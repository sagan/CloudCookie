use crate::crypto::{
    constant_time_token_eq, validate_client_id, validate_encrypted_blob, validate_request_nonce,
    verify_request_signature,
};
use crate::rate_limit::{rate_limit_middleware, RateLimiter};
use crate::storage::{ClientStatus, Storage, StorageError};
use axum::{
    body::Body,
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{header, Request, StatusCode},
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use chrono::Utc;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

#[derive(Clone, Default)]
pub struct NonceCache {
    seen: Arc<Mutex<HashMap<(String, String), i64>>>,
}

impl NonceCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns `true` if `(client_id, nonce)` has not been seen within `window_secs`,
    /// recording it atomically. Returns `false` on replay.
    pub async fn check_and_insert(
        &self,
        client_id: &str,
        nonce: &str,
        now_secs: i64,
        window_secs: i64,
    ) -> bool {
        let mut map = self.seen.lock().await;
        if map.len() > 4096 {
            map.retain(|_, ts| now_secs.saturating_sub(*ts) <= window_secs);
        }
        let key = (client_id.to_string(), nonce.to_string());
        if let Some(&prev_ts) = map.get(&key) {
            if now_secs.saturating_sub(prev_ts) <= window_secs {
                return false;
            }
        }
        map.insert(key, now_secs);
        true
    }
}

const ADMIN_HTML: &str = include_str!("admin.html");
const FAVICON_ICO: &[u8] = include_bytes!("favicon.ico");
const FAVICON_SVG: &str = include_str!("favicon.svg");

#[derive(Clone)]
pub struct AppState {
    pub storage: Arc<Storage>,
    pub admin_token: Arc<String>,
    pub auto_register_pending: bool,
    pub public_mode: bool,
    pub max_body_bytes: usize,
    pub auth_window_secs: i64,
    pub enable_nonce_cache: bool,
    pub nonce_cache: NonceCache,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SyncAction {
    Get,
    Update,
    Delete,
    List,
}

impl SyncAction {
    fn as_str(self) -> &'static str {
        match self {
            SyncAction::Get => "get",
            SyncAction::Update => "update",
            SyncAction::Delete => "delete",
            SyncAction::List => "list",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SlotParam {
    Index(u32),
    All,
}

impl<'de> Deserialize<'de> for SlotParam {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct SlotVisitor;
        impl<'de> serde::de::Visitor<'de> for SlotVisitor {
            type Value = SlotParam;

            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a non-negative integer slot index or \"all\"")
            }

            fn visit_u64<E>(self, v: u64) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                u32::try_from(v)
                    .map(SlotParam::Index)
                    .map_err(|_| E::custom("slot index out of u32 range"))
            }

            fn visit_str<E>(self, v: &str) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                if v == "all" {
                    Ok(SlotParam::All)
                } else {
                    Err(E::custom("string slot value must be \"all\""))
                }
            }
        }
        deserializer.deserialize_any(SlotVisitor)
    }
}

