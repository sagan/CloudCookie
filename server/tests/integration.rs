use axum::{
    body::Body,
    http::{header, Request, StatusCode},
    Router,
};
use chrono::Utc;
use cloudcookie_server::crypto::{
    constant_time_token_eq, decrypt_payload, derive_client_id, derive_enc_key, encrypt_payload,
    generate_request_nonce, generate_root_key, hex_decode, sign_request, validate_client_id,
    xaes_256_gcm_open, xaes_256_gcm_seal,
};
use cloudcookie_server::server::{build_router, AppState, NonceCache};
use cloudcookie_server::storage::{Storage, StorageError};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::sync::Arc;
use tempfile::TempDir;
use tower::ServiceExt;

fn setup_app(
    auto_register_pending: bool,
    rate_limit_per_min: u32,
    enable_nonce_cache: bool,
    max_slots_per_client: Option<usize>,
    max_client_storage_bytes: Option<u64>,
) -> (Router, TempDir, String) {
    setup_app_with_public_mode(
        auto_register_pending,
        false,
        rate_limit_per_min,
        enable_nonce_cache,
        max_slots_per_client,
        max_client_storage_bytes,
    )
}

fn setup_app_with_public_mode(
    auto_register_pending: bool,
    public_mode: bool,
    rate_limit_per_min: u32,
    enable_nonce_cache: bool,
    max_slots_per_client: Option<usize>,
    max_client_storage_bytes: Option<u64>,
) -> (Router, TempDir, String) {
    let dir = TempDir::new().expect("tempdir");
    let storage = Arc::new(
        Storage::load_or_init(
            dir.path().to_path_buf(),
            100,
            16,
            max_slots_per_client,
            max_client_storage_bytes,
        )
        .unwrap(),
    );
    let admin_token = "test-admin-secret-token-12345".to_string();
    let state = AppState {
        storage,
        admin_token: Arc::new(admin_token.clone()),
        auto_register_pending,
        public_mode,
        max_body_bytes: 1024 * 1024,
        auth_window_secs: 300,
        enable_nonce_cache,
        nonce_cache: NonceCache::new(),
    };
    let app = build_router(state, rate_limit_per_min);
    (app, dir, admin_token)
}

fn signed_get_body(root_key: &[u8; 32], slot: u32, ts_offset: i64) -> String {
    let client_id = derive_client_id(root_key).unwrap();
    let timestamp = Utc::now().timestamp() + ts_offset;
    let nonce = generate_request_nonce().unwrap();
    let slot_str = slot.to_string();
    let signature =
        sign_request(root_key, "get", &slot_str, None, timestamp, &nonce, None).unwrap();
    json!({
        "action": "get",
        "client_id": client_id,
        "slot": slot,
        "timestamp": timestamp,
        "nonce": nonce,
        "signature": signature,
    })
    .to_string()
}

fn signed_update_body_with_offset(
    root_key: &[u8; 32],
    slot: u32,
    expected_version: u64,
    encrypted: &str,
    ts_offset: i64,
) -> String {
    let client_id = derive_client_id(root_key).unwrap();
    let slot_str = slot.to_string();
    let timestamp = Utc::now().timestamp() + ts_offset;
    let nonce = generate_request_nonce().unwrap();
    let signature = sign_request(
        root_key,
        "update",
        &slot_str,
        Some(expected_version),
        timestamp,
        &nonce,
        Some(encrypted),
    )
    .unwrap();
    json!({
        "action": "update",
        "client_id": client_id,
        "slot": slot,
        "expected_version": expected_version,
        "timestamp": timestamp,
        "nonce": nonce,
        "encrypted": encrypted,
        "signature": signature,
    })
    .to_string()
}

fn signed_update_body(
    root_key: &[u8; 32],
    slot: u32,
    expected_version: u64,
    encrypted: &str,
) -> String {
    signed_update_body_with_offset(root_key, slot, expected_version, encrypted, 0)
}

