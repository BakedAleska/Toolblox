//! Versioned, permission-checked messages exchanged with isolated widget frames.

use std::collections::{HashMap, HashSet, VecDeque};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::widgets::WidgetPermission;

/// Protocol version every widget message must carry.
pub const WIDGET_PROTOCOL_VERSION: u32 = 1;
/// Largest accepted widget message, in bytes.
pub const MAX_WIDGET_MESSAGE_BYTES: usize = 64 * 1024;

/// A method call sent by a widget frame.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetRequest {
    pub protocol: u32,
    /// Widget-chosen ID echoed in the response, up to 128 bytes.
    pub request_id: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

/// The reply to a widget request. Exactly one of `result` and `error` is set.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetResponse {
    pub protocol: u32,
    pub request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// One widget frame's identity, granted permissions, and request rate.
#[derive(Debug)]
pub struct WidgetSession {
    pub widget_id: String,
    pub permissions: HashSet<WidgetPermission>,
    /// Times of requests in the last second, for rate limiting.
    recent_requests: VecDeque<Instant>,
}

impl WidgetSession {
    /// Starts a session with the widget's granted permissions.
    pub fn new(widget_id: String, permissions: impl IntoIterator<Item = WidgetPermission>) -> Self {
        Self {
            widget_id,
            permissions: permissions.into_iter().collect(),
            recent_requests: VecDeque::new(),
        }
    }

    /// Parses a message and checks its size, rate, protocol version, request ID, and the permission
    /// its method requires.
    pub fn parse_and_authorize(&mut self, message: &[u8]) -> Result<WidgetRequest, String> {
        if message.len() > MAX_WIDGET_MESSAGE_BYTES {
            return Err("The widget message is too large.".into());
        }
        self.enforce_rate_limit(Instant::now())?;
        let request: WidgetRequest = serde_json::from_slice(message)
            .map_err(|_| "The widget message isn't valid JSON.".to_string())?;
        if request.protocol != WIDGET_PROTOCOL_VERSION {
            return Err("The widget protocol version isn't supported.".into());
        }
        if request.request_id.is_empty() || request.request_id.len() > 128 {
            return Err("The widget request ID isn't valid.".into());
        }
        let permission = permission_for_method(&request.method)
            .ok_or_else(|| "The widget method isn't supported.".to_string())?;
        if !self.permissions.contains(&permission) {
            return Err("The widget hasn't been granted permission for this action.".into());
        }
        Ok(request)
    }

    /// Allows at most 30 requests per rolling second.
    fn enforce_rate_limit(&mut self, now: Instant) -> Result<(), String> {
        while self
            .recent_requests
            .front()
            .is_some_and(|time| now.duration_since(*time) > Duration::from_secs(1))
        {
            self.recent_requests.pop_front();
        }
        if self.recent_requests.len() >= 30 {
            return Err("The widget is sending requests too quickly.".into());
        }
        self.recent_requests.push_back(now);
        Ok(())
    }
}

/// Active widget frame sessions, keyed by an opaque session ID.
#[derive(Default)]
pub struct WidgetSessions {
    sessions: HashMap<String, WidgetSession>,
}

impl WidgetSessions {
    /// Registers a session.
    pub fn insert(&mut self, session_id: String, session: WidgetSession) {
        self.sessions.insert(session_id, session);
    }

    /// Ends a session.
    pub fn remove(&mut self, session_id: &str) -> Option<WidgetSession> {
        self.sessions.remove(session_id)
    }

    /// Authorizes a message for a session, rejecting it when the claimed widget ID doesn't match
    /// the session's widget.
    pub fn authorize(
        &mut self,
        session_id: &str,
        claimed_widget_id: &str,
        message: &[u8],
    ) -> Result<WidgetRequest, String> {
        let session = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| "The widget session isn't active.".to_string())?;
        if session.widget_id != claimed_widget_id {
            return Err("The widget session identity doesn't match.".into());
        }
        session.parse_and_authorize(message)
    }
}

/// Builds a successful response.
pub fn success(request_id: String, result: Value) -> WidgetResponse {
    WidgetResponse {
        protocol: WIDGET_PROTOCOL_VERSION,
        request_id,
        result: Some(result),
        error: None,
    }
}

/// Builds an error response.
pub fn failure(request_id: String, error: impl Into<String>) -> WidgetResponse {
    WidgetResponse {
        protocol: WIDGET_PROTOCOL_VERSION,
        request_id,
        result: None,
        error: Some(error.into()),
    }
}

/// Returns the permission a method requires, or `None` for unknown methods.
fn permission_for_method(method: &str) -> Option<WidgetPermission> {
    match method {
        "accounts.list" => Some(WidgetPermission::AccountsReadBasic),
        "widgetData.get" => Some(WidgetPermission::WidgetDataRead),
        "widgetData.set" => Some(WidgetPermission::WidgetDataWrite),
        "roblox.status" => Some(WidgetPermission::RobloxStatus),
        "roblox.join" => Some(WidgetPermission::RobloxJoin),
        "network.fetch" => Some(WidgetPermission::NetworkFetch),
        "process.spawn" | "process.send" | "process.poll" | "process.stop" => {
            Some(WidgetPermission::ProcessSpawn)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn denies_methods_without_declared_permission() {
        let mut session = WidgetSession::new("sample".into(), []);
        let message = br#"{"protocol":1,"requestId":"one","method":"accounts.list"}"#;
        assert!(session.parse_and_authorize(message).is_err());
    }

    #[test]
    fn rejects_a_claimed_identity_mismatch() {
        let mut sessions = WidgetSessions::default();
        sessions.insert(
            "session".into(),
            WidgetSession::new("sample".into(), [WidgetPermission::WidgetDataRead]),
        );
        let message = br#"{"protocol":1,"requestId":"one","method":"widgetData.get"}"#;
        assert!(sessions.authorize("session", "other", message).is_err());
    }

    #[test]
    fn accepts_a_valid_scoped_request() {
        let mut session = WidgetSession::new("sample".into(), [WidgetPermission::WidgetDataWrite]);
        let message =
            br#"{"protocol":1,"requestId":"one","method":"widgetData.set","params":{"value":1}}"#;
        let request = session.parse_and_authorize(message).unwrap();
        assert_eq!(request.method, "widgetData.set");
    }
}
