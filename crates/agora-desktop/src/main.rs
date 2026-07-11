//! Agora desktop: a Tauri shell that fronts either server.
//!
//! Two modes, chosen in `desktop.json` (see [`settings`]):
//! - **embedded** (default): boot agora-core in-process on loopback and point
//!   the window at it — identical to the headless deployment, so the UI code
//!   has exactly one environment.
//! - **remote**: skip the local hub entirely and point the window at a
//!   deployed agora-server (the bundled `connect.html` page validates the
//!   URL + owner token and flips modes).
//!
//! In embedded mode the hub must outlive the window: agents reply
//! asynchronously and their messages land in this process's database. So
//! closing the window only hides it (the app keeps running in the dock;
//! clicking the icon reopens it) and Cmd-Q is the real quit.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, OnceLock};

use tauri::menu::{Menu, SubmenuBuilder};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};
#[cfg(not(target_os = "macos"))]
use tauri_plugin_notification::NotificationExt;

mod google_login;
#[cfg(target_os = "macos")]
mod notify;
mod remote_notify;
mod settings;

use settings::{DesktopSettings, Mode};

/// The embedded hub, once the core is up — the window-event handler flips
/// its ui_active flag so unseen messages notify only while unfocused.
static HUB: OnceLock<Arc<agora_core::hub::Hub>> = OnceLock::new();

/// The embedded server, booted at most once per process.
static EMBEDDED: tokio::sync::OnceCell<Embedded> = tokio::sync::OnceCell::const_new();

/// The remote-mode notifier task, if one is running. Replaced (old one
/// aborted) on every mode/settings change so at most one socket is live.
static REMOTE_NOTIFIER: Mutex<Option<tauri::async_runtime::JoinHandle<()>>> = Mutex::new(None);

struct Embedded {
    addr: std::net::SocketAddr,
    token: String,
}

