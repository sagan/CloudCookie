package cloudcookie

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ed25519"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

const (
	protocolSalt    = "cloudcookie-v1"
	infoAuthEd25519 = "client-auth-ed25519"
	infoEncKey      = "e2e-xaes256gcm"
	nonceLen        = 24
	tagLen          = 16
	minEncryptedLen = nonceLen + tagLen
	emptySHA256Hex  = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
)

// Keys holds the derived authentication keypair, client_id, and content encryption key.
type Keys struct {
	ClientID   string
	PrivateKey ed25519.PrivateKey
	PublicKey  ed25519.PublicKey
	EncKey     [32]byte
}

// ParseRootKey parses a 64-character hex-encoded 256-bit root key.
func ParseRootKey(hexKey string) ([32]byte, error) {
	var out [32]byte
	cleaned := strings.TrimSpace(hexKey)
	if len(cleaned) != 64 {
		return out, fmt.Errorf("e2e_key must be 64 hex characters, got %d", len(cleaned))
	}
	raw, err := hex.DecodeString(cleaned)
	if err != nil {
		return out, fmt.Errorf("invalid hex e2e_key: %w", err)
	}
	copy(out[:], raw)
	return out, nil
}

// DeriveKeys derives the Ed25519 auth keypair, client_id, and XAES-256-GCM encryption key
// from the 256-bit root key using HKDF-SHA256.
func DeriveKeys(rootKey [32]byte) (Keys, error) {
	var keys Keys
	salt := []byte(protocolSalt)

	authSeed, err := hkdf.Key(sha256.New, rootKey[:], salt, infoAuthEd25519, 32)
	if err != nil {
		return keys, fmt.Errorf("hkdf auth seed: %w", err)
	}
	priv := ed25519.NewKeyFromSeed(authSeed)
	pub := priv.Public().(ed25519.PublicKey)

	encSlice, err := hkdf.Key(sha256.New, rootKey[:], salt, infoEncKey, 32)
	if err != nil {
		return keys, fmt.Errorf("hkdf enc key: %w", err)
	}

	keys.PrivateKey = priv
	keys.PublicKey = pub
	keys.ClientID = hex.EncodeToString(pub)
	copy(keys.EncKey[:], encSlice)
	return keys, nil
}

// GenerateNonce generates a 16-byte CSPRNG nonce encoded as 32 lowercase hex chars.
func GenerateNonce() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("generate nonce: %w", err)
	}
	return hex.EncodeToString(b[:]), nil
}

// SignRequest computes the Ed25519 signature over the canonical CloudCookie v1 signing string.
func SignRequest(
	priv ed25519.PrivateKey,
	action string,
	clientID string,
	slotOrAll string,
	expectedVersionOrDash string,
	timestamp int64,
	nonce string,
	payloadSHA256Hex string,
) string {
	msg := fmt.Sprintf(
		"%s:%s:%s:%s:%s:%d:%s:%s",
		protocolSalt,
		action,
		clientID,
		slotOrAll,
		expectedVersionOrDash,
		timestamp,
		nonce,
		payloadSHA256Hex,
	)
	sig := ed25519.Sign(priv, []byte(msg))
	return hex.EncodeToString(sig)
}

func xaesDeriveSubkey(key [32]byte, nonce []byte) ([32]byte, [12]byte, error) {
	var kx [32]byte
	var n2 [12]byte

	block, err := aes.NewCipher(key[:])
	if err != nil {
		return kx, n2, err
	}

	var lBlock [16]byte
	block.Encrypt(lBlock[:], lBlock[:])

	var k1 [16]byte
	msb := (lBlock[0] & 0x80) != 0
	for i := 0; i < 15; i++ {
		k1[i] = (lBlock[i] << 1) | (lBlock[i+1] >> 7)
	}
	k1[15] = lBlock[15] << 1
	if msb {
		k1[15] ^= 0x87
	}

	n1 := nonce[:12]
	copy(n2[:], nonce[12:24])

	var m1 [16]byte
	m1[0] = 0x00
	m1[1] = 0x01
	m1[2] = 'X'
	m1[3] = 0x00
	copy(m1[4:16], n1)
	for i := 0; i < 16; i++ {
		m1[i] ^= k1[i]
	}

	var m2 [16]byte
	m2[0] = 0x00
	m2[1] = 0x02
	m2[2] = 'X'
	m2[3] = 0x00
	copy(m2[4:16], n1)
	for i := 0; i < 16; i++ {
		m2[i] ^= k1[i]
	}

	block.Encrypt(kx[:16], m1[:])
	block.Encrypt(kx[16:], m2[:])
	return kx, n2, nil
}

// DecryptSlot decrypts a base64-encoded XAES-256-GCM payload with AAD bound to clientID, slot, and version.
func DecryptSlot(encKey [32]byte, clientID string, slot uint32, version uint64, encryptedB64 string) ([]byte, error) {
	raw, err := base64.StdEncoding.DecodeString(encryptedB64)
	if err != nil {
		return nil, fmt.Errorf("invalid base64 payload: %w", err)
	}
	if len(raw) < minEncryptedLen {
		return nil, errors.New("encrypted payload shorter than nonce + tag")
	}

	nonce := raw[:nonceLen]
	ciphertext := raw[nonceLen:]

	kx, n2, err := xaesDeriveSubkey(encKey, nonce)
	if err != nil {
		return nil, fmt.Errorf("xaes key derivation: %w", err)
	}

	gcmBlock, err := aes.NewCipher(kx[:])
	if err != nil {
		return nil, fmt.Errorf("aes cipher: %w", err)
	}
	aead, err := cipher.NewGCM(gcmBlock)
	if err != nil {
		return nil, fmt.Errorf("aes-gcm: %w", err)
	}

	aad := fmt.Sprintf("%s:%s:%d:%d", protocolSalt, clientID, slot, version)
	plaintext, err := aead.Open(nil, n2[:], ciphertext, []byte(aad))
	if err != nil {
		return nil, fmt.Errorf("aead decryption failed: %w", err)
	}
	return plaintext, nil
}
