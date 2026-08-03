//! Speech-to-text via OpenAI and text-to-speech via ElevenLabs with OpenAI
//! fallback.
//!
//! Powers the voice features (voice notes, speak-aloud, live voice) that the
//! web/desktop/mobile clients call through `/api/channels/{id}/voice` and
//! `/api/messages/{id}/speech`. Voice input is enabled by `OPENAI_API_KEY`;
//! when `ELEVENLABS_API_KEY` is also set, spoken replies prefer ElevenLabs and
//! fall back to OpenAI on every failure.
//!
//! Mirrors Pantheo's `engine/transcription.py` / `engine/tts.py` so the same
//! models and behavior apply on both sides of the bridge.

use std::io::Read;
use std::time::Duration;

const STT_MODEL: &str = "gpt-4o-mini-transcribe";
const TTS_MODEL: &str = "gpt-4o-mini-tts";
const TTS_VOICE: &str = "alloy";
const ELEVENLABS_MODEL: &str = "eleven_flash_v2_5";
const ELEVENLABS_VOICE: &str = "21m00Tcm4TlvDq8ikWAM"; // Rachel, premade.
const ELEVENLABS_OUTPUT: &str = "mp3_44100_128";

/// The speech API caps input at 4096 chars; clip a bit below to stay safe.
const MAX_TTS_CHARS: usize = 4000;

const TIMEOUT: Duration = Duration::from_secs(120);
const ELEVENLABS_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, PartialEq, Eq)]
struct ElevenLabsConfig {
    key: String,
    voice_id: String,
    model_id: String,
}

/// The key that enables voice, straight from the process env (no config-file
/// storage: this is a secret, and the server env is the deployment boundary).
pub fn openai_api_key() -> Option<String> {
    std::env::var("OPENAI_API_KEY")
        .ok()
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
}

fn non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn elevenlabs_config_from(
    key: Option<String>,
    voice_id: Option<String>,
    model_id: Option<String>,
) -> Option<ElevenLabsConfig> {
    Some(ElevenLabsConfig {
        key: non_empty(key)?,
        voice_id: non_empty(voice_id).unwrap_or_else(|| ELEVENLABS_VOICE.to_string()),
        model_id: non_empty(model_id).unwrap_or_else(|| ELEVENLABS_MODEL.to_string()),
    })
}

fn elevenlabs_config() -> Option<ElevenLabsConfig> {
    elevenlabs_config_from(
        std::env::var("ELEVENLABS_API_KEY").ok(),
        std::env::var("ELEVENLABS_VOICE_ID").ok(),
        std::env::var("ELEVENLABS_MODEL_ID").ok(),
    )
}

/// Clip overly long replies at a sentence-ish boundary for speech.
pub fn clip_for_tts(text: &str) -> String {
    let text = text.trim();
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= MAX_TTS_CHARS {
        return text.to_string();
    }
    let clipped: String = chars[..MAX_TTS_CHARS].iter().collect();
    let cut = clipped
        .rfind(". ")
        .into_iter()
        .chain(clipped.rfind('\n'))
        .max();
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
    let safe_name = if safe_name.is_empty() {
        "voice-note.webm".into()
    } else {
        safe_name
    };
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
        .set(
            "Content-Type",
            &format!("multipart/form-data; boundary={boundary}"),
        )
        .send_bytes(&body)
        .map_err(|e| flatten_api_error("OpenAI", e))?;
    let parsed: serde_json::Value = response.into_json()?;
    Ok(parsed["text"]
        .as_str()
        .unwrap_or_default()
        .trim()
        .to_string())
}

/// Render text to MP3 bytes (Safari's `<audio>` can't decode Opus).
/// Blocking — run via `spawn_blocking`.
pub fn synthesize(openai_key: &str, text: &str) -> anyhow::Result<Vec<u8>> {
    let input = clip_for_tts(text);
    anyhow::ensure!(!input.is_empty(), "nothing to speak");
    let elevenlabs = elevenlabs_config();
    synthesize_with_fallback(
        elevenlabs.as_ref(),
        |config| synthesize_elevenlabs(config, &input),
        || synthesize_openai(openai_key, &input),
    )
}

