//! Advanced settings that write configuration files Roblox reads. Each is off by default, and
//! this is the only place Toolblox writes Roblox's files. None of them injects code or touches
//! Roblox's memory.
//!
//! - **FastFlags.** Roblox reads `ClientSettings/ClientAppSettings.json` next to its player when a
//!   client starts. Toolblox writes it before launches, because a Roblox update installs the
//!   player in a new folder. Turning FastFlags off, or launching in safe mode, deletes it.
//! - **Client settings.** Roblox keeps its in-game settings in `GlobalBasicSettings_<n>.xml`,
//!   shared by every account. Toolblox sets the frame rate cap, graphics quality, and fullscreen
//!   values in it before launches. Roblox keeps the last values written after the setting turns
//!   off, and a client that exits saves its own values.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Most flags saved at once.
const MAX_FLAGS: usize = 200;
/// Longest flag name.
const MAX_NAME_CHARS: usize = 100;
/// Longest text value.
const MAX_VALUE_CHARS: usize = 200;

/// Accepted frame rate caps. The highest is the highest option in Roblox's own settings menu.
const FPS_CAP_RANGE: std::ops::RangeInclusive<u32> = 15..=240;
/// Highest graphics quality, matching Roblox's 10-step slider. `0` is automatic.
const MAX_GRAPHICS_QUALITY: u8 = 10;
/// Accepted client window widths and heights.
const WINDOW_WIDTH_RANGE: std::ops::RangeInclusive<i32> = 320..=7680;
const WINDOW_HEIGHT_RANGE: std::ops::RangeInclusive<i32> = 180..=4320;

/// Checks flag names and values. Returns a user-facing message on failure.
pub fn validate_flags(flags: &Map<String, Value>) -> Result<(), String> {
    if flags.len() > MAX_FLAGS {
        return Err(format!(
            "Only {MAX_FLAGS} FastFlags can be saved. Can you remove some?"
        ));
    }
    for (name, value) in flags {
        if name.is_empty()
            || name.len() > MAX_NAME_CHARS
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        {
            return Err(format!(
                "\"{}\" isn't a valid FastFlag name. Can you use only letters, digits, and underscores?",
                name.chars().take(MAX_NAME_CHARS).collect::<String>()
            ));
        }
        let valid = match value {
            Value::Bool(_) | Value::Number(_) => true,
            Value::String(text) => text.chars().count() <= MAX_VALUE_CHARS,
            _ => false,
        };
        if !valid {
            return Err(format!(
                "The value of {name} isn't valid. Can you use text, a number, or true or false?"
            ));
        }
    }
    Ok(())
}

/// A client window size in physical pixels.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct WindowSize {
    pub width: i32,
    pub height: i32,
}

/// Per-launch client settings. `None` leaves Roblox's value unchanged.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct ClientSettings {
    pub fps_cap: Option<u32>,
    /// `0` is automatic, `1` to `10` match Roblox's graphics slider.
    pub graphics_quality: Option<u8>,
    /// Window size, set after the client opens. Turns off fullscreen. Windows only.
    pub window_size: Option<WindowSize>,
}

impl ClientSettings {
    /// Checks the ranges. Returns a user-facing message on failure.
    pub fn validate(&self) -> Result<(), String> {
        if self
            .fps_cap
            .is_some_and(|cap| !FPS_CAP_RANGE.contains(&cap))
        {
            return Err(format!(
                "The frame rate cap must be from {} to {}. Can you change it?",
                FPS_CAP_RANGE.start(),
                FPS_CAP_RANGE.end()
            ));
        }
        if self
            .graphics_quality
            .is_some_and(|quality| quality > MAX_GRAPHICS_QUALITY)
        {
            return Err(
                "Graphics quality must be from 1 to 10, or automatic. Can you change it?".into(),
            );
        }
        if self.window_size.is_some_and(|size| {
            !WINDOW_WIDTH_RANGE.contains(&size.width) || !WINDOW_HEIGHT_RANGE.contains(&size.height)
        }) {
            return Err(format!(
                "The window size must be from {}×{} to {}×{}. Can you change it?",
                WINDOW_WIDTH_RANGE.start(),
                WINDOW_HEIGHT_RANGE.start(),
                WINDOW_WIDTH_RANGE.end(),
                WINDOW_HEIGHT_RANGE.end()
            ));
        }
        Ok(())
    }

    /// These settings, with any unset value taken from `defaults`.
    pub fn or(self, defaults: Self) -> Self {
        Self {
            fps_cap: self.fps_cap.or(defaults.fps_cap),
            graphics_quality: self.graphics_quality.or(defaults.graphics_quality),
            window_size: self.window_size.or(defaults.window_size),
        }
    }

