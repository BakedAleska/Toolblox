//! Rotating, redacted log file shared by the host, the interface, and widgets.
//!
//! Records go through the [`log`] facade. Toolblox's own records are kept from `Info` up (`Debug`
//! in debug builds); other crates, such as Tauri and its plugins, from `Warn` up. Every line is
//! redacted before it's written, so cookies, tickets, authorization headers, and launch URLs never
//! reach the file, whoever logged them.
//!
//! The file is `v2/logs/toolblox.log` in the data folder. It rotates at 1 MB and keeps three older
//! files, `toolblox.log.1` through `toolblox.log.3`.

use std::fmt::Write as _;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use log::{Level, LevelFilter, Log, Metadata, Record};

/// Name of the current log file.
const FILE_NAME: &str = "toolblox.log";
/// Size at which the current file rotates.
const MAX_FILE_BYTES: u64 = 1_000_000;
/// Rotated files kept next to the current one.
const BACKUPS: usize = 3;
/// Longest message kept per record, in bytes. Longer messages are cut.
pub const MAX_MESSAGE_BYTES: usize = 8 * 1024;
/// Most lines [`tail`] returns.
pub const MAX_TAIL_LINES: usize = 2_000;
/// Target of records logged from the crate root, shown as `toolblox`.
const CRATE_ROOT: &str = "toolblox_lib";
/// Prefix of Toolblox's own module paths, dropped from record targets.
const CRATE_PREFIX: &str = "toolblox_lib::";

/// Targets for records that don't come from a Toolblox module.
pub const OWN_TARGETS: &[&str] = &["interface", "panic"];
/// Prefix of widget record targets, followed by the widget ID.
pub const WIDGET_TARGET_PREFIX: &str = "widget:";

/// Replacement for redacted values.
const REDACTED: &str = "[redacted]";

/// Keys whose values are secret wherever they appear as `key=value`, `key: value`, or
/// `"key": "value"`. Matched case-insensitively at word boundaries.
const SECRET_KEYS: &[&str] = &[
    ".roblosecurity",
    "rbx-authentication-ticket",
    "authentication-ticket",
    "ticket",
    "x-csrf-token",
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    "password",
    "secret",
    "token",
    "access_token",
    "refresh_token",
    "api_key",
    "apikey",
];

/// Keys whose values run to the end of the line or quote, because they can contain spaces or
/// several `name=value` pairs.
const WHOLE_VALUE_KEYS: &[&str] = &[
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
];

/// Schemes whose URIs carry join tickets. Everything after the scheme is redacted.
const LAUNCH_SCHEMES: &[&str] = &["roblox-player:", "roblox-studio:"];

/// Start of every Roblox session cookie value.
const COOKIE_MARKER: &str = "_|warning:";

static LOGGER: OnceLock<FileLogger> = OnceLock::new();

/// Appends records to the current file, rotating it when it grows too large.
struct FileLogger {
    directory: PathBuf,
    file: Mutex<Option<File>>,
}

impl FileLogger {
    fn path(&self) -> PathBuf {
        self.directory.join(FILE_NAME)
    }

    fn append(&self, line: &str) {
        let mut file = self.file.lock().unwrap_or_else(|error| error.into_inner());
        let size = file
            .as_ref()
            .and_then(|file| file.metadata().ok())
            .map_or(0, |metadata| metadata.len());
        if file.is_none() || size + line.len() as u64 > MAX_FILE_BYTES {
            *file = None;
            if size > 0 {
                rotate(&self.directory);
            }
            *file = open(&self.path()).ok();
        }
        if let Some(file) = file.as_mut() {
            let _ = file.write_all(line.as_bytes());
        }
    }
}

impl Log for FileLogger {
    fn enabled(&self, metadata: &Metadata) -> bool {
        metadata.level() <= level_for(metadata.target())
    }

    fn log(&self, record: &Record) {
        if self.enabled(record.metadata()) {
            let message = record.args().to_string();
            self.append(&format_line(
                SystemTime::now(),
                record.level(),
                record.target(),
                &message,
            ));
        }
    }

