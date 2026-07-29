//! Speech-to-text and text-to-speech via OpenAI's audio APIs.
//!
//! Powers the voice features (voice notes, speak-aloud, live voice) that the
//! web/desktop/mobile clients call through `/api/channels/{id}/voice` and
//! `/api/messages/{id}/speech`. Enabled by setting `OPENAI_API_KEY` in the
//! server's environment; without it the endpoints return a clear 400 and the
//! clients hide their voice controls (`voice: false` in `/api/me`).
//!
//! Mirrors Pantheo's `engine/transcription.py` / `engine/tts.py` so the same
//! models and behavior apply on both sides of the bridge.

use std::io::Read;
use std::time::Duration;

const STT_MODEL: &str = "gpt-4o-mini-transcribe";
const TTS_MODEL: &str = "gpt-4o-mini-tts";
const TTS_VOICE: &str = "alloy";

/// The speech API caps input at 4096 chars; clip a bit below to stay safe.
const MAX_TTS_CHARS: usize = 4000;
const MIN_TTS_CHUNK_CHARS: usize = 20;

const TIMEOUT: Duration = Duration::from_secs(120);

/// The key that enables voice, straight from the process env (no config-file
/// storage: this is a secret, and the server env is the deployment boundary).
pub fn api_key() -> Option<String> {
    std::env::var("OPENAI_API_KEY")
        .ok()
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
}

/// Turn visually formatted chat text into deterministic spoken prose.
///
/// This deliberately does not ask a model to rewrite the message: speech must
/// remain the same answer the user can read. It only removes content that
/// should never be voiced and converts visual structure into pauses.
pub fn normalize_for_tts(text: &str) -> String {
    let text = ["think", "thinking", "reasoning"]
        .into_iter()
        .fold(text.to_string(), |text, tag| strip_complete_tagged_blocks(&text, tag));
    let add_pauses = text.lines().filter(|line| !line.trim().is_empty()).count() > 1;
    let mut lines = Vec::new();
    let mut in_fence = false;
    for raw in text.lines() {
        let trimmed = raw.trim();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence || trimmed.is_empty() {
            continue;
        }
        if trimmed
            .chars()
            .all(|c| matches!(c, '|' | '-' | ':' | ' '))
        {
            continue;
        }
        let line = strip_structural_line_prefix(trimmed);
        let line = strip_ordered_list_prefix(line);
        let line = if line.contains('|') {
            line.split('|')
                .map(str::trim)
                .filter(|cell| !cell.is_empty())
                .map(clean_inline_markdown)
                .collect::<Vec<_>>()
                .join(", ")
        } else {
            clean_inline_markdown(line)
        };
        if line.is_empty() {
            continue;
        }
        let mut line = line;
        if add_pauses && !line.ends_with(['.', '!', '?', ';', ':']) {
            line.push('.');
        }
        lines.push(line);
    }
    lines.join(" ").split_whitespace().collect::<Vec<_>>().join(" ")
}

fn strip_complete_tagged_blocks(text: &str, tag: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    // Exact tags only. Treating every `<think...` prefix as markup can pair a
    // literal mention in prose with a later close tag and delete visible text.
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    loop {
        let lower = rest.to_ascii_lowercase();
        let Some(start) = lower.find(&open) else {
            out.push_str(rest);
            break;
        };
        let after_open = &rest[start..];
        let after_lower = &lower[start..];
        let Some(end) = after_lower.find(&close) else {
            // Literal or malformed prose must remain speakable. Only remove a
            // reasoning block when both exact tags are present.
            out.push_str(rest);
            break;
        };
        out.push_str(&rest[..start]);
        rest = &after_open[end + close.len()..];
    }
    out
}

fn strip_structural_line_prefix(line: &str) -> &str {
    let bytes = line.as_bytes();
    if bytes.len() >= 2
        && matches!(bytes[0], b'-' | b'+' | b'*' | b'>')
        && bytes[1].is_ascii_whitespace()
    {
        return line[2..].trim_start();
    }
    let hashes = bytes.iter().take_while(|b| **b == b'#').count();
    if hashes > 0 && bytes.get(hashes).is_some_and(u8::is_ascii_whitespace) {
        return line[hashes + 1..].trim_start();
    }
    line
}

fn strip_ordered_list_prefix(line: &str) -> &str {
    let digits = line.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 {
        return line;
    }
    let bytes = line.as_bytes();
    if matches!(bytes.get(digits), Some(b'.' | b')'))
        && bytes.get(digits + 1).is_some_and(u8::is_ascii_whitespace)
    {
        line[digits + 2..].trim_start()
    } else {
        line
    }
}

