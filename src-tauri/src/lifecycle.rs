//! Window, tray, single-instance, and autostart lifecycle helpers.

use std::fmt;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, WebviewWindow};

pub const MAIN_WINDOW_LABEL: &str = "main";
pub const TRAY_ID: &str = "toolblox-tray";
const TRAY_OPEN_ID: &str = "toolblox-open";
const TRAY_QUIT_ID: &str = "toolblox-quit";
const TRAY_SAFE_MODE_ID: &str = "toolblox-safe-mode";

#[derive(Default)]
pub struct LifecycleState {
    quit_requested: AtomicBool,
    pending_activation: AtomicBool,
}

impl LifecycleState {
    pub fn mark_quit_requested(&self) {
        self.quit_requested.store(true, Ordering::SeqCst);
    }

    pub fn quit_requested(&self) -> bool {
        self.quit_requested.load(Ordering::SeqCst)
    }

    pub fn take_pending_activation(&self) -> bool {
        self.pending_activation.swap(false, Ordering::SeqCst)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CloseDecision {
    HideToTray,
    Exit,
}

pub fn decide_close(
    run_in_background: bool,
    tray_ready: bool,
    quit_requested: bool,
) -> CloseDecision {
    if run_in_background && tray_ready && !quit_requested {
        CloseDecision::HideToTray
    } else {
        CloseDecision::Exit
    }
}

pub fn handle_close_request(
    window: &WebviewWindow,
    api: &tauri::CloseRequestApi,
    state: &LifecycleState,
    run_in_background: bool,
) -> Result<CloseDecision, LifecycleError> {
    let tray_ready = window.app_handle().tray_by_id(TRAY_ID).is_some();
    let decision = decide_close(run_in_background, tray_ready, state.quit_requested());
    if decision == CloseDecision::Exit {
        return Ok(decision);
    }

    api.prevent_close();
    if window.set_skip_taskbar(true).is_err() || window.hide().is_err() {
        let _ = window.set_skip_taskbar(false);
        let _ = window.show();
        return Err(LifecycleError::Hide);
    }
    Ok(decision)
}

pub fn restore_main_window(app: &tauri::AppHandle) -> Result<(), LifecycleError> {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return Err(LifecycleError::MissingMainWindow);
    };
    window
        .set_skip_taskbar(false)
        .map_err(|_| LifecycleError::Restore)?;
    window.unminimize().map_err(|_| LifecycleError::Restore)?;
    window.show().map_err(|_| LifecycleError::Restore)?;
    window.set_focus().map_err(|_| LifecycleError::Restore)?;
    Ok(())
}

pub fn activate_or_defer(app: &tauri::AppHandle, state: &LifecycleState) {
    if restore_main_window(app).is_err() {
        state.pending_activation.store(true, Ordering::SeqCst);
    }
}

pub fn apply_pending_activation(
    app: &tauri::AppHandle,
    state: &LifecycleState,
) -> Result<(), LifecycleError> {
    if state.take_pending_activation() {
        restore_main_window(app)?;
    }
    Ok(())
}

pub fn install_tray(
    app: &tauri::AppHandle,
    state: Arc<LifecycleState>,
    before_quit: Arc<dyn Fn() + Send + Sync>,
    request_safe_mode: Arc<dyn Fn() + Send + Sync>,
) -> Result<(), LifecycleError> {
    if app.tray_by_id(TRAY_ID).is_some() {
        return Ok(());
    }

    let open = MenuItem::with_id(app, TRAY_OPEN_ID, "Open Toolblox", true, None::<&str>)
        .map_err(|_| LifecycleError::Tray)?;
    let safe_mode = MenuItem::with_id(
        app,
        TRAY_SAFE_MODE_ID,
        "Restart without widgets",
        true,
        None::<&str>,
    )
    .map_err(|_| LifecycleError::Tray)?;
    let quit = MenuItem::with_id(app, TRAY_QUIT_ID, "Quit", true, None::<&str>)
        .map_err(|_| LifecycleError::Tray)?;
    let menu =
        Menu::with_items(app, &[&open, &safe_mode, &quit]).map_err(|_| LifecycleError::Tray)?;

    let quit_state = state.clone();
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Toolblox")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            TRAY_OPEN_ID => {
                activate_or_defer(app, &quit_state);
            }
            TRAY_SAFE_MODE_ID => {
                request_safe_mode();
                app.restart();
            }
            TRAY_QUIT_ID => {
                quit_state.mark_quit_requested();
                before_quit();
                app.exit(0);
            }
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app).map_err(|_| LifecycleError::Tray)?;
    Ok(())
}

