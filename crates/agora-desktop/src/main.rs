//! Agora desktop: a Tauri shell around the embedded agora-core hub.
//!
//! The core binds its HTTP+WS server on loopback (serving the bundled web UI)
//! and the window simply navigates to it with the owner token — identical to
//! the headless deployment, so the UI code has exactly one environment.
//!
//! The hub must outlive the window: agents reply asynchronously and their
//! messages land in this process's database. So closing the window only
//! hides it (the app keeps running in the dock; clicking the icon reopens
//! it) and Cmd-Q is the real quit.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::{Arc, OnceLock};

use tauri::path::BaseDirectory;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
#[cfg(not(target_os = "macos"))]
use tauri_plugin_notification::NotificationExt;

#[cfg(target_os = "macos")]
mod notify;

/// The embedded hub, once the core is up — the window-event handler flips
/// its ui_active flag so unseen messages notify only while unfocused.
static HUB: OnceLock<Arc<agora_core::hub::Hub>> = OnceLock::new();

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .on_window_event(|window, event| {
            match event {
                WindowEvent::Focused(focused) => {
                    if let Some(hub) = HUB.get() {
                        hub.set_ui_active(*focused);
                    }
                }
                // Close = hide: agents keep processing and replies keep
                // landing (and notifying) while the window is away.
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = window.hide();
                    if let Some(hub) = HUB.get() {
                        hub.set_ui_active(false);
                    }
                }
                _ => {}
            }
        })
        .setup(|app| {
            // macOS banners require the modern UserNotifications framework,
            // which in turn requires a stably signed bundle (see notify.rs).
            // First launch pops the system "allow notifications?" prompt.
            #[cfg(target_os = "macos")]
            notify::request_authorization();
            let data_dir = app.path().app_data_dir()?;
            // Bundled UI: <bundle>/Resources/ui in a build; the repo's ui/ in dev.
            let ui_dir = app
                .path()
                .resolve("ui", BaseDirectory::Resource)
                .ok()
                .filter(|p| p.join("index.html").exists())
                .or_else(|| {
                    let dev = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                        .join("../../ui");
                    dev.join("index.html").exists().then_some(dev)
                });
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match agora_core::run(data_dir, ui_dir).await {
                    Ok(core) => {
                        // New messages landing while the window is unfocused
                        // (i.e. unseen) surface as native notifications.
                        let _ = HUB.set(Arc::clone(&core.state.hub));
                        #[cfg(target_os = "macos")]
                        core.state.hub.set_notifier(|ev| {
                            notify::notify(&ev.title, &ev.body);
                        });
                        #[cfg(not(target_os = "macos"))]
                        {
                            let notify_handle = handle.clone();
                            core.state.hub.set_notifier(move |ev| {
                                let result = notify_handle
                                    .notification()
                                    .builder()
                                    .title(&ev.title)
                                    .body(&ev.body)
                                    .show();
                                if let Err(e) = result {
                                    tracing::warn!("notification failed: {e}");
                                }
                            });
                        }
                        let token = core.state.config.owner_token();
                        // A wildcard bind (0.0.0.0, for LAN clients) is not a
                        // navigable host; the window always loads via loopback.
                        let mut window_addr = core.addr;
                        if window_addr.ip().is_unspecified() {
                            window_addr.set_ip(std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST));
                        }
                        let url = format!("http://{}/?token={}", window_addr, token);
                        let result = WebviewWindowBuilder::new(
                            &handle,
                            "main",
                            WebviewUrl::External(url.parse().expect("valid loopback url")),
                        )
                        .title("Agora")
                        .inner_size(1240.0, 840.0)
                        .min_inner_size(480.0, 400.0)
                        .build();
                        if let Err(e) = result {
                            tracing::error!("window failed: {e}");
                            handle.exit(1);
                        }
                    }
                    Err(e) => {
                        tracing::error!("agora core failed to start: {e}");
                        handle.exit(1);
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Agora")
        .run(|app, event| match event {
            // Keep running with zero visible windows (background hub);
            // an explicit quit (Cmd-Q / dock menu) carries an exit code.
            tauri::RunEvent::ExitRequested { api, code, .. } => {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
            // Dock icon click while hidden: bring the window back.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            _ => {}
        });
}
