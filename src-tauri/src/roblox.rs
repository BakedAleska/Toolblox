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

/// Returns the user a session belongs to.
const AUTH_URL: &str = "https://users.roblox.com/v1/users/authenticated";
/// Public user profiles, by ID.
const USERS_URL: &str = "https://users.roblox.com/v1/users";
/// Avatar headshot images.
const THUMBNAIL_URL: &str = "https://thumbnails.roblox.com/v1/users/avatar-headshot";
/// Friends of a user, by ID. The online list requires that user's session.
const FRIENDS_URL: &str = "https://friends.roblox.com/v1/users";
/// Most online friends shown. Roblox's batch lookups accept about this many IDs.
const FRIENDS_LIMIT: usize = 100;
/// User presence. Requires a signed-in session.
const PRESENCE_URL: &str = "https://presence.roblox.com/v1/presence/users";
/// Game details, by universe ID.
const GAMES_URL: &str = "https://games.roblox.com/v1/games";
/// The universe a place belongs to.
const PLACE_UNIVERSE_URL: &str = "https://apis.roblox.com/universes/v1/places";
/// Game search, as used by roblox.com. Undocumented, so failures return no results.
const SEARCH_URL: &str = "https://apis.roblox.com/search-api/omni-search";
/// Most games a place search returns.
const SEARCH_LIMIT: usize = 24;
/// Game icon images, by universe ID.
const GAME_ICONS_URL: &str = "https://thumbnails.roblox.com/v1/games/icons";
/// Exact username lookup.
const USERNAMES_URL: &str = "https://users.roblox.com/v1/usernames/users";
/// Most players a player search returns.
const PLAYER_SEARCH_LIMIT: usize = 10;
/// Follow lookups for the session's user.
const FOLLOWING_EXISTS_URL: &str = "https://friends.roblox.com/v1/user/following-exists";
/// Blocking, by user ID.
const BLOCKING_URL: &str = "https://apis.roblox.com/user-blocking-api/v1/users";
/// Issues one-time authentication tickets for launching the Roblox client.
const TICKET_URL: &str = "https://auth.roblox.com/v1/authentication-ticket";
/// Roblox place launcher, passed to the client in the launch URI.
const PLACE_LAUNCHER_URL: &str = "https://assetgame.roblox.com/game/PlaceLauncher.ashx";

/// Keeps browser tracker IDs distinct for joins in the same instant.
static TRACKER_SEQUENCE: AtomicU32 = AtomicU32::new(0);

/// Why a Roblox request failed. Displays as a user-facing message.
#[derive(Debug)]
pub enum RobloxError {
    /// The place ID or game link isn't valid.
    InvalidPlace,
    /// Roblox answered with something unexpected.
    InvalidResponse,
    /// Roblox couldn't be reached.
    Network,
    /// Roblox refused the request with this HTTP status.
    Rejected(u16),
    /// Roblox asked for a verification check that only roblox.com can show.
    Challenged,
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
                "Toolblox couldn't reach Roblox. Is the connection working?"
            ),
            Self::Rejected(status) => write!(
                formatter,
                "Roblox rejected the request (status {status}). Is the account still signed in?"
            ),
            Self::Challenged => write!(
                formatter,
                "Roblox asked for a verification check. Can you do this on roblox.com instead?"
            ),
        }
    }
}

impl std::error::Error for RobloxError {}

/// A Roblox user's public profile.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Profile {
    pub id: u64,
    pub name: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
}

/// A user from the users API.
#[derive(Deserialize)]
struct UserResponse {
    id: u64,
    name: String,
    #[serde(rename = "displayName")]
    display_name: Option<String>,
}

/// The batch users API response.
#[derive(Deserialize)]
struct UsersEnvelope {
    #[serde(default)]
    data: Vec<UserResponse>,
}

/// The online friends API response. Only IDs are read. Other details come from the users and
/// presence APIs.
#[derive(Deserialize)]
struct FriendsEnvelope {
    #[serde(default)]
    data: Vec<FriendResponse>,
}

/// One online friend.
#[derive(Deserialize)]
struct FriendResponse {
    id: u64,
}

/// A friend who is online, as the dashboard shows it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OnlineFriend {
    pub id: u64,
    pub name: String,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
    pub in_game: bool,
    pub in_studio: bool,
    /// The game name, or `Studio - <place>` in Roblox Studio.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub game_name: Option<String>,
}

/// The thumbnails API response.
#[derive(Deserialize)]
struct ThumbnailEnvelope {
    #[serde(default)]
    data: Vec<ThumbnailResponse>,
}

/// One avatar or game icon image.
#[derive(Deserialize)]
struct ThumbnailResponse {
    #[serde(rename = "targetId", default)]
    target_id: u64,
    #[serde(rename = "imageUrl")]
    image_url: Option<String>,
}

/// The presence API response.
#[derive(Deserialize)]
struct PresenceEnvelope {
    #[serde(rename = "userPresences", default)]
    user_presences: Vec<PresenceResponse>,
}

/// One user's presence.
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
    /// Game name reported with the presence, trimmed to 100 characters.
    pub location: Option<String>,
}

impl PresenceDetail {
    /// Whether the user is in a game or in Roblox Studio.
    pub fn in_game(&self) -> bool {
        matches!(self.state, PresenceState::InGame | PresenceState::InStudio)
    }

    /// The activity as roblox.com shows it: the game name, or `Studio - <place>` in Roblox Studio.
    /// Roblox already adds the prefix for some Studio sessions, so it isn't repeated.
    pub fn activity(&self, name: Option<String>) -> Option<String> {
        if self.state != PresenceState::InStudio {
            return name;
        }
        let place = name
            .as_deref()
            .map(|name| name.strip_prefix("Studio - ").unwrap_or(name).trim())
            .filter(|name| !name.is_empty());
        Some(place.map_or_else(|| "Studio".to_string(), |place| format!("Studio - {place}")))
    }
}

