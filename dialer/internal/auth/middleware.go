// Go chi middleware — RBAC enforcement (M02 PLAN §8.2).
package auth

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/vici2/dialer/internal/auth/rbac"
)

// contextKey is the key for AuthContext in a request context.
type contextKey struct{}

// AuthFromContext retrieves the AuthContext stored by a preceding auth middleware.
func AuthFromContext(ctx context.Context) rbac.AuthContext {
	v, _ := ctx.Value(contextKey{}).(rbac.AuthContext)
	return v
}

// WithAuth stores an AuthContext in the request context.
func WithAuth(ctx context.Context, auth rbac.AuthContext) context.Context {
	return context.WithValue(ctx, contextKey{}, auth)
}

// RequirePermission returns a chi middleware that enforces RBAC via Can().
// extractScope is called once per request to produce the ScopeContext.
// If extractScope is nil, only the tenant check applies.
func RequirePermission(
	verb        string,
	extractScope func(*http.Request) rbac.ScopeContext,
) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			auth := AuthFromContext(r.Context())

			var scope rbac.ScopeContext
			if extractScope != nil {
				scope = extractScope(r)
			} else {
				scope = rbac.ScopeContext{TenantID: auth.TenantID}
			}

			decision := rbac.Can(auth, verb, scope)
			if !decision.Allow {
				writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden", "reason": string(decision.Reason)})
				return
			}
			// Sensitive-allow audit is handled by the caller's audit middleware.
			next.ServeHTTP(w, r)
		})
	}
}

// NoPermission documents intentionally open routes (health, metrics).
// It is a no-op middleware.
func NoPermission(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Intentionally no permission check — see M02 PLAN §8.2
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, body interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
