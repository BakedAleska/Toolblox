//! Tauri command boundary and frontend-safe application state.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Manager, State};

use crate::credentials::{CredentialStore, OsCredentialStore, Secret};
use crate::login::{AccountIdentity, LoginError, LoginNotice};
use crate::models::{AccountDto, PresenceState, Settings, StoredAccount};
use crate::storage::{Storage, StorageError};
use crate::widget_process::WidgetProcessManager;
use crate::widgets::{Catalogue, CatalogueEntry, InstalledWidget};

/// The account and previous session to restore if saving a signed-in account fails.
type CredentialRollback = Arc<Mutex<Option<(u64, Option<Secret>)>>>;

/// Shared state for commands, managed by Tauri.
pub struct Runtime {
    /// Folder the legacy Flet app stored its data in.
    pub legacy_root: PathBuf,
    pub storage: Arc<Storage>,
    pub credentials: Arc<OsCredentialStore>,
    pub client: reqwest::Client,
    pub widgets_root: PathBuf,
    /// The verified widget catalogue, once loaded.
    pub catalogue: Mutex<Option<Catalogue>>,
    /// Why the catalogue couldn't be loaded, shown on the Widgets screen.
    pub catalogue_error: Mutex<Option<String>>,
    pub processes: Arc<Mutex<WidgetProcessManager>>,
    /// Active widget frame sessions.
    pub widget_sessions: Mutex<crate::widget_ipc::WidgetSessions>,
    /// Bundled helper that closes Roblox's singleton handles, when installed.
    pub multi_instance_helper: Option<PathBuf>,
    /// Roblox processes the helper already handled.
    pub cleared_roblox_pids: Mutex<std::collections::HashSet<u32>>,
    /// Widget modules and frames stay unloaded for this session.
    pub safe_mode: bool,
}

/// The settings the interface reads and edits.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsDto {
    sidebar_position: crate::models::SidebarPosition,
    theme_mode: crate::models::ThemeMode,
    show_avatars: bool,
    compact_mode: bool,
    sort_order: crate::models::SortOrder,
    place_id: String,
    multi_instance: bool,
    auto_rejoin: bool,
    open_on_launch: bool,
    run_in_background: bool,
    minimize_on_join: bool,
    show_game_names: bool,
    notify_on_drop: bool,
    always_on_top: bool,
}

impl From<&Settings> for SettingsDto {
    fn from(settings: &Settings) -> Self {
        Self {
            sidebar_position: settings.sidebar_pos.clone(),
            theme_mode: settings.theme_mode.clone(),
            show_avatars: settings.show_avatars,
            compact_mode: settings.compact_mode,
            sort_order: settings.sort_order.clone(),
            place_id: settings.place_id.clone(),
            multi_instance: settings.multi_instance,
            auto_rejoin: settings.auto_rejoin,
            open_on_launch: settings.open_on_launch,
            run_in_background: settings.run_in_background,
            minimize_on_join: settings.minimize_on_join,
            show_game_names: settings.show_game_names,
            notify_on_drop: settings.notify_on_drop,
            always_on_top: settings.always_on_top,
        }
    }
}

/// An account with its presence, as shown in the interface.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountView {
    #[serde(flatten)]
    account: AccountDto,
    presence: FrontendPresence,
    /// Name of the game the account is in, when game details are on.
    #[serde(skip_serializing_if = "Option::is_none")]
    game_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    game_place_id: Option<u64>,
}

/// Presence as the interface shows it.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum FrontendPresence {
    Offline,
    Playing,
    /// Presence couldn't be determined.
    Warning,
}

/// An installed widget, as shown in the interface.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetSummary {
    id: String,
    name: String,
    description: String,
    icon: Option<String>,
    enabled: bool,
    version: String,
    available_version: Option<String>,
    permissions: Vec<crate::widgets::WidgetPermission>,
    /// Permissions of the newer catalogue version, when one is available.
    available_permissions: Option<Vec<crate::widgets::WidgetPermission>>,
    has_settings: bool,
    has_dashboard_tile: bool,
    has_page_frame: bool,
    module_url: Option<String>,
    can_start_on_launch: bool,
    start_on_launch: bool,
    host_url: String,
}

/// A catalogue widget that isn't installed.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogueSummary {
    id: String,
    name: String,
    description: String,
    version: String,
    logo_url: Option<String>,
    permissions: Vec<crate::widgets::WidgetPermission>,
}

/// Everything the interface needs to render, without secrets.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStateDto {
    version: &'static str,
    channel: &'static str,
    platform: &'static str,
    widgets_path: String,
    accounts: Vec<AccountView>,
    installed_widgets: Vec<WidgetSummary>,
    widget_errors: Vec<String>,
    catalogue: Vec<CatalogueSummary>,
    catalogue_error: Option<String>,
    settings: SettingsDto,
    recent_places: Vec<crate::models::RecentPlace>,
    safe_mode: bool,
}

/// Result of a manual update check.
#[derive(Debug, Serialize)]
pub struct UpdateAvailability {
    available: bool,
    version: Option<String>,
}

/// Converts an error to the message returned to the interface.
fn command_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

