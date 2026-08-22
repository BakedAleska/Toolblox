"""Fullscreen click-to-sample color picker for the Mana Bar Overlay's
color selector.

A borderless, topmost window covering the whole screen, made almost
fully transparent (alpha 0.02) so the desktop and any app beneath it
still shows through - the point is to intercept the click here rather
than let it pass through to whatever's underneath, unlike a global
mouse hook, which would also click whatever's under the cursor. Moving
the mouse continuously samples the screen pixel under the cursor (via
Pillow's ImageGrab, which reads the composited desktop) and shows a
small live preview swatch and hex label next to the cursor. Clicking
prints the sampled color and exits; Escape cancels.

Prints exactly one JSON line and exits, the same one-shot subprocess
pattern as area_picker.py in this same folder: `{"color": "#RRGGBB"}`
on a click, or `{"cancelled": true}` on Escape. Printing nothing at all
(e.g. the window was closed some other way) is treated by the caller
the same as a cancel.

Because the picker window itself is nearly (not perfectly) transparent,
a sampled pixel can be off by roughly 1 unit per color channel from the
true on-screen value - negligible for picking a highlight color by eye.

On Windows, this process is marked per-monitor DPI aware before the Tk
window is created (see _make_dpi_aware). Without that, Windows silently
scales the whole app to a virtualized, lower-resolution desktop when
display scaling is above 100% - `winfo_screenwidth`/`winfo_screenheight`
then under-report the real screen size (so the overlay doesn't actually
cover the whole screen) and ImageGrab samples at that same scaled-down
resolution (so the sampled pixel doesn't line up with the cursor).
Being DPI aware makes both sides agree on real physical pixels.

This is a duplicate of no other file - the Mana Bar Overlay section is
the only place in the app with a color wheel/eyedropper feature.
"""

import json
import sys
import tkinter as tk

from PIL import ImageGrab

INSTRUCTIONS = "Move to preview a color, click to pick it. Esc to cancel."

PREVIEW_SIZE = 18
PREVIEW_OFFSET = 20


def _make_dpi_aware() -> None:
    """Mark this process per-monitor DPI aware on Windows, before any Tk
    window is created.

    Falls back to the older, whole-desktop-only DPI-aware call if the
    per-monitor one isn't available (older Windows builds), and gives up
    silently if neither is - a picker that's slightly misaligned on an
    unusual setup is better than one that crashes outright.
    """
    if sys.platform != "win32":
        return
    import ctypes

    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except (AttributeError, OSError):
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except (AttributeError, OSError):
            pass


def _print(data: dict) -> None:
    print(json.dumps(data), flush=True)


def _sample(x: int, y: int) -> str:
    """The hex color of the screen pixel at (x, y), in global screen
    coordinates."""
    pixel = ImageGrab.grab(bbox=(x, y, x + 1, y + 1)).getpixel((0, 0))
    r, g, b = pixel[:3]
    return f"#{r:02X}{g:02X}{b:02X}"


def main() -> None:
    """Show the picker and block until the user clicks or cancels."""
    _make_dpi_aware()
    root = tk.Tk()
    root.overrideredirect(True)
    root.attributes("-topmost", True)
    try:
        root.attributes("-alpha", 0.02)
    except tk.TclError:
        pass

    screen_w, screen_h = root.winfo_screenwidth(), root.winfo_screenheight()
    root.geometry(f"{screen_w}x{screen_h}+0+0")

    canvas = tk.Canvas(root, width=screen_w, height=screen_h, bg="black", highlightthickness=0)
    canvas.pack(fill="both", expand=True)
    canvas.create_text(
        screen_w // 2, 24, text=INSTRUCTIONS, fill="white", font=("Segoe UI", 14, "bold")
    )

    state = {"swatch": None, "label_bg": None, "label": None}

    def _clear_preview():
        for key in ("swatch", "label_bg", "label"):
            if state[key] is not None:
                canvas.delete(state[key])
                state[key] = None

    def on_motion(event):
        try:
            color = _sample(event.x_root, event.y_root)
        except Exception:
            return
        _clear_preview()
        sx = event.x + PREVIEW_OFFSET
        sy = event.y + PREVIEW_OFFSET
        state["swatch"] = canvas.create_rectangle(
            sx, sy, sx + PREVIEW_SIZE, sy + PREVIEW_SIZE, fill=color, outline="white"
        )
        text_x = sx + PREVIEW_SIZE + 6
        state["label"] = canvas.create_text(
            text_x, sy + PREVIEW_SIZE / 2, text=color, fill="white", anchor="w",
            font=("Segoe UI", 11, "bold"),
        )
        bbox = canvas.bbox(state["label"])
        state["label_bg"] = canvas.create_rectangle(bbox, fill="black", outline="")
        canvas.tag_lower(state["label_bg"], state["label"])

    def on_click(event):
        try:
            color = _sample(event.x_root, event.y_root)
        except Exception:
            root.destroy()
            return
        _print({"color": color})
        root.destroy()

    def on_cancel(event=None):
        _print({"cancelled": True})
        root.destroy()

    canvas.bind("<Motion>", on_motion)
    canvas.bind("<ButtonPress-1>", on_click)
    root.bind("<Escape>", on_cancel)
    root.focus_force()

    root.mainloop()


if __name__ == "__main__":
    main()