/// The place universe API response.
#[derive(Deserialize)]
struct UniverseResponse {
    #[serde(rename = "universeId")]
    universe_id: Option<u64>,
}

/// The games API response.
#[derive(Deserialize)]
struct GamesEnvelope {
    #[serde(default)]
    data: Vec<GameResponse>,
}

/// One game's details. Fields other than `id` and `name` are only used by place search.
#[derive(Deserialize)]
struct GameResponse {
    id: u64,
    name: String,
    #[serde(default)]
    creator: Option<GameCreator>,
    #[serde(default)]
    price: Option<u64>,
    #[serde(default)]
    visits: Option<u64>,
    #[serde(default, rename = "favoritedCount")]
    favorited_count: Option<u64>,
    #[serde(default)]
    updated: Option<String>,
    #[serde(default)]
    genre_l1: Option<String>,
    #[serde(default)]
    genre_l2: Option<String>,
}

/// The user or group that owns a game.
#[derive(Deserialize)]
struct GameCreator {
    #[serde(default)]
    name: String,
    #[serde(default, rename = "hasVerifiedBadge")]
    has_verified_badge: bool,
}

/// The game search response.
#[derive(Deserialize)]
struct SearchEnvelope {
    #[serde(default, rename = "searchResults")]
    search_results: Vec<SearchGroup>,
}

/// One group of search results. Only `Game` groups are used.
#[derive(Deserialize)]
struct SearchGroup {
    #[serde(default, rename = "contentGroupType")]
    content_group_type: String,
    #[serde(default)]
    contents: Vec<SearchGame>,
}

/// One game in the search results.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchGame {
    #[serde(default)]
    name: String,
    #[serde(default)]
    root_place_id: u64,
    #[serde(default)]
    universe_id: u64,
    #[serde(default)]
    is_sponsored: bool,
    #[serde(default)]
    player_count: u64,
    #[serde(default)]
    total_up_votes: u64,
    #[serde(default)]
    total_down_votes: u64,
    #[serde(default)]
    content_maturity: String,
}

/// A game found by name, with the place a join opens.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlaceMatch {
    pub place_id: String,
    pub name: String,
    pub player_count: u64,
    pub up_votes: u64,
    pub down_votes: u64,
    /// An `https:` icon image. `None` when Roblox has none or the lookup failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_url: Option<String>,
    /// Roblox's maturity label, such as `minimal` or `moderate`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub maturity: Option<String>,
    /// The fields below come from a second lookup and are `None` when it fails.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub creator_name: Option<String>,
    pub creator_verified: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visits: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub favorites: Option<u64>,
    /// When the game was last updated, as an RFC 3339 timestamp.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub genre: Option<String>,
    /// Robux needed to join. `None` for free games.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price: Option<u64>,
    #[serde(skip)]
    universe_id: u64,
}

/// Trims Roblox-supplied text and caps its length. Blank text is `None`.
fn clean_text(text: Option<String>, max: usize) -> Option<String> {
    let text = text?;
    let text = text.trim();
    (!text.is_empty()).then(|| text.chars().take(max).collect())
}

/// Extracts a place ID from digits or an `https://www.roblox.com/games/<id>/â€¦` link.
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

/// What a join opens: a place, or the game a player is in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JoinTarget {
    Place(String),
    User(u64),
}

impl fmt::Display for JoinTarget {
    /// The stored form: a place ID, or `@` and a user ID.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Place(id) => write!(formatter, "{id}"),
            Self::User(id) => write!(formatter, "@{id}"),
        }
    }
}

/// Reads a join target: `@` and a user ID, an `https://www.roblox.com/users/<id>/…` link, or
/// anything `parse_place_id` accepts.
pub fn parse_join_target(input: &str) -> Result<JoinTarget, RobloxError> {
    let input = input.trim();
    if let Some(id) = input.strip_prefix('@') {
        return parse_user_id(id).map(JoinTarget::User);
    }
    if let Ok(url) = url::Url::parse(input)
        && url.scheme() == "https"
        && matches!(url.host_str(), Some("roblox.com" | "www.roblox.com"))
        && let Some(mut segments) = url.path_segments()
        && segments.next() == Some("users")
    {
        return parse_user_id(segments.next().unwrap_or_default()).map(JoinTarget::User);
    }
    parse_place_id(input).map(JoinTarget::Place)
}

/// A user ID: 1 to 20 ASCII digits, not zero.
fn parse_user_id(input: &str) -> Result<u64, RobloxError> {
    if input.is_empty() || input.len() > 20 || !input.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(RobloxError::InvalidPlace);
    }
    input
        .parse()
        .ok()
        .filter(|id| *id > 0)
        .ok_or(RobloxError::InvalidPlace)
}

/// Returns the profile of the user a session belongs to, validating the session.
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

/// Returns a user's public profile, rejecting a response for a different user.
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

/// Adds the user's avatar headshot URL. A missing avatar isn't an error.
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

/// Returns each requested user's presence state.
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

/// Returns each requested user's presence and game.
pub async fn fetch_presence_details(
    client: &reqwest::Client,
    session: &Secret,
    user_ids: &[u64],
) -> Result<BTreeMap<u64, PresenceDetail>, RobloxError> {
    if user_ids.is_empty() {
        return Ok(BTreeMap::new());
    }
    let body = json!({ "userIds": user_ids });
    let response =
        send_with_session(client, session, reqwest::Method::POST, PRESENCE_URL, &body).await?;
    let body = response.text().await.map_err(|_| RobloxError::Network)?;
    parse_presence_response(&body, user_ids)
}

