//! One-way import of legacy Flet JSON and OS-protected sessions.

use std::collections::BTreeMap;
use std::fmt;
use std::fs::File;
use std::path::Path;

use serde::Deserialize;
use serde_json::{Map, Value};

#[cfg(windows)]
use crate::credentials::decrypt_legacy_dpapi;
#[cfg(target_os = "macos")]
use crate::credentials::lookup_legacy_keychain;
use crate::credentials::{CredentialError, CredentialStore, Secret};
use crate::models::{Settings, StoredAccount};
use crate::storage::{Storage, StorageError};

#[derive(Debug, Default, PartialEq, Eq)]
pub struct MigrationSummary {
    pub settings_imported: bool,
    pub accounts_imported: usize,
    pub sessions_imported: usize,
}

#[derive(Debug)]
pub enum MigrationError {
    Credentials(CredentialError),
    Json(serde_json::Error),
    Io(std::io::Error),
    Storage(StorageError),
}

impl fmt::Display for MigrationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Credentials(error) => error.fmt(formatter),
            Self::Storage(error) => error.fmt(formatter),
            Self::Json(_) => write!(
                formatter,
                "Toolblox couldn't read the old account data. Is the file intact?"
            ),
            Self::Io(_) => write!(
                formatter,
                "Toolblox couldn't access the old account data. Is the folder available?"
            ),
        }
    }
}

impl std::error::Error for MigrationError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Credentials(error) => Some(error),
            Self::Json(error) => Some(error),
            Self::Io(error) => Some(error),
            Self::Storage(error) => Some(error),
        }
    }
}

impl From<CredentialError> for MigrationError {
    fn from(error: CredentialError) -> Self {
        Self::Credentials(error)
    }
}

impl From<serde_json::Error> for MigrationError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

impl From<std::io::Error> for MigrationError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<StorageError> for MigrationError {
    fn from(error: StorageError) -> Self {
        Self::Storage(error)
    }
}

#[derive(Deserialize)]
struct LegacyAccount {
    id: u64,
    name: String,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    avatar_url: Option<String>,
    #[serde(default)]
    notes: String,
    added_at: f64,
    #[serde(default)]
    last_played_at: Option<f64>,
    #[serde(default)]
    play_count: u64,
    #[serde(default)]
    widget_data: BTreeMap<String, Value>,
    #[serde(default)]
    security_cookie: Option<String>,
    #[serde(flatten)]
    extra: Map<String, Value>,
}

pub fn migrate_legacy(
    legacy_root: &Path,
    storage: &Storage,
    credentials: &dyn CredentialStore,
) -> Result<MigrationSummary, MigrationError> {
    migrate_with(legacy_root, storage, credentials, resolve_legacy_secret)
}

fn migrate_with(
    legacy_root: &Path,
    storage: &Storage,
    credentials: &dyn CredentialStore,
    resolve_secret: impl Fn(u64, Option<&str>) -> Result<Option<Secret>, CredentialError>,
) -> Result<MigrationSummary, MigrationError> {
    let mut summary = MigrationSummary::default();
    let settings_path = legacy_root.join("settings.json");
    if settings_path.exists() {
        let settings: Settings = serde_json::from_reader(File::open(settings_path)?)?;
        storage.save_settings(&settings)?;
        summary.settings_imported = true;
    }

    let accounts_path = legacy_root.join("accounts.json");
    if !accounts_path.exists() {
        return Ok(summary);
    }
    let legacy: Vec<LegacyAccount> = serde_json::from_reader(File::open(accounts_path)?)?;
    let mut accounts = Vec::with_capacity(legacy.len());
    let mut sessions = Vec::new();
    for old in legacy {
        if let Some(secret) = resolve_secret(old.id, old.security_cookie.as_deref())? {
            sessions.push((old.id, secret));
        }
        let display_name = old
            .display_name
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| old.name.clone());
        accounts.push(StoredAccount {
            id: old.id,
            name: old.name,
            display_name,
            avatar_url: old.avatar_url,
            notes: old.notes,
            added_at: old.added_at,
            last_played_at: old.last_played_at,
            play_count: old.play_count,
            widget_data: old.widget_data,
            place_id: None,
            last_place_id: None,
            extra: old.extra,
        });
    }
    let mut stored_sessions = Vec::new();
    for (account_id, secret) in &sessions {
        let previous = credentials.get(*account_id).ok();
        if let Err(error) = credentials.set(*account_id, secret.expose()) {
            rollback_credentials(credentials, stored_sessions);
            return Err(error.into());
        }
        stored_sessions.push((*account_id, previous));
    }
    summary.sessions_imported = stored_sessions.len();
    summary.accounts_imported = accounts.len();
    if let Err(error) = storage.save_accounts(&accounts) {
        rollback_credentials(credentials, stored_sessions);
        return Err(error.into());
    }
    Ok(summary)
}