/// Reads a response body, failing with `too_large` once it exceeds `maximum` bytes.
pub(crate) async fn read_response_limited(
    mut response: reqwest::Response,
    maximum: usize,
    too_large: &'static str,
    read_error: &'static str,
) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > maximum as u64)
    {
        return Err(too_large.into());
    }
    let mut bytes = Vec::with_capacity(
        response
            .content_length()
            .unwrap_or_default()
            .min(maximum as u64) as usize,
    );
    while let Some(chunk) = response.chunk().await.map_err(|_| read_error.to_string())? {
        if bytes.len().saturating_add(chunk.len()) > maximum {
            return Err(too_large.into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

/// Current Unix time in seconds.
fn now_seconds() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}

/// Fills in names and avatars for accounts saved without an avatar, such as imported ones.
pub(crate) async fn backfill_profiles(runtime: &Runtime) {
    let Ok(accounts) = runtime.storage.load_accounts() else {
        return;
    };
    let missing: Vec<_> = accounts
        .iter()
        .filter(|account| account.avatar_url.is_none())
        .map(|account| account.id)
        .collect();
    for account_id in missing {
        let Ok(profile) = crate::roblox::public_profile(&runtime.client, account_id).await else {
            continue;
        };
        let _ = runtime.storage.update_accounts(|accounts| {
            if let Some(account) = accounts.iter_mut().find(|account| account.id == account_id) {
                account.name = profile.name.clone();
                account.display_name = profile.display_name.clone();
                account.avatar_url = profile.avatar_url.clone();
            }
            Ok(())
        });
    }
}

/// Summarizes installed widgets, noting newer catalogue versions.
fn installed_widgets(runtime: &Runtime, settings: &Settings) -> Vec<WidgetSummary> {
    let catalogue_entries: HashMap<_, _> = runtime
        .catalogue
        .lock()
        .ok()
        .and_then(|value| value.clone())
        .map(|catalogue| {
            catalogue
                .entries
                .into_iter()
                .map(|entry| (entry.id, (entry.version, entry.permissions)))
                .collect()
        })
        .unwrap_or_default();
    crate::widgets::discover_installed(&runtime.widgets_root)
        .into_iter()
        .filter_map(Result::ok)
        .map(|widget| widget_summary(widget, settings, &catalogue_entries))
        .collect()
}

/// Summarizes one installed widget.
fn widget_summary(
    widget: InstalledWidget,
    settings: &Settings,
    catalogue_entries: &HashMap<String, (String, Vec<crate::widgets::WidgetPermission>)>,
) -> WidgetSummary {
    let id = widget.id;
    let available = catalogue_entries.get(&id).filter(|(version, _)| {
        semver::Version::parse(version)
            .ok()
            .zip(semver::Version::parse(&widget.version).ok())
            .is_some_and(|(available, installed)| available > installed)
    });
    WidgetSummary {
        name: widget.manifest.name,
        description: widget.manifest.description,
        icon: widget.manifest.icon,
        enabled: !settings.disabled_widgets.contains(&id),
        available_version: available.map(|(version, _)| version.clone()),
        permissions: widget.manifest.permissions.clone(),
        available_permissions: available.map(|(_, permissions)| permissions.clone()),
        has_settings: widget.manifest.settings_entry.is_some(),
        has_dashboard_tile: widget.manifest.dashboard_entry.is_some(),
        has_page_frame: widget.manifest.entry.is_some(),
        module_url: widget
            .manifest
            .module
            .as_deref()
            .map(|module| widget_asset_url(&id, module)),
        can_start_on_launch: !widget.manifest.processes.is_empty(),
        start_on_launch: settings.widgets_start_on_launch.contains(&id),
        host_url: widget_asset_url(&id, "index.html"),
        version: widget.version,
        id,
    }
}

/// Adds presence to each account.
///
/// Presence is fetched with the first session Roblox accepts. When game details are on, accounts
/// whose place is hidden from others are checked with their own session, and game names are
/// looked up.
async fn account_views(
    runtime: &Runtime,
    accounts: &[StoredAccount],
    show_game_names: bool,
) -> Vec<AccountView> {
    if accounts.is_empty() {
        return Vec::new();
    }
    let ids: Vec<_> = accounts.iter().map(|account| account.id).collect();
    let mut states = None;
    for account in accounts {
        let Ok(secret) = runtime.credentials.get(account.id) else {
            continue;
        };
        match crate::roblox::fetch_presence_details(&runtime.client, &secret, &ids).await {
            Ok(found) => {
                states = Some(found);
                break;
            }
            Err(crate::roblox::RobloxError::Rejected(_)) => continue,
            Err(_) => break,
        }
    }
    let mut game_names = BTreeMap::new();
    if let Some(states) = states.as_mut().filter(|_| show_game_names) {
        for account in accounts {
            let hidden = states
                .get(&account.id)
                .is_some_and(|detail| detail.in_game() && detail.place_id.is_none());
            if !hidden {
                continue;
            }
            let Ok(secret) = runtime.credentials.get(account.id) else {
                continue;
            };
            let own =
                crate::roblox::fetch_presence_details(&runtime.client, &secret, &[account.id])
                    .await;
            if let Some(detail) = own.ok().and_then(|own| own.into_values().next()) {
                states.insert(account.id, detail);
            }
        }
        let unnamed: BTreeSet<_> = states
            .values()
            .filter(|detail| detail.in_game() && detail.location.is_none())
            .filter_map(|detail| detail.universe_id)
            .collect();
        game_names = crate::roblox::fetch_game_names(&runtime.client, &unnamed).await;
    }
    accounts
        .iter()
        .map(|account| {
            let detail = states.as_ref().and_then(|states| states.get(&account.id));
            let presence = match detail.map(|detail| &detail.state) {
                Some(PresenceState::Offline) => FrontendPresence::Offline,
                Some(PresenceState::InGame | PresenceState::InStudio) => FrontendPresence::Playing,
                Some(PresenceState::Online | PresenceState::Unknown) | None => {
                    FrontendPresence::Warning
                }
            };
            let detail = detail.filter(|detail| show_game_names && detail.in_game());
            AccountView {
                account: AccountDto::from(account),
                presence,
                game_name: detail.and_then(|detail| {
                    detail.location.clone().or_else(|| {
                        detail
                            .universe_id
                            .and_then(|id| game_names.get(&id).cloned())
                    })
                }),
                game_place_id: detail.and_then(|detail| detail.place_id),
            }
        })
        .collect()
}

/// Looks up names for recent places that don't have one yet. Network failures leave the name
/// unset so the next refresh tries again.
async fn name_recent_places(runtime: &Runtime, settings: Settings) -> Settings {
    let mut named = BTreeMap::new();
    for place in settings
        .recent_places
        .iter()
        .filter(|place| place.name.is_none())
    {
        let Ok(universe) =
            crate::roblox::fetch_place_universe(&runtime.client, &place.place_id).await
        else {
            continue;
        };
        let name = match universe {
            Some(universe) => {
                let ids = BTreeSet::from([universe]);
                let names = crate::roblox::fetch_game_names(&runtime.client, &ids).await;
                let Some(name) = names.get(&universe) else {
                    continue;
                };
                name.clone()
            }
            None => String::new(),
        };
        named.insert(place.place_id.clone(), name);
    }
    if named.is_empty() {
        return settings;
    }
    runtime
        .storage
        .update_settings(|saved| {
            for place in &mut saved.recent_places {
                if let Some(name) = named.get(&place.place_id) {
                    place.name = Some(name.clone());
                }
            }
            Ok(saved.clone())
        })
        .unwrap_or(settings)
}

/// Returns the full interface state, loading the catalogue first if it hasn't been tried.
#[tauri::command]
pub async fn get_app_state(runtime: State<'_, Runtime>) -> Result<AppStateDto, String> {
    let catalogue_unset = runtime
        .catalogue
        .lock()
        .map(|value| value.is_none())
        .unwrap_or(false)
        && runtime
            .catalogue_error
            .lock()
            .map(|value| value.is_none())
            .unwrap_or(false);
    if catalogue_unset {
        let _ = refresh_catalogue_data(&runtime).await;
    }
    let mut settings = runtime.storage.load_settings().map_err(command_error)?;
    if settings.show_game_names {
        settings = name_recent_places(&runtime, settings).await;
    }
    let accounts = runtime.storage.load_accounts().map_err(command_error)?;
    let catalogue = runtime
        .catalogue
        .lock()
        .map_err(|_| "The widget catalogue is busy. Can you try again?".to_string())?
        .clone()
        .map(|catalogue| {
            catalogue
                .entries
                .into_iter()
                .filter(|entry| !runtime.widgets_root.join(&entry.id).exists())
                .map(|entry| CatalogueSummary {
                    id: entry.id,
                    name: entry.name,
                    description: entry.description,
                    version: entry.version,
                    logo_url: entry.icon_url,
                    permissions: entry.permissions,
                })
                .collect()
        })
        .unwrap_or_default();
    let catalogue_error = runtime
        .catalogue_error
        .lock()
        .ok()
        .and_then(|value| value.clone());
    let widget_errors = crate::widgets::discover_installed(&runtime.widgets_root)
        .into_iter()
        .filter_map(Result::err)
        .collect();
    Ok(AppStateDto {
        version: env!("CARGO_PKG_VERSION"),
        channel: if cfg!(debug_assertions) {
            "canary"
        } else {
            "stable"
        },
        platform: if cfg!(target_os = "macos") {
            "macos"
        } else {
            "windows"
        },
        widgets_path: runtime.widgets_root.display().to_string(),
        accounts: account_views(&runtime, &accounts, settings.show_game_names).await,
        installed_widgets: installed_widgets(&runtime, &settings),
        widget_errors,
        catalogue,
        catalogue_error,
        recent_places: settings.recent_places.clone(),
        safe_mode: runtime.safe_mode,
        settings: SettingsDto::from(&settings),
    })
}

/// Validates and saves settings, applies always on top, and changes launch at login. The settings
/// are restored if launch at login can't be changed.
#[tauri::command]
pub fn save_settings(
    app: AppHandle,
    settings: SettingsDto,
    runtime: State<'_, Runtime>,
) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;

    let mut saved = runtime.storage.load_settings().map_err(command_error)?;
    let previous = saved.clone();
    saved.sidebar_pos = settings.sidebar_position;
    saved.theme_mode = settings.theme_mode;
    saved.show_avatars = settings.show_avatars;
    saved.compact_mode = settings.compact_mode;
    saved.sort_order = settings.sort_order;
    saved.place_id = crate::roblox::parse_place_id(&settings.place_id)
        .or_else(|error| {
            if settings.place_id.trim().is_empty() {
                Ok(String::new())
            } else {
                Err(error)
            }
        })
        .map_err(command_error)?;
    saved.multi_instance = settings.multi_instance;
    saved.auto_rejoin = settings.auto_rejoin;
    saved.open_on_launch = settings.open_on_launch;
    saved.run_in_background = settings.run_in_background;
    saved.minimize_on_join = settings.minimize_on_join;
    saved.show_game_names = settings.show_game_names;
    saved.notify_on_drop = settings.notify_on_drop;
    saved.always_on_top = settings.always_on_top;
    if !saved.place_id.is_empty() && saved.place_id != previous.place_id {
        let place_id = saved.place_id.clone();
        saved.remember_place(&place_id);
    }
    runtime
        .storage
        .save_settings(&saved)
        .map_err(command_error)?;
    if saved.always_on_top != previous.always_on_top
        && let Some(window) = app.get_webview_window(crate::lifecycle::MAIN_WINDOW_LABEL)
    {
        let _ = window.set_always_on_top(saved.always_on_top);
    }
    let autostart = app.autolaunch();
    let result = if saved.open_on_launch == previous.open_on_launch {
        Ok(())
    } else if saved.open_on_launch {
        autostart.enable()
    } else {
        autostart.disable()
    };
    if result.is_err() {
        let _ = runtime.storage.save_settings(&previous);
        return Err(
            "The startup setting couldn't be changed. Does this account allow startup apps?".into(),
        );
    }
    Ok(())
}

/// Reports whether Roblox knows the place. Network failures are errors, not a missing place.
#[tauri::command]
pub async fn place_exists(place_id: String, runtime: State<'_, Runtime>) -> Result<bool, String> {
    crate::roblox::fetch_place_universe(&runtime.client, &place_id)
        .await
        .map(|universe| universe.is_some())
        .map_err(command_error)
}

/// Sets or clears the place a single account joins instead of the default place.
#[tauri::command]
pub fn set_account_place(
    account_id: u64,
    place_id: Option<String>,
    runtime: State<'_, Runtime>,
) -> Result<(), String> {
    let place_id = match place_id.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(input) => Some(crate::roblox::parse_place_id(input).map_err(command_error)?),
    };
    runtime
        .storage
        .update_accounts(|accounts| {
            let account = accounts
                .iter_mut()
                .find(|account| account.id == account_id)
                .ok_or_else(|| {
                    StorageError::Invalid(
                        "The account wasn't found. Can you refresh the list?".into(),
                    )
                })?;
            account.place_id = place_id.clone();
            Ok(())
        })
        .map_err(command_error)?;
    if let Some(place_id) = place_id {
        runtime
            .storage
            .update_settings(|settings| {
                settings.remember_place(&place_id);
                Ok(())
            })
            .map_err(command_error)?;
    }
    Ok(())
}

