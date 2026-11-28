package cookies

import (
	"fmt"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/sagan/cloudcookie-mcp/internal/cloudcookie"
)

// DomainPolicy restricts which domains may be queried or exposed.
type DomainPolicy struct {
	Allow []string
	Block []string
}

// NewDomainPolicy normalizes allow and block domain lists.
func NewDomainPolicy(allow, block []string) DomainPolicy {
	return DomainPolicy{
		Allow: normalizeList(allow),
		Block: normalizeList(block),
	}
}

func normalizeList(items []string) []string {
	var out []string
	for _, item := range items {
		norm := NormalizeDomain(item)
		if norm != "" {
			out = append(out, norm)
		}
	}
	return out
}

// IsAllowed checks whether a domain is permitted by the policy.
func (p DomainPolicy) IsAllowed(domain string) bool {
	norm := NormalizeDomain(domain)
	if norm == "" {
		return false
	}
	for _, blocked := range p.Block {
		if domainMatchesPattern(norm, blocked) {
			return false
		}
	}
	if len(p.Allow) == 0 {
		return true
	}
	for _, allowed := range p.Allow {
		if domainMatchesPattern(norm, allowed) {
			return true
		}
	}
	return false
}

func domainMatchesPattern(domain, pattern string) bool {
	return domain == pattern || strings.HasSuffix(domain, "."+pattern)
}

// NormalizeDomain strips leading dots, whitespace, optional port, and lowercases the domain.
func NormalizeDomain(domain string) string {
	d := strings.TrimSpace(strings.ToLower(domain))
	d = strings.TrimLeft(d, ".")
	if idx := strings.IndexByte(d, ':'); idx > 0 {
		// Strip port if not an IPv6 literal
		if !strings.HasPrefix(d, "[") {
			d = d[:idx]
		}
	}
	return d
}

// MatchOptions controls how cookies are matched from a SlotDataPayload.
type MatchOptions struct {
	URL               string
	Domain            string
	IncludeSubdomains bool
	IncludeExpired    bool
	Names             []string
	Now               time.Time
}

// MatchResult contains the matched cookies and resolved target metadata.
type MatchResult struct {
	Target  string
	Cookies []cloudcookie.SerializedCookie
}

// MatchCookies filters cookies from payload according to RFC 6265 (when URL is set)
// or domain matching (when Domain is set), enforcing DomainPolicy.
func MatchCookies(payload *cloudcookie.SlotDataPayload, policy DomainPolicy, opts MatchOptions) (*MatchResult, error) {
	if payload == nil {
		return nil, fmt.Errorf("slot payload is nil")
	}

	now := opts.Now
	if now.IsZero() {
		now = time.Now()
	}
	nowUnix := float64(now.Unix())

	var nameSet map[string]bool
	if len(opts.Names) > 0 {
		nameSet = make(map[string]bool, len(opts.Names))
		for _, n := range opts.Names {
			nameSet[n] = true
		}
	}

	if strings.TrimSpace(opts.URL) != "" {
		parsed, err := url.Parse(strings.TrimSpace(opts.URL))
		if err != nil {
			return nil, fmt.Errorf("invalid url %q: %w", opts.URL, err)
		}
		scheme := strings.ToLower(parsed.Scheme)
		if scheme != "http" && scheme != "https" {
			return nil, fmt.Errorf("url scheme must be http or https, got %q", parsed.Scheme)
		}
		host := NormalizeDomain(parsed.Hostname())
		if host == "" {
			return nil, fmt.Errorf("url %q has no hostname", opts.URL)
		}
		if !policy.IsAllowed(host) {
			return nil, fmt.Errorf("domain %q is blocked by policy", host)
		}

		reqPath := parsed.EscapedPath()
		if reqPath == "" {
			reqPath = "/"
		}

		var matched []cloudcookie.SerializedCookie
		for _, list := range payload.Cookies {
			for _, c := range list {
				if !policy.IsAllowed(c.Domain) {
					continue
				}
				if !domainMatchesURL(c, host) {
					continue
				}
				if !pathMatches(c.Path, reqPath) {
					continue
				}
				if c.Secure && scheme != "https" {
					continue
				}
				if !opts.IncludeExpired && isExpired(c, nowUnix) {
					continue
				}
				if nameSet != nil && !nameSet[c.Name] {
					continue
				}
				matched = append(matched, c)
			}
		}

		sortCookies(matched)
		return &MatchResult{
			Target:  parsed.String(),
			Cookies: matched,
		}, nil
	}

	targetDomain := NormalizeDomain(opts.Domain)
	if targetDomain == "" {
		return nil, fmt.Errorf("either url or domain is required")
	}
	if !policy.IsAllowed(targetDomain) {
		return nil, fmt.Errorf("domain %q is blocked by policy", targetDomain)
	}

	var matched []cloudcookie.SerializedCookie
	for _, list := range payload.Cookies {
		for _, c := range list {
			if !policy.IsAllowed(c.Domain) {
				continue
			}
			cDomain := NormalizeDomain(c.Domain)
			if cDomain == "" {
				continue
			}
			matches := cDomain == targetDomain ||
				(!c.HostOnly && strings.HasSuffix(targetDomain, "."+cDomain)) ||
				(opts.IncludeSubdomains && strings.HasSuffix(cDomain, "."+targetDomain))
			if !matches {
				continue
			}
			if !opts.IncludeExpired && isExpired(c, nowUnix) {
				continue
			}
			if nameSet != nil && !nameSet[c.Name] {
				continue
			}
			matched = append(matched, c)
		}
	}

	sortCookies(matched)
	return &MatchResult{
		Target:  targetDomain,
		Cookies: matched,
	}, nil
}