    fn flush(&self) {
        if let Ok(mut file) = self.file.lock()
            && let Some(file) = file.as_mut()
        {
            let _ = file.flush();
        }
    }
}

/// Highest level kept for a target.
fn level_for(target: &str) -> LevelFilter {
    let own = target == CRATE_ROOT
        || target.starts_with(CRATE_PREFIX)
        || OWN_TARGETS.contains(&target)
        || target.starts_with(WIDGET_TARGET_PREFIX);
    match (own, cfg!(debug_assertions)) {
        (true, true) => LevelFilter::Debug,
        (true, false) => LevelFilter::Info,
        (false, _) => LevelFilter::Warn,
    }
}

/// Opens the log file for appending, creating it if needed.
fn open(path: &Path) -> io::Result<File> {
    OpenOptions::new().create(true).append(true).open(path)
}

/// Shifts `toolblox.log.N` to `N + 1`, dropping the oldest, then moves the current file to `.1`.
fn rotate(directory: &Path) {
    let numbered = |index: usize| directory.join(format!("{FILE_NAME}.{index}"));
    let _ = fs::remove_file(numbered(BACKUPS));
    for index in (1..BACKUPS).rev() {
        let _ = fs::rename(numbered(index), numbered(index + 1));
    }
    let _ = fs::rename(directory.join(FILE_NAME), numbered(1));
}

/// Starts logging to `directory` and records panics. Later calls do nothing.
pub fn init(directory: &Path) -> io::Result<()> {
    fs::create_dir_all(directory)?;
    let file = open(&directory.join(FILE_NAME))?;
    let logger = LOGGER.get_or_init(|| FileLogger {
        directory: directory.to_path_buf(),
        file: Mutex::new(Some(file)),
    });
    if log::set_logger(logger).is_err() {
        return Ok(());
    }
    log::set_max_level(LevelFilter::Debug);
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let backtrace = std::backtrace::Backtrace::force_capture();
        log::error!(target: "panic", "{info}\n{backtrace}");
        log::logger().flush();
        previous(info);
    }));
    Ok(())
}

/// Folder holding the log files, once logging has started.
pub fn directory() -> Option<&'static Path> {
    LOGGER.get().map(|logger| logger.directory.as_path())
}

/// Returns up to `lines` of the most recent log lines, oldest first, reading into rotated files
/// when the current one is shorter.
pub fn tail(lines: usize) -> Result<String, String> {
    let directory = directory().ok_or_else(|| {
        "Logging didn't start. Can you check that the data folder is writable?".to_string()
    })?;
    tail_in(directory, lines.clamp(1, MAX_TAIL_LINES))
}

fn tail_in(directory: &Path, lines: usize) -> Result<String, String> {
    let files = std::iter::once(directory.join(FILE_NAME))
        .chain((1..=BACKUPS).map(|index| directory.join(format!("{FILE_NAME}.{index}"))));
    let mut collected: Vec<String> = Vec::new();
    for path in files {
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(_) => {
                return Err("The log couldn't be read. Is another program using it?".into());
            }
        };
        let text = String::from_utf8_lossy(&bytes);
        let mut older: Vec<String> = text
            .lines()
            .rev()
            .take(lines - collected.len())
            .map(str::to_owned)
            .collect();
        collected.append(&mut older);
        if collected.len() >= lines {
            break;
        }
    }
    collected.reverse();
    Ok(collected.join("\n"))
}