fn signed_list_body(root_key: &[u8; 32]) -> String {
    let client_id = derive_client_id(root_key).unwrap();
    let timestamp = Utc::now().timestamp();
    let nonce = generate_request_nonce().unwrap();
    let signature = sign_request(root_key, "list", "-", None, timestamp, &nonce, None).unwrap();
    json!({
        "action": "list",
        "client_id": client_id,
        "timestamp": timestamp,
        "nonce": nonce,
        "signature": signature,
    })
    .to_string()
}

fn signed_delete_body(root_key: &[u8; 32], slot: Option<u32>) -> String {
    let client_id = derive_client_id(root_key).unwrap();
    let timestamp = Utc::now().timestamp();
    let nonce = generate_request_nonce().unwrap();
    let slot_or_all = slot.map_or_else(|| "all".to_string(), |s| s.to_string());
    let signature = sign_request(
        root_key,
        "delete",
        &slot_or_all,
        None,
        timestamp,
        &nonce,
        None,
    )
    .unwrap();
    let mut obj = json!({
        "action": "delete",
        "client_id": client_id,
        "timestamp": timestamp,
        "nonce": nonce,
        "signature": signature,
    });
    match slot {
        Some(s) => obj["slot"] = json!(s),
        None => obj["slot"] = json!("all"),
    }
    obj.to_string()
}

async fn json_response(res: axum::response::Response) -> (StatusCode, Value) {
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let val: Value = serde_json::from_slice(&bytes).unwrap();
    (status, val)
}

#[test]
fn test_xaes_256_gcm_c2sp_vector_and_slot_version_aad() {
    // Official C2SP XAES-256-GCM test vector #1
    let key: [u8; 32] = [0x01; 32];
    let nonce: [u8; 24] = *b"ABCDEFGHIJKLMNOPQRSTUVWX";
    let plaintext = b"XAES-256-GCM";
    let ct = xaes_256_gcm_seal(&key, &nonce, plaintext, b"").unwrap();
    assert_eq!(
        hex_decode("ce546ef63c9cc60765923609b33a9a1974e96e52daf2fcf7075e2271")
            .unwrap()
            .as_slice(),
        ct.as_slice()
    );
    let pt = xaes_256_gcm_open(&key, &nonce, &ct, b"").unwrap();
    assert_eq!(pt, plaintext);

    // CloudCookie HKDF + Ed25519 + XAES-256-GCM with (slot, version) AAD
    let root_key = generate_root_key().unwrap();
    let client_id = derive_client_id(&root_key).unwrap();
    let enc_key = derive_enc_key(&root_key).unwrap();
    assert!(validate_client_id(&client_id));
    assert_ne!(hex_decode(&client_id).unwrap().as_slice(), &enc_key);

    let msg = br#"{"cookie_data":{"example.com":[{"name":"sid","value":"secret"}]}}"#;
    let encrypted = encrypt_payload(&root_key, 1, 1, msg).unwrap();
    assert_eq!(decrypt_payload(&root_key, 1, 1, &encrypted).unwrap(), msg);

    // Tampered version metadata must fail AAD verification
    assert!(decrypt_payload(&root_key, 1, 2, &encrypted).is_err());
    // Cross-slot substitution must fail AAD verification
    assert!(decrypt_payload(&root_key, 0, 1, &encrypted).is_err());
    // Wrong key must fail
    let other_key = generate_root_key().unwrap();
    assert!(decrypt_payload(&other_key, 1, 1, &encrypted).is_err());

    // Print deterministic CloudCookie test vector for PROTOCOL.md verification
    let vec_root: [u8; 32] = core::array::from_fn(|i| i as u8);
    let vec_cid = derive_client_id(&vec_root).unwrap();
    let vec_kenc = derive_enc_key(&vec_root).unwrap();
    let vec_nonce: [u8; 24] = *b"ABCDEFGHIJKLMNOPQRSTUVWX";
    let vec_aad = format!("cloudcookie-v1:{vec_cid}:1:1");
    let vec_pt = br#"{"hello":"cloudcookie"}"#;
    let vec_ct = xaes_256_gcm_seal(&vec_kenc, &vec_nonce, vec_pt, vec_aad.as_bytes()).unwrap();
    let mut vec_blob = Vec::with_capacity(24 + vec_ct.len());
    vec_blob.extend_from_slice(&vec_nonce);
    vec_blob.extend_from_slice(&vec_ct);
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
    let vec_b64 = BASE64.encode(&vec_blob);
    let vec_sig = sign_request(
        &vec_root,
        "update",
        "1",
        Some(0),
        1700000000,
        "00112233445566778899aabbccddeeff",
        Some(&vec_b64),
    )
    .unwrap();
    assert_eq!(
        vec_cid,
        "efaa52e7bf7b356fcebcbde5b95fa9aa24d6d91bbe6dac4d06bc5679b1d3e31e"
    );
    assert_eq!(
        cloudcookie_server::crypto::hex_encode(&vec_kenc),
        "81d7dd656c9ed75994ce72f06f083e6891271f29c2221dfd844003118e1593b0"
    );
    assert_eq!(
        vec_b64,
        "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYmob7YcRaAVXTjoVMw1qdJkqG5yJ+18HiKUzRt4j2RMkePC2TNAN7"
    );
    assert_eq!(
        vec_sig,
        "5d1894a3d27d44072e859eef0c31f222bd032ed7576f0c76641c4717981c1facbf3c60ad4e5c36608bf44e8b476dd6e393f9d3d011d063de4d0e38855c86fc00"
    );
}

