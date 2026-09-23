//! Fail-closed release update gate shown before the main application state loads.

use std::fs;
#[cfg(not(debug_assertions))]
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(not(debug_assertions))]
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(not(debug_assertions))]
use base64::Engine;
#[cfg(not(debug_assertions))]
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
#[cfg(not(debug_assertions))]
use semver::Version;
use serde::Serialize;
#[cfg(not(debug_assertions))]
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
#[cfg(not(debug_assertions))]
use tauri_plugin_updater::UpdaterExt;

#[cfg(not(debug_assertions))]
use crate::app_commands::Runtime;
#[cfg(not(debug_assertions))]
use crate::update::{HighestSeenStore, ManifestSignatureVerifier, ReleaseDecision};

#[derive(Clone, Debug, Serialize)]
#[cfg_attr(debug_assertions, allow(dead_code))]
#[serde(tag = "phase", rename_all = "snake_case")]
pub enum StartupView {
    Checking,
    Installing { version: String },
    Ready,
    Failed { message: String },
}

pub struct StartupState {
    view: Mutex<StartupView>,
    in_progress: AtomicBool,
}

impl StartupState {
    pub fn new() -> Self {
        Self {
            view: Mutex::new(StartupView::Checking),
            in_progress: AtomicBool::new(false),
        }
    }

    fn set(&self, view: StartupView) {
        *self.view.lock().unwrap_or_else(|error| error.into_inner()) = view;
    }

    pub fn view(&self) -> StartupView {
        self.view
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }
}

pub async fn wait_until_ready(app: &AppHandle) {
    loop {
        if matches!(app.state::<StartupState>().view(), StartupView::Ready) {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
}

#[cfg(not(debug_assertions))]
struct Ed25519Verifier {
    public_key: VerifyingKey,
}

#[cfg(not(debug_assertions))]
impl Ed25519Verifier {
    fn new(encoded: &str) -> Result<Self, String> {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded.trim())
            .map_err(|_| "The update manifest public key isn't valid.".to_string())?;
        let bytes: [u8; 32] = bytes
            .try_into()
            .map_err(|_| "The update manifest public key has the wrong length.".to_string())?;
        Ok(Self {
            public_key: VerifyingKey::from_bytes(&bytes)
                .map_err(|_| "The update manifest public key isn't valid.".to_string())?,
        })
    }
}

#[cfg(not(debug_assertions))]
impl ManifestSignatureVerifier for Ed25519Verifier {
    fn verify(&self, manifest_bytes: &[u8], detached_signature: &[u8]) -> Result<(), String> {
        let encoded = std::str::from_utf8(detached_signature)
            .map_err(|_| "The update manifest signature isn't text.".to_string())?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded.trim())
            .map_err(|_| "The update manifest signature isn't valid base64.".to_string())?;
        let signature = Signature::from_slice(&bytes)
            .map_err(|_| "The update manifest signature has the wrong length.".to_string())?;
        self.public_key
            .verify(manifest_bytes, &signature)
            .map_err(|_| "The update manifest signature didn't match.".to_string())
    }
}

#[cfg(not(debug_assertions))]
struct FileHighestSeen(PathBuf);

#[cfg(not(debug_assertions))]
impl HighestSeenStore for FileHighestSeen {
    fn load(&self) -> Result<Option<Version>, String> {
        match fs::read_to_string(&self.0) {
            Ok(value) => Version::parse(value.trim()).map(Some).map_err(|_| {
                "The saved update security state isn't valid. Reinstall Toolblox to repair it?"
                    .into()
            }),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err(
                "The update security state couldn't be read. Is the data folder available?".into(),
            ),
        }
    }

    fn store(&self, version: &Version) -> Result<(), String> {
        let parent = self
            .0
            .parent()
            .ok_or_else(|| "The update security path isn't valid.".to_string())?;
        fs::create_dir_all(parent)
            .map_err(|_| "The update security state couldn't be saved.".to_string())?;
        let temporary = self.0.with_extension("tmp");
        fs::write(&temporary, format!("{version}\n"))
            .and_then(|_| crate::storage::replace_file(&temporary, &self.0))
            .map_err(|_| "The update security state couldn't be saved.".to_string())
    }
}

pub async fn run(app: AppHandle) {
    let state = app.state::<StartupState>();
    if state.in_progress.swap(true, Ordering::SeqCst) {
        return;
    }
    state.set(StartupView::Checking);
    let result = run_inner(&app).await;
    if let Err(message) = result {
        state.set(StartupView::Failed { message });
    }
    state.in_progress.store(false, Ordering::SeqCst);
}

