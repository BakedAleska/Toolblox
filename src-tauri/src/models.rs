//! Typed persisted data and frontend-safe account views.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Which side of the window the sidebar is on.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SidebarPosition {
    Left,
    Right,
}

/// Color theme. `System` follows the operating system.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ThemeMode {
    System,
    Light,
    Dark,
}

/// Account list order. `Manual` keeps the saved order.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SortOrder {
    LastPlayed,
    Alphabetical,
    Manual,
}

/// Saved preferences. Missing fields take defaults, legacy snake_case names are accepted, and
/// unknown fields are preserved.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    #[serde(alias = "sidebar_pos")]
    pub sidebar_pos: SidebarPosition,
    #[serde(alias = "theme_mode")]
    pub theme_mode: ThemeMode,
    #[serde(alias = "show_avatars")]
    pub show_avatars: bool,
    #[serde(alias = "sort_order")]
    pub sort_order: SortOrder,
    #[serde(alias = "compact_mode")]
    pub compact_mode: bool,
    /// Default place to join. Empty when none is set.
    #[serde(alias = "place_id")]
    pub place_id: String,
    /// IDs of installed widgets that are turned off.
    #[serde(alias = "disabled_widgets")]
    pub disabled_widgets: Vec<String>,
    /// Per-widget settings, keyed by widget ID.
    #[serde(alias = "widget_settings")]
    pub widget_settings: BTreeMap<String, Value>,
    /// Allow several Roblox clients at once (Windows only).
    #[serde(alias = "multi_instance")]
    pub multi_instance: bool,
    #[serde(alias = "auto_rejoin")]
    pub auto_rejoin: bool,
    /// Launch Toolblox at login.
    #[serde(alias = "open_on_launch")]
    pub open_on_launch: bool,
    /// Closing the window hides to the tray instead of quitting.
    #[serde(alias = "run_in_background")]
    pub run_in_background: bool,
    /// IDs of widgets whose processes start with the app.
    #[serde(alias = "widgets_start_on_launch")]
    pub widgets_start_on_launch: Vec<String>,
    /// Minimize the window after a manual join.
    pub minimize_on_join: bool,
    /// Look up and show game names for accounts in game.
    pub show_game_names: bool,
    /// Notify when an account leaves a game.
    pub notify_on_drop: bool,
    pub always_on_top: bool,
    /// Recently used places, newest first.
    pub recent_places: Vec<RecentPlace>,
    /// Unknown fields, kept when saving.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Most places kept in the recent list.
pub const RECENT_PLACES_LIMIT: usize = 6;

/// A place the user has joined from. `name` is `None` until Toolblox looks it up and empty when
/// Roblox has no name for it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecentPlace {
    pub place_id: String,
    #[serde(default)]
    pub name: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            sidebar_pos: SidebarPosition::Left,
            theme_mode: ThemeMode::System,
            show_avatars: true,
            sort_order: SortOrder::LastPlayed,
            compact_mode: false,
            place_id: String::new(),
            disabled_widgets: Vec::new(),
            widget_settings: BTreeMap::new(),
            multi_instance: false,
            auto_rejoin: false,
            open_on_launch: false,
            run_in_background: true,
            widgets_start_on_launch: Vec::new(),
            minimize_on_join: false,
            show_game_names: true,
            notify_on_drop: false,
            always_on_top: false,
            recent_places: Vec::new(),
            extra: Map::new(),
        }
    }
}

impl Settings {
    /// Checks the place IDs, recent places, and widget IDs. Returns a user-facing message on failure.
    pub fn validate(&self) -> Result<(), String> {
        if !self.place_id.is_empty() && !is_place_id(&self.place_id) {
            return Err("The saved place ID isn't valid. Can you enter it again?".into());
        }
        if self.recent_places.len() > RECENT_PLACES_LIMIT
            || self.recent_places.iter().any(|place| {
                !is_place_id(&place.place_id)
                    || place
                        .name
                        .as_ref()
                        .is_some_and(|name| name.chars().count() > 100)
            })
        {
            return Err("The recent places list isn't valid. Can you set the place again?".into());
        }
        for id in self
            .disabled_widgets
            .iter()
            .chain(&self.widgets_start_on_launch)
            .chain(self.widget_settings.keys())
        {
            validate_widget_id(id)?;
        }
        Ok(())
    }

