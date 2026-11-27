use clap::Parser;
use std::net::SocketAddr;
use std::path::PathBuf;

#[derive(Debug, Clone, Parser)]
#[command(name = "cloudcookie-server", about = "CloudCookie E2E encrypted cookie sync server")]
pub struct Config {
    /// Address and port to listen on
    #[arg(long, env = "CLOUDCOOKIE_LISTEN", default_value = "127.0.0.1:6767")]
    pub listen: SocketAddr,

    /// Directory to store client registry and encrypted cookie blobs
    #[arg(long, env = "CLOUDCOOKIE_DATA_DIR", default_value = "/var/lib/cloudcookie")]
    pub data_dir: PathBuf,

    /// Admin bearer token for /admin/* endpoints (if omitted, a random token is generated on startup)
    #[arg(long, env = "CLOUDCOOKIE_ADMIN_TOKEN")]
    pub admin_token: Option<String>,

    /// Automatically record unknown client_ids as pending admin approval (APPROVAL mode)
    #[arg(long, env = "CLOUDCOOKIE_AUTO_REGISTER_PENDING", default_value_t = false)]
    pub auto_register_pending: bool,

    /// Public mode: automatically approve new client_ids without requiring admin approval
    #[arg(long, env = "CLOUDCOOKIE_PUBLIC_MODE", default_value_t = false, conflicts_with = "private_mode")]
    pub public_mode: bool,

    /// Private mode (default): disable new client_id registration (only existing/pre-authorized client_ids allowed)
    #[arg(long, env = "CLOUDCOOKIE_PRIVATE_MODE", default_value_t = false, conflicts_with = "public_mode")]
    pub private_mode: bool,

    /// Maximum number of pending client registrations to keep (DoS protection)
    #[arg(long, env = "CLOUDCOOKIE_MAX_PENDING", default_value_t = 1000)]
    pub max_pending: usize,

    /// Maximum 0-based slot index allowed per client
    #[arg(long, env = "CLOUDCOOKIE_MAX_SLOT", default_value_t = 1023)]
    pub max_slot: u32,

    /// Optional maximum number of stored slots per client (unlimited if omitted)
    #[arg(long, env = "CLOUDCOOKIE_MAX_SLOTS_PER_CLIENT")]
    pub max_slots_per_client: Option<usize>,

    /// Optional maximum total encrypted storage size in bytes per client (unlimited if omitted)
    #[arg(long, env = "CLOUDCOOKIE_MAX_CLIENT_STORAGE_BYTES")]
    pub max_client_storage_bytes: Option<u64>,

    /// Allowed clock skew / request auth window in seconds for get/delete actions
    #[arg(long, env = "CLOUDCOOKIE_AUTH_WINDOW_SECS", default_value_t = 300)]
    pub auth_window_secs: i64,

    /// Enable in-memory (client_id, nonce) replay cache for get/delete actions
    #[arg(long, env = "CLOUDCOOKIE_ENABLE_NONCE_CACHE", default_value_t = false)]
    pub enable_nonce_cache: bool,

    /// Maximum HTTP request body size in bytes (default: 16 MiB)
    #[arg(long, env = "CLOUDCOOKIE_MAX_BODY_BYTES", default_value_t = 16 * 1024 * 1024)]
    pub max_body_bytes: usize,

    /// Maximum requests per minute per IP (0 disables rate limiting)
    #[arg(long, env = "CLOUDCOOKIE_RATE_LIMIT_PER_MIN", default_value_t = 120)]
    pub rate_limit_per_min: u32,
}
