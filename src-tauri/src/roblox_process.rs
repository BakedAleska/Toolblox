//! Running Roblox clients: finding them, setting their priority and CPU cores, and tiling their
//! windows.
//!
//! Uses operating-system process and window APIs only. Nothing is read from or written to a
//! client's memory or files.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use serde::{Deserialize, Serialize};

use crate::roblox_files::WindowSize;

/// Scheduling priority for a Roblox client.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ClientPriority {
    #[default]
    Normal,
    BelowNormal,
    Low,
}

/// Window size used when tiling Roblox clients.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TileSize {
    /// Divide the screen evenly between the windows.
    #[default]
    Fit,
    /// 960 × 540 windows.
    Medium,
    /// 640 × 360 windows.
    Small,
}

/// Largest CPU core limit accepted per client.
pub const MAX_CPU_CORES: u32 = 64;

/// Seconds to watch for a launched client's process.
const WATCH_SECONDS: u32 = 30;

/// How a launched client is tuned. The default leaves the process unchanged.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Tuning {
    pub priority: ClientPriority,
    /// Logical cores the client may use. `0` allows every core.
    pub cpu_cores: u32,
    /// Size of the client's window once it opens. Windows only.
    pub window_size: Option<WindowSize>,
}

impl Tuning {
    /// Whether the process needs to be changed at all.
    pub fn changes_process(&self) -> bool {
        *self != Self::default()
    }
}

/// Tracks which Roblox processes Toolblox already tuned, so batch launches tune each new client
/// once.
#[derive(Debug, Default)]
pub struct ClientTuner {
    /// Process IDs claimed by a launch, with the account they belong to.
    claimed: Mutex<HashMap<u32, u64>>,
    /// Rotates which cores each limited client gets.
    next_slot: AtomicUsize,
}

impl ClientTuner {
    /// Claims a Roblox process that started after `before` and isn't claimed yet.
    fn claim(&self, before: &HashSet<u32>, running: &HashSet<u32>, account_id: u64) -> Option<u32> {
        let mut claimed = self.claimed.lock().ok()?;
        claimed.retain(|pid, _| running.contains(pid));
        let pid = running
            .iter()
            .copied()
            .filter(|pid| !before.contains(pid) && !claimed.contains_key(pid))
            .min()?;
        claimed.insert(pid, account_id);
        Some(pid)
    }

    /// Watches for the client a launch starts and tunes it. If Roblox replaces its first process,
    /// as it does while updating, the replacement is tuned too.
    ///
    /// ponytail: launches in a batch are matched to new processes in the order they appear. Two
    /// clients that start out of order swap tuning. Matching by command line needs process APIs
    /// Toolblox doesn't use yet.
    pub async fn watch(&self, before: HashSet<u32>, tuning: Tuning, account_id: u64) {
        let slot = self.next_slot.fetch_add(1, Ordering::Relaxed);
        let mask = affinity_mask(slot, tuning.cpu_cores, available_cores());
        let mut current = None;
        let mut sized = tuning.window_size.is_none();
        for _ in 0..WATCH_SECONDS {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            let Ok(Ok(running)) = tauri::async_runtime::spawn_blocking(roblox_pids).await else {
                continue;
            };
            if !current.is_some_and(|pid| running.contains(&pid)) {
                current = self.claim(&before, &running, account_id);
                sized = tuning.window_size.is_none();
                if let Some(pid) = current
                    && (tuning.priority != ClientPriority::Normal || mask.is_some())
                {
                    match apply(pid, tuning.priority, mask) {
                        Ok(()) => log::info!("Tuned Roblox client {pid} for account {account_id}"),
                        Err(error) => log::warn!("Roblox client {pid} couldn't be tuned: {error}"),
                    }
                }
            }
            if let (Some(pid), Some(size), false) = (current, tuning.window_size, sized) {
                sized = resize_client(pid, size);
            }
        }
        if current.is_none() {
            log::info!("No new Roblox client appeared for account {account_id}");
        }
    }
}

/// Seconds to wait for a launched client before the next launch.
const START_TIMEOUT_SECONDS: u32 = 20;
/// Seconds a new client gets to read Roblox's files before the next launch rewrites them.
const READ_FILES_SECONDS: u64 = 3;