#[test]
fn test_constant_time_token_eq() {
    assert!(constant_time_token_eq("abc123", "abc123"));
    assert!(!constant_time_token_eq("abc123", "abc124"));
    assert!(!constant_time_token_eq("abc123", "abc1234"));
}

#[tokio::test]
async fn test_multi_slot_cas_delete_and_admin_flow() {
    let (app, _dir, admin_token) = setup_app(true, 0, false, None, None);
    let root_key = generate_root_key().unwrap();
    let client_id = derive_client_id(&root_key).unwrap();

    // 1. Unknown client -> pending (403)
    let req = Request::builder()
        .method("POST")
        .uri("/")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(signed_get_body(&root_key, 0, 0)))
        .unwrap();
    let (status, body) = json_response(app.clone().oneshot(req).await.unwrap()).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["status"], "pending");

    // 2. Admin approves client
    let req = Request::builder()
        .method("POST")
        .uri(format!("/admin/clients/{client_id}/approve"))
        .header(header::AUTHORIZATION, format!("Bearer {admin_token}"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(json!({ "label": "Work" }).to_string()))
        .unwrap();
    let (status, _) = json_response(app.clone().oneshot(req).await.unwrap()).await;
    assert_eq!(status, StatusCode::OK);

    // 3. Update slot 0 with expected_version=0 -> version becomes 1
    let meta = br#"{"used_slots":[1]}"#;
    let enc0 = encrypt_payload(&root_key, 0, 1, meta).unwrap();
    let update0_body = signed_update_body(&root_key, 0, 0, &enc0);
    let req = Request::builder()
        .method("POST")
        .uri("/")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(update0_body.clone()))
        .unwrap();
    let (status, body) = json_response(app.clone().oneshot(req).await.unwrap()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["version"], 1);

    // 4. Replaying the exact same update request fails with 409 version_conflict!
    let req = Request::builder()
        .method("POST")
        .uri("/")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(update0_body))
        .unwrap();
    let (status, body) = json_response(app.clone().oneshot(req).await.unwrap()).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"], "version_conflict");
    assert_eq!(body["current_version"], 1);

    // 5. Update slot 1 with expected_version=0, then fetch & decrypt with version from server
    let cookies = br#"{"cookie_data":{"github.com":[{"name":"s","value":"v"}]}}"#;
    let enc1 = encrypt_payload(&root_key, 1, 1, cookies).unwrap();
    let req = Request::builder()
        .method("POST")
        .uri("/")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(signed_update_body(&root_key, 1, 0, &enc1)))
        .unwrap();
    let (status, _) = json_response(app.clone().oneshot(req).await.unwrap()).await;
    assert_eq!(status, StatusCode::OK);

    let req = Request::builder()
        .method("POST")
        .uri("/")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(signed_get_body(&root_key, 1, 0)))
        .unwrap();
    let (status, body) = json_response(app.clone().oneshot(req).await.unwrap()).await;
    assert_eq!(status, StatusCode::OK);
    let ver = body["version"].as_u64().unwrap();
    assert_eq!(ver, 1);
    let decrypted = decrypt_payload(&root_key, 1, ver, body["encrypted"].as_str().unwrap()).unwrap();
    assert_eq!(decrypted, cookies);

    // 5b. List slots -> returns slot 0 and slot 1 metadata
    let req = Request::builder()
        .method("POST")
        .uri("/")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(signed_list_body(&root_key)))
        .unwrap();
    let (status, body) = json_response(app.clone().oneshot(req).await.unwrap()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["action"], "list");
    let slots = body["slots"].as_array().unwrap();
    assert_eq!(slots.len(), 2);
    assert_eq!(slots[0]["slot"], 0);
    assert_eq!(slots[0]["version"], 1);
    assert_eq!(slots[1]["slot"], 1);
    assert_eq!(slots[1]["version"], 1);

    // 6. Delete slot 1 -> 200, then get slot 1 -> 404
    let req = Request::builder()
        .method("POST")
        .uri("/")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(signed_delete_body(&root_key, Some(1))))
        .unwrap();
    let (status, body) = json_response(app.clone().oneshot(req).await.unwrap()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["slot"], 1);

    let req = Request::builder()
        .method("POST")
        .uri("/")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(signed_get_body(&root_key, 1, 0)))
        .unwrap();
    let (status, _) = json_response(app.clone().oneshot(req).await.unwrap()).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // 7. Delete without slot field -> 400 missing_slot
    let req_no_slot = Request::builder()
        .method("POST")
        .uri("/")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            json!({
                "action": "delete",
                "client_id": client_id,
                "timestamp": Utc::now().timestamp(),
                "nonce": generate_request_nonce().unwrap(),
                "signature": "00".repeat(64),
            })
            .to_string(),
        ))
        .unwrap();
    let (status, body) = json_response(app.clone().oneshot(req_no_slot).await.unwrap()).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "missing_slot");

    // 8. Delete everything for client_id ("slot": "all") -> 200 deleted_all
    let req = Request::builder()
        .method("POST")
        .uri("/")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(signed_delete_body(&root_key, None)))
        .unwrap();
    let (status, body) = json_response(app.clone().oneshot(req).await.unwrap()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["deleted_all"], true);
}

