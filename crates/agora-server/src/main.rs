//! Headless Agora: the same hub the desktop app embeds, run standalone.
//!
//! Usage: agora-server [--data-dir PATH] [--ui-dir PATH]
//! Bind address/port and tokens live in <data-dir>/config.json (created on
//! first run; the admin key is printed so a client can connect).
//!
//! PaaS-style env overrides (Railway injects `PORT`): `AGORA_BIND`, and
//! `AGORA_PORT` / `PORT` (the former wins). Google sign-in can likewise be
//! configured without touching the volume: `AGORA_GOOGLE_CLIENT_ID`,
//! `AGORA_GOOGLE_CLIENT_SECRET`, `AGORA_GOOGLE_ALLOWED_EMAILS`
//! (comma-separated), and `AGORA_PUBLIC_URL` (the https origin Google
//! redirects back to). Sign in with Apple (native iOS flow):
//! `AGORA_APPLE_ALLOWED_EMAILS` (comma-separated) and optionally
//! `AGORA_APPLE_BUNDLE_ID`. All are persisted into config.json so dial-in
//! bridges and printed URLs agree with what the platform routes to.

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
    // Default to the built UI: web/dist in the repo (run `npm run build`),
    // or a directory named `ui` next to the binary (how the Docker image
    // and older deployments lay the assets out).
    if ui_dir.is_none() {
        for candidate in ["web/dist", "../web/dist", "../../web/dist", "ui", "../ui", "../../ui"] {
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
    println!("Admin key: {}", cfg.admin_key);
    println!("Open http://{}/?token={} in a browser", app.addr, cfg.admin_key);
    tokio::signal::ctrl_c().await?;
    Ok(())
}

/// Fold the `AGORA_*` env overrides into config.json before boot.
fn apply_env_overrides(data_dir: &std::path::Path) -> anyhow::Result<()> {
    let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
    let bind = env("AGORA_BIND");
    let port = env("AGORA_PORT").or_else(|| env("PORT"));
    let google_id = env("AGORA_GOOGLE_CLIENT_ID");
    let google_secret = env("AGORA_GOOGLE_CLIENT_SECRET");
    let google_emails = env("AGORA_GOOGLE_ALLOWED_EMAILS");
    let apple_emails = env("AGORA_APPLE_ALLOWED_EMAILS");
    let apple_bundle_id = env("AGORA_APPLE_BUNDLE_ID");
    let public_url = env("AGORA_PUBLIC_URL");
    if [
        &bind,
        &port,
        &google_id,
        &google_secret,
        &google_emails,
        &apple_emails,
        &apple_bundle_id,
        &public_url,
    ]
    .iter()
    .all(|v| v.is_none())
    {
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
        if let Some(v) = google_id {
            c.google_client_id = v;
        }
        if let Some(v) = google_secret {
            c.google_client_secret = v;
        }
        if let Some(v) = google_emails {
            c.google_allowed_emails = v
                .split(',')
                .map(|e| e.trim().to_lowercase())
                .filter(|e| !e.is_empty())
                .collect();
        }
        if let Some(v) = apple_emails {
            c.apple_allowed_emails = v
                .split(',')
                .map(|e| e.trim().to_lowercase())
                .filter(|e| !e.is_empty())
                .collect();
        }
        if let Some(v) = apple_bundle_id {
            c.apple_bundle_id = v.trim().to_string();
        }
        if let Some(v) = public_url {
            c.public_url = v.trim_end_matches('/').to_string();
        }
    });
    Ok(())
}
