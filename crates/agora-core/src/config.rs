//! App configuration persisted as `config.json` in the data dir.
//!
//! The admin key authenticates the (single) local user's UI/API calls; it
//! is generated on first run. Pairing tokens authenticate dial-in agent
//! bridges. Connections are the Pantheo (or compatible) endpoints the app
//! dials out to.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::store::new_token;

#[derive(Clone, Serialize, Deserialize)]
pub struct Connection {
    pub name: String,
    /// ws(s)://host:port/agora/connect
    pub url: String,
    pub token: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct PairingToken {
    pub token: String,
    pub name: String,
    pub created_at: f64,
}

fn default_true() -> bool {
    true
}

/// Resolved Google OAuth client settings (see [`Config::google`]).
#[derive(Clone)]
pub struct GoogleConfig {
    pub client_id: String,
    pub client_secret: String,
    pub allowed_emails: Vec<String>,
}

/// Resolved Sign in with Apple settings (see [`Config::apple`]). The native
/// mobile flow needs no client secret: the identity token's audience is the
/// app's bundle id and its signature is checked against Apple's JWKS.
#[derive(Clone)]
pub struct AppleConfig {
    pub bundle_id: String,
    pub allowed_emails: Vec<String>,
}

/// Audience the mobile app's Apple identity tokens carry by default.
pub const DEFAULT_APPLE_BUNDLE_ID: &str = "app.agora.mobile";

fn default_username() -> String {
    "me".to_string()
}

fn default_instance_name() -> String {
    "My Agora".to_string()
}

#[derive(Clone, Serialize, Deserialize)]
pub struct ConfigData {
    /// Formerly `owner_token`; the alias keeps existing config.json files
    /// loading (a miss here would regenerate the key and lock clients out).
    #[serde(default, alias = "owner_token")]
    pub admin_key: String,
    /// Signs the short-lived session tokens minted by Google sign-in.
    /// Generated once; rotating it signs every session out.
    #[serde(default)]
    pub session_secret: String,
    /// Stable identity this app declares to every linked Pantheo (an
    /// `identify` frame after connect), so an instance serving several Agoras
    /// can keep their sessions and channels apart. Generated once, kept for
    /// the life of the data dir.
    #[serde(default)]
    pub instance_id: String,
    /// Human-readable name shown alongside this app's chats on the other side.
    #[serde(default = "default_instance_name")]
    pub instance_name: String,
    #[serde(default = "default_username")]
    pub username: String,
    /// Loopback by default; set 0.0.0.0 to accept LAN bridges.
    #[serde(default = "default_bind")]
    pub bind: String,
    #[serde(default = "default_port")]
    pub port: u16,
    /// When true, refuse plaintext `ws://`/`http://` to non-loopback hosts on
    /// outbound connections (the token and all traffic would otherwise travel
    /// in the clear). Off by default so LAN/dev setups keep working; turn it on
    /// for deployments where every peer is reachable over TLS.
    #[serde(default)]
    pub require_tls: bool,
    #[serde(default)]
    pub connections: Vec<Connection>,
    #[serde(default)]
    pub pairing_tokens: Vec<PairingToken>,
    /// Per-attachment upload cap, megabytes.
    #[serde(default = "default_max_file_mb")]
    pub max_file_mb: u64,
    /// Google OAuth client (Web application type). Both must be set for
    /// Google sign-in to be offered.
    #[serde(default)]
    pub google_client_id: String,
    #[serde(default)]
    pub google_client_secret: String,
    /// Google accounts that may sign in without a pending invite
    /// (lowercased) — pre-account installs used this as the whole gate, so
    /// it keeps working as a standing allowlist. Everyone else needs an
    /// existing account or an invite created on the admin Users page.
    #[serde(default)]
    pub google_allowed_emails: Vec<String>,
    /// Sign in with Apple: emails that may sign in without an invite
    /// (lowercased; a Hide-My-Email relay address counts — it is stable per
    /// Apple ID and app). Apple sign-in is offered when this list is
    /// non-empty or `apple_bundle_id` is set explicitly.
    #[serde(default)]
    pub apple_allowed_emails: Vec<String>,
    /// iOS bundle id the identity token must be issued for. Empty means the
    /// stock mobile app id ([`DEFAULT_APPLE_BUNDLE_ID`]).
    #[serde(default)]
    pub apple_bundle_id: String,
    /// Public base URL (https://agora.example.com) used to build the OAuth
    /// redirect URI behind a proxy. When empty it is derived per request.
    #[serde(default)]
    pub public_url: String,
}

fn default_bind() -> String {
    "127.0.0.1".to_string()
}

fn default_port() -> u16 {
    4470
}

fn default_max_file_mb() -> u64 {
    10
}

impl Default for ConfigData {
    fn default() -> Self {
        Self {
            admin_key: new_token(),
            session_secret: new_token(),
            instance_id: new_token(),
            instance_name: default_instance_name(),
            username: default_username(),
            bind: default_bind(),
            port: default_port(),
            require_tls: false,
            connections: Vec::new(),
            pairing_tokens: Vec::new(),
            max_file_mb: default_max_file_mb(),
            google_client_id: String::new(),
            google_client_secret: String::new(),
            google_allowed_emails: Vec::new(),
            apple_allowed_emails: Vec::new(),
            apple_bundle_id: String::new(),
            public_url: String::new(),
        }
    }
}

pub struct Config {
    path: PathBuf,
    data: Mutex<ConfigData>,
}

impl Config {
    pub fn load(data_dir: &Path) -> anyhow::Result<Self> {
        std::fs::create_dir_all(data_dir)?;
        let path = data_dir.join("config.json");
        let mut data: ConfigData = match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
            Err(_) => ConfigData::default(),
        };
        if data.admin_key.is_empty() {
            data.admin_key = new_token();
        }
        if data.session_secret.is_empty() {
            data.session_secret = new_token();
        }
        if data.instance_id.is_empty() {
            data.instance_id = new_token();
        }
        if data.instance_name.trim().is_empty() {
            data.instance_name = default_instance_name();
        }
        let cfg = Self {
            path,
            data: Mutex::new(data),
        };
        cfg.save();
        Ok(cfg)
    }

