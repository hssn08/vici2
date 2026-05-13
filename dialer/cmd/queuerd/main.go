// Package main is the I01 inbound queue daemon (queuerd).
//
// I01 PLAN §18.1: queuerd binary. Imports dialer/internal/queue/,
// dialer/internal/esl/ (T01), dialer/internal/conference/ (T03).
//
// Reads environment variables for connectivity:
//   VALKEY_URL or REDIS_URL — Valkey/Redis connection
//   DATABASE_URL            — MySQL connection string
//   FS_HOST                 — FreeSWITCH ESL host (default: freeswitch)
//   FS_PORT                 — FreeSWITCH ESL port (default: 8021)
//   FS_PASSWORD             — FreeSWITCH ESL password
//   POD_ID                  — unique pod identifier (default: hostname)
//   TENANT_ID               — tenant ID (default: 1)
//   METRICS_PORT            — Prometheus metrics port (default: 9105)
//   DIALPLAN_DIR            — path to dialplan/default/ dir for XML rendering
package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	_ "github.com/joho/godotenv/autoload"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/redis/go-redis/v9"

	"github.com/vici2/dialer/internal/conference"
	"github.com/vici2/dialer/internal/esl"
	"github.com/vici2/dialer/internal/queue"
	vkey "github.com/vici2/dialer/internal/valkey"
)

const serviceName = "queuerd"

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
	slog.SetDefault(logger.With(slog.String("service", serviceName)))

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	if err := run(ctx, logger); err != nil && !errors.Is(err, context.Canceled) {
		logger.Error("queuerd exited with error", "err", err)
		os.Exit(1)
	}
	logger.Info("queuerd stopped")
}

func run(ctx context.Context, log *slog.Logger) error {
	// --- Config from env -------------------------------------------------------
	tenantID := int64(1)
	if tid := os.Getenv("TENANT_ID"); tid != "" {
		if v, err := strconv.ParseInt(tid, 10, 64); err == nil {
			tenantID = v
		}
	}

	podID := os.Getenv("POD_ID")
	if podID == "" {
		podID, _ = os.Hostname()
	}
	if podID == "" {
		podID = fmt.Sprintf("queuerd-%d", os.Getpid())
	}

	metricsPort := envOr("METRICS_PORT", "9105")
	dialplanDir := envOr("DIALPLAN_DIR", "/etc/freeswitch/dialplan/default")
	fsHost := envOr("FS_HOST", "freeswitch")
	fsPort := envOr("FS_PORT", "8021")
	fsPass := envOr("FS_PASSWORD", "ClueCon")
	dbURL := envOr("DATABASE_URL", "")

	// --- Prometheus ------------------------------------------------------------
	reg := prometheus.NewRegistry()
	prometheus.MustRegister() // noop but load default metrics separately
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok","service":"queuerd"}`))
	})
	mux.Handle("/metrics", promhttp.HandlerFor(reg, promhttp.HandlerOpts{}))

	metricsSrv := &http.Server{
		Addr:              ":" + metricsPort,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		log.Info("queuerd metrics", "port", metricsPort)
		if err := metricsSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("metrics server failed", "err", err)
		}
	}()
	defer metricsSrv.Shutdown(context.Background()) //nolint:errcheck

	// --- Redis / Valkey --------------------------------------------------------
	valkeyURL := envFirstNonEmpty(
		os.Getenv("VALKEY_STATE_URL"),
		os.Getenv("VALKEY_URL"),
		os.Getenv("REDIS_URL"),
	)
	if valkeyURL == "" {
		return fmt.Errorf("queuerd: VALKEY_URL / REDIS_URL not set")
	}
	opt, err := redis.ParseURL(valkeyURL)
	if err != nil {
		return fmt.Errorf("queuerd: parse VALKEY_URL: %w", err)
	}
	rdb := redis.NewClient(opt)
	defer rdb.Close()
	if err := rdb.Ping(ctx).Err(); err != nil {
		return fmt.Errorf("queuerd: Redis ping: %w", err)
	}
	log.Info("queuerd: Redis connected", "url", valkeyURL)

	// --- MySQL (optional — required for full operation but not for unit tests) -
	var db *sql.DB
	if dbURL != "" {
		// MySQL driver must be imported by the caller or integration binary.
		// For now, attempt open and warn on failure rather than fatal.
		db, err = sql.Open("mysql", dbURL)
		if err != nil {
			log.Warn("queuerd: sql.Open failed (no MySQL driver?)", "err", err)
			db = nil
		} else {
			db.SetConnMaxLifetime(3 * time.Minute)
			db.SetMaxOpenConns(10)
			db.SetMaxIdleConns(5)
			if pingErr := db.PingContext(ctx); pingErr != nil {
				log.Warn("queuerd: DB ping failed", "err", pingErr)
				db = nil
			} else {
				log.Info("queuerd: MySQL connected")
				defer db.Close()
			}
		}
	} else {
		log.Warn("queuerd: DATABASE_URL not set — running without MySQL (test mode)")
	}

	// --- ESL client (T01) ------------------------------------------------------
	eslHostPort := fmt.Sprintf("%s:%s", fsHost, fsPort)
	eslOpts := esl.Options{
		FSHosts:  []string{eslHostPort},
		Password: fsPass,
	}
	eslClient, err := esl.New(eslOpts, rdb, reg)
	if err != nil {
		return fmt.Errorf("queuerd: ESL client init: %w", err)
	}
	// Start ESL supervisor goroutines.
	go func() {
		if err := eslClient.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
			log.Error("queuerd: ESL Run exited", "err", err)
		}
	}()

	// --- Conference operator (T03) — valkey.Client wrapper --------------------
	vkeyCfg := vkey.Config{
		URL:      valkeyURL,
		TenantID: tenantID,
	}
	vkeyClient, err := vkey.New(ctx, vkeyCfg)
	if err != nil {
		log.Warn("queuerd: valkey.New failed", "err", err)
		// Non-fatal: operator works without Valkey (ESL fallback mode).
	}
	operator := conference.New(eslClient, vkeyClient, fsHost, log)

	// --- Dialplan renderer (I01 §15) -------------------------------------------
	renderer, err := queue.NewIngroupRenderer(dialplanDir, eslClient, fsHost, log)
	if err != nil {
		log.Warn("queuerd: IngroupRenderer init failed", "err", err)
		// Non-fatal: renderer is optional at startup.
	}
	_ = renderer // used by API routes when triggered via admin save

	// --- Queue supervisor -------------------------------------------------------
	supervisor := queue.NewQueueSupervisor(queue.SupervisorConfig{
		TenantID:   tenantID,
		PodID:      podID,
		DB:         db,
		Rdb:        rdb,
		ESLClient:  eslClient,
		FSHost:     fsHost,
		Operator:   operator,
		Prometheus: reg,
		Log:        log,
	})

	log.Info("queuerd: starting supervisor", "tenant_id", tenantID, "pod_id", podID)
	return supervisor.Run(ctx)
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envFirstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}