/// Sends a request with the session to a Roblox URL, retrying once with the CSRF token Roblox
/// returns on the first request. A verification challenge fails with `Challenged`.
async fn send_with_session(
    client: &reqwest::Client,
    session: &Secret,
    method: reqwest::Method,
    url: &str,
    body: &serde_json::Value,
) -> Result<reqwest::Response, RobloxError> {
    let cookie = cookie_header(session)?;
    let request = |csrf: Option<HeaderValue>| {
        let request = client
            .request(method.clone(), url)
            .header(COOKIE, cookie.clone());
        let request = if method == reqwest::Method::GET {
            request
        } else {
            request.json(body)
        };
        match csrf {
            Some(csrf) => request.header("x-csrf-token", csrf),
            None => request,
        }
    };
    let mut response = request(None)
        .send()
        .await
        .map_err(|_| RobloxError::Network)?;
    if response.status() == reqwest::StatusCode::FORBIDDEN
        && let Some(csrf) = response.headers().get("x-csrf-token").cloned()
    {
        response = request(Some(csrf))
            .send()
            .await
            .map_err(|_| RobloxError::Network)?;
    }
    if response.headers().contains_key("rblx-challenge-id") {
        return Err(RobloxError::Challenged);
    }
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        if let Some(reason) = roblox_error_reason(&body) {
            log::info!("Roblox rejected a request with status {status}: {reason}");
        }
        return Err(RobloxError::Rejected(status));
    }
    Ok(response)
}

/// Reads the first error code and message from a Roblox error body, at most 200 characters.
fn roblox_error_reason(body: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let error = value["errors"].as_array()?.first()?;
    let reason = format!("code {} {}", error["code"], error["message"]);
    Some(reason.chars().take(200).collect())
}

/// A player found by name.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlayerMatch {
    pub id: u64,
    pub name: String,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
    pub verified: bool,
}

/// A user from the user search and username APIs.
#[derive(Deserialize)]
struct PlayerResponse {
    id: u64,
    name: String,
    #[serde(rename = "displayName", default)]
    display_name: Option<String>,
    #[serde(rename = "hasVerifiedBadge", default)]
    verified: bool,
}

/// The username API response.
#[derive(Deserialize)]
struct PlayersEnvelope {
    #[serde(default)]
    data: Vec<PlayerResponse>,
}

/// One user in the player search results.
#[derive(Deserialize)]
struct SearchUser {
    #[serde(rename = "contentId", default)]
    id: u64,
    #[serde(default)]
    username: String,
    #[serde(rename = "displayName", default)]
    display_name: Option<String>,
    #[serde(rename = "hasVerifiedBadge", default)]
    verified: bool,
}

/// The player search response, grouped like the game search.
#[derive(Deserialize)]
struct UserSearchEnvelope {
    #[serde(default, rename = "searchResults")]
    search_results: Vec<UserSearchGroup>,
}

/// One group of player search results. Only `User` groups are used.
#[derive(Deserialize)]
struct UserSearchGroup {
    #[serde(default, rename = "contentGroupType")]
    content_group_type: String,
    #[serde(default)]
    contents: Vec<SearchUser>,
}

/// Finds players by username or display name with the search roblox.com uses, which isn't rate
/// limited like the users API search. An exact username match comes first. Failures return no
/// results.
pub async fn search_players(client: &reqwest::Client, query: &str) -> Vec<PlayerMatch> {
    let query = query.trim().trim_start_matches('@').trim();
    if query.is_empty() || query.chars().count() > 50 {
        return Vec::new();
    }
    let exact = async {
        let response = client
            .post(USERNAMES_URL)
            .json(&json!({ "usernames": [query], "excludeBannedUsers": true }))
            .send()
            .await
            .ok()?;
        response.text().await.ok()
    };
    let search = async {
        let response = search_request(client, query)
            .query(&[("verticalType", "user")])
            .send()
            .await
            .ok()?;
        response.text().await.ok()
    };
    let (exact, search) = tokio::join!(exact, search);
    let mut players = parse_players(exact.as_deref(), search.as_deref());
    if players.is_empty() {
        return players;
    }
    let ids: Vec<_> = players.iter().map(|player| player.id).collect();
    let avatars = fetch_avatars(client, &ids).await;
    for player in &mut players {
        player.avatar_url = avatars.get(&player.id).cloned();
    }
    players
}

/// Reads players from the username lookup, then the player search, dropping duplicates, malformed
/// bodies, and invalid IDs, and keeping at most `PLAYER_SEARCH_LIMIT`.
fn parse_players(exact: Option<&str>, search: Option<&str>) -> Vec<PlayerMatch> {
    let exact = exact
        .and_then(|body| serde_json::from_str::<PlayersEnvelope>(body).ok())
        .map(|envelope| envelope.data)
        .unwrap_or_default();
    let found = search
        .and_then(|body| serde_json::from_str::<UserSearchEnvelope>(body).ok())
        .map(|envelope| envelope.search_results)
        .unwrap_or_default()
        .into_iter()
        .filter(|group| group.content_group_type == "User")
        .flat_map(|group| group.contents)
        .map(|user| PlayerResponse {
            id: user.id,
            name: user.username,
            display_name: user.display_name,
            verified: user.verified,
        });
    let mut seen = BTreeSet::new();
    exact
        .into_iter()
        .chain(found)
        .filter(|player| player.id > 0 && !player.name.trim().is_empty() && seen.insert(player.id))
        .take(PLAYER_SEARCH_LIMIT)
        .map(|player| PlayerMatch {
            id: player.id,
            display_name: clean_text(player.display_name, 100)
                .unwrap_or_else(|| player.name.clone()),
            name: player.name.chars().take(100).collect(),
            avatar_url: None,
            verified: player.verified,
        })
        .collect()
}

/// Where a friendship stands between the session's user and another player.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FriendStatus {
    None,
    Friends,
    RequestSent,
    RequestReceived,
}

/// The session user's relationship to another player. Fields Roblox didn't answer are `None`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Relationship {
    pub friend: FriendStatus,
    pub following: Option<bool>,
    pub blocked: Option<bool>,
}

/// A change to the session user's relationship with another player.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SocialAction {
    RequestFriend,
    AcceptFriend,
    DeclineFriend,
    Unfriend,
    Follow,
    Unfollow,
    Block,
    Unblock,
}

