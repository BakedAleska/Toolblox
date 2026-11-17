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

/// Which accounts' online friends the dashboard lists.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FriendsSource {
    All,
    #[default]
    Pinned,
    LastPlayed,
}

/// Saved preferences. Missing fields take defaults and unknown fields are preserved.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub sidebar_pos: SidebarPosition,
    pub theme_mode: ThemeMode,
    pub show_avatars: bool,
    pub sort_order: SortOrder,
    pub compact_mode: bool,
    /// Default place to join. Empty when none is set.
    pub place_id: String,
    /// IDs of installed widgets that are turned off.
    pub disabled_widgets: Vec<String>,
    /// Per-widget settings, keyed by widget ID.
    pub widget_settings: BTreeMap<String, Value>,
    /// Allow several Roblox clients at once (Windows only).
    pub multi_instance: bool,
    /// Seconds between account launches in a batch.
    pub join_delay_seconds: u64,
    pub auto_rejoin: bool,
    /// Launch Toolblox at login.
    pub open_on_launch: bool,
    /// Closing the window hides to the tray instead of quitting.
    pub run_in_background: bool,
    /// Minimize the window after a manual join.
    pub minimize_on_join: bool,
    /// Notify when an account leaves a game.
    pub notify_on_drop: bool,
    pub always_on_top: bool,
    /// Animate transitions, menus, and notifications.
    pub show_animations: bool,
    /// Play full animations even when the OS asks for reduced motion.
    pub ignore_reduced_motion: bool,
    /// Skip toasts that confirm a finished action.
    pub reduce_toasts: bool,
    /// Whose online friends the dashboard lists.
    pub friends_source: FriendsSource,
    /// Open the Widgets page at installed widgets instead of scrolling to the catalogue.
    pub widgets_open_installed: bool,
    /// Recently used places, newest first.
    pub recent_places: Vec<RecentPlace>,
    /// Named sets of accounts that join together.
    pub groups: Vec<AccountGroup>,
    /// Colored labels shown on accounts.
    pub tags: Vec<AccountTag>,
    /// Toolblox version that last opened with these settings. `None` before 0.4.8.
    pub last_seen_version: Option<String>,
    /// Unknown fields, kept when saving.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Most places kept in the recent list.
pub const RECENT_PLACES_LIMIT: usize = 5;

/// Largest recent list a saved settings file may contain. Older versions kept more than
/// `RECENT_PLACES_LIMIT`, so longer lists still load and are trimmed when shown or saved.
const MAX_RECENT_PLACES: usize = 10;

/// A place Roblox confirmed exists. `name` is `None` until Toolblox looks it up.
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
            join_delay_seconds: 1,
            auto_rejoin: false,
            open_on_launch: false,
            run_in_background: true,
            minimize_on_join: false,
            notify_on_drop: false,
            always_on_top: false,
            show_animations: true,
            ignore_reduced_motion: false,
            reduce_toasts: false,
            friends_source: FriendsSource::Pinned,
            widgets_open_installed: false,
            recent_places: Vec::new(),
            groups: Vec::new(),
            tags: Vec::new(),
            last_seen_version: None,
            extra: Map::new(),
        }
    }
}

