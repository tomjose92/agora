//! Server-side link unfurling.
//!
//! Posted messages queue their id to a single background worker (installed
//! at boot via [`crate::hub::Hub::set_unfurler`]); it fetches each linked
//! page's `<head>`, distills OpenGraph/Twitter/`<title>` metadata, and
//! merges the result into the message's `meta` — `meta.unfurls` for links
//! in the prose, fetched titles/descriptions folded into `meta.sources` for
//! cited URLs. Clients learn about it through the same `message_update`
//! broadcast they already merge, so nothing on the post path ever waits on
//! the network.
//!
//! This is the one place Agora fetches URLs *chosen by users and agents*,
//! so every request goes through a resolver that refuses private, loopback,
//! link-local and otherwise non-public addresses — on every redirect hop,
//! which also closes DNS-rebinding tricks. Results (including failures) are
//! cached in the store so a URL is fetched once, not once per message.

use std::io::Read;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, ToSocketAddrs};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use crate::hub::Hub;
use crate::store::Store;

/// Most links unfurled from one message's prose.
pub const UNFURL_MAX_LINKS: usize = 3;
/// Most sources enriched per message (the viewer degrades gracefully to a
/// bare URL for the rest).
pub const ENRICH_MAX_SOURCES: usize = 8;
/// Redirect hops before giving up.
const MAX_REDIRECTS: u32 = 3;
/// Most bytes read from a page — the metadata lives in `<head>`.
const MAX_BODY_BYTES: u64 = 512 * 1024;
/// Per-request timeout.
const FETCH_TIMEOUT: Duration = Duration::from_secs(10);
/// Field caps: pages get no say in how much we store.
const MAX_TITLE_CHARS: usize = 300;
const MAX_DESC_CHARS: usize = 500;
const MAX_IMAGE_URL_CHARS: usize = 2048;

/// Start the worker and hand back its queue sender (wired into the hub at
/// boot). One message at a time: unfurling is best-effort background work
/// and must never contend with the interactive paths.
pub fn spawn_worker(hub: Arc<Hub>) -> tokio::sync::mpsc::UnboundedSender<i64> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Some(message_id) = rx.recv().await {
            let hub = Arc::clone(&hub);
            let _ = tokio::task::spawn_blocking(move || process(&hub, message_id)).await;
        }
    });
    tx
}

fn process(hub: &Hub, message_id: i64) {
    let Some(message) = hub.store.message(message_id) else {
        return;
    };
    let agent = http_agent();
    let store = Arc::clone(&hub.store);
    let fetch = move |url: &str| fetch_cached(&store, &agent, url);
    let Some(patch) = enrich(&message, &fetch) else {
        return;
    };
    let Some(updated) = hub.store.update_message_meta(message_id, &patch) else {
        return;
    };
    let channel_id = updated["channel_id"].as_str().unwrap_or_default().to_string();
    hub.post_transient(
        &channel_id,
        json!({"type": "message_update", "message": updated}),
    );
}

/// The meta patch a message needs: fetched metadata folded into its
/// `sources`, and `unfurls` for the first few *other* links in the text
/// (cited URLs are chips already — unfurling them too would re-grow exactly
/// the bulk the sources UI removes). Pure apart from `fetch`, so tests
/// inject one. `None` when there is nothing to add.
pub fn enrich(message: &Value, fetch: &dyn Fn(&str) -> Option<Value>) -> Option<Value> {
    let text = message["text"].as_str().unwrap_or_default();
    let meta = &message["meta"];
    if meta.get("unfurls").is_some() {
        return None; // already processed
    }
    let mut patch = serde_json::Map::new();

    let sources: Vec<Value> = meta["sources"].as_array().cloned().unwrap_or_default();
    let source_urls: Vec<String> = sources
        .iter()
        .filter_map(|s| s["url"].as_str().map(str::to_string))
        .collect();
    let mut sources_changed = false;
    let enriched: Vec<Value> = sources
        .into_iter()
        .enumerate()
        .map(|(i, mut src)| {
            let needs_more = src.get("title").is_none()
                || src.get("description").is_none()
                || src.get("image").is_none();
            if i >= ENRICH_MAX_SOURCES || !needs_more {
                return src;
            }
            let url = src["url"].as_str().unwrap_or_default().to_string();
            if let (Some(obj), Some(fetched)) = (src.as_object_mut(), fetch(&url)) {
                for key in ["title", "description", "image", "site"] {
                    if obj.get(key).is_none() {
                        if let Some(v) = fetched.get(key).filter(|v| !v.is_null()) {
                            obj.insert(key.into(), v.clone());
                            sources_changed = true;
                        }
                    }
                }
            }
            src
        })
        .collect();
    if sources_changed {
        patch.insert("sources".into(), Value::Array(enriched));
    }

    let mut unfurls = Vec::new();
    for url in crate::sources::extract_urls(text) {
        if unfurls.len() >= UNFURL_MAX_LINKS {
            break;
        }
        if source_urls.iter().any(|s| s == &url) {
            continue;
        }
        if let Some(fetched) = fetch(&url) {
            let mut entry = fetched;
            if let Some(obj) = entry.as_object_mut() {
                obj.insert("url".into(), json!(url));
            }
            unfurls.push(entry);
        }
    }
    if !unfurls.is_empty() {
        patch.insert("unfurls".into(), Value::Array(unfurls));
    }

    (!patch.is_empty()).then(|| Value::Object(patch))
}

