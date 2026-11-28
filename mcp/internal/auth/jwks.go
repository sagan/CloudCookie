package auth

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"sync"
	"time"
)

type jwksResponse struct {
	Keys []jwkEntry `json:"keys"`
}

type jwkEntry struct {
	Kty string `json:"kty"`
	Kid string `json:"kid"`
	Use string `json:"use"`
	Alg string `json:"alg"`
	// RSA
	N string `json:"n"`
	E string `json:"e"`
	// EC
	Crv string `json:"crv"`
	X   string `json:"x"`
	Y   string `json:"y"`
}

// JWKSVerifier verifies RS256/ES256 JWTs against a remote JWKS endpoint.
type JWKSVerifier struct {
	jwksURL       string
	issuer        string
	audience      string
	requiredScope string
	httpClient    *http.Client
	cacheTTL      time.Duration

	mu          sync.RWMutex
	keys        map[string]crypto.PublicKey
	unnamedKeys []crypto.PublicKey
	fetchedAt   time.Time
}

// NewJWKSVerifier creates a verifier for an external OAuth/OIDC JWKS endpoint.
func NewJWKSVerifier(jwksURL, issuer, audience, requiredScope string, httpClient *http.Client) *JWKSVerifier {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 10 * time.Second}
	}
	return &JWKSVerifier{
		jwksURL:       jwksURL,
		issuer:        issuer,
		audience:      audience,
		requiredScope: requiredScope,
		httpClient:    httpClient,
		cacheTTL:      5 * time.Minute,
		keys:          make(map[string]crypto.PublicKey),
	}
}

// Verify parses and verifies a Bearer JWT token against cached or freshly fetched JWKS.
func (v *JWKSVerifier) Verify(ctx context.Context, token string) (*JWTClaims, error) {
	hdr, claims, signingInput, sig, err := parseJWT(token)
	if err != nil {
		return nil, err
	}
	if hdr.Alg != "RS256" && hdr.Alg != "ES256" {
		return nil, fmt.Errorf("unsupported jwt alg %q", hdr.Alg)
	}

	candidates, err := v.getKeysForKid(ctx, hdr.Kid)
	if err != nil {
		return nil, err
	}

	var sigVerified bool
	for _, pub := range candidates {
		if verifyAsymmetricSignature(hdr.Alg, pub, signingInput, sig) == nil {
			sigVerified = true
			break
		}
	}
	if !sigVerified {
		return nil, errors.New("jwt signature verification failed")
	}

	if err := validateClaims(claims, v.issuer, v.audience, v.requiredScope, time.Now()); err != nil {
		return nil, err
	}
	return claims, nil
}

func (v *JWKSVerifier) getKeysForKid(ctx context.Context, kid string) ([]crypto.PublicKey, error) {
	v.mu.RLock()
	fresh := time.Since(v.fetchedAt) < v.cacheTTL
	if fresh {
		if kid != "" {
			if k, ok := v.keys[kid]; ok {
				v.mu.RUnlock()
				return []crypto.PublicKey{k}, nil
			}
		} else if len(v.unnamedKeys) > 0 {
			out := append([]crypto.PublicKey(nil), v.unnamedKeys...)
			v.mu.RUnlock()
			return out, nil
		}
	}
	// Rate-limit forced refreshes on unknown kid to once per 15s
	canRefresh := !fresh || time.Since(v.fetchedAt) > 15*time.Second
	v.mu.RUnlock()

	if canRefresh {
		if err := v.refresh(ctx); err != nil {
			return nil, err
		}
	}

	v.mu.RLock()
	defer v.mu.RUnlock()
	if kid != "" {
		if k, ok := v.keys[kid]; ok {
			return []crypto.PublicKey{k}, nil
		}
		return nil, fmt.Errorf("unknown jwk kid %q", kid)
	}
	if len(v.unnamedKeys) > 0 {
		return append([]crypto.PublicKey(nil), v.unnamedKeys...), nil
	}
	var all []crypto.PublicKey
	for _, k := range v.keys {
		all = append(all, k)
	}
	if len(all) == 0 {
		return nil, errors.New("no usable keys in jwks")
	}
	return all, nil
}

func (v *JWKSVerifier) refresh(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, v.jwksURL, nil)
	if err != nil {
		return err
	}
	resp, err := v.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("fetch jwks: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("fetch jwks status %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 2*1024*1024))
	if err != nil {
		return fmt.Errorf("read jwks: %w", err)
	}

	var jwks jwksResponse
	if err := json.Unmarshal(body, &jwks); err != nil {
		return fmt.Errorf("parse jwks: %w", err)
	}

	keyMap := make(map[string]crypto.PublicKey)
	var unnamed []crypto.PublicKey
	for _, entry := range jwks.Keys {
		if entry.Use != "" && entry.Use != "sig" {
			continue
		}
		pub, err := parseJWK(entry)
		if err != nil {
			continue
		}
		if entry.Kid != "" {
			keyMap[entry.Kid] = pub
		} else {
			unnamed = append(unnamed, pub)
		}
	}

	v.mu.Lock()
	v.keys = keyMap
	v.unnamedKeys = unnamed
	v.fetchedAt = time.Now()
	v.mu.Unlock()
	return nil
}

func parseJWK(e jwkEntry) (crypto.PublicKey, error) {
	switch e.Kty {
	case "RSA":
		nb, err := base64.RawURLEncoding.DecodeString(e.N)
		if err != nil {
			return nil, err
		}
		eb, err := base64.RawURLEncoding.DecodeString(e.E)
		if err != nil {
			return nil, err
		}
		n := new(big.Int).SetBytes(nb)
		exp := new(big.Int).SetBytes(eb)
		if !exp.IsInt64() || exp.Int64() <= 1 {
			return nil, errors.New("invalid rsa exponent")
		}
		return &rsa.PublicKey{N: n, E: int(exp.Int64())}, nil

	case "EC":
		if e.Crv != "P-256" {
			return nil, fmt.Errorf("unsupported ec curve %q", e.Crv)
		}
		xb, err := base64.RawURLEncoding.DecodeString(e.X)
		if err != nil {
			return nil, err
		}
		yb, err := base64.RawURLEncoding.DecodeString(e.Y)
		if err != nil {
			return nil, err
		}
		return &ecdsa.PublicKey{
			Curve: elliptic.P256(),
			X:     new(big.Int).SetBytes(xb),
			Y:     new(big.Int).SetBytes(yb),
		}, nil

	default:
		return nil, fmt.Errorf("unsupported jwk kty %q", e.Kty)
	}
}
