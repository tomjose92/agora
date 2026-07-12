//! AI answers over search ("ask Agora"): retrieve candidate messages with the
//! FTS index, then have Claude synthesize a short, cited answer from those
//! excerpts. Powers `POST /api/search/ask`.
//!
//! Enabled by setting `ANTHROPIC_API_KEY` in the server's environment (same
//! pattern as voice's `OPENAI_API_KEY`: secrets live in the deployment env,
//! not config.json); without it the endpoint returns a clear 400 and the
//! clients hide their "Ask AI" controls (`search_ai: false` in `/api/me`).

use std::time::Duration;

use serde_json::{json, Value};

/// Default model for answer synthesis; override with `AGORA_AI_MODEL`.
const DEFAULT_MODEL: &str = "claude-sonnet-5";

const ANTHROPIC_URL: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const TIMEOUT: Duration = Duration::from_secs(60);
const MAX_ANSWER_TOKENS: u32 = 1024;

/// Cap on retrieved messages handed to the model as context.
pub const CONTEXT_MESSAGES: usize = 30;
/// Cap on keywords extracted from the question for retrieval.
const MAX_KEYWORDS: usize = 12;

/// The key that enables AI answers, straight from the process env.
pub fn api_key() -> Option<String> {
    std::env::var("ANTHROPIC_API_KEY")
        .ok()
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
}

pub fn model() -> String {
    std::env::var("AGORA_AI_MODEL")
        .ok()
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| DEFAULT_MODEL.to_string())
}

/// Question words that carry no retrieval signal. Small on purpose: a missed
/// stopword just adds one low-weight OR term.
const STOPWORDS: &[&str] = &[
    "a", "an", "and", "any", "are", "about", "been", "but", "can", "could", "did", "do", "does",
    "for", "from", "had", "has", "have", "how", "into", "is", "it", "its", "of", "on", "or",
    "our", "she", "should", "that", "the", "their", "them", "then", "there", "these", "they",
    "this", "was", "we", "were", "what", "when", "where", "which", "who", "why", "will", "with",
    "would", "you", "your",
];

/// Distill a natural-language question into a recall-oriented keyword list
/// for FTS retrieval ("What did we decide about the deploy?" -> "decide
/// deploy"). Returns None when nothing survives — the caller should fall
/// back to the raw question.
pub fn retrieval_keywords(question: &str) -> Option<String> {
    let mut seen = std::collections::HashSet::new();
    let words: Vec<String> = question
        .split(|c: char| !c.is_alphanumeric())
        .map(str::to_lowercase)
        .filter(|w| w.len() >= 2 && !STOPWORDS.contains(&w.as_str()))
        .filter(|w| seen.insert(w.clone()))
        .take(MAX_KEYWORDS)
        .collect();
    if words.is_empty() {
        None
    } else {
        Some(words.join(" "))
    }
}

/// Ask Claude to answer `question` from numbered message excerpts (the rows
/// `Store::search_messages` returns). Blocking — run via `spawn_blocking`.
/// Returns the answer text, which cites excerpts as [1], [2], ….
pub fn answer(key: &str, model: &str, question: &str, context: &[Value]) -> anyhow::Result<String> {
    anyhow::ensure!(!context.is_empty(), "no matching messages to answer from");
    let excerpts: String = context
        .iter()
        .enumerate()
        .map(|(i, m)| {
            let author = m["author_name"]
                .as_str()
                .filter(|s| !s.is_empty())
                .or_else(|| m["author_id"].as_str())
                .unwrap_or("unknown");
            let where_ = format!(
                "{} / #{}",
                m["group_name"].as_str().unwrap_or(""),
                m["channel_name"].as_str().unwrap_or(""),
            );
            let ts = crate::hub::format_ts(m["ts"].as_f64().unwrap_or(0.0));
            let text: String = m["text"].as_str().unwrap_or("").chars().take(1500).collect();
            format!("[{}] ({where_} — {author}, {ts})\n{text}\n", i + 1)
        })
        .collect();
    let system = "You answer questions about a chat workspace from message excerpts found by \
                  full-text search. Use only the excerpts as evidence. Cite the excerpts that \
                  support each claim inline as [1], [2] (the client links them to the original \
                  messages). Be direct and brief: answer first, in a few sentences; use Markdown \
                  lists only when the answer is genuinely a list. If the excerpts don't answer \
                  the question, say so plainly and mention the closest related thing they do \
                  cover. Never invent message content.";
    let prompt = format!("Question: {question}\n\nMessage excerpts:\n\n{excerpts}");
    let response = ureq::post(ANTHROPIC_URL)
        .timeout(TIMEOUT)
        .set("x-api-key", key)
        .set("anthropic-version", ANTHROPIC_VERSION)
        .send_json(json!({
            "model": model,
            "max_tokens": MAX_ANSWER_TOKENS,
            "system": system,
            "messages": [{"role": "user", "content": prompt}],
        }))
        .map_err(flatten_api_error)?;
    let parsed: Value = response.into_json()?;
    let text = parsed["content"]
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|b| b["text"].as_str())
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default();
    anyhow::ensure!(!text.trim().is_empty(), "empty answer from model");
    Ok(text.trim().to_string())
}

/// Pull the API's error message out of a non-2xx response so logs say
/// "invalid x-api-key" instead of just "status 401".
fn flatten_api_error(e: ureq::Error) -> anyhow::Error {
    match e {
        ureq::Error::Status(code, response) => {
            let body = response.into_string().unwrap_or_default();
            let detail = serde_json::from_str::<Value>(&body)
                .ok()
                .and_then(|v| v["error"]["message"].as_str().map(String::from))
                .unwrap_or(body);
            anyhow::anyhow!(
                "Anthropic API error {code}: {}",
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
    fn retrieval_keywords_drops_stopwords_and_dedupes() {
        assert_eq!(
            retrieval_keywords("What did we decide about the deploy deploy?"),
            Some("decide deploy".to_string())
        );
        assert_eq!(retrieval_keywords("what is the of"), None);
        assert_eq!(retrieval_keywords(""), None);
    }

    #[test]
    fn api_key_requires_non_empty_env() {
        if std::env::var("ANTHROPIC_API_KEY").is_err() {
            assert!(api_key().is_none());
        }
    }
}
