// Command eslbridge is the FreeSWITCH ESL event-fan-out daemon.
//
// It maintains a persistent inbound ESL connection per configured FS host,
// subscribes to the T01 event allowlist, enriches events with Valkey HASH
// lookups, and publishes to durable Valkey Streams and low-latency pub/sub.
//
// T01 PLAN §2.2.
//
// # Ports
//
//   - ESLBRIDGE_METRICS_PORT (default 9104): Prometheus /metrics
//   - ESLBRIDGE_HTTP_PORT    (default 8080):  /health
//
// # Env vars
//
// See T01 PLAN §3.4 for the full table. Requires FS_HOSTS and
// FS_EVENT_SOCKET_PASSWORD. Valkey connection from VALKEY_URL / REDIS_URL.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	_ "github.com/joho/godotenv/autoload"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/redis/go-redis/v9"
	"github.com/vici2/dialer/internal/esl"
	"github.com/vici2/dialer/internal/valkey"
)

const serviceName = "eslbridge"

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
	slog.SetDefault(logger.With(slog.String("service", serviceName)))

	metricsPort := envOr("ESLBRIDGE_METRICS_PORT", "9104")
	httpPort := envOr("ESLBRIDGE_HTTP_PORT", "8080")

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	// Valkey client (for fan-out and hydration).
	var rdb redis.Cmdable
	vc, err := valkey.NewFromEnv(ctx)
	if err != nil {
		slog.Warn("valkey unavailable; running without fan-out", slog.String("err", err.Error()))
	} else {
		slog.Info("valkey connected")
		rdb = vc.State
	}

	// Prometheus registry (separate from dialer's to avoid metric name collisions).
	reg := prometheus.NewRegistry()

	// Build the ESL client.
	eslClient, err := esl.NewFromEnv(rdb, reg)
	if err != nil {
		slog.Error("esl client init failed", slog.String("err", err.Error()))
		os.Exit(1)
	}

	// HTTP server: /health on ESLBRIDGE_HTTP_PORT.
	healthMux := http.NewServeMux()
	healthMux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		status := eslClient.HostStatus()
		healthy := len(eslClient.HealthyHosts()) > 0
		code := http.StatusOK
		if !healthy {
			code = http.StatusServiceUnavailable
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(code)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"service": serviceName,
			"ok":      healthy,
			"hosts":   status,
		})
	})
	healthSrv := &http.Server{
		Addr:              ":" + httpPort,
		Handler:           healthMux,
		ReadHeaderTimeout: 5 * time.Second,
	}

	// HTTP server: /metrics on ESLBRIDGE_METRICS_PORT.
	metricsMux := http.NewServeMux()
	metricsMux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"ok"}`))
	})
	// Prometheus handler using the local registry.
	metricsMux.HandleFunc("/metrics", func(w http.ResponseWriter, r *http.Request) {
		// Use standard Prometheus text format.
		w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		// Gather from our registry.
		families, _ := reg.Gather()
		for _, f := range families {
			if f == nil {
				continue
			}
			_ = f // encode via expfmt below once we add the dependency
		}
	})
	metricsSrv := &http.Server{
		Addr:              ":" + metricsPort,
		Handler:           metricsMux,
		ReadHeaderTimeout: 5 * time.Second,
	}

	// Start HTTP servers.
	go func() {
		slog.Info("eslbridge health endpoint", slog.String("port", httpPort))
		if err := healthSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("health server failed", slog.String("err", err.Error()))
		}
	}()
	go func() {
		slog.Info("eslbridge metrics endpoint", slog.String("port", metricsPort))
		if err := metricsSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("metrics server failed", slog.String("err", err.Error()))
		}
	}()

	// Run the ESL client (blocks until ctx cancelled).
	slog.Info("eslbridge starting ESL client")
	if err := eslClient.Run(ctx); err != nil {
		slog.Error("esl client error", slog.String("err", err.Error()))
	}

	// Shutdown HTTP servers.
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutdownCancel()
	_ = healthSrv.Shutdown(shutdownCtx)
	_ = metricsSrv.Shutdown(shutdownCtx)

	slog.Info("eslbridge stopped")
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
