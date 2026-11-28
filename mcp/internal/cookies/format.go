package cookies

import (
	"fmt"
	"math"
	"strings"

	"github.com/sagan/cloudcookie-mcp/internal/cloudcookie"
)

// PlaywrightCookie is compatible with Playwright's BrowserContext.AddCookies and CDP Network.setCookies.
type PlaywrightCookie struct {
	Name     string   `json:"name"`
	Value    string   `json:"value"`
	Domain   string   `json:"domain"`
	Path     string   `json:"path"`
	Expires  *float64 `json:"expires,omitempty"`
	HTTPOnly bool     `json:"httpOnly"`
	Secure   bool     `json:"secure"`
	SameSite string   `json:"sameSite,omitempty"`
}

// FormatHeader formats cookies as an HTTP Cookie header value ("name1=val1; name2=val2").
func FormatHeader(list []cloudcookie.SerializedCookie) string {
	if len(list) == 0 {
		return ""
	}
	parts := make([]string, 0, len(list))
	for _, c := range list {
		parts = append(parts, c.Name+"="+c.Value)
	}
	return strings.Join(parts, "; ")
}

// FormatNetscape formats cookies in the Netscape HTTP Cookie File format (for curl -b).
func FormatNetscape(list []cloudcookie.SerializedCookie) string {
	var b strings.Builder
	b.WriteString("# Netscape HTTP Cookie File\n")
	b.WriteString("# https://curl.haxx.se/rfc/cookie_spec.html\n")
	b.WriteString("# This is a generated file! Do not edit.\n")
	for _, c := range list {
		domain := c.Domain
		if !c.HostOnly && !strings.HasPrefix(domain, ".") {
			domain = "." + domain
		}
		includeSubdomains := "FALSE"
		if strings.HasPrefix(domain, ".") {
			includeSubdomains = "TRUE"
		}
		path := c.Path
		if path == "" {
			path = "/"
		}
		secure := "FALSE"
		if c.Secure {
			secure = "TRUE"
		}
		expiration := "0"
		if c.ExpirationDate != nil && !math.IsNaN(*c.ExpirationDate) && !math.IsInf(*c.ExpirationDate, 0) {
			expiration = fmt.Sprintf("%d", int64(math.Round(*c.ExpirationDate)))
		}
		fmt.Fprintf(&b, "%s\t%s\t%s\t%s\t%s\t%s\t%s\n",
			domain, includeSubdomains, path, secure, expiration, c.Name, c.Value)
	}
	return strings.TrimSuffix(b.String(), "\n")
}

// FormatPlaywright converts SerializedCookie entries to Playwright/CDP cookie objects.
func FormatPlaywright(list []cloudcookie.SerializedCookie) []PlaywrightCookie {
	out := make([]PlaywrightCookie, 0, len(list))
	for _, c := range list {
		path := c.Path
		if path == "" {
			path = "/"
		}
		var expires *float64
		if !c.Session && c.ExpirationDate != nil && *c.ExpirationDate > 0 {
			v := *c.ExpirationDate
			expires = &v
		}
		out = append(out, PlaywrightCookie{
			Name:     c.Name,
			Value:    c.Value,
			Domain:   c.Domain,
			Path:     path,
			Expires:  expires,
			HTTPOnly: c.HTTPOnly,
			Secure:   c.Secure,
			SameSite: mapSameSite(c.SameSite),
		})
	}
	return out
}

func mapSameSite(s string) string {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "strict":
		return "Strict"
	case "lax":
		return "Lax"
	case "no_restriction", "none":
		return "None"
	default:
		return ""
	}
}
