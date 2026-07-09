//! Headless Agora: the same hub the desktop app embeds, run standalone.
//!
//! Usage: agora-server [--data-dir PATH] [--ui-dir PATH]
//! Bind address/port and tokens live in <data-dir>/config.json (created on
//! first run; the owner token is printed so a client can connect).
//!
//! PaaS-style env overrides (Railway injects `PORT`): `AGORA_BIND`, and
//! `AGORA_PORT` / `PORT` (the former wins). They are persisted into
//! config.json so dial-in bridges and printed URLs agree with what the
//! platform routes to.

use std::path::PathBuf;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let mut data_dir = PathBuf::from("data");
    let mut ui_dir: Option<PathBuf> = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--data-dir" => data_dir = PathBuf::from(args.next().expect("--data-dir needs a value")),
            "--ui-dir" => ui_dir = Some(PathBuf::from(args.next().expect("--ui-dir needs a value"))),
            "--help" | "-h" => {
                println!("agora-server [--data-dir PATH] [--ui-dir PATH]");
                return Ok(());
            }
            other => anyhow::bail!("unknown argument: {other}"),
        }
    }
    // Default to the UI bundled next to the binary or in the repo.
    if ui_dir.is_none() {
        for candidate in ["ui", "../ui", "../../ui"] {
            let p = PathBuf::from(candidate);
            if p.join("index.html").exists() {
                ui_dir = Some(p);
                break;
            }
        }
    }

    apply_env_overrides(&data_dir)?;

    let app = agora_core::run(data_dir, ui_dir).await?;
    let cfg = app.state.config.snapshot();
    println!("Agora ready at http://{}", app.addr);
    println!("Owner token: {}", cfg.owner_token);
    println!("Open http://{}/?token={} in a browser", app.addr, cfg.owner_token);
    tokio::signal::ctrl_c().await?;
    Ok(())
}

/// Fold `AGORA_BIND` and `AGORA_PORT`/`PORT` into config.json before boot.
fn apply_env_overrides(data_dir: &std::path::Path) -> anyhow::Result<()> {
    let bind = std::env::var("AGORA_BIND").ok().filter(|v| !v.is_empty());
    let port = ["AGORA_PORT", "PORT"]
        .iter()
        .find_map(|k| std::env::var(k).ok().filter(|v| !v.is_empty()));
    if bind.is_none() && port.is_none() {
        return Ok(());
    }
    let port: Option<u16> = match port {
        Some(v) => Some(v.parse().map_err(|_| anyhow::anyhow!("invalid port: {v}"))?),
        None => None,
    };
    let cfg = agora_core::config::Config::load(data_dir)?;
    cfg.update(|c| {
        if let Some(b) = bind {
            c.bind = b;
        }
        if let Some(p) = port {
            c.port = p;
        }
    });
    Ok(())
}
