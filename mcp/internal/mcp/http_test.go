package mcp

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/sagan/cloudcookie-mcp/internal/auth"
)

func TestHTTPTransportWithBearerAndOAuthChallenge(t *testing.T) {
	srv := newTestServer()

	// 1. Protected by OAuth + static bearer token
	authenticator, err := auth.NewAuthenticator(auth.AuthConfig{
		BearerTokens: []string{"test-bearer"},
		OAuthEnabled: true,
		OAuthSecret:  "secret",
		PublicURL:    "https://mcp.example.com",
		MCPPath:      "/mcp",
	})
	if err != nil {
		t.Fatalf("NewAuthenticator: %v", err)
	}

	mux := http.NewServeMux()
	authenticator.RegisterRoutes(mux)
	mux.Handle("/mcp", authenticator.Middleware(NewHTTPHandler(srv)))
	ts := httptest.NewServer(mux)
	defer ts.Close()

	// Unauthenticated POST /mcp -> 401 with WWW-Authenticate resource_metadata
	resp, err := http.Post(ts.URL+"/mcp", "application/json", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"ping"}`))
	if err != nil {
		t.Fatalf("post unauth: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", resp.StatusCode)
	}
	wwwAuth := resp.Header.Get("WWW-Authenticate")
	if !strings.Contains(wwwAuth, "resource_metadata=") {
		t.Fatalf("expected resource_metadata in WWW-Authenticate, got %q", wwwAuth)
	}

	// Authenticated initialize -> 200 + Mcp-Session-Id
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer test-bearer")
	initResp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("initialize: %v", err)
	}
	initResp.Body.Close()
	if initResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", initResp.StatusCode)
	}
	sessionID := initResp.Header.Get("Mcp-Session-Id")
	if sessionID == "" {
		t.Fatalf("expected Mcp-Session-Id header")
	}

	// Notification -> 202 Accepted
	notifReq, _ := http.NewRequest(http.MethodPost, ts.URL+"/mcp", strings.NewReader(`{"jsonrpc":"2.0","method":"notifications/initialized"}`))
	notifReq.Header.Set("Content-Type", "application/json")
	notifReq.Header.Set("Authorization", "Bearer test-bearer")
	notifReq.Header.Set("Mcp-Session-Id", sessionID)
	notifResp, err := http.DefaultClient.Do(notifReq)
	if err != nil {
		t.Fatalf("notification: %v", err)
	}
	notifResp.Body.Close()
	if notifResp.StatusCode != http.StatusAccepted {
		t.Fatalf("expected 202, got %d", notifResp.StatusCode)
	}

	// tools/call get_cookies -> 200 with sid=xyz
	callReq, _ := http.NewRequest(http.MethodPost, ts.URL+"/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_cookies","arguments":{"url":"https://app.example.com/"}}}`))
	callReq.Header.Set("Content-Type", "application/json")
	callReq.Header.Set("Authorization", "Bearer test-bearer")
	callReq.Header.Set("Mcp-Session-Id", sessionID)
	callResp, err := http.DefaultClient.Do(callReq)
	if err != nil {
		t.Fatalf("tools/call: %v", err)
	}
	var rpcResp struct {
		Result CallToolResult `json:"result"`
	}
	_ = json.NewDecoder(callResp.Body).Decode(&rpcResp)
	callResp.Body.Close()
	if callResp.StatusCode != http.StatusOK || rpcResp.Result.IsError {
		t.Fatalf("unexpected tools/call response: status=%d result=%+v", callResp.StatusCode, rpcResp.Result)
	}
	if len(rpcResp.Result.Content) == 0 || !strings.Contains(rpcResp.Result.Content[0].Text, "sid=xyz") {
		t.Fatalf("expected sid=xyz in response, got %+v", rpcResp.Result.Content)
	}

	// DELETE /mcp -> 204 No Content
	delReq, _ := http.NewRequest(http.MethodDelete, ts.URL+"/mcp", nil)
	delReq.Header.Set("Authorization", "Bearer test-bearer")
	delReq.Header.Set("Mcp-Session-Id", sessionID)
	delResp, err := http.DefaultClient.Do(delReq)
	if err != nil {
		t.Fatalf("delete session: %v", err)
	}
	delResp.Body.Close()
	if delResp.StatusCode != http.StatusNoContent {
		t.Fatalf("expected 204, got %d", delResp.StatusCode)
	}
}
