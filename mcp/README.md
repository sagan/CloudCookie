# CloudCookie MCP Server (`cloudcookie-mcp`)

`cloudcookie-mcp` is a standalone, zero-dependency Go binary that acts as a **CloudCookie Protocol v1** read-only client and exposes an **MCP (Model Context Protocol)** server over `stdio`. It lets AI agents fetch decrypted browser cookies for any website on demand so they can authenticate `curl` requests, Firecrawl scrapes, or headless browsers (Playwright / Puppeteer / CDP) using the user's real session cookies.

## Features

- **Zero-Knowledge Client**: Derives the Ed25519 auth keypair (`client_id`) and XAES-256-GCM content encryption key locally from `e2e_key` (`K_root`) via HKDF-SHA256. Never sends `e2e_key` to the server.
- **Clock-Skew Resilient**: Automatically detects `timestamp_expired` (`server_time`) and adjusts its clock offset.
- **In-Memory TTL Cache**: Caches decrypted Slot `0` and Slot `1+` payloads in memory (default `30s`, bypassable per call with `refresh: true`).
- **RFC 6265 Cookie Matching**: When given a `url`, filters by domain (`hostOnly` vs domain cookies), path prefix, `Secure` flag (`https` vs `http`), and expiration.
- **Agent-Ready Formats**:
  - `header`: `name1=val1; name2=val2` for `curl -H "Cookie: ..."` and Firecrawl `headers.Cookie`
  - `playwright`: Playwright / CDP-compatible cookie objects (`sameSite` mapped to `Strict` / `Lax` / `None`, `expires` Unix timestamp)
  - `netscape`: Netscape HTTP Cookie File (`cookies.txt`) for `curl -b`
  - `json`: Raw CloudCookie `SerializedCookie[]`
- **Domain Access Policy**: Optional `--allow-domains` and `--block-domains` guardrails to restrict which domains an AI agent can read.

---

## Build

Requires Go 1.24+:

```bash
cd mcp
go build -o cloudcookie-mcp .
```

Run tests:

```bash
cd mcp
go test -v ./...
```

---

## Configuration

All options can be passed via CLI flags or environment variables:

| CLI Flag                  | Environment Variable                    | Default          | Description                                                                        |
| ------------------------- | --------------------------------------- | ---------------- | ---------------------------------------------------------------------------------- |
| `--server-url`            | `CLOUDCOOKIE_SERVER_URL`                | _(required)_     | CloudCookie server origin (e.g. `https://cloudcookie.sagan.me`)                    |
| `--e2e-key`               | `CLOUDCOOKIE_E2E_KEY`                   | _(required)_     | 64-character hex 256-bit root key (`K_root`)                                       |
| `--slot`                  | `CLOUDCOOKIE_SLOT`                      | `0` (auto)       | Default slot ID (`>= 1`). `0` auto-selects the most recently updated active slot   |
| `--cache-ttl`             | `CLOUDCOOKIE_CACHE_TTL`                 | `30s`            | In-memory cache TTL for decrypted slot payloads (`0` disables)                     |
| `--allow-domains`         | `CLOUDCOOKIE_ALLOW_DOMAINS`             | _(all)_          | Comma-separated allowlist (matches domain and its subdomains)                      |
| `--block-domains`         | `CLOUDCOOKIE_BLOCK_DOMAINS`             | _(none)_         | Comma-separated blocklist (takes precedence over allowlist)                        |
| `--transport`             | `CLOUDCOOKIE_MCP_TRANSPORT`             | `stdio`          | Transport mode: `stdio` or `http`                                                  |
| `--listen`                | `CLOUDCOOKIE_MCP_LISTEN`                | `127.0.0.1:6777` | Listen address when `--transport=http`                                             |
| `--mcp-path`              | `CLOUDCOOKIE_MCP_PATH`                  | `/mcp`           | HTTP path for the MCP Streamable HTTP endpoint                                     |
| `--public-url`            | `CLOUDCOOKIE_MCP_PUBLIC_URL`            | _(auto)_         | Public origin (e.g. `https://mcp.example.com`) for OAuth metadata                  |
| `--bearer-token`          | `CLOUDCOOKIE_MCP_BEARER_TOKEN`          | —                | Comma-separated static Bearer token(s) for HTTP auth                               |
| `--allow-unauthenticated` | `CLOUDCOOKIE_MCP_ALLOW_UNAUTHENTICATED` | `false`          | Allow unauthenticated HTTP access (not recommended)                                |
| `--oauth`                 | `CLOUDCOOKIE_MCP_OAUTH`                 | `false`          | Enable built-in OAuth 2.1 Authorization Server (PKCE + DCR + `client_credentials`) |
| `--oauth-secret`          | `CLOUDCOOKIE_MCP_OAUTH_SECRET`          | —                | Passphrase for built-in `/oauth/authorize` consent page                            |
| `--oauth-client-id`       | `CLOUDCOOKIE_MCP_OAUTH_CLIENT_ID`       | —                | Pre-configured `client_id` for `client_credentials` grant                          |
| `--oauth-client-secret`   | `CLOUDCOOKIE_MCP_OAUTH_CLIENT_SECRET`   | —                | Pre-configured `client_secret` for `client_credentials` grant                      |
| `--oauth-issuer`          | `CLOUDCOOKIE_MCP_OAUTH_ISSUER`          | —                | External OAuth/OIDC issuer URL                                                     |
| `--oauth-jwks-url`        | `CLOUDCOOKIE_MCP_OAUTH_JWKS_URL`        | —                | External OAuth/OIDC JWKS URL (RS256/ES256 JWT validation)                          |
| `--oauth-audience`        | `CLOUDCOOKIE_MCP_OAUTH_AUDIENCE`        | —                | Expected JWT `aud` claim for external OAuth                                        |
| `--oauth-scope`           | `CLOUDCOOKIE_MCP_OAUTH_SCOPE`           | —                | Required JWT `scope` claim for external OAuth                                      |
| `--print-client-id`       | —                                       | `false`          | Print the derived 64-char hex `client_id` and exit                                 |
| `--version`               | —                                       | `false`          | Print version and exit                                                             |

