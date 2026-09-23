//! Roblox HTTP flows and strict launch-URI construction.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use reqwest::header::{COOKIE, HeaderValue};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::credentials::Secret;
use crate::models::PresenceState;

const AUTH_URL: &str = "https://users.roblox.com/v1/users/authenticated";
const USERS_URL: &str = "https://users.roblox.com/v1/users";
const THUMBNAIL_URL: &str = "https://thumbnails.roblox.com/v1/users/avatar-headshot";
const PRESENCE_URL: &str = "https://presence.roblox.com/v1/presence/users";
const GAMES_URL: &str = "https://games.roblox.com/v1/games";
const PLACE_UNIVERSE_URL: &str = "https://apis.roblox.com/universes/v1/places";
const TICKET_URL: &str = "https://auth.roblox.com/v1/authentication-ticket";
const PLACE_LAUNCHER_URL: &str = "https://assetgame.roblox.com/game/PlaceLauncher.ashx";

static TRACKER_SEQUENCE: AtomicU32 = AtomicU32::new(0);

#[derive(Debug)]
pub enum RobloxError {
    InvalidPlace,
    InvalidResponse,
    Network,
    Rejected(u16),
}

impl fmt::Display for RobloxError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidPlace => write!(
                formatter,
                "The place ID isn't valid. Can you check the game link?"
            ),
            Self::InvalidResponse => write!(
                formatter,
                "Roblox returned an unexpected response. Can you try again?"
            ),
            Self::Network => write!(
                formatter,
                "Toolblox couldn't reach Roblox. Is your connection working?"
            ),
            Self::Rejected(status) => write!(
                formatter,
                "Roblox rejected the request (status {status}). Is the account still signed in?"
            ),
        }
    }
}

impl std::error::Error for RobloxError {}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Profile {
    pub id: u64,
    pub name: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
}

#[derive(Deserialize)]
struct UserResponse {
    id: u64,
    name: String,
    #[serde(rename = "displayName")]
    display_name: Option<String>,
}

#[derive(Deserialize)]
struct ThumbnailEnvelope {
    #[serde(default)]
    data: Vec<ThumbnailResponse>,
}

#[derive(Deserialize)]
struct ThumbnailResponse {
    #[serde(rename = "imageUrl")]
    image_url: Option<String>,
}

#[derive(Deserialize)]
struct PresenceEnvelope {
    #[serde(rename = "userPresences", default)]
    user_presences: Vec<PresenceResponse>,
}

#[derive(Deserialize)]
struct PresenceResponse {
    #[serde(rename = "userId")]
    user_id: u64,
    #[serde(rename = "userPresenceType")]
    presence_type: u8,
    #[serde(rename = "placeId", default)]
    place_id: Option<u64>,
    #[serde(rename = "universeId", default)]
    universe_id: Option<u64>,
    #[serde(rename = "lastLocation", default)]
    last_location: Option<String>,
}

/// Presence plus the game an in-game account is playing. Roblox omits the place for
/// accounts the viewing session isn't allowed to see.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PresenceDetail {
    pub state: PresenceState,
    pub place_id: Option<u64>,
    pub universe_id: Option<u64>,
    pub location: Option<String>,
}

impl PresenceDetail {
    pub fn in_game(&self) -> bool {
        matches!(self.state, PresenceState::InGame | PresenceState::InStudio)
    }
}

#[derive(Deserialize)]
struct UniverseResponse {
    #[serde(rename = "universeId")]
    universe_id: Option<u64>,
}

#[derive(Deserialize)]
struct GamesEnvelope {
    #[serde(default)]
    data: Vec<GameResponse>,
}

#[derive(Deserialize)]
struct GameResponse {
    id: u64,
    name: String,
}

pub fn parse_place_id(input: &str) -> Result<String, RobloxError> {
    let input = input.trim();
    if !input.is_empty() && input.bytes().all(|byte| byte.is_ascii_digit()) {
        return Ok(input.to_owned());
    }
    let url = url::Url::parse(input).map_err(|_| RobloxError::InvalidPlace)?;
    if url.scheme() != "https" || !matches!(url.host_str(), Some("roblox.com" | "www.roblox.com")) {
        return Err(RobloxError::InvalidPlace);
    }
    let mut segments = url.path_segments().ok_or(RobloxError::InvalidPlace)?;
    if segments.next() != Some("games") {
        return Err(RobloxError::InvalidPlace);
    }
    let id = segments.next().ok_or(RobloxError::InvalidPlace)?;
    if id.is_empty() || !id.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(RobloxError::InvalidPlace);
    }
    Ok(id.to_owned())
}

