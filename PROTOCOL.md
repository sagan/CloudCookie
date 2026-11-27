# CloudCookie Protocol v1

CloudCookie is an enhanced, end-to-end encrypted cookie synchronization protocol inspired by CookieCloud.

## Design Goals vs. Original CookieCloud

1. **Minimal Client Configuration (2 fields only)**:
   - `server_url`: Origin only (e.g., `https://cookie.sagan.me`), no path component.
   - `e2e_key`: 256-bit (32-byte) root key generated automatically via CSPRNG by the browser extension.
2. **Modern Fixed Cryptography**:
   - No user-selectable or legacy algorithms (removes MD5, AES-128-CBC, fixed zero-IV, and CryptoJS-salted formats).
   - **Key Derivation**: HKDF-SHA256 (RFC 5869) with explicit domain separation.
   - **AEAD**: XAES-256-GCM (C2SP spec: 256-bit key, 192-bit random nonce, 128-bit GCM tag).
   - **Stateless Anti-Replay Request Auth**:
     - Ed25519 signatures over `(action, client_id, slot, expected_version, timestamp, nonce, payload_sha256_hex)`.
     - All actions (`get`, `update`, `delete`) enforce `timestamp` freshness within `auth_window_secs` (default `300` seconds) and an optional in-memory `(client_id, nonce)` deduplication cache (disabled by default).
     - `update` actions additionally enforce mandatory `expected_version` (optimistic concurrency control / CAS).
   - **Zero-Knowledge of Content & Keys**: The server never receives `e2e_key` or the encryption key, and never performs server-side decryption. (See *Security Model & Trade-offs* for metadata visibility.)
3. **Multi-Slot Storage & Quotas**:
   - Each client can store, fetch, and delete multiple independent 0-based integer `slot`s (e.g., slot `0` for metadata/index of used slots, slots `1+` for individual browser profiles/instances; slot `0` is a client convention, not server-enforced).
   - Optional per-client `max_slots_per_client` and `max_client_storage_bytes` quotas (both unlimited by default).
4. **Single POST Sync Endpoint**:
   - All client sync operations (`get`, `update`, `delete`, `list`) go through `POST /`.
5. **Admin Client Authorization**:
   - Client identifiers (`client_id`) must be authorized by an administrator in a separate `/admin/*` flow before the server accepts or serves encrypted data.

---

## Cryptography Specification

### 1. Root Key (`K_root`)
- 32 bytes (256 bits) generated via CSPRNG (`crypto.getRandomValues` in browser, `ring::rand::SystemRandom` in Rust).
- **Encoding**: 64 lowercase hexadecimal characters (or 32 raw bytes).

### 2. Key Derivation (HKDF-SHA256)
Salt: UTF-8 bytes of `"cloudcookie-v1"` (14 bytes).

- **Client Authentication Keypair (`sk_auth`, `pk_auth`) & `client_id`**:
  - `seed = HKDF-SHA256(ikm = K_root, salt = "cloudcookie-v1", info = "client-auth-ed25519", len = 32)`
  - `(sk_auth, pk_auth) = Ed25519_Keypair_From_Seed(seed)`
  - `client_id = lowercase_hex(pk_auth)` (64 lowercase hex characters, 32-byte Ed25519 public key)
- **Content Encryption Key (`K_enc`)**:
  - `K_enc = HKDF-SHA256(ikm = K_root, salt = "cloudcookie-v1", info = "e2e-xaes256gcm", len = 32)` (32 bytes)

Because `seed` and `K_enc` use distinct `info` contexts, `client_id` (`pk_auth`) is cryptographically independent of `K_enc` and reveals zero bits about `K_enc` or `K_root`.