/// Replaces an account's notes, up to 10,000 characters.
#[tauri::command]
pub fn update_account_notes(
    account_id: u64,
    notes: String,
    runtime: State<'_, Runtime>,
) -> Result<(), String> {
    if notes.chars().count() > 10_000 {
        return Err("The note is too long. Can you shorten it?".into());
    }
    runtime
        .storage
        .update_accounts(|accounts| {
            let account = accounts
                .iter_mut()
                .find(|account| account.id == account_id)
                .ok_or_else(|| {
                    StorageError::Invalid(
                        "The account wasn't found. Can you refresh the list?".into(),
                    )
                })?;
            account.notes = notes;
            Ok(())
        })
        .map_err(command_error)
}

/// Removes an account and its stored session. The account is restored if the session can't be
/// deleted.
#[tauri::command]
pub fn remove_account(account_id: u64, runtime: State<'_, Runtime>) -> Result<(), String> {
    let removed = runtime
        .storage
        .update_accounts(|accounts| {
            let index = accounts
                .iter()
                .position(|account| account.id == account_id)
                .ok_or_else(|| {
                    StorageError::Invalid(
                        "The account wasn't found. Can you refresh the list?".into(),
                    )
                })?;
            Ok((index, accounts.remove(index)))
        })
        .map_err(command_error)?;
    if let Err(error) = runtime.credentials.delete(account_id) {
        let rollback = runtime.storage.update_accounts(|accounts| {
            if accounts.iter().all(|account| account.id != account_id) {
                accounts.insert(removed.0.min(accounts.len()), removed.1.clone());
            }
            Ok(())
        });
        return match rollback {
            Ok(()) => Err(command_error(error)),
            Err(_) => Err("The account was removed, but its secure session couldn't be cleared. Can you restart Toolblox and try adding then removing the account again?".into()),
        };
    }
    Ok(())
}

