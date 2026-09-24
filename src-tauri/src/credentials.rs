//! OS-backed Roblox session storage. Secrets stay inside the Rust host.

use std::fmt;
use zeroize::Zeroize;

/// Keychain and Credential Manager service name for Roblox sessions.
const SERVICE: &str = "Toolblox";

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

/// Decrypts a session the legacy Flet app protected with Windows DPAPI for the current user.
#[cfg(windows)]
pub(crate) fn decrypt_legacy_dpapi(stored: &str) -> Result<Secret, CredentialError> {
    use base64::Engine;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CRYPT_INTEGER_BLOB, CryptUnprotectData};

    let ciphertext = match base64::engine::general_purpose::STANDARD.decode(stored) {
        Ok(value) => value,
        Err(_) => return Ok(Secret(stored.to_owned())),
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: ciphertext.len() as u32,
        pbData: ciphertext.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let ok = unsafe {
        CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            &mut output,
        )
    };
    if ok == 0 {
        return Err(CredentialError::Platform);
    }
    let bytes = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) };
    let plaintext = String::from_utf8(bytes.to_vec()).map_err(|_| CredentialError::Platform);
    unsafe {
        LocalFree(output.pbData.cast());
    }
    plaintext.map(Secret)
}

/// Reads a session the legacy Flet app stored in the macOS login Keychain.
#[cfg(target_os = "macos")]
pub(crate) fn lookup_legacy_keychain(account_id: u64) -> Result<Secret, CredentialError> {
    use std::process::Command;

    let output = Command::new("security")
        .args([
            "find-generic-password",
            "-a",
            &format!("account-{account_id}"),
            "-s",
            SERVICE,
            "-w",
        ])
        .output()
        .map_err(|_| CredentialError::Platform)?;
    if !output.status.success() {
        return Err(CredentialError::Missing);
    }
    let secret = String::from_utf8(output.stdout).map_err(|_| CredentialError::Platform)?;
    let secret = secret.trim_end_matches(['\r', '\n']).to_owned();
    if secret.is_empty() {
        Err(CredentialError::Missing)
    } else {
        Ok(Secret(secret))
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use super::*;

    #[derive(Default)]
    pub struct MemoryCredentialStore {
        values: Mutex<HashMap<u64, String>>,
    }

    impl CredentialStore for MemoryCredentialStore {
        fn get(&self, account_id: u64) -> Result<Secret, CredentialError> {
            self.values
                .lock()
                .map_err(|_| CredentialError::Platform)?
                .get(&account_id)
                .cloned()
                .map(Secret)
                .ok_or(CredentialError::Missing)
        }

        fn set(&self, account_id: u64, secret: &str) -> Result<(), CredentialError> {
            self.values
                .lock()
                .map_err(|_| CredentialError::Platform)?
                .insert(account_id, secret.to_owned());
            Ok(())
        }

        fn delete(&self, account_id: u64) -> Result<(), CredentialError> {
            self.values
                .lock()
                .map_err(|_| CredentialError::Platform)?
                .remove(&account_id);
            Ok(())
        }
    }
}
