# 500 Bits to Impact — Demo Runbook

Region: **us-east-1** (DevOps Agent "Olympus" space). Total: ~60 min, demo-heavy.

---

## Pre-flight (do this 1–2 hours before the session)

1. **Deploy the stack** (builds the app image + provisions Fargate/collector):
   ```bash
   cd cdk && npm install && npm run build && npx cdk deploy
   ```
   Note the outputs: `ClusterName`, `ServiceName`, `LogGroup`.

2. **Confirm the task is running and exporting** (~2–3 min after deploy):
   ```bash
   export CLUSTER=<ClusterName> SERVICE=<ServiceName>
   aws ecs list-tasks --cluster "$CLUSTER" --service-name "$SERVICE" --region us-east-1
   cwpromql metrics --filter checkout --region us-east-1   # expect checkout_* names
   ```

3. **Stage the PromQL alarm** (one-time, fully scriptable — no console step):
   ```bash
   cd demo && ./create-alarm.sh          # put-metric-alarm --evaluation-criteria PromQLCriteria
   ```

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

6. **Sanity-check the DevOps Agent** in the Olympus space can answer
   "give me an overview of my recent alarms" (dry run).

---

## Act 0 — Framing (4 min) · slides
- Open on the title + abstract. Pose the question: *how big is one metric observation?*
- Reveal the honest byte math (deck slide 2). Land the "~500 bits" hook.

## Act 1 — Birth (7 min) · `app/main.go`
- Show `doCheckout()` — the two instrument calls (`requests.Add`, `latency.Record`).
- Point out resource attributes (`service.name=checkout-service`) set once in `initMeter`.
- Message: this is the moment the bits are born; everything downstream is that same point.

## Act 2 — Journey (8 min) · `otel/collector.yaml` + console
- Walk the path: app → OTLP/gRPC `localhost:4317` → ADOT sidecar → `otlphttp` +
  `sigv4auth` → `https://monitoring.us-east-1.amazonaws.com/v1/metrics`.
- Show the sidecar in the task definition (CDK) and the `batch` processor
  (the "amortized marginal cost" callback to Act 0).
- Console: CloudWatch → Query Studio, run `checkout_requests_total` to show it arrived.

## Act 3 — Interrogation (12 min) · `demo/promql-queries.md`
Live terminal with cw-otel-cli (see the cheat sheet). Key beats:
```bash
alias cwq='cwpromql --region us-east-1'
cwq query 'sum by (outcome)(rate(checkout_requests_total[5m]))'
cwq query 'histogram_quantile(0.95, rate(checkout_request_duration_seconds[5m]))'
cwq range 'histogram_quantile(0.95, rate(checkout_request_duration_seconds[5m]))' --since 30m --watch 15s
```
- Show resource attributes surface as `@resource.*` labels (OTel semantics preserved).

## Act 4 — Incident (18 min) · the payoff
1. Show the alarm query returns **no series** (healthy — no errors):
   ```bash
   cwq query 'sum(rate({__name__="checkout_requests_total", outcome="error"}[1m])) / sum(rate({__name__="checkout_requests_total"}[1m]))'
   ```
2. **Inject the incident:**
   ```bash
   cd demo && ./inject-fault.sh error 0.6
   ```
3. Within ~1–2 min: re-run the query (now returns a breaching series) and show the
   `checkout-error-rate-slo` alarm flip to **ALARM** in the console.
4. **Hand it to the DevOps Agent** (Olympus space):
   > "give me an overview of my recent alarms"

   It surfaces the breached PromQL alarm; follow up:
   > "investigate the checkout-error-rate-slo alarm and find the root cause"
5. Narrate the agent's investigation → root cause (error-rate spike on
   `checkout-service`, `outcome="error"`).
6. **Recover:** `./inject-fault.sh none` (error rate falls, alarm returns to OK).

### Act 4 variant — fully automated (validated: HTTP 200 live)
Instead of asking the agent by hand, let the alarm breach kick off the
investigation itself (closes the "no native CloudWatch auto-trigger" gap). This
path is deployed and verified end to end (EventBridge → Lambda → generic webhook
→ investigation created; per-alarm cooldown confirmed).

Pre-flight (one-time, in addition to the alarm):
```bash
# 1. Get the webhook URL + secret from the Olympus Agent Space:
#    Associations tab → MCP Servers → register a webhook (HMAC auth) →
#    copy the Webhook URL and Secret (shown once).
# 2. Deploy WITH the auto-trigger. The URL/secret are passed as NoEcho CFN
#    parameters and stored in Secrets Manager by CDK -- never written to a file:
export WEBHOOK_URL='https://event-ai.us-east-1.api.aws/webhook/generic/<id>'
export WEBHOOK_SECRET='<hmac secret>'
cd demo && ./deploy-auto-trigger.sh
#    (equivalently: cd cdk && npx cdk deploy -c enableAutoTrigger=true \
#       --parameters WebhookUrl=$WEBHOOK_URL --parameters WebhookSecret=$WEBHOOK_SECRET)
```
Collaborators who don't want the auto-trigger just run `cdk deploy` as usual —
it's gated behind `-c enableAutoTrigger=true`.
Live: run `./inject-fault.sh error 0.6` as usual. Within ~1–2 min the alarm flips
to ALARM, EventBridge invokes the Lambda, and a new investigation appears in the
Operator App on its own — no prompt needed. Talking point: *"nobody typed
anything; the ~500-bit observation drove the alarm, and the alarm drove the
investigation."* Then open the investigation to narrate the root cause.

- **Why it won't spam:** the Lambda claims a per-alarm cooldown slot in DynamoDB
  (default 30 min) before POSTing, so alarm flapping yields at most one
  investigation per window.
- **Smoke test without breaking anything:** `aws cloudwatch set-alarm-state
  --alarm-name checkout-error-rate-slo --state-value ALARM --state-reason test`
  then check the Lambda logs / Operator App; reset with `--state-value OK`.

## Act 5 — Impact (7 min) · slides
- Cost levers: 60s export interval (we used 15s for demo speed), label cardinality,
  high-cardinality store (up to 150 labels, preview).
- Call to action: `cdk deploy` this repo; swap `checkout-service` for your service.

## Q&A buffer (4 min)

---

## Fallbacks
- **Metrics not appearing:** OTLP metrics are NOT in `get-metric-data`/`list-metrics`
  — only via PromQL. Use `cwpromql metrics`. Give it 1–2 min after task start.
- **Alarm slow to flip:** the `[1m]` window is intentional for speed; if still lagging,
  bump fault rate (`./inject-fault.sh error 0.9`).
- **DevOps Agent quiet:** ask directly by alarm name; ensure the Olympus space has the
  monitor role association valid.
- **Live investigation stalls:** have a pre-captured screenshot/recording of a prior
  successful investigation ready to show.