fn rollback_credentials(credentials: &dyn CredentialStore, stored: Vec<(u64, Option<Secret>)>) {
    for (account_id, previous) in stored.into_iter().rev() {
        if let Some(secret) = previous {
            let _ = credentials.set(account_id, secret.expose());
        } else {
            let _ = credentials.delete(account_id);
        }
    }
}

#[cfg(windows)]
fn resolve_legacy_secret(
    _account_id: u64,
    stored: Option<&str>,
) -> Result<Option<Secret>, CredentialError> {
    stored
        .filter(|value| !value.is_empty())
        .map(decrypt_legacy_dpapi)
        .transpose()
}

#[cfg(target_os = "macos")]
fn resolve_legacy_secret(
    account_id: u64,
    stored: Option<&str>,
) -> Result<Option<Secret>, CredentialError> {
    match lookup_legacy_keychain(account_id) {
        Ok(secret) => Ok(Some(secret)),
        Err(CredentialError::Missing) => Ok(stored
            .filter(|value| !value.is_empty())
            .map(|value| Secret::new(value.to_owned()))),
        Err(error) => Err(error),
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
fn resolve_legacy_secret(
    _account_id: u64,
    stored: Option<&str>,
) -> Result<Option<Secret>, CredentialError> {
    if stored.is_some_and(|value| !value.is_empty()) {
        Err(CredentialError::Unsupported)
    } else {
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    use crate::credentials::test_support::MemoryCredentialStore;

    use super::*;

    static SEQUENCE: AtomicU64 = AtomicU64::new(0);

    fn temp_root(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "toolblox-migration-{label}-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ))
    }

    #[test]
    fn migration_moves_the_secret_out_of_json_and_preserves_unknown_data() {
        let root = temp_root("legacy");
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("accounts.json"),
            r#"[{"id":1,"name":"builderman","added_at":1,"security_cookie":"cookie-value","future":true}]"#,
        )
        .unwrap();
        fs::write(root.join("settings.json"), r#"{"future_setting":true}"#).unwrap();
        let credentials = MemoryCredentialStore::default();
        let storage = Storage::new(root.clone());

        let summary = migrate_with(&root, &storage, &credentials, |_id, stored| {
            Ok(stored.map(|value| Secret::new(value.to_owned())))
        })
        .unwrap();

        assert_eq!(summary.accounts_imported, 1);
        assert_eq!(summary.sessions_imported, 1);
        assert_eq!(credentials.get(1).unwrap().expose(), "cookie-value");
        let json = fs::read_to_string(root.join("accounts.json")).unwrap();
        assert!(!json.contains("cookie-value"));
        assert!(!json.contains("security_cookie"));
        assert_eq!(storage.load_accounts().unwrap()[0].extra["future"], true);
        assert_eq!(
            storage.load_settings().unwrap().extra["future_setting"],
            true
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_migration_restores_an_existing_credential() {
        let root = temp_root("rollback");
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("accounts.json"),
            r#"[{"id":1,"name":"","added_at":1,"security_cookie":"new-cookie"}]"#,
        )
        .unwrap();
        let credentials = MemoryCredentialStore::default();
        credentials.set(1, "old-cookie").unwrap();
        let storage = Storage::new(root.clone());

        assert!(
            migrate_with(&root, &storage, &credentials, |_id, stored| {
                Ok(stored.map(|value| Secret::new(value.to_owned())))
            })
            .is_err()
        );
        assert_eq!(credentials.get(1).unwrap().expose(), "old-cookie");
        fs::remove_dir_all(root).unwrap();
    }
}
