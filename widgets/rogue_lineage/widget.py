"""Rogue Lineage: track characters, their class, race, notes, and items.

A character's username is always typed in by hand. If it's similar to one
of Toolblox's own tracked accounts, pressing Tab while the field is
focused autofills the full match - and once it's an exact match, the
character starts syncing with that account automatically (see
storage.sync_with_accounts): its username and avatar follow the account
from then on, kept in sync automatically, and it falls back to standalone
again if the account is later removed. Every screen build starts a
background loop that re-checks the roster against the current account
list every few seconds, so this happens without reopening the widget.

Class, race, and item choices come from a bundled reference.json, editable
by hand - see reference.py's docstring. Every dropdown built from that
list also offers "Other...", so an incomplete list never blocks entering
real data.

The Mana bar overlay section pins a rectangle, with shaded highlight
bands inside it, directly over a screen area the user picks by hand -
meant to sit on top of an in-game resource bar so its thresholds are
easy to spot at a glance. It draws shapes rather than pinning an image
(see widgets/image_overlay), so it's never off-size or off-position the
way an image can be when the real bar doesn't match the picture's exact
dimensions. This is the "dumb" version: the user places the rectangle
and its highlights by hand. Finding the bar itself via image recognition
is a possible future addition, not implemented here.

The Keybinds section remaps a physical key onto one of Rogue Lineage's own
hotbar keys - 1-9, 0, -, = - system-wide, via backend/key_remapper.py
(see its own docstring for why that's a separate `keyboard`-library
backend rather than the pynput hotkey listener Autoclicker uses). Windows
only.
"""

import asyncio
import colorsys
import json
import math
import os
import re
import sys
from pathlib import Path
from typing import Callable, Optional

import flet as ft

from toolblox.data import accounts as accounts_store
from toolblox.logs import get_logger
from toolblox.roblox.detect import is_roblox_active
from toolblox.state import get_widget_setting, set_widget_setting
from toolblox.ui.layout import build_layout, widget_route
from toolblox.ui.style import (
    DIALOG_WIDTH,
    RADIUS_PILL,
    SPACE_LG,
    SPACE_MD,
    SPACE_SM,
    SPACE_XS,
    card_border,
    radius_card,
    radius_menu,
    scroll_margin,
    section_box,
    status_dot,
    text_caption,
    text_heading,
    text_label,
    text_section,
    text_title,
)
from toolblox.ui.toast import show_confirm_toast, show_toast
from toolblox.widgets.api import Widget
from toolblox.widgets.process import WidgetProcess, start_process, stop_process

from . import reference, storage

logger = get_logger(__name__)

LOGO_PATH = str(Path(__file__).parent / "assets" / "RogueLineage.svg")
_RACE_ICONS_DIR = Path(__file__).parent / "assets"
_RACE_ICON_SIZE = 16


def _race_icon_path(race: str) -> str | None:
    """Path to race's bundled icon (assets/<race>.png), or None if that
    race has no icon yet - not every entry in reference.json's races list
    has a matching png."""
    icon_path = _RACE_ICONS_DIR / f"{race}.png"
    return str(icon_path) if icon_path.is_file() else None

WIDGET_ID = "rogue_lineage"
_GENERATION_KEY = f"_{WIDGET_ID}_generation"
_DIALOG_OPEN_KEY = f"_{WIDGET_ID}_dialog_open"
_SYNC_INTERVAL_SECONDS = 10

_OTHER_KEY = "__other__"

MANA_BACKEND_SCRIPT = Path(__file__).parent / "backend" / "mana_bar_overlay.py"
MANA_AREA_PICKER_SCRIPT = Path(__file__).parent / "backend" / "area_picker.py"

_MANA_PROCESS_KEY = f"_{WIDGET_ID}_mana_process"
_MANA_POLL_STATE_KEY = f"_{WIDGET_ID}_mana_poll_state"

DEFAULT_MANA_AREA = {"x": 100, "y": 100, "width": 300, "height": 30}
DEFAULT_MANA_HIGHLIGHTS: list = []
DEFAULT_MANA_CLICK_THROUGH = True
DEFAULT_MANA_WAIT_FOR_ROBLOX = True
MANA_POLL_INTERVAL_SECONDS = 1.0
"""Checked against `is_roblox_active`, not just `is_roblox_running` -
tighter than Image Overlay's own 3-second poll, since a user alt-tabbing
away from Roblox expects the overlay to hide close to immediately, not
after a multi-second lag."""

DEFAULT_HIGHLIGHT_COLOR_HEX = "#00E5FF"
DEFAULT_HIGHLIGHT_TRANSPARENCY = 0.5
DEFAULT_BORDER_COLOR_HEX = "#00E5FF"
DEFAULT_BORDER_WIDTH = 2

KEY_REMAPPER_SCRIPT = Path(__file__).parent / "backend" / "key_remapper.py"

_KEYREMAP_PROCESS_KEY = f"_{WIDGET_ID}_keyremap_process"
_KEYREMAP_CONFIG_KEY = f"_{WIDGET_ID}_keyremap_config"
_KEYREMAP_GENERATION_KEY = f"_{WIDGET_ID}_keyremap_generation"
_KEYREMAP_CHAT_OPEN_KEY = f"_{WIDGET_ID}_keyremap_chat_open"

DEFAULT_KEY_REMAPS: list = []
DEFAULT_KEYREMAP_WAIT_FOR_ROBLOX = True
DEFAULT_KEYREMAP_STOP_WHEN_CHAT_OPEN = True
KEYREMAP_POLL_INTERVAL_SECONDS = 1.0
"""Same cadence as MANA_POLL_INTERVAL_SECONDS - checked against
is_roblox_active whenever "Only while Roblox is active" is on, and also
how quickly an added/removed/changed keybind reaches the running
remapper process."""

OUTPUT_KEY_OPTIONS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "-", "="]
"""The only keys a keybind is allowed to output. Rogue Lineage's own
hotbar and ability keys live on this row, which is the entire point of
remapping something else onto it - there's no reason to ever output
anything else here."""

_KEYREMAP_STATE_COLORS = {
    "Off": ft.Colors.OUTLINE_VARIANT,
    "Active": ft.Colors.GREEN,
    "Waiting for Roblox to be the active window...": ft.Colors.AMBER,
    "Paused - chat is open": ft.Colors.AMBER,
    "Error": ft.Colors.ERROR,
}

_KEYREMAP_FUNCTION_KEY_RE = re.compile(r"^F([1-9]|1[0-9]|2[0-4])$")

_KEYREMAP_SPECIAL_KEY_MAP = {
    "Escape": "esc",
    "Enter": "enter",
    "Space": "space",
    "Tab": "tab",
    "Backspace": "backspace",
    "Delete": "delete",
    "Insert": "insert",
    "Home": "home",
    "End": "end",
    "Page Up": "page up",
    "Page Down": "page down",
    "Arrow Up": "up",
    "Arrow Down": "down",
    "Arrow Left": "left",
    "Arrow Right": "right",
}
"""Flet key name -> `keyboard` library key name, for the special keys
that don't already match between the two. Same set as Autoclicker's own
_SPECIAL_KEY_MAP, but with `keyboard`'s space-separated names ("page up")
instead of pynput's underscored tokens ("page_up")."""


def _keyboard_event_to_remap_input(e: ft.KeyboardEvent) -> tuple[str, str] | None:
    """Convert a Flet key press into a (label, `keyboard`-library key name)
    pair for use as a keybind's input key, or None if the key alone isn't
    usable as one (a bare modifier).

    Unlike Autoclicker's _keyboard_event_to_hotkey, this ignores any held
    modifiers entirely - a keybind remaps one physical key to another, not
    a modifier combo, so Ctrl/Alt/Shift/Meta held while capturing are
    simply not part of the result.
    """
    key = e.key
    if key in ("Shift", "Control", "Alt", "Meta"):
        return None

    if len(key) == 1 and key.isalnum():
        return key.upper(), key.lower()
    if len(key) == 1 and key.isprintable() and not key.isspace():
        return key, key
    if _KEYREMAP_FUNCTION_KEY_RE.match(key):
        return key, key.lower()
    if key in _KEYREMAP_SPECIAL_KEY_MAP:
        return key, _KEYREMAP_SPECIAL_KEY_MAP[key]
    return None


def _key_remapper_command(pairs: list[list[str]], stop_when_chat_open: bool) -> list[str]:
    """The command that starts `backend/key_remapper.py` with these
    input/output key pairs."""
    command = [sys.executable, str(KEY_REMAPPER_SCRIPT), json.dumps(pairs)]
    if stop_when_chat_open:
        command.append("--stop-when-chat-open")
    return command

_MANA_STATE_COLORS = {
    "Stopped": ft.Colors.OUTLINE_VARIANT,
    "Running": ft.Colors.GREEN,
    "Waiting for Roblox to be the active window...": ft.Colors.AMBER,
    "Error": ft.Colors.ERROR,
}
"""Semantic color per overlay run state, for the status dot next to
status_text - same running/stopped/error idiom as Accounts' own
presence dot, plus an amber "armed but not active yet" state for
"wait for Roblox" mode."""

COLOR_WHEEL_IMAGE_PATH = str(Path(__file__).parent / "assets" / "color_wheel.png")
EYEDROPPER_SCRIPT = Path(__file__).parent / "backend" / "eyedropper.py"
COLOR_WHEEL_SIZE = 260
"""Diameter, in logical pixels, of the color wheel image and the
GestureDetector laid on top of it. The wheel image itself
(assets/color_wheel.png) is a plain hue/saturation disc at full
brightness. Value (brightness) is picked separately, from the vertical
gradient bar next to the wheel - see _BRIGHTNESS_BAR_WIDTH - so black
and other dark colors are reachable even though the wheel image itself
only shows full-brightness hues."""
_COLOR_WHEEL_MARKER_SIZE = 14
_BRIGHTNESS_BAR_WIDTH = 28
"""Width of the vertical brightness gradient bar next to the color
wheel. Its height always matches COLOR_WHEEL_SIZE so both controls
line up. The bar's own gradient runs from the current hue/saturation's
full-brightness color at the top to black at the bottom, so it always
shows the current color at every brightness level rather than a plain
generic gradient."""
_BRIGHTNESS_MARKER_HEIGHT = 6
_NAME_FIELD_WIDTH = 200
_PERCENT_FIELD_WIDTH = 100
_TRANSPARENCY_FIELD_WIDTH = 110
_COLOR_SWATCH_SIZE = 48


def _clamp01(value: float) -> float:
    return max(0.0, min(1.0, value))


def _hex_to_rgb(hex_value: str) -> tuple[int, int, int]:
    stripped = hex_value.lstrip("#")
    return (
        int(stripped[0:2], 16),
        int(stripped[2:4], 16),
        int(stripped[4:6], 16),
    )


def _rgb_to_hex(r: int, g: int, b: int) -> str:
    return f"#{r:02X}{g:02X}{b:02X}"


def _hex_to_hsv(hex_value: str) -> tuple[float, float, float]:
    r, g, b = _hex_to_rgb(hex_value)
    return colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)


