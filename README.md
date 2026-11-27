# CloudCookie

CloudCookie is an end-to-end encrypted, multi-slot self-hosting browser cookie synchronization system inspired by [CookieCloud][]. It consists of a zero-knowledge Rust server and a cross-browser extension (Chrome MV3 & Firefox) built with WXT, React, and TypeScript.

## Features

- **Zero-Knowledge End-to-End Encryption**: The server never receives the root key (`e2e_key`) or encryption keys, and never performs server-side decryption.
- **Minimal Client Configuration**: Only two fields are required to connect a browser—`server_url` (origin only) and a 256-bit `e2e_key` generated via CSPRNG.
- **Modern Fixed Cryptography** ([PROTOCOL.md](PROTOCOL.md)):
  - **Key Derivation**: HKDF-SHA256 (`RFC 5869`) with domain separation for authentication (`client-auth-ed25519`) and encryption (`e2e-xaes256gcm`).
  - **AEAD**: XAES-256-GCM (192-bit random nonce, 128-bit GCM tag) with AAD bound to `client_id`, `slot`, and `version`.
  - **Request Authentication**: Stateless Ed25519 signatures over `(action, client_id, slot, expected_version, timestamp, nonce, payload_sha256_hex)` with configurable timestamp freshness and optional nonce replay caching.
  - **Optimistic Concurrency Control**: Mandatory `expected_version` (CAS) on `update` requests.
- **Multi-Slot Storage**: Each client can manage multiple independent 0-based slots (e.g., Slot `0` for encrypted slot metadata/index, Slots `1+` for individual browser profiles/instances).
- **Flexible Client Authorization**: Supports **Private** (default, pre-authorized clients only), **Approval** (pending admin approval), and **Public** (auto-approve) modes, plus a built-in Admin Web UI (`/admin.html`) and REST API (`/admin/*`).

## Project Structure

- [`server/`](server/) — Rust sync server (`cloudcookie-server`) built with Axum, Tokio, `ring`, and `aes-gcm`.
- [`ext/`](ext/) — Browser extension (`cloudcookie-ext`) built with WXT, React, Tailwind CSS, and `@noble/*` cryptography libraries.
- [`PROTOCOL.md`](PROTOCOL.md) — CloudCookie Protocol v1 specification, HTTP API, security model, and reference test vectors.
- [`ext/SCHEMA.md`](ext/SCHEMA.md) — Browser storage layout and encrypted Slot `0` / Slot `1+` JSON schemas.
- [`LICENSE`](LICENSE) — MIT License.

---

## Quick Start

### Official Demo Server

An official public-mode instance is available at **<https://cloudcookie.sagan.me/>** (also selectable directly from the browser extension's server dropdown):

- **Public Mode**: Anyone can connect and use it without prior registration or admin approval.
- **Demo / Evaluation / Test Only**: This server is provided strictly for demonstration, evaluation, and testing purposes. Stored data may be deleted or flushed at any time without prior notice.
- For production or persistent cookie synchronization, self-host your own `cloudcookie-server` instance.

### 1. Run the Server

Requires a Rust toolchain (`cargo`).

```bash
cd server
cargo build --release
```

Run in **Private** mode (default—clients must be pre-authorized via `/admin/*`):

```bash
CLOUDCOOKIE_ADMIN_TOKEN="your-secret-admin-token" \
./target/release/cloudcookie-server
```

Or run in **Approval** mode (unknown clients are queued as pending for admin approval) or **Public** mode (auto-approve new clients):

```bash
# Approval mode
./target/release/cloudcookie-server --auto-register-pending

# Public mode
./target/release/cloudcookie-server --public-mode
```

Data is stored in `/var/lib/cloudcookie` by default, which can be changed by `--data-dir` flag or `CLOUDCOOKIE_DATA_DIR` env.

If `CLOUDCOOKIE_ADMIN_TOKEN` / `--admin-token` is omitted, an ephemeral random token is generated and logged on startup.

Once running:
- **Sync endpoint**: `POST /`
- **Health check**: `GET /health`
- **Admin Web UI**: `GET /admin.html` (authenticate with your admin bearer token)

> **Production Note**: Deploy behind a TLS-terminating reverse proxy (HTTPS) so metadata and signed requests within `auth_window_secs` are protected in transit.

### 2. Build & Load the Browser Extension

Requires Node.js and npm.

```bash
cd ext
npm install
npm run build
```

- For Firefox: `npm run build:firefox`
- For development with hot reload: `npm run dev` (or `npm run dev:firefox`)

To load in Chrome/Chromium:
1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select `ext/dist/chrome-mv3`.
3. Open the CloudCookie popup, select the official demo server (`https://cloudcookie.sagan.me`) or enter your own `server_url` (e.g., `https://cookie.example.com`), and generate or paste your 64-character hex `e2e_key`.

---

## Server Configuration

All options can be passed as CLI flags or environment variables:

| CLI Flag | Environment Variable | Default | Description |
| --- | --- | --- | --- |
| `--listen` | `CLOUDCOOKIE_LISTEN` | `0.0.0.0:6767` | Address and port to listen on |
| `--data-dir` | `CLOUDCOOKIE_DATA_DIR` | `/var/lib/cloudcookie` | Directory for client registry and encrypted blobs |
| `--admin-token` | `CLOUDCOOKIE_ADMIN_TOKEN` | *(random)* | Bearer token for `/admin/*` endpoints |
| `--private-mode` | `CLOUDCOOKIE_PRIVATE_MODE` | `false` | Private mode (default when neither public nor auto-register is set) |
| `--auto-register-pending` | `CLOUDCOOKIE_AUTO_REGISTER_PENDING` | `false` | Record unknown `client_id`s as pending admin approval |
| `--public-mode` | `CLOUDCOOKIE_PUBLIC_MODE` | `false` | Automatically approve new `client_id`s |
| `--max-pending` | `CLOUDCOOKIE_MAX_PENDING` | `1000` | Maximum pending client registrations |
| `--max-slot` | `CLOUDCOOKIE_MAX_SLOT` | `1023` | Maximum 0-based slot index allowed per client |
| `--max-slots-per-client` | `CLOUDCOOKIE_MAX_SLOTS_PER_CLIENT` | *(unlimited)* | Maximum number of stored slots per client |
| `--max-client-storage-bytes` | `CLOUDCOOKIE_MAX_CLIENT_STORAGE_BYTES` | *(unlimited)* | Maximum total encrypted storage bytes per client |
| `--auth-window-secs` | `CLOUDCOOKIE_AUTH_WINDOW_SECS` | `300` | Allowed clock skew / request auth window in seconds |
| `--enable-nonce-cache` | `CLOUDCOOKIE_ENABLE_NONCE_CACHE` | `false` | Enable in-memory `(client_id, nonce)` replay cache |
| `--max-body-bytes` | `CLOUDCOOKIE_MAX_BODY_BYTES` | `16777216` | Maximum HTTP request body size in bytes (16 MiB) |
| `--rate-limit-per-min` | `CLOUDCOOKIE_RATE_LIMIT_PER_MIN` | `120` | Maximum requests per minute per IP (`0` disables) |

---

## Development & Testing

### Server Tests

```bash
cd server
cargo test
```

### Extension Type-Check & Tests

```bash
cd ext
npm run compile
npm test
```

---

## License

This project is licensed under the [MIT License](LICENSE).

[CookieCloud]: https://github.com/easychen/CookieCloud