/// Saves a manual account order. `account_ids` must list every account once.
#[tauri::command]
pub fn reorder_accounts(account_ids: Vec<u64>, runtime: State<'_, Runtime>) -> Result<(), String> {
    runtime
        .storage
        .update_accounts(|accounts| {
            if account_ids.len() != accounts.len() {
                return Err(StorageError::Invalid(
                    "The account order is incomplete. Can you refresh the list?".into(),
                ));
            }
            let mut by_id: BTreeMap<_, _> = accounts
                .drain(..)
                .map(|account| (account.id, account))
                .collect();
            for id in &account_ids {
                let account = by_id.remove(id).ok_or_else(|| {
                    StorageError::Invalid(
                        "The account order contains an unknown account. Can you refresh the list?"
                            .into(),
                    )
                })?;
                accounts.push(account);
            }
            if !by_id.is_empty() {
                return Err(StorageError::Invalid(
                    "The account order is incomplete. Can you refresh the list?".into(),
                ));
            }
            Ok(())
        })
        .map_err(command_error)
}

/// Joins each account, at `place_id` when given, then minimizes the window if that setting is on.
#[tauri::command]
pub async fn join_accounts(
    app: AppHandle,
    account_ids: Vec<u64>,
    place_id: Option<String>,
    runtime: State<'_, Runtime>,
) -> Result<(), String> {
    if account_ids.is_empty() {
        return Err("No accounts were selected. Can you select at least one?".into());
    }
    let place_id = place_id
        .as_deref()
        .map(crate::roblox::parse_place_id)
        .transpose()
        .map_err(command_error)?;
    join_account_ids(&runtime, &account_ids, true, place_id.as_deref()).await?;
    let minimize = runtime
        .storage
        .load_settings()
        .is_ok_and(|settings| settings.minimize_on_join);
    if minimize && let Some(window) = app.get_webview_window(crate::lifecycle::MAIN_WINDOW_LABEL) {
        let _ = window.minimize();
    }
    Ok(())
}

/// Opens the Roblox sign-in window and waits for it, then adds or updates the signed-in account.
/// The previous session is restored if saving the account fails.
#[tauri::command]
pub async fn begin_roblox_login(
    app: AppHandle,
    runtime: State<'_, Runtime>,
) -> Result<AccountView, String> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let client = runtime.client.clone();
    let credentials = Arc::clone(&runtime.credentials);
    let credential_rollback: CredentialRollback = Arc::new(Mutex::new(None));
    let rollback_for_store = Arc::clone(&credential_rollback);
    crate::login::open_roblox_login(
        &app,
        move |cookie| {
            let profile = tauri::async_runtime::block_on(crate::roblox::authenticated_profile(
                &client,
                &crate::credentials::Secret::new(cookie.expose_secret().to_owned()),
            ))
            .map_err(|error| match error {
                crate::roblox::RobloxError::Network => LoginError::Network,
                _ => LoginError::InvalidSession,
            })?;
            Ok(AccountIdentity {
                id: profile.id,
                name: profile.name,
                display_name: profile.display_name,
                avatar_url: profile.avatar_url,
            })
        },
        move |identity, cookie| {
            let previous = credentials.get(identity.id).ok();
            credentials
                .set(identity.id, cookie.expose_secret())
                .map_err(|_| LoginError::CredentialStore)?;
            *rollback_for_store
                .lock()
                .map_err(|_| LoginError::CredentialStore)? = Some((identity.id, previous));
            Ok(())
        },
        move |notice| {
            let _ = sender.send(notice);
        },
    )
    .map_err(command_error)?;
    let notice = tauri::async_runtime::spawn_blocking(move || receiver.recv())
        .await
        .map_err(|_| "The Roblox sign-in stopped unexpectedly. Can you try again?".to_string())?
        .map_err(|_| "The Roblox sign-in stopped unexpectedly. Can you try again?".to_string())?;
    let identity = match notice {
        LoginNotice::Complete(identity) => identity,
        LoginNotice::Failed(error) => return Err(command_error(error)),
        LoginNotice::Cancelled => {
            return Err("The Roblox sign-in was cancelled. Can you try again?".into());
        }
    };
    let account_result = runtime.storage.update_accounts(|accounts| {
        if let Some(account) = accounts
            .iter_mut()
            .find(|account| account.id == identity.id)
        {
            account.name = identity.name.clone();
            account.display_name = identity.display_name.clone();
            account.avatar_url = identity.avatar_url.clone();
            return Ok(account.clone());
        }
        let account = StoredAccount {
            id: identity.id,
            name: identity.name,
            display_name: identity.display_name,
            avatar_url: identity.avatar_url,
            notes: String::new(),
            added_at: now_seconds(),
            last_played_at: None,
            play_count: 0,
            widget_data: BTreeMap::new(),
            place_id: None,
            last_place_id: None,
            extra: serde_json::Map::new(),
        };
        accounts.push(account.clone());
        Ok(account)
    });
    let account = match account_result {
        Ok(account) => {
            if let Ok(mut rollback) = credential_rollback.lock() {
                rollback.take();
            }
            account
        }
        Err(error) => {
            if let Ok(mut rollback) = credential_rollback.lock()
                && let Some((account_id, previous)) = rollback.take()
            {
                if let Some(secret) = previous {
                    let _ = runtime.credentials.set(account_id, secret.expose());
                } else {
                    let _ = runtime.credentials.delete(account_id);
                }
            }
            return Err(command_error(error));
        }
    };
    Ok(AccountView {
        account: AccountDto::from(&account),
        presence: FrontendPresence::Warning,
        game_name: None,
        game_place_id: None,
    })
}

/// Returns a widget's entry in the verified catalogue.
fn catalogue_entry(runtime: &Runtime, widget_id: &str) -> Result<CatalogueEntry, String> {
    runtime
        .catalogue
        .lock()
        .map_err(|_| "The widget catalogue is busy. Can you try again?".to_string())?
        .as_ref()
        .and_then(|catalogue| catalogue.entries.iter().find(|entry| entry.id == widget_id))
        .cloned()
        .ok_or_else(|| "The widget isn't in the verified catalogue. Can you refresh it?".into())
}