impl SocialAction {
    /// The Roblox endpoint that makes the change.
    fn url(self, user_id: u64) -> String {
        let (base, path) = match self {
            Self::RequestFriend => (FRIENDS_URL, "request-friendship"),
            Self::AcceptFriend => (FRIENDS_URL, "accept-friend-request"),
            Self::DeclineFriend => (FRIENDS_URL, "decline-friend-request"),
            Self::Unfriend => (FRIENDS_URL, "unfriend"),
            Self::Follow => (FRIENDS_URL, "follow"),
            Self::Unfollow => (FRIENDS_URL, "unfollow"),
            Self::Block => (BLOCKING_URL, "block-user"),
            Self::Unblock => (BLOCKING_URL, "unblock-user"),
        };
        format!("{base}/{user_id}/{path}")
    }
}

/// Returns the relationship between the session's user, `account_id`, and `user_id`. Only the
/// friend status is required. Follow and block lookups that fail are `None`.
pub async fn fetch_relationship(
    client: &reqwest::Client,
    session: &Secret,
    account_id: u64,
    user_id: u64,
) -> Result<Relationship, RobloxError> {
    let none = json!({});
    let statuses = format!("{FRIENDS_URL}/{account_id}/friends/statuses?userIds={user_id}");
    let following_body = json!({ "targetUserIds": [user_id] });
    let blocked = format!("{BLOCKING_URL}/{user_id}/is-blocked");
    let (friend, following, blocked) = tokio::join!(
        send_with_session(client, session, reqwest::Method::GET, &statuses, &none),
        send_with_session(
            client,
            session,
            reqwest::Method::POST,
            FOLLOWING_EXISTS_URL,
            &following_body
        ),
        send_with_session(client, session, reqwest::Method::GET, &blocked, &none),
    );
    let friend = friend?.text().await.map_err(|_| RobloxError::Network)?;
    let following = match following {
        Ok(response) => response.text().await.ok(),
        Err(_) => None,
    };
    let blocked = match blocked {
        Ok(response) => response.text().await.ok(),
        Err(error) => {
            log::info!("Block status of player {user_id} couldn't be read: {error}");
            None
        }
    };
    let blocked = blocked.and_then(|body| {
        let parsed = parse_blocked(&body);
        if parsed.is_none() {
            let shape: String = body.chars().take(200).collect();
            log::info!("Block status of player {user_id} has an unknown format: {shape}");
        }
        parsed
    });
    Ok(Relationship {
        friend: parse_friend_status(&friend, user_id)?,
        following: following.and_then(|body| parse_following(&body, user_id)),
        blocked,
    })
}

/// Reads one user's friend status from the friend statuses API.
fn parse_friend_status(body: &str, user_id: u64) -> Result<FriendStatus, RobloxError> {
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|_| RobloxError::InvalidResponse)?;
    let status = value["data"]
        .as_array()
        .and_then(|data| {
            data.iter()
                .find(|entry| entry["id"].as_u64() == Some(user_id))
        })
        .and_then(|entry| entry["status"].as_str())
        .ok_or(RobloxError::InvalidResponse)?;
    Ok(match status {
        "Friends" => FriendStatus::Friends,
        "RequestSent" => FriendStatus::RequestSent,
        "RequestReceived" => FriendStatus::RequestReceived,
        _ => FriendStatus::None,
    })
}

/// Reads whether the session's user follows `user_id` from the following-exists API.
fn parse_following(body: &str, user_id: u64) -> Option<bool> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    value["followings"]
        .as_array()?
        .iter()
        .find(|entry| entry["userId"].as_u64() == Some(user_id))?["isFollowing"]
        .as_bool()
}

/// Reads the is-blocked API, which answers with a bare boolean or an `isBlocked` field.
fn parse_blocked(body: &str) -> Option<bool> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    value.as_bool().or_else(|| value["isBlocked"].as_bool())
}

/// Changes the session user's relationship with `user_id`.
pub async fn change_relationship(
    client: &reqwest::Client,
    session: &Secret,
    user_id: u64,
    action: SocialAction,
) -> Result<(), RobloxError> {
    let body = if action == SocialAction::RequestFriend {
        json!({ "friendshipOriginSourceType": "PlayerSearch" })
    } else {
        json!({})
    };
    send_with_session(
        client,
        session,
        reqwest::Method::POST,
        &action.url(user_id),
        &body,
    )
    .await
    .map(|_| ())
}

/// Maps each requested user to a presence. Users missing from the response are `Unknown`, and
/// game details are kept only for users in game.
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

/// Returns the online friends of the user a session belongs to, in-game friends first.
pub async fn fetch_online_friends(
    client: &reqwest::Client,
    session: &Secret,
    user_id: u64,
) -> Result<Vec<OnlineFriend>, RobloxError> {
    let response = client
        .get(format!("{FRIENDS_URL}/{user_id}/friends/online"))
        .header(COOKIE, cookie_header(session)?)
        .send()
        .await
        .map_err(|_| RobloxError::Network)?;
    if !response.status().is_success() {
        return Err(RobloxError::Rejected(response.status().as_u16()));
    }
    let body = response.text().await.map_err(|_| RobloxError::Network)?;
    let ids = parse_friend_ids(&body)?;
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let details = fetch_presence_details(client, session, &ids).await?;
    let users = fetch_users(client, &ids).await?;
    let avatars = fetch_avatars(client, &ids).await;
    let unnamed: BTreeSet<_> = details
        .values()
        .filter(|detail| detail.in_game() && detail.location.is_none())
        .filter_map(|detail| detail.universe_id)
        .collect();
    let game_names = fetch_game_names(client, &unnamed).await;
    Ok(merge_friends(users, &details, &avatars, &game_names))
}

/// Reads friend IDs, dropping duplicates and keeping at most `FRIENDS_LIMIT`.
fn parse_friend_ids(body: &str) -> Result<Vec<u64>, RobloxError> {
    let response: FriendsEnvelope =
        serde_json::from_str(body).map_err(|_| RobloxError::InvalidResponse)?;
    let mut seen = BTreeSet::new();
    Ok(response
        .data
        .into_iter()
        .map(|friend| friend.id)
        .filter(|id| *id > 0 && seen.insert(*id))
        .take(FRIENDS_LIMIT)
        .collect())
}

