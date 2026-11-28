package cloudcookie

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func encryptForTest(t *testing.T, encKey [32]byte, clientID string, slot uint32, version uint64, plaintext []byte) string {
	t.Helper()
	var nonce [24]byte
	for i := range nonce {
		nonce[i] = byte(i + 1)
	}
	kx, n2, err := xaesDeriveSubkey(encKey, nonce[:])
	if err != nil {
		t.Fatalf("xaesDeriveSubkey: %v", err)
	}
	block, err := aes.NewCipher(kx[:])
	if err != nil {
		t.Fatalf("aes.NewCipher: %v", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatalf("cipher.NewGCM: %v", err)
	}
	aad := fmt.Sprintf("cloudcookie-v1:%s:%d:%d", clientID, slot, version)
	ct := aead.Seal(nil, n2[:], plaintext, []byte(aad))
	out := append(nonce[:], ct...)
	return base64.StdEncoding.EncodeToString(out)
}

func TestClientSyncCacheAndClockOffset(t *testing.T) {
	const rootKeyHex = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
	rk, _ := ParseRootKey(rootKeyHex)
	keys, _ := DeriveKeys(rk)

	slot0JSON, _ := json.Marshal(Slot0Payload{
		SchemaVersion: 1,
		UpdatedAt:     1795692095000,
		Slots: map[string]SlotMetaEntry{
			"1": {Slot: 1, Name: "Dev Chrome", CreatedAt: 1795690000000, UpdatedAt: 1795692095000},
		},
	})
	slot1JSON, _ := json.Marshal(SlotDataPayload{
		SchemaVersion: 1,
		Slot:          1,
		InstanceName:  "Dev Chrome",
		CookieCount:   1,
		DomainCount:   1,
		Cookies: map[string][]SerializedCookie{
			"example.org": {{Name: "tok", Value: "v1", Domain: "example.org", Path: "/", HostOnly: true}},
		},
	})

	enc0 := encryptForTest(t, keys.EncKey, keys.ClientID, 0, 1, slot0JSON)
	enc1 := encryptForTest(t, keys.EncKey, keys.ClientID, 1, 2, slot1JSON)

	var reqCount atomic.Int32
	var forceSkewOnce atomic.Bool
	forceSkewOnce.Store(true)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reqCount.Add(1)
		var req SyncRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}

		// Verify Ed25519 signature
		slotOrAll := "-"
		if req.Slot != nil {
			slotOrAll = fmt.Sprintf("%d", *req.Slot)
		}
		msg := fmt.Sprintf("cloudcookie-v1:%s:%s:%s:-:%d:%s:%s",
			req.Action, req.ClientID, slotOrAll, req.Timestamp, req.Nonce, emptySHA256Hex)
		sigBytes, _ := hex.DecodeString(req.Signature)
		if !ed25519.Verify(keys.PublicKey, []byte(msg), sigBytes) {
			http.Error(w, "bad sig", http.StatusUnauthorized)
			return
		}

		// Simulate clock skew on very first request
		if forceSkewOnce.Swap(false) {
			serverNow := time.Now().Unix() + 600
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(SyncResponse{
				OK:         false,
				Error:      "timestamp_expired",
				Message:    "clock skew",
				ServerTime: &serverNow,
			})
			return
		}

		w.Header().Set("Content-Type", "application/json")
		switch req.Action {
		case "list":
			_ = json.NewEncoder(w).Encode(SyncResponse{
				OK:       true,
				Action:   "list",
				ClientID: req.ClientID,
				Slots: []ListSlotEntry{
					{Slot: 0, Version: 1, UpdatedAt: "2026-11-28T00:00:00Z", SizeBytes: 100},
					{Slot: 1, Version: 2, UpdatedAt: "2026-11-28T00:00:00Z", SizeBytes: 200},
				},
			})
		case "get":
			if req.Slot == nil {
				http.Error(w, "missing slot", http.StatusBadRequest)
				return
			}
			if *req.Slot == 0 {
				_ = json.NewEncoder(w).Encode(SyncResponse{
					OK:        true,
					Action:    "get",
					ClientID:  req.ClientID,
					Slot:      req.Slot,
					Version:   1,
					Encrypted: enc0,
				})
				return
			}
			_ = json.NewEncoder(w).Encode(SyncResponse{
				OK:        true,
				Action:    "get",
				ClientID:  req.ClientID,
				Slot:      req.Slot,
				Version:   2,
				Encrypted: enc1,
			})
		}
	}))
	defer srv.Close()

	client, err := NewClient(Config{
		ServerURL: srv.URL,
		E2EKey:    rootKeyHex,
		CacheTTL:  30 * time.Second,
	})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}

	ctx := context.Background()
	slotID, err := client.ResolveSlot(ctx, nil, false)
	if err != nil {
		t.Fatalf("ResolveSlot: %v", err)
	}
	if slotID != 1 {
		t.Fatalf("expected slot 1, got %d", slotID)
	}

	data, ver, err := client.GetSlotData(ctx, slotID, false)
	if err != nil {
		t.Fatalf("GetSlotData: %v", err)
	}
	if ver != 2 || data.InstanceName != "Dev Chrome" {
		t.Fatalf("unexpected slot data: ver=%d, data=%+v", ver, data)
	}

	// Second call should hit cache without hitting server
	beforeCount := reqCount.Load()
	_, _, err = client.GetSlotData(ctx, slotID, false)
	if err != nil {
		t.Fatalf("GetSlotData cached: %v", err)
	}
	if reqCount.Load() != beforeCount {
		t.Fatalf("expected cache hit, but server request count increased")
	}
}