impl Settings {
    /// Checks the place IDs, recent places, widget IDs, and core limit. Returns a
    /// user-facing message on failure.
    pub fn validate(&self) -> Result<(), String> {
        if self.join_delay_seconds > 60 {
            return Err("The join delay isn't valid. Can you choose 0 to 60 seconds?".into());
        }
        if !self.place_id.is_empty() && !is_join_target(&self.place_id) {
            return Err("The saved place ID isn't valid. Can you enter it again?".into());
        }
        if self.recent_places.len() > MAX_RECENT_PLACES
            || self.recent_places.iter().any(|place| {
                !is_join_target(&place.place_id)
                    || place
                        .name
                        .as_ref()
                        .is_some_and(|name| name.chars().count() > 100)
            })
        {
            return Err("The recent places list isn't valid. Can you set the place again?".into());
        }
        validate_groups(&self.groups)?;
        validate_tags(&self.tags)?;
        for id in self
            .disabled_widgets
            .iter()
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

/// Whether `value` is a stored join target: a place ID, or `@` and a user ID.
pub fn is_join_target(value: &str) -> bool {
    is_place_id(value.strip_prefix('@').unwrap_or(value))
}

/// Most groups a settings file may hold.
pub const MAX_GROUPS: usize = 50;
/// Most accounts one group may hold.
const MAX_GROUP_MEMBERS: usize = 200;

/// A named set of accounts that join together. Pinning a group shows the group on the dashboard,
/// not its accounts. `account_ids` may name removed accounts, which the interface leaves out.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccountGroup {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub account_ids: Vec<u64>,
    #[serde(default)]
    pub pinned: bool,
    /// Where the group joins: a place ID, or `@` and a user ID. `None` uses each account's own.
    #[serde(default)]
    pub place_id: Option<String>,
    #[serde(default)]
    pub notes: String,
}

/// Checks the group list: unique IDs of 1 to 64 letters, digits, and `-`, names of 1 to 50
/// characters, unique members, valid destinations, and notes up to 1,000 characters.
fn validate_groups(groups: &[AccountGroup]) -> Result<(), String> {
    let invalid = || Err("A saved group isn't valid. Can you edit it again?".to_string());
    if groups.len() > MAX_GROUPS {
        return Err(format!(
            "There are more than {MAX_GROUPS} groups. Can you delete some?"
        ));
    }
    let mut ids = std::collections::BTreeSet::new();
    for group in groups {
        let name = group.name.trim();
        let mut members = std::collections::BTreeSet::new();
        if group.id.is_empty()
            || group.id.len() > 64
            || !group
                .id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            || !ids.insert(group.id.as_str())
            || name.is_empty()
            || name.chars().count() > 50
            || group.account_ids.len() > MAX_GROUP_MEMBERS
            || !group
                .account_ids
                .iter()
                .all(|id| *id > 0 && members.insert(*id))
            || group
                .place_id
                .as_deref()
                .is_some_and(|id| !is_join_target(id))
            || group.notes.chars().count() > 1_000
        {
            return invalid();
        }
    }
    Ok(())
}

/// Most tags a settings file may hold.
pub const MAX_TAGS: usize = 50;

/// A tag's color, drawn from the theme's `--tag-*` tokens.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TagColor {
    Gray,
    Red,
    Orange,
    Yellow,
    Green,
    Blue,
}

/// A colored label on any number of accounts. `account_ids` may name removed accounts, which the
/// interface leaves out.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccountTag {
    pub id: String,
    pub name: String,
    pub color: TagColor,
    #[serde(default)]
    pub account_ids: Vec<u64>,
    /// Members while a game is the default destination, by place ID. `account_ids` holds the
    /// members when no game is.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub games: BTreeMap<String, Vec<u64>>,
}

/// Most characters in one account note.
pub const MAX_NOTE_CHARS: usize = 10_000;

