package auth

import (
	"crypto/subtle"
	"errors"
	"fmt"
	"net/http"
	"strings"
)

// AuthConfig configures HTTP authentication for the MCP server.
type AuthConfig struct {
	BearerTokens        []string
	AllowUnauthenticated bool

	// Built-in OAuth 2.1 server
	OAuthEnabled      bool
	OAuthSecret       string
	OAuthClientID     string
	OAuthClientSecret string

	// External OAuth / OIDC resource server
	ExternalIssuer   string
	ExternalJWKSURL  string
	ExternalAudience string
	RequiredScope    string

	PublicURL string
	MCPPath   string
}

// Authenticator enforces Bearer token or OAuth authentication on HTTP requests
// and mounts OAuth metadata / endpoints when OAuth is enabled.
type Authenticator struct {
	cfg          AuthConfig
	oauthServer  *OAuthServer
	jwksVerifier *JWKSVerifier
}

// NewAuthenticator validates AuthConfig and builds an Authenticator.
func NewAuthenticator(cfg AuthConfig) (*Authenticator, error) {
	if cfg.MCPPath == "" {
		cfg.MCPPath = "/mcp"
	}

	hasBearer := len(cfg.BearerTokens) > 0
	hasExternalOAuth := cfg.ExternalJWKSURL != ""
	hasBuiltinOAuth := cfg.OAuthEnabled

	if hasBuiltinOAuth && hasExternalOAuth {
		return nil, errors.New("cannot enable both built-in OAuth server and external JWKS OAuth at the same time")
	}
	if hasBuiltinOAuth && cfg.OAuthSecret == "" && (cfg.OAuthClientID == "" || cfg.OAuthClientSecret == "") {
		return nil, errors.New("built-in OAuth requires --oauth-secret (for authorization_code) or --oauth-client-id + --oauth-client-secret (for client_credentials)")
	}
	if !hasBearer && !hasBuiltinOAuth && !hasExternalOAuth && !cfg.AllowUnauthenticated {
		return nil, errors.New("HTTP mode requires authentication: set --bearer-token, enable OAuth (--oauth / --oauth-jwks-url), or pass --allow-unauthenticated")
	}

	a := &Authenticator{cfg: cfg}
	if hasBuiltinOAuth {
		srv, err := NewOAuthServer(OAuthServerConfig{
			PublicURL:    cfg.PublicURL,
			MCPPath:      cfg.MCPPath,
			AdminSecret:  cfg.OAuthSecret,
			ClientID:     cfg.OAuthClientID,
			ClientSecret: cfg.OAuthClientSecret,
		})
		if err != nil {
			return nil, fmt.Errorf("init oauth server: %w", err)
		}
		a.oauthServer = srv
	}
	if hasExternalOAuth {
		a.jwksVerifier = NewJWKSVerifier(cfg.ExternalJWKSURL, cfg.ExternalIssuer, cfg.ExternalAudience, cfg.RequiredScope, nil)
	}
	return a, nil
}

// OAuthEnabled returns true if built-in or external OAuth is active.
func (a *Authenticator) OAuthEnabled() bool {
	return a.oauthServer != nil || a.jwksVerifier != nil
}

// RegisterRoutes mounts OAuth endpoints and RFC 9728 protected-resource metadata if enabled.
func (a *Authenticator) RegisterRoutes(mux *http.ServeMux) {
	if a.oauthServer != nil {
		a.oauthServer.RegisterRoutes(mux)
		return
	}
	if a.jwksVerifier != nil {
		mux.HandleFunc("/.well-known/oauth-protected-resource", a.handleExternalProtectedResource)
	}
}

func (a *Authenticator) handleExternalProtectedResource(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	base := a.baseURL(r)
	var authServers []string
	if a.cfg.ExternalIssuer != "" {
		authServers = []string{strings.TrimRight(a.cfg.ExternalIssuer, "/")}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"resource":                 base + a.cfg.MCPPath,
		"authorization_servers":    authServers,
		"bearer_methods_supported": []string{"header"},
	})
}

func (a *Authenticator) baseURL(r *http.Request) string {
	if a.cfg.PublicURL != "" {
		return strings.TrimRight(a.cfg.PublicURL, "/")
	}
	scheme := "http"
	if r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
		scheme = "https"
	}
	return scheme + "://" + r.Host
}

// Middleware wraps an http.Handler with Bearer / OAuth authentication.
func (a *Authenticator) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if a.cfg.AllowUnauthenticated && len(a.cfg.BearerTokens) == 0 && !a.OAuthEnabled() {
			next.ServeHTTP(w, r)
			return
		}

		token, ok := extractBearerToken(r.Header.Get("Authorization"))
		if !ok {
			a.writeUnauthorized(w, r, "missing bearer token")
			return
		}

		// 1. Check static bearer tokens if configured
		for _, expected := range a.cfg.BearerTokens {
			if subtle.ConstantTimeCompare([]byte(token), []byte(expected)) == 1 {
				next.ServeHTTP(w, r)
				return
			}
		}

		// 2. Check built-in OAuth JWT
		if a.oauthServer != nil {
			if _, err := a.oauthServer.VerifyToken(token); err == nil {
				next.ServeHTTP(w, r)
				return
			}
		}

		// 3. Check external JWKS OAuth JWT
		if a.jwksVerifier != nil {
			if _, err := a.jwksVerifier.Verify(r.Context(), token); err == nil {
				next.ServeHTTP(w, r)
				return
			}
		}

		a.writeUnauthorized(w, r, "invalid or expired token")
	})
}

func (a *Authenticator) writeUnauthorized(w http.ResponseWriter, r *http.Request, msg string) {
	if a.OAuthEnabled() {
		metaURL := a.baseURL(r) + "/.well-known/oauth-protected-resource"
		w.Header().Set("WWW-Authenticate", fmt.Sprintf(`Bearer resource_metadata="%s"`, metaURL))
	} else {
		w.Header().Set("WWW-Authenticate", `Bearer realm="cloudcookie-mcp"`)
	}
	writeJSON(w, http.StatusUnauthorized, map[string]string{
		"error":   "unauthorized",
		"message": msg,
	})
}

func extractBearerToken(authHeader string) (string, bool) {
	parts := strings.SplitN(strings.TrimSpace(authHeader), " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return "", false
	}
	tok := strings.TrimSpace(parts[1])
	return tok, tok != ""
}
