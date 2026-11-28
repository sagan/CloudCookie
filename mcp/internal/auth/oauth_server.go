package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"html/template"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"
)

// OAuthServerConfig configures the built-in OAuth 2.1 Authorization Server.
type OAuthServerConfig struct {
	PublicURL    string
	MCPPath      string
	AdminSecret  string // Required to approve authorization_code consent UI
	ClientID     string // Optional pre-configured client_credentials client_id
	ClientSecret string // Optional pre-configured client_credentials client_secret
	SigningKey   []byte // Optional 32-byte HMAC signing key; random if empty
}

type registeredClient struct {
	ClientID     string
	ClientSecret string
	ClientName   string
	RedirectURIs []string
}

type authCodeEntry struct {
	ClientID            string
	RedirectURI         string
	CodeChallenge       string
	CodeChallengeMethod string
	Scope               string
	ExpiresAt           time.Time
}

type refreshEntry struct {
	ClientID  string
	Scope     string
	ExpiresAt time.Time
}

// OAuthServer is a self-contained OAuth 2.1 Authorization Server with PKCE,
// Dynamic Client Registration (RFC 7591), and client_credentials support.
type OAuthServer struct {
	cfg        OAuthServerConfig
	signingKey []byte

	mu            sync.Mutex
	clients       map[string]registeredClient
	codes         map[string]authCodeEntry
	refreshTokens map[string]refreshEntry
}

// NewOAuthServer creates a built-in OAuth 2.1 server.
func NewOAuthServer(cfg OAuthServerConfig) (*OAuthServer, error) {
	key := cfg.SigningKey
	if len(key) == 0 {
		if cfg.AdminSecret != "" {
			sum := sha256.Sum256([]byte("cloudcookie-mcp-oauth-jwt:" + cfg.AdminSecret))
			key = sum[:]
		} else {
			key = make([]byte, 32)
			if _, err := rand.Read(key); err != nil {
				return nil, err
			}
		}
	}

	clients := make(map[string]registeredClient)
	if cfg.ClientID != "" && cfg.ClientSecret != "" {
		clients[cfg.ClientID] = registeredClient{
			ClientID:     cfg.ClientID,
			ClientSecret: cfg.ClientSecret,
			ClientName:   "configured-client",
		}
	}

	return &OAuthServer{
		cfg:           cfg,
		signingKey:    key,
		clients:       clients,
		codes:         make(map[string]authCodeEntry),
		refreshTokens: make(map[string]refreshEntry),
	}, nil
}

// VerifyToken validates an access token issued by this OAuthServer.
func (o *OAuthServer) VerifyToken(token string) (*JWTClaims, error) {
	return VerifyHS256(token, o.signingKey, o.cfg.PublicURL, "", time.Now())
}

// RegisterRoutes mounts RFC 9728, RFC 8414, RFC 7591, /oauth/authorize, and /oauth/token.
func (o *OAuthServer) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/.well-known/oauth-protected-resource", o.handleProtectedResourceMetadata)
	mux.HandleFunc("/.well-known/oauth-authorization-server", o.handleAuthServerMetadata)
	mux.HandleFunc("/oauth/register", o.handleRegister)
	mux.HandleFunc("/oauth/authorize", o.handleAuthorize)
	mux.HandleFunc("/oauth/token", o.handleToken)
}

func (o *OAuthServer) baseURL(r *http.Request) string {
	if o.cfg.PublicURL != "" {
		return strings.TrimRight(o.cfg.PublicURL, "/")
	}
	scheme := "http"
	if r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
		scheme = "https"
	}
	return scheme + "://" + r.Host
}

func (o *OAuthServer) handleProtectedResourceMetadata(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	base := o.baseURL(r)
	writeJSON(w, http.StatusOK, map[string]any{
		"resource":                 base + o.cfg.MCPPath,
		"authorization_servers":    []string{base},
		"bearer_methods_supported": []string{"header"},
		"scopes_supported":         []string{"cookies:read"},
	})
}