pub async fn authenticated_profile(
    client: &reqwest::Client,
    session: &Secret,
) -> Result<Profile, RobloxError> {
    let response = client
        .get(AUTH_URL)
        .header(COOKIE, cookie_header(session)?)
        .send()
        .await
        .map_err(|_| RobloxError::Network)?;
    if !response.status().is_success() {
        return Err(RobloxError::Rejected(response.status().as_u16()));
    }
    let user: UserResponse = response
        .json()
        .await
        .map_err(|_| RobloxError::InvalidResponse)?;
    profile_with_avatar(client, user).await
}

pub async fn public_profile(
    client: &reqwest::Client,
    user_id: u64,
) -> Result<Profile, RobloxError> {
    let response = client
        .get(format!("{USERS_URL}/{user_id}"))
        .send()
        .await
        .map_err(|_| RobloxError::Network)?;
    if !response.status().is_success() {
        return Err(RobloxError::Rejected(response.status().as_u16()));
    }
    let user: UserResponse = response
        .json()
        .await
        .map_err(|_| RobloxError::InvalidResponse)?;
    if user.id != user_id {
        return Err(RobloxError::InvalidResponse);
    }
    profile_with_avatar(client, user).await
}

async fn profile_with_avatar(
    client: &reqwest::Client,
    user: UserResponse,
) -> Result<Profile, RobloxError> {
    let response = client
        .get(THUMBNAIL_URL)
        .query(&[
            ("userIds", user.id.to_string()),
            ("size", "150x150".into()),
            ("format", "Png".into()),
            ("isCircular", "false".into()),
        ])
        .send()
        .await;
    let avatar_url = match response {
        Ok(response) if response.status().is_success() => response
            .json::<ThumbnailEnvelope>()
            .await
            .ok()
            .and_then(|envelope| envelope.data.into_iter().next())
            .and_then(|thumbnail| thumbnail.image_url),
        _ => None,
    };
    Ok(Profile {
        id: user.id,
        display_name: user
            .display_name
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| user.name.clone()),
        name: user.name,
        avatar_url,
    })
}

pub async fn fetch_presence(
    client: &reqwest::Client,
    session: &Secret,
    user_ids: &[u64],
) -> Result<BTreeMap<u64, PresenceState>, RobloxError> {
    let details = fetch_presence_details(client, session, user_ids).await?;
    Ok(details
        .into_iter()
        .map(|(id, detail)| (id, detail.state))
        .collect())
}

pub async fn fetch_presence_details(
    client: &reqwest::Client,
    session: &Secret,
    user_ids: &[u64],
) -> Result<BTreeMap<u64, PresenceDetail>, RobloxError> {
    if user_ids.is_empty() {
        return Ok(BTreeMap::new());
    }
    let cookie = cookie_header(session)?;
    let body = json!({ "userIds": user_ids });
    let mut response = client
        .post(PRESENCE_URL)
        .header(COOKIE, cookie.clone())
        .json(&body)
        .send()
        .await
        .map_err(|_| RobloxError::Network)?;
    if response.status() == reqwest::StatusCode::FORBIDDEN {
        let csrf = response
            .headers()
            .get("x-csrf-token")
            .cloned()
            .ok_or(RobloxError::InvalidResponse)?;
        response = client
            .post(PRESENCE_URL)
            .header(COOKIE, cookie)
            .header("x-csrf-token", csrf)
            .json(&body)
            .send()
            .await
            .map_err(|_| RobloxError::Network)?;
    }
    if !response.status().is_success() {
        return Err(RobloxError::Rejected(response.status().as_u16()));
    }
    let body = response.text().await.map_err(|_| RobloxError::Network)?;
    parse_presence_response(&body, user_ids)
}