/// Formats one record as a redacted line: `<UTC time> <LEVEL> <target>: <message>`.
///
/// Messages are cut at [`MAX_MESSAGE_BYTES`]. Continuation lines are indented and other control
/// characters are escaped, so a message can't imitate another record.
fn format_line(time: SystemTime, level: Level, target: &str, message: &str) -> String {
    let target = if target == CRATE_ROOT {
        "toolblox"
    } else {
        target.strip_prefix(CRATE_PREFIX).unwrap_or(target)
    };
    let mut message = redact(message);
    if message.len() > MAX_MESSAGE_BYTES {
        let mut end = MAX_MESSAGE_BYTES;
        while !message.is_char_boundary(end) {
            end -= 1;
        }
        message.truncate(end);
        message.push_str(" [truncated]");
    }
    let mut line = format!(
        "{} {:<5} {}: ",
        timestamp(time),
        level,
        sanitize(&redact(target), false)
    );
    line.push_str(&sanitize(message.trim_end(), true));
    line.push('\n');
    line
}

/// Escapes control characters. With `multiline`, line breaks become indented continuation lines.
fn sanitize(text: &str, multiline: bool) -> String {
    let mut output = String::with_capacity(text.len());
    for character in text.chars() {
        match character {
            '\n' if multiline => output.push_str("\n    "),
            '\r' if multiline => {}
            '\t' => output.push(' '),
            character if character.is_control() => {
                let _ = write!(output, "\\u{{{:x}}}", character as u32);
            }
            character => output.push(character),
        }
    }
    output
}

/// Formats a time as UTC ISO 8601 with milliseconds.
fn timestamp(time: SystemTime) -> String {
    let elapsed = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    let seconds = elapsed.as_secs();
    let (year, month, day) = civil_from_days((seconds / 86_400) as i64);
    let remainder = seconds % 86_400;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        remainder / 3_600,
        remainder % 3_600 / 60,
        remainder % 60,
        elapsed.subsec_millis()
    )
}

/// Converts days since 1970-01-01 to a proleptic Gregorian date (Howard Hinnant's algorithm).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * month_index + 2) / 5 + 1) as u32;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    } as u32;
    (year_of_era + era * 400 + i64::from(month <= 2), month, day)
}

/// Replaces Roblox session cookies, launch URIs, and the values of [`SECRET_KEYS`] with
/// `[redacted]`.
pub fn redact(text: &str) -> String {
    let lower = text.to_ascii_lowercase();
    let bytes = text.as_bytes();
    let mut output = String::with_capacity(text.len());
    let mut copied = 0;
    let mut index = 0;
    while index < bytes.len() {
        let Some((value_start, value_end)) = secret_at(&lower, bytes, index) else {
            index += 1;
            continue;
        };
        output.push_str(&text[copied..value_start]);
        output.push_str(REDACTED);
        copied = value_end;
        index = value_end.max(index + 1);
    }
    output.push_str(&text[copied..]);
    output
}

/// Finds a secret starting at `index` and returns the byte range of its value.
fn secret_at(lower: &str, bytes: &[u8], index: usize) -> Option<(usize, usize)> {
    if !lower.is_char_boundary(index) {
        return None;
    }
    let rest = &lower[index..];
    if rest.starts_with(COOKIE_MARKER) {
        return Some((index, value_end(bytes, index, false)));
    }
    let boundary = index == 0 || !is_word_byte(bytes[index - 1]);
    if !boundary {
        return None;
    }
    if let Some(scheme) = LAUNCH_SCHEMES
        .iter()
        .find(|scheme| rest.starts_with(**scheme))
    {
        let start = index + scheme.len();
        let end = value_end(bytes, start, false);
        return (end > start).then_some((start, end));
    }
    let key = SECRET_KEYS
        .iter()
        .filter(|key| rest.starts_with(**key))
        .filter(|key| {
            bytes
                .get(index + key.len())
                .is_none_or(|next| !is_word_byte(*next))
        })
        .max_by_key(|key| key.len())?;
    let mut cursor = index + key.len();
    if bytes.get(cursor) == Some(&b'"') {
        cursor += 1;
    }
    cursor = skip_spaces(bytes, cursor);
    if !matches!(bytes.get(cursor), Some(b'=' | b':')) {
        return None;
    }
    cursor = skip_spaces(bytes, cursor + 1);
    let quoted = bytes.get(cursor) == Some(&b'"');
    if quoted {
        cursor += 1;
    }
    let end = if quoted {
        bytes[cursor..]
            .iter()
            .position(|byte| *byte == b'"' || *byte == b'\n')
            .map_or(bytes.len(), |offset| cursor + offset)
    } else {
        value_end(bytes, cursor, WHOLE_VALUE_KEYS.contains(key))
    };
    (end > cursor && &lower[cursor..end] != REDACTED).then_some((cursor, end))
}