impl Embedded {
    fn url(&self) -> Url {
        // A wildcard bind (0.0.0.0, set to let phones on the LAN in) is not a
        // routable destination — the webview must dial loopback instead.
        let mut addr = self.addr;
        if addr.ip().is_unspecified() {
            addr.set_ip(std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST));
        }
        format!("http://{}/?token={}", addr, self.token)
            .parse()
            .expect("valid loopback url")
    }
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        // target="_blank" links in the UI open in the system browser instead
        // of dying inside the webview (see capabilities/remote.json).
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_server_settings,
            set_server_settings,
            connect_remote,
            open_current_server,
            google_sign_in,
            probe_server
        ])
        .menu(|handle| {
            let menu = Menu::default(handle)?;
            let server = SubmenuBuilder::new(handle, "Server")
                .text("server-settings", "Server Settings…")
                .separator()
                .text("sign-out", "Sign Out")
                .build()?;
            menu.append(&server)?;
            Ok(menu)
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "server-settings" => open_main(app, connect_page_url(true)),
            "sign-out" => sign_out(app),
            _ => {}
        })
        .on_window_event(|window, event| {
            match event {
                WindowEvent::Focused(focused) => {
                    remote_notify::UI_FOCUSED.store(*focused, Ordering::Relaxed);
                    if let Some(hub) = HUB.get() {
                        hub.set_ui_active(*focused);
                    }
                }
                // Close = hide: agents keep processing and replies keep
                // landing (and notifying) while the window is away.
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = window.hide();
                    remote_notify::UI_FOCUSED.store(false, Ordering::Relaxed);
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
            let handle = app.handle().clone();
            let data_dir = app.path().app_data_dir()?;
            let desktop = settings::load(&data_dir);
            sync_remote_notifier(&handle, &desktop);
            tauri::async_runtime::spawn(async move {
                match desktop.mode {
                    // Remote: open the connect page; it validates the stored
                    // URL/token (via the connect_remote command) and navigates.
                    Mode::Remote => open_main(&handle, connect_page_url(false)),
                    Mode::Embedded => match ensure_embedded(&handle).await {
                        Ok(embedded) => open_main(&handle, embedded.url()),
                        Err(e) => {
                            tracing::error!("agora core failed to start: {e}");
                            handle.exit(1);
                        }
                    },
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

// ------------------------------------------------------------ embedded core

/// Boot the embedded server exactly once and return its address + token.
async fn ensure_embedded(handle: &AppHandle) -> anyhow::Result<&'static Embedded> {
    let handle = handle.clone();
    EMBEDDED
        .get_or_try_init(|| async move {
            let data_dir = handle.path().app_data_dir()?;
            // Bundled UI: <bundle>/Resources/ui in a build; the repo's ui/ in dev.
            let ui_dir = handle
                .path()
                .resolve("ui", BaseDirectory::Resource)
                .ok()
                .filter(|p| p.join("index.html").exists())
                .or_else(|| {
                    let dev =
                        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../ui");
                    dev.join("index.html").exists().then_some(dev)
                });
            let core = agora_core::run(data_dir, ui_dir).await?;
            // New messages landing while the window is unfocused (i.e.
            // unseen) surface as native notifications.
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
            // A staged data import restarts the app to apply it at boot.
            let restart_handle = handle.clone();
            *core.state.restart_handler.lock().unwrap() = Some(Box::new(move || {
                restart_handle.restart();
            }));
            Ok(Embedded {
                addr: core.addr,
                token: core.state.config.owner_token(),
            })
        })
        .await
}

// ----------------------------------------------------------------- commands

#[tauri::command]
fn get_server_settings(app: AppHandle) -> Result<DesktopSettings, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(settings::load(&data_dir))
}

/// Persist the chosen mode and navigate the window to it. Remote settings
/// are validated against the server before anything is saved.
#[tauri::command]
async fn set_server_settings(app: AppHandle, settings: DesktopSettings) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    match settings.mode {
        Mode::Remote => {
            let url = settings
                .remote_url()
                .ok_or("Server URL and owner token are both required")?;
            validate_remote(&settings).await?;
            settings::save(&data_dir, &settings).map_err(|e| e.to_string())?;
            open_main(&app, url.parse().map_err(|_| "Invalid server URL")?);
        }
        Mode::Embedded => {
            settings::save(&data_dir, &settings).map_err(|e| e.to_string())?;
            let embedded = ensure_embedded(&app)
                .await
                .map_err(|e| format!("embedded server failed to start: {e}"))?;
            open_main(&app, embedded.url());
        }
    }
    sync_remote_notifier(&app, &settings);
    Ok(())
}

/// Validate the stored remote settings and navigate to the server on
/// success. The connect page calls this on load in remote mode.
#[tauri::command]
async fn connect_remote(app: AppHandle) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let stored = settings::load(&data_dir);
    let url = stored
        .remote_url()
        .ok_or("No remote server configured yet")?;
    validate_remote(&stored).await?;
    open_main(&app, url.parse().map_err(|_| "Invalid server URL")?);
    sync_remote_notifier(&app, &stored);
    Ok(())
}

/// Leave the settings page without changing anything: navigate back to
/// whatever server the saved settings point at.
#[tauri::command]
async fn open_current_server(app: AppHandle) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let stored = settings::load(&data_dir);
    match (stored.mode, stored.remote_url()) {
        (Mode::Remote, Some(url)) => {
            open_main(&app, url.parse().map_err(|_| "Invalid server URL")?);
        }
        _ => {
            let embedded = ensure_embedded(&app)
                .await
                .map_err(|e| format!("embedded server failed to start: {e}"))?;
            open_main(&app, embedded.url());
        }
    }
    sync_remote_notifier(&app, &stored);
    Ok(())
}

/// Menu sign-out. Remote mode: drop the stored session/owner token (the
/// server URL stays, so the connect page lands on its sign-in step) and stop
/// the notifier socket that was using it. Embedded mode has no credential to
/// drop — the local owner token *is* the server — so just open the picker.
fn sign_out(app: &AppHandle) {
    let Ok(data_dir) = app.path().app_data_dir() else { return };
    let mut stored = settings::load(&data_dir);
    match stored.mode {
        Mode::Remote => {
            stored.token = None;
            if let Err(e) = settings::save(&data_dir, &stored) {
                tracing::warn!("sign-out failed to save settings: {e}");
                return;
            }
            sync_remote_notifier(app, &stored);
            open_main(app, connect_page_url(false));
        }
        Mode::Embedded => open_main(app, connect_page_url(true)),
    }
}

/// What sign-in methods a server offers. The connect page calls this before
/// showing its sign-in step (the webview can't fetch a remote origin itself —
/// CORS). Unreachable hosts are an Err; a reachable host that doesn't answer
/// the probe as expected still allows owner-token sign-in.
#[tauri::command]
async fn probe_server(url: String) -> Result<serde_json::Value, String> {
    let base = url.trim().trim_end_matches('/').to_string();
    if !base.starts_with("http://") && !base.starts_with("https://") {
        return Err("Server URL must start with http:// or https://".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let response = ureq::get(&format!("{base}/api/auth/config"))
            .timeout(std::time::Duration::from_secs(10))
            .call();
        match response {
            Ok(r) => {
                let google = r
                    .into_string()
                    .ok()
                    .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
                    .map(|v| v["google"]["enabled"] == serde_json::Value::Bool(true))
                    .unwrap_or(false);
                Ok(serde_json::json!({"google": google}))
            }
            Err(ureq::Error::Status(_, _)) => Ok(serde_json::json!({"google": false})),
            Err(e) => Err(format!("Could not reach the server: {e}")),
        }
    })
    .await
    .map_err(|_| "probe task failed".to_string())?
}

/// Google sign-in against a remote server: run the loopback OAuth dance in
/// the system browser, then persist the returned session token exactly like
/// a pasted owner token (remote mode) and navigate to the server.
#[tauri::command]
async fn google_sign_in(
    app: AppHandle,
    url: String,
    select_account: Option<bool>,
) -> Result<(), String> {
    let base = url.trim().trim_end_matches('/').to_string();
    if !base.starts_with("http://") && !base.starts_with("https://") {
        return Err("Server URL must start with http:// or https://".into());
    }
    let token = google_login::run_flow(base.clone(), select_account.unwrap_or(false)).await?;
    let settings = DesktopSettings {
        mode: Mode::Remote,
        url: Some(base),
        token: Some(token),
    };
    validate_remote(&settings).await?;
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    settings::save(&data_dir, &settings).map_err(|e| e.to_string())?;
    let url = settings.remote_url().ok_or("sign-in produced no session")?;
    open_main(&app, url.parse().map_err(|_| "Invalid server URL")?);
    sync_remote_notifier(&app, &settings);
    Ok(())
}

/// GET /api/me with the owner token; distinguishes bad-token from unreachable.
async fn validate_remote(settings: &DesktopSettings) -> Result<(), String> {
    let base = settings
        .url
        .as_deref()
        .unwrap_or_default()
        .trim_end_matches('/')
        .to_string();
    if !base.starts_with("http://") && !base.starts_with("https://") {
        return Err("Server URL must start with http:// or https://".into());
    }
    let token = settings.token.clone().unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        let response = ureq::get(&format!("{base}/api/me"))
            .set("authorization", &format!("Bearer {token}"))
            .timeout(std::time::Duration::from_secs(10))
            .call();
        match response {
            Ok(_) => Ok(()),
            Err(ureq::Error::Status(401, _)) => Err("The server rejected that owner token".into()),
            Err(ureq::Error::Status(code, _)) => {
                Err(format!("Server responded with HTTP {code} — is that an Agora server?"))
            }
            Err(e) => Err(format!("Could not reach the server: {e}")),
        }
    })
    .await
    .map_err(|_| "validation task failed".to_string())?
}

