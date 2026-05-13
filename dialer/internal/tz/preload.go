package tz

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"strconv"
	"sync/atomic"
	"time"
)

// phoneMap is the in-process map for phone_codes: key = NPA*1000+NXX.
type phoneMap = map[uint32]cacheEntry

// zipMap is the in-process map for zip_codes: key = zip as uint32.
type zipMap = map[uint32]cacheEntry

// npaMap is the collapse of phone_codes by NPA (first distinct IANA per NPA).
type npaMap = map[string]cacheEntry

// npaStateMap maps NPA (3-char string) to US state code (2-char string).
// Built alongside npaOnlyCache from phone_codes.state.
// X05 uses this for Tier-3 same-state matching.
type npaStateMap = map[string]string

// Preload reads phone_codes, phone_codes_overrides, and zip_codes from MySQL
// into the in-process maps. It is called at boot and every 6 hours.
// If MySQL is unavailable at boot, it returns an error (fail-fast).
func (r *Resolver) Preload(ctx context.Context) error {
	slog.Info("tz: preload started")
	start := time.Now()

	if err := r.loadPhoneCodes(ctx); err != nil {
		return fmt.Errorf("tz: loadPhoneCodes: %w", err)
	}
	if err := r.loadOverrides(ctx); err != nil {
		return fmt.Errorf("tz: loadOverrides: %w", err)
	}
	if err := r.loadZipCodes(ctx); err != nil {
		return fmt.Errorf("tz: loadZipCodes: %w", err)
	}

	r.lastLoadedAt.Store(time.Now().UnixNano())
	slog.Info("tz: preload complete", "elapsed", time.Since(start))
	return nil
}

