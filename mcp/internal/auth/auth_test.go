package auth

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestBearerTokenMiddleware(t *testing.T) {
	a, err := NewAuthenticator(AuthConfig{
		BearerTokens: []string{"secret-tok-1", "secret-tok-2"},
	})
	if err != nil {
		t.Fatalf("NewAuthenticator: %v", err)
	}

	h := a.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))

	// Missing token -> 401
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/mcp", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}

	// Wrong token -> 401
	req := httptest.NewRequest(http.MethodPost, "/mcp", nil)
	req.Header.Set("Authorization", "Bearer wrong")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}

	// Valid token -> 200
	req = httptest.NewRequest(http.MethodPost, "/mcp", nil)
	req.Header.Set("Authorization", "Bearer secret-tok-2")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
}

func TestBuiltinOAuthPKCEAndClientCredentials(t *testing.T) {
	a, err := NewAuthenticator(AuthConfig{
		OAuthEnabled:      true,
		OAuthSecret:       "admin-passphrase",
		OAuthClientID:     "svc-client",
		OAuthClientSecret: "svc-secret",
		MCPPath:           "/mcp",
	})
	if err != nil {
		t.Fatalf("NewAuthenticator: %v", err)
	}

	mux := http.NewServeMux()
	a.RegisterRoutes(mux)
	mux.Handle("/mcp", a.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("authorized"))
	})))

	srv := httptest.NewServer(mux)
	defer srv.Close()

	// 1. Protected resource metadata
	resp, err := http.Get(srv.URL + "/.well-known/oauth-protected-resource")
	if err != nil {
		t.Fatalf("get protected resource metadata: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}

	// 2. Dynamic Client Registration
	regBody := strings.NewReader(`{"client_name":"test-agent","redirect_uris":["http://127.0.0.1:9999/cb"]}`)
	regResp, err := http.Post(srv.URL+"/oauth/register", "application/json", regBody)
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	var regData struct {
		ClientID string `json:"client_id"`
	}
	_ = json.NewDecoder(regResp.Body).Decode(&regData)
	regResp.Body.Close()
	if regResp.StatusCode != http.StatusCreated || regData.ClientID == "" {
		t.Fatalf("unexpected register response: status=%d client_id=%q", regResp.StatusCode, regData.ClientID)
	}

	// 3. PKCE authorize -> code -> token
	verifier := "test-pkce-verifier-string-1234567890"
	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])

	noRedirectClient := &http.Client{
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	authForm := url.Values{
		"client_id":             {regData.ClientID},
		"redirect_uri":          {"http://127.0.0.1:9999/cb"},
		"state":                 {"xyz"},
		"code_challenge":        {challenge},
		"code_challenge_method": {"S256"},
		"scope":                 {"cookies:read"},
		"secret":                {"admin-passphrase"},
	}
	authResp, err := noRedirectClient.PostForm(srv.URL+"/oauth/authorize", authForm)
	if err != nil {
		t.Fatalf("authorize post: %v", err)
	}
	authResp.Body.Close()
	if authResp.StatusCode != http.StatusFound {
		t.Fatalf("expected 302 redirect, got %d", authResp.StatusCode)
	}
	loc, _ := url.Parse(authResp.Header.Get("Location"))
	code := loc.Query().Get("code")
	if code == "" || loc.Query().Get("state") != "xyz" {
		t.Fatalf("missing code/state in redirect: %s", loc.String())
	}

	tokResp, err := http.PostForm(srv.URL+"/oauth/token", url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {"http://127.0.0.1:9999/cb"},
		"client_id":     {regData.ClientID},
		"code_verifier": {verifier},
	})
	if err != nil {
		t.Fatalf("token post: %v", err)
	}
	var tokData struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
	}
	_ = json.NewDecoder(tokResp.Body).Decode(&tokData)
	tokResp.Body.Close()
	if tokResp.StatusCode != http.StatusOK || tokData.AccessToken == "" || tokData.RefreshToken == "" {
		t.Fatalf("unexpected token response: %d %+v", tokResp.StatusCode, tokData)
	}

	// 4. Access protected /mcp with OAuth access token
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/mcp", nil)
	req.Header.Set("Authorization", "Bearer "+tokData.AccessToken)
	mcpResp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("mcp request: %v", err)
	}
	mcpResp.Body.Close()
	if mcpResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 with OAuth token, got %d", mcpResp.StatusCode)
	}

	// 5. client_credentials grant
	ccResp, err := http.PostForm(srv.URL+"/oauth/token", url.Values{
		"grant_type":    {"client_credentials"},
		"client_id":     {"svc-client"},
		"client_secret": {"svc-secret"},
	})
	if err != nil {
		t.Fatalf("client_credentials: %v", err)
	}
	var ccData struct {
		AccessToken string `json:"access_token"`
	}
	_ = json.NewDecoder(ccResp.Body).Decode(&ccData)
	ccResp.Body.Close()
	if ccResp.StatusCode != http.StatusOK || ccData.AccessToken == "" {
		t.Fatalf("unexpected client_credentials response: %d", ccResp.StatusCode)
	}
}

func TestExternalJWKSRS256(t *testing.T) {
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("rsa.GenerateKey: %v", err)
	}

	const kid = "key-1"
	jwksSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		eBytes := big.NewInt(int64(priv.PublicKey.E)).Bytes()
		_ = json.NewEncoder(w).Encode(map[string]any{
			"keys": []map[string]any{
				{
					"kty": "RSA",
					"kid": kid,
					"use": "sig",
					"alg": "RS256",
					"n":   base64.RawURLEncoding.EncodeToString(priv.PublicKey.N.Bytes()),
					"e":   base64.RawURLEncoding.EncodeToString(eBytes),
				},
			},
		})
	}))
	defer jwksSrv.Close()

	signRS256 := func(claims JWTClaims) string {
		hdrB, _ := json.Marshal(jwtHeader{Alg: "RS256", Typ: "JWT", Kid: kid})
		clmB, _ := json.Marshal(claims)
		input := base64.RawURLEncoding.EncodeToString(hdrB) + "." + base64.RawURLEncoding.EncodeToString(clmB)
		sum := sha256.Sum256([]byte(input))
		sig, err := rsa.SignPKCS1v15(rand.Reader, priv, crypto.SHA256, sum[:])
		if err != nil {
			t.Fatalf("SignPKCS1v15: %v", err)
		}
		return input + "." + base64.RawURLEncoding.EncodeToString(sig)
	}

	verifier := NewJWKSVerifier(jwksSrv.URL, "https://idp.example.com", "https://mcp.example.com", "cookies:read", nil)

	validTok := signRS256(JWTClaims{
		Iss:   "https://idp.example.com",
		Sub:   "agent-1",
		Aud:   "https://mcp.example.com",
		Exp:   time.Now().Add(time.Hour).Unix(),
		Scope: "openid cookies:read",
	})
	if _, err := verifier.Verify(t.Context(), validTok); err != nil {
		t.Fatalf("expected valid RS256 token to verify: %v", err)
	}

	wrongAudTok := signRS256(JWTClaims{
		Iss:   "https://idp.example.com",
		Aud:   "https://other.example.com",
		Exp:   time.Now().Add(time.Hour).Unix(),
		Scope: "cookies:read",
	})
	if _, err := verifier.Verify(t.Context(), wrongAudTok); err == nil {
		t.Fatalf("expected audience mismatch error")
	}
}
