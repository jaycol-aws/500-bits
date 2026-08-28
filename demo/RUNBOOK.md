# 500 Bits to Impact — Demo Runbook

Region: **us-east-1**. Total: ~60 min, demo-heavy. This runbook is written so an
SA who has never seen the repo can deliver the session end to end.

> **New here? Read these first (10 min):** [`README.md`](../README.md) for the
> prerequisites table and deploy tiers, and [`SPEC.md`](../SPEC.md) for the
> canonical names/endpoints. The deck speaker script is
> [`deck/outline.md`](../deck/outline.md); the presentable deck is
> `deck/index.html` (arrow keys to nav, `F` fullscreen).

## What you're demoing (one breath)
We follow a **single OpenTelemetry metric observation** from the line of code
that emits it → through an ADOT sidecar → into the **CloudWatch OTel metric
store** → query it back with **PromQL in Query Studio** → break the service on
purpose → and hand the breach to the **Amazon DevOps Agent** for root cause.
The "~500 bits" is a storytelling hook, not a spec constant — own that framing.

---

## Before you start (prerequisites)

**Tooling on your laptop:**
- **Docker running** — the app image is built locally during `cdk deploy`. It
  builds **linux/arm64** (Fargate runs ARM64/Graviton). On Apple Silicon this is
  native; on Intel it cross-builds (slower). If Docker isn't running, deploy fails.
- **Node 18+ and npm**, and the **AWS CDK** (used via `npx`, no global install needed).
- **AWS credentials for us-east-1** with permission to deploy (ECS, EC2/VPC, IAM,
  Logs, SSM, Secrets Manager, CloudWatch). Confirm with
  `aws sts get-caller-identity`.
- **CDK bootstrapped** in this account/Region: `npx cdk bootstrap aws://<acct>/us-east-1`
  (one-time; skip if already done).
