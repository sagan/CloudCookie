package mcp

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"strings"

	"github.com/sagan/cloudcookie-mcp/internal/bookmarks"
	"github.com/sagan/cloudcookie-mcp/internal/cloudcookie"
	"github.com/sagan/cloudcookie-mcp/internal/cookies"
)

const serverInstructions = `CloudCookie MCP Server provides on-demand read-only access to the user's end-to-end encrypted browser cookies and bookmarks stored in CloudCookie.
Typical workflow:
1. Call get_cookies with either "url" (recommended for RFC 6265 domain/path/secure matching) or "domain".
2. Use format="header" (default) for curl (-H "Cookie: ...") or Firecrawl (headers.Cookie), format="playwright" for Playwright/CDP, or format="netscape" for curl -b. If the slot includes browser meta info (e.g. meta.user_agent), pass it as the User-Agent header when websites bind cookies to the browser User-Agent.
3. Optionally call list_domains to discover which websites have saved cookies, list_slots if the user has multiple browser profiles, or get_slot_meta to inspect the browser User-Agent and environment metadata of a slot.
4. Call get_bookmarks to search or retrieve the user's synced browser bookmarks.`

// CookieProvider abstracts the CloudCookie client for testability.
type CookieProvider interface {
	ListSlots(ctx context.Context, refresh bool) ([]cloudcookie.SlotSummary, error)
	ResolveSlot(ctx context.Context, requestedSlot *uint32, refresh bool) (uint32, error)
	GetSlotData(ctx context.Context, slot uint32, refresh bool) (*cloudcookie.SlotDataPayload, uint64, error)
	GetBookmarks(ctx context.Context, refresh bool) (*cloudcookie.BookmarkSlotPayload, uint64, error)
}

// Server implements the CloudCookie MCP server over stdio.
type Server struct {
	provider CookieProvider
	policy   cookies.DomainPolicy
	version  string
	logger   *log.Logger
}

// NewServer creates a new MCP Server.
func NewServer(provider CookieProvider, policy cookies.DomainPolicy, version string, logger *log.Logger) *Server {
	if logger == nil {
		logger = log.New(io.Discard, "", 0)
	}
	if version == "" {
		version = "0.1.0"
	}
	return &Server{
		provider: provider,
		policy:   policy,
		version:  version,
		logger:   logger,
	}
}

// ServeStdio reads newline-delimited JSON-RPC 2.0 messages from r and writes responses to w.
func (s *Server) ServeStdio(ctx context.Context, r io.Reader, w io.Writer) error {
	scanner := bufio.NewScanner(r)
	// Allow up to 16 MiB per JSON-RPC message line.
	scanner.Buffer(make([]byte, 64*1024), 16*1024*1024)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)

	for scanner.Scan() {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}

		var req JSONRPCRequest
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			resp := JSONRPCResponse{
				JSONRPC: JSONRPCVersion,
				ID:      json.RawMessage("null"),
				Error:   &JSONRPCError{Code: ErrCodeParseError, Message: "parse error: " + err.Error()},
			}
			if err := enc.Encode(resp); err != nil {
				return err
			}
			continue
		}

		// Notifications have no ID; do not send a response.
		if len(req.ID) == 0 {
			s.handleNotification(req.Method)
			continue
		}

		resp := s.HandleRequest(ctx, req)
		if err := enc.Encode(resp); err != nil {
			return err
		}
	}

	if err := scanner.Err(); err != nil {
		return fmt.Errorf("read stdin: %w", err)
	}
	return nil
}

func (s *Server) handleNotification(method string) {
	switch method {
	case "notifications/initialized", "notifications/cancelled":
		// Expected MCP client notifications; nothing to reply.
	default:
		s.logger.Printf("ignoring notification %q", method)
	}
}