fn synthesize_with_fallback<F, G>(
    elevenlabs: Option<&ElevenLabsConfig>,
    try_elevenlabs: F,
    try_openai: G,
) -> anyhow::Result<Vec<u8>>
where
    F: FnOnce(&ElevenLabsConfig) -> anyhow::Result<Vec<u8>>,
    G: FnOnce() -> anyhow::Result<Vec<u8>>,
{
    if let Some(config) = elevenlabs {
        match try_elevenlabs(config) {
            Ok(audio) => return Ok(audio),
            Err(e) => {
                tracing::warn!("ElevenLabs speech synthesis failed; falling back to OpenAI: {e}")
            }
        }
    }
    try_openai()
}

fn synthesize_openai(key: &str, input: &str) -> anyhow::Result<Vec<u8>> {
    let response = ureq::post("https://api.openai.com/v1/audio/speech")
        .timeout(TIMEOUT)
        .set("Authorization", &format!("Bearer {key}"))
        .send_json(serde_json::json!({
            "model": TTS_MODEL,
            "voice": TTS_VOICE,
            "input": input,
            "response_format": "mp3",
        }))
        .map_err(|e| flatten_api_error("OpenAI", e))?;
    read_audio(response)
}

fn synthesize_elevenlabs(config: &ElevenLabsConfig, input: &str) -> anyhow::Result<Vec<u8>> {
    anyhow::ensure!(
        config
            .voice_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_')),
        "invalid ELEVENLABS_VOICE_ID"
    );
    let url = format!(
        "https://api.elevenlabs.io/v1/text-to-speech/{}?output_format={}",
        config.voice_id, ELEVENLABS_OUTPUT
    );
    let response = ureq::post(&url)
        .timeout(ELEVENLABS_TIMEOUT)
        .set("xi-api-key", &config.key)
        .send_json(serde_json::json!({
            "text": input,
            "model_id": config.model_id,
        }))
        .map_err(|e| flatten_api_error("ElevenLabs", e))?;
    read_audio(response)
}

fn read_audio(response: ureq::Response) -> anyhow::Result<Vec<u8>> {
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
fn flatten_api_error(provider: &str, e: ureq::Error) -> anyhow::Error {
    match e {
        ureq::Error::Status(code, response) => {
            let body = response.into_string().unwrap_or_default();
            let detail = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| v["error"]["message"].as_str().map(String::from))
                .unwrap_or(body);
            anyhow::anyhow!(
                "{provider} API error {code}: {}",
                detail.chars().take(300).collect::<String>()
            )
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
    fn openai_api_key_requires_non_empty_env() {
        // Not set in the test env; the endpoints must gate cleanly on None.
        if std::env::var("OPENAI_API_KEY").is_err() {
            assert!(openai_api_key().is_none());
        }
    }

    #[test]
    fn elevenlabs_config_needs_a_key_and_defaults_voice_and_model() {
        assert!(elevenlabs_config_from(None, None, None).is_none());
        assert!(elevenlabs_config_from(Some("  ".into()), None, None).is_none());
        assert_eq!(
            elevenlabs_config_from(Some(" key ".into()), None, None),
            Some(ElevenLabsConfig {
                key: "key".into(),
                voice_id: ELEVENLABS_VOICE.into(),
                model_id: ELEVENLABS_MODEL.into(),
            })
        );
        let configured = elevenlabs_config_from(
            Some("key".into()),
            Some(" voice ".into()),
            Some(" model ".into()),
        )
        .unwrap();
        assert_eq!(configured.voice_id, "voice");
        assert_eq!(configured.model_id, "model");
    }

    #[test]
    fn synthesis_prefers_elevenlabs_and_skips_openai_on_success() {
        let config = elevenlabs_config_from(Some("key".into()), None, None).unwrap();
        let audio = synthesize_with_fallback(
            Some(&config),
            |_| Ok(vec![1]),
            || panic!("OpenAI should not run"),
        )
        .unwrap();
        assert_eq!(audio, vec![1]);
    }

    #[test]
    fn synthesis_falls_back_to_openai_after_any_elevenlabs_error() {
        let config = elevenlabs_config_from(Some("key".into()), None, None).unwrap();
        let audio = synthesize_with_fallback(
            Some(&config),
            |_| anyhow::bail!("quota exhausted"),
            || Ok(vec![2]),
        )
        .unwrap();
        assert_eq!(audio, vec![2]);
    }

    #[test]
    fn synthesis_uses_openai_directly_without_elevenlabs() {
        let audio = synthesize_with_fallback(
            None,
            |_| panic!("ElevenLabs should not run"),
            || Ok(vec![3]),
        )
        .unwrap();
        assert_eq!(audio, vec![3]);
    }
}
