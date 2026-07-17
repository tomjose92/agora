//! Google + Apple sign-in and the signed session tokens both mint.
//!
//! Google (OIDC authorization-code flow) is ported from Pantheo's
//! `engine/auth/{oauth,tokens}.py`: the browser is sent to Google's consent
//! screen, the callback exchanges the returned code for an `id_token` over a
//! TLS back-channel, and we trust its claims after checking
//! `iss`/`aud`/`exp`/`email_verified` (no JWKS fetch — the token comes straight
//! from Google's token endpoint over TLS).
//!
//! Sign in with Apple takes the native path instead: the iOS app runs Apple's
//! system sheet and posts the resulting identity token here. That token
//! arrives from the client, not from Apple, so its RS256 signature must be
//! verified against Apple's published JWKS before the claims mean anything.
//!
//! Either way, this module's job ends at a *verified email*; mapping that
//! email to a user account (existing account, pending invite, or the
//! config allowlist) happens in the server, which then mints a per-user
//! HMAC session token, accepted everywhere the admin key is. Provider
//! tokens themselves are never stored.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hmac::{Hmac, Mac};
use serde_json::Value;
use sha2::Sha256;

use crate::config::{AppleConfig, GoogleConfig};
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
/// payload `{"u": username, "v": session_version, "iat": ..., "exp": ...}`
/// signed with HMAC-SHA256. Logout just drops the client copy; bumping the
/// user's `session_version` revokes their tokens, rotating the secret
/// invalidates everyone's.
pub fn mint_session(username: &str, version: i64, secret: &str) -> String {
    let now = now_secs();
    let payload = serde_json::json!({
        "u": username, "v": version, "iat": now, "exp": now + SESSION_TTL_SECS,
    });
    let msg = URL_SAFE_NO_PAD.encode(payload.to_string());
    let sig = sign(&msg, secret);
    format!("{msg}.{sig}")
}

/// The token's subject and session version if it is authentic and unexpired.
/// Tokens minted before versions existed carry no `v` and count as version 1
/// (what every migrated account starts at), so they stay valid.
pub fn verify_session(token: &str, secret: &str) -> Option<(String, i64)> {
    let (msg, sig) = token.split_once('.')?;
    let expected = sign(msg, secret);
    if !constant_time_eq(sig, &expected) {
        return None;
    }
    let payload: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(msg).ok()?).ok()?;
    if payload["exp"].as_i64()? < now_secs() {
        return None;
    }
    let version = payload["v"].as_i64().unwrap_or(1);
    payload["u"].as_str().map(|u| (u.to_string(), version))
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
/// `next` target and an optional invite-link token, so the callback needs no
/// server-side session to find them.
pub fn encode_state(next: &str, invite: &str) -> String {
    format!(
        "{}.{}.{}",
        new_token(),
        URL_SAFE_NO_PAD.encode(next),
        URL_SAFE_NO_PAD.encode(invite)
    )
}

/// The `next` target carried in a state produced by [`encode_state`].
pub fn next_from_state(state: &str) -> Option<String> {
    let next_b64 = state.split('.').nth(1)?;
    let next = String::from_utf8(URL_SAFE_NO_PAD.decode(next_b64).ok()?).ok()?;
    // Re-check at redeem time: the cookie lives client-side. "/" is the
    // web UI's own landing.
    (next == "/" || allowed_next(&next)).then_some(next)
}

/// The invite-link token carried in a state produced by [`encode_state`],
/// if any. Validity (unused, unexpired) is the store's call at redeem time.
pub fn invite_from_state(state: &str) -> Option<String> {
    let token_b64 = state.split('.').nth(2)?;
    let token = String::from_utf8(URL_SAFE_NO_PAD.decode(token_b64).ok()?).ok()?;
    (!token.is_empty()).then_some(token)
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
/// claims: issuer, audience, expiry, verified email. Whether that email may
/// sign in (existing account / invite / allowlist) is the server's decision.
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
    Ok(email)
}

// ------------------------------------------------------ sign in with apple

