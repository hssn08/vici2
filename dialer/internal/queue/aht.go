package queue

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"math"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

// AHTUpdater maintains the EWMA avg handle time per in-group.
// I01 PLAN §8.2 + §18.2 (AHTUpdater goroutine).
type AHTUpdater struct {
	db   *sql.DB
	rdb  *redis.Client
	keys QueueKeys
	log  *slog.Logger
}

// NewAHTUpdater creates an AHTUpdater.
func NewAHTUpdater(db *sql.DB, rdb *redis.Client, keys QueueKeys, log *slog.Logger) *AHTUpdater {
	if log == nil {
		log = slog.Default()
	}
	return &AHTUpdater{db: db, rdb: rdb, keys: keys, log: log}
}

// SeedFromDB loads the last 100 inbound call talk_seconds for each in-group
// and seeds the EWMA. Called at startup. I01 PLAN §8.1.
func (u *AHTUpdater) SeedFromDB(ctx context.Context, ingroups []string) error {
	const q = `
		SELECT ingroup_id, talk_seconds
		FROM call_log
		WHERE tenant_id = ? AND direction = 'inbound' AND ingroup_id = ?
		ORDER BY created_at DESC
		LIMIT 100`

	for _, igid := range ingroups {
		rows, err := u.db.QueryContext(ctx, q, u.keys.tid, igid)
		if err != nil {
			u.log.Warn("aht: seed query failed", "ingroup", igid, "err", err)
			continue
		}

		var samples []float64
		for rows.Next() {
			var (
				ig   string
				secs int
			)
			if err := rows.Scan(&ig, &secs); err == nil {
				samples = append(samples, float64(secs))
			}
		}
		rows.Close()

		if len(samples) == 0 {
			// No data — set default.
			if err := u.setAHT(ctx, igid, AHTDefault); err != nil {
				u.log.Warn("aht: setAHT default failed", "ingroup", igid, "err", err)
			}
			continue
		}

		// Run EWMA over samples (oldest first).
		for i := len(samples) - 1; i >= 0; i-- {
			// We don't persist mid-way; just compute final.
		}
		// Simple mean for seed (EWMA converges quickly after real calls).
		sum := 0.0
		for _, s := range samples {
			sum += s
		}
		aht := sum / float64(len(samples))
		if err := u.setAHT(ctx, igid, aht); err != nil {
			u.log.Warn("aht: setAHT seed failed", "ingroup", igid, "err", err)
		}
	}
	return nil
}

// Update applies the EWMA for a completed inbound call.
// I01 PLAN §8.2.
func (u *AHTUpdater) Update(ctx context.Context, igid string, talkSeconds int) error {
	currentStr, err := u.rdb.HGet(ctx, u.keys.IngroupQueueMeta(igid), "avg_handle_sec").Result()
	current := AHTDefault
	if err == nil {
		if v, err2 := strconv.ParseFloat(currentStr, 64); err2 == nil {
			current = v
		}
	}
	newAHT := (1-AHTAlpha)*current + AHTAlpha*float64(talkSeconds)
	return u.setAHT(ctx, igid, newAHT)
}

// setAHT stores the AHT value in Redis.
func (u *AHTUpdater) setAHT(ctx context.Context, igid string, aht float64) error {
	return u.rdb.HSet(ctx, u.keys.IngroupQueueMeta(igid), "avg_handle_sec", aht).Err()
}

// GetAHT retrieves the current AHT for an in-group.
func (u *AHTUpdater) GetAHT(ctx context.Context, igid string) float64 {
	v, err := u.rdb.HGet(ctx, u.keys.IngroupQueueMeta(igid), "avg_handle_sec").Result()
	if err != nil {
		return AHTDefault
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil {
		return AHTDefault
	}
	return f
}

// ComputeEWT computes estimated wait time for a given position.
// I01 PLAN §8.1 (FROZEN).
// pos is 1-indexed.
func ComputeEWT(pos int, ahtSeconds, readyAgents float64) float64 {
	if readyAgents < 1 {
		readyAgents = 1
	}
	ewt := float64(pos) * ahtSeconds / readyAgents
	return roundEWT(ewt)
}

// roundEWT rounds EWT per the FROZEN rounding rules.
// I01 PLAN §8.1.
func roundEWT(ewt float64) float64 {
	if ewt < 60 {
		return ewt // no announce (caller-facing check below)
	}
	if ewt < 120 {
		// Round up to nearest 30 s
		return math.Ceil(ewt/30) * 30
	}
	// Round up to nearest 60 s
	return math.Ceil(ewt/60) * 60
}

// ShouldAnnounce returns true if the EWT meets the minimum threshold.
// I01 PLAN §8.1.
func ShouldAnnounce(ewtSeconds float64, ig *InGroup) bool {
	return ewtSeconds >= float64(ig.AnnounceMinWaitSec)
}

// RunAHTUpdater starts a background loop that listens for inbound call-ended
// events and updates EWMA. I01 PLAN §18.2.
func (u *AHTUpdater) RunAHTUpdater(ctx context.Context) error {
	// Subscribe to call ended events stream.
	lastID := "$"
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		entries, err := u.rdb.XRead(ctx, &redis.XReadArgs{
			Streams: []string{"events:vici2.call.ended", lastID},
			Count:   100,
			Block:   5 * time.Second,
		}).Result()
		if err != nil {
			if err == redis.Nil {
				continue
			}
			u.log.Error("aht: XRead call.ended", "err", err)
			time.Sleep(time.Second)
			continue
		}

		for _, stream := range entries {
			for _, msg := range stream.Messages {
				lastID = msg.ID

				direction, _ := msg.Values["direction"].(string)
				if direction != "inbound" {
					continue
				}
				igid, _ := msg.Values["ingroup_id"].(string)
				talkStr, _ := msg.Values["talk_seconds"].(string)
				if igid == "" || talkStr == "" {
					continue
				}
				talkSec, err := strconv.Atoi(talkStr)
				if err != nil {
					continue
				}

				if err := u.Update(ctx, igid, talkSec); err != nil {
					u.log.Error("aht: update failed", "ingroup", igid, "err", err)
				}
			}
		}
	}
}

// UpdateEWTPerPos recomputes and stores the EWT-per-pos key.
// Called every 30s by the announcement scheduler.
// I01 PLAN §8.3.
func (u *AHTUpdater) UpdateEWTPerPos(ctx context.Context, igid string, readyAgents float64) error {
	aht := u.GetAHT(ctx, igid)
	if readyAgents < 1 {
		readyAgents = 1
	}
	ewtPerPos := aht / readyAgents
	// Store with 60 s TTL so stale values expire on dispatcher crash.
	return u.rdb.Set(ctx, u.keys.EWTPerPos(igid), fmt.Sprintf("%.2f", ewtPerPos), 60*time.Second).Err()
}
