//! Google sign-in (OIDC authorization-code flow) + signed session tokens.
//!
//! Ported from Pantheo's `engine/auth/{oauth,tokens}.py`: the browser is sent
//! to Google's consent screen, the callback exchanges the returned code for an
//! `id_token` over a TLS back-channel, and we trust its claims after checking
//! `iss`/`aud`/`exp`/`email_verified` (no JWKS fetch — the token comes straight
//! from Google's token endpoint over TLS). A verified email on the configured
//! allowlist earns a short-lived HMAC session token, accepted everywhere the
//! owner token is. Google tokens themselves are never stored.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hmac::{Hmac, Mac};
use serde_json::Value;
use sha2::Sha256;

use crate::config::GoogleConfig;
use crate::store::new_token;

pub const GOOGLE_AUTH_URI: &str = "https://accounts.google.com/o/oauth2/v2/auth";
pub const GOOGLE_TOKEN_URI: &str = "https://oauth2.googleapis.com/token";
const GOOGLE_ISSUERS: [&str; 2] = ["https://accounts.google.com", "accounts.google.com"];
const GOOGLE_SCOPE: &str = "openid email profile";
/// Seconds of leeway on `exp` checks (id_token and sessions alike).
const CLOCK_SKEW: i64 = 120;

/// Session lifetime. Pantheo uses 12h for its admin dashboard; Agora sessions
/// back long-lived desktop/mobile clients, so they last longer and a re-login
/// is one Google tap.
pub const SESSION_TTL_SECS: i64 = 30 * 24 * 3600;

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------- session tokens

fn sign(msg: &str, secret: &str) -> String {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("hmac accepts any key length");
    mac.update(msg.as_bytes());
    URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
}

/// A stateless `<payload_b64>.<sig_b64>` token, mirroring Pantheo's shape:
/// payload `{"u": username, "iat": ..., "exp": ...}` signed with HMAC-SHA256.
/// Logout just drops the client copy; rotating the secret invalidates all.
pub fn mint_session(username: &str, secret: &str) -> String {
    let now = now_secs();
    let payload = serde_json::json!({"u": username, "iat": now, "exp": now + SESSION_TTL_SECS});
    let msg = URL_SAFE_NO_PAD.encode(payload.to_string());
    let sig = sign(&msg, secret);
    format!("{msg}.{sig}")
}

/// The token's subject if it is authentic and unexpired.
pub fn verify_session(token: &str, secret: &str) -> Option<String> {
    let (msg, sig) = token.split_once('.')?;
    let expected = sign(msg, secret);
    if !constant_time_eq(sig, &expected) {
        return None;
    }
    let payload: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(msg).ok()?).ok()?;
    if payload["exp"].as_i64()? < now_secs() {
        return None;
    }
    payload["u"].as_str().map(str::to_string)
}

fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() || a.is_empty() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

// ------------------------------------------------------------- oauth flow

/// Where the callback may bounce the session token to, besides this origin's
/// own web UI: the desktop shell's loopback listener and the mobile app's
/// deep link (`exp://` is the Expo dev-client flavor of the same app).
pub fn allowed_next(next: &str) -> bool {
    ["http://127.0.0.1:", "http://localhost:", "agora://", "exp://"]
        .iter()
        .any(|p| next.starts_with(p))
}

/// The `state` round-tripped through Google: a CSRF nonce plus the validated
/// `next` target, so the callback needs no server-side session to find it.
pub fn encode_state(next: &str) -> String {
    format!("{}.{}", new_token(), URL_SAFE_NO_PAD.encode(next))
}

/// The `next` target carried in a state produced by [`encode_state`].
pub fn next_from_state(state: &str) -> Option<String> {
    let (_, next_b64) = state.split_once('.')?;
    let next = String::from_utf8(URL_SAFE_NO_PAD.decode(next_b64).ok()?).ok()?;
    // Re-check at redeem time: the cookie lives client-side. "/" is the
    // web UI's own landing.
    (next == "/" || allowed_next(&next)).then_some(next)
}

pub fn state_matches(cookie: &str, param: &str) -> bool {
    constant_time_eq(cookie, param)
}

