// Package main is the dialer engine entry point.
//
// F01 ships a hello-world stub: structured slog JSON to stdout, /health on the
// metrics port, /metrics in Prometheus exposition format. Subsequent modules
// (T01, T04, E01-E06) add the real pacing engine.
//
// E02: pacing.NewManager is wired here when VALKEY_URL is set. If Valkey is
// unreachable, the manager is skipped (degraded mode: no pacing, metrics only).
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	_ "github.com/joho/godotenv/autoload"
	"github.com/redis/go-redis/v9"
	"github.com/vici2/dialer/internal/pacing"
	"github.com/vici2/dialer/internal/telemetry"
	vkey "github.com/vici2/dialer/internal/valkey"
)

const serviceName = "dialer"

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
	slog.SetDefault(logger.With(
		slog.String("service", serviceName),
	))

	metricsPort := envOr("METRICS_PORT", "9102")
	grpcPort := envOr("GRPC_PORT", "7000")

	registry := telemetry.NewRegistry(serviceName)

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok","service":"dialer"}`))
	})
	mux.Handle("/metrics", registry.Handler())

	srv := &http.Server{
		Addr:              ":" + metricsPort,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	go func() {
		slog.Info("dialer starting",
			slog.String("module", "main"),
			slog.String("metrics_port", metricsPort),
			slog.String("grpc_port", grpcPort),
		)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("metrics server failed", slog.String("err", err.Error()))
			os.Exit(1)
		}
	}()

	// E02: start the pacing manager if Valkey is configured.
	// Phase 2: InitialCampaigns are empty (no MySQL scan); campaigns arrive via
	// pubsub "campaign_started" events. MySQL stub: db=nil → config.Put() for tests.
	if valkeyURL := envFirstNonEmpty(
		os.Getenv("VALKEY_STATE_URL"),
		os.Getenv("VALKEY_URL"),
		os.Getenv("REDIS_URL"),
	); valkeyURL != "" {
		rc, err := redis.ParseURL(valkeyURL)
		if err != nil {
			slog.Warn("pacing: invalid Valkey URL; pacing disabled",
				slog.String("err", err.Error()))
		} else {
			vrc := redis.NewClient(rc)
			keys := vkey.NewKeys(1) // Phase 1: single-tenant
			hostname, _ := os.Hostname()
			podID := hostname
			if podID == "" {
				podID = fmt.Sprintf("pid-%d", os.Getpid())
			}
			mgr := pacing.NewManager(pacing.ManagerConfig{
				Valkey:     vrc,
				Keys:       keys,
				Prometheus: registry.Reg(),
				PodID:      podID,
				TenantID:   1,
			})
			go func() {
				if err := mgr.Start(ctx); err != nil {
					slog.Error("pacing manager error", slog.String("err", err.Error()))
				}
			}()
			slog.Info("pacing: E02 manager started", slog.String("pod_id", podID))
		}
	} else {
		slog.Info("pacing: no VALKEY_URL set; pacing manager not started")
	}

	<-ctx.Done()
	slog.Info("dialer shutting down")

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutdownCancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		slog.Error("shutdown error", slog.String("err", err.Error()))
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envFirstNonEmpty(vs ...string) string {
	for _, v := range vs {
		if v != "" {
			return v
		}
	}
	return ""
}

// compile-time interface assertion (placeholder; ensures fmt import used in
// future expansion without trip-up).
var _ = fmt.Sprintf