/// Waits until a Roblox client that wasn't in `before` is running, then a little longer, so the
/// next launch can rewrite Roblox's files. Gives up after 20 seconds.
///
/// ponytail: the grace period is fixed. A client that reads its files later than that starts with
/// the next account's settings. Watching Roblox's log for the point it reads them would be exact.
pub async fn wait_for_client(before: &HashSet<u32>) {
    for _ in 0..START_TIMEOUT_SECONDS * 2 {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let started = tauri::async_runtime::spawn_blocking(roblox_pids)
            .await
            .ok()
            .and_then(Result::ok)
            .is_some_and(|running| running.iter().any(|pid| !before.contains(pid)));
        if started {
            tokio::time::sleep(std::time::Duration::from_secs(READ_FILES_SECONDS)).await;
            return;
        }
    }
    log::info!("No new Roblox client appeared before the next launch");
}

/// Number of logical cores, capped at the 64 one affinity mask can hold.
fn available_cores() -> u32 {
    std::thread::available_parallelism()
        .map_or(1, |count| count.get() as u32)
        .min(usize::BITS)
}

/// The cores client number `slot` may use: `cores` consecutive cores, starting where the previous
/// client's left off. Returns `None` when every core is allowed.
pub(crate) fn affinity_mask(slot: usize, cores: u32, available: u32) -> Option<usize> {
    if cores == 0 || cores >= available {
        return None;
    }
    let start = (slot * cores as usize) % available as usize;
    Some((0..cores as usize).fold(0, |mask, offset| {
        mask | 1 << ((start + offset) % available as usize)
    }))
}

/// Process IDs of the running Roblox clients.
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

/// Sets a client's priority and, on Windows, the cores it may use.
fn apply(pid: u32, priority: ClientPriority, mask: Option<usize>) -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{
            BELOW_NORMAL_PRIORITY_CLASS, IDLE_PRIORITY_CLASS, OpenProcess, PROCESS_SET_INFORMATION,
            SetPriorityClass, SetProcessAffinityMask,
        };

        // SAFETY: `OpenProcess` takes no pointers; a null result is handled.
        let process = unsafe { OpenProcess(PROCESS_SET_INFORMATION, 0, pid) };
        if process.is_null() {
            return Err("The Roblox client couldn't be opened. Has it closed?".into());
        }
        let class = match priority {
            ClientPriority::Normal => None,
            ClientPriority::BelowNormal => Some(BELOW_NORMAL_PRIORITY_CLASS),
            ClientPriority::Low => Some(IDLE_PRIORITY_CLASS),
        };
        // SAFETY: `process` is an open handle with set-information access, closed once below.
        let applied = unsafe {
            class.is_none_or(|class| SetPriorityClass(process, class) != 0)
                && mask.is_none_or(|mask| SetProcessAffinityMask(process, mask) != 0)
        };
        // SAFETY: `process` came from `OpenProcess` and isn't used again.
        unsafe { CloseHandle(process) };
        if applied {
            Ok(())
        } else {
            Err("The Roblox client's priority couldn't be changed. Has it closed?".into())
        }
    }
    #[cfg(target_os = "macos")]
    {
        unsafe extern "C" {
            fn setpriority(
                which: std::ffi::c_int,
                who: u32,
                priority: std::ffi::c_int,
            ) -> std::ffi::c_int;
        }
        const PRIO_PROCESS: std::ffi::c_int = 0;
        let _ = mask;
        let nice = match priority {
            ClientPriority::Normal => return Ok(()),
            ClientPriority::BelowNormal => 5,
            ClientPriority::Low => 15,
        };
        // SAFETY: `setpriority` takes no pointers.
        if unsafe { setpriority(PRIO_PROCESS, pid, nice) } == 0 {
            Ok(())
        } else {
            Err("The Roblox client's priority couldn't be changed. Has it closed?".into())
        }
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = (pid, priority, mask);
        Err("Changing client priority isn't supported on this platform.".into())
    }
}

/// A screen rectangle in physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// Offset between layers when fixed-size windows don't all fit on the screen.
const LAYER_OFFSET: i32 = 32;

