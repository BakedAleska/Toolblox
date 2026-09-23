//! Validated, atomic JSON persistence serialized by one application state.

use std::collections::HashSet;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::models::{Settings, StoredAccount};

static TEMP_SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[derive(Debug)]
pub enum StorageError {
    Io(io::Error),
    Invalid(String),
    Json(serde_json::Error),
    Locked,
}

impl fmt::Display for StorageError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(_) => write!(
                formatter,
                "Toolblox couldn't access its local data. Is the data folder available?"
            ),
            Self::Invalid(message) => formatter.write_str(message),
            Self::Json(_) => write!(
                formatter,
                "Toolblox couldn't read its local data. Is the file intact?"
            ),
            Self::Locked => write!(
                formatter,
                "Toolblox couldn't lock its local data. Can you restart the app?"
            ),
        }
    }
}

impl std::error::Error for StorageError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Json(error) => Some(error),
            Self::Invalid(_) | Self::Locked => None,
        }
    }
}

impl From<io::Error> for StorageError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<serde_json::Error> for StorageError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

pub struct Storage {
    root: PathBuf,
    gate: Mutex<()>,
}

impl Storage {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            gate: Mutex::new(()),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn load_settings(&self) -> Result<Settings, StorageError> {
        let _guard = self.gate.lock().map_err(|_| StorageError::Locked)?;
        self.load_settings_unlocked()
    }

    pub fn save_settings(&self, settings: &Settings) -> Result<(), StorageError> {
        let _guard = self.gate.lock().map_err(|_| StorageError::Locked)?;
        settings.validate().map_err(StorageError::Invalid)?;
        write_json_atomic(&self.root.join("settings.json"), settings)
    }

    pub fn update_settings<T>(
        &self,
        update: impl FnOnce(&mut Settings) -> Result<T, StorageError>,
    ) -> Result<T, StorageError> {
        let _guard = self.gate.lock().map_err(|_| StorageError::Locked)?;
        let mut settings = self.load_settings_unlocked()?;
        let result = update(&mut settings)?;
        settings.validate().map_err(StorageError::Invalid)?;
        write_json_atomic(&self.root.join("settings.json"), &settings)?;
        Ok(result)
    }

    pub fn load_accounts(&self) -> Result<Vec<StoredAccount>, StorageError> {
        let _guard = self.gate.lock().map_err(|_| StorageError::Locked)?;
        self.load_accounts_unlocked()
    }

    pub fn save_accounts(&self, accounts: &[StoredAccount]) -> Result<(), StorageError> {
        let _guard = self.gate.lock().map_err(|_| StorageError::Locked)?;
        validate_accounts(accounts)?;
        write_json_atomic(&self.root.join("accounts.json"), accounts)
    }

    pub fn update_accounts<T>(
        &self,
        update: impl FnOnce(&mut Vec<StoredAccount>) -> Result<T, StorageError>,
    ) -> Result<T, StorageError> {
        let _guard = self.gate.lock().map_err(|_| StorageError::Locked)?;
        let mut accounts = self.load_accounts_unlocked()?;
        let result = update(&mut accounts)?;
        validate_accounts(&accounts)?;
        write_json_atomic(&self.root.join("accounts.json"), &accounts)?;
        Ok(result)
    }

    fn load_settings_unlocked(&self) -> Result<Settings, StorageError> {
        let path = self.root.join("settings.json");
        if !path.exists() {
            return Ok(Settings::default());
        }
        let settings: Settings = read_json(&path)?;
        settings.validate().map_err(StorageError::Invalid)?;
        Ok(settings)
    }

    fn load_accounts_unlocked(&self) -> Result<Vec<StoredAccount>, StorageError> {
        let path = self.root.join("accounts.json");
        if !path.exists() {
            return Ok(Vec::new());
        }
        let accounts: Vec<StoredAccount> = read_json(&path)?;
        validate_accounts(&accounts)?;
        Ok(accounts)
    }
}

fn validate_accounts(accounts: &[StoredAccount]) -> Result<(), StorageError> {
    let mut ids = HashSet::with_capacity(accounts.len());
    for account in accounts {
        account.validate().map_err(StorageError::Invalid)?;
        if !ids.insert(account.id) {
            return Err(StorageError::Invalid(
                "The account list contains a duplicate. Can you remove and add it again?".into(),
            ));
        }
    }
    Ok(())
}

fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T, StorageError> {
    Ok(serde_json::from_reader(File::open(path)?)?)
}

fn write_json_atomic(path: &Path, value: &(impl Serialize + ?Sized)) -> Result<(), StorageError> {
    let parent = path.parent().ok_or_else(|| {
        StorageError::Invalid("The local data path isn't valid. Can you restart the app?".into())
    })?;
    fs::create_dir_all(parent)?;
    let sequence = TEMP_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let temp = parent.join(format!(
        ".{}.{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("data"),
        std::process::id(),
        sequence
    ));

    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;

            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        serde_json::to_writer_pretty(&mut file, value)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        replace_file(&temp, path)?;
        sync_directory(parent)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

#[cfg(windows)]
pub(crate) fn replace_file(from: &Path, to: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };

    let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    let moved = unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
pub(crate) fn replace_file(from: &Path, to: &Path) -> io::Result<()> {
    fs::rename(from, to)
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> io::Result<()> {
    File::open(path)?.sync_all()
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::thread;

    use serde_json::Map;

    use super::*;

    fn test_root(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "toolblox-{name}-{}-{}",
            std::process::id(),
            TEMP_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ))
    }

    fn account() -> StoredAccount {
        StoredAccount {
            id: 1,
            name: "builderman".into(),
            display_name: "Builderman".into(),
            avatar_url: None,
            notes: String::new(),
            added_at: 1.0,
            last_played_at: None,
            play_count: 0,
            widget_data: Default::default(),
            place_id: None,
            last_place_id: None,
            extra: Map::new(),
        }
    }

    #[test]
    fn settings_round_trip_preserves_unknown_fields() {
        let root = test_root("settings");
        let store = Storage::new(root.clone());
        let mut settings = Settings::default();
        settings.extra.insert("future_setting".into(), true.into());
        store.save_settings(&settings).unwrap();
        assert_eq!(store.load_settings().unwrap(), settings);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn updates_are_serialized_without_lost_writes() {
        let root = test_root("serialized");
        let store = Arc::new(Storage::new(root.clone()));
        store.save_accounts(&[account()]).unwrap();
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let store = Arc::clone(&store);
                thread::spawn(move || {
                    store
                        .update_accounts(|accounts| {
                            accounts[0].play_count += 1;
                            Ok(())
                        })
                        .unwrap();
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        assert_eq!(store.load_accounts().unwrap()[0].play_count, 8);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_data_is_rejected_before_replacing_the_file() {
        let root = test_root("validation");
        let store = Storage::new(root.clone());
        store.save_accounts(&[account()]).unwrap();
        let mut invalid = account();
        invalid.name.clear();
        assert!(store.save_accounts(&[invalid]).is_err());
        assert_eq!(store.load_accounts().unwrap()[0].name, "builderman");
        fs::remove_dir_all(root).unwrap();
    }
}