// HandleRequest processes a single JSON-RPC 2.0 request and returns a response.
func (s *Server) HandleRequest(ctx context.Context, req JSONRPCRequest) JSONRPCResponse {
	if req.JSONRPC != JSONRPCVersion {
		return errorResp(req.ID, ErrCodeInvalidRequest, "jsonrpc must be '2.0'")
	}

	switch req.Method {
	case "initialize":
		return s.handleInitialize(req)
	case "ping":
		return okResp(req.ID, map[string]any{})
	case "tools/list":
		return okResp(req.ID, ListToolsResult{Tools: toolDefinitions()})
	case "tools/call":
		return s.handleToolsCall(ctx, req)
	case "resources/list":
		return okResp(req.ID, ListResourcesResult{Resources: resourceDefinitions()})
	case "resources/read":
		return s.handleResourcesRead(ctx, req)
	default:
		return errorResp(req.ID, ErrCodeMethodNotFound, fmt.Sprintf("method %q not found", req.Method))
	}
}

func (s *Server) handleInitialize(req JSONRPCRequest) JSONRPCResponse {
	var params InitializeParams
	if len(req.Params) > 0 {
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return errorResp(req.ID, ErrCodeInvalidParams, "invalid initialize params: "+err.Error())
		}
	}

	proto := DefaultProtocolVersion
	if params.ProtocolVersion == LatestProtocolVersion || params.ProtocolVersion == DefaultProtocolVersion {
		proto = params.ProtocolVersion
	}

	return okResp(req.ID, InitializeResult{
		ProtocolVersion: proto,
		Capabilities: ServerCapabilities{
			Tools:     &ToolsCapability{ListChanged: false},
			Resources: &ResourcesCapability{Subscribe: false, ListChanged: false},
		},
		ServerInfo: EntityInfo{
			Name:    "cloudcookie-mcp",
			Version: s.version,
		},
		Instructions: serverInstructions,
	})
}

func (s *Server) handleToolsCall(ctx context.Context, req JSONRPCRequest) JSONRPCResponse {
	var params CallToolParams
	if err := json.Unmarshal(req.Params, &params); err != nil {
		return errorResp(req.ID, ErrCodeInvalidParams, "invalid tools/call params: "+err.Error())
	}

	switch params.Name {
	case "list_slots":
		return okResp(req.ID, s.callListSlots(ctx, params.Arguments))
	case "list_domains":
		return okResp(req.ID, s.callListDomains(ctx, params.Arguments))
	case "get_cookies":
		return okResp(req.ID, s.callGetCookies(ctx, params.Arguments))
	case "get_slot_meta":
		return okResp(req.ID, s.callGetSlotMeta(ctx, params.Arguments))
	case "get_bookmarks":
		return okResp(req.ID, s.callGetBookmarks(ctx, params.Arguments))
	default:
		return errorResp(req.ID, ErrCodeInvalidParams, fmt.Sprintf("unknown tool %q", params.Name))
	}
}

type listSlotsArgs struct {
	Refresh bool `json:"refresh"`
}

func (s *Server) callListSlots(ctx context.Context, rawArgs json.RawMessage) CallToolResult {
	var args listSlotsArgs
	if len(rawArgs) > 0 {
		if err := json.Unmarshal(rawArgs, &args); err != nil {
			return toolError("invalid arguments: " + err.Error())
		}
	}

	slots, err := s.provider.ListSlots(ctx, args.Refresh)
	if err != nil {
		return toolError("failed to list slots: " + err.Error())
	}
	if slots == nil {
		slots = []cloudcookie.SlotSummary{}
	}

	payload := map[string]any{
		"slot_count": len(slots),
		"slots":      slots,
	}
	return toolJSON(payload)
}

type listDomainsArgs struct {
	Slot    *uint32 `json:"slot"`
	Query   string  `json:"query"`
	Refresh bool    `json:"refresh"`
}

func (s *Server) callListDomains(ctx context.Context, rawArgs json.RawMessage) CallToolResult {
	var args listDomainsArgs
	if len(rawArgs) > 0 {
		if err := json.Unmarshal(rawArgs, &args); err != nil {
			return toolError("invalid arguments: " + err.Error())
		}
	}

	slotID, err := s.provider.ResolveSlot(ctx, args.Slot, args.Refresh)
	if err != nil {
		return toolError(err.Error())
	}

	data, version, err := s.provider.GetSlotData(ctx, slotID, args.Refresh)
	if err != nil {
		return toolError(fmt.Sprintf("failed to fetch slot %d: %v", slotID, err))
	}

	domains := cookies.ListDomains(data, s.policy, args.Query)
	if domains == nil {
		domains = []cookies.DomainCount{}
	}

	payload := map[string]any{
		"slot":          slotID,
		"instance_name": data.InstanceName,
		"version":       version,
		"domain_count":  len(domains),
		"domains":       domains,
	}
	if data.Meta != nil {
		payload["meta"] = data.Meta
	}
	return toolJSON(payload)
}