### 3. AEAD Encryption (XAES-256-GCM, 192-bit nonce)
- **Plaintext**: UTF-8 JSON payload.
- **Nonce**: 24 bytes (192 bits) generated freshly per encryption via CSPRNG.
- **Per-nonce key derivation** (C2SP XAES-256-GCM):
  - Split `N` (24B) into `N1 = N[0..12]` and `N2 = N[12..24]`.
  - `L = AES-256-ECB(K_enc, 0x00^16)`; `K1 = CMAC_subkey(L)`.
  - `M1 = [0x00, 0x01, 'X', 0x00] || N1`, `M2 = [0x00, 0x02, 'X', 0x00] || N1`.
  - `Kx = AES-256-ECB(K_enc, M1 ^ K1) || AES-256-ECB(K_enc, M2 ^ K1)`.
  - Encrypt with `AES-256-GCM(Kx, N2, plaintext, AAD)`.
- **AAD (Associated Authenticated Data)**: UTF-8 bytes of:
  ```
  cloudcookie-v1:<client_id>:<slot>:<version>
  ```
  where `<slot>` and `<version>` are canonical non-negative base-10 integers with no leading zeros (`"0"` for zero). On `update`, `<version>` is `expected_version + 1`; on `get`, `<version>` is the `version` returned by the server.
- **Output**: `base64_standard(nonce (24 bytes) || ciphertext || gcm_tag (16 bytes))` (with standard Base64 `=` padding). Minimum decoded length is 40 bytes.

### 4. Stateless Request Authentication
Canonical signing message (UTF-8):
```
cloudcookie-v1:<action>:<client_id>:<slot_or_all>:<expected_version_or_dash>:<timestamp>:<nonce>:<payload_sha256_hex>
```
Where:
- `<action>` is `"get"`, `"update"`, `"delete"`, or `"list"`.
- `<slot_or_all>` is the canonical decimal slot index (e.g. `"0"`, `"1"`), `"all"` when `action == "delete"` and `"slot": "all"`, or `"-"` when `action == "list"`.
- `<expected_version_or_dash>` is the canonical decimal `expected_version` for `"update"`, or `"-"` for `"get"`, `"delete"`, and `"list"`.
- `<timestamp>` is the canonical decimal Unix timestamp in seconds (required for all actions; checked against `|server_now - timestamp| <= auth_window_secs`).
- `<nonce>` is a 32-character lowercase hex string (16 random bytes, required for all actions).
- `<payload_sha256_hex>` is:
  - For `"update"`: `lowercase_hex(SHA256(encrypted_ascii_bytes))` — the SHA-256 of the **exact UTF-8/ASCII Base64 string** of the `encrypted` field as transmitted (including `=` padding), **not** the decoded binary ciphertext.
  - For `"get"`, `"delete"`, and `"list"`: `lowercase_hex(SHA256(b""))` = `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` (the SHA-256 of an empty string).

---

## HTTP API

### Client Sync Endpoint: `POST /`
All `POST /` responses include `Cache-Control: no-store`.

**JSON Integer Range**: `slot`, `version`, and `expected_version` are unsigned integers; for JavaScript/browser interoperability, implementations should keep values within `[0, 2^53 - 1]`.

**Implicit Defaults**:
- If `action` is omitted: defaults to `"update"` when `encrypted` is present, otherwise `"get"`.
- If `slot` is omitted: defaults to `0` for `"get"` and `"update"`; for `"delete"`, `slot` is **required** (either a 0-based integer index to delete a single slot, or `"all"` to delete all stored slots and the client registration).

#### `get` action
```json
{
  "action": "get",
  "client_id": "<64-char hex Ed25519 public key>",
  "slot": 0,
  "timestamp": 1795692095,
  "nonce": "<32-char hex random nonce>",
  "signature": "<128-char hex Ed25519 signature>"
}
```
Response (`200 OK`):
```json
{ "ok": true, "action": "get", "client_id": "...", "slot": 0, "encrypted": "...", "updated_at": "...", "version": 1 }
```

