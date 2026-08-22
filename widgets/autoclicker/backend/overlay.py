"""On-screen "Autoclicker running" indicator, shown as its own process.

A small always-on-top, borderless window pinned to a screen corner, so
it stays visible over whatever else is on screen (e.g. the game window)
while the click loop is running. It has no output protocol: widget.py
just starts it alongside the click backend and terminates it when
clicking stops, the same lifecycle as any other widget backend process.

Built with tkinter instead of a platform-native script, since it ships
with the standard CPython install on both Windows and macOS and a
borderless topmost window doesn't need anything more than that.

On Windows the window is also made click-through, via a Win32 extended
style flag, so it never intercepts a click meant for whatever's under
it. tkinter has no equivalent for that on macOS, so there the indicator
is topmost but not click-through; it's kept small and corner-pinned to
stay out of the way.
"""

import argparse
import sys
import tkinter as tk

WINDOW_TITLE = "Autoclicker Indicator"


def _make_click_through_windows(root: tk.Tk) -> None:
    """Best-effort: let clicks pass through the indicator on Windows."""
    try:
        import ctypes

        hwnd = ctypes.windll.user32.GetParent(root.winfo_id())
        GWL_EXSTYLE = -20
        WS_EX_LAYERED = 0x80000
        WS_EX_TRANSPARENT = 0x20
        style = ctypes.windll.user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
        ctypes.windll.user32.SetWindowLongW(
            hwnd, GWL_EXSTYLE, style | WS_EX_LAYERED | WS_EX_TRANSPARENT
        )
    except Exception:
        pass


def main() -> None:
    """Build and show the borderless indicator window, then block on it.

    Runs until the parent process kills it; the window itself has no
    close button and no stdout protocol of its own.

    Position defaults to the bottom-right corner, but `--x`/`--y` (the
    dummy indicator's dragged position, from backend/position_picker.py)
    override that when both are given.
    """
    parser = argparse.ArgumentParser()
    parser.add_argument("--x", type=int, default=None)
    parser.add_argument("--y", type=int, default=None)
    args = parser.parse_args()

    root = tk.Tk()
    root.title(WINDOW_TITLE)
    root.overrideredirect(True)
    root.attributes("-topmost", True)
    try:
        root.attributes("-alpha", 0.85)
    except tk.TclError:
        pass

    screen_width = root.winfo_screenwidth()
    screen_height = root.winfo_screenheight()
    width, height = 170, 36
    if args.x is not None and args.y is not None:
        x, y = args.x, args.y
    else:
        margin = 24
        x = screen_width - width - margin
        y = screen_height - height - margin - 40
    root.geometry(f"{width}x{height}+{x}+{y}")

    frame = tk.Frame(root, bg="#1b1b1b")
    frame.pack(fill="both", expand=True)
    dot = tk.Label(frame, text="●", fg="#3ddc84", bg="#1b1b1b", font=("Segoe UI", 12))
    dot.pack(side="left", padx=(10, 4))
    label = tk.Label(
        frame, text="Autoclicker ON", fg="#f2f2f2", bg="#1b1b1b", font=("Segoe UI", 10, "bold")
    )
    label.pack(side="left", padx=(0, 10))

    if sys.platform == "win32":
        root.after(50, lambda: _make_click_through_windows(root))

    root.mainloop()


if __name__ == "__main__":
    main()
