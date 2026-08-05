//! Native macOS notifications via UNUserNotificationCenter.
//!
//! tauri-plugin-notification still posts through the deprecated
//! NSUserNotificationCenter (via notify-rust), which modern macOS delivers
//! silently into Notification Center without popping a banner. The modern
//! UserNotifications framework is the only reliable path, so we call it
//! directly. Requires running from a real .app bundle — the framework
//! aborts for bare executables, hence the bundle guard.

#![cfg(target_os = "macos")]

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use agora_core::hub::{NotifyEvent, ReadNotifyEvent};
use block2::RcBlock;
use objc2::runtime::Bool;
use objc2_foundation::{NSArray, NSBundle, NSError, NSString};
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

#[derive(Clone)]
struct Delivered {
    identifier: String,
    message_id: i64,
}

static DELIVERED: OnceLock<Mutex<HashMap<String, Vec<Delivered>>>> = OnceLock::new();

fn conversation_key(channel_id: &str, thread_id: Option<i64>) -> String {
    thread_id.map_or_else(
        || format!("channel:{channel_id}"),
        |id| format!("thread:{id}"),
    )
}

/// Post a banner notification and remember enough identity to clear it when read.
pub fn notify(event: &NotifyEvent) {
    let Some(id) = post(&event.title, &event.body) else {
        return;
    };
    let key = conversation_key(&event.channel_id, event.thread_id);
    DELIVERED
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .entry(key)
        .or_default()
        .push(Delivered {
            identifier: id,
            message_id: event.message_id,
        });
}

fn post(title: &str, body: &str) -> Option<String> {
    if !in_bundle() {
        return None;
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
    Some(id)
}

/// Post a shell-level notification (updates, lifecycle notices) that is not
/// associated with chat read state.
pub fn notify_untracked(title: &str, body: &str) {
    let _ = post(title, body);
}

/// Remove cards for this exact conversation at or below its read marker.
/// The registry is intentionally process-local; restart recovery is deferred.
pub fn clear_read(event: &ReadNotifyEvent) {
    if !in_bundle() {
        return;
    }
    let key = conversation_key(&event.channel_id, event.thread_id);
    let mut registry = DELIVERED.get_or_init(Default::default).lock().unwrap();
    let Some(entries) = registry.get_mut(&key) else {
        return;
    };
    let mut ids = Vec::new();
    entries.retain(|entry| {
        if entry.message_id <= event.last_read_id {
            ids.push(NSString::from_str(&entry.identifier));
            false
        } else {
            true
        }
    });
    if entries.is_empty() {
        registry.remove(&key);
    }
    drop(registry);
    if ids.is_empty() {
        return;
    }
    let ids = NSArray::from_retained_slice(&ids);
    UNUserNotificationCenter::currentNotificationCenter()
        .removeDeliveredNotificationsWithIdentifiers(&ids);
}