    /// Whether Roblox's settings file needs to change.
    fn changes_file(&self) -> bool {
        self.fps_cap.is_some() || self.graphics_quality.is_some() || self.window_size.is_some()
    }
}

/// The Roblox files one launch needs. `None` leaves that file alone.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LaunchFiles {
    pub flags: Option<Map<String, Value>>,
    pub settings: Option<ClientSettings>,
}

impl LaunchFiles {
    /// Writes the files. A missing Roblox install or settings file is an error.
    pub fn write(&self) -> Result<(), String> {
        if let Some(flags) = &self.flags {
            write_flags(flags)?;
        }
        if let Some(settings) = self.settings.filter(ClientSettings::changes_file) {
            write_client_settings(&settings)?;
        }
        Ok(())
    }
}

/// The `ClientSettings` folders of every installed Roblox player.
fn client_settings_dirs() -> Vec<PathBuf> {
    #[cfg(windows)]
    let players: Vec<PathBuf> = ["LOCALAPPDATA", "ProgramFiles(x86)"]
        .iter()
        .filter_map(std::env::var_os)
        .map(|root| PathBuf::from(root).join("Roblox").join("Versions"))
        .flat_map(|versions| player_folders(&versions, "RobloxPlayerBeta.exe"))
        .collect();
    #[cfg(target_os = "macos")]
    let players: Vec<PathBuf> = std::iter::once(PathBuf::from("/Applications"))
        .chain(std::env::var_os("HOME").map(|home| PathBuf::from(home).join("Applications")))
        .map(|apps| apps.join("Roblox.app").join("Contents").join("MacOS"))
        .filter(|folder| folder.join("RobloxPlayer").is_file())
        .collect();
    #[cfg(not(any(windows, target_os = "macos")))]
    let players: Vec<PathBuf> = Vec::new();
    players
        .into_iter()
        .map(|folder| folder.join("ClientSettings"))
        .collect()
}

/// Subfolders of `versions` that contain `player`.
#[cfg_attr(not(windows), allow(dead_code))]
fn player_folders(versions: &Path, player: &str) -> Vec<PathBuf> {
    std::fs::read_dir(versions)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|folder| folder.join(player).is_file())
        .collect()
}

/// Writes the flags for every installed Roblox player and returns how many were written.
pub fn write_flags(flags: &Map<String, Value>) -> Result<usize, String> {
    validate_flags(flags)?;
    write_flags_to(&client_settings_dirs(), flags)
}

/// Writes the flags file into each folder.
fn write_flags_to(folders: &[PathBuf], flags: &Map<String, Value>) -> Result<usize, String> {
    if folders.is_empty() {
        return Err("Roblox wasn't found. Is it installed?".into());
    }
    let contents = serde_json::to_vec_pretty(flags)
        .map_err(|_| "The FastFlags couldn't be prepared. Can you check them?".to_string())?;
    for folder in folders {
        std::fs::create_dir_all(folder)
            .and_then(|()| std::fs::write(folder.join("ClientAppSettings.json"), &contents))
            .map_err(|_| {
                "The FastFlags couldn't be saved in Roblox's folder. Is Roblox running as administrator?"
                    .to_string()
            })?;
    }
    Ok(folders.len())
}

/// Deletes the flags file from every installed Roblox player. A missing file isn't an error.
pub fn remove_flags() -> Result<(), String> {
    remove_flags_from(&client_settings_dirs())
}

/// Deletes the flags file from each folder.
fn remove_flags_from(folders: &[PathBuf]) -> Result<(), String> {
    for folder in folders {
        match std::fs::remove_file(folder.join("ClientAppSettings.json")) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => {
                return Err(
                    "The FastFlags couldn't be removed from Roblox's folder. Is Roblox running?"
                        .into(),
                );
            }
        }
    }
    Ok(())
}

/// Roblox's settings folder: `%LOCALAPPDATA%\Roblox` or `~/Library/Roblox`.
fn roblox_settings_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    return std::env::var_os("LOCALAPPDATA").map(|root| PathBuf::from(root).join("Roblox"));
    #[cfg(target_os = "macos")]
    return std::env::var_os("HOME").map(|home| PathBuf::from(home).join("Library").join("Roblox"));
    #[cfg(not(any(windows, target_os = "macos")))]
    None
}

/// The newest player settings file in `folder`. Studio's file is skipped.
fn settings_file_in(folder: &Path) -> Option<PathBuf> {
    std::fs::read_dir(folder)
        .ok()?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let version: u32 = name
                .strip_prefix("GlobalBasicSettings_")?
                .strip_suffix(".xml")?
                .parse()
                .ok()?;
            Some((version, entry.path()))
        })
        .max_by_key(|(version, _)| *version)
        .map(|(_, path)| path)
}