/// Cache-through fetch: a fresh cached row answers directly (misses included
/// — dead links are not retried per message), anything else goes out on the
/// wire and lands in the cache either way.
fn fetch_cached(store: &Store, agent: &ureq::Agent, url: &str) -> Option<Value> {
    if let Some((ok, meta)) = store.unfurl_cache_get(url) {
        return ok.then_some(meta);
    }
    match fetch_remote(agent, url) {
        Some(meta) => {
            store.unfurl_cache_put(url, true, &meta);
            Some(meta)
        }
        None => {
            store.unfurl_cache_put(url, false, &json!({}));
            None
        }
    }
}

fn fetch_remote(agent: &ureq::Agent, url: &str) -> Option<Value> {
    let resp = agent
        .get(url)
        .set("accept", "text/html,application/xhtml+xml")
        .set("accept-language", "en")
        .call()
        .ok()?;
    let content_type = resp.content_type().to_ascii_lowercase();
    if content_type != "text/html" && content_type != "application/xhtml+xml" {
        return None;
    }
    // The redirect target, not the posted URL, is the base for relative
    // image paths and the site fallback.
    let final_url = resp.get_url().to_string();
    let mut buf = Vec::new();
    resp.into_reader()
        .take(MAX_BODY_BYTES)
        .read_to_end(&mut buf)
        .ok()?;
    parse_head(&String::from_utf8_lossy(&buf), &final_url)
}

/// The outbound agent every unfurl request goes through: bounded redirects
/// and timeouts, and the guarded resolver on each hop.
pub fn http_agent() -> ureq::Agent {
    ureq::builder()
        .redirects(MAX_REDIRECTS)
        .timeout(FETCH_TIMEOUT)
        .user_agent("Agora-linkbot/1.0 (+https://github.com/tomjose92/agora)")
        .resolver(|netloc: &str| -> std::io::Result<Vec<SocketAddr>> {
            let addrs: Vec<SocketAddr> = netloc
                .to_socket_addrs()?
                .filter(|a| ip_allowed(a.ip()))
                .collect();
            if addrs.is_empty() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "resolved to a non-public address",
                ));
            }
            Ok(addrs)
        })
        .build()
}

/// Public-internet addresses only. Everything a fetch could use to reach
/// the host, its LAN, or cloud metadata services is refused: loopback,
/// RFC1918, link-local (169.254 carries AWS/GCP metadata), CGNAT, IPv6
/// unique-local — and the reserved/documentation ranges for good measure.
fn ip_allowed(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            !(v4.is_unspecified()
                || v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_multicast()
                || o[0] == 0
                || (o[0] == 100 && (o[1] & 0xC0) == 64) // CGNAT 100.64.0.0/10
                || (o[0] == 192 && o[1] == 0 && o[2] == 0) // IETF 192.0.0.0/24
                || (o[0] == 192 && o[1] == 0 && o[2] == 2) // TEST-NET-1
                || (o[0] == 198 && (o[1] & 0xFE) == 18) // benchmarking 198.18.0.0/15
                || (o[0] == 198 && o[1] == 51 && o[2] == 100) // TEST-NET-2
                || (o[0] == 203 && o[1] == 0 && o[2] == 113) // TEST-NET-3
                || o[0] >= 240) // reserved 240.0.0.0/4
        }
        IpAddr::V6(v6) => {
            let seg = v6.segments();
            // IPv4-mapped (::ffff:a.b.c.d): judge the embedded IPv4.
            if seg[..5] == [0, 0, 0, 0, 0] && seg[5] == 0xffff {
                let [a, b] = seg[6].to_be_bytes();
                let [c, d] = seg[7].to_be_bytes();
                return ip_allowed(IpAddr::V4(Ipv4Addr::new(a, b, c, d)));
            }
            !(v6.is_unspecified()
                || v6.is_loopback()
                || v6.is_multicast()
                || (seg[0] & 0xfe00) == 0xfc00 // unique local fc00::/7
                || (seg[0] & 0xffc0) == 0xfe80 // link local fe80::/10
                || (seg[0] == 0x2001 && seg[1] == 0xdb8)) // documentation
        }
    }
}

