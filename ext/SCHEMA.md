# CloudCookie Extension Slot & Storage Schema

## Browser Storage Separation

- **`browser.storage.sync`** (synced across Chrome profiles signed into the same account):
  - `server_url`: string (origin only, e.g. `https://cookie.example.com`)
  - `root_key`: string (64-char lowercase hex `K_root`)

- **`browser.storage.local`** (strictly local to each browser instance):
  - `using_slot`: `number | null` (the slot index `>= 1` owned by this browser instance)
  - `using_slot_name`: `string | null` (cached display name of the slot)
  - `auto_upload_enabled`: `boolean` (default `true`)
  - `upload_interval_minutes`: `number` (default `5`)
  - `blacklist_domains`: `string[]`
  - `last_upload_hash`, `last_upload_at`, `last_upload_status`, `last_upload_error`, `last_slot_version`, `last_cookie_count`, `last_domain_count`

---

## Slot 0 Schema (Encrypted Meta Slot, `slot = 0`)

Encrypted with XAES-256-GCM (`AAD = cloudcookie-v1:<client_id>:0:<version>`):

```json
{
  "schema_version": 1,
  "updated_at": 1795692095000,
  "slots": {
    "1": {
      "slot": 1,
      "name": "Work MacBook Chrome",
      "created_at": 1795690000000,
      "updated_at": 1795692095000
    },
    "2": {
      "slot": 2,
      "name": "Home Linux Desktop",
      "created_at": 1795691000000,
      "updated_at": 1795691500000
    }
  }
}
```

- Slot 0 is updated using optimistic concurrency control (`expected_version`) when creating, renaming, or deleting a slot, with automatic retry on `409 version_conflict`.
- Routine cookie uploads only update Slot `1+` and do not touch Slot 0.

---

## Slot 1+ Schema (Encrypted Cookie Data Slot, `slot >= 1`)

Encrypted with XAES-256-GCM (`AAD = cloudcookie-v1:<client_id>:<slot>:<version>`):

```json
{
  "schema_version": 1,
  "slot": 1,
  "instance_name": "Work MacBook Chrome",
  "updated_at": 1795692095000,
  "cookie_count": 42,
  "domain_count": 5,
  "cookies": {
    "github.com": [
      {
        "name": "user_session",
        "value": "...",
        "domain": ".github.com",
        "path": "/",
        "secure": true,
        "httpOnly": true,
        "sameSite": "lax",
        "expirationDate": 1827228095,
        "hostOnly": false,
        "session": false,
        "storeId": "0",
        "partitionKey": null
      }
    ]
  }
}
```

- `cookies` is keyed by normalized domain (`domain.replace(/^\.+/, '').toLowerCase()`), while each cookie object preserves its original `domain` and `hostOnly` flag for accurate restoration via `browser.cookies.set()`.