/// Positions for `count` windows tiled in `area`, left to right and top to bottom.
pub(crate) fn tile_rects(count: usize, area: Rect, size: TileSize) -> Vec<Rect> {
    if count == 0 || area.width <= 0 || area.height <= 0 {
        return Vec::new();
    }
    let (width, height) = match size {
        TileSize::Fit => {
            let columns = (count as f64).sqrt().ceil() as usize;
            let rows = count.div_ceil(columns);
            (area.width / columns as i32, area.height / rows as i32)
        }
        TileSize::Medium => (960.min(area.width), 540.min(area.height)),
        TileSize::Small => (640.min(area.width), 360.min(area.height)),
    };
    let columns = (area.width / width).max(1) as usize;
    let rows = (area.height / height).max(1) as usize;
    (0..count)
        .map(|index| {
            let layer = (index / (columns * rows)) as i32;
            let cell = index % (columns * rows);
            Rect {
                x: area.x + (cell % columns) as i32 * width + layer * LAYER_OFFSET,
                y: area.y + (cell / columns) as i32 * height + layer * LAYER_OFFSET,
                width,
                height,
            }
        })
        .collect()
}

/// The visible, unowned top-level windows of the given processes, sorted by process ID.
#[cfg(windows)]
fn client_windows(pids: HashSet<u32>) -> Vec<(u32, windows_sys::Win32::Foundation::HWND)> {
    use windows_sys::Win32::Foundation::{HWND, LPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GW_OWNER, GetWindow, GetWindowThreadProcessId, IsWindowVisible,
    };

    struct Search {
        pids: HashSet<u32>,
        windows: Vec<(u32, HWND)>,
    }

    unsafe extern "system" fn visit(window: HWND, search: LPARAM) -> i32 {
        // SAFETY: `search` is the `Search` passed to `EnumWindows`, alive for the whole call.
        let search = unsafe { &mut *(search as *mut Search) };
        let mut pid = 0;
        // SAFETY: `window` comes from `EnumWindows` and `pid` is a valid out pointer.
        unsafe {
            GetWindowThreadProcessId(window, &mut pid);
            if search.pids.contains(&pid)
                && IsWindowVisible(window) != 0
                && GetWindow(window, GW_OWNER).is_null()
            {
                search.windows.push((pid, window));
            }
        }
        1
    }

    let mut search = Search {
        pids,
        windows: Vec::new(),
    };
    if !search.pids.is_empty() {
        // SAFETY: `visit` only casts the `LPARAM` back to `search`, which outlives the call.
        unsafe { EnumWindows(Some(visit), &mut search as *mut Search as LPARAM) };
    }
    search.windows.sort_by_key(|(pid, _)| *pid);
    search.windows
}

/// Restores a window from minimized or maximized, then gives it the rectangle. With
/// `keep_position`, only the size changes.
#[cfg(windows)]
fn place_window(window: windows_sys::Win32::Foundation::HWND, rect: Rect, keep_position: bool) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        IsIconic, IsZoomed, SW_RESTORE, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOZORDER, SetWindowPos,
        ShowWindow,
    };

    let flags = SWP_NOZORDER | SWP_NOACTIVATE | if keep_position { SWP_NOMOVE } else { 0 };
    // SAFETY: `window` is a top-level window found by `client_windows`. A window that closed since
    // then makes these calls fail harmlessly.
    unsafe {
        if IsIconic(window) != 0 || IsZoomed(window) != 0 {
            ShowWindow(window, SW_RESTORE);
        }
        SetWindowPos(
            window,
            std::ptr::null_mut(),
            rect.x,
            rect.y,
            rect.width,
            rect.height,
            flags,
        );
    }
}

/// Sizes a client's window. Returns whether the window was found. Does nothing outside Windows.
fn resize_client(pid: u32, size: WindowSize) -> bool {
    #[cfg(windows)]
    {
        let Some((_, window)) = client_windows(HashSet::from([pid])).into_iter().next() else {
            return false;
        };
        let rect = Rect {
            x: 0,
            y: 0,
            width: size.width,
            height: size.height,
        };
        place_window(window, rect, true);
        true
    }
    #[cfg(not(windows))]
    {
        let _ = (pid, size);
        true
    }
}