/// Looks up public profiles by ID. Roblox leaves out banned users.
async fn fetch_users(
    client: &reqwest::Client,
    user_ids: &[u64],
) -> Result<Vec<UserResponse>, RobloxError> {
    let response = client
        .post(USERS_URL)
        .json(&json!({ "userIds": user_ids, "excludeBannedUsers": true }))
        .send()
        .await
        .map_err(|_| RobloxError::Network)?;
    if !response.status().is_success() {
        return Err(RobloxError::Rejected(response.status().as_u16()));
    }
    let users: UsersEnvelope = response
        .json()
        .await
        .map_err(|_| RobloxError::InvalidResponse)?;
    Ok(users.data)
}

/// Looks up avatar headshots by user ID. Failures return no avatars because they're display-only.
async fn fetch_avatars(client: &reqwest::Client, user_ids: &[u64]) -> BTreeMap<u64, String> {
    let ids = user_ids
        .iter()
        .map(u64::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let response = client
        .get(THUMBNAIL_URL)
        .query(&[
            ("userIds", ids.as_str()),
            ("size", "150x150"),
            ("format", "Png"),
            ("isCircular", "false"),
        ])
        .send()
        .await;
    let Ok(response) = response else {
        return BTreeMap::new();
    };
    match response.text().await {
        Ok(body) => parse_icon_response(&body),
        Err(_) => BTreeMap::new(),
    }
}

/// Combines profiles with presence, dropping friends who have since gone offline. Friends in game
/// come first, then the rest, each sorted by name.
fn merge_friends(
    users: Vec<UserResponse>,
    details: &BTreeMap<u64, PresenceDetail>,
    avatars: &BTreeMap<u64, String>,
    game_names: &BTreeMap<u64, String>,
) -> Vec<OnlineFriend> {
    let mut friends: Vec<_> = users
        .into_iter()
        .filter_map(|user| {
            let detail = details.get(&user.id)?;
            if detail.state == PresenceState::Offline {
                return None;
            }
            let in_game = detail.in_game();
            let game_name = in_game
                .then(|| {
                    detail.activity(detail.location.clone().or_else(|| {
                        detail
                            .universe_id
                            .and_then(|id| game_names.get(&id).cloned())
                    }))
                })
                .flatten();
            Some(OnlineFriend {
                id: user.id,
                display_name: user
                    .display_name
                    .filter(|name| !name.is_empty())
                    .unwrap_or_else(|| user.name.clone()),
                name: user.name,
                avatar_url: avatars.get(&user.id).cloned(),
                in_game,
                in_studio: detail.state == PresenceState::InStudio,
                game_name,
            })
        })
        .collect();
    friends.sort_by_cached_key(|friend| (!friend.in_game, friend.display_name.to_lowercase()));
    friends
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

/// Searches Roblox for games by name. Failures return no results because search is optional.
pub async fn search_places(client: &reqwest::Client, query: &str) -> Vec<PlaceMatch> {
    let query: String = query.trim().chars().take(100).collect();
    if query.is_empty() {
        return Vec::new();
    }
    let Ok(response) = search_request(client, &query).send().await else {
        return Vec::new();
    };
    if !response.status().is_success() {
        return Vec::new();
    }
    let Ok(body) = response.text().await else {
        return Vec::new();
    };
    let mut matches = parse_search_response(&body);
    let (icons, details) = tokio::join!(
        fetch_game_icons(client, &matches),
        fetch_game_details(client, &matches)
    );
    for place in &mut matches {
        place.icon_url = icons.get(&place.universe_id).cloned();
    }
    if let Some(body) = details {
        apply_game_details(&mut matches, &body);
    }
    matches
}

/// Fetches the games API response for the matches' universes. Failures return `None`.
async fn fetch_game_details(client: &reqwest::Client, matches: &[PlaceMatch]) -> Option<String> {
    let ids = matches
        .iter()
        .filter(|place| place.universe_id > 0)
        .map(|place| place.universe_id.to_string())
        .collect::<Vec<_>>()
        .join(",");
    if ids.is_empty() {
        return None;
    }
    let response = client
        .get(GAMES_URL)
        .query(&[("universeIds", ids)])
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.text().await.ok()
}

/// Copies visits, creator, and other details onto the matching places.
fn apply_game_details(matches: &mut [PlaceMatch], body: &str) {
    let games = serde_json::from_str::<GamesEnvelope>(body)
        .map(|envelope| envelope.data)
        .unwrap_or_default();
    for game in games {
        let Some(place) = matches
            .iter_mut()
            .find(|place| place.universe_id == game.id)
        else {
            continue;
        };
        if let Some(creator) = game.creator {
            place.creator_name = clean_text(Some(creator.name), 50);
            place.creator_verified = creator.has_verified_badge;
        }
        place.visits = game.visits;
        place.favorites = game.favorited_count;
        place.updated = clean_text(game.updated, 40);
        place.genre = clean_text(game.genre_l2, 40).or_else(|| clean_text(game.genre_l1, 40));
        place.price = game.price.filter(|price| *price > 0);
    }
}

/// Roblox returns no results without a `sessionId`. Any value works, so a fixed one keeps
/// searches unlinkable.
fn search_request(client: &reqwest::Client, query: &str) -> reqwest::RequestBuilder {
    client.get(SEARCH_URL).query(&[
        ("searchQuery", query),
        ("sessionId", "00000000-0000-0000-0000-000000000000"),
        ("pageType", "all"),
    ])
}

/// Looks up icons for the matches' universes. Failures return no icons because they're display-only.
async fn fetch_game_icons(
    client: &reqwest::Client,
    matches: &[PlaceMatch],
) -> BTreeMap<u64, String> {
    let ids = matches
        .iter()
        .filter(|place| place.universe_id > 0)
        .map(|place| place.universe_id.to_string())
        .collect::<Vec<_>>()
        .join(",");
    if ids.is_empty() {
        return BTreeMap::new();
    }
    let response = client
        .get(GAME_ICONS_URL)
        .query(&[
            ("universeIds", ids.as_str()),
            ("size", "150x150"),
            ("format", "Png"),
            ("isCircular", "false"),
        ])
        .send()
        .await;
    let Ok(response) = response else {
        return BTreeMap::new();
    };
    match response.text().await {
        Ok(body) => parse_icon_response(&body),
        Err(_) => BTreeMap::new(),
    }
}

/// Keeps `https:` image URLs, by universe or user ID.
fn parse_icon_response(body: &str) -> BTreeMap<u64, String> {
    serde_json::from_str::<ThumbnailEnvelope>(body)
        .map(|envelope| envelope.data)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|icon| {
            Some((
                icon.target_id,
                icon.image_url.filter(|url| url.starts_with("https://"))?,
            ))
        })
        .collect()
}

/// Keeps unsponsored games with a place and a name, without repeats, up to `SEARCH_LIMIT`.
fn parse_search_response(body: &str) -> Vec<PlaceMatch> {
    let mut seen = BTreeSet::new();
    serde_json::from_str::<SearchEnvelope>(body)
        .map(|envelope| envelope.search_results)
        .unwrap_or_default()
        .into_iter()
        .filter(|group| group.content_group_type == "Game")
        .flat_map(|group| group.contents)
        .filter(|game| !game.is_sponsored && game.root_place_id > 0)
        .filter(|game| seen.insert(game.root_place_id))
        .filter_map(|game| {
            clean_game_name(game.name).map(|name| PlaceMatch {
                place_id: game.root_place_id.to_string(),
                name,
                player_count: game.player_count,
                up_votes: game.total_up_votes,
                down_votes: game.total_down_votes,
                icon_url: None,
                maturity: clean_text(Some(game.content_maturity), 20),
                creator_name: None,
                creator_verified: false,
                visits: None,
                favorites: None,
                updated: None,
                genre: None,
                price: None,
                universe_id: game.universe_id,
            })
        })
        .take(SEARCH_LIMIT)
        .collect()
}

/// Keeps names for requested universes only.
fn parse_games_response(body: &str, requested: &BTreeSet<u64>) -> BTreeMap<u64, String> {
    serde_json::from_str::<GamesEnvelope>(body)
        .map(|envelope| envelope.data)
        .unwrap_or_default()
        .into_iter()
        .filter(|game| requested.contains(&game.id))
        .filter_map(|game| clean_game_name(game.name).map(|name| (game.id, name)))
        .collect()
}

/// Builds a `roblox-player:` URI that joins the place, or follows the player into their game, as
/// the session's user.
///
/// Requests an authentication ticket, first obtaining a CSRF token. The URI contains the ticket,
/// so it must not be logged.
pub async fn build_join_uri(
    client: &reqwest::Client,
    session: &Secret,
    target: &JoinTarget,
) -> Result<String, RobloxError> {
    let referer = match target {
        JoinTarget::Place(place_id) => format!("https://www.roblox.com/games/{place_id}"),
        JoinTarget::User(user_id) => format!("https://www.roblox.com/users/{user_id}/profile"),
    };
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
    let csrf = first.headers().get("x-csrf-token").cloned().ok_or(
        if first.status() == reqwest::StatusCode::UNAUTHORIZED {
            RobloxError::Rejected(401)
        } else {
            RobloxError::InvalidResponse
        },
    )?;
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
    Ok(join_uri(target, ticket))
}

/// Builds the session cookie header, marked sensitive so it isn't logged.
fn cookie_header(session: &Secret) -> Result<HeaderValue, RobloxError> {
    let mut value = HeaderValue::from_str(&format!(".ROBLOSECURITY={}", session.expose()))
        .map_err(|_| RobloxError::InvalidResponse)?;
    value.set_sensitive(true);
    Ok(value)
}

/// Formats the launch URI for a ticket and target.
fn join_uri(target: &JoinTarget, ticket: &str) -> String {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let launch_time = elapsed.as_millis();
    let tracker = (elapsed.as_nanos() as u32) ^ TRACKER_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let request = match target {
        JoinTarget::Place(place_id) => {
            format!("request=RequestGame&browserTrackerId={tracker}&placeId={place_id}")
        }
        JoinTarget::User(user_id) => {
            format!("request=RequestFollowUser&browserTrackerId={tracker}&userId={user_id}")
        }
    };
    let launcher = format!("{PLACE_LAUNCHER_URL}?{request}&isPlayTogetherGame=false");
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
    fn friend_ids_are_unique_positive_and_capped() {
        assert_eq!(
            parse_friend_ids(r#"{"data":[{"id":2,"name":""},{"id":2},{"id":0},{"id":1}]}"#)
                .unwrap(),
            [2, 1]
        );
        let many: Vec<_> = (1..=150).map(|id| json!({ "id": id })).collect();
        let body = json!({ "data": many }).to_string();
        assert_eq!(parse_friend_ids(&body).unwrap().len(), FRIENDS_LIMIT);
        assert!(parse_friend_ids("not json").is_err());
    }

    #[test]
    fn friends_merge_sorts_in_game_first_and_drops_offline_and_hidden_names() {
        let user = |id, name: &str, display: Option<&str>| UserResponse {
            id,
            name: name.into(),
            display_name: display.map(Into::into),
        };
        let users = || {
            vec![
                user(1, "alpha", Some("Alpha")),
                user(2, "zed", Some("")),
                user(3, "gone", None),
                user(4, "missing", None),
            ]
        };
        let detail = |state, universe_id| PresenceDetail {
            state,
            place_id: None,
            universe_id,
            location: None,
        };
        let details = BTreeMap::from([
            (1, detail(PresenceState::Online, None)),
            (2, detail(PresenceState::InGame, Some(9))),
            (3, detail(PresenceState::Offline, None)),
        ]);
        let avatars = BTreeMap::from([(2, "https://example.test/a.png".to_string())]);
        let games = BTreeMap::from([(9, "Crossroads".to_string())]);

        let friends = merge_friends(users(), &details, &avatars, &games);
        assert_eq!(friends.len(), 2);
        assert_eq!(friends[0].id, 2);
        assert_eq!(friends[0].display_name, "zed");
        assert_eq!(friends[0].game_name.as_deref(), Some("Crossroads"));
        assert!(friends[0].avatar_url.is_some());
        assert_eq!(friends[1].id, 1);
        assert!(!friends[1].in_game);
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
    fn studio_activity_uses_the_roblox_studio_format_once() {
        let detail = |state| PresenceDetail {
            state,
            place_id: None,
            universe_id: None,
            location: None,
        };
        let studio = detail(PresenceState::InStudio);
        assert_eq!(
            studio.activity(Some("Crossroads".into())).as_deref(),
            Some("Studio - Crossroads")
        );
        assert_eq!(
            studio
                .activity(Some("Studio - terrain replacement".into()))
                .as_deref(),
            Some("Studio - terrain replacement")
        );
        assert_eq!(studio.activity(None).as_deref(), Some("Studio"));
        assert_eq!(
            detail(PresenceState::InGame)
                .activity(Some("Studio - Tycoon".into()))
                .as_deref(),
            Some("Studio - Tycoon")
        );
        assert_eq!(detail(PresenceState::InGame).activity(None), None);
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
    fn place_search_details_fill_matching_places_only() {
        let mut matches = parse_search_response(
            r#"{"searchResults":[{"contentGroupType":"Game","contents":[
                {"name":"Bloodlines","rootPlaceId":5571328985,"universeId":7,"contentMaturity":"moderate"},
                {"name":"Other","rootPlaceId":2,"universeId":8}]}]}"#,
        );
        apply_game_details(
            &mut matches,
            r#"{"data":[{"id":7,"name":"x","creator":{"name":"-Bloodlines-","hasVerifiedBadge":true},
                "price":799,"visits":68648562,"favoritedCount":172633,"updated":"2026-10-28T23:44:26.973Z",
                "genre_l1":"RPG","genre_l2":"Action RPG"},
                {"id":9,"name":"Unrequested","visits":1}]}"#,
        );
        let [first, second] = matches.as_slice() else {
            panic!("two matches expected")
        };
        assert_eq!(first.maturity.as_deref(), Some("moderate"));
        assert_eq!(first.creator_name.as_deref(), Some("-Bloodlines-"));
        assert!(first.creator_verified);
        assert_eq!(
            (first.visits, first.favorites, first.price),
            (Some(68648562), Some(172633), Some(799))
        );
        assert_eq!(first.genre.as_deref(), Some("Action RPG"));
        assert_eq!(first.updated.as_deref(), Some("2026-10-28T23:44:26.973Z"));
        assert_eq!(
            (second.visits, second.creator_name.as_deref()),
            (None, None)
        );
        assert!(
            serde_json::to_value(second)
                .unwrap()
                .get("visits")
                .is_none()
        );
        apply_game_details(&mut matches, "not json");
        assert_eq!(matches[0].visits, Some(68648562));
    }

    #[test]
    fn place_search_sends_a_fixed_session_id() {
        let request = search_request(&reqwest::Client::new(), "rogue lineage")
            .build()
            .unwrap();
        let query = request.url().query().unwrap();
        assert!(query.contains("searchQuery=rogue+lineage"));
        assert!(query.contains("sessionId=00000000-0000-0000-0000-000000000000"));
    }

    #[test]
    fn place_search_keeps_unsponsored_named_games_once() {
        let matches = parse_search_response(
            r#"{"searchResults":[
                {"contentGroupType":"Game","contents":[{"name":"[x] Bloodlines","rootPlaceId":5571328985,
                    "universeId":7,"playerCount":5978,"totalUpVotes":90,"totalDownVotes":10}]},
                {"contentGroupType":"Game","contents":[{"name":"Ad","rootPlaceId":1,"isSponsored":true}]},
                {"contentGroupType":"User","contents":[{"name":"Player","rootPlaceId":2}]},
                {"contentGroupType":"Game","contents":[{"name":" ","rootPlaceId":3},{"name":"No place"},
                    {"name":"Again","rootPlaceId":5571328985}]}]}"#,
        );
        assert_eq!(
            matches,
            vec![PlaceMatch {
                place_id: "5571328985".into(),
                name: "[x] Bloodlines".into(),
                player_count: 5978,
                up_votes: 90,
                down_votes: 10,
                icon_url: None,
                maturity: None,
                creator_name: None,
                creator_verified: false,
                visits: None,
                favorites: None,
                updated: None,
                genre: None,
                price: None,
                universe_id: 7,
            }]
        );
        assert_eq!(
            parse_icon_response(
                r#"{"data":[{"targetId":7,"imageUrl":"https://tr.rbxcdn.com/a.png"},
                    {"targetId":8,"imageUrl":"http://tr.rbxcdn.com/b.png"},{"targetId":9,"imageUrl":null}]}"#
            ),
            BTreeMap::from([(7, "https://tr.rbxcdn.com/a.png".to_string())])
        );
        assert!(parse_icon_response("not json").is_empty());
        assert!(parse_search_response("not json").is_empty());
        let many = (1..=30)
            .map(|id| format!(r#"{{"name":"G{id}","rootPlaceId":{id}}}"#))
            .collect::<Vec<_>>()
            .join(",");
        let body =
            format!(r#"{{"searchResults":[{{"contentGroupType":"Game","contents":[{many}]}}]}}"#);
        assert_eq!(parse_search_response(&body).len(), SEARCH_LIMIT);
    }

    #[test]
    fn join_uri_encodes_the_launcher_but_keeps_the_protocol_shape() {
        let uri = join_uri(&JoinTarget::Place("1818".into()), "ticket-value");
        assert!(uri.starts_with("roblox-player:1+launchmode:play+gameinfo:ticket-value+"));
        assert!(uri.contains(
            "placelauncherurl:https%3A%2F%2Fassetgame.roblox.com%2Fgame%2FPlaceLauncher.ashx%3F"
        ));
        assert!(uri.contains("request%3DRequestGame%26"));
        assert!(uri.contains("placeId%3D1818%26"));
        assert!(!uri.contains("request=RequestGame"));
    }

    #[test]
    fn error_reason_reads_only_the_first_roblox_error() {
        assert_eq!(
            roblox_error_reason(r#"{"errors":[{"code":14,"message":"captcha"},{"code":1}]}"#),
            Some(r#"code 14 "captcha""#.into())
        );
        assert_eq!(roblox_error_reason("<html>"), None);
        assert_eq!(roblox_error_reason("{}"), None);
    }

    #[test]
    fn following_a_player_uses_the_follow_launcher_request() {
        let uri = join_uri(&JoinTarget::User(156), "ticket-value");
        assert!(uri.contains("request%3DRequestFollowUser%26"));
        assert!(uri.contains("userId%3D156%26"));
        assert!(!uri.contains("placeId"));
    }

    #[test]
    fn join_targets_accept_places_players_and_profile_links() {
        let place = |id: &str| Ok::<_, ()>(JoinTarget::Place(id.into()));
        let parse = |input| parse_join_target(input).map_err(|_| ());
        assert_eq!(parse("1818"), place("1818"));
        assert_eq!(parse("https://www.roblox.com/games/1818/x"), place("1818"));
        assert_eq!(parse(" @156 "), Ok(JoinTarget::User(156)));
        assert_eq!(
            parse("https://www.roblox.com/users/156/profile"),
            Ok(JoinTarget::User(156))
        );
        for invalid in [
            "@",
            "@0",
            "@builderman",
            "@15 6",
            "@123456789012345678901",
            "https://example.com/users/156",
            "http://www.roblox.com/users/156/profile",
            "https://www.roblox.com/users/x/profile",
        ] {
            assert!(parse(invalid).is_err(), "{invalid}");
        }
        assert_eq!(JoinTarget::User(156).to_string(), "@156");
        assert_eq!(JoinTarget::Place("1818".into()).to_string(), "1818");
    }

    #[test]
    fn player_search_keeps_valid_players_once_in_order() {
        let exact = r#"{"data":[{"id":156,"name":"builderman","displayName":"builderman","hasVerifiedBadge":true}]}"#;
        let user = |id: u64, name: &str| {
            format!(r#"{{"contentId":{id},"username":"{name}","displayName":""}}"#)
        };
        let search = format!(
            r#"{{"searchResults":[{{"contentGroupType":"Game","contents":[{}]}},{{"contentGroupType":"User","contents":[{},{},{},{}]}}]}}"#,
            user(9, "game"),
            user(156, "builderman"),
            user(0, "zero"),
            user(7, " "),
            user(8, "alt")
        );
        let players = parse_players(Some(exact), Some(&search));
        assert_eq!(
            players.iter().map(|player| player.id).collect::<Vec<_>>(),
            [156, 8]
        );
        assert!(players[0].verified);
        assert_eq!(players[1].display_name, "alt");
        assert_eq!(parse_players(Some("not json"), Some(&search)).len(), 2);
        assert_eq!(parse_players(Some(exact), None).len(), 1);
        let many = (1..=30)
            .map(|id| user(id, &format!("p{id}")))
            .collect::<Vec<_>>()
            .join(",");
        let many =
            format!(r#"{{"searchResults":[{{"contentGroupType":"User","contents":[{many}]}}]}}"#);
        assert_eq!(parse_players(None, Some(&many)).len(), PLAYER_SEARCH_LIMIT);
    }

    #[test]
    fn relationship_responses_read_only_the_requested_player() {
        let statuses = |status: &str| {
            format!(
                r#"{{"data":[{{"id":9,"status":"Friends"}},{{"id":156,"status":"{status}"}}]}}"#
            )
        };
        assert_eq!(
            parse_friend_status(&statuses("Friends"), 156).unwrap(),
            FriendStatus::Friends
        );
        assert_eq!(
            parse_friend_status(&statuses("RequestSent"), 156).unwrap(),
            FriendStatus::RequestSent
        );
        assert_eq!(
            parse_friend_status(&statuses("RequestReceived"), 156).unwrap(),
            FriendStatus::RequestReceived
        );
        assert_eq!(
            parse_friend_status(&statuses("NotFriends"), 156).unwrap(),
            FriendStatus::None
        );
        assert!(parse_friend_status(&statuses("Friends"), 157).is_err());
        assert!(parse_friend_status("[]", 156).is_err());
        let following = r#"{"followings":[{"userId":9,"isFollowing":true},{"userId":156,"isFollowing":false}]}"#;
        assert_eq!(parse_following(following, 156), Some(false));
        assert_eq!(parse_following(following, 157), None);
        assert_eq!(parse_blocked("true"), Some(true));
        assert_eq!(parse_blocked(r#"{"isBlocked":false}"#), Some(false));
        assert_eq!(parse_blocked("{}"), None);
    }

    #[test]
    fn social_actions_post_only_to_roblox_endpoints_for_the_player() {
        assert_eq!(
            SocialAction::RequestFriend.url(156),
            "https://friends.roblox.com/v1/users/156/request-friendship"
        );
        assert_eq!(
            SocialAction::Unfollow.url(156),
            "https://friends.roblox.com/v1/users/156/unfollow"
        );
        assert_eq!(
            SocialAction::Block.url(156),
            "https://apis.roblox.com/user-blocking-api/v1/users/156/block-user"
        );
        assert_eq!(
            SocialAction::Unblock.url(156),
            "https://apis.roblox.com/user-blocking-api/v1/users/156/unblock-user"
        );
    }
}
