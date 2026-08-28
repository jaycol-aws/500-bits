# 500 Bits to Impact: The Life of a Single Observation

**Format:** 60-minute technical webinar (builder audience) · demo-heavy · minimal deck
**Region:** us-east-1 · **Service:** `checkout-service` (demo env)
**Deck philosophy:** slides are signposts, not content. Most of the hour is live terminal + console.
**Presentable deck:** `deck/index.html` — self-contained (no network), arrow-key/Space nav, `F` fullscreen, `P` print-to-PDF layout. This outline is the speaker script; keep the two in sync.

---

## Slide 1 — Title + Abstract

- **500 Bits to Impact: The Life of a Single Observation**
- Speaker + role; "hands-on hour, mostly live — deck is just the map"
- Abstract (verbatim):
  > Every dashboard, every alert, every 3 a.m. page begins as a few hundred bits of truth emitted by your code. In this hands-on hour we follow one OpenTelemetry metric observation end to end: the moment an app records it, its OTLP journey into the new CloudWatch OTel metric store, querying it back with PromQL, and — when an incident strikes — handing it to the Amazon DevOps Agent to pinpoint root cause. You'll take away a repeatable pattern for OTel-native observability on AWS.
- One line: "We follow ONE observation from birth to a 3 a.m. page."

> **Speaker note:** Set the frame — this is not a slideware talk; the terminal is the star. Frame the through-line: we follow one observation from the code that emits it all the way to a root-cause investigation.

---

## Slide 2 — The 500-Bits Hook (honest byte math)

- A single observation feels tiny — how tiny, really? Let's do the math, honestly.
- Bare `(timestamp, value)` ≈ **128 bits** (two 64-bit numbers, no context)
- Standalone **self-describing** observation ≈ **1,000–1,600 bits** (metric name, resource attrs, labels, units, encoding)
- **Batched** on the wire, marginal cost per point ≈ **120–160 bits** (shared context amortized)
- **"500 bits" is an explicitly rounded, evocative hook** — a round number sitting between the batched floor and the standalone ceiling, not a spec constant

> **Speaker note:** Be transparent that 500 is a storytelling device. Builders respect honesty about the math — it earns trust for the rest of the hour.

---

## Slide 3 — The Journey (ONE architecture diagram)

- **Left → right, single horizontal flow:**
  - **Go app on ECS Fargate** (`checkout-service`, port 8080) records `checkout_requests_total` / `checkout_request_duration_seconds`
  - → **OpenTelemetry Collector sidecar** (same task): OTLP/gRPC in at `localhost:4317` → `otlphttp` exporter w/ `sigv4auth`
  - → **CloudWatch OTel metric store** via `https://monitoring.us-east-1.amazonaws.com/v1/metrics`
  - → **PromQL query API** — query in **CloudWatch Query Studio** (optionally `cwpromql`) **+ PromQL alarm** (`checkout-error-rate-slo`)
  - → **Amazon DevOps Agent** (Olympus Agent Space, us-east-1) for root-cause on breach
- Callout: one Fargate task = app + collector; task role needs `cloudwatch:PutMetricData`

> **Speaker note:** This is the only architecture slide — trace the single observation's path with your finger, then drop to the terminal. Everything after this is live.

---

## Slide 4 — Run of Show (5 acts → the hour)

- **Framing — 4m:** why one observation; the honest byte math
- **Birth — 7m:** app records it; instruments, attributes, OTLP/gRPC to sidecar
- **Journey — 8m:** OTel Collector `sigv4auth` → CloudWatch OTLP endpoint; confirm ingest
- **Interrogation — 12m:** query it back with PromQL in Query Studio (rate, error ratio, latency); `cwpromql` optional
- **Incident — 18m:** inject fault (`/admin/fault`), watch `checkout-error-rate-slo` fire, hand to DevOps Agent
- **Impact — 7m:** cost levers, activation takeaways, the repeatable pattern
- **Q&A — 4m**

> **Speaker note:** ~54m content + Q&A. The Incident act is the centerpiece — protect its 18 minutes; cut Interrogation queries if running long.

---

## Slide 4b — Closing the Loop: alarm → investigation, automatically (optional live beat)

- The gap: **no native CloudWatch-alarm → DevOps Agent trigger** yet
- The bridge: `checkout-error-rate-slo` ALARM → **EventBridge** → **Lambda** (HMAC-signs an incident, POSTs the generic webhook) → investigation created
- **Won't spam:** the Lambda claims a per-alarm **cooldown** in DynamoDB (default 30m) before POSTing — a flapping alarm yields at most one investigation per window
- Shareable IaC: opt-in `cdk deploy -c enableAutoTrigger=true`; webhook URL/secret are NoEcho CFN params → Secrets Manager (never in source)
- Live option: inject the fault and say nothing — the investigation appears on its own

> **Speaker note:** This is the "we closed the loop" wow moment. Signing scheme (verified live): `x-amzn-event-signature = base64(HMAC-SHA256("{timestamp}:{body}", secret))` + `x-amzn-event-timestamp` header.

---

## Slide 5 — Impact: Cost, Activation & Call to Action

- **Cost levers:** 60s export interval (fewer points), control **label cardinality**, high-cardinality store supports up to **150 labels** per series; feature is **preview** — price accordingly
- **Retention/activation takeaway:** value compounds with a second integration + a first investigation — don't stop at a single default source
- **Repeatable pattern:** OTel-native, SigV4 to `monitoring.us-east-1`, PromQL to query + alarm, agent for RCA
- **Takeaway:** one repeatable pattern — OTel SDK → OTel Collector (SigV4) → CloudWatch OTel store → PromQL (query + alarm) → agent for RCA; the internal repo has the reference implementation
- Internal reference: repo + `cwpromql` cheat-sheet (backup slide)

> **Speaker note:** Land the pattern, not a product pitch — this is an internal reference, not a public giveaway. Name the preview caveat honestly.

---

## Backup Slide A — PromQL Cheat-Sheet (optional)

- Request rate: `sum(rate(checkout_requests_total[1m]))`
- Error ratio (SLO): `sum(rate({__name__="checkout_requests_total", outcome="error"}[1m])) / sum(rate({__name__="checkout_requests_total"}[1m]))`
- Alarm threshold: `… > 0.2` → `checkout-error-rate-slo`
- p95 latency: `histogram_quantile(0.95, sum(rate(checkout_request_duration_seconds_bucket[5m])) by (le))`
- Always `--region us-east-1`; short `[1m]` windows for live-demo responsiveness
- **Selector rule:** bare name + inline `{label="val"}` is rejected — use the `{__name__="metric", label="val"}` form

> **Speaker note:** Pull up only if the terminal fails or someone asks for the exact selectors.

---

## Backup Slide B — DevOps Agent Prompt Examples (optional)

- "Error rate on `checkout-service` breached 20% at <time> — what changed?"
- "Correlate `checkout_request_duration_seconds` latency with the `outcome="error"` spike"
- "Which fault mode explains the `/checkout` errors — latency or 5xx?"
- Reminder: agent is **read-only by design**; it investigates, you remediate

> **Speaker note:** Use if the live agent run stalls, or to show prompt-crafting for RCA.