/// Tiles every visible Roblox client window on the primary screen and returns how many moved.
pub fn tile_windows(size: TileSize) -> Result<usize, String> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::RECT;
        use windows_sys::Win32::UI::WindowsAndMessaging::{SPI_GETWORKAREA, SystemParametersInfoW};

        let windows = client_windows(roblox_pids()?);
        if windows.is_empty() {
            return Ok(0);
        }
        let mut work = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        // SAFETY: `SPI_GETWORKAREA` writes one `RECT` to the pointer.
        let found = unsafe {
            SystemParametersInfoW(SPI_GETWORKAREA, 0, (&mut work as *mut RECT).cast(), 0)
        };
        if found == 0 {
            return Err("The screen size couldn't be read. Can you try again?".into());
        }
        let area = Rect {
            x: work.left,
            y: work.top,
            width: work.right - work.left,
            height: work.bottom - work.top,
        };
        let rects = tile_rects(windows.len(), area, size);
        for ((_, window), rect) in windows.iter().zip(&rects) {
            place_window(*window, *rect, false);
        }
        Ok(rects.len())
    }
    #[cfg(not(windows))]
    {
        let _ = size;
        Err("Tiling windows isn't supported on macOS yet.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_tuning_leaves_the_process_alone() {
        assert!(!Tuning::default().changes_process());
        let low = Tuning {
            priority: ClientPriority::Low,
            cpu_cores: 0,
            window_size: None,
        };
        assert!(low.changes_process());
    }

    #[test]
    fn affinity_rotates_through_the_cores() {
        assert_eq!(affinity_mask(0, 0, 8), None);
        assert_eq!(affinity_mask(0, 8, 8), None);
        assert_eq!(affinity_mask(0, 2, 8), Some(0b0000_0011));
        assert_eq!(affinity_mask(1, 2, 8), Some(0b0000_1100));
        assert_eq!(affinity_mask(3, 2, 8), Some(0b1100_0000));
        assert_eq!(affinity_mask(4, 2, 8), Some(0b0000_0011));
        assert_eq!(affinity_mask(2, 3, 8), Some(0b1100_0001));
        assert_eq!(affinity_mask(1, 1, 64), Some(0b10));
    }

    #[test]
    fn tasklist_rows_give_process_ids() {
        let text = "\"RobloxPlayerBeta.exe\",\"4120\",\"Console\",\"1\",\"512,000 K\"\r\n\
                    \"RobloxPlayerBeta.exe\",\"88\",\"Console\",\"1\",\"1 K\"\r\n\
                    INFO: No tasks are running which match the specified criteria.\r\n";
        assert_eq!(parse_tasklist(text), HashSet::from([4120, 88]));
    }

    #[test]
    fn claims_each_new_process_once() {
        let tuner = ClientTuner::default();
        let before = HashSet::from([1]);
        let running = HashSet::from([1, 7, 9]);
        assert_eq!(tuner.claim(&before, &running, 100), Some(7));
        assert_eq!(tuner.claim(&before, &running, 200), Some(9));
        assert_eq!(tuner.claim(&before, &running, 300), None);
        assert_eq!(
            tuner.claim(&before, &HashSet::from([1, 9, 12]), 300),
            Some(12)
        );
    }

    #[test]
    fn fit_tiles_fill_the_area_in_a_grid() {
        let area = Rect {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
        };
        assert!(tile_rects(0, area, TileSize::Fit).is_empty());
        assert_eq!(tile_rects(1, area, TileSize::Fit), [area]);
        let three = tile_rects(3, area, TileSize::Fit);
        assert_eq!(three.len(), 3);
        assert_eq!(
            three[2],
            Rect {
                x: 0,
                y: 540,
                width: 960,
                height: 540
            }
        );
    }

    #[test]
    fn fixed_tiles_wrap_then_layer() {
        let area = Rect {
            x: 10,
            y: 20,
            width: 1920,
            height: 1080,
        };
        let rects = tile_rects(10, area, TileSize::Small);
        assert_eq!(
            rects[3],
            Rect {
                x: 10,
                y: 380,
                width: 640,
                height: 360
            }
        );
        assert_eq!(
            rects[9],
            Rect {
                x: 10 + LAYER_OFFSET,
                y: 20 + LAYER_OFFSET,
                width: 640,
                height: 360
            }
        );
        let tiny = Rect {
            x: 0,
            y: 0,
            width: 500,
            height: 300,
        };
        assert_eq!(tile_rects(1, tiny, TileSize::Medium)[0], tiny);
    }
}