fn clean_inline_markdown(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        let remaining: String = chars[i..].iter().take(8).collect();
        if remaining.starts_with("https://") || remaining.starts_with("http://") {
            while chars.get(i).is_some_and(|c| !c.is_whitespace()) {
                i += 1;
            }
            continue;
        }
        // Images and links speak their readable label, never the destination.
        let image = chars[i] == '!' && chars.get(i + 1) == Some(&'[');
        if chars[i] == '[' || image {
            let label_start = i + if image { 2 } else { 1 };
            if let Some(label_end) = chars[label_start..].iter().position(|c| *c == ']') {
                let label_end = label_start + label_end;
                if chars.get(label_end + 1) == Some(&'(') {
                    if let Some(url_end) = chars[label_end + 2..].iter().position(|c| *c == ')') {
                        out.extend(chars[label_start..label_end].iter());
                        i = label_end + 2 + url_end + 1;
                        continue;
                    }
                }
            }
        }
        let c = chars[i];
        if c == '|' {
            out.push_str(", ");
        } else {
            out.push(c);
        }
        i += 1;
    }
    // Preserve asterisks/underscores/tildes: they may be literal operators or
    // identifiers. Backticks alone are unambiguous paired presentation marks.
    let out = strip_paired_marker(&out, "`");
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn strip_paired_marker(text: &str, marker: &str) -> String {
    let mut text = text.to_string();
    let mut from = 0;
    while let Some(start) = text[from..].find(marker).map(|i| from + i) {
        let content_start = start + marker.len();
        let Some(end) = text[content_start..].find(marker).map(|i| content_start + i) else {
            break;
        };
        if end == content_start {
            from = end + marker.len();
            continue;
        }
        text.replace_range(end..end + marker.len(), "");
        text.replace_range(start..content_start, "");
        from = end - marker.len();
    }
    text
}

/// Normalize and clip overly long replies at a sentence-ish boundary.
pub fn clip_for_tts(text: &str) -> String {
    let normalized = normalize_for_tts(text);
    let text = normalized.trim();
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= MAX_TTS_CHARS {
        return text.to_string();
    }
    let clipped: String = chars[..MAX_TTS_CHARS].iter().collect();
    let cut = clipped.rfind(". ").into_iter().chain(clipped.rfind('\n')).max();
    match cut {
        Some(cut) if cut > clipped.len() / 2 => clipped[..=cut].trim().to_string(),
        _ => clipped.trim().to_string(),
    }
}

/// Deterministically split one stored message into sequential speech requests.
pub fn chunks_for_tts(text: &str) -> Vec<String> {
    let text = clip_for_tts(text);
    if text.is_empty() {
        return Vec::new();
    }
    let chars: Vec<char> = text.chars().collect();
    let mut chunks = Vec::new();
    let mut start = 0;
    let mut i = 0;
    while i < chars.len() {
        let boundary = matches!(chars[i], '.' | '!' | '?')
            && chars.get(i + 1).is_none_or(|c| c.is_whitespace());
        if boundary {
            let candidate: String = chars[start..=i].iter().collect();
            if candidate.trim().chars().count() >= MIN_TTS_CHUNK_CHARS {
                chunks.push(candidate.trim().to_string());
                start = i + 1;
                while chars.get(start).is_some_and(|c| c.is_whitespace()) {
                    start += 1;
                }
            }
        }
        i += 1;
    }
    if start < chars.len() {
        let tail: String = chars[start..].iter().collect();
        let tail = tail.trim();
        if !tail.is_empty() {
            if let Some(last) = chunks.last_mut().filter(|_| tail.chars().count() < MIN_TTS_CHUNK_CHARS)
            {
                last.push(' ');
                last.push_str(tail);
            } else {
                chunks.push(tail.to_string());
            }
        }
    }
    chunks
}

/// Transcribe an audio clip (webm/ogg/m4a/wav…). The API infers the codec
/// from the filename extension. Blocking — run via `spawn_blocking`.
pub fn transcribe(key: &str, data: &[u8], filename: &str) -> anyhow::Result<String> {
    let boundary = format!("agora{}", crate::store::new_token());
    let mut body: Vec<u8> = Vec::with_capacity(data.len() + 512);
    let part = |body: &mut Vec<u8>, headers: &str| {
        body.extend_from_slice(format!("--{boundary}\r\n{headers}\r\n\r\n").as_bytes());
    };
    part(&mut body, "Content-Disposition: form-data; name=\"model\"");
    body.extend_from_slice(STT_MODEL.as_bytes());
    body.extend_from_slice(b"\r\n");
    let safe_name: String = filename
        .chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, '.' | '-' | '_'))
        .take(80)
        .collect();
    let safe_name = if safe_name.is_empty() { "voice-note.webm".into() } else { safe_name };
    part(
        &mut body,
        &format!(
            "Content-Disposition: form-data; name=\"file\"; filename=\"{safe_name}\"\r\n\
             Content-Type: application/octet-stream"
        ),
    );
    body.extend_from_slice(data);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());

    let response = ureq::post("https://api.openai.com/v1/audio/transcriptions")
        .timeout(TIMEOUT)
        .set("Authorization", &format!("Bearer {key}"))
        .set("Content-Type", &format!("multipart/form-data; boundary={boundary}"))
        .send_bytes(&body)
        .map_err(flatten_api_error)?;
    let parsed: serde_json::Value = response.into_json()?;
    Ok(parsed["text"].as_str().unwrap_or_default().trim().to_string())
}

