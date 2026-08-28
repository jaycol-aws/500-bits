// 500 Bits to Impact — checkout-service
//
// A tiny instrumented HTTP service that emits exactly the metrics described in
// SPEC.md. It self-drives ~5 rps of traffic so telemetry always flows during
// the demo, and exposes /admin/fault to inject an error or latency incident.
//
// Metrics (OTel -> OTLP/gRPC -> OpenTelemetry Collector sidecar -> CloudWatch OTLP endpoint):
//   checkout_requests_total          Counter   attrs: outcome, route
//   checkout_request_duration_seconds Histogram attrs: route
package main

import (
	"context"
	"errors"
	"log"
	"math/rand"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc"
	"go.opentelemetry.io/otel/metric"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
)

const route = "/checkout"

// ---- fault state (toggled live via /admin/fault) ------------------------

type faultState struct {
	mu   sync.RWMutex
	mode string  // none | latency | error
	rate float64 // 0..1 fraction of requests affected
}

func (f *faultState) get() (string, float64) {
	f.mu.RLock()
	defer f.mu.RUnlock()
	return f.mode, f.rate
}

func (f *faultState) set(mode string, rate float64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.mode, f.rate = mode, rate
}

var faults = &faultState{mode: "none", rate: 0}

// ---- metric instruments -------------------------------------------------

var (
	requests metric.Int64Counter
	latency  metric.Float64Histogram
)

func initMeter(ctx context.Context) (func(context.Context) error, error) {
	res, err := resource.New(ctx,
		resource.WithAttributes(
			semconv.ServiceName("checkout-service"),
			semconv.ServiceVersion("1.0.0"),
			semconv.DeploymentEnvironment("demo"),
		),
	)
	if err != nil {
		return nil, err
	}

	// OTLP/gRPC to the collector sidecar. Endpoint from OTEL_EXPORTER_OTLP_ENDPOINT
	// (default localhost:4317); insecure because it's a same-task loopback hop.
	endpoint := os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
	if endpoint == "" {
		endpoint = "localhost:4317"
	}
	// Strip a scheme if present (otlpmetricgrpc wants host:port).
	endpoint = trimScheme(endpoint)

	exp, err := otlpmetricgrpc.New(ctx,
		otlpmetricgrpc.WithEndpoint(endpoint),
		otlpmetricgrpc.WithInsecure(),
	)
	if err != nil {
		return nil, err
	}

	interval := 15 * time.Second // demo-friendly; SPEC note: 60s is prod-standard
	if v := os.Getenv("OTEL_METRIC_EXPORT_INTERVAL_MS"); v != "" {
		if ms, e := strconv.Atoi(v); e == nil {
			interval = time.Duration(ms) * time.Millisecond
		}
	}

	provider := sdkmetric.NewMeterProvider(
		sdkmetric.WithResource(res),
		// The default OTel histogram buckets are tuned for milliseconds; we
		// record seconds, so define Prometheus-style second-scale boundaries.
		// Without this, sub-100ms latencies all fall in the first bucket and
		// histogram_quantile() returns meaningless values.
		sdkmetric.WithView(sdkmetric.NewView(
			sdkmetric.Instrument{Name: "checkout_request_duration_seconds"},
			sdkmetric.Stream{Aggregation: sdkmetric.AggregationExplicitBucketHistogram{
				Boundaries: []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10},
			}},
		)),
		sdkmetric.WithReader(sdkmetric.NewPeriodicReader(exp,
			sdkmetric.WithInterval(interval))),
	)
	otel.SetMeterProvider(provider)

	meter := provider.Meter("checkout-service")
	requests, err = meter.Int64Counter("checkout_requests_total",
		metric.WithDescription("Total checkout requests"),
		metric.WithUnit("{requests}"))
	if err != nil {
		return nil, err
	}
	latency, err = meter.Float64Histogram("checkout_request_duration_seconds",
		metric.WithDescription("Checkout request latency"),
		metric.WithUnit("s"))
	if err != nil {
		return nil, err
	}
	return provider.Shutdown, nil
}

func trimScheme(s string) string {
	for _, p := range []string{"http://", "https://"} {
		if len(s) >= len(p) && s[:len(p)] == p {
			return s[len(p):]
		}
	}
	return s
}

// ---- the one observation: doCheckout ------------------------------------

