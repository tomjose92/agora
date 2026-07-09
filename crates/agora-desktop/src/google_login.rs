//! Desktop Google sign-in: the standard native-app loopback dance.
//!
//! The shell binds an ephemeral loopback listener, opens the *system* browser
//! at the remote server's `/api/auth/google/start?next=http://127.0.0.1:PORT/callback`
//! (Google refuses to run OAuth inside embedded webviews), and waits for the
//! server's callback to bounce the freshly minted session token back to the
//! listener. The token then takes the owner token's place in `desktop.json`.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::{Duration, Instant};

/// How long the user gets to finish the consent screen.
const FLOW_TIMEOUT: Duration = Duration::from_secs(300);

/// Runs the whole flow and returns the session token. `select_account`
/// forces Google's account chooser — used on retries so a rejected account
/// isn't silently re-picked forever.
pub async fn run_flow(base: String, select_account: bool) -> Result<String, String> {
    check_enabled(&base).await?;
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("could not open a local listener: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| e.to_string())?
        .port();
    let next = format!("http://127.0.0.1:{port}/callback");
    let start = format!(
        "{base}/api/auth/google/start?next={}{}",
        urlencode(&next),
        if select_account { "&select_account=1" } else { "" }
    );
    open_browser(&start)?;
    tokio::task::spawn_blocking(move || wait_for_callback(listener))
        .await
        .map_err(|_| "sign-in task failed".to_string())?
}

/// The server must actually offer Google sign-in before we open a browser.
async fn check_enabled(base: &str) -> Result<(), String> {
    let base = base.to_string();
    tokio::task::spawn_blocking(move || {
        let response = ureq::get(&format!("{base}/api/auth/config"))
            .timeout(Duration::from_secs(10))
            .call()
            .map_err(|e| format!("could not reach the server: {e}"))?;
        let text = response
            .into_string()
            .map_err(|_| "unexpected response — is that an Agora server?".to_string())?;
        let body: serde_json::Value = serde_json::from_str(&text)
            .map_err(|_| "unexpected response — is that an Agora server?".to_string())?;
        if body["google"]["enabled"] == serde_json::Value::Bool(true) {
            Ok(())
        } else {
            Err("that server does not have Google sign-in configured".to_string())
        }
    })
    .await
    .map_err(|_| "sign-in task failed".to_string())?
}

/// Accept exactly one loopback request (the server's redirect) and pull
/// `token` or `error` out of its query string.
fn wait_for_callback(listener: TcpListener) -> Result<String, String> {
    listener
        .set_nonblocking(true)
        .map_err(|e| e.to_string())?;
    let deadline = Instant::now() + FLOW_TIMEOUT;
    loop {
        match listener.accept() {
            Ok((mut stream, _)) => {
                let _ = stream.set_nonblocking(false);
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..n]);
                let Some(target) = request.split_whitespace().nth(1) else {
                    respond_empty(&mut stream);
                    continue; // not an HTTP request; keep waiting
                };
                // Browsers also ask for /favicon.ico; only /callback counts.
                if !target.starts_with("/callback") {
                    respond_empty(&mut stream);
                    continue;
                }
                let query: std::collections::HashMap<String, String> = target
                    .split_once('?')
                    .map(|(_, q)| q)
                    .unwrap_or("")
                    .split('&')
                    .filter_map(|pair| {
                        let (k, v) = pair.split_once('=')?;
                        Some((k.to_string(), percent_decode(v)))
                    })
                    .collect();
                if let Some(token) = query.get("token").filter(|t| !t.is_empty()) {
                    respond(
                        &mut stream,
                        true,
                        "You're signed in",
                        "Agora is opening on your desktop — you can close this tab.",
                    );
                    return Ok(token.clone());
                }
                let reason = query
                    .get("error")
                    .cloned()
                    .unwrap_or_else(|| "unknown".to_string());
                respond(
                    &mut stream,
                    false,
                    "Sign-in didn't finish",
                    &sign_in_error(&reason),
                );
                return Err(sign_in_error(&reason));
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() > deadline {
                    return Err("Sign-in timed out — try again".to_string());
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            Err(e) => return Err(format!("local listener failed: {e}")),
        }
    }
}

fn sign_in_error(reason: &str) -> String {
    match reason {
        "no_access" => "That Google account isn't allowed on this instance".to_string(),
        "google_access_denied" => "Google sign-in was cancelled".to_string(),
        other => format!("Google sign-in failed ({other})"),
    }
}

/// Branded landing page for the browser tab the OAuth dance ends in. The
/// first thing it does is scrub the token from the address bar
/// (history.replaceState), then it politely tries window.close() — most
/// browsers refuse for tabs they didn't open via script, hence the message.
fn respond(stream: &mut std::net::TcpStream, ok: bool, title: &str, detail: &str) {
    let (badge_bg, badge) = if ok {
        ("rgba(74,222,128,.12)", "&#10003;")
    } else {
        ("rgba(248,113,113,.12)", "&#10005;")
    };
    let badge_color = if ok { "#4ade80" } else { "#f87171" };
    let page = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>Agora</title><style>\
         body{{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;\
         background:#07090f;color:#eceef4;font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}}\
         .card{{width:min(400px,92vw);text-align:center;background:rgba(255,255,255,.04);\
         border:1px solid rgba(255,255,255,.09);border-radius:18px;padding:40px 32px}}\
         .badge{{width:56px;height:56px;border-radius:50%;margin:0 auto 18px;display:flex;\
         align-items:center;justify-content:center;font-size:26px;background:{badge_bg};color:{badge_color}}}\
         h1{{margin:0 0 8px;font-size:20px}}p{{margin:0;color:#8b91a5;font-size:14px}}\
         </style></head><body><div class=\"card\">\
         <div class=\"badge\">{badge}</div><h1>{title}</h1><p>{detail}</p></div>\
         <script>history.replaceState(null,'','/done');setTimeout(function(){{window.close()}},1500);</script>\
         </body></html>"
    );
    let _ = write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{page}",
        page.len()
    );
    let _ = stream.flush();
}

/// Stray requests (favicon probes, non-HTTP noise) get an empty 204.
fn respond_empty(stream: &mut std::net::TcpStream) {
    let _ = write!(stream, "HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n");
    let _ = stream.flush();
}

fn open_browser(url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(url).spawn();
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("cmd").args(["/c", "start", "", url]).spawn();
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let result = std::process::Command::new("xdg-open").arg(url).spawn();
    result
        .map(|_| ())
        .map_err(|e| format!("could not open the browser: {e}"))
}

fn urlencode(raw: &str) -> String {
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

fn percent_decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 3 <= bytes.len() {
            if let Ok(v) = u8::from_str_radix(&raw[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(if bytes[i] == b'+' { b' ' } else { bytes[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_decode_roundtrip() {
        assert_eq!(percent_decode("abc"), "abc");
        assert_eq!(percent_decode("a%20b%2Bc"), "a b+c");
        assert_eq!(percent_decode(&urlencode("http://127.0.0.1:9/x?y=z")), "http://127.0.0.1:9/x?y=z");
        // Session tokens (b64url + '.') survive the round-trip untouched.
        let token = "eyJ1IjoibWUifQ.c2ln";
        assert_eq!(percent_decode(&urlencode(token)), token);
    }

    #[test]
    fn error_reasons_are_humanized() {
        assert!(sign_in_error("no_access").contains("isn't allowed"));
        assert!(sign_in_error("google_access_denied").contains("cancelled"));
        assert!(sign_in_error("weird").contains("weird"));
    }
}
