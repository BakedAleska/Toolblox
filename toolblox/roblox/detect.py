"""Detects whether a Roblox game client process is currently running, or
is the active (foreground) window.

Used by widgets, such as Image Overlay and Rogue Lineage's Mana bar
overlay, that should only act while Roblox itself is open or focused.
This is plain OS inspection - process listing for "running", and the
foreground window/frontmost app for "active" - rather than adding a
dependency like psutil, unrelated to the account/login/join flow the
rest of `toolblox/roblox/` handles.
"""

import subprocess
import sys
from pathlib import Path

WINDOWS_PROCESS_NAME = "RobloxPlayerBeta.exe"
MACOS_PROCESS_NAME = "RobloxPlayer"


def is_roblox_running() -> bool:
    """Return True if a Roblox game client process is currently running.

    Shells out to the OS's own process listing (`tasklist` on Windows,
    `pgrep` on macOS) rather than adding a dependency like psutil. Pure
    and blocking, so callers on the Flet event loop should run it via
    `asyncio.to_thread` rather than calling it directly. Never raises;
    any failure to read the process list is treated as "not running".
    """
    try:
        if sys.platform == "win32":
            result = subprocess.run(
                ["tasklist", "/FI", f"IMAGENAME eq {WINDOWS_PROCESS_NAME}", "/NH"],
                capture_output=True,
                text=True,
                timeout=5,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
            return WINDOWS_PROCESS_NAME.lower() in result.stdout.lower()
        if sys.platform == "darwin":
            result = subprocess.run(
                ["pgrep", "-x", MACOS_PROCESS_NAME],
                capture_output=True,
                text=True,
                timeout=5,
            )
            return result.returncode == 0
        return False
    except (OSError, subprocess.TimeoutExpired):
        return False


def _foreground_process_name_windows() -> str:
    """The file name of the process owning the current foreground window,
    or "" if it can't be determined.
    """
    import ctypes
    from ctypes import wintypes

    hwnd = ctypes.windll.user32.GetForegroundWindow()
    if not hwnd:
        return ""
    pid = wintypes.DWORD()
    ctypes.windll.user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    if not pid.value:
        return ""
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    handle = ctypes.windll.kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid.value)
    if not handle:
        return ""
    try:
        buffer = ctypes.create_unicode_buffer(260)
        size = wintypes.DWORD(260)
        if not ctypes.windll.kernel32.QueryFullProcessImageNameW(
            handle, 0, buffer, ctypes.byref(size)
        ):
            return ""
        return buffer.value
    finally:
        ctypes.windll.kernel32.CloseHandle(handle)


def _frontmost_app_name_macos() -> str:
    """The name of the frontmost app, via System Events, or "" on failure."""
    try:
        result = subprocess.run(
            [
                "osascript",
                "-e",
                'tell application "System Events" to get name of first '
                "application process whose frontmost is true",
            ],
            capture_output=True,
            text=True,
            timeout=5,
        )
        return result.stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        return ""


def is_roblox_active() -> bool:
    """Return True if Roblox is currently the active (foreground) window.

    Stricter than `is_roblox_running`: a Roblox process sitting in the
    background (alt-tabbed away, behind another window) counts as not
    active here, even though it's still running. Pure and blocking, so
    callers on the Flet event loop should run it via `asyncio.to_thread`.
    Never raises; any failure to read the foreground window is treated as
    "not active".
    """
    try:
        if sys.platform == "win32":
            name = _foreground_process_name_windows()
            return bool(name) and Path(name).name.lower() == WINDOWS_PROCESS_NAME.lower()
        if sys.platform == "darwin":
            return _frontmost_app_name_macos() == MACOS_PROCESS_NAME
        return False
    except OSError:
        return False