type getCookiesArgs struct {
	URL               string   `json:"url"`
	Domain            string   `json:"domain"`
	Format            string   `json:"format"`
	Slot              *uint32  `json:"slot"`
	IncludeSubdomains *bool    `json:"include_subdomains"`
	IncludeExpired    bool     `json:"include_expired"`
	Names             []string `json:"names"`
	Refresh           bool     `json:"refresh"`
}

func (s *Server) callGetCookies(ctx context.Context, rawArgs json.RawMessage) CallToolResult {
	var args getCookiesArgs
	if len(rawArgs) > 0 {
		if err := json.Unmarshal(rawArgs, &args); err != nil {
			return toolError("invalid arguments: " + err.Error())
		}
	}

	format := strings.ToLower(strings.TrimSpace(args.Format))
	if format == "" {
		format = "header"
	}
	switch format {
	case "header", "json", "playwright", "netscape", "all":
	default:
		return toolError(fmt.Sprintf("unsupported format %q; must be one of: header, json, playwright, netscape, all", args.Format))
	}

	includeSubdomains := true
	if args.IncludeSubdomains != nil {
		includeSubdomains = *args.IncludeSubdomains
	}

	slotID, err := s.provider.ResolveSlot(ctx, args.Slot, args.Refresh)
	if err != nil {
		return toolError(err.Error())
	}

	data, version, err := s.provider.GetSlotData(ctx, slotID, args.Refresh)
	if err != nil {
		return toolError(fmt.Sprintf("failed to fetch slot %d: %v", slotID, err))
	}

	matched, err := cookies.MatchCookies(data, s.policy, cookies.MatchOptions{
		URL:               args.URL,
		Domain:            args.Domain,
		IncludeSubdomains: includeSubdomains,
		IncludeExpired:    args.IncludeExpired,
		Names:             args.Names,
	})
	if err != nil {
		return toolError(err.Error())
	}

	out := map[string]any{
		"slot":          slotID,
		"instance_name": data.InstanceName,
		"version":       version,
		"target":        matched.Target,
		"format":        format,
		"matched_count": len(matched.Cookies),
	}
	if data.Meta != nil {
		out["meta"] = data.Meta
	}

	switch format {
	case "header":
		out["cookie_header"] = cookies.FormatHeader(matched.Cookies)
	case "json":
		out["cookies"] = matched.Cookies
	case "playwright":
		out["cookies"] = cookies.FormatPlaywright(matched.Cookies)
	case "netscape":
		out["netscape"] = cookies.FormatNetscape(matched.Cookies)
	case "all":
		out["cookie_header"] = cookies.FormatHeader(matched.Cookies)
		out["playwright"] = cookies.FormatPlaywright(matched.Cookies)
		out["netscape"] = cookies.FormatNetscape(matched.Cookies)
		out["cookies"] = matched.Cookies
	}

	return toolJSON(out)
}

type getSlotMetaArgs struct {
	Slot    *uint32 `json:"slot"`
	Refresh bool    `json:"refresh"`
}

func (s *Server) callGetSlotMeta(ctx context.Context, rawArgs json.RawMessage) CallToolResult {
	var args getSlotMetaArgs
	if len(rawArgs) > 0 {
		if err := json.Unmarshal(rawArgs, &args); err != nil {
			return toolError("invalid arguments: " + err.Error())
		}
	}

	slotID, err := s.provider.ResolveSlot(ctx, args.Slot, args.Refresh)
	if err != nil {
		return toolError(err.Error())
	}

	data, version, err := s.provider.GetSlotData(ctx, slotID, args.Refresh)
	if err != nil {
		return toolError(fmt.Sprintf("failed to fetch slot %d: %v", slotID, err))
	}

	return toolJSON(map[string]any{
		"slot":          slotID,
		"instance_name": data.InstanceName,
		"version":       version,
		"updated_at":    data.UpdatedAt,
		"meta":          data.Meta,
	})
}

