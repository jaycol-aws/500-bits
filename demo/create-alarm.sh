#!/usr/bin/env bash
# Pre-flight (run BEFORE the session): create the PromQL alarm for Act 4.
#
# PromQL alarms ARE creatable via the CLI: put-metric-alarm with
# --evaluation-criteria PromQLCriteria. The threshold is embedded in the query
# (> 0.2). The query must reduce to a single time series. Note: label matching
# uses the {__name__="metric", label="val"} form (CloudWatch rejects bare-name +
# inline label matchers).
set -euo pipefail

REGION="${REGION:-us-east-1}"
ALARM_NAME="${ALARM_NAME:-checkout-error-rate-slo}"
QUERY='sum(rate({__name__="checkout_requests_total", outcome="error"}[1m])) / sum(rate({__name__="checkout_requests_total"}[1m])) > 0.2'

echo "== Verifying metrics have landed in the OTLP store ($REGION) =="
cwpromql metrics --filter checkout --region "$REGION" || {
  echo "No checkout_* metrics yet. Wait 1-2 min after the service starts." >&2
  exit 1
}

echo "== Creating PromQL alarm: $ALARM_NAME =="
aws cloudwatch put-metric-alarm \
  --region "$REGION" \
  --alarm-name "$ALARM_NAME" \
  --alarm-description "500 Bits demo: checkout error rate exceeds 20% (PromQL alarm on CloudWatch OTLP metrics)" \
  --evaluation-interval 60 \
  --evaluation-criteria "{\"PromQLCriteria\":{\"Query\":\"${QUERY//\"/\\\"}\",\"PendingPeriod\":30,\"RecoveryPeriod\":60}}"
# Optional: add --alarm-actions arn:aws:sns:...:MyTopic for a notification.

echo "== State (expect OK while healthy) =="
aws cloudwatch describe-alarms --region "$REGION" --alarm-names "$ALARM_NAME" \
  --query 'MetricAlarms[0].{Name:AlarmName,State:StateValue}' --output json

cat <<EOF

Alarm ready. During Act 4:
  cd demo && ./inject-fault.sh error 0.6      # ratio climbs past 0.2
  # ~30-90s later the alarm flips to ALARM (PendingPeriod=30s)
Then ask the DevOps Agent: "give me an overview of my recent alarms"
Recover: ./inject-fault.sh none
EOF
