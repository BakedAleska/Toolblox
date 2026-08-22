"""Always-on-top borderless window that draws a rectangle with translucent
highlight bands, meant to sit directly on top of an in-game resource bar
(a mana bar, in Rogue Lineage) so its thresholds are easy to spot at a
glance.

This is the "dumb" version: it doesn't look at the screen at all, it
just draws shapes at whatever area and highlight ranges the widget's own
UI was configured with. A smarter version that finds the bar itself via
image recognition, instead of the user picking the area by hand, is a
possible future addition, not implemented here.

Same borderless/topmost/click-through pattern as
widgets/image_overlay/backend/overlay_image.py for the main window, which
only draws the border rectangle. Each highlight is a second, separate
borderless window instead of a shape on the same canvas: tkinter's Canvas
has no true per-shape alpha, only dither stipples, so a real adjustable
transparency needs its own window with its own `-alpha` attribute, which
Tk supports on both Windows and macOS (unlike `-transparentcolor`, which
is Windows-only and is what the main window still uses for the space
inside the border that isn't part of a highlight).

A highlight's start/end are percentages (0-100) along the bar's fill
axis, picked automatically from the area's own shape (see _orientation):
left-to-right for a wider-than-tall area, bottom-to-top for a
taller-than-wide one, matching how a resource bar conventionally fills.
There's no separate orientation setting - the picked area's own shape is
the answer.

Exits after printing one JSON line: `{"ready": true}` once the window is
up, or `{"error": "..."}` if the highlights couldn't be parsed. It has no
further stdout protocol after that, and no stdin protocol at all; the
widget stops it by terminating the process, same as Image Overlay.

The normal way this process ends is Toolblox itself calling
`stop_process` on a clean window close, Stop press, or Roblox going
inactive - but that path only runs if Toolblox shuts down cleanly. If
Toolblox crashes, is killed from Task Manager, or the machine loses
power mid-session, nothing ever sends this process a terminate signal,
and it would otherwise sit there forever: borderless, no taskbar entry,
easy to alt-tab past and hard to even notice is still running, let alone
close. See _watch_parent - this process checks Toolblox's own pid
periodically and closes itself the moment that pid is gone, so it can
never outlive Toolblox by more than a few seconds regardless of how
Toolblox went away.

That pid is passed in explicitly via `--parent-pid`, rather than trusted
from `os.getppid()`. On a Windows venv, `sys.executable` is a small
launcher stub that re-execs the real interpreter as its own child and
stays resident supervising it - so this process's actual OS parent is
that stub, not Toolblox itself, and the stub can be left running (also
orphaned, also with nothing to stop it) even after Toolblox is gone.
Watching `os.getppid()` would then watch a process that outlives
Toolblox, defeating the whole point. Toolblox already knows its own
real pid from inside its own running code (`os.getpid()`, always
accurate for "what am I," unlike asking about ancestry), so it hands
that down directly instead.
"""

import argparse
import json
import os
import sys
import tkinter as tk

TRANSPARENT_KEY = "#010101"
"""Near-black fill color for the space inside the area that isn't part
of the border or a highlight band. On Windows this is set as the main
window's transparent color, so that space is see-through and the real
bar underneath shows through. There's no tkinter equivalent on macOS, so
it shows as a solid near-black box there instead.
"""

BORDER_COLOR = "#00E5FF"
"""Default border color/width, used when the widget doesn't pass
--border-color/--border-width explicitly (e.g. highlight windows that
still reference BORDER_COLOR as their own fallback)."""
BORDER_WIDTH = 2

DEFAULT_TRANSPARENCY = 0.5
"""How see-through a highlight is by default, on the widget's own 0-1
scale where 1 is fully transparent (invisible) and 0 is fully opaque.
Applied to highlights saved before this field existed, same fallback
pattern as multi_instance settings elsewhere in the app.
"""

PARENT_CHECK_INTERVAL_MS = 3000
"""How often the failsafe watchdog checks whether Toolblox is still
running. Cheap enough (one process lookup) to poll this often without it
mattering, and short enough that an orphaned overlay never lingers for
more than a few seconds.
"""


def _print(data: dict) -> None:
    print(json.dumps(data), flush=True)


def _make_click_through_windows(win) -> None:
    """Best-effort: let clicks pass through a window on Windows."""
    try:
        import ctypes

        hwnd = ctypes.windll.user32.GetParent(win.winfo_id())
        GWL_EXSTYLE = -20
        WS_EX_LAYERED = 0x80000
        WS_EX_TRANSPARENT = 0x20
        style = ctypes.windll.user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
        ctypes.windll.user32.SetWindowLongW(
            hwnd, GWL_EXSTYLE, style | WS_EX_LAYERED | WS_EX_TRANSPARENT
        )
    except Exception:
        pass


def _process_alive(pid: int) -> bool:
    """Whether a process with this pid is still running.

    Windows has no equivalent to POSIX's `os.kill(pid, 0)` existence
    check, so it opens a handle to the pid and asks it for its own exit
    code. A successful `OpenProcess` on its own isn't enough - the
    kernel keeps a pid's process object alive, and openable, for as long
    as anything still holds a handle to it (e.g. whatever originally
    launched Toolblox), even well after the process itself has actually
    exited - so this checks `GetExitCodeProcess` for STILL_ACTIVE rather
    than trusting the open to mean "running".
    """
    if sys.platform == "win32":
        import ctypes
        from ctypes import wintypes

        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        STILL_ACTIVE = 259
        handle = ctypes.windll.kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            return False
        try:
            exit_code = wintypes.DWORD()
            if not ctypes.windll.kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
                return False
            return exit_code.value == STILL_ACTIVE
        finally:
            ctypes.windll.kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False