/// Downloads and installs a widget from the verified catalogue.
async fn install_catalogue_widget(widget_id: &str, runtime: &Runtime) -> Result<(), String> {
    let entry = catalogue_entry(runtime, widget_id)?;
    let response = runtime
        .client
        .get(&entry.archive_url)
        .send()
        .await
        .map_err(|_| {
            "The widget package couldn't be downloaded. Is your connection working?".to_string()
        })?;
    if !response.status().is_success() {
        return Err(format!(
            "The widget package download failed with status {}. Can you try again?",
            response.status().as_u16()
        ));
    }
    let bytes = read_response_limited(
        response,
        20 * 1024 * 1024,
        "The widget package is larger than 20 MB.",
        "The widget package couldn't be read. Can you try again?",
    )
    .await?;
    crate::widgets::install_archive(
        &bytes,
        &entry.id,
        &entry.version,
        &entry.sha256,
        &entry.permissions,
        &runtime.widgets_root,
    )
    .map(|_| ())
}

/// Installs a catalogue widget that isn't installed yet.
#[tauri::command]
pub async fn install_widget(widget_id: String, runtime: State<'_, Runtime>) -> Result<(), String> {
    if find_installed_widget(&runtime, &widget_id).is_ok() {
        return Err("The widget is already installed. Can you update it instead?".into());
    }
    install_catalogue_widget(&widget_id, &runtime).await
}

/// Stops a widget's processes and installs its newer catalogue version.
#[tauri::command]
pub async fn update_widget(widget_id: String, runtime: State<'_, Runtime>) -> Result<(), String> {
    let installed = find_installed_widget(&runtime, &widget_id)?;
    let entry = catalogue_entry(&runtime, &widget_id)?;
    let installed_version = semver::Version::parse(&installed.version).map_err(|_| {
        "The installed widget version isn't valid. Can you reinstall it?".to_string()
    })?;
    let available_version = semver::Version::parse(&entry.version)
        .map_err(|_| "The catalogue widget version isn't valid. Can you refresh it?".to_string())?;
    if available_version <= installed_version {
        return Err("The catalogue doesn't contain a newer widget version.".into());
    }
    runtime
        .processes
        .lock()
        .map_err(|_| "The widget process manager is busy. Can you try again?".to_string())?
        .stop_widget(&widget_id);
    install_catalogue_widget(&widget_id, &runtime).await
}

/// Stops a widget's processes, removes it, and clears its settings.
#[tauri::command]
pub fn uninstall_widget(widget_id: String, runtime: State<'_, Runtime>) -> Result<(), String> {
    runtime
        .processes
        .lock()
        .map_err(|_| "The widget process manager is busy. Can you try again?".to_string())?
        .stop_widget(&widget_id);
    crate::widgets::uninstall_widget(&widget_id, &runtime.widgets_root)?;
    let mut settings = runtime.storage.load_settings().map_err(command_error)?;
    settings.disabled_widgets.retain(|id| id != &widget_id);
    settings
        .widgets_start_on_launch
        .retain(|id| id != &widget_id);
    settings.widget_settings.remove(&widget_id);
    runtime
        .storage
        .save_settings(&settings)
        .map_err(command_error)
}

/// Turns an installed widget on or off, stopping its processes when turned off.
#[tauri::command]
pub fn set_widget_enabled(
    widget_id: String,
    enabled: bool,
    runtime: State<'_, Runtime>,
) -> Result<(), String> {
    if !runtime.widgets_root.join(&widget_id).is_dir() {
        return Err("The widget isn't installed. Can you refresh the list?".into());
    }
    let mut settings = runtime.storage.load_settings().map_err(command_error)?;
    settings.disabled_widgets.retain(|id| id != &widget_id);
    if !enabled {
        settings.disabled_widgets.push(widget_id.clone());
        runtime
            .processes
            .lock()
            .map_err(|_| "The widget process manager is busy. Can you try again?".to_string())?
            .stop_widget(&widget_id);
    }
    runtime
        .storage
        .save_settings(&settings)
        .map_err(command_error)
}

/// Sets whether a widget's processes start with the app.
#[tauri::command]
pub fn set_widget_start_on_launch(
    widget_id: String,
    enabled: bool,
    runtime: State<'_, Runtime>,
) -> Result<(), String> {
    if !runtime.widgets_root.join(&widget_id).is_dir() {
        return Err("The widget isn't installed. Can you refresh the list?".into());
    }
    let mut settings = runtime.storage.load_settings().map_err(command_error)?;
    settings
        .widgets_start_on_launch
        .retain(|id| id != &widget_id);
    if enabled {
        settings.widgets_start_on_launch.push(widget_id);
    }
    runtime
        .storage
        .save_settings(&settings)
        .map_err(command_error)
}

/// Loads the widget catalogue again.
#[tauri::command]
pub async fn retry_catalogue(runtime: State<'_, Runtime>) -> Result<(), String> {
    refresh_catalogue_data(&runtime).await
}

/// Runs the startup update check again. A required update installs and restarts the app.
#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> Result<UpdateAvailability, String> {
    crate::startup::run(app.clone()).await;
    match app.state::<crate::startup::StartupState>().view() {
        crate::startup::StartupView::Failed { message } => Err(message),
        _ => Ok(UpdateAvailability {
            available: false,
            version: None,
        }),
    }
}

/// Base URL for installed widget assets. Windows WebView2 serves custom schemes over HTTP.
#[cfg(windows)]
const WIDGET_ORIGIN: &str = "http://widget.localhost";
/// Base URL for installed widget assets.
#[cfg(not(windows))]
const WIDGET_ORIGIN: &str = "widget://localhost";

/// Returns the URL of a file in an installed widget.
fn widget_asset_url(widget_id: &str, path: &str) -> String {
    format!("{WIDGET_ORIGIN}/{widget_id}/{path}")
}

