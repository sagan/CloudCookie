package auth

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/hmac"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"slices"
	"strings"
	"time"
)

type jwtHeader struct {
	Alg string `json:"alg"`
	Typ string `json:"typ,omitempty"`
	Kid string `json:"kid,omitempty"`
}

// JWTClaims represents standard JWT claims used for OAuth access tokens.
type JWTClaims struct {
	Iss      string `json:"iss,omitempty"`
	Sub      string `json:"sub,omitempty"`
	Aud      any    `json:"aud,omitempty"` // string or []string
	Exp      int64  `json:"exp,omitempty"`
	Nbf      int64  `json:"nbf,omitempty"`
	Iat      int64  `json:"iat,omitempty"`
	Jti      string `json:"jti,omitempty"`
	Scope    string `json:"scope,omitempty"`
	ClientID string `json:"client_id,omitempty"`
	TokenUse string `json:"token_use,omitempty"`
}

// SignHS256 signs claims into a compact JWS using HMAC-SHA256.
func SignHS256(secret []byte, claims JWTClaims) (string, error) {
	hdrBytes, err := json.Marshal(jwtHeader{Alg: "HS256", Typ: "JWT"})
	if err != nil {
		return "", err
	}
	claimsBytes, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}

	hdrB64 := base64.RawURLEncoding.EncodeToString(hdrBytes)
	claimsB64 := base64.RawURLEncoding.EncodeToString(claimsBytes)
	signingInput := hdrB64 + "." + claimsB64

	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(signingInput))
	sigB64 := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return signingInput + "." + sigB64, nil
}

// VerifyHS256 verifies an HS256 JWT and returns its claims.
func VerifyHS256(token string, secret []byte, expectedIss, expectedAud string, now time.Time) (*JWTClaims, error) {
	hdr, claims, signingInput, sig, err := parseJWT(token)
	if err != nil {
		return nil, err
	}
	if hdr.Alg != "HS256" {
		return nil, fmt.Errorf("unexpected jwt alg %q", hdr.Alg)
	}

	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(signingInput))
	expectedSig := mac.Sum(nil)
	if subtle.ConstantTimeCompare(sig, expectedSig) != 1 {
		return nil, errors.New("invalid jwt signature")
	}

	if err := validateClaims(claims, expectedIss, expectedAud, "", now); err != nil {
		return nil, err
	}
	return claims, nil
}

func parseJWT(token string) (*jwtHeader, *JWTClaims, string, []byte, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, nil, "", nil, errors.New("invalid jwt format")
	}
	hdrBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, nil, "", nil, fmt.Errorf("decode jwt header: %w", err)
	}
	var hdr jwtHeader
	if err := json.Unmarshal(hdrBytes, &hdr); err != nil {
		return nil, nil, "", nil, fmt.Errorf("parse jwt header: %w", err)
	}
	claimsBytes, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, nil, "", nil, fmt.Errorf("decode jwt claims: %w", err)
	}
	var claims JWTClaims
	if err := json.Unmarshal(claimsBytes, &claims); err != nil {
		return nil, nil, "", nil, fmt.Errorf("parse jwt claims: %w", err)
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return nil, nil, "", nil, fmt.Errorf("decode jwt signature: %w", err)
	}
	return &hdr, &claims, parts[0] + "." + parts[1], sig, nil
}

func validateClaims(claims *JWTClaims, expectedIss, expectedAud, requiredScope string, now time.Time) error {
	nowUnix := now.Unix()
	const clockSkew = int64(30)

	if claims.Exp == 0 {
		return errors.New("jwt missing exp claim")
	}
	if nowUnix-clockSkew >= claims.Exp {
		return errors.New("jwt expired")
	}
	if claims.Nbf > 0 && nowUnix+clockSkew < claims.Nbf {
		return errors.New("jwt not yet valid")
	}
	if expectedIss != "" && strings.TrimRight(claims.Iss, "/") != strings.TrimRight(expectedIss, "/") {
		return fmt.Errorf("jwt issuer mismatch: got %q", claims.Iss)
	}
	if expectedAud != "" && !audContains(claims.Aud, expectedAud) {
		return errors.New("jwt audience mismatch")
	}
	if requiredScope != "" {
		scopes := strings.Fields(claims.Scope)
		if !slices.Contains(scopes, requiredScope) {
			return fmt.Errorf("missing required scope %q", requiredScope)
		}
	}
	return nil
}

func audContains(aud any, target string) bool {
	switch v := aud.(type) {
	case string:
		return v == target
	case []any:
		for _, item := range v {
			if s, ok := item.(string); ok && s == target {
				return true
			}
		}
	case []string:
		return slices.Contains(v, target)
	}
	return false
}

func verifyAsymmetricSignature(alg string, key crypto.PublicKey, signingInput string, sig []byte) error {
	digest := sha256.Sum256([]byte(signingInput))

	switch alg {
	case "RS256":
		pub, ok := key.(*rsa.PublicKey)
		if !ok {
			return errors.New("key is not RSA public key")
		}
		return rsa.VerifyPKCS1v15(pub, crypto.SHA256, digest[:], sig)

	case "ES256":
		pub, ok := key.(*ecdsa.PublicKey)
		if !ok {
			return errors.New("key is not ECDSA public key")
		}
		if len(sig) != 64 {
			return errors.New("invalid ES256 signature length")
		}
		r := new(big.Int).SetBytes(sig[:32])
		s := new(big.Int).SetBytes(sig[32:])
		if !ecdsa.Verify(pub, digest[:], r, s) {
			return errors.New("invalid ES256 signature")
		}
		return nil

	default:
		return fmt.Errorf("unsupported jwt alg %q", alg)
	}
}