/// End of an unquoted value: the next whitespace, quote, or separator. With `whole`, only line
/// breaks and quotes end it.
fn value_end(bytes: &[u8], start: usize, whole: bool) -> usize {
    bytes[start..]
        .iter()
        .position(|byte| {
            if whole {
                matches!(byte, b'\n' | b'\r' | b'"' | b'\'')
            } else {
                byte.is_ascii_whitespace()
                    || matches!(byte, b';' | b',' | b'"' | b'\'' | b'&' | b'<' | b'>' | b'`')
            }
        })
        .map_or(bytes.len(), |offset| start + offset)
}

fn skip_spaces(bytes: &[u8], mut cursor: usize) -> usize {
    while bytes.get(cursor) == Some(&b' ') {
        cursor += 1;
    }
    cursor
}

fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.')
}

#[cfg(test)]
mod tests {
    use super::*;

    const COOKIE: &str = "_|WARNING:-DO-NOT-SHARE-THIS.--Sharing-this-will-allow-someone-to-log-in-as-you-and-to-steal-your-ROBUX-and-items.|_ABCDEF0123";

    #[test]
    fn redacts_cookies_anywhere() {
        let text = format!("bare {COOKIE} and quoted \"{COOKIE}\"");
        let redacted = redact(&text);
        assert!(!redacted.contains("ABCDEF0123"), "{redacted}");
        assert_eq!(redacted, "bare [redacted] and quoted \"[redacted]\"");
        assert_eq!(
            redact(".ROBLOSECURITY=abc123; path=/"),
            ".ROBLOSECURITY=[redacted]; path=/"
        );
    }

    #[test]
    fn redacts_headers_and_whole_cookie_values() {
        assert_eq!(
            redact("Authorization: Bearer abc.def"),
            "Authorization: [redacted]"
        );
        assert_eq!(
            redact("cookie: a=1; .ROBLOSECURITY=zzz\nnext"),
            "cookie: [redacted]\nnext"
        );
        assert_eq!(
            redact("rbx-authentication-ticket: T123 sent"),
            "rbx-authentication-ticket: [redacted] sent"
        );
        assert_eq!(redact("x-csrf-token: abc"), "x-csrf-token: [redacted]");
    }

