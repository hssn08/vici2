package tcpa

import (
	"context"

	"github.com/vici2/dialer/internal/tz"
)

// D03Adapter wraps a *tz.Resolver (D03) to satisfy the tcpa.Resolver interface.
// This replaces StubResolver in production wiring.
//
// Usage in main.go / service init:
//
//	tzResolver := tz.New(db, valkeyClient)
//	if err := tzResolver.Start(ctx); err != nil { ... }
//	checker, _ := tcpa.New(tcpa.CheckerOpts{
//	    Resolver: tcpa.NewD03Adapter(tzResolver),
//	    ...
//	})
type D03Adapter struct {
	r *tz.Resolver
}

// NewD03Adapter wraps a D03 Resolver as a tcpa.Resolver.
func NewD03Adapter(r *tz.Resolver) *D03Adapter {
	return &D03Adapter{r: r}
}

// Resolve implements tcpa.Resolver using the D03 6-tier cascade.
func (a *D03Adapter) Resolve(ctx context.Context, req ResolveRequest) (ResolveResult, error) {
	d03Req := tz.ResolveRequest{
		LeadID:        req.LeadID,
		PhoneE164:     req.PhoneE164,
		KnownTimezone: req.KnownTimezone,
		Zip:           req.Zip,
		State:         req.State,
		// CampaignID not in C01's ResolveRequest; campaign default used if set on Resolver
	}
	d03Res, err := a.r.Resolve(ctx, d03Req)
	if err != nil {
		return ResolveResult{}, err
	}
	return ResolveResult{
		IANA:       d03Res.IANA,
		Confidence: Confidence(d03Res.Confidence), // same string enum values
		Location:   d03Res.Location,
	}, nil
}