async def _pick_eyedropper_color() -> Optional[str]:
    """Run the fullscreen eyedropper and return the hex color it sampled.

    Same one-shot subprocess pattern as _pick_mana_area, further down
    this module.
    """
    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        str(EYEDROPPER_SCRIPT),
        stdout=asyncio.subprocess.PIPE,
    )
    line = await proc.stdout.readline()
    await proc.wait()
    if not line:
        return None
    try:
        data = json.loads(line)
    except ValueError:
        return None
    return data.get("color")


def _open_color_dialog(page: ft.Page, initial_hex: str, on_chosen: Callable[[str], None]) -> None:
    """Show the color wheel picker as a modal dialog.

    Drag or tap the wheel to pick a hue and saturation, and drag or tap
    the vertical gradient bar next to it to pick a brightness - the bar
    always shows the current hue/saturation color running from its
    full-brightness version at the top down to black at the bottom, so
    black and other dark shades are reachable, not just full-brightness
    hues. The eyedropper is a single icon button next to the color
    preview, not a separate mode - clicking it runs the same fullscreen
    sampler as before, and whatever it picks feeds back into the wheel,
    bar, and markers so all three ways of picking a color stay in sync.
    `on_chosen` only fires if "Use color" is pressed; closing or
    cancelling leaves whatever the caller started with untouched.
    """
    hue, saturation, value = _hex_to_hsv(initial_hex)
    picked = {"hex": initial_hex.upper(), "hue": hue, "saturation": saturation, "value": value}

    preview_swatch = ft.Container(
        width=32, height=32, bgcolor=picked["hex"], border_radius=6, border=card_border()
    )
    preview_text = ft.Text(picked["hex"], size=12, weight=ft.FontWeight.W_600)

    def _refresh_preview():
        preview_swatch.bgcolor = picked["hex"]
        preview_text.value = picked["hex"]
        preview_swatch.update()
        preview_text.update()

    marker = ft.Container(
        width=_COLOR_WHEEL_MARKER_SIZE,
        height=_COLOR_WHEEL_MARKER_SIZE,
        border_radius=_COLOR_WHEEL_MARKER_SIZE / 2,
        border=ft.Border.all(2, ft.Colors.WHITE),
    )

    def _place_marker():
        center = COLOR_WHEEL_SIZE / 2
        radius = picked["saturation"] * center
        angle = math.radians(picked["hue"] * 360)
        marker.left = center + radius * math.cos(angle) - _COLOR_WHEEL_MARKER_SIZE / 2
        marker.top = center - radius * math.sin(angle) - _COLOR_WHEEL_MARKER_SIZE / 2

    _place_marker()

    def _apply_hsv():
        r, g, b = colorsys.hsv_to_rgb(picked["hue"], picked["saturation"], picked["value"])
        picked["hex"] = _rgb_to_hex(round(r * 255), round(g * 255), round(b * 255))
        _refresh_preview()

    def _pick_from_wheel(local_x: float, local_y: float):
        center = COLOR_WHEEL_SIZE / 2
        dx, dy = local_x - center, -(local_y - center)
        distance = math.hypot(dx, dy)
        picked["saturation"] = _clamp01(distance / center)
        picked["hue"] = (math.degrees(math.atan2(dy, dx)) % 360) / 360
        _place_marker()
        marker.update()
        _apply_hsv()

    def on_wheel_point(e: ft.Event[ft.GestureDetector]):
        _pick_from_wheel(e.local_position.x, e.local_position.y)
        _refresh_brightness_bar()

    wheel_gesture = ft.GestureDetector(
        content=ft.Stack(
            [
                ft.Image(
                    src=COLOR_WHEEL_IMAGE_PATH, width=COLOR_WHEEL_SIZE, height=COLOR_WHEEL_SIZE
                ),
                marker,
            ],
            width=COLOR_WHEEL_SIZE,
            height=COLOR_WHEEL_SIZE,
        ),
        width=COLOR_WHEEL_SIZE,
        height=COLOR_WHEEL_SIZE,
        on_tap_down=on_wheel_point,
        on_pan_start=on_wheel_point,
        on_pan_update=on_wheel_point,
        mouse_cursor=ft.MouseCursor.CLICK,
    )

    def _bright_hue_hex() -> str:
        """The current hue/saturation at full brightness - the color
        the brightness bar's gradient starts from at its top."""
        r, g, b = colorsys.hsv_to_rgb(picked["hue"], picked["saturation"], 1.0)
        return _rgb_to_hex(round(r * 255), round(g * 255), round(b * 255))

    brightness_bar = ft.Container(
        width=_BRIGHTNESS_BAR_WIDTH,
        height=COLOR_WHEEL_SIZE,
        border_radius=4,
        border=card_border(),
        gradient=ft.LinearGradient(
            begin=ft.Alignment.TOP_CENTER,
            end=ft.Alignment.BOTTOM_CENTER,
            colors=[_bright_hue_hex(), "#000000"],
        ),
    )

    def _refresh_brightness_bar():
        brightness_bar.gradient = ft.LinearGradient(
            begin=ft.Alignment.TOP_CENTER,
            end=ft.Alignment.BOTTOM_CENTER,
            colors=[_bright_hue_hex(), "#000000"],
        )
        brightness_bar.update()

    brightness_marker = ft.Container(
        left=-4,
        width=_BRIGHTNESS_BAR_WIDTH + 8,
        height=_BRIGHTNESS_MARKER_HEIGHT,
        border_radius=_BRIGHTNESS_MARKER_HEIGHT / 2,
        border=ft.Border.all(2, ft.Colors.WHITE),
    )

    def _place_brightness_marker():
        brightness_marker.top = (
            (1 - picked["value"]) * COLOR_WHEEL_SIZE - _BRIGHTNESS_MARKER_HEIGHT / 2
        )

    _place_brightness_marker()

    def _pick_from_brightness_bar(local_y: float):
        picked["value"] = _clamp01(1 - local_y / COLOR_WHEEL_SIZE)
        _place_brightness_marker()
        brightness_marker.update()
        _apply_hsv()

    def on_brightness_point(e: ft.Event[ft.GestureDetector]):
        _pick_from_brightness_bar(e.local_position.y)

    brightness_gesture = ft.GestureDetector(
        content=ft.Stack(
            [brightness_bar, brightness_marker],
            width=_BRIGHTNESS_BAR_WIDTH,
            height=COLOR_WHEEL_SIZE,
        ),
        width=_BRIGHTNESS_BAR_WIDTH,
        height=COLOR_WHEEL_SIZE,
        on_tap_down=on_brightness_point,
        on_pan_start=on_brightness_point,
        on_pan_update=on_brightness_point,
        mouse_cursor=ft.MouseCursor.CLICK,
    )

    eyedropper_button = ft.IconButton(
        icon=ft.Icons.COLORIZE, tooltip="Pick color from screen"
    )

    async def on_eyedropper_click(e: ft.Event[ft.IconButton]):
        eyedropper_button.disabled = True
        page.update()
        sampled = await _pick_eyedropper_color()
        eyedropper_button.disabled = False
        if sampled:
            picked["hue"], picked["saturation"], picked["value"] = _hex_to_hsv(sampled)
            picked["hex"] = sampled.upper()
            _place_marker()
            marker.update()
            _place_brightness_marker()
            brightness_marker.update()
            _refresh_brightness_bar()
            _refresh_preview()
        page.update()

    eyedropper_button.on_click = on_eyedropper_click

    def on_cancel(e: ft.Event[ft.TextButton]):
        page.pop_dialog()

    def on_use_color(e: ft.Event[ft.FilledButton]):
        page.pop_dialog()
        on_chosen(picked["hex"])

    dialog = ft.AlertDialog(
        modal=True,
        scrollable=True,
        shape=ft.RoundedRectangleBorder(radius=radius_card(page)),
        title=ft.Text("Choose color"),
        content=ft.Container(
            width=DIALOG_WIDTH,
            content=ft.Column(
                [
                    ft.Row(
                        [wheel_gesture, brightness_gesture],
                        spacing=SPACE_LG,
                        alignment=ft.MainAxisAlignment.CENTER,
                        vertical_alignment=ft.CrossAxisAlignment.START,
                    ),
                    ft.Divider(),
                    ft.Row(
                        [
                            preview_swatch,
                            preview_text,
                            ft.Container(expand=True),
                            eyedropper_button,
                        ],
                        spacing=SPACE_MD,
                        vertical_alignment=ft.CrossAxisAlignment.CENTER,
                    ),
                ],
                spacing=SPACE_XS,
                horizontal_alignment=ft.CrossAxisAlignment.CENTER,
                tight=True,
            ),
        ),
        actions=[
            ft.TextButton("Cancel", on_click=on_cancel),
            ft.FilledButton("Use color", on_click=on_use_color),
        ],
        actions_alignment=ft.MainAxisAlignment.END,
    )
    page.show_dialog(dialog)


_USERNAME_TEXT_SIZE = 16
"""Shared text size for the username field and its ghost-completion text
behind it, so typed characters and the gray suggestion line up. The field
uses border=NONE and no built-in label (a plain Text above it stands in
for one instead) specifically so both layers share the same padding-only
box - Flutter's OutlineInputBorder and floating label both add their own
internal offsets that a plain Text sitting behind the field can't predict
or match."""
_TS_KW = {"size": _USERNAME_TEXT_SIZE}
_USERNAME_TEXT_STYLE = ft.TextStyle(**_TS_KW)
_USERNAME_PADDING = ft.Padding.symmetric(horizontal=8, vertical=10)


def _dropdown_options(values: list[str]) -> list[ft.dropdown.Option]:
    return [ft.dropdown.Option(key=v, text=v) for v in values] + [
        ft.dropdown.Option(key=_OTHER_KEY, text="Other...")
    ]


def _resolve_choice(dropdown: ft.Dropdown, other_field: ft.TextField) -> str:
    """The chosen class/race/item name, from either the dropdown or its
    "Other..." text field."""
    if dropdown.value == _OTHER_KEY:
        return (other_field.value or "").strip()
    return dropdown.value or ""


def _build_choice_row(label: str, options: list[str], current_value: str) -> tuple:
    """A Dropdown plus a paired "Other..." TextField, pre-selecting
    Other and filling the text field if current_value isn't in options.
    """
    is_custom = bool(current_value) and current_value not in options
    dropdown = ft.Dropdown(
        label=label,
        options=_dropdown_options(options),
        value=_OTHER_KEY if is_custom else (current_value or None),
        dense=True,
        expand=True,
    )
    other_field = ft.TextField(
        label=f"{label} (custom)",
        value=current_value if is_custom else "",
        visible=is_custom,
        dense=True,
        expand=True,
    )

    def on_change(e: ft.Event[ft.Dropdown]):
        other_field.visible = dropdown.value == _OTHER_KEY
        other_field.update()

    dropdown.on_change = on_change
    return dropdown, other_field


def _best_username_match(accounts: list[dict], typed: str) -> str | None:
    """The first tracked account username that starts with typed text, for
    the Tab-to-autofill hint - or None if nothing matches or typed is
    empty.
    """
    query = (typed or "").strip().lower()
    if not query:
        return None
    for account in accounts:
        name = account.get("name", "")
        if name.lower() != query and name.lower().startswith(query):
            return name
    return None


