//! Expo Push API client for mobile remote notifications.
//!
//! The headless server can't keep a phone's WebSocket alive once iOS suspends
//! the app, so agent messages fan out here to any registered Expo push tokens.
//! Expo relays to APNs/FCM; tickets that report `DeviceNotRegistered` tell us
//! to drop stale tokens from the store.

use serde_json::{json, Value};

const EXPO_PUSH_URL: &str = "https://exp.host/--/api/v2/push/send";

/// One notification destined for every registered device token.
#[derive(Clone, Debug)]
pub struct PushMessage {
    pub title: String,
    pub body: String,
    pub channel_id: String,
    pub thread_id: Option<i64>,
}

/// POST `message` to each `token` via Expo. Returns tokens Expo says are dead
/// so the caller can prune them. Best-effort: network failures return no
/// prunes (retry next message) rather than wiping the table.
pub fn send(message: &PushMessage, tokens: &[String]) -> Vec<String> {
    if tokens.is_empty() {
        return Vec::new();
    }
    let mut data = json!({
        "channel_id": message.channel_id,
    });
    if let Some(tid) = message.thread_id {
        data["thread_id"] = json!(tid);
    }
    let messages: Vec<Value> = tokens
        .iter()
        .map(|token| {
            json!({
                "to": token,
                "title": message.title,
                "body": message.body,
                "data": data,
                "sound": "default",
            })
        })
        .collect();

    let response = match ureq::post(EXPO_PUSH_URL)
        .set("Content-Type", "application/json")
        .set("Accept", "application/json")
        .send_json(json!(messages))
    {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("expo push send failed: {e}");
            return Vec::new();
        }
    };

    let body: Value = match response.into_json() {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("expo push response decode failed: {e}");
            return Vec::new();
        }
    };

    dead_tokens_from_tickets(&body, tokens)
}

/// Pull `DeviceNotRegistered` tokens out of an Expo tickets response.
/// `tickets.data[i]` aligns with the request order of `tokens`.
pub fn dead_tokens_from_tickets(body: &Value, tokens: &[String]) -> Vec<String> {
    let Some(tickets) = body.get("data").and_then(|d| d.as_array()) else {
        return Vec::new();
    };
    let mut dead = Vec::new();
    for (i, ticket) in tickets.iter().enumerate() {
        if ticket.get("status").and_then(|s| s.as_str()) != Some("error") {
            continue;
        }
        let err = ticket
            .pointer("/details/error")
            .and_then(|e| e.as_str())
            .unwrap_or("");
        if err == "DeviceNotRegistered" {
            if let Some(token) = tokens.get(i) {
                dead.push(token.clone());
            }
        } else {
            tracing::warn!(
                "expo push ticket error: {}",
                ticket.get("message").and_then(|m| m.as_str()).unwrap_or(err)
            );
        }
    }
    dead
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prunes_device_not_registered_by_index() {
        let tokens = vec![
            "ExponentPushToken[alive]".into(),
            "ExponentPushToken[dead]".into(),
        ];
        let body = json!({
            "data": [
                {"status": "ok", "id": "xxx"},
                {
                    "status": "error",
                    "message": "\"ExponentPushToken[dead]\" is not a registered push notification recipient",
                    "details": {"error": "DeviceNotRegistered"}
                }
            ]
        });
        assert_eq!(
            dead_tokens_from_tickets(&body, &tokens),
            vec!["ExponentPushToken[dead]".to_string()]
        );
    }

    #[test]
    fn ignores_other_errors_and_malformed_bodies() {
        let tokens = vec!["ExponentPushToken[a]".into()];
        let body = json!({
            "data": [{
                "status": "error",
                "message": "InvalidCredentials",
                "details": {"error": "InvalidCredentials"}
            }]
        });
        assert!(dead_tokens_from_tickets(&body, &tokens).is_empty());
        assert!(dead_tokens_from_tickets(&json!({}), &tokens).is_empty());
    }
}
