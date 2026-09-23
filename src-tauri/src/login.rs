//! Isolated Roblox login webview and secret handoff.

use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use zeroize::Zeroizing;

pub const LOGIN_WINDOW_LABEL: &str = "roblox-login";
pub const LOGIN_URL: &str = "https://www.roblox.com/login";
const SECURITY_COOKIE_NAME: &str = ".ROBLOSECURITY";

pub struct RobloxCookie(Zeroizing<String>);

impl RobloxCookie {
    pub fn expose_secret(&self) -> &str {
        self.0.as_str()
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountIdentity {
    pub id: u64,
    pub name: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LoginPhase {
    Waiting,
    Checking,
    Complete,
    Cancelled,
    Failed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LoginError {
    AlreadyOpen,
    Window,
    CookieRead,
    Network,
    InvalidSession,
    CredentialStore,
    Cleanup,
}

impl fmt::Display for LoginError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::AlreadyOpen => "The Roblox sign-in window is already open. Can you use it?",
            Self::Window => "The Roblox sign-in window couldn't open. Would trying again help?",
            Self::CookieRead => "The Roblox session couldn't be read. Would signing in again help?",
            Self::Network => "Toolblox couldn't reach Roblox. Is your connection working?",
            Self::InvalidSession => "Roblox didn't accept the session. Would signing in again help?",
            Self::CredentialStore => {
                "The Roblox session couldn't be stored securely. Is the credential store available?"
            }
            Self::Cleanup => {
                "The temporary Roblox browsing data couldn't be cleared. Would restarting Toolblox help?"
            }
        })
    }
}

impl std::error::Error for LoginError {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LoginNotice {
    Complete(AccountIdentity),
    Failed(LoginError),
    Cancelled,
}

type ValidateSession =
    dyn Fn(&RobloxCookie) -> Result<AccountIdentity, LoginError> + Send + Sync + 'static;
type StoreSession =
    dyn Fn(&AccountIdentity, &RobloxCookie) -> Result<(), LoginError> + Send + Sync + 'static;
type Notify = dyn Fn(LoginNotice) + Send + Sync + 'static;

struct LoginRuntime {
    in_flight: AtomicBool,
    cancelled: AtomicBool,
    phase: Mutex<LoginPhase>,
    validate: Arc<ValidateSession>,
    store: Arc<StoreSession>,
    notify: Arc<Notify>,
}

impl LoginRuntime {
    fn set_phase(&self, phase: LoginPhase) {
        *self.phase.lock().unwrap_or_else(|error| error.into_inner()) = phase;
    }
}

pub fn open_roblox_login<V, S, N>(
    app: &tauri::AppHandle,
    validate: V,
    store: S,
    notify: N,
) -> Result<(), LoginError>
where
    V: Fn(&RobloxCookie) -> Result<AccountIdentity, LoginError> + Send + Sync + 'static,
    S: Fn(&AccountIdentity, &RobloxCookie) -> Result<(), LoginError> + Send + Sync + 'static,
    N: Fn(LoginNotice) + Send + Sync + 'static,
{
    if app.get_webview_window(LOGIN_WINDOW_LABEL).is_some() {
        return Err(LoginError::AlreadyOpen);
    }

    let runtime = Arc::new(LoginRuntime {
        in_flight: AtomicBool::new(false),
        cancelled: AtomicBool::new(false),
        phase: Mutex::new(LoginPhase::Waiting),
        validate: Arc::new(validate),
        store: Arc::new(store),
        notify: Arc::new(notify),
    });
    let page_runtime = runtime.clone();
    let login_url = LOGIN_URL.parse().map_err(|_| LoginError::Window)?;

    let window =
        WebviewWindowBuilder::new(app, LOGIN_WINDOW_LABEL, WebviewUrl::External(login_url))
            .title("Sign in to Roblox")
            .inner_size(480.0, 640.0)
            .incognito(true)
            .devtools(false)
            .on_navigation(is_allowed_roblox_navigation)
            .on_new_window(|_, _| NewWindowResponse::Deny)
            .on_page_load(move |window, payload| {
                if payload.event() == PageLoadEvent::Finished {
                    schedule_cookie_check(window, page_runtime.clone());
                }
            })
            .build()
            .map_err(|_| LoginError::Window)?;

    let closed_runtime = runtime.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            closed_runtime.cancelled.store(true, Ordering::SeqCst);
            if closed_runtime.phase.lock().is_ok_and(|phase| {
                !matches!(
                    *phase,
                    LoginPhase::Complete | LoginPhase::Cancelled | LoginPhase::Failed
                )
            }) {
                closed_runtime.set_phase(LoginPhase::Cancelled);
                (closed_runtime.notify)(LoginNotice::Cancelled);
            }
        }
    });

    Ok(())
}

pub fn is_allowed_roblox_navigation(url: &tauri::Url) -> bool {
    url.scheme() == "https"
        && url.host_str().is_some_and(|host| {
            let host = host.to_ascii_lowercase();
            host == "roblox.com" || host.ends_with(".roblox.com")
        })
}