#[derive(Debug, Deserialize)]
pub struct SyncRequest {
    pub client_id: String,
    #[serde(default)]
    pub action: Option<SyncAction>,
    #[serde(default)]
    pub slot: Option<SlotParam>,
    #[serde(default)]
    pub expected_version: Option<u64>,
    #[serde(default)]
    pub timestamp: Option<i64>,
    #[serde(default)]
    pub nonce: Option<String>,
    pub signature: String,
    #[serde(default)]
    pub encrypted: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AdminListQuery {
    pub status: Option<ClientStatus>,
}

#[derive(Debug, Deserialize)]
pub struct AdminPreauthRequest {
    pub client_id: String,
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AdminApproveRequest {
    #[serde(default)]
    pub label: Option<String>,
}

pub fn build_router(state: AppState, rate_limit_per_min: u32) -> Router {
    let limiter = RateLimiter::new(rate_limit_per_min);
    let max_body = state.max_body_bytes;

    let admin_routes = Router::new()
        .route("/clients", get(admin_list_clients).post(admin_preauth_client))
        .route("/clients/{client_id}/approve", post(admin_approve_client))
        .route("/clients/{client_id}/revoke", post(admin_revoke_client))
        .route("/clients/{client_id}", delete(admin_delete_client))
        .route_layer(middleware::from_fn_with_state(state.clone(), admin_auth_middleware));

    Router::new()
        .route("/", get(handle_root_help).post(handle_sync))
        .route("/health", get(handle_health))
        .route("/admin.html", get(handle_admin_html))
        .route("/favicon.ico", get(handle_favicon_ico))
        .route("/favicon.svg", get(handle_favicon_svg))
        .nest("/admin", admin_routes)
        .with_state(state)
        .layer(middleware::from_fn_with_state(limiter, rate_limit_middleware))
        .layer(DefaultBodyLimit::max(max_body))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
}

async fn handle_root_help(State(state): State<AppState>) -> impl IntoResponse {
    let mode = if state.public_mode {
        "PUBLIC (new client_ids are automatically approved)"
    } else if state.auto_register_pending {
        "APPROVAL (new client_ids are registered as pending admin approval)"
    } else {
        "PRIVATE (new client_id registration disabled; only existing/pre-authorized client_ids allowed)"
    };

    let body = format!(
        "CloudCookie Server v{version}\n\
         \n\
         Mode: {mode}\n\
         \n\
         Endpoints:\n\
           GET  /                                 This plain-text help\n\
           POST /                                 Client sync endpoint (actions: get, update, delete, list)\n\
           GET  /health                           Server health check (JSON)\n\
           GET  /admin.html                       Admin web console\n\
           GET  /admin/clients                    List clients (Bearer token required)\n\
           POST /admin/clients                    Pre-authorize client (Bearer token required)\n\
           POST /admin/clients/{{client_id}}/approve  Approve client (Bearer token required)\n\
           POST /admin/clients/{{client_id}}/revoke   Revoke client (Bearer token required)\n\
           DELETE /admin/clients/{{client_id}}        Delete client (Bearer token required)\n\
         \n\
         Sync Request (POST /):\n\
           JSON body with client_id (64-char hex Ed25519 pubkey), action, slot,\n\
           timestamp, nonce (32-char hex), signature, and for update:\n\
           expected_version and encrypted payload.\n",
        version = env!("CARGO_PKG_VERSION"),
        mode = mode,
    );

    (
        [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        body,
    )
}

async fn handle_admin_html() -> impl IntoResponse {
    Html(ADMIN_HTML)
}

async fn handle_favicon_ico() -> impl IntoResponse {
    (
        [
            (header::CONTENT_TYPE, "image/x-icon"),
            (header::CACHE_CONTROL, "public, max-age=86400"),
        ],
        FAVICON_ICO,
    )
}

async fn handle_favicon_svg() -> impl IntoResponse {
    (
        [
            (header::CONTENT_TYPE, "image/svg+xml; charset=utf-8"),
            (header::CACHE_CONTROL, "public, max-age=86400"),
        ],
        FAVICON_SVG,
    )
}

fn error_response(status: StatusCode, error: &str, message: impl Into<String>) -> Response {
    (
        status,
        Json(json!({
            "ok": false,
            "error": error,
            "message": message.into(),
        })),
    )
        .into_response()
}

async fn handle_health() -> impl IntoResponse {
    Json(json!({
        "status": "ok",
        "timestamp": Utc::now().to_rfc3339(),
    }))
}

async fn handle_sync(
    State(state): State<AppState>,
    Json(req): Json<SyncRequest>,
) -> Response {
    let mut res = handle_sync_inner(state, req).await;
    res.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    res
}

async fn handle_sync_inner(state: AppState, req: SyncRequest) -> Response {
    if !validate_client_id(&req.client_id) {
        return error_response(
            StatusCode::BAD_REQUEST,
            "invalid_client_id",
            "client_id must be a 64-character lowercase hex Ed25519 public key",
        );
    }

    let action = match (req.action, req.encrypted.as_ref()) {
        (Some(a), _) => a,
        (None, Some(_)) => SyncAction::Update,
        (None, None) => SyncAction::Get,
    };

    let slot_or_all = match (action, req.slot) {
        (SyncAction::Delete, Some(SlotParam::Index(s))) => s.to_string(),
        (SyncAction::Delete, Some(SlotParam::All)) => "all".to_string(),
        (SyncAction::Delete, None) => {
            return error_response(
                StatusCode::BAD_REQUEST,
                "missing_slot",
                "slot field is required for delete action (use a 0-based index or \"all\")",
            );
        }
        (SyncAction::List, _) => "-".to_string(),
        (SyncAction::Get | SyncAction::Update, Some(SlotParam::All)) => {
            return error_response(
                StatusCode::BAD_REQUEST,
                "invalid_slot",
                "slot \"all\" is only valid for delete action",
            );
        }
        (SyncAction::Get | SyncAction::Update, Some(SlotParam::Index(s))) => s.to_string(),
        (SyncAction::Get | SyncAction::Update, None) => "0".to_string(),
    };

    let Some(timestamp) = req.timestamp else {
        return error_response(
            StatusCode::BAD_REQUEST,
            "missing_timestamp",
            "timestamp field is required",
        );
    };
    let Some(ref nonce) = req.nonce else {
        return error_response(
            StatusCode::BAD_REQUEST,
            "missing_nonce",
            "nonce field is required",
        );
    };
    if !validate_request_nonce(nonce) {
        return error_response(
            StatusCode::BAD_REQUEST,
            "invalid_nonce",
            "nonce must be a 32-character lowercase hex string",
        );
    }
    let now_secs = Utc::now().timestamp();
    if (now_secs - timestamp).abs() > state.auth_window_secs {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({
                "ok": false,
                "error": "timestamp_expired",
                "server_time": now_secs,
                "message": "Request timestamp is outside the allowed authorization window",
            })),
        )
            .into_response();
    }

