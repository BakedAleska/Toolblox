//! Running several Roblox clients at once.
//!
//! On Windows, the bundled audited helper closes Roblox's singleton handles. On macOS, Roblox's
//! single-instance semaphore name is removed and the player is started directly, because Launch
//! Services refuses a second instance of a bundle with `LSMultipleInstancesProhibited`. The
//! semaphore was identified by [multi-roblox-macos](https://github.com/Insadem/multi-roblox-macos)
//! and [rororo-mac](https://github.com/estevanhernandez-stack-ed/rororo-mac).

use std::collections::HashSet;
use std::path::{Path, PathBuf};
#[cfg(any(windows, target_os = "macos"))]
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Process creation flag that keeps console helpers from opening a window.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Closes the singleton handles of Roblox processes that started since the last call, so the next
/// client can open alongside them.
///
/// `cleared` holds the process IDs already handled and drops IDs that have exited. Does nothing
/// outside Windows.
pub fn clear_new_roblox_instances(
    helper: Option<&Path>,
    cleared: &mut HashSet<u32>,
) -> Result<(), String> {
    #[cfg(not(windows))]
    {
        let _ = (helper, cleared);
        Ok(())
    }
    #[cfg(windows)]
    {
        let helper = helper.filter(|path| path.is_file()).ok_or_else(|| {
            "The multi-instance helper isn't installed. Can you reinstall Toolblox?".to_string()
        })?;
        let output = Command::new("tasklist.exe")
            .args([
                "/FI",
                "IMAGENAME eq RobloxPlayerBeta.exe",
                "/FO",
                "CSV",
                "/NH",
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|_| {
                "Toolblox couldn't inspect running Roblox processes. Can you try again?".to_string()
            })?;
        let text = String::from_utf8_lossy(&output.stdout);
        let running: HashSet<u32> = text
            .lines()
            .filter_map(|line| line.split("\",\"").nth(1))
            .filter_map(|value| value.trim_matches('"').parse().ok())
            .collect();
        cleared.retain(|pid| running.contains(pid));
        let new: Vec<_> = running.difference(cleared).copied().collect();
        if new.is_empty() {
            return Ok(());
        }
        let status = Command::new(helper)
            .args(new.iter().map(u32::to_string))
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map_err(|_| {
                "The multi-instance helper couldn't start. Can you try again?".to_string()
            })?;
        if !status.success() {
            return Err("The multi-instance helper failed. Can you try again?".into());
        }
        cleared.extend(new);
        Ok(())
    }
}

/// The POSIX semaphore the macOS Roblox player uses to refuse a second client.
#[cfg(target_os = "macos")]
const ROBLOX_SEMAPHORE: &std::ffi::CStr = c"/RobloxPlayerUniq";

/// The player executable inside `Roblox.app`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const PLAYER_EXECUTABLE: &str = "Contents/MacOS/RobloxPlayer";

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn sem_unlink(name: *const std::ffi::c_char) -> std::ffi::c_int;
}

/// Removes a named semaphore. A semaphore that doesn't exist isn't an error. Processes that
/// already opened it keep their handle.
#[cfg(target_os = "macos")]
fn unlink_semaphore(name: &std::ffi::CStr) -> Result<(), String> {
    // SAFETY: `name` is a valid NUL-terminated string that outlives the call.
    if unsafe { sem_unlink(name.as_ptr()) } == 0 {
        return Ok(());
    }
    match std::io::Error::last_os_error().kind() {
        std::io::ErrorKind::NotFound => Ok(()),
        _ => Err("Roblox's single-instance lock couldn't be cleared. Can you try again?".into()),
    }
}

/// Returns the first installed Roblox player under the given application folders.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn find_roblox_player(application_dirs: &[PathBuf]) -> Option<PathBuf> {
    application_dirs
        .iter()
        .map(|dir| dir.join("Roblox.app").join(PLAYER_EXECUTABLE))
        .find(|path| path.is_file())
}