    /// Moves a place to the front of the recent list, keeping any name already looked up.
    pub fn remember_place(&mut self, place_id: &str) {
        let existing = self
            .recent_places
            .iter()
            .position(|place| place.place_id == place_id);
        let place = match existing {
            Some(index) => self.recent_places.remove(index),
            None => RecentPlace {
                place_id: place_id.to_string(),
                name: None,
            },
        };
        self.recent_places.insert(0, place);
        self.recent_places.truncate(RECENT_PLACES_LIMIT);
    }
}

/// Whether `value` is a Roblox place ID: 1 to 20 ASCII digits.
pub fn is_place_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 20 && value.bytes().all(|byte| byte.is_ascii_digit())
}

/// Accepts non-empty IDs of ASCII letters, digits, `_`, and `-`.
fn validate_widget_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err("A saved widget ID isn't valid. Can you reinstall the widget?".into());
    }
    Ok(())
}

/// A saved account. The session is stored separately in the credential store.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StoredAccount {
    pub id: u64,
    pub name: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
    #[serde(default)]
    pub notes: String,
    /// Unix time, in seconds, the account was added.
    pub added_at: f64,
    /// Unix time, in seconds, of the last manual join.
    #[serde(default)]
    pub last_played_at: Option<f64>,
    /// Number of manual joins.
    #[serde(default)]
    pub play_count: u64,
    /// Per-widget data for this account, keyed by widget ID.
    #[serde(default)]
    pub widget_data: BTreeMap<String, Value>,
    /// Place this account joins instead of the default place.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub place_id: Option<String>,
    /// Place of the last manual join.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_place_id: Option<String>,
    /// Unknown fields, kept when saving.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl StoredAccount {
    /// Checks the IDs, dates, place IDs, and widget IDs, and rejects legacy fields that look like
    /// secrets. Returns a user-facing message on failure.
    pub fn validate(&self) -> Result<(), String> {
        if self.id == 0 || self.name.trim().is_empty() {
            return Err("A saved account is incomplete. Can you add the account again?".into());
        }
        if !self.added_at.is_finite() || self.added_at < 0.0 {
            return Err(
                "A saved account has an invalid date. Can you add the account again?".into(),
            );
        }
        if self
            .last_played_at
            .is_some_and(|value| !value.is_finite() || value < 0.0)
        {
            return Err("A saved account has an invalid play date. Can you add it again?".into());
        }
        for id in self.widget_data.keys() {
            validate_widget_id(id)?;
        }
        if self.place_id.as_deref().is_some_and(|id| !is_place_id(id)) {
            return Err("A saved account has an invalid place ID. Can you set it again?".into());
        }
        if self
            .last_place_id
            .as_deref()
            .is_some_and(|id| !is_place_id(id))
        {
            return Err("A saved account has an invalid last place. Can you join again?".into());
        }
        if self.extra.keys().any(|key| {
            let key = key.to_ascii_lowercase();
            key.contains("cookie") || key.contains("secret") || key.contains("ticket")
        }) {
            return Err(
                "A saved account contains unsafe legacy data. Can you migrate it again?".into(),
            );
        }
        Ok(())
    }

    /// Records a manual join at `timestamp` (Unix seconds) to `place_id`.
    pub fn record_play(&mut self, timestamp: f64, place_id: &str) -> Result<(), String> {
        if !timestamp.is_finite() || timestamp < 0.0 {
            return Err("The play time wasn't valid. Can you try joining again?".into());
        }
        self.play_count = self.play_count.saturating_add(1);
        self.last_played_at = Some(timestamp);
        self.last_place_id = Some(place_id.to_owned());
        Ok(())
    }
}

