//! Toolblox native host.
//!
//! Toolblox is a Tauri 2 desktop app for managing and launching Roblox accounts. This crate owns
//! everything that touches secrets, the network, the file system, or other processes. The React
//! interface receives display data and opaque IDs only.
//!
//! # Modules
//!
//! - [`app_commands`]: the Tauri commands the interface calls, and the shared [`Runtime`].
//! - [`startup`] and [`update`]: the fail-closed update gate that runs before the app opens.
//! - [`storage`] and [`models`]: validated, atomic JSON persistence for settings and accounts.
//! - [`credentials`]: Roblox sessions in Windows Credential Manager or the macOS Keychain.
//! - [`login`]: the isolated Roblox sign-in window.
//! - [`roblox`]: Roblox web APIs for profiles, presence, games, and join tickets.
//! - [`auto_rejoin`]: presence monitoring for drop notifications and auto-rejoin.
//! - [`multi_instance`]: running several Roblox clients on Windows and macOS.
//! - [`lifecycle`]: window, tray, and single-instance behavior.
//! - [`logs`]: the rotating, redacted log file.
//! - [`widgets`], [`widget_protocol`], [`widget_ipc`], and [`widget_process`]: signed widget
//!   packages, their assets, permission-checked messages, and sidecar processes.
//!
//! # Data
//!
//! Data lives in the Toolblox data folder: `%LOCALAPPDATA%\Toolblox` on Windows and
//! `~/Library/Application Support/Toolblox` on macOS.

#![allow(rustdoc::private_intra_doc_links)]

mod app_commands;
mod auto_rejoin;
mod credentials;
mod lifecycle;
mod login;
mod logs;
mod models;
mod multi_instance;
mod roblox;
mod startup;
mod storage;
mod update;
mod widget_ipc;
mod widget_process;
mod widget_protocol;
mod widgets;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use app_commands::Runtime;
use lifecycle::LifecycleState;
use tauri::Manager;

/// Returns the Toolblox data folder.
///
/// This is `%LOCALAPPDATA%\Toolblox` on Windows and `~/Library/Application Support/Toolblox` on
/// macOS. Debug builds use `TOOLBLOX_DATA_DIR` instead when it's set.
fn toolblox_data_root() -> Result<PathBuf, std::io::Error> {
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os("TOOLBLOX_DATA_DIR") {
        return Ok(PathBuf::from(path));
    }
    #[cfg(windows)]
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("USERPROFILE").map(|home| PathBuf::from(home).join("AppData/Local"))
        });
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME")
        .map(|home| PathBuf::from(home).join("Library/Application Support"));
    #[cfg(not(any(windows, target_os = "macos")))]
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")));
    base.map(|path| path.join("Toolblox")).ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "Toolblox couldn't locate its data folder. Is the user profile available?",
        )
    })
}

