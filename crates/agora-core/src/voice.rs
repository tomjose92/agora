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

const TIMEOUT: Duration = Duration::from_secs(120);

/// The key that enables voice, straight from the process env (no config-file
/// storage: this is a secret, and the server env is the deployment boundary).
pub fn api_key() -> Option<String> {
    std::env::var("OPENAI_API_KEY")
        .ok()
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
}

/// Clip overly long replies at a sentence-ish boundary for speech.
pub fn clip_for_tts(text: &str) -> String {
    let text = text.trim();
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
    response.into_reader().take(32 * 1024 * 1024).read_to_end(&mut audio)?;
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
    fn api_key_requires_non_empty_env() {
        // Not set in the test env; the endpoints must gate cleanly on None.
        if std::env::var("OPENAI_API_KEY").is_err() {
            assert!(api_key().is_none());
        }
    }
}