/// Distill `{title, description?, image?, site?}` from a page. OpenGraph
/// wins over Twitter cards over plain `<title>`/`name=description`; a page
/// yielding no title yields no unfurl — a bare URL says as much.
pub fn parse_head(html: &str, base_url: &str) -> Option<Value> {
    // (rank, value): lower rank wins, first-seen wins within a rank.
    let mut title: Option<(u8, String)> = None;
    let mut desc: Option<(u8, String)> = None;
    let mut image: Option<(u8, String)> = None;
    let mut site: Option<(u8, String)> = None;
    let mut set = |slot: &mut Option<(u8, String)>, rank: u8, raw: &str| {
        let v = decode_entities(raw.trim());
        if !v.is_empty() && slot.as_ref().map(|(r, _)| rank < *r).unwrap_or(true) {
            *slot = Some((rank, v));
        }
    };
    for (start, _) in html.match_indices("<meta") {
        let tag = &html[start..];
        let Some(end) = tag.find('>') else { break };
        let attrs = tag_attrs(&tag[5..end]);
        let key = attrs
            .iter()
            .find(|(k, _)| k == "property" || k == "name")
            .map(|(_, v)| v.to_ascii_lowercase())
            .unwrap_or_default();
        let Some((_, content)) = attrs.iter().find(|(k, _)| k == "content") else {
            continue;
        };
        match key.as_str() {
            "og:title" => set(&mut title, 0, content),
            "twitter:title" => set(&mut title, 1, content),
            "og:description" => set(&mut desc, 0, content),
            "twitter:description" => set(&mut desc, 1, content),
            "description" => set(&mut desc, 2, content),
            "og:image" | "og:image:url" => set(&mut image, 0, content),
            "twitter:image" => set(&mut image, 1, content),
            "og:site_name" => set(&mut site, 0, content),
            _ => {}
        }
    }
    if title.is_none() {
        if let Some(t) = html.find("<title") {
            let rest = &html[t..];
            if let (Some(open), Some(close)) = (rest.find('>'), rest.find("</title")) {
                if open < close {
                    set(&mut title, 2, &rest[open + 1..close]);
                }
            }
        }
    }
    let title = cut(&title?.1, MAX_TITLE_CHARS);
    let mut out = serde_json::Map::new();
    out.insert("title".into(), json!(title));
    if let Some((_, d)) = desc {
        out.insert("description".into(), json!(cut(&d, MAX_DESC_CHARS)));
    }
    if let Some(img) = image.and_then(|(_, i)| resolve_url(base_url, &i)) {
        if img.len() <= MAX_IMAGE_URL_CHARS {
            out.insert("image".into(), json!(img));
        }
    }
    let site = site.map(|(_, s)| cut(&s, 100)).or_else(|| host_of(base_url));
    if let Some(s) = site {
        out.insert("site".into(), json!(s));
    }
    Some(Value::Object(out))
}

fn cut(s: &str, max: usize) -> String {
    // Collapse whitespace runs — head metadata is single-line by nature.
    let mut out = String::new();
    let mut last_space = false;
    for c in s.chars() {
        if out.chars().count() >= max {
            break;
        }
        if c.is_whitespace() {
            if !last_space && !out.is_empty() {
                out.push(' ');
            }
            last_space = true;
        } else {
            out.push(c);
            last_space = false;
        }
    }
    out.trim_end().to_string()
}

