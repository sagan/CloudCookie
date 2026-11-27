use axum::{
    body::Body,
    extract::{ConnectInfo, State},
    http::{Request, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

#[derive(Clone)]
pub struct RateLimiter {
    limit_per_min: u32,
    buckets: Arc<Mutex<HashMap<IpAddr, (u32, Instant)>>>,
}

impl RateLimiter {
    pub fn new(limit_per_min: u32) -> Self {
        Self {
            limit_per_min,
            buckets: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn check(&self, ip: IpAddr) -> bool {
        if self.limit_per_min == 0 {
            return true;
        }
        let now = Instant::now();
        let window = Duration::from_secs(60);
        let mut map = self.buckets.lock().await;

        // Opportunistic cleanup if map grows large
        if map.len() > 10_000 {
            map.retain(|_, (_, start)| now.duration_since(*start) < window);
        }

        let entry = map.entry(ip).or_insert((0, now));
        if now.duration_since(entry.1) >= window {
            *entry = (1, now);
            return true;
        }
        if entry.0 >= self.limit_per_min {
            return false;
        }
        entry.0 += 1;
        true
    }
}

pub async fn rate_limit_middleware(
    State(limiter): State<RateLimiter>,
    req: Request<Body>,
    next: Next,
) -> Response {
    let ip = req
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ci| ci.0.ip())
        .unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST));

    if !limiter.check(ip).await {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({
                "ok": false,
                "error": "rate_limited",
                "message": "Too many requests, please try again later"
            })),
        )
            .into_response();
    }

    next.run(req).await
}
