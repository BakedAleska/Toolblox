//! OS-backed Roblox session storage. Secrets stay inside the Rust host.

use std::fmt;
use zeroize::Zeroize;

/// Keychain and Credential Manager service name for Roblox sessions.
const SERVICE: &str = "Toolblox";

/// Start of every Roblox session cookie value, in lowercase.
pub(crate) const SESSION_COOKIE_MARKER: &str = "_|warning:";

/// Whether text contains a Roblox session cookie value, ignoring case.
pub(crate) fn contains_session_cookie(text: &str) -> bool {
    text.to_ascii_lowercase().contains(SESSION_COOKIE_MARKER)
}

/// A Roblox session cookie. Its `Debug` output is redacted and its memory is zeroed on drop.
pub struct Secret(String);

impl Secret {
    /// Wraps a session value read from storage or a sign-in.
    pub(crate) fn new(value: String) -> Self {
        Self(value)
    }

    /// Returns the raw session value. Callers must not log or return it to JavaScript.
    pub(crate) fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Secret([redacted])")
    }
}

impl Drop for Secret {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

/// Why a session couldn't be read or written.
#[derive(Debug)]
pub enum CredentialError {
    /// No session is stored for the account, or an empty session was given.
    Missing,
    /// This platform has no supported secure storage.
    #[cfg(not(any(windows, target_os = "macos")))]
    Unsupported,
    /// The operating system's secure storage failed or is locked.
    Platform,
}

impl fmt::Display for CredentialError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Missing => write!(
                formatter,
                "The saved session wasn't found. Can you sign in again?"
            ),
            #[cfg(not(any(windows, target_os = "macos")))]
            Self::Unsupported => write!(
                formatter,
                "Secure session storage isn't supported here. Can you use Windows or macOS?"
            ),
            Self::Platform => write!(
                formatter,
                "Toolblox couldn't access secure session storage. Is it unlocked?"
            ),
        }
    }
}

impl std::error::Error for CredentialError {}

/// Stores one Roblox session per account ID.
pub trait CredentialStore: Send + Sync {
    /// Reads the account's session.
    fn get(&self, account_id: u64) -> Result<Secret, CredentialError>;
    /// Stores or replaces the account's session. Rejects an empty session.
    fn set(&self, account_id: u64, secret: &str) -> Result<(), CredentialError>;
    /// Deletes the account's session. Deleting a missing session succeeds.
    fn delete(&self, account_id: u64) -> Result<(), CredentialError>;
}

/// Stores sessions in Windows Credential Manager or the macOS login Keychain.
#[derive(Debug, Default)]
pub struct OsCredentialStore;

impl OsCredentialStore {
    /// Opens the keyring entry for an account.
    #[cfg(any(windows, target_os = "macos"))]
    fn entry(account_id: u64) -> Result<keyring::Entry, CredentialError> {
        keyring::Entry::new(SERVICE, &format!("account-{account_id}"))
            .map_err(|_| CredentialError::Platform)
    }
}

#[cfg(any(windows, target_os = "macos"))]
impl CredentialStore for OsCredentialStore {
    fn get(&self, account_id: u64) -> Result<Secret, CredentialError> {
        Self::entry(account_id)?
            .get_password()
            .map(Secret)
            .map_err(|error| match error {
                keyring::Error::NoEntry => CredentialError::Missing,
                _ => CredentialError::Platform,
            })
    }

    fn set(&self, account_id: u64, secret: &str) -> Result<(), CredentialError> {
        if secret.is_empty() {
            return Err(CredentialError::Missing);
        }
        Self::entry(account_id)?
            .set_password(secret)
            .map_err(|_| CredentialError::Platform)
    }