### HTTP + Auth Examples (Behind Reverse Proxy)

**1. Static Bearer Token:**

```bash
./cloudcookie-mcp \
  --server-url https://cloudcookie.sagan.me \
  --e2e-key <64-char-hex-root-key> \
  --transport http \
  --listen 0.0.0.0:6777 \
  --bearer-token "my-secret-mcp-token"
```

**2. Built-in OAuth 2.1 Server (PKCE + Dynamic Client Registration for Claude / Cursor / MCP clients):**

```bash
./cloudcookie-mcp \
  --server-url https://cloudcookie.sagan.me \
  --e2e-key <64-char-hex-root-key> \
  --transport http \
  --listen 0.0.0.0:6777 \
  --public-url https://mcp.example.com \
  --oauth \
  --oauth-secret "my-consent-passphrase"
```

**3. External OAuth / OIDC Provider (JWKS):**

```bash
./cloudcookie-mcp \
  --server-url https://cloudcookie.sagan.me \
  --e2e-key <64-char-hex-root-key> \
  --transport http \
  --listen 0.0.0.0:6777 \
  --public-url https://mcp.example.com \
  --oauth-issuer https://auth.example.com \
  --oauth-jwks-url https://auth.example.com/.well-known/jwks.json \
  --oauth-audience https://mcp.example.com/mcp
```

### MCP Client Configuration Example

```json
{
  "mcpServers": {
    "cloudcookie": {
      "command": "/path/to/cloudcookie-mcp",
      "env": {
        "CLOUDCOOKIE_SERVER_URL": "https://cloudcookie.sagan.me",
        "CLOUDCOOKIE_E2E_KEY": "your-64-char-hex-root-key",
        "CLOUDCOOKIE_BLOCK_DOMAINS": "chase.com,paypal.com"
      }
    }
  }
}
```

---

## MCP Protocol Specification

- **Transports**:
  - `stdio`: Newline-delimited JSON-RPC 2.0 on `stdin` / `stdout` (diagnostic logs to `stderr`).
  - `http`: MCP Streamable HTTP (`2025-03-26`) at `--mcp-path` (`POST` JSON-RPC + `Mcp-Session-Id`, `GET` SSE keepalive, `DELETE` session cleanup, `GET /health`), intended to run behind a TLS-terminating reverse proxy.
- **HTTP Authentication**:
  - **Static Bearer Token**: `--bearer-token` checked in constant time.
  - **Built-in OAuth 2.1**: Serves RFC 9728 `/.well-known/oauth-protected-resource`, RFC 8414 `/.well-known/oauth-authorization-server`, RFC 7591 `POST /oauth/register`, PKCE S256 `/oauth/authorize`, and `/oauth/token` (`authorization_code`, `refresh_token`, `client_credentials`).
  - **External OAuth/OIDC**: Validates `RS256` / `ES256` JWTs against `--oauth-jwks-url` with `iss`, `aud`, `exp`, `nbf`, and `scope` checks.
- **Protocol Versions**: `2024-11-05` and `2025-03-26`.
- **Capabilities**: `tools` (`listChanged: false`), `resources` (`subscribe: false`, `listChanged: false`).

### Tools

#### 1. `list_slots`

Lists active browser cookie slots from encrypted Slot `0` metadata (falling back to server `list` if Slot `0` is absent).

- **Arguments**:
  - `refresh` (`boolean`, optional): Bypass cache and fetch fresh metadata.
- **Returns**: `{ slot_count, slots: [{ slot, name, created_at, updated_at, version, size_bytes }] }`.

#### 2. `list_domains`

Lists all domains that have stored cookies in a slot, along with cookie counts.

- **Arguments**:
  - `slot` (`integer`, optional, `>= 1`): Slot ID. Uses default or auto-discovered slot if omitted.
  - `query` (`string`, optional): Case-insensitive substring filter for domain names.
  - `refresh` (`boolean`, optional): Bypass cache.
- **Returns**: `{ slot, instance_name, version, domain_count, domains: [{ domain, cookie_count }] }`.

#### 3. `get_cookies`

Retrieves decrypted cookies for a target `url` or `domain`.

- **Arguments**:
  - `url` (`string`, optional): Target HTTP/HTTPS URL (e.g. `https://github.com/settings`). Applies RFC 6265 domain, path, `Secure`, and expiration matching. Either `url` or `domain` is required.
  - `domain` (`string`, optional): Target domain (e.g. `github.com`). Either `url` or `domain` is required.
  - `format` (`string`, optional, default `"header"`): One of `"header"`, `"json"`, `"playwright"`, `"netscape"`, `"all"`.
  - `slot` (`integer`, optional, `>= 1`): Slot ID.
  - `include_subdomains` (`boolean`, optional, default `true`): Include subdomain cookies when querying by `domain` (ignored when `url` is used).
  - `include_expired` (`boolean`, optional, default `false`): Include expired cookies.
  - `names` (`string[]`, optional): Filter to specific cookie names.
  - `refresh` (`boolean`, optional, default `false`): Bypass cache.
- **Returns**: `{ slot, instance_name, version, target, format, matched_count, ... }` plus the requested format field(s) (`cookie_header`, `cookies`, `netscape`, `playwright`).

### Resources

- `cloudcookie://slots` (`application/json`): Active CloudCookie slots.
- `cloudcookie://domains` (`application/json`): Domains and cookie counts in the default slot.
