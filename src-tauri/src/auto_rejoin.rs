//! Conservative presence monitor for opt-in auto-rejoin and drop notifications.

use std::collections::HashMap;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::app_commands::Runtime;
use crate::credentials::CredentialStore;
use crate::models::PresenceState;

/// Time between presence checks.
const POLL_INTERVAL: Duration = Duration::from_secs(10);
/// Time between presence checks while an account is in its launch window.
const LAUNCH_POLL_INTERVAL: Duration = Duration::from_secs(3);
/// How long after a join or rejoin presence is checked more often.
const LAUNCH_WINDOW: Duration = Duration::from_secs(60);
/// A drop within this time of an automatic rejoin pauses auto-rejoin for the account.
const REJOIN_GRACE: Duration = Duration::from_secs(45);

/// Presence history for one account between checks.
#[derive(Default)]
struct Entry {
    /// Whether the previous check saw the account in game.
    was_in_game: bool,
    last_rejoin: Option<Instant>,
    /// Whether auto-rejoin is paused until the account is joined manually.
    suspended: bool,
    last_played_at: Option<f64>,
}

/// Polls presence for drop notifications and auto-rejoin until the app exits.
///
/// Does nothing while both settings are off. A manual join clears a paused account.
pub async fn run(app: AppHandle) {
    let mut entries: HashMap<u64, Entry> = HashMap::new();
    let mut interval = POLL_INTERVAL;
    let mut presence_failing = false;
    loop {
        tokio::time::sleep(interval).await;
        interval = POLL_INTERVAL;
        let runtime = app.state::<Runtime>();
        let Ok(settings) = runtime.storage.load_settings() else {
            continue;
        };
        if !settings.auto_rejoin && !settings.notify_on_drop {
            entries.clear();
            continue;
        }
        let Ok(accounts) = runtime.storage.load_accounts() else {
            continue;
        };
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0.0, |elapsed| elapsed.as_secs_f64());
        let launched = accounts
            .iter()
            .any(|account| launched_recently(now, account.last_played_at))
            || entries.values().any(|entry| {
                entry
                    .last_rejoin
                    .is_some_and(|last| last.elapsed() < LAUNCH_WINDOW)
            });
        if launched {
            interval = LAUNCH_POLL_INTERVAL;
        }
        let ids: Vec<_> = accounts.iter().map(|account| account.id).collect();
        let mut states = None;
        let mut failure = None;
        for account in &accounts {
            let Ok(secret) = runtime.credentials.get(account.id) else {
                continue;
            };
            match crate::roblox::fetch_presence(&runtime.client, &secret, &ids).await {
                Ok(found) => {
                    states = Some(found);
                    break;
                }
                Err(error @ crate::roblox::RobloxError::Rejected(_)) => {
                    failure = Some(error.to_string());
                }
                Err(error) => {
                    failure = Some(error.to_string());
                    break;
                }
            }
        }
        let Some(states) = states else {
            if !presence_failing && !accounts.is_empty() {
                log::warn!(
                    "Presence checks for auto-rejoin are failing: {}",
                    failure
                        .as_deref()
                        .unwrap_or("no account has a readable session")
                );
            }
            presence_failing = true;
            continue;
        };
        if presence_failing {
            log::info!("Presence checks for auto-rejoin recovered");
            presence_failing = false;
        }
        entries.retain(|id, _| states.contains_key(id));
        for (id, presence) in states {
            let entry = entries.entry(id).or_default();
            let last_played_at = accounts
                .iter()
                .find(|account| account.id == id)
                .and_then(|account| account.last_played_at);
            if entry.last_played_at.is_some() && entry.last_played_at != last_played_at {
                entry.suspended = false;
                entry.last_rejoin = None;
            }
            entry.last_played_at = last_played_at;
            match presence {
                PresenceState::InGame | PresenceState::InStudio => entry.was_in_game = true,
                PresenceState::Offline | PresenceState::Online if entry.was_in_game => {
                    entry.was_in_game = false;
                    let name = accounts
                        .iter()
                        .find(|account| account.id == id)
                        .map(|account| account.display_name.clone())
                        .unwrap_or_default();
                    let notify = |title: String, body: &str| {
                        if settings.notify_on_drop {
                            let _ = app.notification().builder().title(title).body(body).show();
                        }
                    };
                    log::info!("Account {id} left its game");
                    if !settings.auto_rejoin {
                        notify(format!("{name} disconnected"), "Open Toolblox to rejoin.");
                        continue;
                    }
                    if entry.suspended {
                        continue;
                    }
                    if entry
                        .last_rejoin
                        .is_some_and(|last| last.elapsed() < REJOIN_GRACE)
                    {
                        entry.suspended = true;
                        log::warn!(
                            "Auto-rejoin paused for account {id}: it left again within {} seconds",
                            REJOIN_GRACE.as_secs()
                        );
                        notify(
                            format!("Auto-rejoin paused for {name}"),
                            "It disconnected again shortly after rejoining. Join manually to resume.",
                        );
                        continue;
                    }
                    notify(format!("{name} disconnected"), "Rejoining automatically.");
                    match crate::app_commands::join_account_ids(&runtime, &[id], false, None).await
                    {
                        Ok(()) => {
                            log::info!("Auto-rejoined account {id}");
                            entry.last_rejoin = Some(Instant::now());
                        }
                        Err(error) => log::warn!("Auto-rejoin for account {id} failed: {error}"),
                    }
                }
                PresenceState::Offline | PresenceState::Online | PresenceState::Unknown => {}
            }
        }
    }
}

/// Reports whether an account was joined within the launch window, when drops are most likely.
fn launched_recently(now: f64, last_played_at: Option<f64>) -> bool {
    last_played_at
        .is_some_and(|played| (0.0..LAUNCH_WINDOW.as_secs_f64()).contains(&(now - played)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn polls_faster_only_in_the_first_minute() {
        assert!(launched_recently(100.0, Some(100.0)));
        assert!(launched_recently(100.0, Some(41.0)));
        assert!(!launched_recently(100.0, Some(40.0)));
        assert!(!launched_recently(100.0, Some(200.0)));
        assert!(!launched_recently(100.0, None));
    }
}