type getBookmarksArgs struct {
	Query   string `json:"query"`
	Folder  string `json:"folder"`
	Format  string `json:"format"`
	Limit   int    `json:"limit"`
	Refresh bool   `json:"refresh"`
}

func (s *Server) callGetBookmarks(ctx context.Context, rawArgs json.RawMessage) CallToolResult {
	var args getBookmarksArgs
	if len(rawArgs) > 0 {
		if err := json.Unmarshal(rawArgs, &args); err != nil {
			return toolError("invalid arguments: " + err.Error())
		}
	}

	format := strings.ToLower(strings.TrimSpace(args.Format))
	if format == "" {
		format = "json"
	}
	switch format {
	case "json", "tree", "markdown":
	default:
		return toolError(fmt.Sprintf("unsupported format %q; must be one of: json, tree, markdown", args.Format))
	}

	data, version, err := s.provider.GetBookmarks(ctx, args.Refresh)
	if err != nil {
		return toolError(fmt.Sprintf("failed to fetch bookmarks: %v", err))
	}

	out := map[string]any{
		"slot":           data.Slot,
		"version":        version,
		"updated_at":     data.UpdatedAt,
		"bookmark_count": data.BookmarkCount,
		"folder_count":   data.FolderCount,
		"format":         format,
	}

	if format == "tree" {
		out["roots"] = data.Roots
		return toolJSON(out)
	}

	matched, total := bookmarks.FilterBookmarks(data, bookmarks.FilterOptions{
		Query:  args.Query,
		Folder: args.Folder,
		Limit:  args.Limit,
	})
	if matched == nil {
		matched = []bookmarks.FlatBookmark{}
	}
	out["matched_count"] = total
	out["returned_count"] = len(matched)

	if format == "markdown" {
		out["markdown"] = bookmarks.FormatMarkdown(matched)
	} else {
		out["bookmarks"] = matched
	}

	return toolJSON(out)
}

func (s *Server) handleResourcesRead(ctx context.Context, req JSONRPCRequest) JSONRPCResponse {
	var params ReadResourceParams
	if err := json.Unmarshal(req.Params, &params); err != nil {
		return errorResp(req.ID, ErrCodeInvalidParams, "invalid resources/read params: "+err.Error())
	}

	switch params.URI {
	case "cloudcookie://slots":
		slots, err := s.provider.ListSlots(ctx, false)
		if err != nil {
			return errorResp(req.ID, ErrCodeInternalError, err.Error())
		}
		if slots == nil {
			slots = []cloudcookie.SlotSummary{}
		}
		b, _ := json.MarshalIndent(map[string]any{"slots": slots}, "", "  ")
		return okResp(req.ID, ReadResourceResult{
			Contents: []ResourceContent{{
				URI:      params.URI,
				MimeType: "application/json",
				Text:     string(b),
			}},
		})

	case "cloudcookie://domains":
		slotID, err := s.provider.ResolveSlot(ctx, nil, false)
		if err != nil {
			return errorResp(req.ID, ErrCodeInternalError, err.Error())
		}
		data, _, err := s.provider.GetSlotData(ctx, slotID, false)
		if err != nil {
			return errorResp(req.ID, ErrCodeInternalError, err.Error())
		}
		domains := cookies.ListDomains(data, s.policy, "")
		if domains == nil {
			domains = []cookies.DomainCount{}
		}
		resPayload := map[string]any{
			"slot":          slotID,
			"instance_name": data.InstanceName,
			"domains":       domains,
		}
		if data.Meta != nil {
			resPayload["meta"] = data.Meta
		}
		b, _ := json.MarshalIndent(resPayload, "", "  ")
		return okResp(req.ID, ReadResourceResult{
			Contents: []ResourceContent{{
				URI:      params.URI,
				MimeType: "application/json",
				Text:     string(b),
			}},
		})

	case "cloudcookie://meta":
		slotID, err := s.provider.ResolveSlot(ctx, nil, false)
		if err != nil {
			return errorResp(req.ID, ErrCodeInternalError, err.Error())
		}
		data, version, err := s.provider.GetSlotData(ctx, slotID, false)
		if err != nil {
			return errorResp(req.ID, ErrCodeInternalError, err.Error())
		}
		b, _ := json.MarshalIndent(map[string]any{
			"slot":          slotID,
			"instance_name": data.InstanceName,
			"version":       version,
			"updated_at":    data.UpdatedAt,
			"meta":          data.Meta,
		}, "", "  ")
		return okResp(req.ID, ReadResourceResult{
			Contents: []ResourceContent{{
				URI:      params.URI,
				MimeType: "application/json",
				Text:     string(b),
			}},
		})

	case "cloudcookie://bookmarks":
		data, version, err := s.provider.GetBookmarks(ctx, false)
		if err != nil {
			return errorResp(req.ID, ErrCodeInternalError, err.Error())
		}
		b, _ := json.MarshalIndent(map[string]any{
			"slot":           data.Slot,
			"version":        version,
			"updated_at":     data.UpdatedAt,
			"bookmark_count": data.BookmarkCount,
			"folder_count":   data.FolderCount,
			"roots":          data.Roots,
		}, "", "  ")
		return okResp(req.ID, ReadResourceResult{
			Contents: []ResourceContent{{
				URI:      params.URI,
				MimeType: "application/json",
				Text:     string(b),
			}},
		})

	default:
		return errorResp(req.ID, ErrCodeInvalidParams, fmt.Sprintf("unknown resource URI %q", params.URI))
	}
}