/// Checks the tag list: unique IDs of 1 to 64 letters, digits, and `-`, names of 1 to 30
/// characters, unique members, and place IDs as game keys.
fn validate_tags(tags: &[AccountTag]) -> Result<(), String> {
    if tags.len() > MAX_TAGS {
        return Err(format!(
            "There are more than {MAX_TAGS} tags. Can you delete some?"
        ));
    }
    let mut ids = std::collections::BTreeSet::new();
    for tag in tags {
        let name = tag.name.trim();
        let mut members = std::collections::BTreeSet::new();
        if tag.id.is_empty()
            || tag.id.len() > 64
            || !tag
                .id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            || !ids.insert(tag.id.as_str())
            || name.is_empty()
            || name.chars().count() > 30
            || !tag
                .account_ids
                .iter()
                .all(|id| *id > 0 && members.insert(*id))
            || !tag.games.iter().all(|(place_id, ids)| {
                let mut members = std::collections::BTreeSet::new();
                is_place_id(place_id) && ids.iter().all(|id| *id > 0 && members.insert(*id))
            })
        {
            return Err("A saved tag isn't valid. Can you edit it again?".into());
        }
    }
    Ok(())
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
    /// Notes shown while a game is the default destination, by place ID. `notes` is shown when no
    /// game is.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub game_notes: BTreeMap<String, String>,
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
    /// Shown on the dashboard.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub pinned: bool,
    /// Unknown fields, kept when saving.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl StoredAccount {
    /// Checks the IDs, dates, place IDs, and widget IDs, and rejects fields that look like secrets.
    /// Returns a user-facing message on failure.
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
        if self
            .place_id
            .as_deref()
            .is_some_and(|id| !is_join_target(id))
        {
            return Err("A saved account has an invalid place ID. Can you set it again?".into());
        }
        if self
            .last_place_id
            .as_deref()
            .is_some_and(|id| !is_place_id(id))
        {
            return Err("A saved account has an invalid last place. Can you join again?".into());
        }
        if self
            .game_notes
            .iter()
            .any(|(place_id, note)| !is_place_id(place_id) || note.chars().count() > MAX_NOTE_CHARS)
        {
            return Err("A saved account has an invalid game note. Can you edit it again?".into());
        }
        if self.extra.keys().any(|key| is_secret_key(key)) {
            return Err(
                "A saved account contains session data. Can you add the account again?".into(),
            );
        }
        Ok(())
    }

    /// Removes unknown fields that look like secrets, such as the cookies older versions saved
    /// with each account. Returns whether any were removed.
    pub fn remove_secrets(&mut self) -> bool {
        let count = self.extra.len();
        self.extra.retain(|key, _| !is_secret_key(key));
        self.extra.len() != count
    }

    /// Records a manual join at `timestamp` (Unix seconds) to `place_id`, when the place is known.
    pub fn record_play(&mut self, timestamp: f64, place_id: Option<&str>) -> Result<(), String> {
        if !timestamp.is_finite() || timestamp < 0.0 {
            return Err("The play time isn't valid. Can you try joining again?".into());
        }
        self.play_count = self.play_count.saturating_add(1);
        self.last_played_at = Some(timestamp);
        if let Some(place_id) = place_id {
            self.last_place_id = Some(place_id.to_owned());
        }
        Ok(())
    }
}

/// Whether an unknown account field name looks like it holds a session secret.
fn is_secret_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    ["cookie", "secret", "security", "ticket"]
        .iter()
        .any(|word| key.contains(word))
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
    pub game_notes: BTreeMap<String, String>,
    pub added_at: f64,
    pub last_played_at: Option<f64>,
    pub play_count: u64,
    pub place_id: Option<String>,
    pub last_place_id: Option<String>,
    pub pinned: bool,
}

