//! Best-effort Windows Roblox singleton cleanup using the bundled audited helper.

use std::collections::HashSet;
use std::path::Path;
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub fn clear_new_roblox_instances(
    helper: Option<&Path>,
    cleared: &mut HashSet<u32>,
) -> Result<(), String> {
    #[cfg(not(windows))]
    {
        let _ = (helper, cleared);
        return Ok(());
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
