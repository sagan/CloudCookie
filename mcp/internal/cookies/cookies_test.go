package cookies

import (
	"strings"
	"testing"
	"time"

	"github.com/sagan/cloudcookie-mcp/internal/cloudcookie"
)

func floatPtr(v float64) *float64 { return &v }

func samplePayload() *cloudcookie.SlotDataPayload {
	future := float64(time.Now().Add(24 * time.Hour).Unix())
	past := float64(time.Now().Add(-24 * time.Hour).Unix())
	return &cloudcookie.SlotDataPayload{
		SchemaVersion: 1,
		Slot:          1,
		InstanceName:  "Test Browser",
		Cookies: map[string][]cloudcookie.SerializedCookie{
			"github.com": {
				{
					Name:           "user_session",
					Value:          "abc123",
					Domain:         ".github.com",
					Path:           "/",
					Secure:         true,
					HTTPOnly:       true,
					SameSite:       "lax",
					ExpirationDate: floatPtr(future),
					HostOnly:       false,
				},
				{
					Name:           "expired_tok",
					Value:          "old",
					Domain:         ".github.com",
					Path:           "/",
					Secure:         true,
					ExpirationDate: floatPtr(past),
					HostOnly:       false,
				},
				{
					Name:     "host_only_gh",
					Value:    "only_root",
					Domain:   "github.com",
					Path:     "/settings",
					Secure:   false,
					HostOnly: true,
				},
			},
			"gist.github.com": {
				{
					Name:     "gist_pref",
					Value:    "dark",
					Domain:   "gist.github.com",
					Path:     "/",
					Secure:   true,
					SameSite: "no_restriction",
					HostOnly: true,
					Session:  true,
				},
			},
			"secretbank.com": {
				{
					Name:   "bank_sid",
					Value:  "s3cr3t",
					Domain: "secretbank.com",
					Path:   "/",
				},
			},
		},
	}
}

func TestMatchCookiesByURL(t *testing.T) {
	payload := samplePayload()
	policy := NewDomainPolicy(nil, []string{"secretbank.com"})

	// HTTPS request to gist.github.com should get gist_pref + user_session (.github.com),
	// NOT host_only_gh (hostOnly on github.com) and NOT expired_tok.
	res, err := MatchCookies(payload, policy, MatchOptions{
		URL: "https://gist.github.com/myuser",
	})
	if err != nil {
		t.Fatalf("MatchCookies failed: %v", err)
	}
	if len(res.Cookies) != 2 {
		t.Fatalf("expected 2 cookies, got %d: %+v", len(res.Cookies), res.Cookies)
	}
	header := FormatHeader(res.Cookies)
	if !strings.Contains(header, "gist_pref=dark") || !strings.Contains(header, "user_session=abc123") {
		t.Fatalf("unexpected header: %s", header)
	}

	// HTTP request should exclude Secure cookies
	resHTTP, err := MatchCookies(payload, policy, MatchOptions{
		URL: "http://github.com/settings/profile",
	})
	if err != nil {
		t.Fatalf("MatchCookies HTTP failed: %v", err)
	}
	if len(resHTTP.Cookies) != 1 || resHTTP.Cookies[0].Name != "host_only_gh" {
		t.Fatalf("expected only host_only_gh for http://github.com/settings/profile, got %+v", resHTTP.Cookies)
	}

	// Blocked domain should return error
	if _, err := MatchCookies(payload, policy, MatchOptions{URL: "https://app.secretbank.com/"}); err == nil {
		t.Fatalf("expected error for blocked domain")
	}
}

func TestFormatNetscapeAndPlaywright(t *testing.T) {
	payload := samplePayload()
	policy := DomainPolicy{}

	res, err := MatchCookies(payload, policy, MatchOptions{
		Domain:            "github.com",
		IncludeSubdomains: true,
	})
	if err != nil {
		t.Fatalf("MatchCookies failed: %v", err)
	}

	netscape := FormatNetscape(res.Cookies)
	if !strings.Contains(netscape, "# Netscape HTTP Cookie File") {
		t.Fatalf("missing Netscape header")
	}
	if !strings.Contains(netscape, ".github.com\tTRUE\t/\tTRUE\t") {
		t.Fatalf("missing .github.com Netscape line: %s", netscape)
	}

	pw := FormatPlaywright(res.Cookies)
	if len(pw) != len(res.Cookies) {
		t.Fatalf("playwright count mismatch")
	}
	foundLax := false
	foundNone := false
	for _, c := range pw {
		if c.Name == "user_session" && c.SameSite == "Lax" && c.Expires != nil {
			foundLax = true
		}
		if c.Name == "gist_pref" && c.SameSite == "None" && c.Expires == nil {
			foundNone = true
		}
	}
	if !foundLax || !foundNone {
		t.Fatalf("unexpected playwright conversion: %+v", pw)
	}
}
