# 500 Bits to Impact — The Life of a Single Observation

> Every dashboard, every alert, every 3 a.m. page begins as a few hundred bits of
> truth emitted by your code. In this hands-on hour we follow one OpenTelemetry
> metric observation end to end: the moment an app records it, its OTLP journey
> into the new CloudWatch OTel metric store, querying it back with PromQL, and —
> when an incident strikes — handing it to the Amazon DevOps Agent to pinpoint
> root cause. You'll take away a repeatable pattern for OTel-native observability
> on AWS.

A complete, deployable webinar demo: a Go service on **ECS Fargate** emits OTel
metrics through an **OpenTelemetry Collector sidecar** into the **CloudWatch OTLP metric store**
(`monitoring.us-east-1.amazonaws.com/v1/metrics`), queried with **PromQL** in
**CloudWatch Query Studio** (optionally the
[cw-otel-cli](https://github.com/lewinkedrs/cw-otel-cli) CLI), with a **PromQL
alarm** and an **Amazon DevOps Agent** investigation as the finale.

## Architecture

```
  ┌──────────────────────── ECS Fargate task ────────────────────────┐
  │  checkout-service (Go, OTel SDK)                                  │
  │        │  OTLP/gRPC  localhost:4317                               │
  │        ▼                                                          │
  │  OTel Collector sidecar  ──otlphttp + sigv4auth──►                │
  └───────────────────────────────────┬──────────────────────────────┘
                                       ▼
        CloudWatch OTLP metric store  (monitoring.us-east-1.amazonaws.com/v1/metrics)
                                       │
                 ┌─────────────────────┼──────────────────────┐
                 ▼                     ▼                      ▼
         PromQL query API       PromQL alarm          Amazon DevOps Agent
       (Query Studio, Act 3)  (Act 4 breach)        (Act 4 root cause)
```

The service self-drives ~5 rps so telemetry always flows. An incident is injected
by flipping an **SSM parameter** the app polls — no inbound
listener, no load balancer, no shell in the image.

## Repo layout

| Path | What |
|---|---|
| `SPEC.md` | Canonical contract — metric names, endpoints, ports, region |
| `app/` | Instrumented Go `checkout-service` (+ Dockerfile) |
| `otel/collector.yaml` | OpenTelemetry Collector config (OTLP → CloudWatch OTLP endpoint) |
| `cdk/` | CDK (TypeScript): VPC, ECS Fargate service + OTel Collector sidecar, IAM, SSM flag |
| `demo/` | `RUNBOOK.md`, `promql-queries.md`, `inject-fault.sh`, `create-alarm.sh` |
| `deck/outline.md` | Minimal builder-audience slide outline |

## Prerequisites

The **runtime and the querying are fully self-service** (`cdk deploy` + Query
Studio). The **Amazon DevOps Agent side is a manual prerequisite** — the CDK
does **not** (and cannot) create a DevOps Agent Space, its account association,
its monitor role, or its webhook. There is no CloudFormation/CDK resource for
those; you set the space up once in the console and then *pass its webhook
credentials into* the CDK.

| To run… | You need | Set up how |
|---|---|---|
| **Acts 0–3 + the alarm** (deploy, query, alarm breaches) | An AWS account (us-east-1) with CDK bootstrapped, **and one free VPC slot** (the stack creates its own dedicated VPC; the default limit is 5 VPCs/Region) | `cdk deploy` — nothing else |
| **Act 4 manual hand-off** ("give me an overview of my recent alarms") | A **pre-existing DevOps Agent Space** with this account associated + a valid monitor role | One-time in the DevOps Agent console |
| **Act 4 auto-trigger** (alarm breach starts the investigation) | The space above **plus** a **generic webhook** registered in it (URL + HMAC secret) | Console → Agent Space → **Associations → MCP Servers → register webhook**; copy the URL + secret (shown once) |

> The base demo requires **no** Agent Space. Only Act 4 does. Nothing in this
> repo provisions the space — supply it (and, for auto-trigger, its webhook)
> as described below.

## Quick start

### Base demo (Acts 0–3, no DevOps Agent Space needed)

```bash
cd cdk && npm install && npm run build && npx cdk deploy    # region us-east-1
```
Wait ~2-3 min, then verify the metrics landed in **CloudWatch Query Studio**
(Console → CloudWatch → Metrics → Query → PromQL → run `checkout_requests_total`).
*(Optional: `cwpromql metrics --filter checkout --region us-east-1` if you have
the [cw-otel-cli](https://github.com/lewinkedrs/cw-otel-cli) CLI installed.)*
Stage the PromQL alarm with `cd demo && ./create-alarm.sh`, then follow
`demo/RUNBOOK.md`.

### Act 4 — manual hand-off (needs a pre-existing Agent Space)

No extra deploy flags. You just need a DevOps Agent Space that already has this
account associated with a valid monitor role. During Act 4 you ask the agent in
that space (e.g. *"give me an overview of my recent alarms"*) to pick up the
breached `checkout-error-rate-slo` alarm. **The Space is identified by which
one you open in the console — it is not passed to the CDK.**

### Act 4 — auto-trigger (needs the Space *and* its webhook, passed to the CDK)

Only the auto-trigger path takes values from the Agent Space. Register a generic
webhook in the Space (Associations → MCP Servers), then pass the URL + HMAC
secret to CDK as **NoEcho** CloudFormation parameters — they never touch source
control or the synthesized template (CDK stores them in Secrets Manager and the
template holds only a `{Ref}`):

```bash
cd cdk
npx cdk deploy \
  -c enableAutoTrigger=true \
  --parameters WebhookUrl='https://event-ai.us-east-1.api.aws/webhook/generic/<id>' \
  --parameters WebhookSecret='<hmac-secret-shown-once>'
```

Equivalent helper: `cd demo && WEBHOOK_URL=… WEBHOOK_SECRET=… ./deploy-auto-trigger.sh`.

Notes:
- `enableAutoTrigger` is a **CDK context flag** (`-c`), so the whole auto-trigger
  construct (EventBridge rule + Lambda + DynamoDB cooldown) is only synthesized
  when you opt in. Plain `cdk deploy` never references a webhook.
- `WebhookUrl` / `WebhookSecret` are **CloudFormation parameters** (`--parameters`),
  marked `NoEcho`. Pass them on every `cdk deploy` of the auto-trigger stack.
- The Agent **Space itself is never a CDK input** — only the webhook it issues is.
  There is no space ID/ARN parameter anywhere in this repo.

## Metrics

| Name | Type | Attributes |
|---|---|---|
| `checkout_requests_total` | Counter | `outcome` (success\|error), `route` |
| `checkout_request_duration_seconds` | Histogram | `route` |

## Troubleshooting

- **`Early validation failed ... AWS::EarlyValidation::ResourceExistenceCheck`**
  on `cdk deploy`: the umbrella hook name hides the real reason. Get the actual
  per-resource error with `describe-events` against the **change-set ARN** (not
  `describe-stack-events` on the stack):
  ```bash
  CS=$(aws cloudformation list-change-sets --stack-name FiveHundredBitsStack \
        --region us-east-1 --query 'Summaries[0].ChangeSetId' --output text)
  aws cloudformation describe-events --change-set-name "$CS" --region us-east-1
  ```
  Look for the `VALIDATION_ERROR` event's `ValidationName` and
  `ValidationStatusReason` — it names the exact resource and problem.
- **`NAME_CONFLICT ... '/ecs/500-bits-to-impact' already exists`**: a prior
  rolled-back/interrupted deploy orphaned the fixed-name log group. The stack
  now sets `removalPolicy: DESTROY` so this won't recur, but to clear an
  existing orphan once:
  `aws logs delete-log-group --log-group-name /ecs/500-bits-to-impact --region us-east-1`,
  then redeploy.
- **A stack stuck in `ROLLBACK_COMPLETE` / `REVIEW_IN_PROGRESS`** can't be
  updated — delete it, then `cdk deploy` again.

## Notes / caveats
- PromQL alarms are created via `aws cloudwatch put-metric-alarm
  --evaluation-criteria PromQLCriteria` (see `demo/create-alarm.sh`); there is no
  CFN/CDK construct for them yet.
- OTLP-ingested metrics do **not** appear in classic `list-metrics`/`get-metric-data`
  — query them via PromQL only.
- Export interval is 15s here for demo responsiveness; 60s is the production standard.