    let expected_version = match action {
        SyncAction::Update => {
            let Some(ver) = req.expected_version else {
                return error_response(
                    StatusCode::BAD_REQUEST,
                    "missing_expected_version",
                    "expected_version field is required for update action",
                );
            };
            if req.encrypted.is_none() {
                return error_response(
                    StatusCode::BAD_REQUEST,
                    "missing_encrypted",
                    "encrypted field is required for update action",
                );
            }
            Some(ver)
        }
        SyncAction::Get | SyncAction::Delete | SyncAction::List => {
            if req.encrypted.is_some() {
                return error_response(
                    StatusCode::BAD_REQUEST,
                    "unexpected_encrypted",
                    "encrypted field must not be provided for get/delete/list action",
                );
            }
            None
        }
    };

    // Verify stateless Ed25519 signature over canonical request fields
    if verify_request_signature(
        &req.client_id,
        action.as_str(),
        &slot_or_all,
        expected_version,
        timestamp,
        nonce,
        req.encrypted.as_deref(),
        &req.signature,
    )
    .is_err()
    {
        return error_response(
            StatusCode::UNAUTHORIZED,
            "invalid_signature",
            "Invalid Ed25519 request signature",
        );
    }

    // Optional in-memory nonce replay cache (disabled by default)
    if state.enable_nonce_cache
        && !state
            .nonce_cache
            .check_and_insert(&req.client_id, nonce, now_secs, state.auth_window_secs)
            .await
    {
        return error_response(
            StatusCode::UNAUTHORIZED,
            "nonce_replayed",
            "Request nonce has already been used",
        );
    }

    // Check admin authorization for this client_id
    let status = match state
        .storage
        .check_or_register_client(&req.client_id, state.auto_register_pending, state.public_mode)
        .await
    {
        Ok(s) => s,
        Err(StorageError::PendingQueueFull) => {
            return error_response(
                StatusCode::TOO_MANY_REQUESTS,
                "pending_queue_full",
                "Pending client registration queue is full",
            );
        }
        Err(e) => {
            tracing::error!("storage error checking client: {e}");
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                "Internal server error",
            );
        }
    };

