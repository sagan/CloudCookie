package mcp

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// HTTPHandler serves the MCP Streamable HTTP (2025-03-26) protocol on a single endpoint.
type HTTPHandler struct {
	server   *Server
	mu       sync.RWMutex
	sessions map[string]time.Time
}

// NewHTTPHandler creates an HTTPHandler wrapping an MCP Server.
func NewHTTPHandler(server *Server) *HTTPHandler {
	return &HTTPHandler{
		server:   server,
		sessions: make(map[string]time.Time),
	}
}

func (h *HTTPHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		h.handlePost(w, r)
	case http.MethodGet:
		h.handleGetSSE(w, r)
	case http.MethodDelete:
		h.handleDelete(w, r)
	default:
		w.Header().Set("Allow", "GET, POST, DELETE")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (h *HTTPHandler) handlePost(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 16*1024*1024))
	if err != nil {
		writeJSONRPCError(w, http.StatusBadRequest, json.RawMessage("null"), ErrCodeParseError, "read body: "+err.Error())
		return
	}

	trimmed := strings.TrimSpace(string(body))
	if trimmed == "" {
		writeJSONRPCError(w, http.StatusBadRequest, json.RawMessage("null"), ErrCodeInvalidRequest, "empty request body")
		return
	}

	// Support JSON-RPC batch requests as well as single requests.
	if strings.HasPrefix(trimmed, "[") {
		var reqs []JSONRPCRequest
		if err := json.Unmarshal([]byte(trimmed), &reqs); err != nil {
			writeJSONRPCError(w, http.StatusBadRequest, json.RawMessage("null"), ErrCodeParseError, "parse error: "+err.Error())
			return
		}
		if len(reqs) == 0 {
			writeJSONRPCError(w, http.StatusBadRequest, json.RawMessage("null"), ErrCodeInvalidRequest, "empty batch")
			return
		}
		var resps []JSONRPCResponse
		for _, req := range reqs {
			if len(req.ID) == 0 {
				h.server.handleNotification(req.Method)
				continue
			}
			resp := h.server.HandleRequest(r.Context(), req)
			if req.Method == "initialize" && resp.Error == nil {
				sid := h.createSession()
				w.Header().Set("Mcp-Session-Id", sid)
			}
			resps = append(resps, resp)
		}
		if len(resps) == 0 {
			w.WriteHeader(http.StatusAccepted)
			return
		}
		writeJSONResponse(w, http.StatusOK, resps)
		return
	}

	var req JSONRPCRequest
	if err := json.Unmarshal([]byte(trimmed), &req); err != nil {
		writeJSONRPCError(w, http.StatusBadRequest, json.RawMessage("null"), ErrCodeParseError, "parse error: "+err.Error())
		return
	}

	// Notification (no id) -> 202 Accepted
	if len(req.ID) == 0 {
		h.server.handleNotification(req.Method)
		w.WriteHeader(http.StatusAccepted)
		return
	}

	if req.Method != "initialize" {
		if sid := r.Header.Get("Mcp-Session-Id"); sid != "" {
			h.touchSession(sid)
		}
	}

	resp := h.server.HandleRequest(r.Context(), req)
	if req.Method == "initialize" && resp.Error == nil {
		sid := h.createSession()
		w.Header().Set("Mcp-Session-Id", sid)
	}

	writeJSONResponse(w, http.StatusOK, resp)
}

func (h *HTTPHandler) handleGetSSE(w http.ResponseWriter, r *http.Request) {
	if !strings.Contains(strings.ToLower(r.Header.Get("Accept")), "text/event-stream") {
		http.Error(w, "Accept: text/event-stream required for GET", http.StatusNotAcceptable)
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(": connected\n\n"))
	flusher.Flush()

	ticker := time.NewTicker(25 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
			_, _ = w.Write([]byte(": keepalive\n\n"))
			flusher.Flush()
		}
	}
}

func (h *HTTPHandler) handleDelete(w http.ResponseWriter, r *http.Request) {
	if sid := r.Header.Get("Mcp-Session-Id"); sid != "" {
		h.mu.Lock()
		delete(h.sessions, sid)
		h.mu.Unlock()
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *HTTPHandler) createSession() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	sid := hex.EncodeToString(b[:])
	h.mu.Lock()
	h.sessions[sid] = time.Now()
	h.mu.Unlock()
	return sid
}

func (h *HTTPHandler) touchSession(sid string) {
	h.mu.Lock()
	if _, ok := h.sessions[sid]; ok {
		h.sessions[sid] = time.Now()
	}
	h.mu.Unlock()
}

func writeJSONResponse(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

func writeJSONRPCError(w http.ResponseWriter, status int, id json.RawMessage, code int, msg string) {
	writeJSONResponse(w, status, JSONRPCResponse{
		JSONRPC: JSONRPCVersion,
		ID:      id,
		Error:   &JSONRPCError{Code: code, Message: msg},
	})
}