fn parse_presence_response(
    body: &str,
    requested: &[u64],
) -> Result<BTreeMap<u64, PresenceDetail>, RobloxError> {
    let response: PresenceEnvelope =
        serde_json::from_str(body).map_err(|_| RobloxError::InvalidResponse)?;
    let mut states: BTreeMap<_, _> = requested
        .iter()
        .copied()
        .map(|id| {
            let unknown = PresenceDetail {
                state: PresenceState::Unknown,
                place_id: None,
                universe_id: None,
                location: None,
            };
            (id, unknown)
        })
        .collect();
    for presence in response.user_presences {
        if let Some(detail) = states.get_mut(&presence.user_id) {
            detail.state = match presence.presence_type {
                0 => PresenceState::Offline,
                1 => PresenceState::Online,
                2 => PresenceState::InGame,
                3 => PresenceState::InStudio,
                _ => PresenceState::Unknown,
            };
            if detail.in_game() {
                detail.place_id = presence.place_id.filter(|id| *id > 0);
                detail.universe_id = presence.universe_id.filter(|id| *id > 0);
                detail.location = presence.last_location.and_then(clean_game_name);
            }
        }
    }
    Ok(states)
}

/// Trims a Roblox-supplied game name and caps its length for display.
fn clean_game_name(name: String) -> Option<String> {
    let name = name.trim();
    (!name.is_empty()).then(|| name.chars().take(100).collect())
}

