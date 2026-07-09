//! agora-core: the embeddable Agora hub.
//!
//! One crate, two consumers: the Tauri desktop app embeds it in-process, and
//! `agora-server` runs it headless (for a VPS, so mobile clients can reach
//! agents 24/7). Everything — store, hub, HTTP/WS API, outbound connections,
//! bundled UI — lives behind [`run`].

pub mod auth;
pub mod config;
pub mod connections;
pub mod hub;
pub mod migrate;
pub mod server;
pub mod store;
pub mod voice;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

pub struct App {
    pub state: server::AppState,
    pub addr: SocketAddr,
}

/// Build the full application state from a data dir and start serving.
/// Returns once the listener is bound; serving continues in the background.
pub async fn run(data_dir: PathBuf, ui_dir: Option<PathBuf>) -> anyhow::Result<App> {
    std::fs::create_dir_all(&data_dir)?;
    // Migration hooks run before anything opens the db: a staged import
    // replaces the current data, AGORA_IMPORT_URL seeds a fresh dir.
    migrate::apply_staged_import(&data_dir)?;
    migrate::seed_from_env(&data_dir)?;

    let config = Arc::new(config::Config::load(&data_dir)?);
    let store = Arc::new(store::Store::open(&data_dir.join("agora.db"))?);
    let hub = Arc::new(hub::Hub::new(store));
    let connections = connections::ConnectionManager::new(Arc::clone(&hub), Arc::clone(&config));
    connections.sync();

    let snapshot = config.snapshot();
    let (auth_limiter, upload_limiter) = server::AppState::default_limiters();
    let state = server::AppState {
        hub,
        config,
        connections,
        ui_dir,
        data_dir,
        restart_handler: Arc::new(std::sync::Mutex::new(None)),
        speech_cache: Arc::new(std::sync::Mutex::new(Vec::new())),
        auth_limiter,
        upload_limiter,
    };
    let app = server::router(state.clone());
    let addr: SocketAddr = format!("{}:{}", snapshot.bind, snapshot.port).parse()?;
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        // Configured port taken (another instance, or an unrelated app):
        // fall back to an ephemeral port instead of refusing to launch. The
        // UI navigates to the *bound* address, so everything still works;
        // only dial-in bridges pinned to the old port need the real one back.
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            tracing::warn!("port {} in use, falling back to an ephemeral port", snapshot.port);
            tokio::net::TcpListener::bind(format!("{}:0", snapshot.bind).parse::<SocketAddr>()?)
                .await?
        }
        Err(e) => return Err(e.into()),
    };
    let bound = listener.local_addr()?;
    // A non-loopback bind exposes the API (owner-token gated, but still) on the
    // network with no TLS of its own — it must sit behind a firewall and a TLS
    // reverse proxy. Loopback has no wire to sniff, so stay quiet there.
    if !bound.ip().is_loopback() {
        tracing::warn!(
            "Agora is bound to {bound} (not loopback): reachable off-host in cleartext. \
             Put it behind a firewall and a TLS reverse proxy (see README §Deploying)."
        );
    }
    tokio::spawn(async move {
        // ConnectInfo carries the client IP to the rate limiter; Option<_> in
        // the handlers keeps it working when a transport doesn't supply it.
        let service = app.into_make_service_with_connect_info::<SocketAddr>();
        if let Err(e) = axum::serve(listener, service).await {
            tracing::error!("server stopped: {e}");
        }
    });
    tracing::info!("Agora listening on http://{bound}");
    Ok(App { state, addr: bound })
}