func toolDefinitions() []ToolDefinition {
	return []ToolDefinition{
		{
			Name:        "list_slots",
			Description: "List available browser cookie slots in CloudCookie (slot ID, browser instance name, and timestamps).",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"refresh": map[string]any{
						"type":        "boolean",
						"description": "Bypass local cache and fetch fresh metadata from the CloudCookie server.",
					},
				},
				"additionalProperties": false,
			},
		},
		{
			Name:        "list_domains",
			Description: "List domains that have stored cookies in a CloudCookie slot, with cookie counts per domain.",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"slot": map[string]any{
						"type":        "integer",
						"minimum":     1,
						"description": "Optional slot ID (>= 1). Uses the configured default or most recently updated slot if omitted.",
					},
					"query": map[string]any{
						"type":        "string",
						"description": "Optional case-insensitive substring filter for domain names (e.g. 'github').",
					},
					"refresh": map[string]any{
						"type":        "boolean",
						"description": "Bypass local cache and fetch fresh data from the CloudCookie server.",
					},
				},
				"additionalProperties": false,
			},
		},
		{
			Name:        "get_cookies",
			Description: "Retrieve decrypted cookies for a website URL or domain from CloudCookie, formatted for curl, Firecrawl, Playwright/CDP, Netscape cookies.txt, or raw JSON.",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"url": map[string]any{
						"type":        "string",
						"description": "Target HTTP/HTTPS URL (e.g. 'https://github.com/settings'). Applies RFC 6265 domain, path, secure, and expiration matching. Either url or domain is required.",
					},
					"domain": map[string]any{
						"type":        "string",
						"description": "Target domain (e.g. 'github.com'). Either url or domain is required.",
					},
					"format": map[string]any{
						"type":        "string",
						"enum":        []string{"header", "json", "playwright", "netscape", "all"},
						"default":     "header",
						"description": "Output format: 'header' (HTTP Cookie header for curl/Firecrawl), 'playwright' (Playwright/CDP cookie objects), 'netscape' (cookies.txt for curl -b), 'json' (raw CloudCookie SerializedCookie[]), or 'all'.",
					},
					"slot": map[string]any{
						"type":        "integer",
						"minimum":     1,
						"description": "Optional slot ID (>= 1). Uses the configured default or most recently updated slot if omitted.",
					},
					"include_subdomains": map[string]any{
						"type":        "boolean",
						"default":     true,
						"description": "When querying by domain, include cookies for subdomains as well (ignored when url is provided).",
					},
					"include_expired": map[string]any{
						"type":        "boolean",
						"default":     false,
						"description": "Include expired cookies.",
					},
					"names": map[string]any{
						"type":        "array",
						"items":       map[string]any{"type": "string"},
						"description": "Optional list of exact cookie names to include.",
					},
					"refresh": map[string]any{
						"type":        "boolean",
						"default":     false,
						"description": "Bypass local cache and fetch fresh data from the CloudCookie server.",
					},
				},
				"additionalProperties": false,
			},
		},
		{
			Name:        "get_slot_meta",
			Description: "Retrieve browser metadata (User-Agent, User-Agent Client Hints, platform, language, timezone, extension version) uploaded with a CloudCookie slot.",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"slot": map[string]any{
						"type":        "integer",
						"minimum":     1,
						"description": "Optional slot ID (>= 1). Uses the configured default or most recently updated slot if omitted.",
					},
					"refresh": map[string]any{
						"type":        "boolean",
						"default":     false,
						"description": "Bypass local cache and fetch fresh data from the CloudCookie server.",
					},
				},
				"additionalProperties": false,
			},
		},
		{
			Name:        "get_bookmarks",
			Description: "Retrieve or search decrypted browser bookmarks stored in CloudCookie's dedicated bookmarks slot.",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"query": map[string]any{
						"type":        "string",
						"description": "Optional case-insensitive substring filter matching bookmark title, URL, or folder path.",
					},
					"folder": map[string]any{
						"type":        "string",
						"description": "Optional case-insensitive substring filter matching the bookmark's folder path (e.g. 'Bookmarks bar/Dev').",
					},
					"format": map[string]any{
						"type":        "string",
						"enum":        []string{"json", "tree", "markdown"},
						"default":     "json",
						"description": "Output format: 'json' (flat list with folder_path), 'tree' (nested folder hierarchy), or 'markdown' (Markdown link list).",
					},
					"limit": map[string]any{
						"type":        "integer",
						"minimum":     1,
						"maximum":     1000,
						"default":     100,
						"description": "Maximum number of bookmarks to return in 'json' or 'markdown' format.",
					},
					"refresh": map[string]any{
						"type":        "boolean",
						"default":     false,
						"description": "Bypass local cache and fetch fresh data from the CloudCookie server.",
					},
				},
				"additionalProperties": false,
			},
		},
	}
}