    fn delete(&self, account_id: u64) -> Result<(), CredentialError> {
        match Self::entry(account_id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(CredentialError::Platform),
        }
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
impl CredentialStore for OsCredentialStore {
    fn get(&self, _account_id: u64) -> Result<Secret, CredentialError> {
        Err(CredentialError::Unsupported)
    }

    fn set(&self, _account_id: u64, _secret: &str) -> Result<(), CredentialError> {
        Err(CredentialError::Unsupported)
    }

    fn delete(&self, _account_id: u64) -> Result<(), CredentialError> {
        Err(CredentialError::Unsupported)
    }
}

/// Fails to compile when the type implements any of the traits.
#[cfg(test)]
macro_rules! assert_not_impl {
    ($type:ty: $($trait:path),+ $(,)?) => {$(
        const _: fn() = || {
            trait AmbiguousIfImplemented<Marker> {
                fn check() {}
            }
            impl<T: ?Sized> AmbiguousIfImplemented<()> for T {}
            struct Implemented;
            impl<T: ?Sized + $trait> AmbiguousIfImplemented<Implemented> for T {}
            let _ = <$type as AmbiguousIfImplemented<_>>::check;
        };
    )+};
}
#[cfg(test)]
pub(crate) use assert_not_impl;

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    assert_not_impl!(Secret: Clone, std::fmt::Display, serde::Serialize);

    /// Every place a session secret is read from the platform or exposed as text, with the files
    /// allowed to do it and how often. A new entry needs security review: it must not return the
    /// secret to JavaScript, a widget, a log, or a non-Roblox host.
    const SECRET_ACCESS: &[(&str, &[(&str, usize)])] = &[
        (".expose()", &[("app_commands.rs", 1), ("roblox.rs", 1)]),
        (".expose_secret()", &[("app_commands.rs", 2)]),
        ("cookie_header(", &[("roblox.rs", 4)]),
        ("keyring::", &[("credentials.rs", 4)]),
        ("get_password", &[("credentials.rs", 1)]),
        (".cookies()", &[("login.rs", 1)]),
        ("find-generic-password", &[]),
        ("CryptUnprotectData", &[]),
    ];

    /// Returns a source file's non-test code with comment lines removed.
    fn production_source(path: &Path) -> String {
        let source = std::fs::read_to_string(path).unwrap();
        let end = ["#[cfg(test)]\nmod ", "#[cfg(test)]\npub(crate) mod "]
            .iter()
            .filter_map(|marker| source.find(marker))
            .min()
            .unwrap_or(source.len());
        source[..end]
            .lines()
            .filter(|line| !line.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn secret_access_points_match_the_reviewed_list() {
        let directory = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files: Vec<_> = std::fs::read_dir(&directory)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| path.extension().is_some_and(|extension| extension == "rs"))
            .collect();
        files.sort();
        assert!(!files.is_empty());
        let mut problems = Vec::new();
        for (pattern, allowed) in SECRET_ACCESS {
            for path in &files {
                let name = path.file_name().unwrap().to_str().unwrap();
                let found = production_source(path).matches(pattern).count();
                let expected = allowed
                    .iter()
                    .find(|(file, _)| *file == name)
                    .map_or(0, |(_, count)| *count);
                if found != expected {
                    problems.push(format!(
                        "{name} uses `{pattern}` {found} times; the reviewed count is {expected}"
                    ));
                }
            }
        }
        assert!(
            problems.is_empty(),
            "Session secret access changed. Review that the secret can't reach JavaScript, a \
             widget, a log, or a non-Roblox host, then update SECRET_ACCESS.\n{}",
            problems.join("\n")
        );
    }

    #[test]
    fn session_cookies_are_detected_in_any_case() {
        assert!(contains_session_cookie(
            r#"{"value":"_|WARNING:-DO-NOT-SHARE-THIS.--Sharing|_ABC"}"#
        ));
        assert!(contains_session_cookie("_|warning:-do-not-share-this"));
        assert!(!contains_session_cookie(
            r#"{"name":".ROBLOSECURITY docs"}"#
        ));
    }
}