/// Looks up game names by universe ID. Failures return no names because they're display-only.
pub async fn fetch_game_names(
    client: &reqwest::Client,
    universe_ids: &BTreeSet<u64>,
) -> BTreeMap<u64, String> {
    if universe_ids.is_empty() {
        return BTreeMap::new();
    }
    let ids = universe_ids
        .iter()
        .map(u64::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let Ok(response) = client
        .get(GAMES_URL)
        .query(&[("universeIds", ids)])
        .send()
        .await
    else {
        return BTreeMap::new();
    };
    if !response.status().is_success() {
        return BTreeMap::new();
    }
    let Ok(body) = response.text().await else {
        return BTreeMap::new();
    };
    parse_games_response(&body, universe_ids)
}

/// Finds the universe for a place. `Ok(None)` means Roblox has no universe for that place.
pub async fn fetch_place_universe(
    client: &reqwest::Client,
    place_id: &str,
) -> Result<Option<u64>, RobloxError> {
    let place_id = parse_place_id(place_id)?;
    let response = client
        .get(format!("{PLACE_UNIVERSE_URL}/{place_id}/universe"))
        .send()
        .await
        .map_err(|_| RobloxError::Network)?;
    if matches!(response.status().as_u16(), 400 | 404) {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(RobloxError::Rejected(response.status().as_u16()));
    }
    let body = response.text().await.map_err(|_| RobloxError::Network)?;
    let universe: UniverseResponse =
        serde_json::from_str(&body).map_err(|_| RobloxError::InvalidResponse)?;
    Ok(universe.universe_id.filter(|id| *id > 0))
}

fn parse_games_response(body: &str, requested: &BTreeSet<u64>) -> BTreeMap<u64, String> {
    serde_json::from_str::<GamesEnvelope>(body)
        .map(|envelope| envelope.data)
        .unwrap_or_default()
        .into_iter()
        .filter(|game| requested.contains(&game.id))
        .filter_map(|game| clean_game_name(game.name).map(|name| (game.id, name)))
        .collect()
}

pub async fn build_join_uri(
    client: &reqwest::Client,
    session: &Secret,
    place_id: &str,
) -> Result<String, RobloxError> {
    let place_id = parse_place_id(place_id)?;
    let referer = format!("https://www.roblox.com/games/{place_id}");
    let cookie = cookie_header(session)?;
    let first = client
        .post(TICKET_URL)
        .header(COOKIE, cookie.clone())
        .header("referer", &referer)
        .header("origin", "https://www.roblox.com")
        .json(&json!({}))
        .send()
        .await
        .map_err(|_| RobloxError::Network)?;
    let csrf = first
        .headers()
        .get("x-csrf-token")
        .cloned()
        .ok_or(RobloxError::InvalidResponse)?;
    let second = client
        .post(TICKET_URL)
        .header(COOKIE, cookie)
        .header("referer", referer)
        .header("origin", "https://www.roblox.com")
        .header("x-csrf-token", csrf)
        .json(&json!({}))
        .send()
        .await
        .map_err(|_| RobloxError::Network)?;
    if !second.status().is_success() {
        return Err(RobloxError::Rejected(second.status().as_u16()));
    }
    let ticket = second
        .headers()
        .get("rbx-authentication-ticket")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .ok_or(RobloxError::InvalidResponse)?;
    Ok(join_uri(&place_id, ticket))
}

fn cookie_header(session: &Secret) -> Result<HeaderValue, RobloxError> {
    let mut value = HeaderValue::from_str(&format!(".ROBLOSECURITY={}", session.expose()))
        .map_err(|_| RobloxError::InvalidResponse)?;
    value.set_sensitive(true);
    Ok(value)
}

fn join_uri(place_id: &str, ticket: &str) -> String {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let launch_time = elapsed.as_millis();
    let tracker = (elapsed.as_nanos() as u32) ^ TRACKER_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let launcher = format!(
        "{PLACE_LAUNCHER_URL}?request=RequestGame&browserTrackerId={tracker}&placeId={place_id}&isPlayTogetherGame=false"
    );
    let encoded_launcher: String =
        url::form_urlencoded::byte_serialize(launcher.as_bytes()).collect();
    format!(
        "roblox-player:1+launchmode:play+gameinfo:{ticket}+launchtime:{launch_time}+placelauncherurl:{encoded_launcher}+browsertrackerid:{tracker}+robloxLocale:en_us+gameLocale:en_us+channel:"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn place_id_parser_accepts_only_ids_and_roblox_game_urls() {
        assert_eq!(parse_place_id("1818").unwrap(), "1818");
        assert_eq!(
            parse_place_id("https://www.roblox.com/games/1818/Classic-Crossroads").unwrap(),
            "1818"
        );
        assert!(parse_place_id("words 1818").is_err());
        assert!(parse_place_id("http://www.roblox.com/games/1818").is_err());
        assert!(parse_place_id("https://example.com/games/1818").is_err());
        assert!(parse_place_id("https://roblox.com/users/1818").is_err());
    }

    #[test]
    fn successful_presence_distinguishes_offline_unknown_and_in_game() {
        let states = parse_presence_response(
            r#"{"userPresences":[{"userId":1,"userPresenceType":0},{"userId":2,"userPresenceType":2}]}"#,
            &[1, 2, 3],
        )
        .unwrap();
        assert_eq!(states[&1].state, PresenceState::Offline);
        assert_eq!(states[&2].state, PresenceState::InGame);
        assert_eq!(states[&3].state, PresenceState::Unknown);
        assert!(parse_presence_response("not json", &[1]).is_err());
    }

    #[test]
    fn presence_keeps_game_details_only_while_in_game() {
        let states = parse_presence_response(
            r#"{"userPresences":[
                {"userId":1,"userPresenceType":2,"placeId":1818,"universeId":9,"lastLocation":"  Crossroads  "},
                {"userId":2,"userPresenceType":1,"placeId":1818,"lastLocation":"Website"},
                {"userId":3,"userPresenceType":2,"placeId":null,"lastLocation":""}
            ]}"#,
            &[1, 2, 3],
        )
        .unwrap();
        assert_eq!(states[&1].place_id, Some(1818));
        assert_eq!(states[&1].universe_id, Some(9));
        assert_eq!(states[&1].location.as_deref(), Some("Crossroads"));
        assert_eq!(states[&2].place_id, None);
        assert_eq!(states[&2].location, None);
        assert_eq!(states[&3].place_id, None);
        assert_eq!(states[&3].location, None);
    }

    #[test]
    fn game_names_ignore_unrequested_blank_and_malformed_entries() {
        let requested = BTreeSet::from([9, 10]);
        let names = parse_games_response(
            r#"{"data":[{"id":9,"name":"Crossroads"},{"id":10,"name":" "},{"id":11,"name":"Other"}]}"#,
            &requested,
        );
        assert_eq!(names, BTreeMap::from([(9, "Crossroads".to_string())]));
        assert!(parse_games_response("not json", &requested).is_empty());
        assert_eq!(clean_game_name("x".repeat(150)).unwrap().len(), 100);
    }

    #[test]
    fn join_uri_encodes_the_launcher_but_keeps_the_protocol_shape() {
        let uri = join_uri("1818", "ticket-value");
        assert!(uri.starts_with("roblox-player:1+launchmode:play+gameinfo:ticket-value+"));
        assert!(uri.contains(
            "placelauncherurl:https%3A%2F%2Fassetgame.roblox.com%2Fgame%2FPlaceLauncher.ashx%3F"
        ));
        assert!(!uri.contains("request=RequestGame"));
    }
}
