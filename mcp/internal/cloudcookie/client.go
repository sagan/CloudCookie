package cloudcookie

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Config configures a CloudCookie read-only client.
type Config struct {
	ServerURL   string
	E2EKey      string
	DefaultSlot uint32 // 0 = auto-discover
	CacheTTL    time.Duration
	HTTPClient  *http.Client
}

// SlotSummary describes an available slot discovered from Slot 0 and/or server list.
type SlotSummary struct {
	Slot        uint32 `json:"slot"`
	Name        string `json:"name"`
	CreatedAt   int64  `json:"created_at,omitempty"`
	UpdatedAt   int64  `json:"updated_at,omitempty"`
	Version     uint64 `json:"version,omitempty"`
	SizeBytes   uint64 `json:"size_bytes,omitempty"`
	CookieCount *int   `json:"cookie_count,omitempty"`
	DomainCount *int   `json:"domain_count,omitempty"`
}

type cachedMeta struct {
	payload   *Slot0Payload
	fetchedAt time.Time
}

type cachedSlotData struct {
	payload   *SlotDataPayload
	version   uint64
	fetchedAt time.Time
}

// Client is a zero-knowledge CloudCookie v1 read-only client with TTL caching.
type Client struct {
	serverURL   string
	keys        Keys
	defaultSlot uint32
	cacheTTL    time.Duration
	httpClient  *http.Client
	clockOffset atomic.Int64

	mu        sync.RWMutex
	metaCache *cachedMeta
	slotCache map[uint32]cachedSlotData
}

// NewClient creates a new CloudCookie client after validating serverURL and e2eKey.
func NewClient(cfg Config) (*Client, error) {
	serverURL := strings.TrimRight(strings.TrimSpace(cfg.ServerURL), "/")
	if serverURL == "" {
		return nil, errors.New("server_url is required")
	}
	if !strings.HasPrefix(serverURL, "http://") && !strings.HasPrefix(serverURL, "https://") {
		return nil, fmt.Errorf("server_url must start with http:// or https://, got %q", serverURL)
	}

	rootKey, err := ParseRootKey(cfg.E2EKey)
	if err != nil {
		return nil, err
	}
	keys, err := DeriveKeys(rootKey)
	if err != nil {
		return nil, err
	}

	httpClient := cfg.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 15 * time.Second}
	}

	cacheTTL := cfg.CacheTTL
	if cacheTTL < 0 {
		cacheTTL = 0
	}

	return &Client{
		serverURL:   serverURL,
		keys:        keys,
		defaultSlot: cfg.DefaultSlot,
		cacheTTL:    cacheTTL,
		httpClient:  httpClient,
		slotCache:   make(map[uint32]cachedSlotData),
	}, nil
}

// ClientID returns the derived 64-char hex Ed25519 public key.
func (c *Client) ClientID() string {
	return c.keys.ClientID
}

// ServerURL returns the normalized server URL.
func (c *Client) ServerURL() string {
	return c.serverURL
}

// DefaultSlot returns the configured default slot (0 if auto-discover).
func (c *Client) DefaultSlot() uint32 {
	return c.defaultSlot
}

func (c *Client) doSync(ctx context.Context, action string, slot *uint32) (*SyncResponse, error) {
	resp, err := c.doSyncOnce(ctx, action, slot)
	if err != nil {
		var srvErr *ServerError
		if errors.As(err, &srvErr) && srvErr.Code == "timestamp_expired" && srvErr.ServerTime != nil {
			offset := *srvErr.ServerTime - time.Now().Unix()
			c.clockOffset.Store(offset)
			return c.doSyncOnce(ctx, action, slot)
		}
		return nil, err
	}
	return resp, nil
}