// loadPhoneCodes loads phone_codes into phoneCodesCache, npaOnlyCache, and npaStateCache.
func (r *Resolver) loadPhoneCodes(ctx context.Context) error {
	rows, err := r.db.QueryContext(ctx,
		`SELECT area_code, exchange_code, tz_iana, state FROM phone_codes`)
	if err != nil {
		return err
	}
	defer rows.Close()

	fresh := make(phoneMap, 170_000)
	npa := make(npaMap, 900)
	npaState := make(npaStateMap, 900)

	for rows.Next() {
		var areaCode, exchangeCode, tzIANA string
		var state sql.NullString
		if err := rows.Scan(&areaCode, &exchangeCode, &tzIANA, &state); err != nil {
			return err
		}
		loc, ok := loadLocation(tzIANA)
		if !ok {
			slog.Warn("tz: invalid IANA in phone_codes", "iana", tzIANA)
			continue
		}
		entry := cacheEntry{IANA: tzIANA, Loc: loc}

		npaInt, _ := strconv.ParseUint(areaCode, 10, 32)
		nxxInt, _ := strconv.ParseUint(exchangeCode, 10, 32)
		key := uint32(npaInt*1000 + nxxInt)
		fresh[key] = entry

		// NPA collapse: first distinct IANA wins
		if _, exists := npa[areaCode]; !exists {
			npa[areaCode] = entry
		}

		// X05: NPA→state mapping (first distinct state per NPA wins)
		if state.Valid && state.String != "" {
			if _, exists := npaState[areaCode]; !exists {
				npaState[areaCode] = state.String
			}
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}

	r.phoneCodesCache.Store(&fresh)
	r.npaOnlyCache.Store(&npa)
	r.npaStateCache.Store(&npaState)
	tzPhoneCodesLoaded.Set(float64(len(fresh)))
	tzCacheSize.WithLabelValues("phone_codes").Set(float64(len(fresh)))
	tzCacheSize.WithLabelValues("npa_only").Set(float64(len(npa)))
	slog.Info("tz: phone_codes loaded", "nxx_rows", len(fresh), "npa_rows", len(npa))
	return nil
}

// loadOverrides loads phone_codes_overrides into overrideCache.
func (r *Resolver) loadOverrides(ctx context.Context) error {
	rows, err := r.db.QueryContext(ctx,
		`SELECT area_code, exchange_code, tz_iana FROM phone_codes_overrides`)
	if err != nil {
		return err
	}
	defer rows.Close()

	fresh := make(phoneMap, 100)
	for rows.Next() {
		var areaCode, exchangeCode, tzIANA string
		if err := rows.Scan(&areaCode, &exchangeCode, &tzIANA); err != nil {
			return err
		}
		loc, ok := loadLocation(tzIANA)
		if !ok {
			slog.Warn("tz: invalid IANA in phone_codes_overrides", "iana", tzIANA)
			continue
		}
		npaInt, _ := strconv.ParseUint(areaCode, 10, 32)
		nxxInt, _ := strconv.ParseUint(exchangeCode, 10, 32)
		key := uint32(npaInt*1000 + nxxInt)
		fresh[key] = cacheEntry{IANA: tzIANA, Loc: loc}
	}
	if err := rows.Err(); err != nil {
		return err
	}

	r.overrideCache.Store(&fresh)
	tzCacheSize.WithLabelValues("overrides").Set(float64(len(fresh)))
	return nil
}

// loadZipCodes loads zip_codes into zipCodesCache.
func (r *Resolver) loadZipCodes(ctx context.Context) error {
	rows, err := r.db.QueryContext(ctx,
		`SELECT zip, tz_iana FROM zip_codes`)
	if err != nil {
		return err
	}
	defer rows.Close()

	fresh := make(zipMap, 35_000)
	for rows.Next() {
		var zip, tzIANA string
		if err := rows.Scan(&zip, &tzIANA); err != nil {
			return err
		}
		loc, ok := loadLocation(tzIANA)
		if !ok {
			slog.Warn("tz: invalid IANA in zip_codes", "iana", tzIANA)
			continue
		}
		key := zipKey(zip)
		fresh[key] = cacheEntry{IANA: tzIANA, Loc: loc}
	}
	if err := rows.Err(); err != nil {
		return err
	}

	r.zipCodesCache.Store(&fresh)
	tzCacheSize.WithLabelValues("zip").Set(float64(len(fresh)))
	slog.Info("tz: zip_codes loaded", "rows", len(fresh))
	return nil
}

// reloadNXX reloads a single NXX entry from phone_codes_overrides.
// Called when the Valkey pubsub channel receives a specific NXX invalidation.
func (r *Resolver) reloadNXX(npa, nxx string) {
	ctx := context.Background()
	var tzIANA string
	err := r.db.QueryRowContext(ctx,
		`SELECT tz_iana FROM phone_codes_overrides
		 WHERE area_code = ? AND exchange_code = ?`, npa, nxx).Scan(&tzIANA)

	npaInt, _ := strconv.ParseUint(npa, 10, 32)
	nxxInt, _ := strconv.ParseUint(nxx, 10, 32)
	key := uint32(npaInt*1000 + nxxInt)

	if err == sql.ErrNoRows {
		// Override deleted — remove from map
		old := r.overrideCache.Load().(*phoneMap)
		fresh := copyPhoneMap(*old)
		delete(fresh, key)
		r.overrideCache.Store(&fresh)
		slog.Info("tz: override removed", "npa", npa, "nxx", nxx)
		return
	}
	if err != nil {
		slog.Error("tz: reloadNXX query failed", "err", err)
		return
	}
	loc, ok := loadLocation(tzIANA)
	if !ok {
		slog.Warn("tz: invalid IANA on reload", "iana", tzIANA)
		return
	}
	old := r.overrideCache.Load().(*phoneMap)
	fresh := copyPhoneMap(*old)
	fresh[key] = cacheEntry{IANA: tzIANA, Loc: loc}
	r.overrideCache.Store(&fresh)
	slog.Info("tz: override reloaded", "npa", npa, "nxx", nxx, "iana", tzIANA)
}

// copyPhoneMap makes a shallow copy of a phoneMap.
func copyPhoneMap(m phoneMap) phoneMap {
	c := make(phoneMap, len(m)+1)
	for k, v := range m {
		c[k] = v
	}
	return c
}

// startPeriodicRefresh launches background goroutines for periodic cache refresh.
// phone_codes: every 6 hours; zip_codes: every 24 hours.
func (r *Resolver) startPeriodicRefresh(ctx context.Context) {
	go func() {
		phoneTicker := time.NewTicker(6 * time.Hour)
		zipTicker := time.NewTicker(24 * time.Hour)
		ageTicker := time.NewTicker(30 * time.Second)
		defer phoneTicker.Stop()
		defer zipTicker.Stop()
		defer ageTicker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-phoneTicker.C:
				slog.Info("tz: 6h periodic phone_codes refresh")
				if err := r.loadPhoneCodes(ctx); err != nil {
					slog.Error("tz: periodic phone_codes refresh failed", "err", err)
				} else {
					tzInvalidations.WithLabelValues("periodic_6h").Inc()
					r.lastLoadedAt.Store(time.Now().UnixNano())
				}
				if err := r.loadOverrides(ctx); err != nil {
					slog.Error("tz: periodic overrides refresh failed", "err", err)
				}
			case <-zipTicker.C:
				slog.Info("tz: 24h periodic zip_codes refresh")
				if err := r.loadZipCodes(ctx); err != nil {
					slog.Error("tz: periodic zip_codes refresh failed", "err", err)
				} else {
					tzInvalidations.WithLabelValues("periodic_24h").Inc()
				}
			case <-ageTicker.C:
				// Update phone_codes_age_seconds gauge
				lastNs := r.lastLoadedAt.Load()
				if lastNs != 0 {
					ageSec := time.Since(time.Unix(0, lastNs)).Seconds()
					tzPhoneCodesAge.Set(ageSec)
				}
			}
		}
	}()
}

// atomicInt64 wraps atomic.Int64 to avoid init issues.
type atomicInt64 struct {
	v atomic.Int64
}

func (a *atomicInt64) Store(v int64) { a.v.Store(v) }
func (a *atomicInt64) Load() int64   { return a.v.Load() }