func (o *OAuthServer) handleAuthServerMetadata(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	base := o.baseURL(r)
	grantTypes := []string{"authorization_code", "refresh_token"}
	if o.cfg.ClientID != "" && o.cfg.ClientSecret != "" {
		grantTypes = append(grantTypes, "client_credentials")
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"issuer":                                base,
		"authorization_endpoint":                base + "/oauth/authorize",
		"token_endpoint":                        base + "/oauth/token",
		"registration_endpoint":                 base + "/oauth/register",
		"response_types_supported":              []string{"code"},
		"grant_types_supported":                 grantTypes,
		"code_challenge_methods_supported":      []string{"S256"},
		"token_endpoint_auth_methods_supported": []string{"none", "client_secret_post", "client_secret_basic"},
		"scopes_supported":                      []string{"cookies:read"},
	})
}

func (o *OAuthServer) handleRegister(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		ClientName   string   `json:"client_name"`
		RedirectURIs []string `json:"redirect_uris"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024)).Decode(&req); err != nil {
		writeOAuthError(w, http.StatusBadRequest, "invalid_client_metadata", err.Error())
		return
	}
	if len(req.RedirectURIs) == 0 {
		writeOAuthError(w, http.StatusBadRequest, "invalid_redirect_uri", "redirect_uris is required")
		return
	}
	for _, u := range req.RedirectURIs {
		parsed, err := url.Parse(u)
		if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http" && parsed.Scheme != "") {
			writeOAuthError(w, http.StatusBadRequest, "invalid_redirect_uri", "invalid redirect_uri")
			return
		}
	}

	cid := randomHex(16)
	o.mu.Lock()
	o.clients[cid] = registeredClient{
		ClientID:     cid,
		ClientName:   req.ClientName,
		RedirectURIs: req.RedirectURIs,
	}
	o.mu.Unlock()

	writeJSON(w, http.StatusCreated, map[string]any{
		"client_id":                  cid,
		"client_name":                req.ClientName,
		"redirect_uris":              req.RedirectURIs,
		"token_endpoint_auth_method": "none",
	})
}

var authorizeHTML = template.Must(template.New("auth").Parse(`<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>CloudCookie MCP Authorization</title>
<style>body{font-family:system-ui,sans-serif;max-width:440px;margin:4rem auto;padding:1.5rem;border:1px solid #ddd;border-radius:8px}input{width:100%;padding:.6rem;margin:.5rem 0 1rem;box-sizing:border-box}button{padding:.6rem 1.2rem;cursor:pointer}</style>
</head>
<body>
<h2>Authorize CloudCookie MCP Access</h2>
<p>Client <strong>{{.ClientName}}</strong> (<code>{{.ClientID}}</code>) is requesting read-only access to your CloudCookie browser cookies (scope: <code>{{.Scope}}</code>).</p>
{{if .Error}}<p style="color:#b00">{{.Error}}</p>{{end}}
<form method="POST" action="/oauth/authorize">
<input type="hidden" name="client_id" value="{{.ClientID}}">
<input type="hidden" name="redirect_uri" value="{{.RedirectURI}}">
<input type="hidden" name="state" value="{{.State}}">
<input type="hidden" name="code_challenge" value="{{.CodeChallenge}}">
<input type="hidden" name="code_challenge_method" value="{{.CodeChallengeMethod}}">
<input type="hidden" name="scope" value="{{.Scope}}">
<label>Passphrase (OAuth Secret):</label>
<input type="password" name="secret" required autofocus>
<button type="submit">Approve Access</button>
</form>
</body>
</html>`))

func (o *OAuthServer) handleAuthorize(w http.ResponseWriter, r *http.Request) {
	if o.cfg.AdminSecret == "" {
		http.Error(w, "authorization_code flow disabled (no oauth secret configured)", http.StatusForbidden)
		return
	}

	var clientID, redirectURI, state, codeChallenge, method, scope, secret string
	if r.Method == http.MethodGet {
		q := r.URL.Query()
		if q.Get("response_type") != "code" {
			http.Error(w, "unsupported response_type", http.StatusBadRequest)
			return
		}
		clientID = q.Get("client_id")
		redirectURI = q.Get("redirect_uri")
		state = q.Get("state")
		codeChallenge = q.Get("code_challenge")
		method = q.Get("code_challenge_method")
		scope = q.Get("scope")
	} else if r.Method == http.MethodPost {
		if err := r.ParseForm(); err != nil {
			http.Error(w, "bad form", http.StatusBadRequest)
			return
		}
		clientID = r.FormValue("client_id")
		redirectURI = r.FormValue("redirect_uri")
		state = r.FormValue("state")
		codeChallenge = r.FormValue("code_challenge")
		method = r.FormValue("code_challenge_method")
		scope = r.FormValue("scope")
		secret = r.FormValue("secret")
	} else {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	o.mu.Lock()
	client, ok := o.clients[clientID]
	o.mu.Unlock()
	if !ok || !slices.Contains(client.RedirectURIs, redirectURI) {
		http.Error(w, "invalid client_id or redirect_uri", http.StatusBadRequest)
		return
	}
	if codeChallenge == "" || method != "S256" {
		http.Error(w, "PKCE S256 code_challenge required", http.StatusBadRequest)
		return
	}
	if scope == "" {
		scope = "cookies:read"
	}

	clientName := client.ClientName
	if clientName == "" {
		clientName = clientID
	}

	if r.Method == http.MethodGet {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_ = authorizeHTML.Execute(w, map[string]string{
			"ClientID":            clientID,
			"ClientName":          clientName,
			"RedirectURI":         redirectURI,
			"State":               state,
			"CodeChallenge":       codeChallenge,
			"CodeChallengeMethod": method,
			"Scope":               scope,
		})
		return
	}

	if subtle.ConstantTimeCompare([]byte(secret), []byte(o.cfg.AdminSecret)) != 1 {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusUnauthorized)
		_ = authorizeHTML.Execute(w, map[string]string{
			"ClientID":            clientID,
			"ClientName":          clientName,
			"RedirectURI":         redirectURI,
			"State":               state,
			"CodeChallenge":       codeChallenge,
			"CodeChallengeMethod": method,
			"Scope":               scope,
			"Error":               "Invalid passphrase.",
		})
		return
	}

	code := randomHex(24)
	o.mu.Lock()
	o.codes[code] = authCodeEntry{
		ClientID:            clientID,
		RedirectURI:         redirectURI,
		CodeChallenge:       codeChallenge,
		CodeChallengeMethod: method,
		Scope:               scope,
		ExpiresAt:           time.Now().Add(5 * time.Minute),
	}
	o.mu.Unlock()

	redir, _ := url.Parse(redirectURI)
	q := redir.Query()
	q.Set("code", code)
	if state != "" {
		q.Set("state", state)
	}
	redir.RawQuery = q.Encode()
	http.Redirect(w, r, redir.String(), http.StatusFound)
}

func (o *OAuthServer) handleToken(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if err := r.ParseForm(); err != nil {
		writeOAuthError(w, http.StatusBadRequest, "invalid_request", "invalid form body")
		return
	}

	grantType := r.FormValue("grant_type")
	switch grantType {
	case "authorization_code":
		o.handleAuthCodeGrant(w, r)
	case "refresh_token":
		o.handleRefreshGrant(w, r)
	case "client_credentials":
		o.handleClientCredentialsGrant(w, r)
	default:
		writeOAuthError(w, http.StatusBadRequest, "unsupported_grant_type", "unsupported grant_type")
	}
}

func (o *OAuthServer) handleAuthCodeGrant(w http.ResponseWriter, r *http.Request) {
	code := r.FormValue("code")
	redirectURI := r.FormValue("redirect_uri")
	verifier := r.FormValue("code_verifier")
	clientID := r.FormValue("client_id")
	if clientID == "" {
		if cid, _, ok := r.BasicAuth(); ok {
			clientID = cid
		}
	}

	o.mu.Lock()
	entry, ok := o.codes[code]
	if ok {
		delete(o.codes, code)
	}
	o.mu.Unlock()

	if !ok || time.Now().After(entry.ExpiresAt) {
		writeOAuthError(w, http.StatusBadRequest, "invalid_grant", "invalid or expired authorization code")
		return
	}
	if entry.ClientID != clientID || entry.RedirectURI != redirectURI {
		writeOAuthError(w, http.StatusBadRequest, "invalid_grant", "client_id or redirect_uri mismatch")
		return
	}

	sum := sha256.Sum256([]byte(verifier))
	computed := base64.RawURLEncoding.EncodeToString(sum[:])
	if subtle.ConstantTimeCompare([]byte(computed), []byte(entry.CodeChallenge)) != 1 {
		writeOAuthError(w, http.StatusBadRequest, "invalid_grant", "PKCE code_verifier mismatch")
		return
	}

	o.issueTokenPair(w, r, entry.ClientID, entry.Scope, true)
}

func (o *OAuthServer) handleRefreshGrant(w http.ResponseWriter, r *http.Request) {
	rt := r.FormValue("refresh_token")
	o.mu.Lock()
	entry, ok := o.refreshTokens[rt]
	if ok {
		delete(o.refreshTokens, rt)
	}
	o.mu.Unlock()

	if !ok || time.Now().After(entry.ExpiresAt) {
		writeOAuthError(w, http.StatusBadRequest, "invalid_grant", "invalid or expired refresh_token")
		return
	}
	o.issueTokenPair(w, r, entry.ClientID, entry.Scope, true)
}

func (o *OAuthServer) handleClientCredentialsGrant(w http.ResponseWriter, r *http.Request) {
	if o.cfg.ClientID == "" || o.cfg.ClientSecret == "" {
		writeOAuthError(w, http.StatusUnauthorized, "unauthorized_client", "client_credentials not configured")
		return
	}
	clientID, clientSecret, ok := r.BasicAuth()
	if !ok {
		clientID = r.FormValue("client_id")
		clientSecret = r.FormValue("client_secret")
	}
	if subtle.ConstantTimeCompare([]byte(clientID), []byte(o.cfg.ClientID)) != 1 ||
		subtle.ConstantTimeCompare([]byte(clientSecret), []byte(o.cfg.ClientSecret)) != 1 {
		writeOAuthError(w, http.StatusUnauthorized, "invalid_client", "invalid client credentials")
		return
	}
	scope := r.FormValue("scope")
	if scope == "" {
		scope = "cookies:read"
	}
	o.issueTokenPair(w, r, clientID, scope, false)
}

func (o *OAuthServer) issueTokenPair(w http.ResponseWriter, r *http.Request, clientID, scope string, withRefresh bool) {
	now := time.Now()
	const ttl = 3600
	iss := o.baseURL(r)
	token, err := SignHS256(o.signingKey, JWTClaims{
		Iss:      iss,
		Sub:      clientID,
		ClientID: clientID,
		Aud:      iss + o.cfg.MCPPath,
		Iat:      now.Unix(),
		Exp:      now.Add(ttl * time.Second).Unix(),
		Scope:    scope,
		Jti:      randomHex(12),
	})
	if err != nil {
		writeOAuthError(w, http.StatusInternalServerError, "server_error", "failed to sign token")
		return
	}

	resp := map[string]any{
		"access_token": token,
		"token_type":   "Bearer",
		"expires_in":   ttl,
		"scope":        scope,
	}
	if withRefresh {
		rt := randomHex(24)
		o.mu.Lock()
		o.refreshTokens[rt] = refreshEntry{
			ClientID:  clientID,
			Scope:     scope,
			ExpiresAt: now.Add(30 * 24 * time.Hour),
		}
		o.mu.Unlock()
		resp["refresh_token"] = rt
	}
	writeJSON(w, http.StatusOK, resp)
}

func randomHex(nBytes int) string {
	b := make([]byte, nBytes)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeOAuthError(w http.ResponseWriter, status int, code, desc string) {
	writeJSON(w, status, map[string]string{
		"error":             code,
		"error_description": desc,
	})
}
