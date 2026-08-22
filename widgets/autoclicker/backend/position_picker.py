"""Drag-to-position picker for the Autoclicker's on-screen indicator.

Shows a borderless, topmost, draggable window sized and styled exactly
like the real indicator (see overlay.py) so what the user drags around
is a true preview of what they'll see while clicking, not an abstract
rectangle. A small fixed instruction bar pinned to the top of the screen
explains the controls without moving along with the dummy.

Same one-shot subprocess pattern as
widgets/rogue_lineage/backend/area_picker.py: prints exactly one JSON
line and exits. `{"x", "y"}` (the dummy's top-left corner) on confirm,
`{"cancelled": true}` on cancel. Printing nothing at all is treated by
the caller the same as a cancel.
"""

import json
import tkinter as tk

INSTRUCTIONS = "Drag the indicator to where you want it. Enter to confirm, Esc to cancel."

WIDTH, HEIGHT = 170, 36
"""Matches overlay.py's real indicator size, so the dummy previews the
actual on-screen footprint rather than a placeholder shape."""

ACCENT = "#00E5FF"


def _print(data: dict) -> None:
    print(json.dumps(data), flush=True)


def main() -> None:
    """Show the draggable dummy indicator and block until confirm/cancel."""
    root = tk.Tk()
    root.overrideredirect(True)
    root.attributes("-topmost", True)
    try:
        root.attributes("-alpha", 0.9)
    except tk.TclError:
        pass

    screen_w, screen_h = root.winfo_screenwidth(), root.winfo_screenheight()
    start_x = screen_w - WIDTH - 24
    start_y = screen_h - HEIGHT - 24 - 40
    root.geometry(f"{WIDTH}x{HEIGHT}+{start_x}+{start_y}")

    frame = tk.Frame(root, bg="#1b1b1b", highlightthickness=2, highlightbackground=ACCENT)
    frame.pack(fill="both", expand=True)
    dot = tk.Label(frame, text="●", fg="#3ddc84", bg="#1b1b1b", font=("Segoe UI", 12))
    dot.pack(side="left", padx=(10, 4))
    label = tk.Label(
        frame, text="Autoclicker ON", fg="#f2f2f2", bg="#1b1b1b", font=("Segoe UI", 10, "bold")
    )
    label.pack(side="left", padx=(0, 10))

    banner = tk.Toplevel(root)
    banner.overrideredirect(True)
    banner.attributes("-topmost", True)
    banner_width = max(WIDTH, 520)
    banner.geometry(f"{banner_width}x36+{(screen_w - banner_width) // 2}+0")
    banner_frame = tk.Frame(banner, bg="black")
    banner_frame.pack(fill="both", expand=True)
    tk.Label(
        banner_frame, text=INSTRUCTIONS, fg="white", bg="black", font=("Segoe UI", 11, "bold")
    ).pack(expand=True)

    drag_offset = {"x": 0, "y": 0}

    def on_press(event):
        drag_offset["x"] = event.x
        drag_offset["y"] = event.y

    def on_drag(event):
        x = root.winfo_pointerx() - drag_offset["x"]
        y = root.winfo_pointery() - drag_offset["y"]
        root.geometry(f"+{x}+{y}")

    for widget in (frame, dot, label):
        widget.bind("<ButtonPress-1>", on_press)
        widget.bind("<B1-Motion>", on_drag)

    def on_confirm(event=None):
        _print({"x": root.winfo_x(), "y": root.winfo_y()})
        root.destroy()

    def on_cancel(event=None):
        _print({"cancelled": True})
        root.destroy()

    root.bind("<Return>", on_confirm)
    root.bind("<KP_Enter>", on_confirm)
    root.bind("<Escape>", on_cancel)
    root.focus_force()

    root.mainloop()


if __name__ == "__main__":
    main()