func (c *Client) doSyncOnce(ctx context.Context, action string, slot *uint32) (*SyncResponse, error) {
	nonce, err := GenerateNonce()
	if err != nil {
		return nil, err
	}
	ts := time.Now().Unix() + c.clockOffset.Load()

	slotOrAll := "-"
	if slot != nil {
		slotOrAll = strconv.FormatUint(uint64(*slot), 10)
	}
	sig := SignRequest(c.keys.PrivateKey, action, c.keys.ClientID, slotOrAll, "-", ts, nonce, emptySHA256Hex)

	reqBody := SyncRequest{
		Action:    action,
		ClientID:  c.keys.ClientID,
		Slot:      slot,
		Timestamp: ts,
		Nonce:     nonce,
		Signature: sig,
	}

	bodyBytes, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.serverURL+"/", bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "application/json")

	httpResp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("http post %s/: %w", c.serverURL, err)
	}
	defer httpResp.Body.Close()

	respBytes, err := io.ReadAll(io.LimitReader(httpResp.Body, 32*1024*1024))
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}

	var syncResp SyncResponse
	if err := json.Unmarshal(respBytes, &syncResp); err != nil {
		return nil, fmt.Errorf("invalid json response (status %d): %w", httpResp.StatusCode, err)
	}

	if httpResp.StatusCode != http.StatusOK || !syncResp.OK {
		return nil, &ServerError{
			StatusCode: httpResp.StatusCode,
			Code:       syncResp.Error,
			Message:    syncResp.Message,
			ServerTime: syncResp.ServerTime,
		}
	}

	// Verify response consistency per PROTOCOL.md
	if syncResp.ClientID != c.keys.ClientID {
		return nil, fmt.Errorf("response client_id mismatch: got %q, want %q", syncResp.ClientID, c.keys.ClientID)
	}
	if syncResp.Action != action {
		return nil, fmt.Errorf("response action mismatch: got %q, want %q", syncResp.Action, action)
	}
	if slot != nil {
		if syncResp.Slot == nil || *syncResp.Slot != *slot {
			return nil, fmt.Errorf("response slot mismatch")
		}
	}

	return &syncResp, nil
}

// ListServerSlots calls the "list" action on the server.
func (c *Client) ListServerSlots(ctx context.Context) ([]ListSlotEntry, error) {
	resp, err := c.doSync(ctx, "list", nil)
	if err != nil {
		return nil, err
	}
	return resp.Slots, nil
}

// GetMeta fetches and decrypts Slot 0 metadata. Returns (nil, nil) if Slot 0 does not exist (no_data).
func (c *Client) GetMeta(ctx context.Context, refresh bool) (*Slot0Payload, error) {
	if !refresh && c.cacheTTL > 0 {
		c.mu.RLock()
		if c.metaCache != nil && time.Since(c.metaCache.fetchedAt) < c.cacheTTL {
			p := c.metaCache.payload
			c.mu.RUnlock()
			return p, nil
		}
		c.mu.RUnlock()
	}

	slot0 := uint32(0)
	resp, err := c.doSync(ctx, "get", &slot0)
	if err != nil {
		var srvErr *ServerError
		if errors.As(err, &srvErr) && srvErr.Code == "no_data" {
			return nil, nil
		}
		return nil, err
	}

	plain, err := DecryptSlot(c.keys.EncKey, c.keys.ClientID, 0, resp.Version, resp.Encrypted)
	if err != nil {
		return nil, fmt.Errorf("decrypt slot 0: %w", err)
	}

	var meta Slot0Payload
	if err := json.Unmarshal(plain, &meta); err != nil {
		return nil, fmt.Errorf("parse slot 0 json: %w", err)
	}

	if c.cacheTTL > 0 {
		c.mu.Lock()
		c.metaCache = &cachedMeta{payload: &meta, fetchedAt: time.Now()}
		c.mu.Unlock()
	}
	return &meta, nil
}