async def _pick_mana_area() -> Optional[dict]:
    """Run the fullscreen area picker and return the rectangle it chose.

    Same one-shot subprocess pattern as
    widgets/image_overlay/widget.py::_pick_area.
    """
    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        str(MANA_AREA_PICKER_SCRIPT),
        stdout=asyncio.subprocess.PIPE,
    )
    line = await proc.stdout.readline()
    await proc.wait()
    if not line:
        return None
    try:
        data = json.loads(line)
    except ValueError:
        return None
    if "x" not in data:
        return None
    return {"x": data["x"], "y": data["y"], "width": data["width"], "height": data["height"]}


def _parse_mana_area(
    x_field: ft.TextField, y_field: ft.TextField, w_field: ft.TextField,
    h_field: ft.TextField, fallback: dict
) -> dict:
    """Read the four area fields, falling back to `fallback` per-field on
    a bad or empty value, and clamping width/height to at least 1.
    """

    def _int(value: Optional[str], default: int) -> int:
        try:
            return int(value)
        except (TypeError, ValueError):
            return default

    x = _int(x_field.value, fallback["x"])
    y = _int(y_field.value, fallback["y"])
    width = max(1, _int(w_field.value, fallback["width"]))
    height = max(1, _int(h_field.value, fallback["height"]))
    return {"x": x, "y": y, "width": width, "height": height}


def _describe_orientation(area: dict) -> str:
    """The same guess backend/mana_bar_overlay.py::_orientation makes
    from an area's width/height, worded for display next to the area
    fields.
    """
    if area["height"] > area["width"]:
        return "Vertical: bottom to top"
    return "Horizontal: left to right"


def _mana_backend_command(
    area: dict,
    highlights: list[dict],
    click_through: bool,
    border_color: str,
    border_width: int,
) -> list[str]:
    """The command that starts `backend/mana_bar_overlay.py` with these options.

    There's no orientation option to pass - the backend guesses it from
    `area`'s own width/height (see mana_bar_overlay.py::_orientation).

    A highlight's `name` is stripped out here - it's a label for the
    widget's own list, never something the overlay itself needs to know
    about or could draw.

    Passes Toolblox's own pid explicitly via `--parent-pid`, for the
    backend's failsafe watchdog (see that module's docstring): on a
    Windows venv, `sys.executable` re-execs through a small launcher
    stub that stays resident as the backend's real OS parent, so the
    backend can't just trust `os.getppid()` to find Toolblox itself.
    `os.getpid()` here, from inside Toolblox's own running code, is
    always Toolblox's real pid regardless of how it was launched.
    """
    overlay_highlights = [
        {k: v for k, v in highlight.items() if k != "name"} for highlight in highlights
    ]
    command = [
        sys.executable,
        str(MANA_BACKEND_SCRIPT),
        "--x",
        str(area["x"]),
        "--y",
        str(area["y"]),
        "--width",
        str(area["width"]),
        "--height",
        str(area["height"]),
        "--highlights",
        json.dumps(overlay_highlights),
        "--border-color",
        border_color,
        "--border-width",
        str(border_width),
        "--parent-pid",
        str(os.getpid()),
    ]
    if click_through:
        command.append("--click-through")
    return command


def _open_character_dialog(page: ft.Page, existing: dict | None, on_saved) -> None:
    """Show the add/edit character form as a modal dialog.

    Only one instance of this dialog can be open at a time, tracked via
    _DIALOG_OPEN_KEY - callers should check that flag before calling this,
    to avoid stacking a second dialog on top of one already open.
    """
    page.session.store.set(_DIALOG_OPEN_KEY, True)
    accounts = accounts_store.load()

    username_field = ft.TextField(
        value=(existing.get("username") or "") if existing else "",
        border=ft.InputBorder.NONE,
        content_padding=_USERNAME_PADDING,
        text_style=_USERNAME_TEXT_STYLE,
        autofocus=True,
        expand=True,
    )
    username_ghost_field = ft.TextField(
        value=username_field.value,
        border=ft.InputBorder.NONE,
        content_padding=_USERNAME_PADDING,
        text_style=ft.TextStyle(color=ft.Colors.ON_SURFACE_VARIANT, **_TS_KW),
        read_only=True,
        disabled=True,
        show_cursor=False,
        expand=True,
    )
    username_box = ft.Container(
        content=ft.Stack([username_ghost_field, username_field]),
        border=ft.Border.all(1, ft.Colors.OUTLINE),
        border_radius=4,
    )
    username_group = ft.Column(
        [
            text_caption("Username"),
            username_box,
        ],
        spacing=SPACE_XS,
    )
    username_focused = False
    current_suggestion: str | None = None

    def update_suggestion(mounted: bool = True):
        """Recompute the Tab-completion ghost text.

        The ghost field's value is set to the typed text plus the
        suggested remainder, in a gray TextField stacked directly behind
        the real one. Both fields share the same border/padding/text
        style, so Flutter lays out their text identically - the typed
        characters in the real field land exactly on top of the same
        characters in the ghost field, and only the untyped suggested
        tail shows through beyond them. This is why the ghost value
        includes the literal typed prefix (not the account's own casing
        for it) - if the two fields' prefixes were different strings,
        different glyph shapes could show through at the edges.
        """
        nonlocal current_suggestion
        typed = username_field.value or ""
        current_suggestion = _best_username_match(accounts, typed)
        suffix = current_suggestion[len(typed) :] if current_suggestion else ""
        username_ghost_field.value = typed + suffix
        if mounted:
            username_ghost_field.update()

    def on_username_change(e: ft.Event[ft.TextField]):
        update_suggestion()

    def on_username_focus(e: ft.Event[ft.TextField]):
        nonlocal username_focused
        username_focused = True

    def on_username_blur(e: ft.Event[ft.TextField]):
        nonlocal username_focused
        username_focused = False

    username_field.on_change = on_username_change
    username_field.on_focus = on_username_focus
    username_field.on_blur = on_username_blur

    previous_keyboard_handler = page.on_keyboard_event

    def on_keyboard_event(e: ft.KeyboardEvent):
        if username_focused and e.key == "Tab" and current_suggestion:
            username_field.value = current_suggestion
            username_field.update()
            update_suggestion()
            return
        if previous_keyboard_handler:
            previous_keyboard_handler(e)

    page.on_keyboard_event = on_keyboard_event

    def close_dialog():
        page.on_keyboard_event = previous_keyboard_handler
        page.session.store.set(_DIALOG_OPEN_KEY, False)
        page.pop_dialog()

    class_dropdown, class_other = _build_choice_row(
        "Class", reference.CLASSES, existing.get("class_name", "") if existing else ""
    )
    race_dropdown, race_other = _build_choice_row(
        "Race", reference.RACES, existing.get("race", "") if existing else ""
    )
    notes_field = ft.TextField(
        label="Notes",
        value=(existing.get("notes") or "") if existing else "",
        multiline=True,
        min_lines=2,
        max_lines=5,
        dense=True,
    )

    items_state: list[dict] = list(existing.get("items", [])) if existing else []
    items_column = ft.Column(spacing=SPACE_XS)

    def render_items(mounted: bool = True):
        if not items_state:
            items_column.controls = [text_caption("No items added yet.")]
        else:
            items_column.controls = [
                _item_chip(index, item) for index, item in enumerate(items_state)
            ]
        if mounted:
            items_column.update()

    def _item_chip(index: int, item: dict) -> ft.Control:
        label = item["name"]
        quantity = item.get("quantity", 1)
        if quantity and quantity > 1:
            label = f"{label} ×{quantity}"

        def on_remove(e: ft.Event[ft.IconButton]):
            items_state.pop(index)
            render_items()

        return ft.Container(
            content=ft.Row(
                [
                    ft.Text(label, size=12, expand=True),
                    ft.IconButton(icon=ft.Icons.CLOSE, icon_size=14, on_click=on_remove),
                ],
                vertical_alignment=ft.CrossAxisAlignment.CENTER,
            ),
            padding=ft.Padding.symmetric(horizontal=SPACE_SM, vertical=2),
            bgcolor=ft.Colors.SURFACE_CONTAINER_HIGHEST,
            border_radius=RADIUS_PILL,
        )

    item_dropdown = ft.Dropdown(
        label="Item", options=_dropdown_options(reference.ITEMS), dense=True, expand=2
    )
    item_other_field = ft.TextField(
        label="Item name (custom)", visible=False, dense=True, expand=True
    )
    item_quantity_field = ft.TextField(
        label="Quantity",
        dense=True,
        expand=1,
        keyboard_type=ft.KeyboardType.NUMBER,
    )

    def on_item_dropdown_change(e: ft.Event[ft.Dropdown]):
        item_other_field.visible = item_dropdown.value == _OTHER_KEY
        item_other_field.update()

    item_dropdown.on_change = on_item_dropdown_change

    def on_add_item(e: ft.Event[ft.IconButton]):
        name = _resolve_choice(item_dropdown, item_other_field)
        if not name:
            show_toast(page, "Pick or type an item name first.")
            return
        raw_quantity = (item_quantity_field.value or "").strip()
        quantity = 1
        if raw_quantity:
            try:
                quantity = max(1, int(raw_quantity))
            except ValueError:
                show_toast(page, "Quantity has to be a whole number.")
                return
        items_state.append({"name": name, "quantity": quantity})
        item_dropdown.value = None
        item_other_field.value = ""
        item_other_field.visible = False
        item_quantity_field.value = ""
        item_dropdown.update()
        item_other_field.update()
        item_quantity_field.update()
        render_items()

    render_items(mounted=False)
    update_suggestion(mounted=False)

    def on_save(e: ft.Event[ft.FilledButton]):
        username = (username_field.value or "").strip()
        if not username:
            show_toast(page, "Enter a username first.")
            return

        class_name = _resolve_choice(class_dropdown, class_other)
        race = _resolve_choice(race_dropdown, race_other)
        if not class_name or not race:
            show_toast(page, "Pick or type a class and race first.")
            return

        current = storage.load_roster()
        if existing:
            for character in current:
                if character["char_id"] == existing["char_id"]:
                    character.update(
                        username=username,
                        class_name=class_name,
                        race=race,
                        notes=(notes_field.value or "").strip(),
                        items=list(items_state),
                    )
                    break
        else:
            current.append(
                storage.new_character(
                    account_id=None,
                    username=username,
                    display_name=None,
                    avatar_url=None,
                    class_name=class_name,
                    race=race,
                    notes=(notes_field.value or "").strip(),
                    items=list(items_state),
                )
            )
        storage.save_roster(current)
        close_dialog()
        on_saved()

    def on_cancel(e: ft.Event[ft.TextButton]):
        close_dialog()

    dialog = ft.AlertDialog(
        modal=True,
        scrollable=True,
        title=ft.Text("Edit character" if existing else "Add character"),
        content=ft.Container(
            content=ft.Column(
                [
                    username_group,
                    ft.Column(
                        [ft.Row([class_dropdown]), ft.Row([class_other])],
                        spacing=SPACE_XS,
                    ),
                    ft.Column(
                        [ft.Row([race_dropdown]), ft.Row([race_other])],
                        spacing=SPACE_XS,
                    ),
                    notes_field,
                    ft.Divider(),
                    text_section("Items"),
                    items_column,
                    ft.Column(
                        [
                            ft.Row(
                                [
                                    item_dropdown,
                                    item_quantity_field,
                                    ft.IconButton(
                                        icon=ft.Icons.ADD,
                                        tooltip="Add item",
                                        on_click=on_add_item,
                                    ),
                                ],
                                spacing=SPACE_MD,
                            ),
                            ft.Row([item_other_field]),
                        ],
                        spacing=SPACE_XS,
                    ),
                ],
                spacing=SPACE_MD,
                horizontal_alignment=ft.CrossAxisAlignment.STRETCH,
            ),
            width=DIALOG_WIDTH,
        ),
        actions=[
            ft.TextButton("Cancel", on_click=on_cancel),
            ft.FilledButton("Save", on_click=on_save),
        ],
        actions_alignment=ft.MainAxisAlignment.END,
    )
    page.show_dialog(dialog)


