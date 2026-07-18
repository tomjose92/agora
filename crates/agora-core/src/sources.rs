//! Trailing source-list handling for agent messages.
//!
//! Research-style agent replies end with a "Sources:" block — a marker line
//! followed by one URL per line (the convention Pantheo's research skill
//! uses). Rendered raw, those URLs dominate the bubble; instead the hub
//! lifts them into ``meta.sources`` (a normalized ``[{url, title?}]`` array)
//! and records where the block starts (``meta.sources_start``) so clients
//! can collapse the tail into a compact chip row while the stored text —
//! which is the search/history/export contract — stays untouched. An agent
//! can also send a structured ``sources`` list on its `post` frame; that
//! list wins over detection, which then only supplies the collapse offset.

use serde_json::{json, Value};

/// Hard cap on sources kept per message, structured or detected.
pub const MAX_SOURCES: usize = 20;
/// Longest accepted source URL; anything longer is dropped, not cut.
const MAX_URL_CHARS: usize = 2048;
/// Longest kept source title; longer titles are cut at a char boundary.
const MAX_TITLE_CHARS: usize = 200;

/// Normalize an agent-supplied `sources` value — an array of URL strings or
/// `{url, title?}` objects — into the canonical stored array. `None` when
/// nothing valid remains, so callers can fall back to text detection.
pub fn normalize_sources(value: &Value) -> Option<Value> {
    let items = value.as_array()?;
    let mut out: Vec<Value> = Vec::new();
    for item in items {
        if out.len() >= MAX_SOURCES {
            break;
        }
        let (url, title) = match item {
            Value::String(s) => (s.as_str(), None),
            Value::Object(_) => (
                item["url"].as_str().unwrap_or_default(),
                item["title"].as_str(),
            ),
            _ => continue,
        };
        let url = url.trim();
        if valid_url(url) && !out.iter().any(|s| s["url"] == url) {
            out.push(source_entry(url, title));
        }
    }
    (!out.is_empty()).then(|| Value::Array(out))
}

/// Detect a trailing sources block: a `Sources:` / `References:` marker line
/// (heading/bold decorations tolerated) followed only by blank or source
/// lines until the end of the text. Returns the marker's offset in **UTF-16
/// code units** — the unit both clients' strings slice by — plus the parsed
/// list. The whole tail must parse: one prose line under the marker means
/// this is regular text, not a block.
pub fn extract_trailing_sources(text: &str) -> Option<(usize, Value)> {
    let mut lines = Vec::new();
    let mut pos = 0;
    for line in text.split('\n') {
        lines.push((pos, line));
        pos += line.len() + 1;
    }
    // Only the *last* marker can head a trailing block; if its tail fails,
    // any earlier marker's tail contains the same offending line.
    let (idx, start, inline) = lines
        .iter()
        .enumerate()
        .rev()
        .find_map(|(i, (p, l))| marker_rest(l).map(|rest| (i, *p, rest)))?;
    let mut out: Vec<Value> = Vec::new();
    let inline = inline.trim().trim_matches(|c| c == '*' || c == '_');
    if !inline.is_empty() {
        // Single-line form: `Sources: <url> <url>…` — every token must be a URL.
        for tok in inline.split([' ', '\t', ',']).filter(|t| !t.is_empty()) {
            let url = tok.trim_end_matches(['.', ',', ';', ')', ']']);
            if !valid_url(url) {
                return None;
            }
            push_source(&mut out, url, None);
        }
    }
    for (_, line) in &lines[idx + 1..] {
        if line.trim().is_empty() {
            continue;
        }
        let (url, title) = parse_source_line(line)?;
        push_source(&mut out, url, title);
    }
    // A bare "Sources:" with nothing under it is prose, not a block. The
    // marker itself must also not be the whole message.
    (!out.is_empty() && start > 0)
        .then(|| (text[..start].encode_utf16().count(), Value::Array(out)))
}

fn push_source(out: &mut Vec<Value>, url: &str, title: Option<&str>) {
    if out.len() < MAX_SOURCES && !out.iter().any(|s| s["url"] == url) {
        out.push(source_entry(url, title));
    }
}

