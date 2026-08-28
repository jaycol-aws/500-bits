# 500 Bits to Impact — The Life of a Single Observation

> Every dashboard, every alert, every 3 a.m. page begins as a few hundred bits of
> truth emitted by your code. In this hands-on hour we follow one OpenTelemetry
> metric observation end to end: the moment an app records it, its OTLP journey
> into the new CloudWatch OTel metric store, querying it back with PromQL, and —
> when an incident strikes — handing it to the Amazon DevOps Agent to pinpoint
> root cause. You'll take away a repeatable pattern for OTel-native observability
> on AWS.

A complete, deployable webinar demo: a Go service on **ECS Fargate** emits OTel
metrics through an **ADOT sidecar** into the **CloudWatch OTLP metric store**
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
  │  ADOT collector sidecar  ──otlphttp + sigv4auth──►                │
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
by flipping an **SSM parameter** (`/500bits/fault`) the app polls — no inbound
listener, no load balancer, no shell in the image.

## Repo layout

| Path | What |
|---|---|
| `SPEC.md` | Canonical contract — metric names, endpoints, ports, region |
| `app/` | Instrumented Go `checkout-service` (+ Dockerfile) |
| `otel/collector.yaml` | ADOT collector config (OTLP → CloudWatch OTLP endpoint) |
| `cdk/` | CDK (TypeScript): VPC, ECS Fargate service + ADOT sidecar, IAM, SSM flag |
| `demo/` | `RUNBOOK.md`, `promql-queries.md`, `inject-fault.sh`, `create-alarm.sh` |
| `deck/outline.md` | Minimal builder-audience slide outline |

## Quick start

```bash
cd cdk && npm install && npm run build && npx cdk deploy    # region us-east-1
```
Wait ~2-3 min, then verify the metrics landed in **CloudWatch Query Studio**
(Console → CloudWatch → Metrics → Query → PromQL → run `checkout_requests_total`).
*(Optional: `cwpromql metrics --filter checkout --region us-east-1` if you have
the [cw-otel-cli](https://github.com/lewinkedrs/cw-otel-cli) CLI installed.)*
Then follow `demo/RUNBOOK.md`.

## Metrics

| Name | Type | Attributes |
|---|---|---|
| `checkout_requests_total` | Counter | `outcome` (success\|error), `route` |
| `checkout_request_duration_seconds` | Histogram | `route` |

## Notes / caveats
- CloudWatch OTLP metrics + PromQL is a **preview** capability. PromQL alarms are
  created via `aws cloudwatch put-metric-alarm --evaluation-criteria PromQLCriteria`
  (see `demo/create-alarm.sh`); there is no CFN/CDK construct for them yet.
- OTLP-ingested metrics do **not** appear in classic `list-metrics`/`get-metric-data`
  — query them via PromQL only.
- Export interval is 15s here for demo responsiveness; 60s is the production standard.