    match status {
        Some(ClientStatus::Approved) => {}
        Some(ClientStatus::Pending) => {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({
                    "ok": false,
                    "error": "client_pending_approval",
                    "status": "pending",
                    "message": "Client ID is pending admin approval",
                })),
            )
                .into_response();
        }
        Some(ClientStatus::Revoked) => {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({
                    "ok": false,
                    "error": "client_revoked",
                    "status": "revoked",
                    "message": "Client ID has been revoked",
                })),
            )
                .into_response();
        }
        None => {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({
                    "ok": false,
                    "error": "client_unauthorized",
                    "status": "unauthorized",
                    "message": "Client ID is not authorized",
                })),
            )
                .into_response();
        }
    }

    match action {
        SyncAction::Update => {
            let slot = match req.slot {
                Some(SlotParam::Index(s)) => s,
                None => 0,
                Some(SlotParam::All) => unreachable!("checked above"),
            };
            let exp_ver = expected_version.expect("checked above");
            let encrypted = req.encrypted.expect("checked above");
            if let Err(e) = validate_encrypted_blob(&encrypted, state.max_body_bytes) {
                return error_response(
                    StatusCode::BAD_REQUEST,
                    "invalid_encrypted_payload",
                    format!("Invalid encrypted payload: {e}"),
                );
            }
            match state
                .storage
                .put_blob(&req.client_id, slot, exp_ver, encrypted)
                .await
            {
                Ok(blob) => (
                    StatusCode::OK,
                    Json(json!({
                        "ok": true,
                        "action": "update",
                        "slot": blob.slot,
                        "updated_at": blob.updated_at.to_rfc3339(),
                        "version": blob.version,
                    })),
                )
                    .into_response(),
                Err(StorageError::SlotOutOfRange) => error_response(
                    StatusCode::BAD_REQUEST,
                    "slot_out_of_range",
                    "Requested slot index exceeds maximum allowed",
                ),
                Err(StorageError::VersionConflict { current_version }) => (
                    StatusCode::CONFLICT,
                    Json(json!({
                        "ok": false,
                        "error": "version_conflict",
                        "current_version": current_version,
                        "message": format!("expected_version {exp_ver} does not match current version {current_version}"),
                    })),
                )
                    .into_response(),
                Err(StorageError::MaxSlotsExceeded { max_slots }) => error_response(
                    StatusCode::FORBIDDEN,
                    "max_slots_exceeded",
                    format!("Per-client slot limit ({max_slots}) exceeded"),
                ),
                Err(StorageError::StorageQuotaExceeded { max_bytes }) => error_response(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "storage_quota_exceeded",
                    format!("Per-client storage quota ({max_bytes} bytes) exceeded"),
                ),
                Err(e) => {
                    tracing::error!("storage error putting blob: {e}");
                    error_response(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "internal_error",
                        "Internal server error",
                    )
                }
            }
        }
        SyncAction::Get => {
            let slot = match req.slot {
                Some(SlotParam::Index(s)) => s,
                None => 0,
                Some(SlotParam::All) => unreachable!("checked above"),
            };
            match state.storage.get_blob(&req.client_id, slot).await {
                Ok(Some(blob)) => (
                    StatusCode::OK,
                    Json(json!({
                        "ok": true,
                        "action": "get",
                        "client_id": req.client_id,
                        "slot": blob.slot,
                        "encrypted": blob.encrypted,
                        "updated_at": blob.updated_at.to_rfc3339(),
                        "version": blob.version,
                    })),
                )
                    .into_response(),
                Ok(None) => error_response(
                    StatusCode::NOT_FOUND,
                    "no_data",
                    "No encrypted data stored for this client slot",
                ),
                Err(StorageError::SlotOutOfRange) => error_response(
                    StatusCode::BAD_REQUEST,
                    "slot_out_of_range",
                    "Requested slot index exceeds maximum allowed",
                ),
                Err(e) => {
                    tracing::error!("storage error getting blob: {e}");
                    error_response(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "internal_error",
                        "Internal server error",
                    )
                }
            }
        }
        SyncAction::Delete => match req.slot {
            Some(SlotParam::Index(slot)) => match state.storage.delete_slot(&req.client_id, slot).await {
                Ok(true) => (
                    StatusCode::OK,
                    Json(json!({
                        "ok": true,
                        "action": "delete",
                        "slot": slot,
                    })),
                )
                    .into_response(),
                Ok(false) => error_response(
                    StatusCode::NOT_FOUND,
                    "no_data",
                    "No encrypted data stored for this client slot",
                ),
                Err(StorageError::SlotOutOfRange) => error_response(
                    StatusCode::BAD_REQUEST,
                    "slot_out_of_range",
                    "Requested slot index exceeds maximum allowed",
                ),
                Err(e) => {
                    tracing::error!("storage error deleting slot: {e}");
                    error_response(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "internal_error",
                        "Internal server error",
                    )
                }
            },
            Some(SlotParam::All) => match state.storage.delete_client(&req.client_id).await {
                Ok(true) => (
                    StatusCode::OK,
                    Json(json!({
                        "ok": true,
                        "action": "delete",
                        "client_id": req.client_id,
                        "deleted_all": true,
                    })),
                )
                    .into_response(),
                Ok(false) => error_response(
                    StatusCode::NOT_FOUND,
                    "client_not_found",
                    "Client ID not found",
                ),
                Err(e) => {
                    tracing::error!("storage error deleting client: {e}");
                    error_response(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "internal_error",
                        "Internal server error",
                    )
                }
            },
            None => unreachable!("checked above"),
        },
        SyncAction::List => match state.storage.list_client_slots(&req.client_id).await {
            Ok(slots) => {
                let list: Vec<_> = slots
                    .into_iter()
                    .map(|(slot, meta)| {
                        json!({
                            "slot": slot,
                            "version": meta.version,
                            "updated_at": meta.updated_at.to_rfc3339(),
                            "size_bytes": meta.size_bytes,
                        })
                    })
                    .collect();
                (
                    StatusCode::OK,
                    Json(json!({
                        "ok": true,
                        "action": "list",
                        "client_id": req.client_id,
                        "slots": list,
                    })),
                )
                    .into_response()
            }
            Err(e) => {
                tracing::error!("storage error listing client slots: {e}");
                error_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal_error",
                    "Internal server error",
                )
            }
        },
    }
}