fn source_entry(url: &str, title: Option<&str>) -> Value {
    let mut obj = serde_json::Map::new();
    obj.insert("url".into(), json!(url));
    if let Some(t) = title.map(str::trim).filter(|t| !t.is_empty()) {
        let cut: String = t.chars().take(MAX_TITLE_CHARS).collect();
        obj.insert("title".into(), json!(cut));
    }
    Value::Object(obj)
}

/// Cheap shape check, not a parser: http(s) scheme + non-empty host, no
/// whitespace or control chars. Fetch-time SSRF checks live with the fetcher.
fn valid_url(s: &str) -> bool {
    if s.len() > MAX_URL_CHARS || s.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return false;
    }
    let rest = match s.strip_prefix("https://").or_else(|| s.strip_prefix("http://")) {
        Some(r) => r,
        None => return false,
    };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    !host.is_empty()
}

/// `Some(rest)` when the line is a sources marker — `Sources:`,
/// `## References`, `**Sources:**` — where `rest` is whatever follows the
/// colon (the single-line form; empty for the usual list-header form).
fn marker_rest(line: &str) -> Option<&str> {
    let t = line.trim().trim_start_matches('#').trim_start();
    let t = t.trim_start_matches(['*', '_']);
    let lower = t.to_lowercase();
    for word in ["sources", "source", "references", "citations"] {
        if !lower.starts_with(word) {
            continue;
        }
        let after = t[word.len()..].trim_start_matches(['*', '_']).trim_start();
        if let Some(rest) = after.strip_prefix(':') {
            return Some(rest);
        }
        if after.is_empty() {
            return Some("");
        }
    }
    None
}

/// One line of a sources block → its URL (+ markdown label when present).
/// The line must *lead* with the link after list/citation prefixes — a URL
/// buried mid-sentence doesn't make a line a source. Trailing prose after
/// the link (`— publisher`) is tolerated but not kept.
fn parse_source_line(line: &str) -> Option<(&str, Option<&str>)> {
    let t = line.trim();
    let t = t.trim_start_matches(['-', '*', '•', '>']).trim_start();
    let t = strip_citation_prefix(t);
    if let Some(rest) = t.strip_prefix('[') {
        let (title, rest) = rest.split_once("](")?;
        let url = rest.split_once(')')?.0.trim();
        return valid_url(url).then_some((url, Some(title)));
    }
    let url = t
        .split_whitespace()
        .next()?
        .trim_end_matches(['.', ',', ';', ')', ']']);
    valid_url(url).then_some((url, None))
}

/// Strip `[1]`, `[1]:`, `1.`, `1)` citation prefixes. A numeric markdown
/// label (`[1](url)`) is left intact for the link parser.
fn strip_citation_prefix(t: &str) -> &str {
    if let Some(rest) = t.strip_prefix('[') {
        if let Some((num, after)) = rest.split_once(']') {
            if !num.is_empty()
                && num.chars().all(|c| c.is_ascii_digit())
                && !after.starts_with('(')
            {
                return after.trim_start_matches(':').trim_start();
            }
        }
    }
    let digits = t.chars().take_while(|c| c.is_ascii_digit()).count();
    if digits > 0 {
        if let Some(rest) = t[digits..].strip_prefix(['.', ')']) {
            return rest.trim_start();
        }
    }
    t
}