- **One free VPC slot** — the stack creates its own VPC (default limit is 5/Region).
- *(Optional)* the `cwpromql` CLI ([cw-otel-cli](https://github.com/lewinkedrs/cw-otel-cli))
  if you prefer a terminal over Query Studio. Not required.

**For Act 4 (the DevOps Agent finale):**
- A **DevOps Agent Space in us-east-1** with **this account associated** and a
  valid **monitor role** (the reference environment is the "Olympus" space —
  substitute your own). Base Acts 0–3 need none of this.
- *(Auto-trigger variant only)* a **generic webhook** registered in that Space
  (URL + HMAC secret) — see the Act 4 variant below.

**Rehearse once.** Do a full dry run (including one fault-inject + recover and
one agent investigation) before the live session — the agent run is the one beat
you can't fully script.

---

## Pre-flight (do this 1–2 hours before the session)

1. **Deploy the stack** (builds the app image + provisions VPC/Fargate/collector):
   ```bash
   cd cdk && npm install && npm run build && npx cdk deploy
   ```
   Note the outputs: `ClusterName`, `ServiceName`, `LogGroupName`.

2. **Confirm the task is running and exporting** (~2–3 min after deploy):
   ```bash
   export CLUSTER=<ClusterName> SERVICE=<ServiceName>
   aws ecs list-tasks --cluster "$CLUSTER" --service-name "$SERVICE" --region us-east-1
   ```
   Then confirm metrics arrived in **CloudWatch Query Studio** (Console →
   CloudWatch → Metrics → Query → PromQL): run `checkout_requests_total` and
   expect the `checkout_*` series. *(Optional: `cwpromql metrics --filter checkout
   --region us-east-1` if the CLI is installed.)*

3. **Stage the PromQL alarm** (one-time, fully scriptable — no console step):
   ```bash
   cd demo && ./create-alarm.sh          # put-metric-alarm --evaluation-criteria PromQLCriteria
   ```
   > Note: the alarm is created by this script, **not** by the CDK stack. Remember
   > to delete it at teardown (see below) — `cdk destroy` won't remove it.

4. **(Optional) Deploy the auto-trigger** so a breach starts the investigation
   with no prompt (see Act 4 variant for how to get the webhook URL + secret):
   ```bash
   export WEBHOOK_URL='https://event-ai.us-east-1.api.aws/webhook/generic/<id>'
   export WEBHOOK_SECRET='<hmac secret>'
   ./deploy-auto-trigger.sh              # NoEcho CFN params -> Secrets Manager
   ```

5. **Reset the fault flag to healthy:**
   ```bash
   ./inject-fault.sh none
   ```

6. **Sanity-check the DevOps Agent** in your Agent Space can answer
   "give me an overview of my recent alarms" (dry run).

**Two windows ready for the live session:** (a) a browser on CloudWatch Query
Studio, (b) a terminal in `demo/`. Zoom the browser/terminal fonts up now.

---

## Act 0 — Framing (4 min) · slides (1–2)
- **Do:** Open on title + abstract. Pose: *how big is one metric observation?*
  Reveal the byte math (slide 2), land the "~500 bits" hook.
- **Say:** "Every dashboard, every 3 a.m. page starts as a few hundred bits of
  truth your code emitted. Today we follow ONE observation from birth to a
  root-cause investigation — mostly live; the deck is just the map."
- **Emphasize:** Be honest that 500 is a *rounded, evocative* number between the
  batched floor (~120 bits) and the standalone ceiling (~1,600 bits). Builders
  reward that honesty — it buys trust for the rest of the hour.

## Act 1 — Birth (7 min) · `app/main.go`
- **Do:** Open `app/main.go`. Show `doCheckout()` — the two instrument calls
  (`requests.Add(...)` and `latency.Record(...)`). Then show `initMeter()` where
  the resource attributes (`service.name=checkout-service`,
  `deployment.environment=demo`) are set **once**.
- **Say:** "This is the moment the bits are born. Two lines of instrumentation —
  a counter and a histogram. The `outcome` label here is the entire plot of
  Act 4. Notice the resource attributes are set once and ride along with every
  point — that's the self-describing context that makes the observation ~500 bits,
  not 128."
- **Emphasize:** The `outcome="success|error"` attribute (it's what the alarm
  keys on) and that units are seconds on the histogram (foreshadow the p95 beat).

## Act 2 — Journey (8 min) · `otel/collector.yaml` + console
- **Do:** Trace the path: app → OTLP/gRPC `localhost:4317` → ADOT sidecar →
  `otlphttp` + `sigv4auth` → `https://monitoring.us-east-1.amazonaws.com/v1/metrics`.
  Show the sidecar in the CDK task definition (one task = app + collector) and the
  `batch` processor in `collector.yaml`. Then in **Query Studio** run
  `checkout_requests_total` to prove it arrived.
- **Say:** "Same task, two containers — your app and the collector share
  localhost. The collector SigV4-signs plain OTLP/HTTP to a CloudWatch endpoint:
  no new protocol, no agent fleet. The `batch` processor is why the *marginal*
  cost per point drops to ~120 bits — shared context amortized. And… there it is
  in the console: the observation we just watched get born."
- **Emphasize:** "one task = app + collector" (a pattern they can copy verbatim)
  and "it's just SigV4 to an HTTPS endpoint." This is the **only** architecture
  slide — trace it with your cursor, then live from here on.

## Act 3 — Interrogation (12 min) · `demo/promql-queries.md`
Drive from **Query Studio** (Console → CloudWatch → Metrics → Query → PromQL).
Add each query as a new line so the graph builds up live.
- **Do + Say, query by query:**
  1. `sum(rate(checkout_requests_total[5m]))` — "Here's our traffic — the counter
     we watched get emitted, now a rate."
  2. `sum by (outcome)(rate(checkout_requests_total[5m]))` — "Split by that
     `outcome` label. All success right now. Remember this line — Act 4 is where
     `error` shows up."
  3. `histogram_quantile(0.95, rate(checkout_request_duration_seconds[5m]))` —
     "p95 latency, straight from the OTel histogram — ~70 ms. No dashboards built,
     no metric math pre-defined; PromQL on raw OTel."
  4. `sum by ("@resource.deployment.environment")(rate(checkout_requests_total[5m]))`
     — "The resource attributes from Act 1 survived the whole journey as
     `@resource.*` labels. OTel semantics preserved end to end."
- **Emphasize:** These are the SAME bits from Act 1, now queryable — no
  pre-aggregation, no schema. If you're behind on time, **cut queries here first**
  (never cut Act 4).

## Act 4 — Incident (18 min) · the payoff
1. **Do:** In **Query Studio**, show the alarm query returns **no series**
   (healthy — numerator empty):
   ```promql
   sum(rate({__name__="checkout_requests_total", outcome="error"}[1m])) / sum(rate({__name__="checkout_requests_total"}[1m]))
   ```
   **Say:** "This is our SLO: error ratio. Right now it returns nothing —
   healthy." **Emphasize** the selector rule: match a label with the
   `{__name__="metric", label="val"}` form (bare `metric{...}` is rejected).
2. **Do — inject the incident:**
   ```bash
   cd demo && ./inject-fault.sh error 0.6
   ```
   **Say:** "I'm flipping an SSM parameter the app polls — 60% of checkouts now
   return 500. No inbound access, no redeploy; the running service just starts
   failing."
3. **Do:** Within ~1–2 min, re-run the query (now a breaching series climbing past
   0.2) and show `checkout-error-rate-slo` flip to **ALARM** in the console.
   **Say:** "There's the breach — and the PromQL alarm firing on it. That alarm is
   the same observation, now driving an SLO."
4. **Do — hand it to the DevOps Agent** (your Agent Space):
   > "give me an overview of my recent alarms"

   then:
   > "investigate the checkout-error-rate-slo alarm and find the root cause"
5. **Say (while it runs):** "The agent is read-only by design — it investigates,
   you remediate. Give it a minute or two; it's correlating the metric, the
   alarm, and the service context." Narrate the result: error-rate spike on
   `checkout-service`, `outcome="error"` on `/checkout`.
   **Expectation-setting:** an investigation typically takes **a few minutes**;
   keep talking, don't stare at a spinner. If it stalls, use the fallback
   screenshot (below).
6. **Do — recover:** `./inject-fault.sh none` (error rate falls, alarm returns to OK).

### Act 4 variant — fully automated (validated: HTTP 200 live)
Instead of asking the agent by hand, let the alarm breach kick off the
investigation itself (closes the "no native CloudWatch auto-trigger" gap).
Deployed and verified end to end (EventBridge → Lambda → generic webhook →
investigation; per-alarm cooldown confirmed).

Pre-flight (one-time, in addition to the alarm):
```bash
# 1. In your Agent Space: Associations tab → MCP Servers → register a webhook
#    (HMAC auth) → copy the Webhook URL and Secret (shown once).
# 2. Deploy WITH the auto-trigger (URL/secret are NoEcho CFN params → Secrets
#    Manager; never written to a file):
export WEBHOOK_URL='https://event-ai.us-east-1.api.aws/webhook/generic/<id>'
export WEBHOOK_SECRET='<hmac secret>'
cd demo && ./deploy-auto-trigger.sh
#    (equivalently: cd cdk && npx cdk deploy -c enableAutoTrigger=true \
#       --parameters WebhookUrl=$WEBHOOK_URL --parameters WebhookSecret=$WEBHOOK_SECRET)
```
Base demo deploys with plain `cdk deploy` — the auto-trigger is gated behind
`-c enableAutoTrigger=true`.

**Live beat:** run `./inject-fault.sh error 0.6` and **say nothing** about
triggering. Within ~1–2 min the alarm flips, EventBridge invokes the Lambda, and
a new investigation appears in the Operator App on its own.
**Say:** *"Nobody typed anything. The ~500-bit observation drove the alarm, and
the alarm drove the investigation."* Then open it and narrate root cause.

- **Why it won't spam:** the Lambda claims a per-alarm cooldown slot in DynamoDB
  (default 30 min) before POSTing, so flapping yields at most one investigation
  per window. **Re-testing within 30 min?** clear the slot first:
  ```bash
  aws dynamodb delete-item --region us-east-1 \
    --table-name <AutoTriggerDedupTableName-output> \
    --key '{"alarmName":{"S":"checkout-error-rate-slo"}}'
  ```
- **Smoke test without touching metrics:**
  `aws cloudwatch set-alarm-state --alarm-name checkout-error-rate-slo \
   --state-value ALARM --state-reason test --region us-east-1`
  then check the Lambda logs / Operator App; reset with `--state-value OK`.

## Act 5 — Impact (7 min) · slides
- **Do/Say:** Cost levers — 60s export interval in prod (we use 15s for demo
  speed), control **label cardinality**, high-cardinality store (up to 150 labels,
  **preview** — price accordingly). Call to action: `cdk deploy` this repo, swap
  `checkout-service` for your service.
- **Emphasize:** Land the **repeatable pattern**, not a product pitch —
  OTel SDK → ADOT SigV4 → CloudWatch OTel store → PromQL (query + alarm) → agent
  for RCA. This is an internal reference implementation.

## Q&A buffer (4 min)

---

## Fallbacks
- **Metrics not appearing:** OTLP metrics are NOT in `get-metric-data`/`list-metrics`
  — only via PromQL. Query them in **Query Studio** (or `cwpromql metrics` if
  installed). Give it 1–2 min after task start.
- **Alarm slow to flip:** the `[1m]` window is intentional for speed; if still lagging,
  bump the fault rate (`./inject-fault.sh error 0.9`).
- **DevOps Agent quiet:** ask directly by alarm name; ensure your Agent Space has a
  valid monitor-role association for this account.
- **Live investigation stalls:** have a pre-captured screenshot/recording of a prior
  successful investigation ready to show.
- **Deploy fails on early validation / name conflict:** see the Troubleshooting
  section in [`README.md`](../README.md) (`describe-events` on the change-set ARN;
  orphaned log group).

---

## Teardown (after the session)
Do these in order — the alarm and any test investigations are **not** removed by
`cdk destroy`:

```bash
# 1. Reset the fault flag (harmless, but tidy)
cd demo && ./inject-fault.sh none

# 2. Delete the script-created PromQL alarm (NOT part of the stack)
aws cloudwatch delete-alarms --alarm-names checkout-error-rate-slo --region us-east-1

# 3. Tear down all stack resources (VPC, ECS, collector, Lambda, DynamoDB,
#    Secrets Manager, log group — the log group now has removalPolicy DESTROY)
cd ../cdk && npx cdk destroy
```
- **Agent Space:** dismiss/close any **test investigations** you created so they
  don't clutter the space (and any smoke-test webhook you registered, if temporary).
- **Verify clean:** `aws cloudformation describe-stacks --stack-name FiveHundredBitsStack
  --region us-east-1` should return "does not exist"; the `/ecs/500-bits-to-impact`
  log group should be gone.