#### `update` action
(`expected_version`, `timestamp`, and `nonce` are mandatory):
```json
{
  "action": "update",
  "client_id": "<64-char hex Ed25519 public key>",
  "slot": 0,
  "expected_version": 0,
  "timestamp": 1795692095,
  "nonce": "<32-char hex random nonce>",
  "encrypted": "<base64(nonce_24B || ciphertext || tag_16B)>",
  "signature": "<128-char hex Ed25519 signature>"
}
```
Response (`200 OK`):
```json
{ "ok": true, "action": "update", "slot": 0, "updated_at": "...", "version": 1 }
```
On version mismatch (`409 Conflict`):
```json
{ "ok": false, "error": "version_conflict", "current_version": 2, "message": "..." }
```

#### `delete` action
(Deletes a specific `slot` index, or deletes all client data + registration when `"slot": "all"`; `slot` is required):
```json
{
  "action": "delete",
  "client_id": "<64-char hex Ed25519 public key>",
  "slot": 1,
  "timestamp": 1795692095,
  "nonce": "<32-char hex random nonce>",
  "signature": "<128-char hex Ed25519 signature>"
}
```
Response (`200 OK`):
- Single slot: `{ "ok": true, "action": "delete", "slot": 1 }`
- All client data (`"slot": "all"`): `{ "ok": true, "action": "delete", "client_id": "...", "deleted_all": true }`

#### `list` action
(Lists metadata for all stored slots of `client_id`; requires `timestamp` and `nonce`):
```json
{
  "action": "list",
  "client_id": "<64-char hex Ed25519 public key>",
  "timestamp": 1795692095,
  "nonce": "<32-char hex random nonce>",
  "signature": "<128-char hex Ed25519 signature>"
}
```
Response (`200 OK`):
```json
{
  "ok": true,
  "action": "list",
  "client_id": "...",
  "slots": [
    { "slot": 0, "version": 1, "updated_at": "...", "size_bytes": 76 },
    { "slot": 1, "version": 3, "updated_at": "...", "size_bytes": 124 }
  ]
}
```
> **Note on `list` trust**: The server-returned `list` is **for convenience only**. Because slot metadata is unauthenticated, a compromised or malicious server can tamper with the returned list (e.g., omit slots, add fake entries, or alter `version`, `updated_at`, and `size_bytes`). Clients **MUST** rely on their own client-side mechanism (such as encrypted metadata in `slot 0`, which cannot be tampered with by the server) to verify slot inventory and data integrity.

#### Error Codes
- `400 Bad Request`: `invalid_client_id`, `missing_slot`, `invalid_slot`, `missing_timestamp`, `missing_nonce`, `invalid_nonce`, `missing_expected_version`, `missing_encrypted`, `unexpected_encrypted`, `invalid_encrypted_payload`, `slot_out_of_range`.
- `401 Unauthorized`: `timestamp_expired` (includes `"server_time": <unix_seconds>` so the client can compute the exact clock offset), `invalid_signature`, `nonce_replayed` (when nonce cache is enabled).
- `403 Forbidden`: `client_pending_approval`, `client_revoked`, `client_unauthorized`, `max_slots_exceeded`.
- `404 Not Found`: `no_data`, `client_not_found`.
- `409 Conflict`: `version_conflict`.
- `413 Payload Too Large`: `storage_quota_exceeded` (or body limit exceeded).
- `429 Too Many Requests`: `rate_limited`, `pending_queue_full`.

### Health Endpoint: `GET /health`
Returns `200 OK` with `{"status": "ok", "timestamp": "..."}`.

### Admin Auth Endpoints: `/admin/*`
All `/admin/*` endpoints require `Authorization: Bearer <ADMIN_TOKEN>`.

- `GET /admin/clients` (optional `?status=pending|approved|revoked`): List client records and their stored slots.
- `POST /admin/clients`: Pre-authorize a client (`{"client_id": "...", "label": "..."}`).
- `POST /admin/clients/{client_id}/approve`: Approve a pending or revoked client (optional `{"label": "..."}`).
- `POST /admin/clients/{client_id}/revoke`: Revoke a client.
- `DELETE /admin/clients/{client_id}`: Delete a client and all its slot data.