// GetSlotData fetches and decrypts a cookie data slot (slot >= 1).
func (c *Client) GetSlotData(ctx context.Context, slot uint32, refresh bool) (*SlotDataPayload, uint64, error) {
	if slot == 0 {
		return nil, 0, errors.New("slot 0 is metadata, not cookie data; specify slot >= 1")
	}

	if !refresh && c.cacheTTL > 0 {
		c.mu.RLock()
		if cached, ok := c.slotCache[slot]; ok && time.Since(cached.fetchedAt) < c.cacheTTL {
			c.mu.RUnlock()
			return cached.payload, cached.version, nil
		}
		c.mu.RUnlock()
	}

	resp, err := c.doSync(ctx, "get", &slot)
	if err != nil {
		return nil, 0, err
	}

	plain, err := DecryptSlot(c.keys.EncKey, c.keys.ClientID, slot, resp.Version, resp.Encrypted)
	if err != nil {
		return nil, 0, fmt.Errorf("decrypt slot %d: %w", slot, err)
	}

	var data SlotDataPayload
	if err := json.Unmarshal(plain, &data); err != nil {
		return nil, 0, fmt.Errorf("parse slot %d json: %w", slot, err)
	}

	if c.cacheTTL > 0 {
		c.mu.Lock()
		c.slotCache[slot] = cachedSlotData{
			payload:   &data,
			version:   resp.Version,
			fetchedAt: time.Now(),
		}
		c.mu.Unlock()
	}
	return &data, resp.Version, nil
}

// ListSlots returns active slots combining authenticated Slot 0 metadata with server list info.
func (c *Client) ListSlots(ctx context.Context, refresh bool) ([]SlotSummary, error) {
	meta, err := c.GetMeta(ctx, refresh)
	if err != nil {
		return nil, err
	}

	serverSlots, listErr := c.ListServerSlots(ctx)
	serverMap := make(map[uint32]ListSlotEntry, len(serverSlots))
	if listErr == nil {
		for _, s := range serverSlots {
			serverMap[s.Slot] = s
		}
	}

	var result []SlotSummary
	seen := make(map[uint32]bool)

	if meta != nil {
		for _, entry := range meta.Slots {
			if entry.Deleted || entry.Slot == 0 {
				continue
			}
			seen[entry.Slot] = true
			summary := SlotSummary{
				Slot:      entry.Slot,
				Name:      entry.Name,
				CreatedAt: entry.CreatedAt,
				UpdatedAt: entry.UpdatedAt,
			}
			if srv, ok := serverMap[entry.Slot]; ok {
				summary.Version = srv.Version
				summary.SizeBytes = srv.SizeBytes
			}
			c.mu.RLock()
			if cached, ok := c.slotCache[entry.Slot]; ok {
				cc := cached.payload.CookieCount
				dc := cached.payload.DomainCount
				summary.CookieCount = &cc
				summary.DomainCount = &dc
			}
			c.mu.RUnlock()
			result = append(result, summary)
		}
	} else if listErr == nil {
		// No Slot 0 metadata; fall back to server list (slots >= 1)
		for _, srv := range serverSlots {
			if srv.Slot == 0 {
				continue
			}
			seen[srv.Slot] = true
			result = append(result, SlotSummary{
				Slot:      srv.Slot,
				Name:      fmt.Sprintf("Slot %d", srv.Slot),
				Version:   srv.Version,
				SizeBytes: srv.SizeBytes,
			})
		}
	} else {
		return nil, listErr
	}

	sort.Slice(result, func(i, j int) bool {
		return result[i].Slot < result[j].Slot
	})
	return result, nil
}

// ResolveSlot returns the requested slot if > 0, otherwise the configured defaultSlot,
// otherwise auto-discovers the most recently updated active slot.
func (c *Client) ResolveSlot(ctx context.Context, requestedSlot *uint32, refresh bool) (uint32, error) {
	if requestedSlot != nil && *requestedSlot > 0 {
		return *requestedSlot, nil
	}
	if requestedSlot != nil && *requestedSlot == 0 {
		return 0, errors.New("slot must be >= 1")
	}
	if c.defaultSlot > 0 {
		return c.defaultSlot, nil
	}

	slots, err := c.ListSlots(ctx, refresh)
	if err != nil {
		return 0, fmt.Errorf("auto-discover slot: %w", err)
	}
	if len(slots) == 0 {
		return 0, errors.New("no active cookie slots found in CloudCookie")
	}

	best := slots[0]
	for _, s := range slots[1:] {
		if s.UpdatedAt > best.UpdatedAt || (s.UpdatedAt == best.UpdatedAt && s.Slot > best.Slot) {
			best = s
		}
	}
	return best.Slot, nil
}
