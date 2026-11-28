package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/sagan/cloudcookie-mcp/internal/auth"
	"github.com/sagan/cloudcookie-mcp/internal/cloudcookie"
	"github.com/sagan/cloudcookie-mcp/internal/cookies"
	"github.com/sagan/cloudcookie-mcp/internal/mcp"
)

const version = "0.1.0"

func main() {
	var (
		serverURL    = flag.String("server-url", envOrDefault("CLOUDCOOKIE_SERVER_URL", ""), "CloudCookie server URL (origin, e.g. https://cloudcookie.sagan.me)")
		e2eKey       = flag.String("e2e-key", envOrDefault("CLOUDCOOKIE_E2E_KEY", ""), "64-char hex CloudCookie root key (K_root)")
		slotFlag     = flag.Uint("slot", envUint("CLOUDCOOKIE_SLOT", 0), "Default slot ID (>= 1; 0 = auto-discover)")
		cacheTTL     = flag.Duration("cache-ttl", envDuration("CLOUDCOOKIE_CACHE_TTL", 30*time.Second), "In-memory cache TTL for decrypted slot payloads")
		allowDomains = flag.String("allow-domains", envOrDefault("CLOUDCOOKIE_ALLOW_DOMAINS", ""), "Comma-separated list of allowed domains (empty = allow all)")
		blockDomains = flag.String("block-domains", envOrDefault("CLOUDCOOKIE_BLOCK_DOMAINS", ""), "Comma-separated list of blocked domains")

		transport = flag.String("transport", envOrDefault("CLOUDCOOKIE_MCP_TRANSPORT", "stdio"), "MCP transport: stdio or http")
		listen    = flag.String("listen", envOrDefault("CLOUDCOOKIE_MCP_LISTEN", "127.0.0.1:6777"), "HTTP listen address (when --transport=http)")
		mcpPath   = flag.String("mcp-path", envOrDefault("CLOUDCOOKIE_MCP_PATH", "/mcp"), "HTTP path for the MCP endpoint")
		publicURL = flag.String("public-url", envOrDefault("CLOUDCOOKIE_MCP_PUBLIC_URL", ""), "Public base URL for OAuth metadata (e.g. https://mcp.example.com)")

		bearerToken          = flag.String("bearer-token", envOrDefault("CLOUDCOOKIE_MCP_BEARER_TOKEN", ""), "Comma-separated static Bearer token(s) for HTTP auth")
		allowUnauthenticated = flag.Bool("allow-unauthenticated", envBool("CLOUDCOOKIE_MCP_ALLOW_UNAUTHENTICATED", false), "Allow unauthenticated HTTP access (not recommended)")
		oauthEnabled         = flag.Bool("oauth", envBool("CLOUDCOOKIE_MCP_OAUTH", false), "Enable built-in OAuth 2.1 Authorization Server (PKCE + DCR + client_credentials)")
		oauthSecret          = flag.String("oauth-secret", envOrDefault("CLOUDCOOKIE_MCP_OAUTH_SECRET", ""), "Passphrase for built-in OAuth /oauth/authorize consent page")
		oauthClientID        = flag.String("oauth-client-id", envOrDefault("CLOUDCOOKIE_MCP_OAUTH_CLIENT_ID", ""), "Pre-configured client_id for OAuth client_credentials grant")
		oauthClientSecret    = flag.String("oauth-client-secret", envOrDefault("CLOUDCOOKIE_MCP_OAUTH_CLIENT_SECRET", ""), "Pre-configured client_secret for OAuth client_credentials grant")
		oauthIssuer          = flag.String("oauth-issuer", envOrDefault("CLOUDCOOKIE_MCP_OAUTH_ISSUER", ""), "External OAuth/OIDC issuer URL")
		oauthJWKSURL         = flag.String("oauth-jwks-url", envOrDefault("CLOUDCOOKIE_MCP_OAUTH_JWKS_URL", ""), "External OAuth/OIDC JWKS URL (enables external JWT validation)")
		oauthAudience        = flag.String("oauth-audience", envOrDefault("CLOUDCOOKIE_MCP_OAUTH_AUDIENCE", ""), "Expected JWT audience (aud) for external OAuth")
		oauthScope           = flag.String("oauth-scope", envOrDefault("CLOUDCOOKIE_MCP_OAUTH_SCOPE", ""), "Required JWT scope for external OAuth")

		showClientID = flag.Bool("print-client-id", false, "Print the derived client_id for the configured e2e-key and exit")
		showVersion  = flag.Bool("version", false, "Print version and exit")
	)
	flag.Parse()

	if *showVersion {
		fmt.Printf("cloudcookie-mcp %s\n", version)
		return
	}

	logger := log.New(os.Stderr, "[cloudcookie-mcp] ", log.LstdFlags)

	if *showClientID {
		rk, err := cloudcookie.ParseRootKey(*e2eKey)
		if err != nil {
			logger.Fatalf("invalid e2e-key: %v", err)
		}
		keys, err := cloudcookie.DeriveKeys(rk)
		if err != nil {
			logger.Fatalf("derive keys: %v", err)
		}
		fmt.Println(keys.ClientID)
		return
	}

	client, err := cloudcookie.NewClient(cloudcookie.Config{
		ServerURL:   *serverURL,
		E2EKey:      *e2eKey,
		DefaultSlot: uint32(*slotFlag),
		CacheTTL:    *cacheTTL,
	})
	if err != nil {
		logger.Fatalf("configuration error: %v", err)
	}

	policy := cookies.NewDomainPolicy(splitCSV(*allowDomains), splitCSV(*blockDomains))
	srv := mcp.NewServer(client, policy, version, logger)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	switch strings.ToLower(strings.TrimSpace(*transport)) {
	case "stdio":
		logger.Printf("starting cloudcookie-mcp %s (transport=stdio, server=%s, client_id=%s, default_slot=%d, cache_ttl=%s)",
			version, client.ServerURL(), client.ClientID(), client.DefaultSlot(), *cacheTTL)
		if err := srv.ServeStdio(ctx, os.Stdin, os.Stdout); err != nil && ctx.Err() == nil {
			logger.Fatalf("stdio server error: %v", err)
		}

	case "http":
		normalizedPath := "/" + strings.TrimLeft(strings.TrimSpace(*mcpPath), "/")
		authenticator, err := auth.NewAuthenticator(auth.AuthConfig{
			BearerTokens:         splitCSV(*bearerToken),
			AllowUnauthenticated: *allowUnauthenticated,
			OAuthEnabled:         *oauthEnabled,
			OAuthSecret:          *oauthSecret,
			OAuthClientID:        *oauthClientID,
			OAuthClientSecret:    *oauthClientSecret,
			ExternalIssuer:       *oauthIssuer,
			ExternalJWKSURL:      *oauthJWKSURL,
			ExternalAudience:     *oauthAudience,
			RequiredScope:        *oauthScope,
			PublicURL:            *publicURL,
			MCPPath:              normalizedPath,
		})
		if err != nil {
			logger.Fatalf("auth configuration error: %v", err)
		}

		mux := http.NewServeMux()
		mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"status":"ok"}`))
		})
		authenticator.RegisterRoutes(mux)
		mux.Handle(normalizedPath, authenticator.Middleware(mcp.NewHTTPHandler(srv)))

		httpSrv := &http.Server{
			Addr:              *listen,
			Handler:           mux,
			ReadHeaderTimeout: 10 * time.Second,
		}

		go func() {
			<-ctx.Done()
			shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = httpSrv.Shutdown(shutdownCtx)
		}()

		logger.Printf("starting cloudcookie-mcp %s (transport=http, listen=%s%s, server=%s, client_id=%s, oauth=%v)",
			version, *listen, normalizedPath, client.ServerURL(), client.ClientID(), authenticator.OAuthEnabled())

		if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Fatalf("http server error: %v", err)
		}

	default:
		logger.Fatalf("unsupported transport %q (expected 'stdio' or 'http')", *transport)
	}
}

func envOrDefault(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func envUint(key string, def uint) uint {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		if n, err := strconv.ParseUint(v, 10, 32); err == nil {
			return uint(n)
		}
	}
	return def
}

func envBool(key string, def bool) bool {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		if b, err := strconv.ParseBool(v); err == nil {
			return b
		}
	}
	return def
}

func envDuration(key string, def time.Duration) time.Duration {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return def
}

func splitCSV(s string) []string {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if t := strings.TrimSpace(p); t != "" {
			out = append(out, t)
		}
	}
	return out
}