def _watch_parent(root: tk.Tk, parent_pid: int) -> None:
    """Failsafe: close this whole overlay the moment Toolblox itself is
    no longer running, regardless of whether it shut down cleanly.

    Reschedules itself via `root.after` for as long as the parent is
    alive, so this is the process's only ongoing background work besides
    the Tk event loop itself. `root.destroy()` tears down every window
    this process owns, including each highlight Toplevel, so a single
    check here is enough to clean up the whole overlay.
    """
    if not _process_alive(parent_pid):
        root.destroy()
        return
    root.after(PARENT_CHECK_INTERVAL_MS, lambda: _watch_parent(root, parent_pid))


def _orientation(width: int, height: int) -> str:
    """Which way the bar fills, guessed from the picked area's own shape.

    A taller-than-wide area is a vertical bar, filling bottom-to-top; a
    wider-than-tall (or square) area is a horizontal bar, filling
    left-to-right. There's no user-facing setting for this - the shape
    of the rectangle the user already picked over the real bar is
    itself the answer.
    """
    return "vertical" if height > width else "horizontal"


def _highlight_rects(
    x: int, y: int, width: int, height: int, highlights: list[dict]
) -> list[tuple[int, int, int, int, str, float]]:
    """Absolute screen (x, y, width, height, color, transparency) for each
    highlight band, along the bar's fill axis.

    A vertical bar's 0% is its bottom edge and 100% its top edge; a
    horizontal bar's 0% is its left edge and 100% its right edge.
    """
    orientation = _orientation(width, height)
    rects = []
    for highlight in highlights:
        start = max(0.0, min(100.0, float(highlight["start"])))
        end = max(0.0, min(100.0, float(highlight["end"])))
        if end <= start:
            continue
        color = highlight.get("color") or BORDER_COLOR
        transparency = float(highlight.get("transparency", DEFAULT_TRANSPARENCY))
        transparency = max(0.0, min(1.0, transparency))
        if orientation == "vertical":
            y0 = height * (1 - end / 100)
            y1 = height * (1 - start / 100)
            rects.append((x, round(y + y0), width, round(y1 - y0), color, transparency))
        else:
            x0 = width * start / 100
            x1 = width * end / 100
            rects.append((round(x + x0), y, round(x1 - x0), height, color, transparency))
    return rects


def _create_highlight_window(
    root: tk.Tk, x: int, y: int, width: int, height: int, color: str, transparency: float,
    click_through: bool,
) -> "tk.Toplevel | None":
    """A borderless, topmost, solid-color window with real per-window
    alpha - the actual translucent band a user sees over one highlight
    range.
    """
    if width <= 0 or height <= 0:
        return None
    win = tk.Toplevel(root)
    win.overrideredirect(True)
    win.attributes("-topmost", True)
    win.configure(bg=color)
    win.geometry(f"{width}x{height}+{x}+{y}")
    try:
        win.attributes("-alpha", 1 - transparency)
    except tk.TclError:
        pass
    if click_through and sys.platform == "win32":
        win.after(50, lambda: _make_click_through_windows(win))
    return win


def main() -> None:
    """Parse arguments, draw the border rectangle and its highlight
    windows, then block.

    Exits with status 1 and one `{"error": "..."}` line if `--highlights`
    isn't valid JSON. On success, prints `{"ready": true}` once the
    window is showing and then blocks in `mainloop()` until the parent
    process kills it - or, failing that, until _watch_parent notices
    Toolblox itself is gone and closes this process on its own.
    """
    parser = argparse.ArgumentParser()
    parser.add_argument("--x", type=int, default=0)
    parser.add_argument("--y", type=int, default=0)
    parser.add_argument("--width", type=int, required=True)
    parser.add_argument("--height", type=int, required=True)
    parser.add_argument("--highlights", default="[]")
    parser.add_argument("--border-color", default=BORDER_COLOR)
    parser.add_argument("--border-width", type=int, default=BORDER_WIDTH)
    parser.add_argument("--click-through", action="store_true")
    parser.add_argument("--parent-pid", type=int, default=None)
    args = parser.parse_args()
    border_width = max(1, args.border_width)

    try:
        highlights = json.loads(args.highlights)
    except ValueError as e:
        _print({"error": f"Couldn't read the highlight ranges. {e}"})
        sys.exit(1)

    root = tk.Tk()
    root.withdraw()
    root.overrideredirect(True)
    root.attributes("-topmost", True)
    root.geometry(f"{args.width}x{args.height}+{args.x}+{args.y}")

    canvas = tk.Canvas(
        root, width=args.width, height=args.height, bg=TRANSPARENT_KEY, highlightthickness=0
    )
    canvas.pack(fill="both", expand=True)
    canvas.create_rectangle(
        border_width // 2 or 1,
        border_width // 2 or 1,
        args.width - (border_width // 2 or 1),
        args.height - (border_width // 2 or 1),
        outline=args.border_color,
        width=border_width,
    )

    root.deiconify()

    if sys.platform == "win32":
        try:
            root.attributes("-transparentcolor", TRANSPARENT_KEY)
        except tk.TclError:
            pass

    if args.click_through and sys.platform == "win32":
        root.after(50, lambda: _make_click_through_windows(root))

    _highlight_windows = [
        _create_highlight_window(root, x, y, width, height, color, transparency, args.click_through)
        for x, y, width, height, color, transparency in _highlight_rects(
            args.x, args.y, args.width, args.height, highlights
        )
    ]

    watched_pid = args.parent_pid if args.parent_pid is not None else os.getppid()
    root.after(PARENT_CHECK_INTERVAL_MS, lambda: _watch_parent(root, watched_pid))

    _print({"ready": True})
    root.mainloop()


if __name__ == "__main__":
    main()