pub const APPLE_JWKS_URI: &str = "https://appleid.apple.com/auth/keys";
const APPLE_ISSUER: &str = "https://appleid.apple.com";
/// How long a fetched JWKS stays good. Apple rotates keys rarely; an unknown
/// `kid` forces an early refetch anyway.
const APPLE_JWKS_TTL: std::time::Duration = std::time::Duration::from_secs(24 * 3600);

/// Fetch Apple's current signing keys (blocking — call via `spawn_blocking`).
pub fn fetch_apple_jwks() -> anyhow::Result<Value> {
    let response = ureq::get(APPLE_JWKS_URI)
        .timeout(std::time::Duration::from_secs(10))
        .call()
        .map_err(|e| anyhow::anyhow!("apple jwks fetch failed: {e}"))?;
    Ok(serde_json::from_str(&response.into_string()?)?)
}

type JwksCache = std::sync::Mutex<Option<(std::time::Instant, Value)>>;

fn apple_jwks_cache() -> &'static JwksCache {
    static CACHE: std::sync::OnceLock<JwksCache> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(None))
}

/// Verify a client-supplied identity token end to end: JWKS lookup (cached,
/// refetched once on an unknown `kid`), signature, claims, allowlist.
/// Blocking — call via `spawn_blocking`.
pub fn verify_apple_token(identity_token: &str, ac: &AppleConfig) -> anyhow::Result<String> {
    let cached = {
        let cache = apple_jwks_cache().lock().unwrap();
        cache
            .as_ref()
            .filter(|(at, _)| at.elapsed() < APPLE_JWKS_TTL)
            .map(|(_, jwks)| jwks.clone())
    };
    if let Some(jwks) = cached {
        match verify_apple_identity_token(identity_token, &jwks, ac) {
            Err(e) if e.to_string().contains("unknown signing key") => {}
            done => return done,
        }
    }
    let jwks = fetch_apple_jwks()?;
    *apple_jwks_cache().lock().unwrap() = Some((std::time::Instant::now(), jwks.clone()));
    verify_apple_identity_token(identity_token, &jwks, ac)
}