_HEADER_TITLE = "Rogue Lineage"
_ADD_BUTTON_TEXT = "Add character"
"""Shared between the real header row and suggestions_overlay's
invisible mirror of it in build_view, so the two can never drift apart
and silently break the dropdown's width alignment.
"""

_SEARCH_DROPDOWN_TOP = 52
"""Vertical offset, in logical pixels, from the top of the search bar's
header row down to where its autofill dropdown starts - approximately
the header row's own rendered height (a dense TextField, the row's
tallest element) plus a small gap. There's no layout API to measure the
row's actual height at build time, so this is a fixed estimate like
_USERNAME_PADDING above, not a computed value.
"""

_SHORTHAND_KEYWORDS = {"race": "race", "class": "class_name", "item": "item"}
"""Search-bar shorthand keyword -> the character field (or "item" for the
items list) it filters. Keys are what's typed after "#"; there's no
"username" entry since a plain query already searches usernames, and no
"notes" entry since notes has no shorthand.
"""


def _split_shorthand(query: str) -> tuple[str, str]:
    """Split "#token rest" or "#token:rest" into (token, rest). query must
    already have its leading "#" stripped."""
    for i, ch in enumerate(query):
        if ch in " :":
            return query[:i], query[i + 1 :].strip()
    return query, ""


def _matching_keywords(token: str) -> list[str]:
    """Shorthand keywords that start with token, or every keyword if
    token is empty."""
    if not token:
        return list(_SHORTHAND_KEYWORDS)
    return [keyword for keyword in _SHORTHAND_KEYWORDS if keyword.startswith(token)]


def _resolve_search(query: str) -> tuple[Optional[str], str, list[str]]:
    """Resolve a lowercased, stripped search-box query into a (field,
    value, keyword_suggestions) tuple.

    For a plain query, field is None and value is the query itself,
    matched against username and display name. For a "#race" / "#class" /
    "#item" shorthand, once the keyword is unambiguous field/value hold
    the parsed filter and keyword_suggestions is empty. While the keyword
    is still ambiguous (e.g. just "#" or "#c"), field is None and
    keyword_suggestions lists the possible keywords instead, so callers
    can offer them as autofill options.
    """
    if not query.startswith("#"):
        return None, query, []
    token, rest = _split_shorthand(query[1:])
    if token in _SHORTHAND_KEYWORDS:
        return _SHORTHAND_KEYWORDS[token], rest, []
    return None, "", _matching_keywords(token)


def _current_field_values(characters: list[dict], field: str, value: str) -> list[str]:
    """Distinct, non-empty values currently on the roster for field
    ("race", "class_name", or "item"), filtered to those containing
    value, sorted alphabetically."""
    if field == "item":
        values = {
            item.get("name", "").strip()
            for character in characters
            for item in character.get("items", [])
        }
    else:
        values = {(character.get(field) or "").strip() for character in characters}
    return sorted(v for v in values if v and value in v.lower())


def _character_matches_search(character: dict, field: Optional[str], value: str) -> bool:
    """Whether character matches a search value, either a plain query
    (against username and display name) or a shorthand-filtered field
    ("race", "class_name", or "item")."""
    if field == "race":
        haystacks = [character.get("race") or ""]
    elif field == "class_name":
        haystacks = [character.get("class_name") or ""]
    elif field == "item":
        haystacks = [item.get("name", "") for item in character.get("items", [])]
    else:
        haystacks = [character.get("username", ""), character.get("display_name") or ""]
    return any(value in haystack.lower() for haystack in haystacks)