/// Every http(s) URL in `text` in order of appearance, deduped — markdown
/// link targets and bare URLs alike. Feeds the unfurl pass, which caps and
/// filters further (sources excluded there, not here).
pub fn extract_urls(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut last_end = 0;
    for (start, _) in text.match_indices("http") {
        // Skip "http" inside a URL already captured ("…?ref=http…").
        if start < last_end {
            continue;
        }
        let tail = &text[start..];
        if !tail.starts_with("http://") && !tail.starts_with("https://") {
            continue;
        }
        let end = tail
            .find(|c: char| c.is_whitespace() || c.is_control() || "<>\"'`)]".contains(c))
            .unwrap_or(tail.len());
        last_end = start + end;
        let url = tail[..end].trim_end_matches(['.', ',', ';', ':', '!', '?']);
        if valid_url(url) && !out.iter().any(|u| u == url) {
            out.push(url.to_string());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_plain_trailing_block() {
        let text = "Answer here.\n\nSources:\nhttps://a.com/x\nhttps://b.com/y";
        let (start, list) = extract_trailing_sources(text).unwrap();
        assert_eq!(start, "Answer here.\n\n".len());
        let urls: Vec<_> = list
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["url"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(urls, ["https://a.com/x", "https://b.com/y"]);
    }

    #[test]
    fn detects_decorated_markers_and_list_forms() {
        for marker in ["**Sources:**", "## References", "Sources", "citations:"] {
            let text = format!(
                "Body.\n\n{marker}\n- [Doc](https://a.com)\n[1] https://b.com\n2. https://c.com — note"
            );
            let (_, list) = extract_trailing_sources(&text).expect(marker);
            let list = list.as_array().unwrap();
            assert_eq!(list.len(), 3, "{marker}");
            assert_eq!(list[0]["title"], "Doc");
            assert_eq!(list[2]["url"], "https://c.com");
        }
    }

    #[test]
    fn detects_single_line_form() {
        let (start, list) =
            extract_trailing_sources("Done.\nSources: https://a.com, https://b.com.").unwrap();
        assert_eq!(start, "Done.\n".len());
        assert_eq!(list.as_array().unwrap().len(), 2);
        assert_eq!(list[0]["url"], "https://a.com");
    }

    #[test]
    fn prose_after_marker_is_not_a_block() {
        assert!(extract_trailing_sources("Sources: unclear.\nMore prose.").is_none());
        assert!(extract_trailing_sources("Check the sources:\nhttps://a.com\nBut also this.").is_none());
        // A message that *is* only a sources block stays visible as text.
        assert!(extract_trailing_sources("Sources:\nhttps://a.com").is_none());
        // Mid-sentence URLs are not sources.
        assert!(extract_trailing_sources("See https://a.com for details.").is_none());
        assert!(extract_trailing_sources("No marker at all\nhttps://a.com").is_none());
    }

    #[test]
    fn offset_counts_utf16_units() {
        let text = "emoji 🎉 first.\nSources:\nhttps://a.com";
        let (start, _) = extract_trailing_sources(text).unwrap();
        // "emoji 🎉 first.\n" = 15 chars but 16 UTF-16 units (🎉 is a surrogate pair).
        assert_eq!(start, 16);
    }

    #[test]
    fn dedupes_and_caps() {
        let urls: Vec<String> = (0..30).map(|i| format!("https://a.com/{}", i % 25)).collect();
        let text = format!("Body.\nSources:\n{}", urls.join("\n"));
        let (_, list) = extract_trailing_sources(&text).unwrap();
        assert_eq!(list.as_array().unwrap().len(), MAX_SOURCES);
    }

    #[test]
    fn normalizes_structured_input() {
        let val = json!([
            "https://a.com",
            {"url": " https://b.com ", "title": "  B  "},
            {"url": "ftp://nope.com"},
            {"title": "no url"},
            "https://a.com",
            42,
        ]);
        let list = normalize_sources(&val).unwrap();
        let list = list.as_array().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0]["url"], "https://a.com");
        assert!(list[0].get("title").is_none());
        assert_eq!(list[1]["url"], "https://b.com");
        assert_eq!(list[1]["title"], "B");
        assert!(normalize_sources(&json!([])).is_none());
        assert!(normalize_sources(&json!(["mailto:x@y.z"])).is_none());
        assert!(normalize_sources(&json!("https://a.com")).is_none());
    }

    #[test]
    fn extract_urls_finds_bare_and_markdown_targets() {
        let urls = extract_urls(
            "See [doc](https://a.com/path) and https://b.com/x?q=1. Also (https://c.com).",
        );
        assert_eq!(urls, ["https://a.com/path", "https://b.com/x?q=1", "https://c.com"]);
        assert!(extract_urls("no links here").is_empty());
    }
}