    pub fn snapshot(&self) -> ConfigData {
        self.data.lock().unwrap().clone()
    }

    pub fn admin_key(&self) -> String {
        self.data.lock().unwrap().admin_key.clone()
    }

    pub fn username(&self) -> String {
        self.data.lock().unwrap().username.clone()
    }

    pub fn instance_id(&self) -> String {
        self.data.lock().unwrap().instance_id.clone()
    }

    pub fn instance_name(&self) -> String {
        self.data.lock().unwrap().instance_name.clone()
    }

    pub fn update<F: FnOnce(&mut ConfigData)>(&self, f: F) {
        {
            let mut data = self.data.lock().unwrap();
            f(&mut data);
        }
        self.save();
    }

    pub fn valid_pairing_token(&self, token: &str) -> Option<String> {
        let data = self.data.lock().unwrap();
        data.pairing_tokens
            .iter()
            .find(|t| constant_time_eq(&t.token, token))
            .map(|t| t.name.clone())
    }

    pub fn is_admin_key(&self, token: &str) -> bool {
        constant_time_eq(&self.data.lock().unwrap().admin_key, token)
    }

    pub fn session_secret(&self) -> String {
        self.data.lock().unwrap().session_secret.clone()
    }

    /// The Google OAuth client, when sign-in is configured (client id +
    /// secret). Who may sign in is decided per email at callback time
    /// (existing account, pending invite, or this allowlist), so an empty
    /// allowlist no longer disables the flow.
    pub fn google(&self) -> Option<GoogleConfig> {
        let data = self.data.lock().unwrap();
        if data.google_client_id.is_empty() || data.google_client_secret.is_empty() {
            return None;
        }
        Some(GoogleConfig {
            client_id: data.google_client_id.clone(),
            client_secret: data.google_client_secret.clone(),
            allowed_emails: data
                .google_allowed_emails
                .iter()
                .map(|e| e.trim().to_lowercase())
                .filter(|e| !e.is_empty())
                .collect(),
        })
    }

    /// Sign in with Apple, when configured: a non-empty email allowlist or
    /// an explicit bundle id (invite-only setups have no allowlist; setting
    /// the bundle id is the opt-in). The bundle id has a stock default.
    pub fn apple(&self) -> Option<AppleConfig> {
        let data = self.data.lock().unwrap();
        if data.apple_allowed_emails.is_empty() && data.apple_bundle_id.trim().is_empty() {
            return None;
        }
        let bundle_id = if data.apple_bundle_id.trim().is_empty() {
            DEFAULT_APPLE_BUNDLE_ID.to_string()
        } else {
            data.apple_bundle_id.trim().to_string()
        };
        Some(AppleConfig {
            bundle_id,
            allowed_emails: data
                .apple_allowed_emails
                .iter()
                .map(|e| e.trim().to_lowercase())
                .filter(|e| !e.is_empty())
                .collect(),
        })
    }

