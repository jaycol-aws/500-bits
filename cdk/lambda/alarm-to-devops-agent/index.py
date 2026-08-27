"""
alarm-to-devops-agent

EventBridge target that turns a CloudWatch alarm ALARM-state transition into a
DevOps Agent investigation by POSTing a signed "incident" event to the Agent
Space generic webhook.

Trigger:  EventBridge rule (source=aws.cloudwatch,
          detail-type="CloudWatch Alarm State Change", state.value=ALARM).

De-duplication:
  Alarms flap (OK -> ALARM -> OK -> ALARM ...). Without a guard, every ALARM
  transition would spawn a new investigation. We enforce a per-alarm cooldown
  with a DynamoDB conditional write:

      PutItem(alarmName) IF attribute_not_exists(alarmName)
                            OR expiresAt < now

  If the item already exists and has not expired, the conditional write fails
  and we skip -- so at most one investigation is created per alarm per cooldown
  window (default 30 min). A DynamoDB TTL on `expiresAt` garbage-collects old
  rows; the explicit `expiresAt < now` comparison is what actually enforces the
  window (TTL deletion is lazy and not timely enough to rely on).

Webhook contract (AWS DevOps Agent generic webhook):
  POST https://event-ai.<region>.api.aws/webhook/generic/<id>
  Headers:
    x-amzn-event-timestamp: <ISO-8601 millis, e.g. 2025-10-05T18:06:00.000Z>
    x-amzn-event-signature: base64( HMAC-SHA256( "{timestamp}:{body}", secret ) )
  (raw-string secret as the HMAC key; signed body bytes must equal bytes sent)
  Body:
    {
      "eventType": "incident",
      "incidentId": "<unique-per-breach>",
      "action": "created",
      "priority": "CRITICAL|HIGH|MEDIUM|LOW|MINIMAL",
      "title": "...",
      "description": "...",
      "timestamp": "<ISO-8601>",
      "service": "..."
    }

Secrets:
  The webhook URL + HMAC secret are read at runtime from a single Secrets
  Manager secret (JSON: {"url", "secret"}), provisioned by CDK from deploy-time
  NoEcho CloudFormation parameters -- never in source or the template.

Configuration (environment variables):
  DEDUP_TABLE           DynamoDB table name (PK: alarmName [S]).
  WEBHOOK_SECRET_ARN    Secrets Manager secret ARN. The secret is a JSON object
                        {"url": "<webhook url>", "secret": "<hmac secret>"}.
  COOLDOWN_SECONDS      Dedup window in seconds (default 1800).
  DEFAULT_PRIORITY      Priority to send (default HIGH).
  SERVICE_NAME          `service` field on the payload (default checkout-service).
  ALARM_ALLOWLIST       Optional CSV of alarm names to act on (defense-in-depth;
                        the EventBridge rule already filters).
"""

import base64
import hashlib
import hmac
import json
import os
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone

import boto3

_secrets = boto3.client("secretsmanager")
_ddb = boto3.client("dynamodb")

# Cache the webhook config across warm invocations (secret fetched once).
_CONFIG = {}


def _get_config():
    """Fetch + cache the webhook URL and secret from Secrets Manager."""
    if _CONFIG:
        return _CONFIG
    resp = _secrets.get_secret_value(SecretId=os.environ["WEBHOOK_SECRET_ARN"])
    data = json.loads(resp["SecretString"])
    url = (data.get("url") or "").strip()
    secret = (data.get("secret") or "").strip()
    if not url or not secret:
        raise RuntimeError("Webhook secret must contain non-empty 'url' and 'secret' keys")
    _CONFIG["url"] = url
    _CONFIG["secret"] = secret
    return _CONFIG


def _claim_cooldown(alarm_name: str, cooldown: int) -> bool:
    """
    Try to claim the cooldown slot for this alarm.

    Returns True if we acquired it (caller should create an investigation),
    False if an unexpired claim already exists (caller should skip).
    """
    now = int(time.time())
    expires_at = now + cooldown
    try:
        _ddb.put_item(
            TableName=os.environ["DEDUP_TABLE"],
            Item={
                "alarmName": {"S": alarm_name},
                "expiresAt": {"N": str(expires_at)},
                "claimedAt": {"N": str(now)},
            },
            # Acquire iff no live claim exists.
            ConditionExpression="attribute_not_exists(alarmName) OR expiresAt < :now",
            ExpressionAttributeValues={":now": {"N": str(now)}},
        )
        return True
    except _ddb.exceptions.ConditionalCheckFailedException:
        return False


