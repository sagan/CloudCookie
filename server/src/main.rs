use clap::Parser;
use cloudcookie_server::config::Config;
use cloudcookie_server::crypto::generate_random_token;
use cloudcookie_server::server::{build_router, AppState, NonceCache};
use cloudcookie_server::storage::Storage;
use std::net::SocketAddr;
use std::sync::Arc;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let cfg = Config::parse();
    let storage = Arc::new(
        Storage::load_or_init(
            cfg.data_dir.clone(),
            cfg.max_pending,
            cfg.max_slot,
            cfg.max_slots_per_client,
            cfg.max_client_storage_bytes,
        )
        .expect("failed to initialize storage"),
    );

    let admin_token = match cfg.admin_token {
        Some(t) if !t.trim().is_empty() => t,
        _ => {
            let generated = generate_random_token().expect("failed to generate admin token");
            tracing::warn!(
                "No CLOUDCOOKIE_ADMIN_TOKEN provided. Generated ephemeral admin token: {}",
                generated
            );
            generated
        }
    };

    let state = AppState {
        storage,
        admin_token: Arc::new(admin_token),
        auto_register_pending: cfg.auto_register_pending,
        max_body_bytes: cfg.max_body_bytes,
        auth_window_secs: cfg.auth_window_secs,
        enable_nonce_cache: cfg.enable_nonce_cache,
        nonce_cache: NonceCache::new(),
    };

    let app = build_router(state, cfg.rate_limit_per_min);
    let listener = tokio::net::TcpListener::bind(cfg.listen)
        .await
        .expect("failed to bind listen address");

    tracing::info!("CloudCookie server listening on http://{}", cfg.listen);

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await
    .expect("server error");
}
