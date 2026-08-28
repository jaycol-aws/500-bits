# Act 3 — Interrogation: PromQL queries

All queries run against the CloudWatch OTLP store in **us-east-1**.

**Default path for the demo: CloudWatch Query Studio** (nothing to install —
it's in the console every attendee already has).

> Console → **CloudWatch → Metrics → Query** → set the query language to
> **PromQL** → paste a query below → **Run**. Add each one as a new query line to
> build up the graph live. (This is the same editor Act 2 used to prove the
> observation arrived.)

The exact same query strings work in the optional `cwpromql` CLI — see
[the CLI aside](#optional-cli-aside-cwpromql) at the bottom if you'd rather drive
Act 3 from a terminal.

## Discover the observation we just followed
```promql
# The metric names land within ~1-2 min of first export.
# In Query Studio, type `checkout` in the metric browser, or run:
checkout_requests_total
```
In Query Studio the metric browser also lists available labels and label values
(e.g. `outcome`) — no separate command needed.

## The signal
```promql
# Total request rate (delta counter -> rate())
sum(rate(checkout_requests_total[5m]))

# Split by outcome — success vs error
sum by (outcome)(rate(checkout_requests_total[5m]))

# NOTE: to match ON a label, use the {__name__=...} form (bare name + inline
# matcher is rejected by the CloudWatch query API), e.g.:
#   sum(rate({__name__="checkout_requests_total", outcome="error"}[1m]))

# p95 latency from the OTel histogram
histogram_quantile(0.95, rate(checkout_request_duration_seconds[5m]))
```
For the live-updating latency chart, set the Query Studio period to a short
interval (e.g. 15s) and let it auto-refresh — great on-screen.

## Resource attributes survive the journey (OTel semantics preserved)
```promql
# @resource. prefix exposes resource attributes as labels
sum by ("@resource.deployment.environment")(rate(checkout_requests_total[5m]))
```
Query Studio shows the full label set of a series when you hover a line on the
graph or expand the results table.

## The alarm query (Act 4) — error-rate SLO
Short `[1m]` window for live-demo responsiveness. NOTE: the CloudWatch query API
requires the `{__name__="metric", label="val"}` selector form when matching on a
label (a bare `metric{label="v"}` is rejected). The alarm itself applies the
`> 0.2` threshold, so the query is just the ratio:
```promql
sum(rate({__name__="checkout_requests_total", outcome="error"}[1m])) / sum(rate({__name__="checkout_requests_total"}[1m]))
```
- Before fault injection: **no series** (numerator empty → healthy).
- After `inject-fault.sh error 0.6`: returns a value that climbs past `0.2`
  → the PromQL alarm (threshold `> 0.2`) breaches.

---

## Optional CLI aside: `cwpromql`

`cwpromql` ([cw-otel-cli](https://github.com/lewinkedrs/cw-otel-cli)) is a small
Go CLI that hits the same PromQL API with SigV4. It's **optional** — the demo
operator would have to install it — but it's handy if you prefer a terminal to
the console. The query strings are identical to those above.

```bash
alias cwq='cwpromql --region us-east-1'

# Discover
cwq metrics --filter checkout
cwq labels
cwq label-values outcome

# The signal
cwq query 'sum(rate(checkout_requests_total[5m]))'
cwq query 'sum by (outcome)(rate(checkout_requests_total[5m]))'
cwq query 'histogram_quantile(0.95, rate(checkout_request_duration_seconds[5m]))'

# Live-updating latency chart
cwq range 'histogram_quantile(0.95, rate(checkout_request_duration_seconds[5m]))' \
  --since 30m --watch 15s

# Full label set of one series
cwq series '{__name__="checkout_requests_total"}' -o json

# The alarm query
cwq query 'sum(rate({__name__="checkout_requests_total", outcome="error"}[1m])) / sum(rate({__name__="checkout_requests_total"}[1m]))'
```