def _release_cooldown(alarm_name: str) -> None:
    """
    Best-effort release of a cooldown claim after a FAILED delivery, so a retry
    (EventBridge) or the next breach can attempt again instead of being
    suppressed for the whole window. Claiming before delivery still guards
    against concurrent duplicate events; this only rolls back on failure.
    """
    try:
        _ddb.delete_item(
            TableName=os.environ["DEDUP_TABLE"],
            Key={"alarmName": {"S": alarm_name}},
        )
    except Exception as e:  # noqa: BLE001 - best-effort cleanup
        print(f"WARN: could not release cooldown for '{alarm_name}': {e}")


def _post_incident(url: str, secret: str, payload: dict) -> int:
    """HMAC-sign and POST the incident payload. Returns HTTP status code.

    The DevOps Agent generic webhook signs the string "{timestamp}:{body}"
    (colon-separated) with HMAC-SHA256 (raw-string key), base64-encoded, and
    requires BOTH the x-amzn-event-timestamp and x-amzn-event-signature headers.
    The signed body bytes must be exactly the bytes we send.
    """
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    body_str = json.dumps(payload)
    signed = f"{ts}:{body_str}".encode("utf-8")
    signature = base64.b64encode(
        hmac.new(secret.encode("utf-8"), signed, hashlib.sha256).digest()
    ).decode("ascii")

    req = urllib.request.Request(
        url,
        data=body_str.encode("utf-8"),
        method="POST",
        headers={
            "Content-Type": "application/json",
            "x-amzn-event-timestamp": ts,
            "x-amzn-event-signature": signature,
        },
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        return resp.status


def handler(event, _context):
    detail = event.get("detail", {})
    alarm_name = detail.get("alarmName", "")
    state = detail.get("state", {}) or {}
    state_value = state.get("value", "")

    # The EventBridge rule already filters to ALARM, but re-check defensively.
    if state_value != "ALARM":
        print(f"Ignoring non-ALARM transition: {alarm_name} -> {state_value}")
        return {"skipped": "not_alarm_state"}

    # Optional allowlist (defense-in-depth beyond the rule's alarmName filter).
    allowlist = [a for a in os.environ.get("ALARM_ALLOWLIST", "").split(",") if a]
    if allowlist and alarm_name not in allowlist:
        print(f"Ignoring alarm not in allowlist: {alarm_name}")
        return {"skipped": "not_in_allowlist"}

    cooldown = int(os.environ.get("COOLDOWN_SECONDS", "1800"))
    if not _claim_cooldown(alarm_name, cooldown):
        print(
            f"DEDUP: active investigation for '{alarm_name}' within "
            f"{cooldown}s cooldown -- skipping."
        )
        return {"skipped": "cooldown_active", "alarmName": alarm_name}

    # State-change timestamp makes each genuine breach a unique incident, while
    # the cooldown above prevents a swarm from a single flapping alarm.
    ts = state.get("timestamp") or detail.get("time") or event.get("time", "")
    reason = state.get("reason", "") or "CloudWatch alarm entered ALARM state."
    account = event.get("account", "")
    region = event.get("region", "")

    payload = {
        "eventType": "incident",
        "incidentId": f"{alarm_name}:{ts}",
        "action": "created",
        "priority": os.environ.get("DEFAULT_PRIORITY", "HIGH"),
        "title": alarm_name,
        "description": (
            f"CloudWatch alarm '{alarm_name}' entered ALARM in {account}/{region}. "
            f"Reason: {reason}"
        ),
        "timestamp": ts,
        "service": os.environ.get("SERVICE_NAME", "checkout-service"),
        # Schema's optional `data`: the original event, so the agent has the
        # full CloudWatch alarm context (metric, threshold, dimensions, reason).
        "data": event,
    }

    try:
        cfg = _get_config()
        status = _post_incident(cfg["url"], cfg["secret"], payload)
    except urllib.error.HTTPError as e:
        detail_body = e.read().decode("utf-8", "replace")[:500]
        print(f"Webhook HTTP {e.code} for '{alarm_name}': {detail_body}")
        # Roll back the cooldown claim so a retry / next breach can try again,
        # then re-raise so the invocation is marked failed and EventBridge retries.
        _release_cooldown(alarm_name)
        raise
    except Exception:
        _release_cooldown(alarm_name)
        raise

    print(
        f"Created investigation for '{alarm_name}' "
        f"(incidentId={payload['incidentId']}, webhook HTTP {status})."
    )
    return {"created": True, "alarmName": alarm_name, "httpStatus": status}