def build_view(page: ft.Page) -> ft.View:
    """The Rogue Lineage screen: a searchable roster of characters, each
    with class, race, notes, and items, plus add/edit/delete.
    """

    search_query = ""
    filter_field: Optional[str] = None
    filter_value = ""
    current_suggestions: list[tuple[str, str]] = []
    """(label, text-to-apply) pairs for the search bar's autofill
    dropdown, in display order - kept alongside highlighted_index so Up/
    Down/Tab can navigate and accept them without recomputing the list.
    """
    highlighted_index = 0
    search_focused = False
    list_column = ft.Column(spacing=SPACE_SM)
    suggestions_list = ft.Column(spacing=0, horizontal_alignment=ft.CrossAxisAlignment.STRETCH)
    suggestions_box = ft.Container(
        content=suggestions_list,
        bgcolor=ft.Colors.SURFACE_CONTAINER_HIGH,
        border=card_border(),
        border_radius=radius_menu(page),
        clip_behavior=ft.ClipBehavior.ANTI_ALIAS,
    )
    suggestions_overlay = ft.Row(
        [
            ft.Container(content=suggestions_box, expand=True),
            ft.Container(
                content=ft.IconButton(icon=ft.Icons.UPLOAD_FILE, disabled=True), opacity=0
            ),
            ft.Container(
                content=ft.IconButton(icon=ft.Icons.DOWNLOAD, disabled=True), opacity=0
            ),
            ft.Container(
                content=ft.FilledButton(_ADD_BUTTON_TEXT, icon=ft.Icons.ADD, disabled=True),
                opacity=0,
            ),
        ],
        spacing=SPACE_MD,
        top=_SEARCH_DROPDOWN_TOP,
        left=0,
        right=0,
        visible=False,
    )
    """suggestions_overlay mirrors the Characters box's own header row -
    [search field, import button, export button, add button] - with
    invisible placeholders sized exactly like the real ones, so its
    first (expand=True) slot lands at the same x-position and width as
    the real search field without needing to measure anything - Flet has
    no API to read a control's rendered position or size at build time.
    The placeholder buttons are disabled so they can't silently swallow
    clicks meant for whatever's underneath once it's visible; the whole
    row's own `visible` is what's toggled to show/hide the dropdown (see
    render_suggestions), which also keeps it out of hit-testing while
    hidden. It's scoped as a Stack sibling of just the header row + list
    (see content_body below), not the whole screen, so this top offset
    only has to clear the header row's own height, not the screen title
    or the box's border/padding above it.
    """

    def delete_character(char_id: str):
        current = storage.load_roster()
        current = [c for c in current if c["char_id"] != char_id]
        storage.save_roster(current)
        render_list()

    def character_card(character: dict) -> ft.Control:
        username = character.get("username", "")
        display_name = character.get("display_name")
        header_text = (
            f"({display_name}) {username}"
            if display_name and display_name != username
            else username
        )

        avatar_url = character.get("avatar_url")
        avatar = (
            ft.Image(src=avatar_url, width=40, height=40, fit=ft.BoxFit.COVER)
            if avatar_url
            else ft.Icon(ft.Icons.PERSON, size=24)
        )

        item_names = ", ".join(item.get("name", "") for item in character.get("items", []))
        subtitle = " • ".join(
            part
            for part in (
                character.get("class_name"),
                character.get("notes"),
                item_names,
            )
            if part
        )

        race = character.get("race")
        race_badge: ft.Control = ft.Container()
        if race:
            icon_path = _race_icon_path(race)
            race_badge = ft.Row(
                [
                    ft.Image(src=icon_path, width=_RACE_ICON_SIZE, height=_RACE_ICON_SIZE)
                    if icon_path
                    else ft.Icon(ft.Icons.QUESTION_MARK, size=_RACE_ICON_SIZE),
                    text_caption(race),
                ],
                spacing=SPACE_XS,
                vertical_alignment=ft.CrossAxisAlignment.CENTER,
                tight=True,
            )

        def on_open(e: ft.Event[ft.Container]):
            if page.session.store.get(_DIALOG_OPEN_KEY):
                return
            _open_character_dialog(page, character, render_list)

        def on_delete(e: ft.Event[ft.IconButton]):
            show_confirm_toast(
                page,
                f'Delete "{username}"? This can\'t be undone.',
                lambda: delete_character(character["char_id"]),
                confirm_label="Delete",
            )

        return ft.Container(
            content=ft.Row(
                [
                    ft.Container(
                        content=avatar,
                        width=40,
                        height=40,
                        bgcolor=ft.Colors.SURFACE_CONTAINER_HIGHEST,
                        border_radius=20,
                        alignment=ft.Alignment.CENTER,
                    ),
                    ft.Row(
                        [
                            text_label(header_text),
                            ft.Row(
                                [
                                    race_badge,
                                    text_caption("•") if race and subtitle else ft.Container(),
                                    text_caption(
                                        subtitle or ("" if race else "No class set"),
                                        max_lines=1,
                                        overflow=ft.TextOverflow.ELLIPSIS,
                                        expand=True,
                                    ),
                                ],
                                spacing=SPACE_XS,
                                expand=True,
                                vertical_alignment=ft.CrossAxisAlignment.CENTER,
                            ),
                            _info_chip("Not linked")
                            if character.get("account_id") is None
                            else ft.Container(),
                        ],
                        expand=True,
                        spacing=SPACE_MD,
                        vertical_alignment=ft.CrossAxisAlignment.CENTER,
                    ),
                    ft.IconButton(
                        icon=ft.Icons.DELETE_OUTLINE, tooltip="Delete", on_click=on_delete
                    ),
                ],
                spacing=SPACE_MD,
                vertical_alignment=ft.CrossAxisAlignment.CENTER,
            ),
            on_click=on_open,
            ink=True,
            padding=SPACE_SM,
            border=card_border(),
            border_radius=radius_card(page),
        )

    def render_list(mounted: bool = True):
        characters = sorted(storage.load_roster(), key=lambda c: c.get("username", "").lower())
        if search_query:
            if search_query.startswith("#") and filter_field is None:
                characters = []
            else:
                characters = [
                    c
                    for c in characters
                    if _character_matches_search(c, filter_field, filter_value)
                ]
        if not characters:
            list_column.controls = [
                text_caption("No characters match your search.")
                if search_query
                else text_caption("No characters added yet.")
            ]
        else:
            list_column.controls = [character_card(c) for c in characters]
        if mounted:
            list_column.update()

    def apply_search_text(text: str):
        nonlocal search_query
        search_field.value = text
        search_query = text.strip().lower()
        search_field.update()
        update_suggestions()
        render_list()

    def on_suggestion_click(apply_text: str):
        def handler(e: ft.Event[ft.Container]):
            apply_search_text(apply_text)

        return handler

    def suggestion_row(label: str, apply_text: str, highlighted: bool) -> ft.Control:
        """One row of the search-bar's autofill dropdown - apply_text is
        what Tab or a click fills the search field with; highlighted marks
        the row Up/Down navigation currently rests on."""
        return ft.Container(
            content=text_label(label),
            on_click=on_suggestion_click(apply_text),
            ink=True,
            bgcolor=ft.Colors.SECONDARY_CONTAINER if highlighted else None,
            padding=ft.Padding.symmetric(horizontal=SPACE_MD, vertical=SPACE_SM),
        )

    def render_suggestions(mounted: bool = True):
        suggestions_list.controls = [
            suggestion_row(label, apply_text, i == highlighted_index)
            for i, (label, apply_text) in enumerate(current_suggestions)
        ]
        suggestions_overlay.visible = bool(current_suggestions)
        if mounted:
            suggestions_overlay.update()

    def update_suggestions(mounted: bool = True):
        """Recompute current_suggestions (and filter_field/filter_value)
        from search_query, reset the highlighted row to the first one, and
        re-render the dropdown."""
        nonlocal filter_field, filter_value, current_suggestions, highlighted_index
        field, value, keyword_suggestions = _resolve_search(search_query)
        filter_field, filter_value = field, value
        if keyword_suggestions:
            current_suggestions = [
                (f"#{keyword}", f"#{keyword} ") for keyword in sorted(keyword_suggestions)
            ]
        elif field is not None:
            keyword = next(k for k, v in _SHORTHAND_KEYWORDS.items() if v == field)
            current_suggestions = [
                (option, f"#{keyword}:{option}")
                for option in _current_field_values(storage.load_roster(), field, value)
            ]
        else:
            current_suggestions = []
        highlighted_index = 0
        render_suggestions(mounted=mounted)

    def on_search_change(e: ft.Event[ft.TextField]):
        nonlocal search_query
        search_query = (e.control.value or "").strip().lower()
        update_suggestions()
        render_list()

    def on_search_focus(e: ft.Event[ft.TextField]):
        nonlocal search_focused
        search_focused = True

    def on_search_blur(e: ft.Event[ft.TextField]):
        nonlocal search_focused
        search_focused = False

    search_field = ft.TextField(
        hint_text="Search...",
        prefix_icon=ft.Icons.SEARCH,
        dense=True,
        expand=True,
        ignore_up_down_keys=True,
        on_change=on_search_change,
        on_focus=on_search_focus,
        on_blur=on_search_blur,
    )

    previous_keyboard_handler = page.on_keyboard_event

    def on_search_keyboard_event(e: ft.KeyboardEvent):
        """Up/Down move the highlighted suggestion, Tab accepts it - then
        falls through to whatever handler was registered before this view
        built (e.g. the add/edit character dialog's own Tab-to-autofill
        handler while it's open).

        Registered once, at view-build time, rather than reassigned per
        keystroke: see widgets/autoclicker/widget.py's
        on_page_keyboard_event docstring for why repeatedly swapping
        page.on_keyboard_event is unreliable in Flet. The route check
        below is what makes a handler left behind after navigating away
        from this view inert instead of intercepting keys elsewhere,
        since there's no per-view teardown hook to unregister it with.
        """
        nonlocal highlighted_index
        is_current_view = bool(page.views) and page.views[-1].route == widget_route(WIDGET_ID)
        if is_current_view and search_focused and current_suggestions:
            if e.key == "Arrow Down":
                highlighted_index = (highlighted_index + 1) % len(current_suggestions)
                render_suggestions()
                return
            if e.key == "Arrow Up":
                highlighted_index = (highlighted_index - 1) % len(current_suggestions)
                render_suggestions()
                return
            if e.key == "Tab":
                apply_search_text(current_suggestions[highlighted_index][1])
                return
        if previous_keyboard_handler:
            previous_keyboard_handler(e)

    page.on_keyboard_event = on_search_keyboard_event

    def on_add(e: ft.Event[ft.FilledButton]):
        if page.session.store.get(_DIALOG_OPEN_KEY):
            return
        _open_character_dialog(page, None, render_list)

    file_picker = ft.FilePicker()

    async def on_export(e: ft.Event[ft.IconButton]):
        path = await file_picker.save_file(
            dialog_title="Export characters",
            file_name="rogue_lineage_characters.json",
            file_type=ft.FilePickerFileType.CUSTOM,
            allowed_extensions=["json"],
        )
        if not path:
            return
        characters = storage.load_roster()
        try:
            Path(path).write_text(storage.export_roster(characters))
        except OSError as err:
            show_toast(page, f"Couldn't write {path}. Is it open in another program?")
            logger.error("Failed to export roster to %s: %s", path, err)
            return
        show_toast(page, f"Exported {len(characters)} character(s) to {Path(path).name}.")

    async def on_import(e: ft.Event[ft.IconButton]):
        files = await file_picker.pick_files(
            dialog_title="Import characters",
            file_type=ft.FilePickerFileType.CUSTOM,
            allowed_extensions=["json"],
            with_data=True,
        )
        if not files:
            return
        picked = files[0]
        try:
            text = (
                picked.bytes.decode("utf-8")
                if picked.bytes is not None
                else Path(picked.path).read_text()
            )
            imported = storage.import_roster(text)
        except (ValueError, OSError, UnicodeDecodeError) as err:
            show_toast(page, f"Couldn't import {picked.name}. Is it a valid export file?")
            logger.error("Failed to import roster from %s: %s", picked.name, err)
            return

        current = storage.load_roster()
        existing_usernames = {c.get("username", "").strip().lower() for c in current}
        added = [c for c in imported if c["username"].strip().lower() not in existing_usernames]
        skipped = len(imported) - len(added)

        if not added:
            show_toast(page, "Every character in that file is already in your roster.")
            return

        storage.save_roster(current + added)
        message = f"Imported {len(added)} character(s)."
        if skipped:
            message += f" Skipped {skipped} already in your roster."
        show_toast(page, message)
        render_list()

    async def sync_loop(generation: int):
        """Reconcile the roster against tracked accounts on a timer, for
        as long as this exact view build is the one on screen.
        """
        while True:
            if (
                not page.views
                or page.views[-1].route != widget_route(WIDGET_ID)
                or page.session.store.get(_GENERATION_KEY) != generation
            ):
                return
            current = storage.load_roster()
            updated, changed = storage.sync_with_accounts(current, accounts_store.load())
            if changed:
                storage.save_roster(updated)
                render_list()
            await asyncio.sleep(_SYNC_INTERVAL_SECONDS)

    update_suggestions(mounted=False)
    render_list(mounted=False)

    generation = (page.session.store.get(_GENERATION_KEY) or 0) + 1
    page.session.store.set(_GENERATION_KEY, generation)
    page.run_task(sync_loop, generation)

    mana_section = _build_mana_bar_overlay_section(page)
    keybinds_section = _build_keybinds_section(page)

    characters_header_row = ft.Row(
        [
            search_field,
            ft.IconButton(
                icon=ft.Icons.UPLOAD_FILE,
                tooltip="Import characters from a file",
                on_click=on_import,
            ),
            ft.IconButton(
                icon=ft.Icons.DOWNLOAD,
                tooltip="Export characters to a file",
                on_click=on_export,
            ),
            ft.FilledButton(_ADD_BUTTON_TEXT, icon=ft.Icons.ADD, on_click=on_add),
        ],
        spacing=SPACE_MD,
        vertical_alignment=ft.CrossAxisAlignment.CENTER,
    )

    characters_section = section_box(
        page,
        ft.Column(
            [
                text_section("Characters"),
                ft.Stack(
                    [
                        ft.Column([characters_header_row, list_column], spacing=SPACE_SM),
                        suggestions_overlay,
                    ],
                    clip_behavior=ft.ClipBehavior.NONE,
                ),
            ],
            spacing=SPACE_SM,
        ),
    )
    """The Characters feature box: search/import/export/add plus the
    roster list, boxed and titled as one feature of the Rogue Lineage
    widget (alongside the Mana bar overlay box below) rather than reading
    as the whole widget. suggestions_overlay is kept as a Stack sibling
    of just this box's own header row + list, rather than of the whole
    screen, so a Positioned Stack child (which paints on top of every
    later sibling regardless of where in the flow it's anchored) only
    covers this box's own content, and its top offset only needs to
    clear the header row's own height."""

    content_body = ft.Column(
        [text_title(_HEADER_TITLE), characters_section, mana_section, keybinds_section],
        spacing=SPACE_LG,
    )

    content = ft.Column(
        [content_body],
        scroll=ft.ScrollMode.AUTO,
        margin=scroll_margin(),
    )

    return ft.View(
        route=widget_route(WIDGET_ID),
        padding=0,
        horizontal_alignment=ft.CrossAxisAlignment.STRETCH,
        controls=[build_layout(page, content)],
        services=[file_picker],
    )