async fn run_inner(app: &AppHandle) -> Result<(), String> {
    #[cfg(debug_assertions)]
    {
        prepare_local_data(&app.state::<crate::app_commands::Runtime>())?;
        app.state::<StartupState>().set(StartupView::Ready);
        Ok(())
    }

    #[cfg(not(debug_assertions))]
    {
        let endpoint = option_env!("TOOLBLOX_UPDATE_MANIFEST_URL")
            .filter(|value| value.starts_with("https://"))
            .ok_or_else(|| "This build doesn't have a secure update endpoint. Reinstall Toolblox from the official release?".to_string())?;
        let manifest_key = option_env!("TOOLBLOX_MANIFEST_PUBLIC_KEY")
            .ok_or_else(|| "This build doesn't have an update manifest key. Reinstall Toolblox from the official release?".to_string())?;
        let updater_key = option_env!("TOOLBLOX_UPDATER_PUBLIC_KEY")
            .ok_or_else(|| "This build doesn't have an updater key. Reinstall Toolblox from the official release?".to_string())?;
        let runtime = app.state::<Runtime>();
        let manifest_response = runtime.client.get(endpoint).send().await.map_err(|_| {
            "Toolblox couldn't check for updates. Is your connection working?".to_string()
        })?;
        if !manifest_response.status().is_success() {
            return Err(format!(
                "The update service returned status {}. Can you try again?",
                manifest_response.status().as_u16()
            ));
        }
        let manifest_bytes = crate::app_commands::read_response_limited(
            manifest_response,
            1024 * 1024,
            "The update information is larger than 1 MB.",
            "The update information couldn't be read. Can you try again?",
        )
        .await?;
        let signature_response = runtime
            .client
            .get(format!("{endpoint}.sig"))
            .send()
            .await
            .map_err(|_| {
                "The update signature couldn't be downloaded. Is your connection working?"
                    .to_string()
            })?;
        if !signature_response.status().is_success() {
            return Err("The update signature isn't available. Can you try again later?".into());
        }
        let signature_bytes = crate::app_commands::read_response_limited(
            signature_response,
            8 * 1024,
            "The update signature is too large.",
            "The update signature couldn't be read. Can you try again?",
        )
        .await?;
        let verified = crate::update::verify_and_parse(
            &manifest_bytes,
            &signature_bytes,
            &Ed25519Verifier::new(manifest_key)?,
        )
        .map_err(|error| error.to_string())?;
        let installed = Version::parse(env!("CARGO_PKG_VERSION"))
            .map_err(|_| "This Toolblox version isn't valid. Reinstall the app?".to_string())?;
        let target = tauri_plugin_updater::target().ok_or_else(|| {
            "Updates aren't supported on this platform. Use Windows or macOS?".to_string()
        })?;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "The system clock isn't valid. Can you correct it?".to_string())?
            .as_secs();
        let decision = crate::update::decide_and_record(
            &verified,
            &installed,
            "stable",
            &target,
            now,
            &FileHighestSeen(runtime.storage.root().join("highest-update-version")),
        )
        .map_err(|error| error.to_string())?;
        match decision {
            ReleaseDecision::Current { .. } => {
                prepare_local_data(&runtime)?;
                app.state::<StartupState>().set(StartupView::Ready);
                Ok(())
            }
            ReleaseDecision::UpdateRequired { version, artifact } => {
                app.state::<StartupState>().set(StartupView::Installing {
                    version: version.to_string(),
                });
                let endpoint = endpoint
                    .parse()
                    .map_err(|_| "The update endpoint isn't valid.".to_string())?;
                let update = app
                    .updater_builder()
                    .pubkey(updater_key)
                    .endpoints(vec![endpoint])
                    .map_err(|error| error.to_string())?
                    .build()
                    .map_err(|error| error.to_string())?
                    .check()
                    .await
                    .map_err(|error| error.to_string())?
                    .ok_or_else(|| {
                        "The verified update wasn't offered by the installer. Can you try again?"
                            .to_string()
                    })?;
                if update.version != version.to_string()
                    || update.download_url.as_str() != artifact.url
                    || update.signature != artifact.signature
                {
                    return Err("The update changed during verification. Can you try again?".into());
                }
                let bytes = update
                    .download(|_, _| {}, || {})
                    .await
                    .map_err(|error| error.to_string())?;
                let digest = hex::encode(Sha256::digest(&bytes));
                if !digest.eq_ignore_ascii_case(&artifact.sha256) {
                    return Err(
                        "The downloaded update checksum didn't match. Can you try again?".into(),
                    );
                }
                update.install(bytes).map_err(|error| error.to_string())?;
                app.restart();
            }
            #[cfg(debug_assertions)]
            ReleaseDecision::DebugBypass => Ok(()),
        }
    }
}

fn prepare_local_data(runtime: &crate::app_commands::Runtime) -> Result<(), String> {
    let data_root = runtime.storage.root();
    let migration_marker = data_root.join(".legacy-migration-complete");
    if !migration_marker.exists()
        && (runtime.legacy_root.join("accounts.json").exists()
            || runtime.legacy_root.join("settings.json").exists())
    {
        crate::migration::migrate_legacy(
            &runtime.legacy_root,
            &runtime.storage,
            runtime.credentials.as_ref(),
        )
        .map_err(|error| error.to_string())?;
        fs::create_dir_all(data_root)
            .map_err(|_| "Toolblox couldn't create its data folder. Is it writable?".to_string())?;
        fs::write(&migration_marker, b"1\n").map_err(|_| {
            "Toolblox couldn't finish account migration. Is the data folder writable?".to_string()
        })?;
    }
    fs::create_dir_all(&runtime.widgets_root)
        .map_err(|_| "Toolblox couldn't create the widget folder. Is it writable?".to_string())
}

#[tauri::command]
pub fn startup_status(state: tauri::State<'_, StartupState>) -> StartupView {
    state.view()
}

#[tauri::command]
pub async fn retry_startup_update(app: AppHandle) {
    run(app).await;
}

#[tauri::command]
pub fn quit_startup(app: AppHandle) {
    app.exit(0);
}