/// Validate an Apple identity token against a JWKS and return the signed-in
/// email. Unlike the Google path this checks the RS256 signature: the token
/// was relayed by the client, so nothing about the transport vouches for it.
/// Like Google, sign-in eligibility for the email is the server's decision.
pub fn verify_apple_identity_token(
    identity_token: &str,
    jwks: &Value,
    ac: &AppleConfig,
) -> anyhow::Result<String> {
    let header = jsonwebtoken::decode_header(identity_token)
        .map_err(|_| anyhow::anyhow!("malformed identity token"))?;
    let kid = header.kid.ok_or_else(|| anyhow::anyhow!("token has no kid"))?;
    let key = jwks["keys"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|k| k["kid"].as_str() == Some(kid.as_str()))
        .ok_or_else(|| anyhow::anyhow!("unknown signing key"))?;
    let decoding = jsonwebtoken::DecodingKey::from_rsa_components(
        key["n"].as_str().unwrap_or_default(),
        key["e"].as_str().unwrap_or_default(),
    )
    .map_err(|_| anyhow::anyhow!("bad jwks key"))?;

    let mut validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::RS256);
    validation.set_issuer(&[APPLE_ISSUER]);
    validation.set_audience(&[&ac.bundle_id]);
    validation.leeway = CLOCK_SKEW as u64;
    let claims = jsonwebtoken::decode::<Value>(identity_token, &decoding, &validation)
        .map_err(|e| anyhow::anyhow!("identity token rejected: {e}"))?
        .claims;

    let email = claims["email"].as_str().unwrap_or_default().trim().to_lowercase();
    if email.is_empty() {
        anyhow::bail!("no email in token");
    }
    // Apple encodes booleans inconsistently here: sometimes true, sometimes "true".
    let verified = claims["email_verified"] == Value::Bool(true)
        || claims["email_verified"].as_str() == Some("true");
    if !verified {
        anyhow::bail!("email is not verified");
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
        let token = mint_session("me", 3, "secret");
        assert_eq!(
            verify_session(&token, "secret"),
            Some(("me".to_string(), 3))
        );
        assert!(verify_session(&token, "other-secret").is_none());
        assert!(verify_session("garbage", "secret").is_none());
        assert!(verify_session("", "secret").is_none());
    }

    #[test]
    fn legacy_session_without_version_counts_as_v1() {
        // Tokens minted before session versions existed must keep working
        // for the migrated account (which starts at version 1).
        let payload =
            serde_json::json!({"u": "me", "iat": now_secs(), "exp": now_secs() + 999});
        let msg = URL_SAFE_NO_PAD.encode(payload.to_string());
        let token = format!("{msg}.{}", sign(&msg, "secret"));
        assert_eq!(
            verify_session(&token, "secret"),
            Some(("me".to_string(), 1))
        );
    }

    #[test]
    fn tampered_session_is_rejected() {
        let token = mint_session("me", 1, "secret");
        let (msg, sig) = token.split_once('.').unwrap();
        let payload = serde_json::json!({"u": "admin", "iat": 0, "exp": now_secs() + 999});
        let forged = format!("{}.{sig}", URL_SAFE_NO_PAD.encode(payload.to_string()));
        assert!(verify_session(&forged, "secret").is_none());
        let _ = msg;
    }

    #[test]
    fn expired_session_is_rejected() {
        let payload =
            serde_json::json!({"u": "me", "v": 1, "iat": now_secs() - 10, "exp": now_secs() - 1});
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
    fn id_token_accepts_any_verified_email() {
        // Allowlist/invite enforcement moved to the server's user-mapping
        // step; token validation itself passes any verified Google account.
        let mut claims = valid_claims();
        claims["email"] = Value::from("stranger@example.com");
        assert_eq!(
            decode_id_token(&fake_id_token(claims), &gc()).unwrap(),
            "stranger@example.com"
        );
    }

    #[test]
    fn id_token_rejects_bad_claims() {
        for (key, value) in [
            ("iss", Value::from("https://evil.example")),
            ("aud", Value::from("other-client")),
            ("exp", Value::from(now_secs() - 3600)),
            ("email", Value::from("")),
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
        let state = encode_state("http://127.0.0.1:49213/callback", "");
        assert_eq!(
            next_from_state(&state).as_deref(),
            Some("http://127.0.0.1:49213/callback")
        );
        assert_eq!(next_from_state(&encode_state("/", "")).as_deref(), Some("/"));
        assert!(next_from_state(&encode_state("", "")).is_none());
        // A tampered cookie pointing somewhere else is refused at redeem time.
        assert!(next_from_state(&encode_state("https://evil.example/steal", "")).is_none());
        assert!(allowed_next("agora://auth"));
        assert!(allowed_next("exp://192.168.1.5:8081/--/auth"));
        assert!(!allowed_next("https://evil.example"));
        assert!(!allowed_next("http://localhost.evil.example/x"));
    }

    #[test]
    fn state_carries_an_optional_invite_token() {
        let state = encode_state("/", "tok123");
        assert_eq!(next_from_state(&state).as_deref(), Some("/"));
        assert_eq!(invite_from_state(&state).as_deref(), Some("tok123"));
        assert!(invite_from_state(&encode_state("/", "")).is_none());
    }

    #[test]
    fn states_do_not_collide() {
        let a = encode_state("agora://auth", "");
        let b = encode_state("agora://auth", "");
        assert_ne!(a, b);
        assert!(state_matches(&a, &a));
        assert!(!state_matches(&a, &b));
    }

    // ---------------------------------------------------------------- apple

    /// Throwaway 2048-bit RSA key for signing test tokens — not a secret.
    const TEST_RSA_PEM: &str = "-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA6+fO1BaqcQ8eS0acKWuKEJfhM49gJc+57MiwDUM+6xrzx2IF
+7vzGsD9+StigRE681ByuVacz3oKZ9KPeUju8qqkUQViF1NCphDPFkjCPlm1zABi
ASCNEpoyqETRAa+PXsqQ3dUaYJmW2MN+pnvG/RKn0TdY3NTjNmKNK5g2v30NjGOV
WLgFp9jj8+gp0WixRrIePiDYDxOiVIAnK9GxF2Qz0HT2iaEQScwX3WhTKzzuqYpq
Wum6p4KBaQBsMk2JrwRyp6mjW0vWwBRpQnTPxx+pCVF5Tw5leHhTxtb2Jry3w/09
3F+GaZ6RNb+Ei73NOFO6V9bDU1nCllt+VwsEAwIDAQABAoIBAFunBi5UWAfw7b4l
Qsq84zkrKO2VSK+oEv4xwmSEuc8x+4B9TwHMtdixHntOJckrXpHlsYzcX7QkICLS
JbfjZCKXtZtc0g1p5b0LTsnDnuQGiqEljO4PLYAKtJ+3jNRw1uznGn11K/hX88ln
uq8H6/mq49RfAoFZnKUmiN5lFvAx8LPWfUenzQayOKiYfK+PvxhwWnea5hsb3swy
AOKsTabC+ZGOxON7hSjiEt3EzlI7gE05D2Y6O6b6ya74H3skYZ4NRiSVSMsmezAS
GN93XeL3XJ2f+8obVpuFzLWj5jVArnaD5j9oIbvE7istz3KKpqHv3xQgK4SE6IBt
pJk8phECgYEA+gGKsFmvgHx9IKW43GiLugJVPMOdzOQjQok/zvBMEB5zXhbxaYAS
RpRjl5D/9wwnbw89wmSuO9syKkMFIz2xKSzPoTzp9X/DcQK8Vn8wj25n75+HYohY
Br3Hsy5Ski3GXpdMEwBntfK0gM1xyhT3xF7Y5c2Miaehr2xRzwePU+cCgYEA8Y+4
ut4gBSJbgguic0XzXCtLDj2CZy8Fbbp5D0CY8x/nj8MfTltf7cyUroyjHZ00pBeZ
7Sl46FW67amDNpV1lIt3ouM5UjL4recyYXOIzrDHp4HAqf0nkriN6vt8DAwJRfBc
/Gpzyo27DSDwa0stddnqyJiIxBcNqoG1gDAKi4UCgYBJ22S+fnBTk/NfTrYTHyuQ
Mxo9Tkjy+77S7DsWhnTiGizY8gw1r6k2gqX9Y8/KiyOnMqh7IkU616G1TIFbDOGm
mV9pcdZoOWtimn1LTF3rMaGw778OQ9tFepFhhODN4IoG7cmCn48D+ISMvKTOH22m
7KJFGXlYPVaNvYFZmRElpwKBgFJqjsRy9MnLpxz/izV5MEbKHpmFMvCxglClxpgF
mimZQRAzqoK5eklP+4pyQVThRgyWYNYhyDa8yUI9C5+b7rn3u6G/lNcOvPnYX8AQ
AyVB+1yTUICu9smAXitGElSp5qAOGiukxkzdfmxESMLSq3gCGbDHGiKNGwSJrLtH
qNFhAoGBANFJFoLQSruwS5cNWnC8V+FpzIW9Kj88gFsjdwBewiHVocgpyGvr9dvf
4RvFbwhM2d6rviMN181nVcNKOVrPJvyen3XB/UCK+hiq3H20KPcpecJpUP02X0M6
UdeGy7DwA1AX/rEVXhJrqnyiDggacXDr7ukM0x5c+GjbsrjO/NR+
-----END RSA PRIVATE KEY-----";
    /// Modulus/exponent of [`TEST_RSA_PEM`], base64url — a one-key JWKS.
    const TEST_RSA_N: &str = "6-fO1BaqcQ8eS0acKWuKEJfhM49gJc-57MiwDUM-6xrzx2IF-7vzGsD9-StigRE681ByuVacz3oKZ9KPeUju8qqkUQViF1NCphDPFkjCPlm1zABiASCNEpoyqETRAa-PXsqQ3dUaYJmW2MN-pnvG_RKn0TdY3NTjNmKNK5g2v30NjGOVWLgFp9jj8-gp0WixRrIePiDYDxOiVIAnK9GxF2Qz0HT2iaEQScwX3WhTKzzuqYpqWum6p4KBaQBsMk2JrwRyp6mjW0vWwBRpQnTPxx-pCVF5Tw5leHhTxtb2Jry3w_093F-GaZ6RNb-Ei73NOFO6V9bDU1nCllt-VwsEAw";

    fn ac() -> AppleConfig {
        AppleConfig {
            bundle_id: "app.agora.mobile".into(),
            allowed_emails: vec!["tom@example.com".into()],
        }
    }

    fn test_jwks() -> Value {
        serde_json::json!({"keys": [
            {"kty": "RSA", "kid": "testkey", "alg": "RS256", "use": "sig",
             "n": TEST_RSA_N, "e": "AQAB"},
        ]})
    }

    fn apple_claims() -> Value {
        serde_json::json!({
            "iss": "https://appleid.apple.com",
            "aud": "app.agora.mobile",
            "exp": now_secs() + 3600,
            "iat": now_secs(),
            "sub": "001234.abcdef",
            "email": "Tom@Example.com",
            "email_verified": "true",
        })
    }

    fn sign_apple_token(claims: &Value, kid: &str) -> String {
        let key = jsonwebtoken::EncodingKey::from_rsa_pem(TEST_RSA_PEM.as_bytes()).unwrap();
        let mut header = jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256);
        header.kid = Some(kid.to_string());
        jsonwebtoken::encode(&header, claims, &key).unwrap()
    }

    #[test]
    fn apple_token_happy_path_lowercases_email() {
        let token = sign_apple_token(&apple_claims(), "testkey");
        let email = verify_apple_identity_token(&token, &test_jwks(), &ac()).unwrap();
        assert_eq!(email, "tom@example.com");
        // Boolean email_verified is accepted too.
        let mut claims = apple_claims();
        claims["email_verified"] = Value::Bool(true);
        let token = sign_apple_token(&claims, "testkey");
        assert!(verify_apple_identity_token(&token, &test_jwks(), &ac()).is_ok());
    }

    #[test]
    fn apple_token_accepts_any_verified_email() {
        // Same as Google: eligibility is decided by the server's user
        // mapping, not by token validation.
        let mut claims = apple_claims();
        claims["email"] = Value::from("stranger@example.com");
        let token = sign_apple_token(&claims, "testkey");
        assert_eq!(
            verify_apple_identity_token(&token, &test_jwks(), &ac()).unwrap(),
            "stranger@example.com"
        );
    }

    #[test]
    fn apple_token_rejects_bad_claims() {
        for (key, value) in [
            ("iss", Value::from("https://evil.example")),
            ("aud", Value::from("app.other.bundle")),
            ("exp", Value::from(now_secs() - 3600)),
            ("email", Value::from("")),
            ("email_verified", Value::from("false")),
        ] {
            let mut claims = apple_claims();
            claims[key] = value;
            let token = sign_apple_token(&claims, "testkey");
            assert!(
                verify_apple_identity_token(&token, &test_jwks(), &ac()).is_err(),
                "claim {key} should have failed"
            );
        }
    }

    #[test]
    fn apple_token_requires_known_key_and_real_signature() {
        // A kid the JWKS doesn't know: the caller refetches on this error.
        let token = sign_apple_token(&apple_claims(), "otherkey");
        let e = verify_apple_identity_token(&token, &test_jwks(), &ac()).unwrap_err();
        assert!(e.to_string().contains("unknown signing key"));

        // Tampered payload under a valid header/kid must fail verification.
        let token = sign_apple_token(&apple_claims(), "testkey");
        let mut parts: Vec<&str> = token.split('.').collect();
        let mut claims = apple_claims();
        claims["email"] = Value::from("intruder@example.com");
        let forged_payload = URL_SAFE_NO_PAD.encode(claims.to_string());
        parts[1] = &forged_payload;
        let forged = parts.join(".");
        assert!(verify_apple_identity_token(&forged, &test_jwks(), &ac()).is_err());

        assert!(verify_apple_identity_token("not-a-jwt", &test_jwks(), &ac()).is_err());
    }
}