def _build_mana_bar_overlay_section(page: ft.Page) -> ft.Control:
    """The Mana bar overlay section: pick a screen area, add shaded
    highlight bands inside it, and pin the result on top of everything
    else while Roblox is open.

    Mirrors widgets/image_overlay/widget.py's area-picking flow (pick
    area, edit fields directly, Start/Stop, watch for Roblox), but draws
    shapes instead of an image, and always watches for Roblox rather than
    offering a choice of app - this section only exists for lining up
    with an in-game bar, so watching anything else wouldn't make sense.

    There's no fill-direction control - a taller-than-wide area is
    treated as a vertical bar (0% at the bottom, 100% at the top), a
    wider-than-tall one as horizontal (0% at the left, 100% at the
    right), the same guess backend/mana_bar_overlay.py makes from the
    area's own width and height. The area picked over the real bar
    already says which shape it is.
    """
    area = get_widget_setting(page, WIDGET_ID, "mana_bar_area", DEFAULT_MANA_AREA)
    highlights: list[dict] = list(
        get_widget_setting(page, WIDGET_ID, "mana_bar_highlights", DEFAULT_MANA_HIGHLIGHTS)
    )
    border_color = get_widget_setting(
        page, WIDGET_ID, "mana_bar_border_color", DEFAULT_BORDER_COLOR_HEX
    )
    border_width = get_widget_setting(
        page, WIDGET_ID, "mana_bar_border_width", DEFAULT_BORDER_WIDTH
    )

    status_dot_widget = status_dot(_MANA_STATE_COLORS["Stopped"])
    status_text = text_heading("Stopped")

    def set_status_visual(state: str):
        """Update the status dot and label together for one overlay run state."""
        status_dot_widget.bgcolor = _MANA_STATE_COLORS[state]
        status_text.value = state

    x_field = ft.TextField(label="X", value=str(area["x"]), expand=True)
    y_field = ft.TextField(label="Y", value=str(area["y"]), expand=True)
    width_field = ft.TextField(label="Width", value=str(area["width"]), expand=True)
    height_field = ft.TextField(label="Height", value=str(area["height"]), expand=True)

    def _square_area_button_style() -> ft.ButtonStyle:
        return ft.ButtonStyle(
            shape=ft.RoundedRectangleBorder(radius=radius_card(page)),
            bgcolor=ft.Colors.SURFACE_CONTAINER_HIGHEST,
        )

    pick_area_button = ft.IconButton(
        icon=ft.Icons.CROP_FREE,
        tooltip="Pick area on screen. Drag to draw the area, Enter to save, Esc to cancel.",
        style=_square_area_button_style(),
        width=48,
        height=48,
    )
    revert_area_button = ft.IconButton(
        icon=ft.Icons.UNDO,
        visible=False,
        tooltip="Restore the previous area.",
        style=_square_area_button_style(),
        width=48,
        height=48,
    )
    orientation_text = text_caption(_describe_orientation(area))
    highlights_column = ft.Column(
        spacing=SPACE_XS, horizontal_alignment=ft.CrossAxisAlignment.STRETCH
    )

    border_color_swatch = ft.Container(
        width=_COLOR_SWATCH_SIZE,
        height=_COLOR_SWATCH_SIZE,
        bgcolor=border_color,
        border=card_border(),
        border_radius=radius_card(page),
        tooltip="Pick border color",
    )
    border_width_field = ft.TextField(
        label="Border width",
        value=str(border_width),
        dense=True,
        width=_TRANSPARENCY_FIELD_WIDTH,
        keyboard_type=ft.KeyboardType.NUMBER,
    )

    new_name_field = ft.TextField(
        label="Name (optional)", dense=True, width=_NAME_FIELD_WIDTH
    )
    new_start_field = ft.TextField(
        label="Start %",
        dense=True,
        width=_PERCENT_FIELD_WIDTH,
        keyboard_type=ft.KeyboardType.NUMBER,
    )
    new_end_field = ft.TextField(
        label="End %", dense=True, width=_PERCENT_FIELD_WIDTH, keyboard_type=ft.KeyboardType.NUMBER
    )
    new_transparency_field = ft.TextField(
        label="Transparency",
        value=str(DEFAULT_HIGHLIGHT_TRANSPARENCY),
        dense=True,
        width=_TRANSPARENCY_FIELD_WIDTH,
        keyboard_type=ft.KeyboardType.NUMBER,
        tooltip="0 = opaque, 1 = see-through",
    )
    new_color_swatch = ft.Container(
        width=_COLOR_SWATCH_SIZE,
        height=_COLOR_SWATCH_SIZE,
        bgcolor=DEFAULT_HIGHLIGHT_COLOR_HEX,
        border=card_border(),
        border_radius=radius_card(page),
        tooltip="Pick color",
    )
    add_button = ft.IconButton(icon=ft.Icons.ADD, tooltip="Add highlight")
    start_button = ft.FilledButton("On", icon=ft.Icons.PLAY_ARROW)
    stop_button = ft.OutlinedButton("Off", icon=ft.Icons.STOP, disabled=True)

    armed = False
    committed_area = dict(area)
    previous_area: Optional[dict] = None
    numbers_edit_index: Optional[int] = None
    new_color = DEFAULT_HIGHLIGHT_COLOR_HEX

    def _editable_controls() -> list[ft.Control]:
        return [
            x_field, y_field, width_field, height_field,
            pick_area_button, revert_area_button,
            border_color_swatch, border_width_field,
            new_name_field, new_start_field, new_end_field, new_transparency_field,
            new_color_swatch, add_button,
        ]

    def set_state(is_armed: bool, active: bool):
        """Reflect the current arm/active state in the status text and
        control disabled-states, same shape as
        widgets/image_overlay/widget.py::set_state.

        Also collapses any highlight chip that's mid-edit - editing
        while the overlay is running would leave disabled, unsaveable
        fields open with no way to close them.
        """
        nonlocal armed, numbers_edit_index
        armed = is_armed
        if is_armed:
            numbers_edit_index = None
        if not is_armed:
            set_status_visual("Stopped")
        elif active:
            set_status_visual("Running")
        else:
            set_status_visual("Waiting for Roblox to be the active window...")
        start_button.disabled = is_armed
        stop_button.disabled = not is_armed
        for control in _editable_controls():
            control.disabled = is_armed
        render_highlights()
        page.update()

    def _apply_area(new_area: dict):
        nonlocal committed_area, previous_area
        if new_area != committed_area:
            previous_area = dict(committed_area)
            revert_area_button.visible = True
        committed_area = dict(new_area)
        set_widget_setting(page, WIDGET_ID, "mana_bar_area", committed_area)
        orientation_text.value = _describe_orientation(committed_area)

    def _set_area_fields(values: dict):
        x_field.value = str(values["x"])
        y_field.value = str(values["y"])
        width_field.value = str(values["width"])
        height_field.value = str(values["height"])

    def save_area() -> dict:
        current = _parse_mana_area(x_field, y_field, width_field, height_field, committed_area)
        _set_area_fields(current)
        _apply_area(current)
        return current

    def on_revert_area(e: ft.Event[ft.TextButton]):
        nonlocal committed_area, previous_area
        if previous_area is None:
            return
        restored = dict(previous_area)
        _set_area_fields(restored)
        set_widget_setting(page, WIDGET_ID, "mana_bar_area", restored)
        committed_area = restored
        previous_area = None
        revert_area_button.visible = False
        orientation_text.value = _describe_orientation(committed_area)
        page.update()

    async def on_pick_area(e: ft.Event[ft.OutlinedButton]):
        pick_area_button.disabled = True
        page.update()
        picked = await _pick_mana_area()
        pick_area_button.disabled = armed
        if picked is not None:
            _set_area_fields(picked)
            _apply_area(picked)
        page.update()

    def on_area_field_blur(e: ft.Event[ft.TextField]):
        save_area()
        page.update()

    def _highlight_chip(index: int, highlight: dict) -> ft.Control:
        """One highlight in the list: a color swatch and a name/percent-
        range label, each with its own hover-revealed pencil instead of
        one shared Edit button. Clicking the color pencil opens
        _open_color_dialog; clicking the numbers pencil swaps the label
        for inline text fields that save on blur or Enter, until the
        pencil (now a checkmark) is clicked again to collapse it.
        """
        is_editing = numbers_edit_index == index

        def on_remove(e: ft.Event[ft.IconButton]):
            nonlocal numbers_edit_index
            highlights.pop(index)
            if numbers_edit_index == index:
                numbers_edit_index = None
            elif numbers_edit_index is not None and numbers_edit_index > index:
                numbers_edit_index -= 1
            set_widget_setting(page, WIDGET_ID, "mana_bar_highlights", highlights)
            render_highlights()

        def on_color_chosen(new_hex: str):
            highlight["color"] = new_hex
            set_widget_setting(page, WIDGET_ID, "mana_bar_highlights", highlights)
            render_highlights()

        def on_color_click(e: ft.Event[ft.Container]):
            _open_color_dialog(
                page, highlight.get("color", DEFAULT_HIGHLIGHT_COLOR_HEX), on_color_chosen
            )

        color_pencil_ref: ft.Ref[ft.Container] = ft.Ref()

        def on_color_hover(e: ft.Event[ft.Container]):
            if color_pencil_ref.current is None:
                return
            color_pencil_ref.current.opacity = 1 if e.data == "true" else 0
            color_pencil_ref.current.update()

        color_zone = ft.Container(
            content=ft.Stack(
                [
                    ft.Container(
                        width=24, height=24, bgcolor=highlight["color"], border_radius=6
                    ),
                    ft.Container(
                        ref=color_pencil_ref,
                        content=ft.Icon(ft.Icons.EDIT, size=12, color=ft.Colors.WHITE),
                        width=24,
                        height=24,
                        border_radius=6,
                        bgcolor=ft.Colors.with_opacity(0.55, ft.Colors.BLACK),
                        alignment=ft.Alignment.CENTER,
                        opacity=0,
                        animate_opacity=150,
                    ),
                ],
                width=24,
                height=24,
            ),
            tooltip="Edit color",
            on_hover=on_color_hover,
            on_click=on_color_click,
            disabled=armed,
        )

        def on_toggle_numbers_edit(e: ft.Event[ft.IconButton]):
            nonlocal numbers_edit_index
            numbers_edit_index = None if is_editing else index
            render_highlights()

        if is_editing:
            edit_name = ft.TextField(
                value=highlight.get("name", ""),
                hint_text="Name",
                dense=True,
                width=_NAME_FIELD_WIDTH,
            )
            edit_start = ft.TextField(
                value=f"{highlight['start']:g}",
                hint_text="Start %",
                dense=True,
                width=_PERCENT_FIELD_WIDTH,
                keyboard_type=ft.KeyboardType.NUMBER,
            )
            edit_end = ft.TextField(
                value=f"{highlight['end']:g}",
                hint_text="End %",
                dense=True,
                width=_PERCENT_FIELD_WIDTH,
                keyboard_type=ft.KeyboardType.NUMBER,
            )
            edit_transparency = ft.TextField(
                value=str(highlight.get("transparency", DEFAULT_HIGHLIGHT_TRANSPARENCY)),
                hint_text="Transparency",
                dense=True,
                width=_TRANSPARENCY_FIELD_WIDTH,
                keyboard_type=ft.KeyboardType.NUMBER,
            )

            def save_numbers(e: ft.Event[ft.TextField]):
                try:
                    start = float(edit_start.value)
                    end = float(edit_end.value)
                except (TypeError, ValueError):
                    show_toast(page, "Start and end have to be numbers.")
                    return
                try:
                    transparency = float(edit_transparency.value)
                except (TypeError, ValueError):
                    show_toast(page, "Transparency has to be a number from 0 to 1.")
                    return
                start = max(0.0, min(100.0, start))
                end = max(0.0, min(100.0, end))
                if end <= start:
                    show_toast(page, "End has to be greater than start.")
                    return
                if not 0.0 <= transparency <= 1.0:
                    show_toast(page, "Transparency has to be between 0 and 1.")
                    return
                highlight.update(
                    name=(edit_name.value or "").strip(),
                    start=start,
                    end=end,
                    transparency=transparency,
                )
                set_widget_setting(page, WIDGET_ID, "mana_bar_highlights", highlights)

            for field in (edit_name, edit_start, edit_end, edit_transparency):
                field.on_blur = save_numbers
                field.on_submit = save_numbers

            numbers_zone: ft.Control = ft.Row(
                [
                    ft.Row(
                        [edit_name, edit_start, edit_end, edit_transparency],
                        spacing=SPACE_SM,
                        wrap=True,
                    ),
                    ft.IconButton(
                        icon=ft.Icons.CHECK,
                        icon_size=14,
                        tooltip="Done editing",
                        on_click=on_toggle_numbers_edit,
                    ),
                ],
                vertical_alignment=ft.CrossAxisAlignment.CENTER,
            )
        else:
            range_text = (
                f"{highlight['start']:g}% - {highlight['end']:g}% "
                f"({highlight.get('transparency', DEFAULT_HIGHLIGHT_TRANSPARENCY):g} transparency)"
            )
            label = f"{highlight['name']} · {range_text}" if highlight.get("name") else range_text

            numbers_pencil_ref: ft.Ref[ft.Container] = ft.Ref()

            def on_numbers_hover(e: ft.Event[ft.Container]):
                if numbers_pencil_ref.current is None:
                    return
                numbers_pencil_ref.current.opacity = 1 if e.data == "true" else 0
                numbers_pencil_ref.current.update()

            numbers_zone = ft.Container(
                content=ft.Row(
                    [
                        ft.Text(label, size=12, expand=True),
                        ft.Container(
                            ref=numbers_pencil_ref,
                            content=ft.Icon(ft.Icons.EDIT_OUTLINED, size=14),
                            opacity=0,
                            animate_opacity=150,
                        ),
                    ],
                    vertical_alignment=ft.CrossAxisAlignment.CENTER,
                ),
                expand=True,
                tooltip="Edit",
                on_hover=on_numbers_hover,
                on_click=on_toggle_numbers_edit,
                disabled=armed,
            )

        return ft.Container(
            content=ft.Row(
                [
                    color_zone,
                    numbers_zone,
                    ft.IconButton(
                        icon=ft.Icons.CLOSE, icon_size=14, on_click=on_remove, disabled=armed
                    ),
                ],
                spacing=SPACE_SM,
                vertical_alignment=ft.CrossAxisAlignment.CENTER,
            ),
            padding=ft.Padding.symmetric(
                horizontal=SPACE_SM, vertical=SPACE_XS if is_editing else 2
            ),
            bgcolor=ft.Colors.SURFACE_CONTAINER_HIGHEST,
            border_radius=radius_card(page) if is_editing else RADIUS_PILL,
        )

    def render_highlights(mounted: bool = True):
        if not highlights:
            highlights_column.controls = [text_caption("No highlights added yet.")]
        else:
            highlights_column.controls = [
                _highlight_chip(index, highlight) for index, highlight in enumerate(highlights)
            ]
        if mounted:
            highlights_column.update()

    def on_border_color_chosen(new_hex: str):
        border_color_swatch.bgcolor = new_hex
        border_color_swatch.update()
        set_widget_setting(page, WIDGET_ID, "mana_bar_border_color", new_hex)

    def on_border_color_click(e: ft.Event[ft.Container]):
        _open_color_dialog(page, border_color_swatch.bgcolor, on_border_color_chosen)

    border_color_swatch.on_click = on_border_color_click

    def on_border_width_blur(e: ft.Event[ft.TextField]):
        try:
            width = max(1, int(border_width_field.value))
        except (TypeError, ValueError):
            width = DEFAULT_BORDER_WIDTH
        border_width_field.value = str(width)
        border_width_field.update()
        set_widget_setting(page, WIDGET_ID, "mana_bar_border_width", width)

    border_width_field.on_blur = on_border_width_blur
    border_width_field.on_submit = on_border_width_blur

    def on_new_color_chosen(new_hex: str):
        nonlocal new_color
        new_color = new_hex
        new_color_swatch.bgcolor = new_color
        new_color_swatch.update()

    def on_new_color_click(e: ft.Event[ft.Container]):
        _open_color_dialog(page, new_color, on_new_color_chosen)

    new_color_swatch.on_click = on_new_color_click

    def on_add_highlight(e: ft.Event[ft.IconButton]):
        nonlocal new_color
        try:
            start = float(new_start_field.value)
            end = float(new_end_field.value)
        except (TypeError, ValueError):
            show_toast(page, "Start and end have to be numbers.")
            return
        try:
            transparency = float(new_transparency_field.value)
        except (TypeError, ValueError):
            show_toast(page, "Transparency has to be a number from 0 to 1.")
            return
        start = max(0.0, min(100.0, start))
        end = max(0.0, min(100.0, end))
        if end <= start:
            show_toast(page, "End has to be greater than start.")
            return
        if not 0.0 <= transparency <= 1.0:
            show_toast(page, "Transparency has to be between 0 and 1.")
            return
        highlights.append(
            {
                "name": (new_name_field.value or "").strip(),
                "start": start,
                "end": end,
                "color": new_color,
                "transparency": transparency,
            }
        )
        set_widget_setting(page, WIDGET_ID, "mana_bar_highlights", highlights)
        new_name_field.value = ""
        new_start_field.value = ""
        new_end_field.value = ""
        new_transparency_field.value = str(DEFAULT_HIGHLIGHT_TRANSPARENCY)
        new_color = DEFAULT_HIGHLIGHT_COLOR_HEX
        new_color_swatch.bgcolor = new_color
        new_name_field.update()
        new_start_field.update()
        new_end_field.update()
        new_transparency_field.update()
        new_color_swatch.update()
        render_highlights()

    def _disarm():
        poll_state = page.session.store.get(_MANA_POLL_STATE_KEY)
        if poll_state is not None:
            poll_state["armed"] = False
        page.session.store.set(_MANA_POLL_STATE_KEY, None)

    def on_line(data: dict):
        error = data.get("error")
        if error:
            set_status_visual("Error")
            page.session.store.set(_MANA_PROCESS_KEY, None)
            _disarm()
            set_state(False, False)
            show_toast(page, error)

    def on_exit(code: int):
        page.session.store.set(_MANA_PROCESS_KEY, None)
        poll_state = page.session.store.get(_MANA_POLL_STATE_KEY)
        if poll_state is not None and poll_state["armed"]:
            set_state(True, False)
        else:
            _disarm()
            set_state(False, False)

    async def _poll_roblox(command: list[str], poll_state: dict):
        """While armed, start the overlay backend when Roblox is the
        active (foreground) window and stop it the moment it isn't -
        alt-tabbing away hides the overlay, not just closing the game -
        checking every MANA_POLL_INTERVAL_SECONDS.
        """
        while poll_state["armed"]:
            target_active = await asyncio.to_thread(is_roblox_active)
            if not poll_state["armed"]:
                break
            current_process: WidgetProcess | None = page.session.store.get(_MANA_PROCESS_KEY)
            if target_active and current_process is None:
                widget_process = await start_process(
                    page, *command, on_line=on_line, on_exit=on_exit
                )
                if not poll_state["armed"]:
                    stop_process(widget_process)
                    break
                page.session.store.set(_MANA_PROCESS_KEY, widget_process)
                set_state(True, True)
            elif not target_active and current_process is not None:
                stop_process(current_process)
                page.session.store.set(_MANA_PROCESS_KEY, None)
                set_state(True, False)
            await asyncio.sleep(MANA_POLL_INTERVAL_SECONDS)

    async def _run_always(command: list[str], poll_state: dict):
        """Start the overlay backend once and leave it running regardless
        of whether Roblox is open or focused - used when the "wait for
        Roblox" setting is off.
        """
        widget_process = await start_process(page, *command, on_line=on_line, on_exit=on_exit)
        if not poll_state["armed"]:
            stop_process(widget_process)
            return
        page.session.store.set(_MANA_PROCESS_KEY, widget_process)
        set_state(True, True)

    async def on_start(e: ft.Event[ft.FilledButton]):
        current_area = save_area()
        try:
            current_border_width = max(1, int(border_width_field.value))
        except (TypeError, ValueError):
            current_border_width = DEFAULT_BORDER_WIDTH
        command = _mana_backend_command(
            current_area,
            highlights,
            DEFAULT_MANA_CLICK_THROUGH,
            border_color_swatch.bgcolor,
            current_border_width,
        )
        wait_for_roblox = get_widget_setting(
            page, WIDGET_ID, "mana_bar_wait_for_roblox", DEFAULT_MANA_WAIT_FOR_ROBLOX
        )
        poll_state = {"armed": True}
        page.session.store.set(_MANA_POLL_STATE_KEY, poll_state)
        set_state(True, False)
        if wait_for_roblox:
            page.run_task(_poll_roblox, command, poll_state)
        else:
            page.run_task(_run_always, command, poll_state)

    def on_stop(e: ft.Event[ft.FilledButton]):
        _disarm()
        widget_process: WidgetProcess | None = page.session.store.get(_MANA_PROCESS_KEY)
        if widget_process is not None:
            stop_process(widget_process)
        page.session.store.set(_MANA_PROCESS_KEY, None)
        set_state(False, False)

    pick_area_button.on_click = on_pick_area
    revert_area_button.on_click = on_revert_area
    for field in (x_field, y_field, width_field, height_field):
        field.on_blur = on_area_field_blur
    add_button.on_click = on_add_highlight
    start_button.on_click = on_start
    stop_button.on_click = on_stop

    render_highlights(mounted=False)

    status_row = ft.Row(
        [
            ft.Row(
                [status_dot_widget, status_text],
                spacing=SPACE_SM,
                vertical_alignment=ft.CrossAxisAlignment.CENTER,
                expand=True,
            ),
            ft.Row([start_button, stop_button], spacing=SPACE_SM),
        ],
        vertical_alignment=ft.CrossAxisAlignment.CENTER,
    )

    return section_box(
        page,
        ft.Column(
            [
                text_section("Mana bar overlay"),
                text_caption(
                    "Pins a shaded rectangle over an in-game bar, so its thresholds "
                    "are easy to spot at a glance."
                ),
                status_row,
                text_label("Area"),
                ft.Row(
                    [x_field, y_field, width_field, height_field, pick_area_button, revert_area_button],
                    spacing=SPACE_SM,
                    vertical_alignment=ft.CrossAxisAlignment.CENTER,
                ),
                orientation_text,
                text_label("Style"),
                ft.Row(
                    [border_color_swatch, border_width_field],
                    spacing=SPACE_SM,
                    vertical_alignment=ft.CrossAxisAlignment.CENTER,
                ),
                text_label("Highlights"),
                highlights_column,
                ft.Row(
                    [
                        new_name_field,
                        new_start_field,
                        new_end_field,
                        new_transparency_field,
                        new_color_swatch,
                        add_button,
                    ],
                    wrap=True,
                    spacing=SPACE_SM,
                    vertical_alignment=ft.CrossAxisAlignment.CENTER,
                ),
            ],
            spacing=SPACE_SM,
            horizontal_alignment=ft.CrossAxisAlignment.STRETCH,
        ),
    )


