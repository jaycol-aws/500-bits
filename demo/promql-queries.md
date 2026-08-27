# Act 3 — Interrogation: PromQL queries (via cw-otel-cli)

All queries run against the CloudWatch OTLP store in **us-east-1**:

```bash
alias cwq='cwpromql --region us-east-1'
```

## Discover the observation we just followed
```bash
# The metric names land within ~1-2 min of first export
cwq metrics --filter checkout
cwq labels
cwq label-values outcome
```

## The signal
```bash
# Total request rate (delta counter -> rate())
cwq query 'sum(rate(checkout_requests_total[5m]))'

# Split by outcome — success vs error
cwq query 'sum by (outcome)(rate(checkout_requests_total[5m]))'

# NOTE: to match ON a label, use the {__name__=...} form (bare name + inline
# matcher is rejected by the CloudWatch query API), e.g.:
#   cwq query 'sum(rate({__name__="checkout_requests_total", outcome="error"}[1m]))'

# p95 latency from the OTel histogram
cwq query 'histogram_quantile(0.95, rate(checkout_request_duration_seconds[5m]))'

# Live-updating latency chart (great on-screen)
cwq range 'histogram_quantile(0.95, rate(checkout_request_duration_seconds[5m]))' \
  --since 30m --watch 15s
```

## Resource attributes survive the journey (OTel semantics preserved)
```bash
# @resource. prefix exposes resource attributes as labels
cwq query 'sum by ("@resource.deployment.environment")(rate(checkout_requests_total[5m]))'
cwq series '{__name__="checkout_requests_total"}' -o json   # full label set of one series
```

## The alarm query (Act 4) — error-rate SLO
Short `[1m]` window for live-demo responsiveness. NOTE: cw-otel-cli / the
CloudWatch query API require the `{__name__="metric", label="val"}` selector form
when matching on a label (a bare `metric{label="v"}` is rejected). The alarm
itself applies the `> 0.2` threshold, so the query is just the ratio:
```bash
cwq query 'sum(rate({__name__="checkout_requests_total", outcome="error"}[1m])) / sum(rate({__name__="checkout_requests_total"}[1m]))'
```
- Before fault injection: **no series** (numerator empty → healthy).
- After `inject-fault.sh error 0.6`: returns a value that climbs past `0.2`
  → the PromQL alarm (threshold `> 0.2`) breaches.
