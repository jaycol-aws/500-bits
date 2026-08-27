# 500 Bits to Impact — Canonical Demo Contract

This file is the single source of truth. Every component (Go app, ADOT collector,
PromQL queries, alarm, CDK, deck) MUST match the names, ports, and endpoints here.

## Region / accounts
- **Region: `us-east-1`** (DevOps Agent "Olympus" Agent Space lives here).
- cw-otel-cli usage: always pass `--region us-east-1`.

## Service identity (OTel resource attributes)
- `service.name = checkout-service`
- `deployment.environment = demo`
- `service.version = 1.0.0`

## Metrics emitted by the app
| Instrument | Name | Type | Unit | Attributes |
|---|---|---|---|---|
| Request count | `checkout_requests_total` | Counter (delta) | `{requests}` | `outcome` = `success`\|`error`, `route` = `/checkout` |
| Request latency | `checkout_request_duration_seconds` | Histogram | `s` | `route` = `/checkout` |

(Underscore names chosen so PromQL selectors need no quoting.)

## Ingest path
- App exports OTLP/gRPC → ADOT collector sidecar at `localhost:4317`.
- Collector `otlphttp` exporter → `https://monitoring.us-east-1.amazonaws.com/v1/metrics`
  with `sigv4auth` extension (service `monitoring`, region `us-east-1`).
- Task role needs IAM `cloudwatch:PutMetricData` (Resource `*`).

## Query path (Act 3)
- `cwpromql query '<promql>' --region us-east-1` (SigV4 service `monitoring`,
  host `monitoring.us-east-1.amazonaws.com/api/v1/*`).

## Fault injection (Act 4)
- App exposes `GET /admin/fault?mode=none|latency|error&rate=<0..1>`.
- `error` mode: fraction `rate` of `/checkout` calls return 500 → `outcome="error"`.
- `latency` mode: adds ~800ms–1.5s to `/checkout` for fraction `rate`.
- An internal load generator drives ~5 rps against `/checkout` so metrics always flow.

## PromQL alarm (Act 4) — error-rate SLO breach
Instant query (short window for live-demo responsiveness — see lesson on [1m] windows).
NOTE: label matching requires the `{__name__="metric", label="val"}` form; the alarm
applies the `> 0.2` threshold, so the query is the ratio itself:
```
sum(rate({__name__="checkout_requests_total", outcome="error"}[1m]))
 / sum(rate({__name__="checkout_requests_total"}[1m]))
```
Alarm name: `checkout-error-rate-slo`, threshold embedded (`> 0.2`). Created via
`demo/create-alarm.sh` using `aws cloudwatch put-metric-alarm` with
`--evaluation-criteria PromQLCriteria` (no CfnAlarm/CDK support for this preview
alarm type yet). Query must reduce to a single time series.

## Auto-trigger (Act 4, optional) — alarm → investigation, no human in the loop
AWS DevOps Agent has **no native CloudWatch-alarm auto-trigger**; the supported
path is its generic webhook. This demo ships an optional CDK construct
(`cdk/lib/devops-auto-trigger.ts`) that closes the gap:

```
checkout-error-rate-slo (ALARM)
  → EventBridge rule (source=aws.cloudwatch,
      detail-type="CloudWatch Alarm State Change", state.value=ALARM)
  → Lambda (cdk/lambda/alarm-to-devops-agent/index.py)
      → DynamoDB conditional write  (per-alarm cooldown; default 30 min)
      → HMAC-SHA256 sign + POST      (generic webhook)
  → DevOps Agent investigation
```

- **Webhook contract:** `POST https://event-ai.<region>.api.aws/webhook/generic/<id>`
  with headers `x-amzn-event-timestamp: <ISO-8601 millis>` and
  `x-amzn-event-signature: base64(HMAC_SHA256("{timestamp}:{body}", secret))`
  (raw-string secret key). Verified against the live endpoint (HTTP 200).
  Body: `{eventType:"incident", incidentId, action:"created", priority, title,
  description, timestamp, service}`. Priority ∈ CRITICAL|HIGH|MEDIUM|LOW|MINIMAL.
- **Dedup:** DynamoDB `PutItem` gated by `attribute_not_exists(alarmName) OR
  expiresAt < now`. A flapping alarm creates at most one investigation per
  cooldown window. TTL on `expiresAt` garbage-collects rows.
- **Secrets:** the webhook URL + HMAC secret are supplied as **NoEcho
  CloudFormation parameters** (`WebhookUrl`, `WebhookSecret`) and written by CDK
  into a **Secrets Manager** secret (JSON `{"url","secret"}`) at deploy time.
  No secret material ever appears in source control or the synthesized template
  — only `{Ref}`. The Lambda reads the secret at runtime
  (`secretsmanager:GetSecretValue`, scoped to that one secret).
- **Opt-in / shareable:** the whole auto-trigger is gated behind
  `-c enableAutoTrigger=true`, so collaborators can `cdk deploy` the base demo
  with no DevOps Agent webhook. Enable it with:
  ```
  cdk deploy -c enableAutoTrigger=true \
    --parameters WebhookUrl=<url> --parameters WebhookSecret=<key>
  # or: WEBHOOK_URL=... WEBHOOK_SECRET=... demo/deploy-auto-trigger.sh
  ```
- **Blast radius:** the EventBridge rule matches ONLY `checkout-error-rate-slo`,
  so no other account alarm is ever forwarded.

## Ports
- App HTTP: `8080` (`/checkout`, `/admin/fault`, `/healthz`)
- OTLP gRPC (collector receiver): `4317`
- OTLP HTTP (collector receiver): `4318`

## Container images
- App: multi-stage Go build (distroless/static final).
- Collector sidecar: `public.ecr.aws/aws-observability/aws-otel-collector:latest`
  with config mounted/passed; task def puts both in one Fargate task.