#[tokio::test]
async fn test_auth_window_300s_and_optional_nonce_cache() {
    let root_key = generate_root_key().unwrap();
    let client_id = derive_client_id(&root_key).unwrap();

    // Part A: default enable_nonce_cache = false, auth_window_secs = 300
    let (app, _dir, admin_token) = setup_app(false, 0, false, None, None);
    let req = Request::builder()
        .method("POST")
        .uri("/admin/clients")
        .header(header::AUTHORIZATION, format!("Bearer {admin_token}"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(json!({ "client_id": client_id }).to_string()))
        .unwrap();
    assert_eq!(app.clone().oneshot(req).await.unwrap().status(), StatusCode::OK);

    let enc = encrypt_payload(&root_key, 0, 1, b"hello").unwrap();
    let req = Request::builder()
        .method("POST")
        .uri("/")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(signed_update_body(&root_key, 0, 0, &enc)))
        .unwrap();
    assert_eq!(app.clone().oneshot(req).await.unwrap().status(), StatusCode::OK);

    // 200s old timestamp is within 300s window -> 200 OK
    let req = Request::builder()
        .method("POST")
        .uri("/")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(signed_get_body(&root_key, 0, -200)))
        .unwrap();
    assert_eq!(app.clone().oneshot(req).await.unwrap().status(), StatusCode::OK);

    // 350s old timestamp on update (even with expected_version=0 after delete) -> 401 timestamp_expired
    let req = Request::builder()
        .method("POST")
        .uri("/")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(signed_update_body_with_offset(
            &root_key, 0, 0, &enc, -350,
        )))
        .unwrap();
    let (status, body) = json_response(app.clone().oneshot(req).await.unwrap()).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"], "timestamp_expired");
    assert!(body["server_time"].as_i64().is_some());

    // 350s old timestamp is outside 300s window -> 401 timestamp_expired
    let req = Request::builder()
        .method("POST")
        .uri("/")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(signed_get_body(&root_key, 0, -350)))
        .unwrap();
    let (status, body) = json_response(app.clone().oneshot(req).await.unwrap()).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"], "timestamp_expired");
    assert!(body["server_time"].as_i64().is_some());

    // Part B: enable_nonce_cache = true rejects replayed get
    let (app_cached, _dir2, admin_token2) = setup_app(false, 0, true, None, None);
    let req = Request::builder()
        .method("POST")
        .uri("/admin/clients")
        .header(header::AUTHORIZATION, format!("Bearer {admin_token2}"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(json!({ "client_id": client_id }).to_string()))
        .unwrap();
    assert_eq!(
        app_cached.clone().oneshot(req).await.unwrap().status(),
        StatusCode::OK
    );

    let get_body = signed_get_body(&root_key, 0, 0);
    let req1 = Request::builder()
        .method("POST")
        .uri("/")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(get_body.clone()))
        .unwrap();
    assert_eq!(
        app_cached.clone().oneshot(req1).await.unwrap().status(),
        StatusCode::NOT_FOUND
    );

    let req2 = Request::builder()
        .method("POST")
        .uri("/")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(get_body))
        .unwrap();
    let (status, body) = json_response(app_cached.clone().oneshot(req2).await.unwrap()).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"], "nonce_replayed");
}