def _build_keybinds_section(page: ft.Page) -> ft.Control:
    """The Keybinds section: remap physical keys onto Rogue Lineage's own
    1-9, 0, -, = hotbar row, system-wide.

    Each row is one keybind: a captured input key (press "Add keybind",
    then press any key) paired with an output key restricted to
    OUTPUT_KEY_OPTIONS via a dropdown next to it. Runs automatically
    whenever at least one keybind is configured - there's no separate
    Start/Off button, only the "Only while Roblox is the active window"
    setting under Settings -> Widgets -> Rogue Lineage, since the whole
    point is that pressing the input key produces the output key instead,
    with nothing to arm by hand.

    The actual remap is Windows-only (see backend/key_remapper.py's
    docstring for why) - the status line reports that plainly rather than
    silently doing nothing on macOS.
    """
    key_remaps: list[dict] = list(
        get_widget_setting(page, WIDGET_ID, "key_remaps", DEFAULT_KEY_REMAPS)
    )

    status_dot_widget = status_dot(_KEYREMAP_STATE_COLORS["Off"])
    status_text = text_heading("Off")

    def set_status_visual(state: str):
        status_dot_widget.bgcolor = _KEYREMAP_STATE_COLORS[state]
        status_text.value = state

    remaps_column = ft.Column(spacing=SPACE_XS, horizontal_alignment=ft.CrossAxisAlignment.STRETCH)
    add_button = ft.OutlinedButton("Add keybind", icon=ft.Icons.ADD)
    capture_hint = ft.Text(
        "", size=12, weight=ft.FontWeight.W_600, color=ft.Colors.PRIMARY, visible=False
    )

    def _remap_row(index: int, remap: dict) -> ft.Control:
        def on_output_change(e: ft.Event[ft.Dropdown]):
            remap["output"] = e.control.value
            set_widget_setting(page, WIDGET_ID, "key_remaps", key_remaps)

        def on_remove(e: ft.Event[ft.IconButton]):
            key_remaps.pop(index)
            set_widget_setting(page, WIDGET_ID, "key_remaps", key_remaps)
            render_remaps()

        return ft.Container(
            content=ft.Row(
                [
                    ft.Text(remap["label"], size=13, weight=ft.FontWeight.W_600),
                    ft.Icon(ft.Icons.ARROW_RIGHT_ALT, size=18),
                    ft.Dropdown(
                        value=remap["output"],
                        options=[ft.dropdown.Option(key=k, text=k) for k in OUTPUT_KEY_OPTIONS],
                        dense=True,
                        width=90,
                        on_select=on_output_change,
                    ),
                    ft.Container(expand=True),
                    ft.IconButton(icon=ft.Icons.CLOSE, icon_size=16, on_click=on_remove),
                ],
                spacing=SPACE_SM,
                vertical_alignment=ft.CrossAxisAlignment.CENTER,
            ),
            padding=ft.Padding.symmetric(horizontal=SPACE_SM, vertical=SPACE_XS),
            bgcolor=ft.Colors.SURFACE_CONTAINER_HIGHEST,
            border_radius=radius_card(page),
        )

    def render_remaps(mounted: bool = True):
        remaps_column.controls = (
            [_remap_row(i, r) for i, r in enumerate(key_remaps)]
            if key_remaps
            else [text_caption("No keybinds added yet.")]
        )
        if mounted:
            remaps_column.update()

    capture_armed = False

    def cancel_capture():
        nonlocal capture_armed
        capture_armed = False
        add_button.disabled = False
        add_button.text = "Add keybind"
        capture_hint.value = ""
        capture_hint.visible = False

    def on_keyremap_keyboard_event(e: ft.KeyboardEvent):
        if not capture_armed:
            if previous_keyboard_handler:
                previous_keyboard_handler(e)
            return

        if e.key == "Escape":
            cancel_capture()
            page.update()
            return

        cancel_capture()
        captured = _keyboard_event_to_remap_input(e)
        if captured is None:
            show_toast(page, "That key can't be used as a keybind. Try a different one.")
            page.update()
            return

        label, input_key = captured
        if any(r["input"] == input_key for r in key_remaps):
            show_toast(page, f'"{label}" is already bound to a keybind.')
            page.update()
            return

        key_remaps.append({"label": label, "input": input_key, "output": OUTPUT_KEY_OPTIONS[0]})
        set_widget_setting(page, WIDGET_ID, "key_remaps", key_remaps)
        render_remaps()
        page.update()

    previous_keyboard_handler = page.on_keyboard_event
    page.on_keyboard_event = on_keyremap_keyboard_event

    def on_add_click(e: ft.Event[ft.OutlinedButton]):
        nonlocal capture_armed
        capture_armed = True
        add_button.disabled = True
        add_button.text = "Press a key…"
        capture_hint.value = "Press any key… (Esc to cancel)"
        capture_hint.visible = True
        page.update()

    add_button.on_click = on_add_click

    def on_keyremap_line(data: dict):
        error = data.get("error")
        if error:
            set_status_visual("Error")
            page.session.store.set(_KEYREMAP_PROCESS_KEY, None)
            page.session.store.set(_KEYREMAP_CONFIG_KEY, None)
            page.session.store.set(_KEYREMAP_CHAT_OPEN_KEY, False)
            page.update()
            show_toast(page, error)
            return

        status = data.get("status")
        if status in ("chat_open", "chat_closed"):
            page.session.store.set(_KEYREMAP_CHAT_OPEN_KEY, status == "chat_open")
            if page.session.store.get(_KEYREMAP_PROCESS_KEY) is not None:
                set_status_visual(
                    "Paused - chat is open" if status == "chat_open" else "Active"
                )
                page.update()

    def on_keyremap_exit(code: int):
        page.session.store.set(_KEYREMAP_PROCESS_KEY, None)
        page.session.store.set(_KEYREMAP_CONFIG_KEY, None)
        page.session.store.set(_KEYREMAP_CHAT_OPEN_KEY, False)

    async def key_remap_loop(generation: int):
        """Keep the key remapper process in sync with the configured
        keybinds and, if "Only while Roblox is active" is on, with
        whether Roblox is currently the active window - for as long as
        this exact view build is the one on screen.

        Same generation-scoped shape as sync_loop above, combined with
        the config-diff restart Autoclicker's sync_listener uses for its
        own keybind listener: re-reads settings every tick rather than
        trusting closed-over state, so a change from another render of
        this same section (e.g. the output dropdown, or a remove) is
        picked up on the next tick without a dedicated signal.
        """
        while True:
            if (
                not page.views
                or page.views[-1].route != widget_route(WIDGET_ID)
                or page.session.store.get(_KEYREMAP_GENERATION_KEY) != generation
            ):
                existing_process: WidgetProcess | None = page.session.store.get(
                    _KEYREMAP_PROCESS_KEY
                )
                if existing_process is not None:
                    stop_process(existing_process)
                    page.session.store.set(_KEYREMAP_PROCESS_KEY, None)
                page.session.store.set(_KEYREMAP_CONFIG_KEY, None)
                page.session.store.set(_KEYREMAP_CHAT_OPEN_KEY, False)
                return

            current_remaps: list[dict] = get_widget_setting(
                page, WIDGET_ID, "key_remaps", DEFAULT_KEY_REMAPS
            )
            current_wait_for_roblox = get_widget_setting(
                page, WIDGET_ID, "key_remaps_wait_for_roblox", DEFAULT_KEYREMAP_WAIT_FOR_ROBLOX
            )
            current_stop_when_chat_open = get_widget_setting(
                page,
                WIDGET_ID,
                "key_remaps_stop_when_chat_open",
                DEFAULT_KEYREMAP_STOP_WHEN_CHAT_OPEN,
            )
            pairs = [[r["input"], r["output"]] for r in current_remaps]

            roblox_active = (
                await asyncio.to_thread(is_roblox_active) if current_wait_for_roblox else True
            )
            should_run = bool(pairs) and roblox_active
            config = (
                json.dumps({"pairs": pairs, "stop_when_chat_open": current_stop_when_chat_open})
                if should_run
                else None
            )

            existing_process = page.session.store.get(_KEYREMAP_PROCESS_KEY)
            existing_config = page.session.store.get(_KEYREMAP_CONFIG_KEY)
            if config != existing_config:
                if existing_process is not None:
                    stop_process(existing_process)
                    page.session.store.set(_KEYREMAP_PROCESS_KEY, None)
                page.session.store.set(_KEYREMAP_CHAT_OPEN_KEY, False)
                if config is not None:
                    process = await start_process(
                        page,
                        *_key_remapper_command(pairs, current_stop_when_chat_open),
                        on_line=on_keyremap_line,
                        on_exit=on_keyremap_exit,
                    )
                    page.session.store.set(_KEYREMAP_PROCESS_KEY, process)
                page.session.store.set(_KEYREMAP_CONFIG_KEY, config)

            if not pairs:
                set_status_visual("Off")
            elif not roblox_active:
                set_status_visual("Waiting for Roblox to be the active window...")
            elif page.session.store.get(_KEYREMAP_PROCESS_KEY) is not None:
                set_status_visual(
                    "Paused - chat is open"
                    if page.session.store.get(_KEYREMAP_CHAT_OPEN_KEY)
                    else "Active"
                )
            page.update()

            await asyncio.sleep(KEYREMAP_POLL_INTERVAL_SECONDS)

    render_remaps(mounted=False)

    generation = (page.session.store.get(_KEYREMAP_GENERATION_KEY) or 0) + 1
    page.session.store.set(_KEYREMAP_GENERATION_KEY, generation)
    page.run_task(key_remap_loop, generation)

    return section_box(
        page,
        ft.Column(
            [
                text_section("Keybinds"),
                text_caption(
                    "Presses of an input key are replaced system-wide with the output "
                    "key next to it, from Rogue Lineage's own 1-9, 0, -, = hotbar row. "
                    "Windows only."
                ),
                ft.Row(
                    [status_dot_widget, status_text],
                    spacing=SPACE_SM,
                    vertical_alignment=ft.CrossAxisAlignment.CENTER,
                ),
                capture_hint,
                remaps_column,
                add_button,
            ],
            spacing=SPACE_SM,
            horizontal_alignment=ft.CrossAxisAlignment.STRETCH,
        ),
    )


