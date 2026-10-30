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