#[tokio::test]
async fn test_per_client_slot_and_storage_quotas() {
    // Max 2 slots, max 160 bytes total encrypted string length
    let (app, _dir, admin_token) = setup_app(false, 0, false, Some(2), Some(160));
    let root_key = generate_root_key().unwrap();
    let client_id = derive_client_id(&root_key).unwrap();

    let req = Request::builder()
        .method("POST")
        .uri("/admin/clients")
        .header(header::AUTHORIZATION, format!("Bearer {admin_token}"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(json!({ "client_id": client_id }).to_string()))
        .unwrap();
    assert_eq!(app.clone().oneshot(req).await.unwrap().status(), StatusCode::OK);

    // Slot 0 (~60 chars base64) -> OK
    let enc0 = encrypt_payload(&root_key, 0, 1, b"abc").unwrap();
    let req = Request::builder()
        .method("POST")
        .uri("/")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(signed_update_body(&root_key, 0, 0, &enc0)))
        .unwrap();
    assert_eq!(app.clone().oneshot(req).await.unwrap().status(), StatusCode::OK);

    // Slot 1 (~60 chars base64) -> OK
    let enc1 = encrypt_payload(&root_key, 1, 1, b"def").unwrap();
    let req = Request::builder()
        .method("POST")
        .uri("/")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(signed_update_body(&root_key, 1, 0, &enc1)))
        .unwrap();
    assert_eq!(app.clone().oneshot(req).await.unwrap().status(), StatusCode::OK);

    // Slot 2 exceeds max_slots_per_client (2) -> 403 max_slots_exceeded
    let enc2 = encrypt_payload(&root_key, 2, 1, b"ghi").unwrap();
    let req = Request::builder()
        .method("POST")
        .uri("/")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(signed_update_body(&root_key, 2, 0, &enc2)))
        .unwrap();
    let (status, body) = json_response(app.clone().oneshot(req).await.unwrap()).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"], "max_slots_exceeded");

    // Updating slot 1 with a large payload exceeds max_client_storage_bytes (160) -> 413
    let big_enc = encrypt_payload(&root_key, 1, 2, &[b'x'; 200]).unwrap();
    let req = Request::builder()
        .method("POST")
        .uri("/")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(signed_update_body(&root_key, 1, 1, &big_enc)))
        .unwrap();
    let (status, body) = json_response(app.clone().oneshot(req).await.unwrap()).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(body["error"], "storage_quota_exceeded");
}

