package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/sagan/cloudcookie-mcp/internal/cloudcookie"
	"github.com/sagan/cloudcookie-mcp/internal/cookies"
)

type mockProvider struct {
	slots []cloudcookie.SlotSummary
	data  map[uint32]*cloudcookie.SlotDataPayload
}

func (m *mockProvider) ListSlots(_ context.Context, _ bool) ([]cloudcookie.SlotSummary, error) {
	return m.slots, nil
}

func (m *mockProvider) ResolveSlot(_ context.Context, requested *uint32, _ bool) (uint32, error) {
	if requested != nil && *requested > 0 {
		return *requested, nil
	}
	return 1, nil
}

func (m *mockProvider) GetSlotData(_ context.Context, slot uint32, _ bool) (*cloudcookie.SlotDataPayload, uint64, error) {
	p, ok := m.data[slot]
	if !ok {
		return nil, 0, &cloudcookie.ServerError{StatusCode: 404, Code: "no_data", Message: "slot not found"}
	}
	return p, 3, nil
}

func newTestServer() *Server {
	mp := &mockProvider{
		slots: []cloudcookie.SlotSummary{
			{Slot: 1, Name: "Work Chrome", UpdatedAt: 1795692095000, Version: 3},
		},
		data: map[uint32]*cloudcookie.SlotDataPayload{
			1: {
				SchemaVersion: 1,
				Slot:          1,
				InstanceName:  "Work Chrome",
				CookieCount:   2,
				DomainCount:   2,
				Cookies: map[string][]cloudcookie.SerializedCookie{
					"example.com": {
						{
							Name:     "sid",
							Value:    "xyz",
							Domain:   ".example.com",
							Path:     "/",
							Secure:   true,
							HTTPOnly: true,
							SameSite: "lax",
						},
					},
					"blocked.com": {
						{
							Name:   "secret",
							Value:  "no",
							Domain: "blocked.com",
							Path:   "/",
						},
					},
				},
			},
		},
	}
	policy := cookies.NewDomainPolicy(nil, []string{"blocked.com"})
	return NewServer(mp, policy, "0.1.0-test", nil)
}

func TestServeStdioLifecycleAndTools(t *testing.T) {
	srv := newTestServer()

	requests := []string{
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","clientInfo":{"name":"test","version":"1.0"}}}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`,
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_slots","arguments":{}}}`,
		`{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"list_domains","arguments":{}}}`,
		`{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"get_cookies","arguments":{"url":"https://app.example.com/home","format":"header"}}}`,
		`{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"get_cookies","arguments":{"domain":"blocked.com"}}}`,
		`{"jsonrpc":"2.0","id":7,"method":"resources/read","params":{"uri":"cloudcookie://domains"}}`,
	}

	input := strings.NewReader(strings.Join(requests, "\n") + "\n")
	var output bytes.Buffer

	if err := srv.ServeStdio(context.Background(), input, &output); err != nil {
		t.Fatalf("ServeStdio failed: %v", err)
	}

	lines := strings.Split(strings.TrimSpace(output.String()), "\n")
	// 7 requests with IDs (notification has no response)
	if len(lines) != 7 {
		t.Fatalf("expected 7 responses, got %d:\n%s", len(lines), output.String())
	}

	// Verify initialize
	var initResp struct {
		ID     int              `json:"id"`
		Result InitializeResult `json:"result"`
	}
	if err := json.Unmarshal([]byte(lines[0]), &initResp); err != nil {
		t.Fatalf("unmarshal init: %v", err)
	}
	if initResp.Result.ProtocolVersion != "2025-03-26" || initResp.Result.ServerInfo.Name != "cloudcookie-mcp" {
		t.Fatalf("unexpected init result: %+v", initResp.Result)
	}

	// Verify get_cookies for https://app.example.com/home
	var getResp struct {
		ID     int            `json:"id"`
		Result CallToolResult `json:"result"`
	}
	if err := json.Unmarshal([]byte(lines[4]), &getResp); err != nil {
		t.Fatalf("unmarshal get_cookies: %v", err)
	}
	if getResp.Result.IsError {
		t.Fatalf("unexpected tool error: %+v", getResp.Result)
	}
	if len(getResp.Result.Content) == 0 || !strings.Contains(getResp.Result.Content[0].Text, "sid=xyz") {
		t.Fatalf("expected sid=xyz in output, got: %+v", getResp.Result.Content)
	}

	// Verify blocked.com returns isError: true
	var blockedResp struct {
		ID     int            `json:"id"`
		Result CallToolResult `json:"result"`
	}
	if err := json.Unmarshal([]byte(lines[5]), &blockedResp); err != nil {
		t.Fatalf("unmarshal blocked: %v", err)
	}
	if !blockedResp.Result.IsError {
		t.Fatalf("expected isError=true for blocked domain")
	}

	// Verify resources/read
	var resResp struct {
		ID     int                `json:"id"`
		Result ReadResourceResult `json:"result"`
	}
	if err := json.Unmarshal([]byte(lines[6]), &resResp); err != nil {
		t.Fatalf("unmarshal resource: %v", err)
	}
	if len(resResp.Result.Contents) != 1 || !strings.Contains(resResp.Result.Contents[0].Text, "example.com") {
		t.Fatalf("unexpected resource output: %+v", resResp.Result)
	}
}
