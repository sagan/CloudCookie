package mcp

import "encoding/json"

const (
	JSONRPCVersion         = "2.0"
	DefaultProtocolVersion = "2024-11-05"
	LatestProtocolVersion  = "2025-03-26"
)

// Standard JSON-RPC 2.0 error codes.
const (
	ErrCodeParseError     = -32700
	ErrCodeInvalidRequest = -32600
	ErrCodeMethodNotFound = -32601
	ErrCodeInvalidParams  = -32602
	ErrCodeInternalError  = -32603
)

// JSONRPCRequest represents an incoming JSON-RPC 2.0 request or notification.
type JSONRPCRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

// JSONRPCResponse represents an outgoing JSON-RPC 2.0 response.
type JSONRPCResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *JSONRPCError   `json:"error,omitempty"`
}

// JSONRPCError represents a JSON-RPC 2.0 error object.
type JSONRPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

// InitializeParams is sent by the MCP client in "initialize".
type InitializeParams struct {
	ProtocolVersion string         `json:"protocolVersion"`
	Capabilities    map[string]any `json:"capabilities,omitempty"`
	ClientInfo      *EntityInfo    `json:"clientInfo,omitempty"`
}

// EntityInfo identifies an MCP client or server.
type EntityInfo struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

// InitializeResult is returned by the MCP server for "initialize".
type InitializeResult struct {
	ProtocolVersion string             `json:"protocolVersion"`
	Capabilities    ServerCapabilities `json:"capabilities"`
	ServerInfo      EntityInfo         `json:"serverInfo"`
	Instructions    string             `json:"instructions,omitempty"`
}

// ServerCapabilities declares supported MCP server features.
type ServerCapabilities struct {
	Tools     *ToolsCapability     `json:"tools,omitempty"`
	Resources *ResourcesCapability `json:"resources,omitempty"`
}

// ToolsCapability declares tool support.
type ToolsCapability struct {
	ListChanged bool `json:"listChanged"`
}

// ResourcesCapability declares resource support.
type ResourcesCapability struct {
	Subscribe   bool `json:"subscribe"`
	ListChanged bool `json:"listChanged"`
}

// ToolDefinition describes an MCP tool and its JSON Schema input.
type ToolDefinition struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
}

// ListToolsResult is returned by "tools/list".
type ListToolsResult struct {
	Tools []ToolDefinition `json:"tools"`
}

// CallToolParams is sent by the client in "tools/call".
type CallToolParams struct {
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments,omitempty"`
}

// ContentBlock represents a piece of MCP tool output content.
type ContentBlock struct {
	Type string `json:"type"`
	Text string `json:"text,omitempty"`
}

// CallToolResult is returned by "tools/call".
type CallToolResult struct {
	Content           []ContentBlock `json:"content"`
	StructuredContent any            `json:"structuredContent,omitempty"`
	IsError           bool           `json:"isError,omitempty"`
}

// ResourceDefinition describes an MCP resource.
type ResourceDefinition struct {
	URI         string `json:"uri"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	MimeType    string `json:"mimeType,omitempty"`
}

// ListResourcesResult is returned by "resources/list".
type ListResourcesResult struct {
	Resources []ResourceDefinition `json:"resources"`
}

// ReadResourceParams is sent by the client in "resources/read".
type ReadResourceParams struct {
	URI string `json:"uri"`
}

// ResourceContent represents a single resource's contents.
type ResourceContent struct {
	URI      string `json:"uri"`
	MimeType string `json:"mimeType,omitempty"`
	Text     string `json:"text,omitempty"`
}

// ReadResourceResult is returned by "resources/read".
type ReadResourceResult struct {
	Contents []ResourceContent `json:"contents"`
}