#[tokio::test]
async fn test_public_mode_auto_approves_new_clients_and_respects_revocation() {
    let (app, _dir, admin_token) =
        setup_app_with_public_mode(true, true, 0, false, None, None);
    let root_key = generate_root_key().unwrap();
    let client_id = derive_client_id(&root_key).unwrap();

    // Unknown client can immediately update without admin approval in PUBLIC mode
    let enc = encrypt_payload(&root_key, 0, 1, b"public-cookie-data").unwrap();
    let req = Request::builder()
        .method("POST")
        .uri("/")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(signed_update_body(&root_key, 0, 0, &enc)))
        .unwrap();
    let (status, body) = json_response(app.clone().oneshot(req).await.unwrap()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["ok"], true);
    assert_eq!(body["version"], 1);

    // Client can immediately get its stored data
    let req = Request::builder()
        .method("POST")
        .uri("/")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(signed_get_body(&root_key, 0, 0)))
        .unwrap();
    let (status, body) = json_response(app.clone().oneshot(req).await.unwrap()).await;
    assert_eq!(status, StatusCode::OK);
    let decrypted = decrypt_payload(&root_key, 0, 1, body["encrypted"].as_str().unwrap()).unwrap();
    assert_eq!(decrypted, b"public-cookie-data");

    // Admin can still revoke a client even in PUBLIC mode
    let req = Request::builder()
        .method("POST")
        .uri(format!("/admin/clients/{client_id}/revoke"))
        .header(header::AUTHORIZATION, format!("Bearer {admin_token}"))
        .body(Body::empty())
        .unwrap();
    let (status, body) = json_response(app.clone().oneshot(req).await.unwrap()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["client"]["status"], "revoked");

    // Revoked client is blocked
    let req = Request::builder()
        .method("POST")
        .uri("/")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(signed_get_body(&root_key, 0, 0)))
        .unwrap();
    let (status, body) = json_response(app.clone().oneshot(req).await.unwrap()).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"], "client_revoked");
}

#[tokio::test]
async fn test_root_get_help_and_embedded_admin_html() {
    let (app, _dir, _admin_token) =
        setup_app_with_public_mode(true, true, 0, false, None, None);

    // GET / returns plain text help
    let req = Request::builder()
        .method("GET")
        .uri("/")
        .body(Body::empty())
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let ct = res
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    assert!(ct.starts_with("text/plain"), "unexpected content-type: {ct}");
    let body_bytes = res.into_body().collect().await.unwrap().to_bytes();
    let text = String::from_utf8(body_bytes.to_vec()).unwrap();
    assert!(text.contains("CloudCookie Server"));
    assert!(text.contains("PUBLIC"));
    assert!(text.contains("/admin.html"));

    // GET /admin.html returns embedded HTML
    let req = Request::builder()
        .method("GET")
        .uri("/admin.html")
        .body(Body::empty())
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let ct = res
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    assert!(ct.starts_with("text/html"), "unexpected content-type: {ct}");
    let body_bytes = res.into_body().collect().await.unwrap().to_bytes();
    let html = String::from_utf8(body_bytes.to_vec()).unwrap();
    assert!(html.contains("<title>CloudCookie Admin</title>"));
    assert!(html.contains("/admin/clients"));
    assert!(html.contains("reg-client-id"));
    assert!(html.contains("Register Client"));
    assert!(html.contains("/favicon.ico"));
    assert!(html.contains("/favicon.svg"));

    // GET /favicon.ico returns embedded ICO
    let req = Request::builder()
        .method("GET")
        .uri("/favicon.ico")
        .body(Body::empty())
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let ct = res
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    assert_eq!(ct, "image/x-icon");
    let ico_bytes = res.into_body().collect().await.unwrap().to_bytes();
    assert!(ico_bytes.len() > 22);
    assert_eq!(&ico_bytes[0..4], &[0, 0, 1, 0]);

    // GET /favicon.svg returns embedded SVG
    let req = Request::builder()
        .method("GET")
        .uri("/favicon.svg")
        .body(Body::empty())
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let ct = res
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    assert!(ct.starts_with("image/svg+xml"), "unexpected content-type: {ct}");
    let svg_bytes = res.into_body().collect().await.unwrap().to_bytes();
    let svg = String::from_utf8(svg_bytes.to_vec()).unwrap();
    assert!(svg.contains("<svg"));
}