/// Downloads and verifies the signed widget catalogue, recording any error for the interface.
/// Debug builds without a catalogue URL use an empty catalogue.
async fn refresh_catalogue_data(runtime: &Runtime) -> Result<(), String> {
    let Some(url) = option_env!("TOOLBLOX_CATALOGUE_URL") else {
        #[cfg(debug_assertions)]
        {
            *runtime
                .catalogue
                .lock()
                .map_err(|_| "The widget catalogue is busy. Can you try again?".to_string())? =
                Some(Catalogue {
                    schema_version: 1,
                    generated_at: 0,
                    entries: Vec::new(),
                });
            *runtime
                .catalogue_error
                .lock()
                .map_err(|_| "The widget catalogue is busy. Can you try again?".to_string())? =
                None;
            return Ok(());
        }
        #[cfg(not(debug_assertions))]
        return set_catalogue_error(
            runtime,
            "This build doesn't have a widget catalogue endpoint. Can you reinstall Toolblox?",
        );
    };
    let Some(public_key) = option_env!("TOOLBLOX_CATALOGUE_PUBLIC_KEY") else {
        return set_catalogue_error(
            runtime,
            "This build doesn't have a widget catalogue key. Can you reinstall Toolblox?",
        );
    };
    if !url.starts_with("https://") {
        return set_catalogue_error(
            runtime,
            "The widget catalogue endpoint isn't secure. Can you reinstall Toolblox?",
        );
    }
    let result = async {
        let response = runtime.client.get(url).send().await.map_err(|_| {
            "The widget catalogue couldn't be downloaded. Is your connection working?".to_string()
        })?;
        if !response.status().is_success() {
            return Err(format!(
                "The widget catalogue returned status {}. Can you try again?",
                response.status().as_u16()
            ));
        }
        let bytes = read_response_limited(
            response,
            1024 * 1024,
            "The widget catalogue is larger than 1 MB.",
            "The widget catalogue couldn't be read. Can you try again?",
        )
        .await?;
        let signature = runtime
            .client
            .get(format!("{url}.sig"))
            .send()
            .await
            .map_err(|_| {
                "The widget catalogue signature couldn't be downloaded. Is your connection working?"
                    .to_string()
            })?;
        if !signature.status().is_success() {
            return Err(
                "The widget catalogue signature isn't available. Can you try again later?".into(),
            );
        }
        let signature = read_response_limited(
            signature,
            8 * 1024,
            "The widget catalogue signature is too large.",
            "The widget catalogue signature couldn't be read. Can you try again?",
        )
        .await?;
        let signature = String::from_utf8(signature)
            .map_err(|_| "The widget catalogue signature isn't text.".to_string())?;
        Catalogue::parse_verified(&bytes, &signature, public_key)
    }
    .await;
    match result {
        Ok(catalogue) => {
            *runtime
                .catalogue
                .lock()
                .map_err(|_| "The widget catalogue is busy. Can you try again?".to_string())? =
                Some(catalogue);
            *runtime
                .catalogue_error
                .lock()
                .map_err(|_| "The widget catalogue is busy. Can you try again?".to_string())? =
                None;
            Ok(())
        }
        Err(error) => set_catalogue_error(runtime, &error),
    }
}

/// Records a catalogue error and returns it.
fn set_catalogue_error(runtime: &Runtime, error: &str) -> Result<(), String> {
    *runtime
        .catalogue_error
        .lock()
        .map_err(|_| "The widget catalogue is busy. Can you try again?".to_string())? =
        Some(error.to_owned());
    Err(error.to_owned())
}

/// A widget surface to load and the session ID its requests must carry.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetHostSession {
    session_id: String,
    url: String,
}

/// Returns an installed widget by ID.
fn find_installed_widget(runtime: &Runtime, widget_id: &str) -> Result<InstalledWidget, String> {
    crate::widgets::discover_installed(&runtime.widgets_root)
        .into_iter()
        .filter_map(Result::ok)
        .find(|widget| widget.id == widget_id)
        .ok_or_else(|| "The widget isn't installed. Can you refresh the list?".into())
}

/// Starts a session for a widget surface: `main`, `settings`, `dashboard`, or `module`.
///
/// Frame surfaces get the manifest's permissions. Module sessions get every permission because
/// modules run in the app window. Fails in safe mode and for disabled widgets.
#[tauri::command]
pub fn open_widget(
    widget_id: String,
    surface: Option<String>,
    runtime: State<'_, Runtime>,
) -> Result<WidgetHostSession, String> {
    let settings = runtime.storage.load_settings().map_err(command_error)?;
    if runtime.safe_mode {
        return Err("Widgets are off in safe mode. Can you restart Toolblox normally?".into());
    }
    if settings.disabled_widgets.contains(&widget_id) {
        return Err("The widget is disabled. Can you enable it first?".into());
    }
    let widget = find_installed_widget(&runtime, &widget_id)?;
    let permissions = widget.manifest.permissions.clone();
    let entry = match surface.as_deref().unwrap_or("main") {
        "main" => widget
            .manifest
            .entry
            .as_deref()
            .ok_or_else(|| "The widget doesn't provide a page.".to_string())?,
        "module" => {
            let module = widget
                .manifest
                .module
                .as_deref()
                .ok_or_else(|| "The widget doesn't provide a module.".to_string())?;
            return Ok(WidgetHostSession {
                session_id: insert_widget_session(
                    &runtime,
                    &widget_id,
                    crate::widgets::WidgetPermission::ALL.to_vec(),
                )?,
                url: widget_asset_url(&widget_id, module),
            });
        }
        "settings" => widget
            .manifest
            .settings_entry
            .as_deref()
            .ok_or_else(|| "The widget doesn't provide a settings view.".to_string())?,
        "dashboard" => widget
            .manifest
            .dashboard_entry
            .as_deref()
            .ok_or_else(|| "The widget doesn't provide a dashboard view.".to_string())?,
        _ => return Err("The widget surface isn't supported.".into()),
    };
    Ok(WidgetHostSession {
        session_id: insert_widget_session(&runtime, &widget_id, permissions)?,
        url: widget_asset_url(&widget_id, entry),
    })
}

/// Registers a widget session with a random ID.
fn insert_widget_session(
    runtime: &Runtime,
    widget_id: &str,
    permissions: Vec<crate::widgets::WidgetPermission>,
) -> Result<String, String> {
    let session_id = uuid::Uuid::new_v4().to_string();
    runtime
        .widget_sessions
        .lock()
        .map_err(|_| "The widget session manager is busy. Can you try again?".to_string())?
        .insert(
            session_id.clone(),
            crate::widget_ipc::WidgetSession::new(widget_id.to_string(), permissions),
        );
    Ok(session_id)
}

/// Largest value a widget can keep in its own store.
const MAX_WIDGET_STORE_BYTES: usize = 1024 * 1024;

/// Reads the free-form JSON value a widget keeps for itself.
#[tauri::command]
pub fn get_widget_store(widget_id: String, runtime: State<'_, Runtime>) -> Result<Value, String> {
    find_installed_widget(&runtime, &widget_id)?;
    let settings = runtime.storage.load_settings().map_err(command_error)?;
    Ok(settings
        .widget_settings
        .get(&widget_id)
        .cloned()
        .unwrap_or(Value::Null))
}

