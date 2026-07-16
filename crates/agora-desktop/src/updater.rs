//! Direct-download auto-updates via tauri-plugin-updater.
//!
//! The feed is `latest.json` on the newest GitHub Release (see
//! `tauri.conf.json > plugins.updater`); artifacts are signed with the
//! project's updater key, which is independent of Apple code signing — it
//! proves the download came from us even if the transport is compromised.
//!
//! Policy: a silent check at startup installs any update in the background
//! and mentions it with a notification (the new version runs from the next
//! launch — no forced restart under the user's feet). The Server menu's
//! "Check for Updates…" is the loud path: it reports "up to date" / errors
//! and relaunches immediately on success, since the user explicitly asked.

use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

/// Check the feed and install any newer version. `Ok(Some(version))` means
/// an update was downloaded and installed (pending a relaunch).
async fn check_and_install(handle: &AppHandle) -> Result<Option<String>, String> {
    let updater = handle.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    let version = update.version.clone();
    update
        .download_and_install(|_received, _total| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    Ok(Some(version))
}

/// Startup path: quiet on "no update" and on errors (a dev build or an
/// offline launch shouldn't nag), one notification when something landed.
pub async fn check_on_startup(handle: AppHandle, notify: impl Fn(&str, &str)) {
    match check_and_install(&handle).await {
        Ok(Some(version)) => {
            tracing::info!("update {version} installed; applies on next launch");
            notify(
                "Agora updated",
                &format!("Version {version} is installed and will run from the next launch."),
            );
        }
        Ok(None) => {}
        Err(e) => tracing::warn!("update check failed: {e}"),
    }
}

/// Menu path: the user asked, so every outcome gets feedback and a found
/// update applies right away.
pub async fn check_from_menu(handle: AppHandle, notify: impl Fn(&str, &str)) {
    match check_and_install(&handle).await {
        Ok(Some(version)) => {
            notify("Agora updated", &format!("Restarting into version {version}…"));
            handle.restart();
        }
        Ok(None) => notify("Agora is up to date", "You're already on the latest version."),
        Err(e) => notify("Update check failed", &e),
    }
}