func resourceDefinitions() []ResourceDefinition {
	return []ResourceDefinition{
		{
			URI:         "cloudcookie://slots",
			Name:        "CloudCookie Slots",
			Description: "List of active browser cookie slots in CloudCookie.",
			MimeType:    "application/json",
		},
		{
			URI:         "cloudcookie://domains",
			Name:        "CloudCookie Domains",
			Description: "List of domains with stored cookies in the default CloudCookie slot.",
			MimeType:    "application/json",
		},
		{
			URI:         "cloudcookie://meta",
			Name:        "CloudCookie Slot Meta",
			Description: "Browser User-Agent and environment metadata for the default CloudCookie slot.",
			MimeType:    "application/json",
		},
		{
			URI:         "cloudcookie://bookmarks",
			Name:        "CloudCookie Bookmarks",
			Description: "Synced browser bookmarks stored in CloudCookie's dedicated bookmarks slot.",
			MimeType:    "application/json",
		},
	}
}

func okResp(id json.RawMessage, result any) JSONRPCResponse {
	return JSONRPCResponse{
		JSONRPC: JSONRPCVersion,
		ID:      id,
		Result:  result,
	}
}

func errorResp(id json.RawMessage, code int, msg string) JSONRPCResponse {
	return JSONRPCResponse{
		JSONRPC: JSONRPCVersion,
		ID:      id,
		Error: &JSONRPCError{
			Code:    code,
			Message: msg,
		},
	}
}

func toolJSON(payload any) CallToolResult {
	b, _ := json.MarshalIndent(payload, "", "  ")
	return CallToolResult{
		Content:           []ContentBlock{{Type: "text", Text: string(b)}},
		StructuredContent: payload,
	}
}

func toolError(msg string) CallToolResult {
	return CallToolResult{
		Content: []ContentBlock{{Type: "text", Text: msg}},
		IsError: true,
	}
}