/// Attributes of one tag body: `name="value"`, `name='value'`, or bare
/// `name=value` — enough for real-world `<meta>` tags without an HTML parser.
fn tag_attrs(tag: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let chars: Vec<char> = tag.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i].is_whitespace() || chars[i] == '/' {
            i += 1;
            continue;
        }
        let name_start = i;
        while i < chars.len() && !chars[i].is_whitespace() && chars[i] != '=' && chars[i] != '/' {
            i += 1;
        }
        let name: String = chars[name_start..i].iter().collect::<String>().to_ascii_lowercase();
        while i < chars.len() && chars[i].is_whitespace() {
            i += 1;
        }
        if i >= chars.len() || chars[i] != '=' {
            if !name.is_empty() {
                out.push((name, String::new()));
            }
            continue;
        }
        i += 1;
        while i < chars.len() && chars[i].is_whitespace() {
            i += 1;
        }
        let value: String = if i < chars.len() && (chars[i] == '"' || chars[i] == '\'') {
            let quote = chars[i];
            i += 1;
            let start = i;
            while i < chars.len() && chars[i] != quote {
                i += 1;
            }
            let v = chars[start..i].iter().collect();
            i += 1;
            v
        } else {
            let start = i;
            while i < chars.len() && !chars[i].is_whitespace() {
                i += 1;
            }
            chars[start..i].iter().collect()
        };
        if !name.is_empty() {
            out.push((name, value));
        }
    }
    out
}