/// Render text to MP3 bytes (Safari's `<audio>` can't decode Opus).
/// Blocking — run via `spawn_blocking`.
pub fn synthesize(key: &str, text: &str) -> anyhow::Result<Vec<u8>> {
    let input = clip_for_tts(text);
    synthesize_input(key, &input)
}

/// Render an already normalized sentence chunk without altering its meaning.
pub fn synthesize_chunk(key: &str, text: &str) -> anyhow::Result<Vec<u8>> {
    anyhow::ensure!(!text.trim().is_empty(), "nothing to speak");
    anyhow::ensure!(text.chars().count() <= MAX_TTS_CHARS, "speech chunk too long");
    synthesize_input(key, text.trim())
}

fn synthesize_input(key: &str, input: &str) -> anyhow::Result<Vec<u8>> {
    anyhow::ensure!(!input.is_empty(), "nothing to speak");
    let response = ureq::post("https://api.openai.com/v1/audio/speech")
        .timeout(TIMEOUT)
        .set("Authorization", &format!("Bearer {key}"))
        .send_json(serde_json::json!({
            "model": TTS_MODEL,
            "voice": TTS_VOICE,
            "input": input,
            "response_format": "mp3",
        }))
        .map_err(flatten_api_error)?;
    let mut audio = Vec::new();
    response
        .into_reader()
        .take(32 * 1024 * 1024)
        .read_to_end(&mut audio)?;
    anyhow::ensure!(!audio.is_empty(), "empty audio response");
    Ok(audio)
}

/// Pull the API's error message out of a non-2xx response so logs say
/// "invalid api key" instead of just "status 401".
fn flatten_api_error(e: ureq::Error) -> anyhow::Error {
    match e {
        ureq::Error::Status(code, response) => {
            let body = response.into_string().unwrap_or_default();
            let detail = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| v["error"]["message"].as_str().map(String::from))
                .unwrap_or(body);
            anyhow::anyhow!("OpenAI API error {code}: {}", detail.chars().take(300).collect::<String>())
        }
        other => anyhow::anyhow!(other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clip_for_tts_passes_short_text_and_cuts_long_text_at_sentences() {
        assert_eq!(clip_for_tts("  hello there  "), "hello there");
        let long = format!("{}. {}", "a".repeat(3000), "b".repeat(3000));
        let clipped = clip_for_tts(&long);
        assert!(clipped.len() <= MAX_TTS_CHARS);
        assert!(clipped.ends_with('.'));
    }

    #[test]
    fn normalize_for_tts_removes_visual_and_private_content() {
        let text = "# Weather\n\n- Read the [forecast](https://example.com).\n\
                    ```rust\nprintln!(\"not spoken\");\n```\n\
                    <think>private reasoning</think>\n\
                    | City | Rain |\n| --- | --- |\n| Kochi | likely |";
        assert_eq!(
            normalize_for_tts(text),
            "Weather. Read the forecast. City, Rain. Kochi, likely."
        );
    }

    #[test]
    fn chunks_for_tts_merges_tiny_fragments_and_flushes_tail() {
        assert_eq!(
            chunks_for_tts("Hi! This is a useful first sentence. This is the second sentence. Tail"),
            vec![
                "Hi! This is a useful first sentence.",
                "This is the second sentence. Tail"
            ]
        );
        assert!(chunks_for_tts("```\nonly_code();\n```").is_empty());
    }

    #[test]
    fn normalization_preserves_signs_decimals_and_literal_symbols() {
        let text = "-5°C was the low.\n+3°C tomorrow.\n3.5 hours later.\n\
                    2*3=6; user_id stays; allow 5~10 minutes.";
        assert_eq!(
            normalize_for_tts(text),
            "-5°C was the low. +3°C tomorrow. 3.5 hours later. \
             2*3=6; user_id stays; allow 5~10 minutes."
        );
        let chunks = chunks_for_tts(text);
        assert!(chunks[0].starts_with("-5°C"));
    }

    #[test]
    fn reasoning_cleanup_requires_complete_exact_tags() {
        assert_eq!(
            normalize_for_tts("<thinking>plan</thinking> The answer is 42."),
            "The answer is 42."
        );
        assert_eq!(
            normalize_for_tts("The literal <think tag remains speakable."),
            "The literal <think tag remains speakable."
        );
        assert_eq!(
            normalize_for_tts("<think>unfinished but user-visible"),
            "<think>unfinished but user-visible"
        );
        assert_eq!(
            normalize_for_tts(
                "<thinking>outline</thinking> Answer. <think>hidden</think> Bye."
            ),
            "Answer. Bye."
        );
        assert_eq!(
            normalize_for_tts(
                "A literal <think reference stays. <think>hidden</think> Answer."
            ),
            "A literal <think reference stays. Answer."
        );
    }

    #[test]
    fn inline_code_preserves_literal_exponents() {
        assert_eq!(
            normalize_for_tts("`2**3` and `4**5` remain literal."),
            "2**3 and 4**5 remain literal."
        );
    }

    #[test]
    fn api_key_requires_non_empty_env() {
        // Not set in the test env; the endpoints must gate cleanly on None.
        if std::env::var("OPENAI_API_KEY").is_err() {
            assert!(api_key().is_none());
        }
    }
}
