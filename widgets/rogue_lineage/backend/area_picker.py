"""Fullscreen click-and-drag rectangle picker for the Mana Bar Overlay section.

A borderless, topmost window covering the whole screen, dimmed so the
selected rectangle stands out against it. Click and drag to draw a
rectangle; press Enter to confirm it or Escape to cancel. Prints exactly
one JSON line and exits, the same one-shot subprocess pattern
toolblox/roblox/login.py uses: `{"x", "y", "width", "height"}` on
confirm, or `{"cancelled": true}` on cancel. Printing nothing at all
(e.g. the window was closed some other way) is treated by the caller
the same as a cancel.

This is a duplicate of widgets/image_overlay/backend/area_picker.py -
each widget folder is independently installable, so it can't import
another widget's backend script.
"""

import json
import tkinter as tk

INSTRUCTIONS = "Click and drag to select an area. Enter confirms, Esc exits."

ACCENT = "#00E5FF"
"""Bright cyan used for the selection outline and handles. Chosen for
high contrast against both light and dark desktop backgrounds, which a
pure red border struggled with on busy or reddish wallpapers.
"""

HANDLE_SIZE = 8


def _print(data: dict) -> None:
    print(json.dumps(data), flush=True)


def main() -> None:
    """Show the picker and block until the user confirms or cancels."""
    root = tk.Tk()
    root.overrideredirect(True)
    root.attributes("-topmost", True)
    try:
        root.attributes("-alpha", 0.45)
    except tk.TclError:
        pass

    screen_w, screen_h = root.winfo_screenwidth(), root.winfo_screenheight()
    root.geometry(f"{screen_w}x{screen_h}+0+0")

    canvas = tk.Canvas(root, width=screen_w, height=screen_h, bg="black", highlightthickness=0)
    canvas.pack(fill="both", expand=True)

    canvas.create_rectangle(
        2, 2, screen_w - 2, screen_h - 2, outline=ACCENT, width=4
    )

    banner = canvas.create_rectangle(
        0, 0, screen_w, 44, fill="black", outline=""
    )
    canvas.create_text(
        screen_w // 2, 22, text=INSTRUCTIONS, fill="white", font=("Segoe UI", 14, "bold")
    )
    canvas.tag_raise(banner)

    state = {
        "start": None,
        "current": None,
        "fill": None,
        "outline": None,
        "handles": [],
        "label_bg": None,
        "label": None,
        "shade": [],
    }

    def _clear_selection():
        for key in ("fill", "outline", "label_bg", "label"):
            if state[key] is not None:
                canvas.delete(state[key])
                state[key] = None
        for handle in state["handles"]:
            canvas.delete(handle)
        state["handles"] = []
        for shade in state["shade"]:
            canvas.delete(shade)
        state["shade"] = []

    def _draw_shade(x0: int, y0: int, x1: int, y1: int):
        """Darken the area outside the selection a bit more than the
        base dim, using four rectangles around the hole, so the
        selected region reads as visibly brighter than its surroundings
        rather than just outlined.
        """
        for shade in state["shade"]:
            canvas.delete(shade)
        state["shade"] = [
            canvas.create_rectangle(0, 0, screen_w, y0, fill="black", stipple="gray50", outline=""),
            canvas.create_rectangle(0, y1, screen_w, screen_h, fill="black", stipple="gray50", outline=""),
            canvas.create_rectangle(0, y0, x0, y1, fill="black", stipple="gray50", outline=""),
            canvas.create_rectangle(x1, y0, screen_w, y1, fill="black", stipple="gray50", outline=""),
        ]
        for shade in state["shade"]:
            canvas.tag_lower(shade)

    def _draw_handles(x0: int, y0: int, x1: int, y1: int):
        for handle in state["handles"]:
            canvas.delete(handle)
        h = HANDLE_SIZE / 2
        state["handles"] = [
            canvas.create_rectangle(cx - h, cy - h, cx + h, cy + h, fill=ACCENT, outline="black")
            for cx, cy in ((x0, y0), (x1, y0), (x0, y1), (x1, y1))
        ]

    def _draw_label(x0: int, y0: int, x1: int, y1: int, width: int, height: int):
        if state["label_bg"] is not None:
            canvas.delete(state["label_bg"])
        if state["label"] is not None:
            canvas.delete(state["label"])
        text = f"{width} x {height}"
        label_y = y0 - 12 if y0 > 24 else y1 + 12
        state["label"] = canvas.create_text(
            (x0 + x1) // 2, label_y, text=text, fill="white", font=("Segoe UI", 11, "bold")
        )
        bbox = canvas.bbox(state["label"])
        padding = 4
        state["label_bg"] = canvas.create_rectangle(
            bbox[0] - padding, bbox[1] - padding, bbox[2] + padding, bbox[3] + padding,
            fill="black", outline=ACCENT,
        )
        canvas.tag_lower(state["label_bg"], state["label"])

    def on_press(event):
        _clear_selection()
        state["start"] = (event.x, event.y)
        state["current"] = (event.x, event.y)

    def on_drag(event):
        if state["start"] is None:
            return
        state["current"] = (event.x, event.y)
        x0, y0 = state["start"]
        x1, y1 = state["current"]
        left, top = min(x0, x1), min(y0, y1)
        right, bottom = max(x0, x1), max(y0, y1)

        _draw_shade(left, top, right, bottom)

        if state["fill"] is not None:
            canvas.delete(state["fill"])
        state["fill"] = canvas.create_rectangle(
            left, top, right, bottom, fill=ACCENT, stipple="gray25", outline=""
        )

        if state["outline"] is not None:
            canvas.delete(state["outline"])
        state["outline"] = canvas.create_rectangle(
            left, top, right, bottom, outline=ACCENT, width=3
        )

        _draw_handles(left, top, right, bottom)
        _draw_label(left, top, right, bottom, right - left, bottom - top)

    def on_confirm(event=None):
        if state["start"] is None or state["current"] is None:
            return
        x0, y0 = state["start"]
        x1, y1 = state["current"]
        x, y = min(x0, x1), min(y0, y1)
        width, height = abs(x1 - x0), abs(y1 - y0)
        if width < 4 or height < 4:
            return
        _print({"x": x, "y": y, "width": width, "height": height})
        root.destroy()

    def on_cancel(event=None):
        _print({"cancelled": True})
        root.destroy()

    canvas.bind("<ButtonPress-1>", on_press)
    canvas.bind("<B1-Motion>", on_drag)
    root.bind("<Return>", on_confirm)
    root.bind("<KP_Enter>", on_confirm)
    root.bind("<Escape>", on_cancel)
    root.focus_force()

    root.mainloop()


if __name__ == "__main__":
    main()