/// The handful of entities that show up in real titles/descriptions, plus
/// numeric forms; anything unrecognized passes through untouched.
fn decode_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        rest = &rest[amp..];
        // Entities are short; a ';' further out means this '&' is literal.
        let semi = match rest.find(';') {
            Some(p) if p <= 11 => p,
            _ => {
                out.push('&');
                rest = &rest[1..];
                continue;
            }
        };
        let entity = &rest[1..semi];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some(' '),
            _ => entity
                .strip_prefix("#x")
                .or_else(|| entity.strip_prefix("#X"))
                .and_then(|h| u32::from_str_radix(h, 16).ok())
                .or_else(|| entity.strip_prefix('#').and_then(|d| d.parse().ok()))
                .and_then(char::from_u32),
        };
        match decoded {
            Some(c) => {
                out.push(c);
                rest = &rest[semi + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Resolve an image reference against the page it came from. Absolute and
/// scheme/host-relative forms only — path-relative images are rare in og
/// tags and not worth a URL library.
fn resolve_url(base: &str, href: &str) -> Option<String> {
    let href = href.trim();
    if href.starts_with("https://") || href.starts_with("http://") {
        return Some(href.to_string());
    }
    let (scheme, rest) = base.split_once("://")?;
    let host = rest.split(['/', '?', '#']).next()?;
    if host.is_empty() {
        return None;
    }
    if let Some(h) = href.strip_prefix("//") {
        return Some(format!("{scheme}://{h}"));
    }
    if href.starts_with('/') {
        return Some(format!("{scheme}://{host}{href}"));
    }
    None
}

fn host_of(url: &str) -> Option<String> {
    let rest = url.split_once("://")?.1;
    let host = rest.split(['/', '?', '#']).next()?;
    (!host.is_empty()).then(|| host.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_og_head_with_priorities_and_entities() {
        let html = r#"<html><head>
            <title>Plain &amp; simple</title>
            <meta name="description" content="plain desc">
            <meta property="og:description" content="OG &quot;desc&quot;">
            <meta content="OG Title &#x1F389;" property="og:title">
            <meta property="og:image" content="/img/preview.png">
            <meta property="og:site_name" content='Example'>
        </head><body></body></html>"#;
        let meta = parse_head(html, "https://example.com/a/page?x=1").unwrap();
        assert_eq!(meta["title"], "OG Title 🎉"); // og beats <title>, attr order agnostic
        assert_eq!(meta["description"], "OG \"desc\"");
        assert_eq!(meta["image"], "https://example.com/img/preview.png");
        assert_eq!(meta["site"], "Example");
    }

    #[test]
    fn falls_back_to_title_tag_and_host() {
        let meta = parse_head("<title>Just a title</title>", "https://x.io/p").unwrap();
        assert_eq!(meta["title"], "Just a title");
        assert_eq!(meta["site"], "x.io");
        assert!(meta.get("description").is_none());
        // No title at all → no unfurl.
        assert!(parse_head("<p>nothing here</p>", "https://x.io").is_none());
    }

    #[test]
    fn caps_and_collapses_whitespace() {
        let html = format!("<title>  a\n\n{}  </title>", "b".repeat(500));
        let meta = parse_head(&html, "https://x.io").unwrap();
        let title = meta["title"].as_str().unwrap();
        assert!(title.starts_with("a b"));
        assert_eq!(title.chars().count(), 300);
    }

    #[test]
    fn blocks_non_public_addresses() {
        for bad in [
            "127.0.0.1", "10.1.2.3", "172.16.0.9", "192.168.1.1", "169.254.169.254",
            "0.0.0.0", "100.64.0.1", "198.18.0.1", "240.0.0.1", "255.255.255.255",
            "::1", "::", "fc00::1", "fd12::1", "fe80::1", "ff02::1", "::ffff:10.0.0.1",
            "2001:db8::1",
        ] {
            assert!(!ip_allowed(bad.parse().unwrap()), "{bad} should be blocked");
        }
        for good in ["93.184.216.34", "1.1.1.1", "2606:4700::1111", "::ffff:1.1.1.1"] {
            assert!(ip_allowed(good.parse().unwrap()), "{good} should be allowed");
        }
    }

    #[test]
    fn enrich_fills_sources_and_unfurls_other_links() {
        let message = json!({
            "text": "Read https://blog.example/post for context.\n\nSources:\nhttps://a.com\nhttps://b.com",
            "meta": {
                "sources": [{"url": "https://a.com"}, {"url": "https://b.com", "title": "Known", "description": "d", "image": "i"}],
                "sources_start": 44,
            },
        });
        let fetch = |url: &str| -> Option<Value> {
            match url {
                "https://a.com" => Some(json!({"title": "A!", "site": "a.com"})),
                "https://blog.example/post" => {
                    Some(json!({"title": "Post", "description": "About things", "site": "blog.example"}))
                }
                _ => panic!("unexpected fetch of {url} (fully-known sources must not refetch)"),
            }
        };
        let patch = enrich(&message, &fetch).unwrap();
        assert_eq!(patch["sources"][0]["title"], "A!");
        assert_eq!(patch["sources"][1]["title"], "Known");
        let unfurls = patch["unfurls"].as_array().unwrap();
        assert_eq!(unfurls.len(), 1); // cited URLs are chips, never unfurl cards
        assert_eq!(unfurls[0]["url"], "https://blog.example/post");
        assert_eq!(unfurls[0]["title"], "Post");

        // Second pass is a no-op: unfurls present marks the message done.
        let mut done = message.clone();
        done["meta"]["unfurls"] = patch["unfurls"].clone();
        assert!(enrich(&done, &|_| panic!("must not fetch")).is_none());
    }

    #[test]
    fn enrich_caps_unfurls_and_handles_failures() {
        let urls: Vec<String> = (0..6).map(|i| format!("https://s{i}.com")).collect();
        let message = json!({"text": urls.join(" and "), "meta": null});
        let fetch = |url: &str| -> Option<Value> {
            // First candidate fails: it must not consume one of the slots.
            (url != "https://s0.com").then(|| json!({"title": url.to_string()}))
        };
        let patch = enrich(&message, &fetch).unwrap();
        let unfurls = patch["unfurls"].as_array().unwrap();
        assert_eq!(unfurls.len(), UNFURL_MAX_LINKS);
        assert_eq!(unfurls[0]["url"], "https://s1.com");
        assert!(patch.get("sources").is_none());

        // Nothing fetchable → no patch at all (nothing to broadcast).
        assert!(enrich(&json!({"text": "https://a.com", "meta": null}), &|_| None).is_none());
        assert!(enrich(&json!({"text": "plain words", "meta": null}), &|_| None).is_none());
    }

    #[test]
    fn resolves_relative_image_urls() {
        assert_eq!(
            resolve_url("https://a.com/x/y", "/img.png").unwrap(),
            "https://a.com/img.png"
        );
        assert_eq!(
            resolve_url("https://a.com/x", "//cdn.b.com/i.png").unwrap(),
            "https://cdn.b.com/i.png"
        );
        assert_eq!(resolve_url("https://a.com", "http://b.com/i.png").unwrap(), "http://b.com/i.png");
        assert!(resolve_url("https://a.com/x", "img.png").is_none());
    }
}