// ------------------------------------------------------------ notifications

/// Deliver a banner through the platform path (shared with embedded mode).
#[cfg_attr(target_os = "macos", allow(unused_variables))]
fn deliver_notification(handle: &AppHandle, title: &str, body: &str) {
    #[cfg(target_os = "macos")]
    notify::notify(title, body);
    #[cfg(not(target_os = "macos"))]
    {
        let result = handle.notification().builder().title(title).body(body).show();
        if let Err(e) = result {
            tracing::warn!("notification failed: {e}");
        }
    }
}

/// Reconcile the remote-notifier task with the given settings: the old task
/// (if any) is aborted, and a fresh one starts iff we're in remote mode with
/// a full URL + token. Embedded mode keeps using the in-process hub notifier.
fn sync_remote_notifier(handle: &AppHandle, settings: &DesktopSettings) {
    let mut guard = REMOTE_NOTIFIER.lock().unwrap();
    if let Some(task) = guard.take() {
        task.abort();
    }
    if settings.mode != Mode::Remote || settings.remote_url().is_none() {
        return;
    }
    let (url, token) = (
        settings.url.clone().unwrap_or_default().trim_end_matches('/').to_string(),
        settings.token.clone().unwrap_or_default(),
    );
    let handle = handle.clone();
    let deliver: remote_notify::Deliver =
        Arc::new(move |title, body| deliver_notification(&handle, title, body));
    *guard = Some(tauri::async_runtime::spawn(remote_notify::run(deliver, url, token)));
}

// ------------------------------------------------------------------- window

/// Navigate the main window (creating it if needed) to the given URL.
fn open_main(handle: &AppHandle, url: Url) {
    if let Some(window) = handle.get_webview_window("main") {
        let _ = window.navigate(url);
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let webview_url = match url.scheme() {
        "http" | "https" => WebviewUrl::External(url),
        _ => WebviewUrl::CustomProtocol(url),
    };
    let result = WebviewWindowBuilder::new(handle, "main", webview_url)
        .title("Agora")
        .inner_size(1240.0, 840.0)
        .min_inner_size(480.0, 400.0)
        // Tauri's native drag-drop handler swallows OS file drops before the
        // webview sees them; the UI relies on HTML5 ondrop, so turn it off.
        .disable_drag_drop_handler()
        .build();
    if let Err(e) = result {
        tracing::error!("window failed: {e}");
    }
}

/// The bundled connect page, on the platform's app protocol. `edit` skips
/// the auto-connect and goes straight to the form.
fn connect_page_url(edit: bool) -> Url {
    let base = if cfg!(any(target_os = "windows", target_os = "android")) {
        "http://tauri.localhost/connect.html"
    } else {
        "tauri://localhost/connect.html"
    };
    let full = if edit { format!("{base}?edit=1") } else { base.to_string() };
    full.parse().expect("valid app url")
}