// DomainCount represents a domain and its cookie count.
type DomainCount struct {
	Domain      string `json:"domain"`
	CookieCount int    `json:"cookie_count"`
}

// ListDomains returns sorted domain counts from payload, filtered by policy and optional query.
func ListDomains(payload *cloudcookie.SlotDataPayload, policy DomainPolicy, query string) []DomainCount {
	if payload == nil {
		return nil
	}
	q := strings.ToLower(strings.TrimSpace(query))
	var out []DomainCount
	for domain, list := range payload.Cookies {
		norm := NormalizeDomain(domain)
		if norm == "" || !policy.IsAllowed(norm) {
			continue
		}
		if q != "" && !strings.Contains(norm, q) {
			continue
		}
		if len(list) == 0 {
			continue
		}
		out = append(out, DomainCount{
			Domain:      norm,
			CookieCount: len(list),
		})
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].Domain < out[j].Domain
	})
	return out
}

func domainMatchesURL(c cloudcookie.SerializedCookie, host string) bool {
	cDomain := NormalizeDomain(c.Domain)
	if cDomain == "" {
		return false
	}
	if c.HostOnly {
		return host == cDomain
	}
	return host == cDomain || strings.HasSuffix(host, "."+cDomain)
}

func pathMatches(cookiePath, reqPath string) bool {
	if cookiePath == "" {
		cookiePath = "/"
	}
	if reqPath == cookiePath {
		return true
	}
	if strings.HasPrefix(reqPath, cookiePath) {
		if strings.HasSuffix(cookiePath, "/") {
			return true
		}
		return len(reqPath) > len(cookiePath) && reqPath[len(cookiePath)] == '/'
	}
	return false
}

func isExpired(c cloudcookie.SerializedCookie, nowUnix float64) bool {
	if c.ExpirationDate == nil {
		return false
	}
	return *c.ExpirationDate > 0 && *c.ExpirationDate <= nowUnix
}

func sortCookies(list []cloudcookie.SerializedCookie) {
	sort.SliceStable(list, func(i, j int) bool {
		pi := len(list[i].Path)
		pj := len(list[j].Path)
		if pi != pj {
			return pi > pj
		}
		if list[i].HostOnly != list[j].HostOnly {
			return list[i].HostOnly
		}
		if list[i].Name != list[j].Name {
			return list[i].Name < list[j].Name
		}
		return list[i].Domain < list[j].Domain
	})
}