async fn admin_auth_middleware(
    State(state): State<AppState>,
    req: Request<Body>,
    next: Next,
) -> Response {
    let auth_header = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());

    let Some(token) = auth_header.and_then(|h| h.strip_prefix("Bearer ")) else {
        return error_response(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "Missing or invalid Authorization Bearer header",
        );
    };

    if !constant_time_token_eq(token, &state.admin_token) {
        return error_response(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "Invalid admin token",
        );
    }

    next.run(req).await
}

async fn admin_list_clients(
    State(state): State<AppState>,
    Query(query): Query<AdminListQuery>,
) -> impl IntoResponse {
    let clients = state.storage.list_clients(query.status).await;
    Json(json!({
        "ok": true,
        "clients": clients,
    }))
}

async fn admin_preauth_client(
    State(state): State<AppState>,
    Json(body): Json<AdminPreauthRequest>,
) -> Response {
    match state
        .storage
        .preauthorize_client(&body.client_id, body.label)
        .await
    {
        Ok(record) => (
            StatusCode::OK,
            Json(json!({
                "ok": true,
                "client": record,
            })),
        )
            .into_response(),
        Err(StorageError::InvalidClientId) => error_response(
            StatusCode::BAD_REQUEST,
            "invalid_client_id",
            "client_id must be a 64-character lowercase hex string",
        ),
        Err(e) => {
            tracing::error!("admin preauth error: {e}");
            error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                "Internal server error",
            )
        }
    }
}

async fn admin_approve_client(
    State(state): State<AppState>,
    Path(client_id): Path<String>,
    body: Option<Json<AdminApproveRequest>>,
) -> Response {
    let label = body.and_then(|b| b.0.label);
    match state.storage.approve_client(&client_id, label).await {
        Ok(record) => (
            StatusCode::OK,
            Json(json!({
                "ok": true,
                "client": record,
            })),
        )
            .into_response(),
        Err(StorageError::InvalidClientId) => error_response(
            StatusCode::BAD_REQUEST,
            "invalid_client_id",
            "client_id must be a 64-character lowercase hex string",
        ),
        Err(StorageError::ClientNotFound) => error_response(
            StatusCode::NOT_FOUND,
            "client_not_found",
            "Client ID not found",
        ),
        Err(e) => {
            tracing::error!("admin approve error: {e}");
            error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                "Internal server error",
            )
        }
    }
}

async fn admin_revoke_client(
    State(state): State<AppState>,
    Path(client_id): Path<String>,
) -> Response {
    match state.storage.revoke_client(&client_id).await {
        Ok(record) => (
            StatusCode::OK,
            Json(json!({
                "ok": true,
                "client": record,
            })),
        )
            .into_response(),
        Err(StorageError::InvalidClientId) => error_response(
            StatusCode::BAD_REQUEST,
            "invalid_client_id",
            "client_id must be a 64-character lowercase hex string",
        ),
        Err(StorageError::ClientNotFound) => error_response(
            StatusCode::NOT_FOUND,
            "client_not_found",
            "Client ID not found",
        ),
        Err(e) => {
            tracing::error!("admin revoke error: {e}");
            error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                "Internal server error",
            )
        }
    }
}

async fn admin_delete_client(
    State(state): State<AppState>,
    Path(client_id): Path<String>,
) -> Response {
    match state.storage.delete_client(&client_id).await {
        Ok(true) => (
            StatusCode::OK,
            Json(json!({
                "ok": true,
                "deleted": client_id,
            })),
        )
            .into_response(),
        Ok(false) => error_response(
            StatusCode::NOT_FOUND,
            "client_not_found",
            "Client ID not found",
        ),
        Err(StorageError::InvalidClientId) => error_response(
            StatusCode::BAD_REQUEST,
            "invalid_client_id",
            "client_id must be a 64-character lowercase hex string",
        ),
        Err(e) => {
            tracing::error!("admin delete error: {e}");
            error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                "Internal server error",
            )
        }
    }
}