/// Replaces the free-form JSON value a widget keeps for itself.
#[tauri::command]
pub fn set_widget_store(
    widget_id: String,
    value: Value,
    runtime: State<'_, Runtime>,
) -> Result<(), String> {
    find_installed_widget(&runtime, &widget_id)?;
    let size = serde_json::to_vec(&value)
        .map_err(|_| "The widget data isn't valid JSON.".to_string())?
        .len();
    if size > MAX_WIDGET_STORE_BYTES {
        return Err("The widget data is larger than 1 MB. Can the widget store less?".into());
    }
    runtime
        .storage
        .update_settings(|settings| {
            if value.is_null() {
                settings.widget_settings.remove(&widget_id);
            } else {
                settings.widget_settings.insert(widget_id.clone(), value);
            }
            Ok(())
        })
        .map_err(command_error)
}

/// Restarts Toolblox, optionally without loading any widgets for the next session.
#[tauri::command]
pub fn restart_app(app: AppHandle, safe_mode: bool, runtime: State<'_, Runtime>) {
    crate::set_safe_mode_marker(runtime.storage.root(), safe_mode);
    app.restart();
}

/// Ends a widget session.
#[tauri::command]
pub fn close_widget_session(session_id: String, runtime: State<'_, Runtime>) {
    if let Ok(mut sessions) = runtime.widget_sessions.lock() {
        sessions.remove(&session_id);
    }
}

/// Authorizes a widget message against its session and runs it. Method failures are returned
/// in the response rather than as a command error.
#[tauri::command]
pub async fn widget_request(
    session_id: String,
    widget_id: String,
    message: String,
    runtime: State<'_, Runtime>,
) -> Result<crate::widget_ipc::WidgetResponse, String> {
    let request = runtime
        .widget_sessions
        .lock()
        .map_err(|_| "The widget session manager is busy. Can you try again?".to_string())?
        .authorize(&session_id, &widget_id, message.as_bytes())?;
    let request_id = request.request_id.clone();
    match dispatch_widget_request(&runtime, &widget_id, &request.method, request.params).await {
        Ok(result) => Ok(crate::widget_ipc::success(request_id, result)),
        Err(error) => Ok(crate::widget_ipc::failure(request_id, error)),
    }
}

/// Runs an authorized widget method.
async fn dispatch_widget_request(
    runtime: &Runtime,
    widget_id: &str,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    match method {
        "accounts.list" => {
            let accounts = runtime.storage.load_accounts().map_err(command_error)?;
            Ok(Value::Array(
                accounts
                    .iter()
                    .map(|account| {
                        json!({
                            "id": account.id,
                            "name": account.name,
                            "displayName": account.display_name,
                            "avatarUrl": account.avatar_url,
                        })
                    })
                    .collect(),
            ))
        }
        "widgetData.get" => {
            let account_id = required_u64(&params, "accountId")?;
            let accounts = runtime.storage.load_accounts().map_err(command_error)?;
            let account = accounts
                .iter()
                .find(|account| account.id == account_id)
                .ok_or_else(|| {
                    "The account wasn't found. Can you refresh the widget?".to_string()
                })?;
            Ok(account
                .widget_data
                .get(widget_id)
                .cloned()
                .unwrap_or(Value::Null))
        }
        "widgetData.set" => {
            let account_id = required_u64(&params, "accountId")?;
            let value = params
                .get("value")
                .cloned()
                .ok_or_else(|| "The widget data value is missing.".to_string())?;
            if serde_json::to_vec(&value)
                .map_err(|_| "The widget data isn't valid JSON.".to_string())?
                .len()
                > 1024 * 1024
            {
                return Err("The widget data is larger than 1 MB.".into());
            }
            runtime
                .storage
                .update_accounts(|accounts| {
                    let account = accounts
                        .iter_mut()
                        .find(|account| account.id == account_id)
                        .ok_or_else(|| {
                            StorageError::Invalid(
                                "The account wasn't found. Can you refresh the widget?".into(),
                            )
                        })?;
                    account.widget_data.insert(widget_id.to_owned(), value);
                    Ok(())
                })
                .map_err(command_error)?;
            Ok(Value::Null)
        }
        "roblox.status" => {
            let accounts = runtime.storage.load_accounts().map_err(command_error)?;
            let ids: Vec<_> = accounts.iter().map(|account| account.id).collect();
            for account in &accounts {
                let Ok(secret) = runtime.credentials.get(account.id) else {
                    continue;
                };
                match crate::roblox::fetch_presence(&runtime.client, &secret, &ids).await {
                    Ok(states) => return Ok(json!(states)),
                    Err(crate::roblox::RobloxError::Rejected(_)) => continue,
                    Err(error) => return Err(command_error(error)),
                }
            }
            Err("No signed-in account could check Roblox status. Can you sign in again?".into())
        }
        "roblox.join" => {
            let account_ids = required_u64_array(&params, "accountIds")?;
            join_account_ids(runtime, &account_ids, true, None).await?;
            Ok(Value::Null)
        }
        "network.fetch" => widget_network_fetch(runtime, widget_id, &params).await,
        "process.spawn" => {
            let process_id = required_string(&params, "processId")?;
            let arguments = optional_string_array(&params, "arguments")?;
            let widget = find_installed_widget(runtime, widget_id)?;
            let declaration = widget
                .manifest
                .processes
                .iter()
                .find(|process| process.id == process_id)
                .ok_or_else(|| "The widget process isn't declared.".to_string())?;
            runtime
                .processes
                .lock()
                .map_err(|_| "The widget process manager is busy. Can you try again?".to_string())?
                .start(
                    widget_id,
                    &runtime.widgets_root.join(widget_id),
                    declaration,
                    &arguments,
                )?;
            Ok(Value::Null)
        }
        "process.send" => {
            let process_id = required_string(&params, "processId")?;
            let value = params
                .get("message")
                .cloned()
                .ok_or_else(|| "The process message is missing.".to_string())?;
            let message = serde_json::to_string(&value)
                .map_err(|_| "The process message isn't valid JSON.".to_string())?;
            let mut processes = runtime.processes.lock().map_err(|_| {
                "The widget process manager is busy. Can you try again?".to_string()
            })?;
            processes.send(widget_id, process_id, &message)?;
            Ok(json!({ "events": processes.drain_events(widget_id) }))
        }
        "process.poll" => {
            let mut processes = runtime.processes.lock().map_err(|_| {
                "The widget process manager is busy. Can you try again?".to_string()
            })?;
            Ok(json!({ "events": processes.drain_events(widget_id) }))
        }
        "process.stop" => {
            let process_id = required_string(&params, "processId")?;
            runtime
                .processes
                .lock()
                .map_err(|_| "The widget process manager is busy. Can you try again?".to_string())?
                .stop(widget_id, process_id)?;
            Ok(Value::Null)
        }
        _ => Err("The widget method isn't supported.".into()),
    }
}