#[tokio::test]
async fn test_private_mode_disables_registration_until_admin_registers() {
    let (app, _dir, admin_token) =
        setup_app_with_public_mode(false, false, 0, false, None, None);
    let root_key = generate_root_key().unwrap();
    let client_id = derive_client_id(&root_key).unwrap();

    // GET / shows PRIVATE mode
    let req = Request::builder()
        .method("GET")
        .uri("/")
        .body(Body::empty())
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    let body_bytes = res.into_body().collect().await.unwrap().to_bytes();
    let text = String::from_utf8(body_bytes.to_vec()).unwrap();
    assert!(text.contains("PRIVATE"));

    // Unknown client is rejected with client_unauthorized and NOT recorded as pending
    let enc = encrypt_payload(&root_key, 0, 1, b"private-secret").unwrap();
    let req = Request::builder()
        .method("POST")
        .uri("/")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(signed_update_body(&root_key, 0, 0, &enc)))
        .unwrap();
    let (status, body) = json_response(app.clone().oneshot(req).await.unwrap()).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"], "client_unauthorized");

    // Verify no pending client record was created
    let req = Request::builder()
        .method("GET")
        .uri("/admin/clients")
        .header(header::AUTHORIZATION, format!("Bearer {admin_token}"))
        .body(Body::empty())
        .unwrap();
    let (status, body) = json_response(app.clone().oneshot(req).await.unwrap()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["clients"].as_array().unwrap().len(), 0);

    // Admin manually registers the client_id via POST /admin/clients
    let req = Request::builder()
        .method("POST")
        .uri("/admin/clients")
        .header(header::AUTHORIZATION, format!("Bearer {admin_token}"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            json!({ "client_id": client_id, "label": "manual-client" }).to_string(),
        ))
        .unwrap();
    let (status, body) = json_response(app.clone().oneshot(req).await.unwrap()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["client"]["status"], "approved");

    // Now the client can update and get
    let req = Request::builder()
        .method("POST")
        .uri("/")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(signed_update_body(&root_key, 0, 0, &enc)))
        .unwrap();
    let (status, _) = json_response(app.clone().oneshot(req).await.unwrap()).await;
    assert_eq!(status, StatusCode::OK);
}

#[test]
fn test_advisory_file_lock_prevents_concurrent_instances() {
    let dir = TempDir::new().expect("tempdir");

    let first = Storage::load_or_init(dir.path().to_path_buf(), 100, 16, None, None)
        .expect("first storage instance should acquire lock");

    let second = Storage::load_or_init(dir.path().to_path_buf(), 100, 16, None, None);
    assert!(
        matches!(second, Err(StorageError::AlreadyLocked(_))),
        "second instance on same data_dir should fail with AlreadyLocked"
    );

    drop(first);

    let third = Storage::load_or_init(dir.path().to_path_buf(), 100, 16, None, None);
    assert!(
        third.is_ok(),
        "storage should acquire lock again after previous instance is dropped"
    );
}
