//! Native macOS notifications via UNUserNotificationCenter.
//!
//! tauri-plugin-notification still posts through the deprecated
//! NSUserNotificationCenter (via notify-rust), which modern macOS delivers
//! silently into Notification Center without popping a banner. The modern
//! UserNotifications framework is the only reliable path, so we call it
//! directly. Requires running from a real .app bundle — the framework
//! aborts for bare executables, hence the bundle guard.

#![cfg(target_os = "macos")]

use std::sync::atomic::{AtomicU64, Ordering};

use block2::RcBlock;
use objc2::runtime::Bool;
use objc2_foundation::{NSBundle, NSError, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNMutableNotificationContent, UNNotificationRequest,
    UNNotificationSound, UNUserNotificationCenter,
};

/// UNUserNotificationCenter aborts outside a bundle (e.g. `cargo run` on the
/// bare binary), so every entry point checks this first.
fn in_bundle() -> bool {
    NSBundle::mainBundle().bundleIdentifier().is_some()
}

/// Ask for notification permission (shows the system prompt on first run).
pub fn request_authorization() {
    if !in_bundle() {
        tracing::warn!("not running from an app bundle; notifications unavailable");
        return;
    }
    unsafe {
        let center = UNUserNotificationCenter::currentNotificationCenter();
        let options = UNAuthorizationOptions::Alert
            | UNAuthorizationOptions::Sound
            | UNAuthorizationOptions::Badge;
        let handler = RcBlock::new(|granted: Bool, error: *mut NSError| {
            if granted.as_bool() {
                tracing::info!("notification permission granted");
            } else if let Some(err) = error.as_ref() {
                tracing::warn!("notification permission denied: {err:?}");
            } else {
                tracing::warn!("notification permission denied by the user");
            }
        });
        center.requestAuthorizationWithOptions_completionHandler(options, &handler);
    }
}

/// Post a banner notification.
pub fn notify(title: &str, body: &str) {
    if !in_bundle() {
        return;
    }
    // Unique per request or the new one silently replaces the previous.
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let id = format!("agora-msg-{}", SEQ.fetch_add(1, Ordering::Relaxed));
    unsafe {
        let center = UNUserNotificationCenter::currentNotificationCenter();
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(title));
        content.setBody(&NSString::from_str(body));
        content.setSound(Some(&UNNotificationSound::defaultSound()));
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &NSString::from_str(&id),
            &content,
            None, // deliver immediately
        );
        let handler = RcBlock::new(|error: *mut NSError| {
            if let Some(err) = error.as_ref() {
                tracing::warn!("notification failed: {err:?}");
            }
        });
        center.addNotificationRequest_withCompletionHandler(&request, Some(&handler));
    }
}