/// The account fields sent to the interface. Never includes the session or widget data.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccountDto {
    pub id: u64,
    pub name: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
    pub notes: String,
    pub added_at: f64,
    pub last_played_at: Option<f64>,
    pub play_count: u64,
    pub place_id: Option<String>,
    pub last_place_id: Option<String>,
}

impl From<&StoredAccount> for AccountDto {
    fn from(account: &StoredAccount) -> Self {
        Self {
            id: account.id,
            name: account.name.clone(),
            display_name: account.display_name.clone(),
            avatar_url: account.avatar_url.clone(),
            notes: account.notes.clone(),
            added_at: account.added_at,
            last_played_at: account.last_played_at,
            play_count: account.play_count,
            place_id: account.place_id.clone(),
            last_place_id: account.last_place_id.clone(),
        }
    }
}

/// An account's Roblox presence.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PresenceState {
    Offline,
    /// On Roblox but not in a game.
    Online,
    InGame,
    InStudio,
    /// Roblox returned a presence type Toolblox doesn't know.
    Unknown,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_the_legacy_app() {
        let settings = Settings::default();
        assert_eq!(settings.sidebar_pos, SidebarPosition::Left);
        assert_eq!(settings.theme_mode, ThemeMode::System);
        assert!(settings.show_avatars);
        assert_eq!(settings.sort_order, SortOrder::LastPlayed);
        assert!(settings.run_in_background);
        assert!(!settings.auto_rejoin);
        assert!(settings.show_game_names);
        assert!(!settings.minimize_on_join);
    }

    #[test]
    fn recent_places_move_to_front_keep_names_and_cap() {
        let mut settings = Settings::default();
        for id in 1..=7 {
            settings.remember_place(&id.to_string());
        }
        assert_eq!(settings.recent_places.len(), RECENT_PLACES_LIMIT);
        assert_eq!(settings.recent_places[0].place_id, "7");
        settings.recent_places[2].name = Some("Five".into());
        settings.remember_place("5");
        assert_eq!(settings.recent_places[0].place_id, "5");
        assert_eq!(settings.recent_places[0].name.as_deref(), Some("Five"));
        assert_eq!(settings.recent_places.len(), RECENT_PLACES_LIMIT);
        assert!(settings.validate().is_ok());
        settings.recent_places[1].place_id = "12a".into();
        assert!(settings.validate().is_err());
    }

    #[test]
    fn account_place_override_must_be_numeric() {
        let mut account: StoredAccount = serde_json::from_str(
            r#"{"id":1,"name":"a","display_name":"a","avatar_url":null,"added_at":1.0}"#,
        )
        .unwrap();
        assert_eq!(account.place_id, None);
        account.place_id = Some("1818".into());
        assert!(account.validate().is_ok());
        account.place_id = Some("not-a-place".into());
        assert!(account.validate().is_err());
    }

    #[test]
    fn record_play_remembers_the_place() {
        let mut account: StoredAccount = serde_json::from_str(
            r#"{"id":1,"name":"a","display_name":"a","avatar_url":null,"added_at":1.0}"#,
        )
        .unwrap();
        assert_eq!(account.last_place_id, None);
        account.record_play(2.0, "1818").unwrap();
        assert_eq!(account.last_place_id.as_deref(), Some("1818"));
        assert_eq!(account.last_played_at, Some(2.0));
        assert!(account.validate().is_ok());
        account.last_place_id = Some("1818/x".into());
        assert!(account.validate().is_err());
    }

    #[test]
    fn account_dto_never_serializes_a_secret_field() {
        let account = StoredAccount {
            id: 1,
            name: "builderman".into(),
            display_name: "Builderman".into(),
            avatar_url: None,
            notes: String::new(),
            added_at: 1.0,
            last_played_at: None,
            play_count: 0,
            widget_data: BTreeMap::new(),
            place_id: None,
            last_place_id: None,
            extra: Map::new(),
        };
        let json = serde_json::to_string(&AccountDto::from(&account)).unwrap();
        assert!(!json.contains("cookie"));
        assert!(!json.contains("secret"));
        assert!(!json.contains("widget_data"));
    }
}