    pub fn public_url(&self) -> String {
        self.data
            .lock()
            .unwrap()
            .public_url
            .trim_end_matches('/')
            .to_string()
    }

    fn save(&self) {
        let data = self.data.lock().unwrap();
        if let Ok(text) = serde_json::to_string_pretty(&*data) {
            std::fs::write(&self.path, text).ok();
        }
    }
}

fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() || a.is_empty() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instance_identity_is_generated_once_and_stable() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = Config::load(dir.path()).unwrap();
        let id = cfg.instance_id();
        assert_eq!(id.len(), 32); // 16 random bytes, hex
        assert_eq!(cfg.instance_name(), "My Agora");
        cfg.update(|c| c.instance_name = "Home Agora".into());
        drop(cfg);
        // A reload keeps both the generated id and the chosen name.
        let cfg = Config::load(dir.path()).unwrap();
        assert_eq!(cfg.instance_id(), id);
        assert_eq!(cfg.instance_name(), "Home Agora");
    }

    #[test]
    fn google_requires_client_and_normalizes_emails() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = Config::load(dir.path()).unwrap();
        assert!(cfg.google().is_none());
        cfg.update(|c| c.google_client_id = "cid".into());
        // Secret still missing -> disabled.
        assert!(cfg.google().is_none());
        cfg.update(|c| c.google_client_secret = "shh".into());
        // Invite-only: sign-in is offered with an empty allowlist (each
        // email is judged at callback time against accounts/invites).
        let gc = cfg.google().expect("client configured");
        assert!(gc.allowed_emails.is_empty());
        cfg.update(|c| c.google_allowed_emails = vec![" Tom@Example.COM ".into()]);
        let gc = cfg.google().expect("fully configured");
        assert_eq!(gc.allowed_emails, vec!["tom@example.com"]);
    }

    #[test]
    fn apple_requires_allowlist_or_bundle_id() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = Config::load(dir.path()).unwrap();
        assert!(cfg.apple().is_none());
        cfg.update(|c| c.apple_allowed_emails = vec![" Tom@Example.COM ".into()]);
        let ac = cfg.apple().expect("configured");
        assert_eq!(ac.bundle_id, DEFAULT_APPLE_BUNDLE_ID);
        assert_eq!(ac.allowed_emails, vec!["tom@example.com"]);
        cfg.update(|c| c.apple_bundle_id = "app.custom.ios".into());
        assert_eq!(cfg.apple().unwrap().bundle_id, "app.custom.ios");
        // Invite-only: explicit bundle id alone enables the flow.
        cfg.update(|c| c.apple_allowed_emails = Vec::new());
        let ac = cfg.apple().expect("bundle id opt-in");
        assert!(ac.allowed_emails.is_empty());
    }

    #[test]
    fn session_secret_is_generated_and_persists() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = Config::load(dir.path()).unwrap();
        let secret = cfg.session_secret();
        assert!(!secret.is_empty());
        drop(cfg);
        let cfg = Config::load(dir.path()).unwrap();
        assert_eq!(cfg.session_secret(), secret);
    }

    #[test]
    fn legacy_config_without_identity_gets_one() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("config.json"),
            r#"{"admin_key": "aaaa", "username": "tom"}"#,
        )
        .unwrap();
        let cfg = Config::load(dir.path()).unwrap();
        assert!(!cfg.instance_id().is_empty());
        assert_eq!(cfg.instance_name(), "My Agora");
        assert_eq!(cfg.username(), "tom");
    }

    #[test]
    fn legacy_owner_token_field_still_loads_and_is_rewritten() {
        // Pre-rename config.json: the key must load under its old name (a
        // miss would regenerate it and lock every client out) and be saved
        // back under the new one.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("config.json"),
            r#"{"owner_token": "cafe1234", "username": "tom"}"#,
        )
        .unwrap();
        let cfg = Config::load(dir.path()).unwrap();
        assert_eq!(cfg.admin_key(), "cafe1234");
        assert!(cfg.is_admin_key("cafe1234"));
        drop(cfg);
        let text = std::fs::read_to_string(dir.path().join("config.json")).unwrap();
        assert!(text.contains("\"admin_key\": \"cafe1234\""));
        assert!(!text.contains("owner_token"));
    }
}
