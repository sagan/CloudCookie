package cloudcookie

import "encoding/json"

// SyncRequest is the POST / request body sent to a CloudCookie server.
type SyncRequest struct {
	Action          string  `json:"action"`
	ClientID        string  `json:"client_id"`
	Slot            *uint32 `json:"slot,omitempty"`
	ExpectedVersion *uint64 `json:"expected_version,omitempty"`
	Timestamp       int64   `json:"timestamp"`
	Nonce           string  `json:"nonce"`
	Encrypted       string  `json:"encrypted,omitempty"`
	Signature       string  `json:"signature"`
}

// ListSlotEntry represents a single slot entry returned by the "list" action.
type ListSlotEntry struct {
	Slot      uint32 `json:"slot"`
	Version   uint64 `json:"version"`
	UpdatedAt string `json:"updated_at"`
	SizeBytes uint64 `json:"size_bytes"`
}

// SyncResponse is the POST / response body from a CloudCookie server.
type SyncResponse struct {
	OK             bool            `json:"ok"`
	Action         string          `json:"action,omitempty"`
	ClientID       string          `json:"client_id,omitempty"`
	Slot           *uint32         `json:"slot,omitempty"`
	Encrypted      string          `json:"encrypted,omitempty"`
	UpdatedAt      string          `json:"updated_at,omitempty"`
	Version        uint64          `json:"version,omitempty"`
	Slots          []ListSlotEntry `json:"slots,omitempty"`
	Error          string          `json:"error,omitempty"`
	Message        string          `json:"message,omitempty"`
	ServerTime     *int64          `json:"server_time,omitempty"`
	CurrentVersion *uint64         `json:"current_version,omitempty"`
}

// SlotMetaEntry represents an entry inside decrypted Slot 0 metadata.
type SlotMetaEntry struct {
	Slot      uint32 `json:"slot"`
	Name      string `json:"name"`
	Type      string `json:"type,omitempty"`
	CreatedAt int64  `json:"created_at"`
	UpdatedAt int64  `json:"updated_at"`
	Deleted   bool   `json:"deleted,omitempty"`
}

// Slot0Payload is the decrypted JSON payload of Slot 0 (Meta Slot).
type Slot0Payload struct {
	SchemaVersion int                      `json:"schema_version"`
	UpdatedAt     int64                    `json:"updated_at"`
	BookmarksSlot *uint32                  `json:"bookmarks_slot,omitempty"`
	Slots         map[string]SlotMetaEntry `json:"slots"`
}

// PartitionKey matches the browser extension's SerializedCookie.partitionKey.
type PartitionKey struct {
	TopLevelSite         string `json:"topLevelSite,omitempty"`
	HasCrossSiteAncestor *bool  `json:"hasCrossSiteAncestor,omitempty"`
}

// SerializedCookie matches the browser extension's SerializedCookie schema.
type SerializedCookie struct {
	Name           string        `json:"name"`
	Value          string        `json:"value"`
	Domain         string        `json:"domain"`
	Path           string        `json:"path"`
	Secure         bool          `json:"secure"`
	HTTPOnly       bool          `json:"httpOnly"`
	SameSite       string        `json:"sameSite,omitempty"`
	ExpirationDate *float64      `json:"expirationDate,omitempty"`
	HostOnly       bool          `json:"hostOnly"`
	Session        bool          `json:"session"`
	StoreID        string        `json:"storeId,omitempty"`
	PartitionKey   *PartitionKey `json:"partitionKey,omitempty"`
}

// UserAgentBrand represents a brand/version pair from NavigatorUAData.
type UserAgentBrand struct {
	Brand   string `json:"brand"`
	Version string `json:"version"`
}

// UserAgentDataMeta represents Chromium UA Client Hints collected by the extension.
type UserAgentDataMeta struct {
	Brands          []UserAgentBrand `json:"brands,omitempty"`
	Mobile          *bool            `json:"mobile,omitempty"`
	Platform        string           `json:"platform,omitempty"`
	PlatformVersion string           `json:"platform_version,omitempty"`
	Architecture    string           `json:"architecture,omitempty"`
	Bitness         string           `json:"bitness,omitempty"`
	FullVersionList []UserAgentBrand `json:"full_version_list,omitempty"`
}

// BrowserMeta holds the browser User-Agent and environment metadata uploaded with a slot.
type BrowserMeta struct {
	UserAgent        string             `json:"user_agent,omitempty"`
	UserAgentData    *UserAgentDataMeta `json:"user_agent_data,omitempty"`
	Platform         string             `json:"platform,omitempty"`
	Language         string             `json:"language,omitempty"`
	Languages        []string           `json:"languages,omitempty"`
	Timezone         string             `json:"timezone,omitempty"`
	ExtensionVersion string             `json:"extension_version,omitempty"`
}

// SlotDataPayload is the decrypted JSON payload of Slot 1+ (Cookie Data Slot).
type SlotDataPayload struct {
	SchemaVersion int                           `json:"schema_version"`
	Slot          uint32                        `json:"slot"`
	InstanceName  string                        `json:"instance_name"`
	UpdatedAt     int64                         `json:"updated_at"`
	CookieCount   int                           `json:"cookie_count"`
	DomainCount   int                           `json:"domain_count"`
	Meta          *BrowserMeta                  `json:"meta,omitempty"`
	Cookies       map[string][]SerializedCookie `json:"cookies"`
}

// BookmarkNode matches the browser extension's SerializedBookmarkNode schema.
type BookmarkNode struct {
	Title     string         `json:"title"`
	URL       string         `json:"url,omitempty"`
	DateAdded int64          `json:"dateAdded,omitempty"`
	Children  []BookmarkNode `json:"children,omitempty"`
}

// BookmarkSlotPayload is the decrypted JSON payload of the dedicated bookmarks slot.
type BookmarkSlotPayload struct {
	SchemaVersion int            `json:"schema_version"`
	Slot          uint32         `json:"slot"`
	UpdatedAt     int64          `json:"updated_at"`
	BookmarkCount int            `json:"bookmark_count"`
	FolderCount   int            `json:"folder_count"`
	Roots         []BookmarkNode `json:"roots"`
}

// ServerError represents an error returned by the CloudCookie HTTP API.
type ServerError struct {
	StatusCode int
	Code       string
	Message    string
	ServerTime *int64
}

func (e *ServerError) Error() string {
	if e.Message != "" {
		return e.Code + ": " + e.Message
	}
	if e.Code != "" {
		return e.Code
	}
	return "cloudcookie server error"
}

// RawMessage alias for convenience if needed.
type RawJSON = json.RawMessage
