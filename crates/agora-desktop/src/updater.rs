//! Direct-download auto-updates via tauri-plugin-updater.
//!
//! The feed is `latest.json` on the newest GitHub Release (see
//! `tauri.conf.json > plugins.updater`); artifacts are signed with the
//! project's updater key, which is independent of Apple code signing — it
//! proves the download came from us even if the transport is compromised.
//!
//! Policy: a silent check at startup installs any update in the background
//! and mentions it with a notification (the new version runs from the next
//! launch — no forced restart under the user's feet). The app menu's
//! "Check for Updates…" is the loud, Sparkle-style path: native dialogs for
//! every outcome, install only on consent, restart only on consent.

use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::{Update, UpdaterExt};

async fn check(handle: &AppHandle) -> Result<Option<Update>, String> {
    let updater = handle.updater().map_err(|e| e.to_string())?;
    updater.check().await.map_err(|e| e.to_string())
}

/// Startup path: quiet on "no update" and on errors (a dev build or an
/// offline launch shouldn't nag), one notification when something landed.
pub async fn check_on_startup(handle: AppHandle, notify: impl Fn(&str, &str)) {
    match check(&handle).await {
        Ok(Some(update)) => {
            let version = update.version.clone();
            match update.download_and_install(|_received, _total| {}, || {}).await {
                Ok(()) => {
                    tracing::info!("update {version} installed; applies on next launch");
                    notify(
                        "Agora updated",
                        &format!("Version {version} is installed and will run from the next launch."),
                    );
                }
                Err(e) => tracing::warn!("update install failed: {e}"),
            }
        }
        Ok(None) => {}
        Err(e) => tracing::warn!("update check failed: {e}"),
    }
}

/// Menu path: the user asked, so every outcome gets a modal answer.
/// Blocking dialogs are fine here — this runs on an async-runtime worker
/// thread, never the main thread.
pub async fn check_from_menu(handle: AppHandle) {
    let current = handle.package_info().version.to_string();
    match check(&handle).await {
        Ok(None) => {
            handle
                .dialog()
                .message(format!("You're up to date. Agora {current} is the latest version."))
                .title("Software Update")
                .blocking_show();
        }
        Ok(Some(update)) => install_with_consent(&handle, update, &current).await,
        Err(e) => {
            handle
                .dialog()
                .message(format!("Couldn't check for updates.\n\n{e}"))
                .title("Software Update")
                .kind(MessageDialogKind::Error)
                .blocking_show();
        }
    }
}

async fn install_with_consent(handle: &AppHandle, update: Update, current: &str) {
    let version = update.version.clone();
    let install = handle
        .dialog()
        .message(format!(
            "Agora {version} is available (you have {current}).\n\nDownload and install now?"
        ))
        .title("Update Available")
        .buttons(MessageDialogButtons::OkCancelCustom("Install".into(), "Later".into()))
        .blocking_show();
    if !install {
        return;
    }
    if let Err(e) = update.download_and_install(|_received, _total| {}, || {}).await {
        handle
            .dialog()
            .message(format!("The update could not be installed.\n\n{e}"))
            .title("Software Update")
            .kind(MessageDialogKind::Error)
            .blocking_show();
        return;
    }
    let restart = handle
        .dialog()
        .message(format!(
            "Agora {version} is installed. Restart now to finish updating? \
             If you choose Later, it applies the next time Agora starts."
        ))
        .title("Update Installed")
        .buttons(MessageDialogButtons::OkCancelCustom("Restart Now".into(), "Later".into()))
        .blocking_show();
    if restart {
        handle.restart();
    }
}