def _info_chip(text: str) -> ft.Control:
    return ft.Container(
        content=ft.Text(text, size=11),
        padding=ft.Padding.symmetric(horizontal=SPACE_SM, vertical=2),
        bgcolor=ft.Colors.SURFACE_CONTAINER_HIGHEST,
        border_radius=RADIUS_PILL,
    )


def build_settings(page: ft.Page) -> ft.Control:
    """Rogue Lineage's Settings section: whether the Mana bar overlay
    waits for Roblox to be the active window before displaying, and
    whether the Keybinds remapper only runs while Roblox is active.

    Same reasoning as widgets/image_overlay/widget.py::build_settings -
    this is app-wide behavior, not something worth re-deciding each time
    the screen opens, so it lives only here.
    """

    def on_mana_wait_for_roblox_change(e: ft.Event[ft.Checkbox]):
        set_widget_setting(page, WIDGET_ID, "mana_bar_wait_for_roblox", e.control.value)

    mana_wait_for_roblox = get_widget_setting(
        page, WIDGET_ID, "mana_bar_wait_for_roblox", DEFAULT_MANA_WAIT_FOR_ROBLOX
    )

    def on_keybinds_wait_for_roblox_change(e: ft.Event[ft.Checkbox]):
        set_widget_setting(page, WIDGET_ID, "key_remaps_wait_for_roblox", e.control.value)

    keybinds_wait_for_roblox = get_widget_setting(
        page, WIDGET_ID, "key_remaps_wait_for_roblox", DEFAULT_KEYREMAP_WAIT_FOR_ROBLOX
    )

    def on_keybinds_stop_when_chat_open_change(e: ft.Event[ft.Checkbox]):
        set_widget_setting(page, WIDGET_ID, "key_remaps_stop_when_chat_open", e.control.value)

    keybinds_stop_when_chat_open = get_widget_setting(
        page,
        WIDGET_ID,
        "key_remaps_stop_when_chat_open",
        DEFAULT_KEYREMAP_STOP_WHEN_CHAT_OPEN,
    )

    return ft.Column(
        [
            text_caption("Mana bar overlay", weight=ft.FontWeight.W_600),
            ft.Checkbox(
                label="Wait for Roblox to be open?",
                tooltip="Hide the Mana bar overlay whenever Roblox isn't the active window.",
                value=mana_wait_for_roblox,
                on_change=on_mana_wait_for_roblox_change,
            ),
            text_caption("Keybinds", weight=ft.FontWeight.W_600),
            ft.Checkbox(
                label="Only while Roblox is the active window",
                value=keybinds_wait_for_roblox,
                on_change=on_keybinds_wait_for_roblox_change,
            ),
            ft.Checkbox(
                label="Stop when chat is open",
                tooltip=(
                    "Pause keybinds while Roblox's chat box is open, so the input key "
                    "types into chat instead of triggering its remapped hotbar key."
                ),
                value=keybinds_stop_when_chat_open,
                on_change=on_keybinds_stop_when_chat_open_change,
            ),
        ],
        spacing=SPACE_XS,
    )


WIDGET = Widget(
    id=WIDGET_ID,
    name="Rogue Lineage",
    description="Track Rogue Lineage characters: class, race, notes, and items.",
    build_view=build_view,
    build_settings=build_settings,
    icon=ft.Icons.SHIELD_OUTLINED,
    selected_icon=ft.Icons.SHIELD,
    logo=LOGO_PATH,
    logo_size=1.5,
)
