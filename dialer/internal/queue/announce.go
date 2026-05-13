package queue

import (
	"context"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/vici2/dialer/internal/esl"
)

// AnnouncementScheduler sends queue position / EWT announcements to waiting callers.
// I01 PLAN §7.3 + §18.2.
type AnnouncementScheduler struct {
	rdb     *redis.Client
	eslCli  *esl.Client
	fsHost  string
	keys    QueueKeys
	aht     *AHTUpdater
	log     *slog.Logger
	metrics *Metrics
}

// NewAnnouncementScheduler creates an AnnouncementScheduler.
func NewAnnouncementScheduler(
	rdb *redis.Client,
	eslCli *esl.Client,
	fsHost string,
	keys QueueKeys,
	aht *AHTUpdater,
	log *slog.Logger,
	metrics *Metrics,
) *AnnouncementScheduler {
	if log == nil {
		log = slog.Default()
	}
	return &AnnouncementScheduler{
		rdb:     rdb,
		eslCli:  eslCli,
		fsHost:  fsHost,
		keys:    keys,
		aht:     aht,
		log:     log,
		metrics: metrics,
	}
}

// RunForIngroup starts the announcement loop for one in-group.
// Wakes every ig.AnnounceIntervalSec. I01 PLAN §7.3.
func (s *AnnouncementScheduler) RunForIngroup(ctx context.Context, ig *InGroup) {
	if ig.AnnounceIntervalSec <= 0 {
		return // announcements disabled
	}
	ticker := time.NewTicker(time.Duration(ig.AnnounceIntervalSec) * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := s.announceAll(ctx, ig); err != nil {
				s.log.Error("announce: announceAll", "ingroup", ig.ID, "err", err)
			}
		}
	}
}

// announceAll iterates all waiting calls in the queue and sends announcements.
func (s *AnnouncementScheduler) announceAll(ctx context.Context, ig *InGroup) error {
	// Get current ready agents count for EWT calculation.
	readyCount, err := s.rdb.ZCard(ctx, s.keys.IngroupReadyAgents(ig.ID)).Result()
	if err != nil {
		return fmt.Errorf("announce: ZCARD ready_agents: %w", err)
	}

	// Update EWT per-position key.
	if err := s.aht.UpdateEWTPerPos(ctx, ig.ID, float64(readyCount)); err != nil {
		s.log.Warn("announce: UpdateEWTPerPos", "ingroup", ig.ID, "err", err)
	}

	ahtSec := s.aht.GetAHT(ctx, ig.ID)

	// Get all calls in queue, ordered by score (dispatch priority).
	callUUIDs, err := s.rdb.ZRangeByScore(ctx, s.keys.IngroupQueue(ig.ID), &redis.ZRangeBy{
		Min: "-inf",
		Max: "+inf",
	}).Result()
	if err != nil {
		return fmt.Errorf("announce: ZRANGE queue: %w", err)
	}

	// Update metrics.
	s.metrics.QueueDepth.WithLabelValues(ig.ID).Set(float64(len(callUUIDs)))
	s.metrics.ReadyAgents.WithLabelValues(ig.ID).Set(float64(readyCount))

	// EWT for position 1.
	if len(callUUIDs) > 0 {
		ewt1 := ComputeEWT(1, ahtSec, float64(readyCount))
		s.metrics.EWTSeconds.WithLabelValues(ig.ID).Set(ewt1)
	}

	for i, callUUID := range callUUIDs {
		pos := i + 1 // 1-indexed
		ewt := ComputeEWT(pos, ahtSec, float64(readyCount))

		if !ShouldAnnounce(ewt, ig) {
			continue
		}

		// Check last announce time to avoid spamming.
		lastAnnounceStr, _ := s.rdb.HGet(ctx, s.keys.QueueCall(callUUID), "last_announce_ts").Result()
		if lastAnnounceStr != "" {
			lastTs, err := strconv.ParseInt(lastAnnounceStr, 10, 64)
			if err == nil {
				elapsed := time.Since(time.UnixMilli(lastTs))
				if elapsed < time.Duration(ig.AnnounceIntervalSec)*time.Second {
					continue
				}
			}
		}

		// Play announcement: position + EWT.
		if err := s.playAnnouncement(ctx, callUUID, pos, int(ewt)); err != nil {
			s.log.Warn("announce: play failed", "call_uuid", callUUID, "err", err)
			continue
		}

		// Update last_announce_ts.
		s.rdb.HSet(ctx, s.keys.QueueCall(callUUID), "last_announce_ts", strconv.FormatInt(time.Now().UnixMilli(), 10))
	}

	return nil
}

// playAnnouncement sends a uuid_broadcast to play the queue position audio.
// I01 PLAN §7.3: concatenated mod_say + pre-recorded WAV segments.
func (s *AnnouncementScheduler) playAnnouncement(ctx context.Context, callUUID string, pos, ewtSec int) error {
	// Audio sequence using FreeSWITCH inline playlist syntax.
	// Combines pre-recorded prefix/suffix WAVs with mod_say numeric synthesis.
	audio := fmt.Sprintf(
		"file_string://sounds/i01/you_are_caller_number.wav!say:en:number:iterated:%d!sounds/i01/estimated_wait.wav!say:en:time_measurement:pronounced:%d!sounds/i01/please_hold.wav",
		pos,
		ewtSec,
	)
	return s.eslCli.UUIDBroadcast(ctx, s.fsHost, callUUID, audio, "aleg")
}

// PlayWelcome plays the welcome audio for a newly queued call.
// I01 PLAN §7.1.
func (s *AnnouncementScheduler) PlayWelcome(ctx context.Context, callUUID string, ig *InGroup) error {
	if ig.WelcomeAudio == nil || *ig.WelcomeAudio == "" {
		return nil
	}
	return s.eslCli.UUIDBroadcast(ctx, s.fsHost, callUUID, *ig.WelcomeAudio, "aleg")
}
