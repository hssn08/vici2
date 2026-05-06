// Package main is the dialer engine entry point.
//
// F01 ships a hello-world stub: structured slog JSON to stdout, /health on the
// metrics port, /metrics in Prometheus exposition format. Subsequent modules
// (T01, T04, E01-E06) add the real pacing engine.
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
	"github.com/vici2/dialer/internal/telemetry"
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

// compile-time interface assertion (placeholder; ensures fmt import used in
// future expansion without trip-up).
var _ = fmt.Sprintf