#[cfg(test)]
pub trait AutostartBackend {
    fn is_enabled(&self) -> Result<bool, String>;
    fn enable(&self) -> Result<(), String>;
    fn disable(&self) -> Result<(), String>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[cfg(test)]
pub enum AutostartChange {
    None,
    Enabled,
    Disabled,
}

#[cfg(test)]
pub fn reconcile_autostart(
    desired: bool,
    backend: &impl AutostartBackend,
) -> Result<AutostartChange, LifecycleError> {
    let current = backend
        .is_enabled()
        .map_err(|_| LifecycleError::Autostart)?;
    match (current, desired) {
        (false, true) => {
            backend.enable().map_err(|_| LifecycleError::Autostart)?;
            Ok(AutostartChange::Enabled)
        }
        (true, false) => {
            backend.disable().map_err(|_| LifecycleError::Autostart)?;
            Ok(AutostartChange::Disabled)
        }
        _ => Ok(AutostartChange::None),
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LifecycleError {
    Tray,
    Hide,
    Restore,
    MissingMainWindow,
    #[cfg(test)]
    Autostart,
}

impl fmt::Display for LifecycleError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Tray => "The tray icon couldn't open. Would turning off background mode help?",
            Self::Hide => "Toolblox couldn't hide safely. Would closing it again help?",
            Self::Restore => "Toolblox couldn't restore its window. Would reopening it help?",
            Self::MissingMainWindow => {
                "The Toolblox window isn't ready yet. Would waiting for startup help?"
            }
            #[cfg(test)]
            Self::Autostart => {
                "The startup setting couldn't be changed. Does this account allow startup apps?"
            }
        })
    }
}

impl std::error::Error for LifecycleError {}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::*;

    #[test]
    fn window_hides_only_when_a_tray_recovery_path_exists() {
        assert_eq!(decide_close(true, true, false), CloseDecision::HideToTray);
        assert_eq!(decide_close(true, false, false), CloseDecision::Exit);
        assert_eq!(decide_close(false, true, false), CloseDecision::Exit);
        assert_eq!(decide_close(true, true, true), CloseDecision::Exit);
    }

    struct FakeAutostart {
        enabled: Cell<bool>,
    }

    impl AutostartBackend for FakeAutostart {
        fn is_enabled(&self) -> Result<bool, String> {
            Ok(self.enabled.get())
        }

        fn enable(&self) -> Result<(), String> {
            self.enabled.set(true);
            Ok(())
        }

        fn disable(&self) -> Result<(), String> {
            self.enabled.set(false);
            Ok(())
        }
    }

    #[test]
    fn autostart_changes_only_when_needed() {
        let backend = FakeAutostart {
            enabled: Cell::new(false),
        };
        assert_eq!(
            reconcile_autostart(true, &backend).unwrap(),
            AutostartChange::Enabled
        );
        assert_eq!(
            reconcile_autostart(true, &backend).unwrap(),
            AutostartChange::None
        );
        assert_eq!(
            reconcile_autostart(false, &backend).unwrap(),
            AutostartChange::Disabled
        );
    }

    #[test]
    fn deferred_activation_is_consumed_once() {
        let state = LifecycleState::default();
        state.pending_activation.store(true, Ordering::SeqCst);
        assert!(state.take_pending_activation());
        assert!(!state.take_pending_activation());
    }
}
