//! Running Roblox clients.
//!
//! Uses operating-system process APIs only. Nothing is read from or written to a client's memory
//! or files.

use std::collections::HashSet;

/// Process IDs of the running Roblox clients.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn roblox_pids() -> Result<HashSet<u32>, String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let output = std::process::Command::new("tasklist.exe")
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
        Ok(parse_tasklist(&String::from_utf8_lossy(&output.stdout)))
    }
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("/usr/bin/pgrep")
            .args(["-x", "RobloxPlayer"])
            .output()
            .map_err(|_| {
                "Toolblox couldn't inspect running Roblox processes. Can you try again?".to_string()
            })?;
        Ok(String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| line.trim().parse().ok())
            .collect())
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        Ok(HashSet::new())
    }
}

/// How long clients get to close normally before they're force-closed.
const CLOSE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Closes every running Roblox client and returns how many were running.
///
/// Asks each client to close normally, so it removes its tray icon, then force-closes any still
/// running after [`CLOSE_TIMEOUT`]. Blocks until done.
pub fn close_all() -> Result<usize, String> {
    let count = roblox_pids()?.len();
    if count == 0 {
        return Ok(0);
    }
    let _ = signal(false);
    let deadline = std::time::Instant::now() + CLOSE_TIMEOUT;
    while std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(250));
        if roblox_pids()?.is_empty() {
            return Ok(count);
        }
    }
    let forced = signal(true).is_ok_and(|status| status.success());
    if forced || roblox_pids()?.is_empty() {
        Ok(count)
    } else {
        Err("Toolblox couldn't close the Roblox clients. Can you try again?".to_string())
    }
}

/// Asks every Roblox client to close, or ends it at once when `force` is set.
fn signal(force: bool) -> std::io::Result<std::process::ExitStatus> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let mut command = std::process::Command::new("taskkill.exe");
        if force {
            command.arg("/F");
        }
        command
            .args(["/T", "/IM", "RobloxPlayerBeta.exe"])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("/usr/bin/pkill")
            .args([if force { "-KILL" } else { "-TERM" }, "-x", "RobloxPlayer"])
            .status()
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = force;
        Err(std::io::ErrorKind::Unsupported.into())
    }
}

/// Reads process IDs from `tasklist /FO CSV /NH` output.
#[cfg_attr(not(windows), allow(dead_code))]
fn parse_tasklist(text: &str) -> HashSet<u32> {
    text.lines()
        .filter_map(|line| line.split("\",\"").nth(1))
        .filter_map(|value| value.trim_matches('"').parse().ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tasklist_rows_give_process_ids() {
        let text = "\"RobloxPlayerBeta.exe\",\"4120\",\"Console\",\"1\",\"512,000 K\"\r\n\
                    \"RobloxPlayerBeta.exe\",\"88\",\"Console\",\"1\",\"1 K\"\r\n\
                    INFO: No tasks are running which match the specified criteria.\r\n";
        assert_eq!(parse_tasklist(text), HashSet::from([4120, 88]));
    }
}