impl From<&StoredAccount> for AccountDto {
    fn from(account: &StoredAccount) -> Self {
        Self {
            id: account.id,
            name: account.name.clone(),
            display_name: account.display_name.clone(),
            avatar_url: account.avatar_url.clone(),
            notes: account.notes.clone(),
            game_notes: account.game_notes.clone(),
            added_at: account.added_at,
            last_played_at: account.last_played_at,
            play_count: account.play_count,
            place_id: account.place_id.clone(),
            last_place_id: account.last_place_id.clone(),
            pinned: account.pinned,
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
    fn defaults_are_stable() {
        let settings = Settings::default();
        assert_eq!(settings.sidebar_pos, SidebarPosition::Left);
        assert_eq!(settings.theme_mode, ThemeMode::System);
        assert!(settings.show_avatars);
        assert_eq!(settings.sort_order, SortOrder::LastPlayed);
        assert!(settings.run_in_background);
        assert!(!settings.auto_rejoin);
        assert!(!settings.minimize_on_join);
        assert_eq!(settings.join_delay_seconds, 1);
    }

    #[test]
    fn join_delay_defaults_and_validates_saved_values() {
        let legacy: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(legacy.join_delay_seconds, 1);
        for seconds in [0, 1, 10, 60, 61] {
            let saved: Settings = serde_json::from_value(serde_json::json!({
                "joinDelaySeconds": seconds
            }))
            .unwrap();
            assert_eq!(saved.validate().is_ok(), seconds <= 60);
        }
        for value in [
            serde_json::json!(-1),
            serde_json::json!(1.5),
            serde_json::json!("5"),
        ] {
            assert!(
                serde_json::from_value::<Settings>(serde_json::json!({
                    "joinDelaySeconds": value
                }))
                .is_err()
            );
        }
    }

    #[test]
    fn tags_need_unique_safe_ids_names_members_and_known_colors() {
        let tag = |id: &str, name: &str, members: &[u64]| AccountTag {
            id: id.into(),
            name: name.into(),
            color: TagColor::Blue,
            account_ids: members.to_vec(),
            games: Default::default(),
        };
        let mut settings = Settings {
            tags: vec![tag("main", "Main", &[1, 2]), tag("alt-1", "Alts", &[])],
            ..Settings::default()
        };
        assert!(settings.validate().is_ok());
        for invalid in [
            tag("main", "Duplicate", &[]),
            tag("", "Empty ID", &[]),
            tag("has space", "Space", &[]),
            tag("blank", "  ", &[]),
            tag("long", &"n".repeat(31), &[]),
            tag("twice", "Twice", &[3, 3]),
            tag("zero", "Zero", &[0]),
        ] {
            let mut bad = settings.clone();
            bad.tags.push(invalid);
            assert!(bad.validate().is_err());
        }
        let mut per_game = tag("game", "Raider", &[]);
        per_game.games.insert("2753915549".into(), vec![1, 2]);
        settings.tags.push(per_game.clone());
        assert!(settings.validate().is_ok());
        for (place_id, members) in [
            ("not-a-place", vec![1]),
            ("2753915549", vec![1, 1]),
            ("2753915549", vec![0]),
        ] {
            let mut bad = settings.clone();
            bad.tags.last_mut().unwrap().games = [(place_id.to_string(), members)].into();
            assert!(bad.validate().is_err());
        }
        settings.tags = (0..=MAX_TAGS)
            .map(|i| tag(&i.to_string(), "Tag", &[]))
            .collect();
        assert!(settings.validate().is_err());
        let loaded: Settings = serde_json::from_value(serde_json::json!({
            "tags": [{ "id": "a", "name": "Old", "color": "green" }]
        }))
        .unwrap();
        assert_eq!(loaded.tags[0].color, TagColor::Green);
        assert!(loaded.tags[0].account_ids.is_empty());
        assert!(
            serde_json::from_value::<Settings>(serde_json::json!({
                "tags": [{ "id": "a", "name": "Old", "color": "magenta" }]
            }))
            .is_err()
        );
    }

    #[test]
    fn groups_need_unique_safe_ids_names_members_and_valid_destinations() {
        let group = |id: &str, name: &str, members: &[u64]| AccountGroup {
            id: id.into(),
            name: name.into(),
            account_ids: members.to_vec(),
            pinned: false,
            place_id: None,
            notes: String::new(),
        };
        let mut settings = Settings {
            groups: vec![
                group("a-1", "Farming", &[1, 2]),
                group("b", "Trading", &[2]),
            ],
            ..Settings::default()
        };
        assert!(settings.validate().is_ok());
        settings.groups[0].place_id = Some("@156".into());
        assert!(settings.validate().is_ok());
        for invalid in [
            group("a-1", "Duplicate", &[]),
            group("", "No ID", &[]),
            group("bad/id", "Slash", &[]),
            group("c", "  ", &[]),
            group("c", &"x".repeat(51), &[]),
            group("c", "Repeat", &[3, 3]),
            group("c", "Zero", &[0]),
        ] {
            let mut bad = settings.clone();
            bad.groups.push(invalid);
            assert!(bad.validate().is_err());
        }
        let mut bad = settings.clone();
        bad.groups[1].place_id = Some("not-a-place".into());
        assert!(bad.validate().is_err());
        bad.groups[1].place_id = None;
        bad.groups[1].notes = "n".repeat(1_001);
        assert!(bad.validate().is_err());
        let many = Settings {
            groups: (0..=MAX_GROUPS)
                .map(|index| group(&index.to_string(), "G", &[]))
                .collect(),
            ..Settings::default()
        };
        assert!(many.validate().is_err());
        let loaded: Settings = serde_json::from_value(serde_json::json!({
            "groups": [{ "id": "a", "name": "Old" }]
        }))
        .unwrap();
        assert_eq!(loaded.groups[0].account_ids, Vec::<u64>::new());
        assert!(!loaded.groups[0].pinned);
    }

    #[test]
    fn friends_source_defaults_to_pinned_and_reads_each_choice() {
        let parse = |json: serde_json::Value| {
            serde_json::from_value::<Settings>(json).map(|settings| settings.friends_source)
        };
        assert_eq!(parse(serde_json::json!({})).unwrap(), FriendsSource::Pinned);
        assert_eq!(
            parse(serde_json::json!({ "friendsSource": "all" })).unwrap(),
            FriendsSource::All
        );
        assert_eq!(
            parse(serde_json::json!({ "friendsSource": "last_played" })).unwrap(),
            FriendsSource::LastPlayed
        );
        assert!(parse(serde_json::json!({ "friendsSource": "everyone" })).is_err());
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
        settings.place_id = "@156".into();
        settings.recent_places[1].place_id = "@156".into();
        assert!(settings.validate().is_ok());
        settings.recent_places[1].place_id = "12a".into();
        assert!(settings.validate().is_err());
    }

    #[test]
    fn longer_saved_recent_lists_still_load() {
        let saved: Settings = serde_json::from_str(
            r#"{"recentPlaces":[{"placeId":"1"},{"placeId":"2"},{"placeId":"3"},{"placeId":"4"},{"placeId":"5"},{"placeId":"6"}]}"#,
        )
        .unwrap();
        assert!(saved.validate().is_ok());
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
        account.place_id = Some("@156".into());
        assert!(account.validate().is_ok());
        for invalid in ["not-a-place", "@", "@@156", "@builderman", "156@"] {
            account.place_id = Some(invalid.into());
            assert!(account.validate().is_err(), "{invalid}");
        }
    }

    #[test]
    fn record_play_remembers_the_place() {
        let mut account: StoredAccount = serde_json::from_str(
            r#"{"id":1,"name":"a","display_name":"a","avatar_url":null,"added_at":1.0}"#,
        )
        .unwrap();
        assert_eq!(account.last_place_id, None);
        account.record_play(2.0, Some("1818")).unwrap();
        assert_eq!(account.last_place_id.as_deref(), Some("1818"));
        assert_eq!(account.last_played_at, Some(2.0));
        account.record_play(3.0, None).unwrap();
        assert_eq!(account.last_place_id.as_deref(), Some("1818"));
        assert_eq!(account.last_played_at, Some(3.0));
        assert!(account.validate().is_ok());
        account.last_place_id = Some("1818/x".into());
        assert!(account.validate().is_err());
    }

    #[test]
    fn game_notes_need_place_ids_and_a_length_limit() {
        let mut account: StoredAccount = serde_json::from_value(serde_json::json!({
            "id": 1, "name": "builderman", "display_name": "Builderman", "avatar_url": null, "added_at": 1.0
        }))
        .unwrap();
        assert!(account.game_notes.is_empty());
        account
            .game_notes
            .insert("2753915549".into(), "Raids".into());
        assert!(account.validate().is_ok());
        account
            .game_notes
            .insert("2753915549".into(), "n".repeat(MAX_NOTE_CHARS + 1));
        assert!(account.validate().is_err());
        account.game_notes = [("@156".to_string(), "Follow".to_string())].into();
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
            game_notes: Default::default(),
            added_at: 1.0,
            last_played_at: None,
            play_count: 0,
            widget_data: BTreeMap::new(),
            place_id: None,
            last_place_id: None,
            pinned: false,
            extra: Map::new(),
        };
        let json = serde_json::to_string(&AccountDto::from(&account)).unwrap();
        assert!(!json.contains("cookie"));
        assert!(!json.contains("secret"));
        assert!(!json.contains("widget_data"));
    }

    #[test]
    fn pinned_defaults_to_false_and_round_trips() {
        let mut account: StoredAccount = serde_json::from_str(
            r#"{"id":1,"name":"a","display_name":"a","avatar_url":null,"added_at":1}"#,
        )
        .unwrap();
        assert!(!account.pinned);
        assert!(!serde_json::to_string(&account).unwrap().contains("pinned"));
        account.pinned = true;
        let saved: StoredAccount =
            serde_json::from_str(&serde_json::to_string(&account).unwrap()).unwrap();
        assert!(saved.pinned);
        assert!(saved.extra.is_empty());
    }
}