/// The Google consent URL to redirect the browser to (step 1 of the flow).
///
/// No `prompt` by default: a returning user with one active Google session
/// bounces straight through with no screen at all. `select_account` is only
/// forced when the client asks (retry after `no_access`) — otherwise Google
/// would keep silently re-picking the same disallowed account.
pub fn build_consent_url(
    gc: &GoogleConfig,
    redirect_uri: &str,
    state: &str,
    select_account: bool,
) -> String {
    let mut pairs = vec![
        ("client_id", gc.client_id.as_str()),
        ("redirect_uri", redirect_uri),
        ("response_type", "code"),
        ("scope", GOOGLE_SCOPE),
        ("state", state),
        ("access_type", "online"),
    ];
    if select_account {
        pairs.push(("prompt", "select_account"));
    }
    format!("{GOOGLE_AUTH_URI}?{}", form_urlencoded(&pairs))
}

/// Exchange an authorization `code` for Google's token response (blocking —
/// call via `spawn_blocking` from async handlers).
pub fn exchange_code(gc: &GoogleConfig, code: &str, redirect_uri: &str) -> anyhow::Result<Value> {
    let response = ureq::post(GOOGLE_TOKEN_URI)
        .timeout(std::time::Duration::from_secs(10))
        .send_form(&[
            ("code", code),
            ("client_id", &gc.client_id),
            ("client_secret", &gc.client_secret),
            ("redirect_uri", redirect_uri),
            ("grant_type", "authorization_code"),
        ])
        .map_err(|e| anyhow::anyhow!("token exchange failed: {e}"))?;
    Ok(serde_json::from_str(&response.into_string()?)?)
}

/// Validate a Google `id_token` and return the signed-in email.
///
/// Trusts the back-channel TLS exchange and checks the security-relevant
/// claims: issuer, audience, expiry, verified email, email allowlist.
pub fn decode_id_token(id_token: &str, gc: &GoogleConfig) -> anyhow::Result<String> {
    let mut parts = id_token.split('.');
    let payload_b64 = parts
        .nth(1)
        .ok_or_else(|| anyhow::anyhow!("malformed id_token"))?;
    let claims: Value = serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(payload_b64.trim_end_matches('='))
            .map_err(|_| anyhow::anyhow!("malformed id_token payload"))?,
    )?;

    let iss = claims["iss"].as_str().unwrap_or_default();
    if !GOOGLE_ISSUERS.contains(&iss) {
        anyhow::bail!("unexpected token issuer");
    }
    if claims["aud"].as_str() != Some(gc.client_id.as_str()) {
        anyhow::bail!("token audience mismatch");
    }
    if claims["exp"].as_i64().unwrap_or(0) < now_secs() - CLOCK_SKEW {
        anyhow::bail!("token has expired");
    }
    let email = claims["email"].as_str().unwrap_or_default().trim().to_lowercase();
    if email.is_empty() {
        anyhow::bail!("no email in token");
    }
    if claims["email_verified"] != Value::Bool(true) {
        anyhow::bail!("email is not verified");
    }
    if !gc.allowed_emails.iter().any(|e| e == &email) {
        anyhow::bail!("email is not on the allowlist");
    }
    Ok(email)
}

/// Minimal x-www-form-urlencoded builder (no extra dependency).
pub fn form_urlencoded(pairs: &[(&str, &str)]) -> String {
    pairs
        .iter()
        .map(|(k, v)| format!("{}={}", urlencode(k), urlencode(v)))
        .collect::<Vec<_>>()
        .join("&")
}