/// Sets the client settings in Roblox's settings file.
fn write_client_settings(settings: &ClientSettings) -> Result<(), String> {
    settings.validate()?;
    let path = roblox_settings_dir()
        .as_deref()
        .and_then(settings_file_in)
        .ok_or_else(|| {
            "Roblox's settings file wasn't found. Can you open Roblox once first?".to_string()
        })?;
    let original = std::fs::read_to_string(&path)
        .map_err(|_| "Roblox's settings file couldn't be read. Is Roblox installed?".to_string())?;
    let edited = edit_client_settings(&original, settings)?;
    if edited == original {
        return Ok(());
    }
    let temporary = path.with_extension("xml.toolblox");
    std::fs::write(&temporary, edited)
        .and_then(|()| crate::storage::replace_file(&temporary, &path))
        .map_err(|_| {
            let _ = std::fs::remove_file(&temporary);
            "Roblox's settings couldn't be saved. Is Roblox closing?".to_string()
        })
}

/// Returns the settings XML with the client settings applied.
fn edit_client_settings(xml: &str, settings: &ClientSettings) -> Result<String, String> {
    let mut xml = xml.to_string();
    let changes = [
        settings
            .fps_cap
            .map(|cap| ("int", "FramerateCap", cap.to_string())),
        settings
            .graphics_quality
            .map(|quality| ("token", "SavedQualityLevel", quality.to_string())),
        settings
            .window_size
            .map(|_| ("bool", "Fullscreen", "false".to_string())),
    ];
    for (kind, name, value) in changes.into_iter().flatten() {
        xml = set_property(&xml, kind, name, &value).ok_or_else(|| {
            format!("Roblox's settings file has no {name} value. Is Roblox up to date?")
        })?;
    }
    Ok(xml)
}