/// Builds the command that starts the player with a join URI, the same arguments Roblox's own
/// launcher passes.
#[cfg(target_os = "macos")]
fn player_command(player: &Path, uri: &str) -> Command {
    use std::os::unix::process::CommandExt;

    let mut command = Command::new(player);
    command
        .args(["-protocolString", uri])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .process_group(0);
    command
}

/// Starts a new Roblox client for a join URI alongside any running clients.
///
/// Removes Roblox's single-instance semaphore name before and after starting the player, so
/// neither a running client nor the new one blocks the next. The URI holds a one-time ticket, so
/// it must not be logged. Only supported on macOS.
pub fn open_new_roblox_instance(uri: &str) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = uri;
        Err("Starting a separate Roblox client isn't supported on this platform.".into())
    }
    #[cfg(target_os = "macos")]
    {
        let mut application_dirs = vec![PathBuf::from("/Applications")];
        if let Some(home) = std::env::var_os("HOME") {
            application_dirs.push(PathBuf::from(home).join("Applications"));
        }
        let player = find_roblox_player(&application_dirs).ok_or_else(|| {
            "Roblox wasn't found in the Applications folder. Is Roblox installed?".to_string()
        })?;
        unlink_semaphore(ROBLOX_SEMAPHORE)?;
        let mut child = player_command(&player, uri)
            .spawn()
            .map_err(|_| "Roblox couldn't be started. Is Roblox installed?".to_string())?;
        std::thread::spawn(move || child.wait());
        unlink_semaphore(ROBLOX_SEMAPHORE)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roblox_player_is_found_in_the_first_folder_that_has_it() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let dirs = [first.path().to_path_buf(), second.path().to_path_buf()];
        assert_eq!(find_roblox_player(&dirs), None);

        let player = second.path().join("Roblox.app").join(PLAYER_EXECUTABLE);
        std::fs::create_dir_all(player.parent().unwrap()).unwrap();
        std::fs::write(&player, b"").unwrap();
        assert_eq!(find_roblox_player(&dirs), Some(player.clone()));

        std::fs::create_dir_all(first.path().join("Roblox.app").join(PLAYER_EXECUTABLE)).unwrap();
        assert_eq!(find_roblox_player(&dirs), Some(player));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn player_receives_the_uri_as_one_protocol_string_argument() {
        let uri = "roblox-player:1+launchmode:play+gameinfo:ticket +placelauncherurl:x";
        let command = player_command(Path::new("/Applications/Roblox.app/x"), uri);
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(args, ["-protocolString", uri]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn missing_semaphore_unlinks_without_error() {
        let name = format!("/tbx-test-{}\0", std::process::id());
        let name = std::ffi::CStr::from_bytes_with_nul(name.as_bytes()).unwrap();
        assert_eq!(unlink_semaphore(name), Ok(()));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn existing_semaphore_is_removed_by_name() {
        unsafe extern "C" {
            fn sem_open(name: *const std::ffi::c_char, flags: std::ffi::c_int, ...) -> isize;
            fn sem_close(semaphore: isize) -> std::ffi::c_int;
        }
        const O_CREAT: std::ffi::c_int = 0x200;
        const SEM_FAILED: isize = -1;
        let name = format!("/tbx-live-{}\0", std::process::id());
        let name = std::ffi::CStr::from_bytes_with_nul(name.as_bytes()).unwrap();
        // SAFETY: `name` is NUL-terminated and the variadic mode and value match `sem_open`.
        let created = unsafe { sem_open(name.as_ptr(), O_CREAT, 0o600 as std::ffi::c_uint, 0) };
        assert_ne!(created, SEM_FAILED);
        assert_eq!(unlink_semaphore(name), Ok(()));
        // SAFETY: `name` is NUL-terminated; opening without `O_CREAT` takes no variadic values.
        let reopened = unsafe { sem_open(name.as_ptr(), 0) };
        assert_eq!(reopened, SEM_FAILED);
        // SAFETY: `created` is an open semaphore from `sem_open`.
        unsafe { sem_close(created) };
    }
}