/// Moves data that 0.2.0 beta saved in a `v2` subfolder into the data folder.
///
/// Moved entries replace same-named ones already in the data folder. An interrupted move
/// continues on the next launch, and nothing happens once the subfolder is gone.
fn move_beta_data(data_root: &std::path::Path) -> std::io::Result<()> {
    let beta_root = data_root.join("v2");
    let entries = match std::fs::read_dir(&beta_root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    for entry in entries {
        let entry = entry?;
        let target = data_root.join(entry.file_name());
        match std::fs::symlink_metadata(&target) {
            Ok(metadata) if metadata.is_dir() => std::fs::remove_dir_all(&target)?,
            Ok(_) => std::fs::remove_file(&target)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        std::fs::rename(entry.path(), target)?;
    }
    std::fs::remove_dir(beta_root)
}

/// Name of the marker file that requests safe mode for the next launch.
const SAFE_MODE_MARKER: &str = "safe-mode-next-launch";

/// Records whether the next launch skips widgets. Failures only lose the one-time request.
pub fn set_safe_mode_marker(data_root: &std::path::Path, enabled: bool) {
    let marker = data_root.join(SAFE_MODE_MARKER);
    let _ = if enabled {
        std::fs::create_dir_all(data_root).and_then(|_| std::fs::write(marker, b""))
    } else {
        std::fs::remove_file(marker)
    };
}

/// Safe mode applies for this launch when requested with `--safe-mode` or by the marker, which is
/// consumed so the following launch loads widgets again.
fn take_safe_mode(data_root: &std::path::Path) -> bool {
    let marker = std::fs::remove_file(data_root.join(SAFE_MODE_MARKER)).is_ok();
    marker || std::env::args().any(|argument| argument == "--safe-mode")
}

/// Starts the processes of widgets marked to start on launch, unless safe mode is active.
fn start_widgets_on_launch(runtime: &Runtime) {
    if runtime.safe_mode {
        return;
    }
    let Ok(settings) = runtime.storage.load_settings() else {
        return;
    };
    let Ok(mut processes) = runtime.processes.lock() else {
        return;
    };
    for widget in widgets::discover_installed(&runtime.widgets_root)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|widget| {
            settings.widgets_start_on_launch.contains(&widget.id)
                && !settings.disabled_widgets.contains(&widget.id)
        })
    {
        let root = runtime.widgets_root.join(&widget.id);
        for declaration in &widget.manifest.processes {
            if let Err(error) = processes.start(&widget.id, &root, declaration, &[]) {
                log::warn!(
                    "Widget {} process {} didn't start on launch: {error}",
                    widget.id,
                    declaration.id
                );
            }
        }
    }
}

/// Builds and runs the Tauri application.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let lifecycle_state = Arc::new(LifecycleState::default());
    let single_instance_state = Arc::clone(&lifecycle_state);
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(move |app, _, _| {
            lifecycle::activate_or_defer(app, &single_instance_state);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .register_uri_scheme_protocol("widget", widget_protocol::response)
        .setup(move |app| {
            app.handle().plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                None,
            ))?;

            let data_root = toolblox_data_root()?;
            let moved = move_beta_data(&data_root);
            let widgets_root = data_root.join("widgets");
            let safe_mode = take_safe_mode(&data_root);
            let _ = logs::init(&data_root.join("logs"));
            log::info!(
                "Toolblox {} ({}) starting on {} {}{}",
                env!("CARGO_PKG_VERSION"),
                if cfg!(debug_assertions) {
                    "debug"
                } else {
                    "release"
                },
                std::env::consts::OS,
                std::env::consts::ARCH,
                if safe_mode { " in safe mode" } else { "" }
            );
            if let Err(error) = moved {
                log::error!("Moving data from the 0.2.0 beta folder failed: {error}");
            }
            let storage = Arc::new(storage::Storage::new(data_root.clone()));
            let credentials = Arc::new(credentials::OsCredentialStore);
            let client = reqwest::Client::builder()
                .https_only(true)
                .redirect(reqwest::redirect::Policy::none())
                .timeout(std::time::Duration::from_secs(20))
                .user_agent(concat!("Toolblox/", env!("CARGO_PKG_VERSION")))
                .build()?;
            let processes = Arc::new(Mutex::new(widget_process::WidgetProcessManager::default()));
            let runtime = Runtime {
                storage,
                credentials,
                client,
                widgets_root,
                catalogue: Mutex::new(None),
                catalogue_error: Mutex::new(None),
                processes: Arc::clone(&processes),
                widget_sessions: Mutex::new(widget_ipc::WidgetSessions::default()),
                multi_instance_helper: Some(
                    app.path()
                        .resource_dir()?
                        .join("resources/multi-instance/multi_instance_helper.exe"),
                ),
                cleared_roblox_pids: Mutex::new(Default::default()),
                safe_mode,
            };
            app.manage(runtime);
            app.manage(Arc::clone(&lifecycle_state));
            app.manage(startup::StartupState::new());

            let before_quit = Arc::new(move || {
                if let Ok(mut processes) = processes.lock() {
                    processes.stop_all();
                }
            });
            let safe_mode_root = data_root.clone();
            lifecycle::install_tray(
                app.handle(),
                Arc::clone(&lifecycle_state),
                before_quit,
                Arc::new(move || set_safe_mode_marker(&safe_mode_root, true)),
            )?;

            if let Some(window) = app.get_webview_window(lifecycle::MAIN_WINDOW_LABEL) {
                let close_state = Arc::clone(&lifecycle_state);
                let close_window = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        let app = close_window.app_handle();
                        let startup_ready = matches!(
                            app.state::<startup::StartupState>().view(),
                            startup::StartupView::Ready
                        );
                        let run_in_background = startup_ready
                            && app
                                .state::<Runtime>()
                                .storage
                                .load_settings()
                                .map(|settings| settings.run_in_background)
                                .unwrap_or(false);
                        if matches!(
                            lifecycle::handle_close_request(
                                &close_window,
                                api,
                                &close_state,
                                run_in_background,
                            ),
                            Ok(lifecycle::CloseDecision::Exit)
                        ) {
                            app.exit(0);
                        }
                    }
                });
            }

            if let Some(window) = app.get_webview_window(lifecycle::MAIN_WINDOW_LABEL) {
                window.show()?;
                lifecycle::apply_pending_activation(app.handle(), &lifecycle_state)?;
            }
            tauri::async_runtime::spawn(startup::run(app.handle().clone()));
            let services_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                startup::wait_until_ready(&services_app).await;
                #[cfg(not(debug_assertions))]
                {
                    use tauri_plugin_autostart::ManagerExt;

                    let runtime = services_app.state::<Runtime>();
                    if let Ok(settings) = runtime.storage.load_settings() {
                        let autostart = services_app.autolaunch();
                        if autostart.is_enabled().ok() != Some(settings.open_on_launch) {
                            let _ = if settings.open_on_launch {
                                autostart.enable()
                            } else {
                                autostart.disable()
                            };
                        }
                    }
                }
                let always_on_top = services_app
                    .state::<Runtime>()
                    .storage
                    .load_settings()
                    .is_ok_and(|settings| settings.always_on_top);
                if always_on_top
                    && let Some(window) =
                        services_app.get_webview_window(lifecycle::MAIN_WINDOW_LABEL)
                {
                    let _ = window.set_always_on_top(true);
                }
                app_commands::backfill_profiles(&services_app.state::<Runtime>()).await;
                start_widgets_on_launch(&services_app.state::<Runtime>());
                auto_rejoin::run(services_app).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_commands::get_app_state,
            app_commands::begin_roblox_login,
            app_commands::update_account_notes,
            app_commands::set_account_place,
            app_commands::place_exists,
            app_commands::get_widget_store,
            app_commands::set_widget_store,
            app_commands::restart_app,
            app_commands::remove_account,
            app_commands::join_accounts,
            app_commands::reorder_accounts,
            app_commands::save_settings,
            app_commands::install_widget,
            app_commands::set_widget_enabled,
            app_commands::set_widget_start_on_launch,
            app_commands::update_widget,
            app_commands::uninstall_widget,
            app_commands::retry_catalogue,
            app_commands::check_for_updates,
            app_commands::open_widget,
            app_commands::close_widget_session,
            app_commands::widget_request,
            app_commands::read_log,
            app_commands::open_log_folder,
            app_commands::write_log,
            startup::startup_status,
            startup::retry_startup_update,
            startup::quit_startup,
        ])
        .build(tauri::generate_context!())
        .expect("Toolblox couldn't start")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if matches!(event, tauri::RunEvent::Reopen { .. }) {
                lifecycle::activate_or_defer(
                    app,
                    app.state::<Arc<LifecycleState>>().inner().as_ref(),
                );
            }
            if matches!(event, tauri::RunEvent::Exit) {
                if let Ok(mut processes) = app.state::<Runtime>().processes.lock() {
                    processes.stop_all();
                }
                log::info!("Toolblox exited");
                log::logger().flush();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Module widgets share the main webview, so its permissions and network policy are pinned.
    /// Widening them needs security review: no permission may create or script webviews, read
    /// cookies, or reach the network outside IPC.
    #[test]
    fn webview_permissions_match_the_reviewed_list() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        assert_eq!(
            capability["permissions"],
            serde_json::json!(["core:default", "opener:default"])
        );
        let capabilities = std::fs::read_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/capabilities"))
            .unwrap()
            .count();
        assert_eq!(capabilities, 1);

        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let security = &config["app"]["security"];
        assert_eq!(security["capabilities"], serde_json::json!(["default"]));
        let connect = security["csp"]
            .as_str()
            .unwrap()
            .split(';')
            .map(str::trim)
            .find(|directive| directive.starts_with("connect-src"));
        assert_eq!(connect, Some("connect-src ipc: http://ipc.localhost"));
    }

    #[test]
    fn beta_data_moves_up_and_replaces_older_entries() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path();
        std::fs::create_dir_all(data.join("v2/logs")).unwrap();
        std::fs::create_dir_all(data.join("logs")).unwrap();
        std::fs::write(data.join("v2/accounts.json"), "new").unwrap();
        std::fs::write(data.join("v2/logs/toolblox.log"), "new").unwrap();
        std::fs::write(data.join("accounts.json"), "old").unwrap();
        std::fs::write(data.join("logs/old.log"), "old").unwrap();
        std::fs::write(data.join("notes.txt"), "kept").unwrap();

        move_beta_data(data).unwrap();

        assert!(!data.join("v2").exists());
        assert_eq!(
            std::fs::read_to_string(data.join("accounts.json")).unwrap(),
            "new"
        );
        assert!(data.join("logs/toolblox.log").exists());
        assert!(!data.join("logs/old.log").exists());
        assert!(data.join("notes.txt").exists());
        move_beta_data(data).unwrap();
        assert_eq!(
            std::fs::read_to_string(data.join("accounts.json")).unwrap(),
            "new"
        );
    }

    #[test]
    fn safe_mode_marker_applies_to_one_launch() {
        let root = tempfile::tempdir().unwrap();
        set_safe_mode_marker(root.path(), true);
        assert!(take_safe_mode(root.path()));
        assert!(!take_safe_mode(root.path()));
        set_safe_mode_marker(root.path(), true);
        set_safe_mode_marker(root.path(), false);
        assert!(!take_safe_mode(root.path()));
    }
}