/// Replaces the text of the first `<kind name="name">` element, or returns `None` when there's
/// none.
fn set_property(xml: &str, kind: &str, name: &str, value: &str) -> Option<String> {
    let open = format!("<{kind} name=\"{name}\">");
    let start = xml.find(&open)? + open.len();
    let end = start + xml[start..].find(&format!("</{kind}>"))?;
    Some(format!("{}{value}{}", &xml[..start], &xml[end..]))
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use serde_json::json;

    use super::*;
    use crate::credentials::tests::production_source;

    /// Every Roblox file Toolblox may change, with the files allowed to name it and how often.
    /// Each entry must be on the Advanced settings list in Settings and in the docs. A new entry
    /// needs review.
    const ROBLOX_FILE_ACCESS: &[(&str, &[(&str, usize)])] = &[
        ("ClientAppSettings.json", &[("roblox_files.rs", 2)]),
        ("\"ClientSettings\"", &[("roblox_files.rs", 1)]),
        ("\"Versions\"", &[("roblox_files.rs", 1)]),
        ("\"GlobalBasicSettings_\"", &[("roblox_files.rs", 1)]),
        ("\"Library\"", &[("roblox_files.rs", 1)]),
        (
            "\"Roblox.app\"",
            &[("roblox_files.rs", 1), ("multi_instance.rs", 1)],
        ),
    ];

    #[test]
    fn roblox_file_access_matches_the_reviewed_list() {
        let directory = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut problems = Vec::new();
        for entry in std::fs::read_dir(&directory).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().is_none_or(|extension| extension != "rs") {
                continue;
            }
            let name = path.file_name().unwrap().to_str().unwrap();
            let source = production_source(&std::fs::read_to_string(&path).unwrap());
            for (pattern, allowed) in ROBLOX_FILE_ACCESS {
                let found = source.matches(pattern).count();
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
            "Roblox file access changed. Update the Advanced settings list and the docs, then \
             ROBLOX_FILE_ACCESS.\n{}",
            problems.join("\n")
        );
    }

    #[test]
    fn flag_names_and_values_are_checked() {
        let valid = json!({"FFlagDebugGraphicsPreferVulkan": true, "DFIntDebugFRMQualityLevelOverride": 1, "FStringX": "a"});
        assert!(validate_flags(valid.as_object().unwrap()).is_ok());
        for invalid in [
            json!({"": 1}),
            json!({"Flag Name": 1}),
            json!({"../Flag": 1}),
            json!({"Flag": null}),
            json!({"Flag": [1]}),
            json!({"Flag": {"nested": 1}}),
            json!({"Flag": "x".repeat(MAX_VALUE_CHARS + 1)}),
        ] {
            assert!(
                validate_flags(invalid.as_object().unwrap()).is_err(),
                "{invalid}"
            );
        }
        let many: Map<_, _> = (0..=MAX_FLAGS)
            .map(|index| (format!("F{index}"), json!(1)))
            .collect();
        assert!(validate_flags(&many).is_err());
    }

    #[test]
    fn flags_are_written_and_removed_per_player() {
        let root = tempfile::tempdir().unwrap();
        let versions = root.path().join("Versions");
        for version in ["version-a", "version-b", "version-c"] {
            std::fs::create_dir_all(versions.join(version)).unwrap();
        }
        std::fs::write(versions.join("version-a/RobloxPlayerBeta.exe"), b"").unwrap();
        std::fs::write(versions.join("version-c/RobloxPlayerBeta.exe"), b"").unwrap();
        let folders: Vec<_> = player_folders(&versions, "RobloxPlayerBeta.exe")
            .into_iter()
            .map(|folder| folder.join("ClientSettings"))
            .collect();
        assert_eq!(folders.len(), 2);

        let flags = json!({"DFIntDebugFRMQualityLevelOverride": 1});
        assert_eq!(write_flags_to(&folders, flags.as_object().unwrap()), Ok(2));
        let written = std::fs::read_to_string(folders[0].join("ClientAppSettings.json")).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&written).unwrap(), flags);
        assert!(!versions.join("version-b/ClientSettings").exists());

        assert_eq!(remove_flags_from(&folders), Ok(()));
        assert!(!folders[1].join("ClientAppSettings.json").exists());
        assert_eq!(remove_flags_from(&folders), Ok(()));
        assert!(write_flags_to(&[], flags.as_object().unwrap()).is_err());
    }

    const SETTINGS_XML: &str = "<roblox version=\"4\">\n\t<Item class=\"UserGameSettings\">\n\t\t<Properties>\n\t\t\t<int name=\"FramerateCap\">240</int>\n\t\t\t<bool name=\"Fullscreen\">true</bool>\n\t\t\t<int name=\"GraphicsQualityLevel\">21</int>\n\t\t\t<token name=\"SavedQualityLevel\">10</token>\n\t\t</Properties>\n\t</Item>\n</roblox>";

    #[test]
    fn client_settings_change_only_their_values() {
        let unchanged = edit_client_settings(SETTINGS_XML, &ClientSettings::default()).unwrap();
        assert_eq!(unchanged, SETTINGS_XML);

        let settings = ClientSettings {
            fps_cap: Some(30),
            graphics_quality: Some(1),
            window_size: Some(WindowSize {
                width: 640,
                height: 360,
            }),
        };
        let edited = edit_client_settings(SETTINGS_XML, &settings).unwrap();
        assert_eq!(
            edited,
            SETTINGS_XML
                .replace(">240<", ">30<")
                .replace("\"Fullscreen\">true", "\"Fullscreen\">false")
                .replace("SavedQualityLevel\">10", "SavedQualityLevel\">1")
        );
        assert!(edited.contains("GraphicsQualityLevel\">21<"));
        assert!(edit_client_settings("<roblox />", &settings).is_err());
    }

    #[test]
    fn client_settings_are_range_checked_and_fall_back_to_defaults() {
        assert!(ClientSettings::default().validate().is_ok());
        let fps = |cap| ClientSettings {
            fps_cap: Some(cap),
            ..Default::default()
        };
        assert!(fps(14).validate().is_err());
        assert!(fps(15).validate().is_ok());
        assert!(fps(240).validate().is_ok());
        assert!(fps(241).validate().is_err());
        let quality = ClientSettings {
            graphics_quality: Some(11),
            ..Default::default()
        };
        assert!(quality.validate().is_err());
        let small = ClientSettings {
            window_size: Some(WindowSize {
                width: 100,
                height: 100,
            }),
            ..Default::default()
        };
        assert!(small.validate().is_err());

        let merged = fps(30).or(ClientSettings {
            fps_cap: Some(60),
            graphics_quality: Some(3),
            window_size: None,
        });
        assert_eq!(merged.fps_cap, Some(30));
        assert_eq!(merged.graphics_quality, Some(3));
    }

    #[test]
    fn newest_player_settings_file_is_chosen() {
        let folder = tempfile::tempdir().unwrap();
        assert_eq!(settings_file_in(folder.path()), None);
        for name in [
            "GlobalBasicSettings_12.xml",
            "GlobalBasicSettings_13.xml",
            "GlobalBasicSettings_13_Studio.xml",
            "GlobalSettings_14.xml",
        ] {
            std::fs::write(folder.path().join(name), b"").unwrap();
        }
        assert_eq!(
            settings_file_in(folder.path()),
            Some(folder.path().join("GlobalBasicSettings_13.xml"))
        );
    }
}