/// Joins each account at `place_id` when given, otherwise at its own place or the default place.
pub(crate) async fn join_account_ids(
    runtime: &Runtime,
    account_ids: &[u64],
    record_play: bool,
    place_id: Option<&str>,
) -> Result<(), String> {
    let settings = runtime.storage.load_settings().map_err(command_error)?;
    let default_place = crate::roblox::parse_place_id(&settings.place_id).ok();
    let accounts = runtime.storage.load_accounts().map_err(command_error)?;
    let mut delay = FIRST_LAUNCH_DELAY;
    for (index, id) in account_ids.iter().enumerate() {
        let Some(account) = accounts.iter().find(|account| account.id == *id) else {
            return Err("An account wasn't found. Can you refresh the widget?".into());
        };
        let place_id = match place_id.or(account.place_id.as_deref()) {
            Some(place_id) => crate::roblox::parse_place_id(place_id).map_err(command_error)?,
            None => default_place.clone().ok_or_else(|| {
                "No place is set to join. Can you set one on the Accounts screen?".to_string()
            })?,
        };
        let secret = runtime.credentials.get(*id).map_err(command_error)?;
        let mut attempt = 0;
        let uri = loop {
            match crate::roblox::build_join_uri(&runtime.client, &secret, &place_id).await {
                Ok(uri) => break uri,
                Err(error @ crate::roblox::RobloxError::InvalidPlace) => {
                    return Err(command_error(error));
                }
                Err(error) => {
                    attempt += 1;
                    if attempt > LAUNCH_RETRIES {
                        return Err(command_error(error));
                    }
                    delay = next_launch_delay(delay);
                    tokio::time::sleep(delay).await;
                }
            }
        };
        if settings.multi_instance {
            let mut cleared = runtime
                .cleared_roblox_pids
                .lock()
                .map_err(|_| "The multi-instance state is busy. Can you try again?".to_string())?;
            crate::multi_instance::clear_new_roblox_instances(
                runtime.multi_instance_helper.as_deref(),
                &mut cleared,
            )?;
        }
        opener::open(uri)
            .map_err(|_| "Roblox couldn't be opened. Is Roblox installed?".to_string())?;
        if record_play {
            runtime
                .storage
                .update_accounts(|accounts| {
                    let account = accounts
                        .iter_mut()
                        .find(|account| account.id == *id)
                        .ok_or_else(|| {
                            StorageError::Invalid(
                                "The launched account wasn't found. Can you refresh the list?"
                                    .into(),
                            )
                        })?;
                    account
                        .record_play(now_seconds(), &place_id)
                        .map_err(StorageError::Invalid)
                })
                .map_err(command_error)?;
        }
        if index + 1 < account_ids.len() {
            tokio::time::sleep(delay).await;
        }
    }
    Ok(())
}

/// Gap between launches in a batch.
const FIRST_LAUNCH_DELAY: std::time::Duration = std::time::Duration::from_secs(1);
/// Longest gap between launches after failures.
const MAX_LAUNCH_DELAY: std::time::Duration = std::time::Duration::from_secs(5);
/// Ticket requests retried per account before the join fails.
const LAUNCH_RETRIES: u32 = 3;

/// Doubles the gap between launches after a failure, up to five seconds. The longer gap then
/// applies to the rest of the batch.
fn next_launch_delay(current: std::time::Duration) -> std::time::Duration {
    (current * 2).min(MAX_LAUNCH_DELAY)
}

/// Fetches an HTTPS URL for a widget and returns the status and a text body of up to 1 MB.
async fn widget_network_fetch(
    runtime: &Runtime,
    widget_id: &str,
    params: &Value,
) -> Result<Value, String> {
    let url = required_string(params, "url")?;
    let parsed = url::Url::parse(url).map_err(|_| "The widget URL isn't valid.".to_string())?;
    if parsed.scheme() != "https" || parsed.username() != "" || parsed.password().is_some() {
        return Err("Widgets can only fetch HTTPS URLs without embedded credentials.".into());
    }
    find_installed_widget(runtime, widget_id)?;
    let response =
        runtime.client.get(parsed).send().await.map_err(|_| {
            "The widget network request failed. Is the connection working?".to_string()
        })?;
    let status = response.status().as_u16();
    let bytes = read_response_limited(
        response,
        1024 * 1024,
        "The widget network response is larger than 1 MB.",
        "The widget network response couldn't be read.",
    )
    .await?;
    let body = String::from_utf8(bytes)
        .map_err(|_| "The widget network response isn't UTF-8 text.".to_string())?;
    Ok(json!({ "status": status, "body": body }))
}

/// Reads a required non-negative integer parameter.
fn required_u64(params: &Value, field: &str) -> Result<u64, String> {
    params
        .get(field)
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("The widget parameter {field} isn't a positive integer."))
}

/// Reads a required non-empty string parameter.
fn required_string<'a>(params: &'a Value, field: &str) -> Result<&'a str, String> {
    params
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("The widget parameter {field} isn't a non-empty string."))
}

/// Reads a required non-empty array of account IDs.
fn required_u64_array(params: &Value, field: &str) -> Result<Vec<u64>, String> {
    let values = params
        .get(field)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("The widget parameter {field} isn't an array."))?;
    let result: Option<Vec<_>> = values.iter().map(Value::as_u64).collect();
    result
        .filter(|values| !values.is_empty())
        .ok_or_else(|| format!("The widget parameter {field} must contain account IDs."))
}

/// Reads an optional array of strings, defaulting to empty.
fn optional_string_array(params: &Value, field: &str) -> Result<Vec<String>, String> {
    let Some(values) = params.get(field) else {
        return Ok(Vec::new());
    };
    let values = values
        .as_array()
        .ok_or_else(|| format!("The widget parameter {field} isn't an array."))?;
    values
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| format!("The widget parameter {field} contains a non-string value."))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_delay_backs_off_from_one_to_five_seconds() {
        let delays: Vec<_> = std::iter::successors(Some(FIRST_LAUNCH_DELAY), |delay| {
            Some(next_launch_delay(*delay))
        })
        .take(5)
        .map(|delay| delay.as_secs())
        .collect();
        assert_eq!(delays, [1, 2, 4, 5, 5]);
    }
}