pub fn urlencode(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for b in raw.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gc() -> GoogleConfig {
        GoogleConfig {
            client_id: "cid.apps.googleusercontent.com".into(),
            client_secret: "shh".into(),
            allowed_emails: vec!["tom@example.com".into()],
        }
    }

    fn fake_id_token(claims: Value) -> String {
        let payload = URL_SAFE_NO_PAD.encode(claims.to_string());
        format!("eyJhbGciOiJSUzI1NiJ9.{payload}.sig")
    }

    fn valid_claims() -> Value {
        serde_json::json!({
            "iss": "https://accounts.google.com",
            "aud": "cid.apps.googleusercontent.com",
            "exp": now_secs() + 3600,
            "email": "Tom@Example.com",
            "email_verified": true,
        })
    }

    #[test]
    fn session_roundtrip() {
        let token = mint_session("me", "secret");
        assert_eq!(verify_session(&token, "secret").as_deref(), Some("me"));
        assert!(verify_session(&token, "other-secret").is_none());
        assert!(verify_session("garbage", "secret").is_none());
        assert!(verify_session("", "secret").is_none());
    }

    #[test]
    fn tampered_session_is_rejected() {
        let token = mint_session("me", "secret");
        let (msg, sig) = token.split_once('.').unwrap();
        let payload = serde_json::json!({"u": "admin", "iat": 0, "exp": now_secs() + 999});
        let forged = format!("{}.{sig}", URL_SAFE_NO_PAD.encode(payload.to_string()));
        assert!(verify_session(&forged, "secret").is_none());
        let _ = msg;
    }

    #[test]
    fn expired_session_is_rejected() {
        let payload =
            serde_json::json!({"u": "me", "iat": now_secs() - 10, "exp": now_secs() - 1});
        let msg = URL_SAFE_NO_PAD.encode(payload.to_string());
        let token = format!("{msg}.{}", sign(&msg, "secret"));
        assert!(verify_session(&token, "secret").is_none());
    }

    #[test]
    fn id_token_happy_path_lowercases_email() {
        let token = fake_id_token(valid_claims());
        assert_eq!(decode_id_token(&token, &gc()).unwrap(), "tom@example.com");
    }

    #[test]
    fn id_token_rejects_bad_claims() {
        for (key, value) in [
            ("iss", Value::from("https://evil.example")),
            ("aud", Value::from("other-client")),
            ("exp", Value::from(now_secs() - 3600)),
            ("email", Value::from("intruder@example.com")),
            ("email_verified", Value::from(false)),
        ] {
            let mut claims = valid_claims();
            claims[key] = value;
            assert!(
                decode_id_token(&fake_id_token(claims), &gc()).is_err(),
                "claim {key} should have failed"
            );
        }
        assert!(decode_id_token("not-a-jwt", &gc()).is_err());
    }

    #[test]
    fn consent_url_carries_client_and_redirect() {
        let url = build_consent_url(&gc(), "https://a.example/api/auth/google/callback", "st", false);
        assert!(url.starts_with(GOOGLE_AUTH_URI));
        assert!(url.contains("client_id=cid.apps.googleusercontent.com"));
        assert!(url.contains("redirect_uri=https%3A%2F%2Fa.example%2Fapi%2Fauth%2Fgoogle%2Fcallback"));
        assert!(url.contains("state=st"));
        assert!(url.contains("scope=openid%20email%20profile"));
        // Silent re-auth by default; the chooser only on request.
        assert!(!url.contains("prompt="));
        let url = build_consent_url(&gc(), "https://a.example/cb", "st", true);
        assert!(url.contains("prompt=select_account"));
    }

    #[test]
    fn state_roundtrips_next_and_enforces_allowlist() {
        let state = encode_state("http://127.0.0.1:49213/callback");
        assert_eq!(
            next_from_state(&state).as_deref(),
            Some("http://127.0.0.1:49213/callback")
        );
        assert_eq!(next_from_state(&encode_state("/")).as_deref(), Some("/"));
        assert!(next_from_state(&encode_state("")).is_none());
        // A tampered cookie pointing somewhere else is refused at redeem time.
        assert!(next_from_state(&encode_state("https://evil.example/steal")).is_none());
        assert!(allowed_next("agora://auth"));
        assert!(allowed_next("exp://192.168.1.5:8081/--/auth"));
        assert!(!allowed_next("https://evil.example"));
        assert!(!allowed_next("http://localhost.evil.example/x"));
    }

    #[test]
    fn states_do_not_collide() {
        let a = encode_state("agora://auth");
        let b = encode_state("agora://auth");
        assert_ne!(a, b);
        assert!(state_matches(&a, &a));
        assert!(!state_matches(&a, &b));
    }
}
