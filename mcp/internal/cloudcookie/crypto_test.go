package cloudcookie

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

func TestProtocolReferenceVector(t *testing.T) {
	// Test vector from PROTOCOL.md
	const (
		rootKeyHex   = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
		wantClientID = "efaa52e7bf7b356fcebcbde5b95fa9aa24d6d91bbe6dac4d06bc5679b1d3e31e"
		wantEncKey   = "81d7dd656c9ed75994ce72f06f083e6891271f29c2221dfd844003118e1593b0"
		encryptedB64 = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYmob7YcRaAVXTjoVMw1qdJkqG5yJ+18HiKUzRt4j2RMkePC2TNAN7"
		wantPlain    = `{"hello":"cloudcookie"}`
		timestamp    = int64(1700000000)
		nonce        = "00112233445566778899aabbccddeeff"
		wantSig      = "5d1894a3d27d44072e859eef0c31f222bd032ed7576f0c76641c4717981c1facbf3c60ad4e5c36608bf44e8b476dd6e393f9d3d011d063de4d0e38855c86fc00"
	)

	rootKey, err := ParseRootKey(rootKeyHex)
	if err != nil {
		t.Fatalf("ParseRootKey failed: %v", err)
	}
	keys, err := DeriveKeys(rootKey)
	if err != nil {
		t.Fatalf("DeriveKeys failed: %v", err)
	}
	if keys.ClientID != wantClientID {
		t.Fatalf("ClientID mismatch: got %s, want %s", keys.ClientID, wantClientID)
	}
	if gotEnc := hex.EncodeToString(keys.EncKey[:]); gotEnc != wantEncKey {
		t.Fatalf("EncKey mismatch: got %s, want %s", gotEnc, wantEncKey)
	}

	plain, err := DecryptSlot(keys.EncKey, keys.ClientID, 1, 1, encryptedB64)
	if err != nil {
		t.Fatalf("DecryptSlot failed: %v", err)
	}
	if string(plain) != wantPlain {
		t.Fatalf("plaintext mismatch: got %q, want %q", string(plain), wantPlain)
	}

	sum := sha256.Sum256([]byte(encryptedB64))
	payloadHex := hex.EncodeToString(sum[:])
	sig := SignRequest(keys.PrivateKey, "update", keys.ClientID, "1", "0", timestamp, nonce, payloadHex)
	if sig != wantSig {
		t.Fatalf("signature mismatch: got %s, want %s", sig, wantSig)
	}
	sigBytes, _ := hex.DecodeString(sig)
	msg := "cloudcookie-v1:update:" + keys.ClientID + ":1:0:1700000000:" + nonce + ":" + payloadHex
	if !ed25519.Verify(keys.PublicKey, []byte(msg), sigBytes) {
		t.Fatalf("ed25519.Verify failed")
	}
}
