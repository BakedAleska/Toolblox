//! Toolblox native host.

mod app_commands;
mod auto_rejoin;
mod credentials;
mod lifecycle;
mod login;
mod migration;
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
            let _ = processes.start(&widget.id, &root, declaration, &[]);
        }
    }
}

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

            let legacy_root = toolblox_data_root()?;
            let data_root = legacy_root.join("v2");
            let widgets_root = data_root.join("widgets");
            let safe_mode = take_safe_mode(&data_root);
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
                legacy_root,
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
            if matches!(event, tauri::RunEvent::Exit)
                && let Ok(mut processes) = app.state::<Runtime>().processes.lock()
            {
                processes.stop_all();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

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
