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
	slots     []cloudcookie.SlotSummary
	data      map[uint32]*cloudcookie.SlotDataPayload
	bookmarks *cloudcookie.BookmarkSlotPayload
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

func (m *mockProvider) GetBookmarks(_ context.Context, _ bool) (*cloudcookie.BookmarkSlotPayload, uint64, error) {
	if m.bookmarks == nil {
		return nil, 0, cloudcookie.ErrNoBookmarksSlot
	}
	return m.bookmarks, 2, nil
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
				UpdatedAt:     1795692095000,
				CookieCount:   2,
				DomainCount:   2,
				Meta: &cloudcookie.BrowserMeta{
					UserAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/131.0.0.0 Safari/537.36",
					Platform:  "MacIntel",
					Language:  "en-US",
					Languages: []string{"en-US", "en"},
					Timezone:  "America/Los_Angeles",
				},
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
		bookmarks: &cloudcookie.BookmarkSlotPayload{
			SchemaVersion: 1,
			Slot:          99,
			UpdatedAt:     1795692095000,
			BookmarkCount: 2,
			FolderCount:   2,
			Roots: []cloudcookie.BookmarkNode{
				{
					Title: "Bookmarks bar",
					Children: []cloudcookie.BookmarkNode{
						{Title: "GitHub", URL: "https://github.com"},
						{Title: "Example", URL: "https://example.com"},
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
		`{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"get_bookmarks","arguments":{"query":"github","format":"markdown"}}}`,
		`{"jsonrpc":"2.0","id":9,"method":"resources/read","params":{"uri":"cloudcookie://bookmarks"}}`,
		`{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"get_slot_meta","arguments":{}}}`,
		`{"jsonrpc":"2.0","id":11,"method":"resources/read","params":{"uri":"cloudcookie://meta"}}`,
	}

	input := strings.NewReader(strings.Join(requests, "\n") + "\n")
	var output bytes.Buffer

	if err := srv.ServeStdio(context.Background(), input, &output); err != nil {
		t.Fatalf("ServeStdio failed: %v", err)
	}

	lines := strings.Split(strings.TrimSpace(output.String()), "\n")
	// 11 requests with IDs (notification has no response)
	if len(lines) != 11 {
		t.Fatalf("expected 11 responses, got %d:\n%s", len(lines), output.String())
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
	if !strings.Contains(getResp.Result.Content[0].Text, "Chrome/131.0.0.0") {
		t.Fatalf("expected browser meta user_agent in get_cookies output, got: %+v", getResp.Result.Content[0].Text)
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

	// Verify get_bookmarks
	var bmResp struct {
		ID     int            `json:"id"`
		Result CallToolResult `json:"result"`
	}
	if err := json.Unmarshal([]byte(lines[7]), &bmResp); err != nil {
		t.Fatalf("unmarshal get_bookmarks: %v", err)
	}
	if bmResp.Result.IsError {
		t.Fatalf("unexpected get_bookmarks error: %+v", bmResp.Result)
	}
	if len(bmResp.Result.Content) == 0 || !strings.Contains(bmResp.Result.Content[0].Text, "https://github.com") {
		t.Fatalf("expected github bookmark in output, got: %+v", bmResp.Result.Content)
	}

	// Verify cloudcookie://bookmarks resource
	var bmResResp struct {
		ID     int                `json:"id"`
		Result ReadResourceResult `json:"result"`
	}
	if err := json.Unmarshal([]byte(lines[8]), &bmResResp); err != nil {
		t.Fatalf("unmarshal bookmarks resource: %v", err)
	}
	if len(bmResResp.Result.Contents) != 1 || !strings.Contains(bmResResp.Result.Contents[0].Text, "https://example.com") {
		t.Fatalf("unexpected bookmarks resource output: %+v", bmResResp.Result)
	}

	// Verify get_slot_meta
	var metaResp struct {
		ID     int            `json:"id"`
		Result CallToolResult `json:"result"`
	}
	if err := json.Unmarshal([]byte(lines[9]), &metaResp); err != nil {
		t.Fatalf("unmarshal get_slot_meta: %v", err)
	}
	if metaResp.Result.IsError {
		t.Fatalf("unexpected get_slot_meta error: %+v", metaResp.Result)
	}
	if len(metaResp.Result.Content) == 0 || !strings.Contains(metaResp.Result.Content[0].Text, "America/Los_Angeles") {
		t.Fatalf("expected timezone in get_slot_meta output, got: %+v", metaResp.Result.Content)
	}

	// Verify cloudcookie://meta resource
	var metaResResp struct {
		ID     int                `json:"id"`
		Result ReadResourceResult `json:"result"`
	}
	if err := json.Unmarshal([]byte(lines[10]), &metaResResp); err != nil {
		t.Fatalf("unmarshal meta resource: %v", err)
	}
	if len(metaResResp.Result.Contents) != 1 || !strings.Contains(metaResResp.Result.Contents[0].Text, "MacIntel") {
		t.Fatalf("unexpected meta resource output: %+v", metaResResp.Result)
	}
}