// doCheckout runs the "work", records one duration observation and one request
// count observation. THIS is the birth of the ~500 bits we follow all hour.
func doCheckout(ctx context.Context) error {
	start := time.Now()
	mode, rate := faults.get()

	// baseline work: 20-60ms
	work := 20 + rand.Intn(40)
	failed := false

	switch mode {
	case "latency":
		if rand.Float64() < rate {
			work += 800 + rand.Intn(700) // +0.8-1.5s
		}
	case "error":
		if rand.Float64() < rate {
			failed = true
		}
	}
	time.Sleep(time.Duration(work) * time.Millisecond)

	outcome := "success"
	if failed {
		outcome = "error"
	}
	attrs := metric.WithAttributes(
		attribute.String("outcome", outcome),
		attribute.String("route", route),
	)
	requests.Add(ctx, 1, attrs)
	latency.Record(ctx, time.Since(start).Seconds(),
		metric.WithAttributes(attribute.String("route", route)))

	if failed {
		return errors.New("simulated checkout failure")
	}
	return nil
}

// ---- HTTP handlers ------------------------------------------------------

func checkoutHandler(w http.ResponseWriter, r *http.Request) {
	if err := doCheckout(r.Context()); err != nil {
		http.Error(w, "checkout failed", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok\n"))
}

// faultHandler flips the incident switch live: /admin/fault?mode=error&rate=0.5
func faultHandler(w http.ResponseWriter, r *http.Request) {
	mode := r.URL.Query().Get("mode")
	if mode == "" {
		mode = "none"
	}
	rate := 1.0
	if v := r.URL.Query().Get("rate"); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			rate = f
		}
	}
	switch mode {
	case "none", "latency", "error":
		faults.set(mode, rate)
		log.Printf("fault mode set: mode=%s rate=%.2f", mode, rate)
		_, _ = w.Write([]byte("fault mode=" + mode + " rate=" + strconv.FormatFloat(rate, 'f', 2, 64) + "\n"))
	default:
		http.Error(w, "mode must be none|latency|error", http.StatusBadRequest)
	}
}

func healthHandler(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("healthy\n"))
}

// ---- SSM fault-flag polling --------------------------------------------

// pollFaultParam watches an SSM parameter (default /500bits/fault) and applies
// its value to the live fault state. Value format: "none" | "error:0.6" |
// "latency:0.5". This is how Act 4's inject-fault.sh flips the incident switch
// without any inbound network path to the (private) service.
func pollFaultParam(ctx context.Context) {
	name := os.Getenv("FAULT_PARAM")
	if name == "" {
		name = "/500bits/fault"
	}
	cfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		log.Printf("SSM disabled (no AWS config): %v", err)
		return
	}
	client := ssm.NewFromConfig(cfg)
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	log.Printf("polling SSM fault flag %q every 5s", name)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			out, err := client.GetParameter(ctx, &ssm.GetParameterInput{Name: &name})
			if err != nil {
				continue // param may not exist yet; keep last known state
			}
			applyFaultFlag(*out.Parameter.Value)
		}
	}
}

// applyFaultFlag parses "mode[:rate]" and updates fault state.
func applyFaultFlag(v string) {
	v = strings.TrimSpace(v)
	if v == "" || v == "none" {
		faults.set("none", 0)
		return
	}
	mode, rateStr, found := strings.Cut(v, ":")
	rate := 1.0
	if found {
		if f, err := strconv.ParseFloat(strings.TrimSpace(rateStr), 64); err == nil {
			rate = f
		}
	}
	switch strings.TrimSpace(mode) {
	case "latency", "error":
		faults.set(strings.TrimSpace(mode), rate)
	default:
		faults.set("none", 0)
	}
}

// ---- internal load generator: keeps ~5 rps flowing ----------------------

func loadGenerator(ctx context.Context) {
	ticker := time.NewTicker(200 * time.Millisecond) // 5 rps
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			_ = doCheckout(ctx)
		}
	}
}

func main() {
	ctx := context.Background()
	shutdown, err := initMeter(ctx)
	if err != nil {
		log.Fatalf("failed to init metrics: %v", err)
	}
	defer func() { _ = shutdown(context.Background()) }()

	go loadGenerator(ctx)
	go pollFaultParam(ctx)

	mux := http.NewServeMux()
	mux.HandleFunc("/checkout", checkoutHandler)
	mux.HandleFunc("/admin/fault", faultHandler)
	mux.HandleFunc("/healthz", healthHandler)

	addr := ":8080"
	log.Printf("checkout-service listening on %s (load generator active ~5 rps)", addr)
	srv := &http.Server{Addr: addr, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	log.Fatal(srv.ListenAndServe())
}