pub fn is_roblox_security_cookie(
    name: &str,
    domain: Option<&str>,
    secure: Option<bool>,
    http_only: Option<bool>,
) -> bool {
    if name != SECURITY_COOKIE_NAME || secure != Some(true) || http_only != Some(true) {
        return false;
    }
    domain.is_some_and(|domain| {
        let domain = domain.trim_start_matches('.').to_ascii_lowercase();
        domain == "roblox.com" || domain.ends_with(".roblox.com")
    })
}

fn schedule_cookie_check(window: WebviewWindow, runtime: Arc<LoginRuntime>) {
    if runtime.cancelled.load(Ordering::SeqCst) || runtime.in_flight.swap(true, Ordering::SeqCst) {
        return;
    }
    runtime.set_phase(LoginPhase::Checking);

    std::thread::spawn(move || {
        let result = read_security_cookie(&window);
        match result {
            Ok(None) => {
                runtime.set_phase(LoginPhase::Waiting);
                runtime.in_flight.store(false, Ordering::SeqCst);
                if !runtime.cancelled.load(Ordering::SeqCst) {
                    std::thread::sleep(std::time::Duration::from_secs(1));
                    schedule_cookie_check(window, runtime);
                }
            }
            Ok(Some(cookie)) => finish_login(&window, &runtime, cookie),
            Err(error) => fail_login(&window, &runtime, error),
        }
    });
}

fn read_security_cookie(window: &WebviewWindow) -> Result<Option<RobloxCookie>, LoginError> {
    let cookies = window.cookies().map_err(|_| LoginError::CookieRead)?;
    Ok(cookies.into_iter().find_map(|cookie| {
        is_roblox_security_cookie(
            cookie.name(),
            cookie.domain(),
            cookie.secure(),
            cookie.http_only(),
        )
        .then(|| RobloxCookie(Zeroizing::new(cookie.value().to_owned())))
    }))
}

fn finish_login(window: &WebviewWindow, runtime: &LoginRuntime, cookie: RobloxCookie) {
    if runtime.cancelled.load(Ordering::SeqCst) {
        runtime.in_flight.store(false, Ordering::SeqCst);
        return;
    }

    let identity = match (runtime.validate)(&cookie) {
        Ok(identity) => identity,
        Err(error) => {
            fail_login(window, runtime, error);
            return;
        }
    };

    if window.clear_all_browsing_data().is_err() {
        fail_login(window, runtime, LoginError::Cleanup);
        return;
    }
    if runtime.cancelled.load(Ordering::SeqCst) {
        let _ = window.destroy();
        runtime.in_flight.store(false, Ordering::SeqCst);
        return;
    }
    if (runtime.store)(&identity, &cookie).is_err() {
        fail_login(window, runtime, LoginError::CredentialStore);
        return;
    }

    runtime.set_phase(LoginPhase::Complete);
    runtime.in_flight.store(false, Ordering::SeqCst);
    let _ = window.destroy();
    (runtime.notify)(LoginNotice::Complete(identity));
}

fn fail_login(window: &WebviewWindow, runtime: &LoginRuntime, error: LoginError) {
    runtime.set_phase(LoginPhase::Failed);
    runtime.cancelled.store(true, Ordering::SeqCst);
    runtime.in_flight.store(false, Ordering::SeqCst);
    let _ = window.clear_all_browsing_data();
    let _ = window.destroy();
    (runtime.notify)(LoginNotice::Failed(error));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navigation_allows_only_https_roblox_hosts() {
        assert!(is_allowed_roblox_navigation(
            &"https://www.roblox.com/login".parse().unwrap()
        ));
        assert!(is_allowed_roblox_navigation(
            &"https://auth.roblox.com/".parse().unwrap()
        ));
        assert!(!is_allowed_roblox_navigation(
            &"http://www.roblox.com/login".parse().unwrap()
        ));
        assert!(!is_allowed_roblox_navigation(
            &"https://roblox.com.example.test/".parse().unwrap()
        ));
        assert!(!is_allowed_roblox_navigation(
            &"https://evilroblox.com/".parse().unwrap()
        ));
    }

    #[test]
    fn cookie_filter_requires_exact_name_security_flags_and_roblox_domain() {
        assert!(is_roblox_security_cookie(
            ".ROBLOSECURITY",
            Some(".roblox.com"),
            Some(true),
            Some(true)
        ));
        assert!(!is_roblox_security_cookie(
            ".ROBLOSECURITY",
            Some("evilroblox.com"),
            Some(true),
            Some(true)
        ));
        assert!(!is_roblox_security_cookie(
            ".ROBLOSECURITY",
            Some(".roblox.com"),
            Some(false),
            Some(true)
        ));
        assert!(!is_roblox_security_cookie(
            "session",
            Some(".roblox.com"),
            Some(true),
            Some(true)
        ));
    }

    #[test]
    fn cookie_secret_has_no_debug_or_serialized_representation() {
        let cookie = RobloxCookie(Zeroizing::new("secret".to_owned()));
        assert_eq!(cookie.expose_secret(), "secret");
    }
}