    #[test]
    fn redacts_json_and_query_values() {
        assert_eq!(
            redact(r#"{"ticket": "T1", "token":"T2", "name":"ok"}"#),
            r#"{"ticket": "[redacted]", "token":"[redacted]", "name":"ok"}"#
        );
        assert_eq!(
            redact("https://example.com/?access_token=abc&page=2"),
            "https://example.com/?access_token=[redacted]&page=2"
        );
    }

    #[test]
    fn redacts_launch_uris() {
        assert_eq!(
            redact("opening roblox-player:1+launchmode:play+gameinfo:T1+launchtime:5 now"),
            "opening roblox-player:[redacted] now"
        );
    }

    #[test]
    fn leaves_ordinary_text_alone() {
        for text in [
            "Joined place 1818 as builderman",
            "tokens are fine without a value",
            "the ticket request failed",
            "Couldn't reach Roblox: timeout",
            "notoken=1 is a different key",
            "café ☕ unicode",
        ] {
            assert_eq!(redact(text), text);
        }
    }

    #[test]
    fn lines_cannot_forge_records_or_leak_control_characters() {
        let line = format_line(
            UNIX_EPOCH,
            Level::Warn,
            "toolblox_lib::widgets",
            "first\r\n2026-01-01T00:00:00.000Z ERROR fake: forged\u{1b}[31m",
        );
        assert_eq!(
            line,
            "1970-01-01T00:00:00.000Z WARN  widgets: first\n    2026-01-01T00:00:00.000Z ERROR fake: forged\\u{1b}[31m\n"
        );
    }

    #[test]
    fn crate_root_records_are_labelled_toolblox() {
        let line = format_line(UNIX_EPOCH, Level::Info, "toolblox_lib", "starting");
        assert_eq!(line, "1970-01-01T00:00:00.000Z INFO  toolblox: starting\n");
    }

    #[test]
    fn long_messages_are_cut_on_a_character_boundary() {
        let line = format_line(UNIX_EPOCH, Level::Info, "t", &"é".repeat(MAX_MESSAGE_BYTES));
        assert!(line.ends_with(" [truncated]\n"));
        assert!(line.len() < MAX_MESSAGE_BYTES + 100);
    }

    #[test]
    fn timestamps_are_utc_dates() {
        assert_eq!(timestamp(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        let leap = UNIX_EPOCH + std::time::Duration::from_millis(951_782_400_123);
        assert_eq!(timestamp(leap), "2000-02-29T00:00:00.123Z");
        let later = UNIX_EPOCH + std::time::Duration::from_secs(1_790_294_399);
        assert_eq!(timestamp(later), "2026-09-24T23:59:59.000Z");
    }

    #[test]
    fn own_targets_are_kept_at_info_and_others_at_warn() {
        assert!(level_for("toolblox_lib") >= LevelFilter::Info);
        assert!(level_for("toolblox_lib::startup") >= LevelFilter::Info);
        assert!(level_for("interface") >= LevelFilter::Info);
        assert!(level_for("widget:rogue_lineage") >= LevelFilter::Info);
        assert_eq!(level_for("tauri::manager"), LevelFilter::Warn);
        assert_eq!(level_for("reqwest"), LevelFilter::Warn);
    }

    #[test]
    fn rotates_and_tails_across_files() {
        let directory = tempfile::tempdir().unwrap();
        let logger = FileLogger {
            directory: directory.path().to_path_buf(),
            file: Mutex::new(None),
        };
        let line = format!("{}\n", "x".repeat(99_999));
        for _ in 0..45 {
            logger.append(&line);
        }
        logger.append("last\n");
        let names = |index: usize| directory.path().join(format!("{FILE_NAME}.{index}"));
        assert!(names(1).exists() && names(2).exists() && names(3).exists());
        assert!(!names(4).exists());
        for path in [directory.path().join(FILE_NAME), names(1)] {
            assert!(fs::metadata(path).unwrap().len() <= MAX_FILE_BYTES);
        }
        let tail = tail_in(directory.path(), 12).unwrap();
        let lines: Vec<_> = tail.lines().collect();
        assert_eq!(lines.len(), 12);
        assert_eq!(lines.last(), Some(&"last"));
    }

    #[test]
    fn records_reach_the_file_redacted_and_filtered() {
        let directory = tempfile::tempdir().unwrap();
        init(directory.path()).unwrap();
        log::info!("joined with roblox-player:1+gameinfo:SECRET-TICKET+launchtime:1");
        log::warn!(target: "widget:sample", "cookie: .ROBLOSECURITY=SECRET-COOKIE");
        log::info!(target: "tauri::noise", "dropped below warn");
        log::logger().flush();
        let tail = tail(10).unwrap();
        assert!(
            tail.contains("INFO  logs::tests: joined with roblox-player:[redacted]"),
            "{tail}"
        );
        assert!(
            tail.contains("WARN  widget:sample: cookie: [redacted]"),
            "{tail}"
        );
        assert!(
            !tail.contains("SECRET") && !tail.contains("dropped"),
            "{tail}"
        );
    }

    #[test]
    fn tail_of_a_missing_log_is_empty() {
        let directory = tempfile::tempdir().unwrap();
        assert_eq!(tail_in(directory.path(), 10).unwrap(), "");
    }
}