---

## Client Verification Requirements
1. **AAD Binding**: Clients **MUST** construct the AEAD AAD using their own locally derived `client_id` and the `slot` they requested—never by blindly trusting `client_id` or `slot` echoed in a server response.
2. **Response Consistency**: Clients **MUST** verify that `client_id`, `slot`, and `action` in any `200 OK` response match the request, and that `version == expected_version + 1` on `update`.
3. **Unauthenticated Metadata**: `updated_at` is server-generated and unauthenticated; clients **MUST NOT** rely on it for security decisions.

---

## Security Model, Trade-offs & Operational Notes
- **Transport Security (TLS)**: The protocol assumes HTTPS (e.g., via a reverse proxy with HSTS) in production. Without TLS, metadata and signed requests within `auth_window_secs` are exposed to network observers.
- **Metadata Visibility**: The server is zero-knowledge with respect to cookie plaintext and `K_root`/`K_enc`, but it observes metadata: `client_id`, slot indices, version numbers, ciphertext sizes, timestamps, client IP addresses, and admin labels.
- **Single Shared `K_root`**: All devices sharing `K_root` share the same `client_id` and signing key. There is no per-device revocation or forward secrecy. Rotating a compromised key requires generating a new `K_root`, authorizing the new `client_id`, re-uploading data, and updating all devices. Losing `K_root` permanently loses access to encrypted data.
- **Revocation vs. Deletion**: Admin `revoke` blocks `get`/`update`/`delete` without deleting stored blobs; re-approving the `client_id` restores access to existing data.
- **Version Relabeling vs. Rollback**: Binding `version` into AAD prevents a compromised server from relabeling a ciphertext with a different version number. It does not prevent a malicious server from serving an older valid `(ciphertext, version)` pair to a stateless client; clients needing rollback protection should persist the highest `version` seen per slot locally.
- **Server Limits**: Default server settings include `max_slot = 1023`, `max_pending = 1000`, `max_body_bytes = 16 MiB`, `rate_limit_per_min = 120`, `auth_window_secs = 300`, `enable_nonce_cache = false`, and unlimited `max_slots_per_client` / `max_client_storage_bytes` (configurable via CLI flags / env vars).

---

## Reference Test Vector

- `K_root` (hex): `000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f`
- `client_id` (hex): `efaa52e7bf7b356fcebcbde5b95fa9aa24d6d91bbe6dac4d06bc5679b1d3e31e`
- `K_enc` (hex): `81d7dd656c9ed75994ce72f06f083e6891271f29c2221dfd844003118e1593b0`
- `slot`: `1`, `version`: `1` (`expected_version`: `0`)
- `AAD`: `cloudcookie-v1:efaa52e7bf7b356fcebcbde5b95fa9aa24d6d91bbe6dac4d06bc5679b1d3e31e:1:1`
- `nonce` (24B ASCII): `ABCDEFGHIJKLMNOPQRSTUVWX` (`4142434445464748494a4b4c4d4e4f505152535455565758`)
- `plaintext` (UTF-8): `{"hello":"cloudcookie"}`
- `encrypted` (Base64): `QUJDREVGR0hJSktMTU5PUFFSU1RVVldYmob7YcRaAVXTjoVMw1qdJkqG5yJ+18HiKUzRt4j2RMkePC2TNAN7`
- `update` auth inputs: `timestamp = 1700000000`, `nonce = 00112233445566778899aabbccddeeff`
- `signature` (hex): `5d1894a3d27d44072e859eef0c31f222bd032ed7576f0c76641c4717981c1facbf3c60ad4e5c36608bf44e8b476dd6e393f9d3d011d063de4d0e38855c86fc00`
