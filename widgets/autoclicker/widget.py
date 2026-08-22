"""Autoclicker: clicks repeatedly at the cursor.

Its UI is built with Flet, same as any widget: Flet can only render
controls from Python code running on its own event loop, so that part
stays Python no matter what. The actual clicking, though, runs entirely
outside Python, as a platform-native script this file starts, stops, and
reads status from over stdout (see toolblox/widgets/process.py).

- Windows: backend/click_windows.ps1, a PowerShell script that calls
  user32.dll's mouse_event directly. No extra dependencies.
- macOS: backend/click_macos.sh, a shell script that shells out to
  cliclick (`brew install cliclick`), since AppleScript/System Events
  can't post synthetic clicks at an arbitrary screen position without it.

Two more backends run alongside the click loop, both cross-platform
Python scripts started the same "external process, JSON over stdout"
way:

- backend/keybind_listener.py, using pynput to listen system-wide for
  configured start/stop hotkeys, so clicking can be toggled without
  switching focus back to Toolblox. The same key can be bound as both
  the start and the stop keybind for one Autoclicker instance: pressing
  it then acts like a NOT gate on the running state, on if it was off
  and off if it was on, rather than needing separate keys for each
  direction. The "Use toggle keybinds" switch, in Settings -> Widgets ->
  Autoclicker, exposes exactly this, as a single keybind list instead of
  requiring the same key to be added to both the start and stop lists by
  hand - every key in that one list is sent to the listener as both a
  start and a stop hotkey, so each one is a toggle on its own.
- backend/overlay.py, a small always-on-top tkinter window shown while
  clicking is active, so it's visible even when Toolblox itself is in
  the background.

To try this widget locally, copy this folder into WIDGETS_DIR (the path
shown in Settings -> Widgets).
"""

import asyncio
import json
import re
import sys
from pathlib import Path

import flet as ft

from toolblox.state import get_widget_setting, set_widget_setting
from toolblox.ui.layout import build_layout, widget_route
from toolblox.ui.style import (
    SPACE_LG,
    SPACE_SM,
    SPACE_XL,
    SPACE_XS,
    SWITCH_SCALE,
    card_border,
    radius_card,
    radius_hero,
    scroll_margin,
    status_dot,
    text_caption,
    text_heading,
    text_label,
    text_section,
    text_title,
)
from toolblox.ui.toast import show_toast
from toolblox.widgets.api import Widget
from toolblox.widgets.process import WidgetProcess, start_process, stop_process

BACKEND_DIR = Path(__file__).parent / "backend"

WIDGET_ID = "autoclicker"
_CLICK_PROCESS_KEY = f"_{WIDGET_ID}_click_process"
_LISTENER_PROCESS_KEY = f"_{WIDGET_ID}_listener_process"
_LISTENER_CONFIG_KEY = f"_{WIDGET_ID}_listener_config"
_OVERLAY_PROCESS_KEY = f"_{WIDGET_ID}_overlay_process"

DEFAULT_CPS = 10
CPS_MIN = 1
CPS_MAX = 20
"""Honest bounds for clicks-per-second, not just a round number.

20 CPS is a 50ms interval, which stays comfortably above the ~15.6ms
tick Windows' default scheduler resolution allows, so the backend script
can actually hit the rate it's asked for (it also raises the timer
resolution to 1ms itself, but that's a best-effort request, not a
guarantee). Higher than this and the reported click count starts
drifting from the requested rate rather than reflecting a real limit
worth exposing in the UI.
"""

DEFAULT_BUTTON = "left"
RANDOMIZE_PERCENT = 15
"""Jitter applied per click when "Randomize timing" is on, as a percent
of the base interval in either direction."""

DEFAULT_SHOW_INDICATOR = True
DEFAULT_RANDOMIZE_TIMING = True
DEFAULT_USE_TOGGLE_KEYBINDS = False
DEFAULT_INDICATOR_POSITION = None
"""No saved position means the indicator falls back to overlay.py's own
default corner placement."""

_STATE_COLORS = {
    "Stopped": ft.Colors.OUTLINE_VARIANT,
    "Running": ft.Colors.GREEN,
    "Error": ft.Colors.ERROR,
}
"""Semantic color per run state, for the hero card's status dot - the
same running/stopped/error idiom the Accounts screen's presence dot
uses, so "is this active" reads the same way across the app."""

DEFAULT_SPEED_UNIT = "cps"
MS_MIN = round(1000 / CPS_MAX)
MS_MAX = round(1000 / CPS_MIN)
"""Whether the speed field reads in clicks-per-second or interval-in-
milliseconds is a per-user preference (see Settings), not something the
Autoclicker screen itself needs to ask about every time it opens. Speed
is still stored canonically as CPS either way - see _cps_to_ms/_ms_to_cps -
so switching the preference doesn't lose or rescale a saved default."""


def _cps_to_ms(cps: int) -> int:
    return round(1000 / cps)


def _ms_to_cps(ms: int) -> int:
    return max(CPS_MIN, min(CPS_MAX, round(1000 / ms)))


def _clamp_speed_input(raw: str, unit: str) -> int:
    """Parse a speed field's raw text, in the given unit, into canonical CPS."""
    try:
        value = int(raw)
    except ValueError:
        value = MS_MIN if unit == "ms" else DEFAULT_CPS
    if unit == "ms":
        return _ms_to_cps(max(MS_MIN, min(MS_MAX, value)))
    return max(CPS_MIN, min(CPS_MAX, value))


def _speed_field_props(unit: str, cps: int) -> tuple[str, str, str]:
    """(label, helper text, field value) for the speed field, in the given unit."""
    if unit == "ms":
        return "Interval (ms)", f"{MS_MIN}-{MS_MAX}", str(_cps_to_ms(cps))
    return "Clicks per second", f"{CPS_MIN}-{CPS_MAX}", str(cps)

_FUNCTION_KEY_RE = re.compile(r"^F([1-9]|1[0-9]|2[0-4])$")

_SPECIAL_KEY_MAP = {
    "Escape": "esc",
    "Enter": "enter",
    "Space": "space",
    "Tab": "tab",
    "Backspace": "backspace",
    "Delete": "delete",
    "Insert": "insert",
    "Home": "home",
    "End": "end",
    "Page Up": "page_up",
    "Page Down": "page_down",
    "Arrow Up": "up",
    "Arrow Down": "down",
    "Arrow Left": "left",
    "Arrow Right": "right",
}


def _keyboard_event_to_hotkey(e: ft.KeyboardEvent) -> tuple[str, str] | None:
    """Convert a Flet key press into a (label, pynput hotkey string) pair.

    Returns None if the key alone isn't a usable hotkey, e.g. a modifier
    pressed on its own with nothing else, or "+" (see below).

    Letters and digits are lowercased into the token and their case
    restored separately via an explicit "<shift>" token, so the token
    itself stays canonical regardless of whether the key was typed with
    Shift held. Punctuation and symbol keys such as "/" or "~" have no
    such canonical unshifted form to fall back on, so they're passed
    through as-is instead: pynput's hotkey parser treats any single
    character literally (matched against the character the OS actually
    produced), which is exactly what `e.key` already reports, whether or
    not Shift changed it. "+" is the one character that can't be used,
    since it's the separator this module's own hotkey strings are joined
    with, not a limitation of pynput's format.
    """
    key = e.key
    if key in ("Shift", "Control", "Alt", "Meta"):
        return None

    if len(key) == 1 and key.isalnum():
        main_token = key.lower()
        main_label = key.upper()
    elif len(key) == 1 and key.isprintable() and not key.isspace():
        if key == "+":
            return None
        main_token = key
        main_label = key
    elif _FUNCTION_KEY_RE.match(key):
        main_token = key.lower()
        main_label = key
    elif key in _SPECIAL_KEY_MAP:
        main_token = _SPECIAL_KEY_MAP[key]
        main_label = key
    else:
        return None

    tokens = []
    labels = []
    if e.ctrl:
        tokens.append("<ctrl>")
        labels.append("Ctrl")
    if e.alt:
        tokens.append("<alt>")
        labels.append("Alt")
    if e.shift:
        tokens.append("<shift>")
        labels.append("Shift")
    if e.meta:
        tokens.append("<cmd>")
        labels.append("Win" if sys.platform == "win32" else "Cmd")

    tokens.append(main_token if len(main_token) == 1 else f"<{main_token}>")
    labels.append(main_label)

    return "+".join(labels), "+".join(tokens)


def _click_backend_command(cps: int, button: str, randomize: bool) -> list[str]:
    """The platform-specific command that runs the click loop."""
    interval_ms = round(1000 / cps)
    randomize_percent = RANDOMIZE_PERCENT if randomize else 0
    if sys.platform == "win32":
        return [
            "powershell",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(BACKEND_DIR / "click_windows.ps1"),
            "-IntervalMs",
            str(interval_ms),
            "-Button",
            button,
            "-RandomizePercent",
            str(randomize_percent),
        ]
    return [
        "/bin/bash",
        str(BACKEND_DIR / "click_macos.sh"),
        str(interval_ms),
        button,
        str(randomize_percent),
    ]


def _keybind_listener_command(start_hotkeys: list[str], stop_hotkeys: list[str]) -> list[str]:
    """The command that starts `backend/keybind_listener.py`.

    Each hotkey list is passed as a JSON-encoded argument, matching what
    that script expects to parse from `sys.argv`.
    """
    return [
        sys.executable,
        str(BACKEND_DIR / "keybind_listener.py"),
        json.dumps(start_hotkeys),
        json.dumps(stop_hotkeys),
    ]


def _overlay_command(position: dict | None) -> list[str]:
    """The command that starts the on-screen "running" indicator process.

    `position`, if set, is a `{"x", "y"}` dict from the drag-to-position
    picker; omitted entirely when unset, so overlay.py falls back to its
    own default corner placement.
    """
    command = [sys.executable, str(BACKEND_DIR / "overlay.py")]
    if position is not None:
        command += ["--x", str(position["x"]), "--y", str(position["y"])]
    return command


async def _pick_indicator_position() -> dict | None:
    """Run the drag-to-position picker and return the corner it was left at.

    Same one-shot subprocess pattern as
    widgets/rogue_lineage/widget.py::_pick_mana_area.
    """
    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        str(BACKEND_DIR / "position_picker.py"),
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
    return {"x": data["x"], "y": data["y"]}


def build_view(page: ft.Page) -> ft.View:
    """The Autoclicker's own screen: speed, button, keybinds, indicator."""
    speed_unit = get_widget_setting(page, WIDGET_ID, "speed_unit", DEFAULT_SPEED_UNIT)
    show_indicator = get_widget_setting(page, WIDGET_ID, "show_indicator", DEFAULT_SHOW_INDICATOR)
    indicator_position: dict | None = get_widget_setting(
        page, WIDGET_ID, "indicator_position", DEFAULT_INDICATOR_POSITION
    )
    randomize_timing = get_widget_setting(
        page, WIDGET_ID, "randomize_timing", DEFAULT_RANDOMIZE_TIMING
    )
    start_keybinds: list[dict] = get_widget_setting(page, WIDGET_ID, "start_keybinds", [])
    stop_keybinds: list[dict] = get_widget_setting(page, WIDGET_ID, "stop_keybinds", [])
    toggle_keybinds: list[dict] = get_widget_setting(page, WIDGET_ID, "toggle_keybinds", [])
    use_toggle_keybinds = get_widget_setting(
        page, WIDGET_ID, "use_toggle_keybinds", DEFAULT_USE_TOGGLE_KEYBINDS
    )

    already_running = page.session.store.get(_CLICK_PROCESS_KEY) is not None
    """Whether a click process is already running when this view builds.

    True when a keybind started clicking while the user was on another
    screen. Every control below starts from this instead of always
    assuming "Stopped", so the screen doesn't show a stale Start button
    for a loop that's actually already running.
    """

    initial_state = "Running" if already_running else "Stopped"
    status_dot_widget = status_dot(_STATE_COLORS[initial_state])
    status_text = text_heading(initial_state)
    count_text = text_caption("Clicks: 0")

    def set_state_visual(state: str):
        """Update the hero's status dot and label together for one run state."""
        status_dot_widget.bgcolor = _STATE_COLORS[state]
        status_text.value = state
    speed_label, speed_helper, speed_value = _speed_field_props(speed_unit, DEFAULT_CPS)
    cps_field = ft.TextField(
        label=speed_label,
        value=speed_value,
        width=160,
        helper=speed_helper,
        disabled=already_running,
        dense=True,
    )
    button_group = ft.RadioGroup(
        value=DEFAULT_BUTTON,
        disabled=already_running,
        content=ft.Row(
            [
                ft.Radio(value="left", label="Left click"),
                ft.Radio(value="middle", label="Middle click"),
                ft.Radio(value="right", label="Right click"),
            ]
        ),
    )
    indicator_checkbox = ft.Checkbox(
        label="Show on-screen indicator while running", value=show_indicator
    )

    def _position_caption_text() -> str:
        if indicator_position is None:
            return "Position: default (bottom-right corner)"
        return f"Position: ({indicator_position['x']}, {indicator_position['y']})"

    position_caption = text_caption(_position_caption_text())
    pick_position_button = ft.OutlinedButton(
        "Pick position on screen...",
        tooltip="Drag the indicator to where you want it, Enter to save, Esc to cancel.",
        disabled=already_running,
    )
    reset_position_button = ft.TextButton(
        "Reset to default",
        icon=ft.Icons.UNDO,
        visible=indicator_position is not None,
        disabled=already_running,
    )

    randomize_checkbox = ft.Checkbox(
        label=f"Randomize timing slightly (±{RANDOMIZE_PERCENT}%)", value=randomize_timing
    )
    start_button = ft.FilledButton("Start", icon=ft.Icons.PLAY_ARROW, disabled=already_running)
    stop_button = ft.OutlinedButton("Stop", icon=ft.Icons.STOP, disabled=not already_running)

    start_chips_row = ft.Row(wrap=True, spacing=SPACE_SM)
    stop_chips_row = ft.Row(wrap=True, spacing=SPACE_SM)
    toggle_chips_row = ft.Row(wrap=True, spacing=SPACE_SM)
    add_start_button = ft.OutlinedButton("Add keybind", icon=ft.Icons.ADD)
    add_stop_button = ft.OutlinedButton("Add keybind", icon=ft.Icons.ADD)
    add_toggle_button = ft.OutlinedButton("Add keybind", icon=ft.Icons.ADD)
    capture_hint = ft.Text(
        "", size=12, weight=ft.FontWeight.W_600, color=ft.Colors.PRIMARY, visible=False
    )

    def set_running(running: bool):
        set_state_visual("Running" if running else "Stopped")
        start_button.disabled = running
        stop_button.disabled = not running
        cps_field.disabled = running
        button_group.disabled = running
        pick_position_button.disabled = running
        reset_position_button.disabled = running
        page.update()

    def on_click_line(data: dict):
        error = data.get("error")
        if error:
            set_state_visual("Error")
            count_text.value = error
            page.update()
            return
        count = data.get("count")
        if count is not None:
            count_text.value = f"Clicks: {count}"
            page.update()

    def on_click_exit(code: int):
        page.session.store.set(_CLICK_PROCESS_KEY, None)
        set_running(False)

    async def stop_overlay():
        """Stop the running indicator process, if one is active."""
        overlay_process: WidgetProcess | None = page.session.store.get(_OVERLAY_PROCESS_KEY)
        if overlay_process is not None:
            stop_process(overlay_process)
        page.session.store.set(_OVERLAY_PROCESS_KEY, None)

    async def start_clicking():
        """Start the click backend, and the overlay indicator if enabled.

        A no-op if a click process is already running, so this is safe to
        call from both the Start button and the keybind listener without
        double-starting.
        """
        if page.session.store.get(_CLICK_PROCESS_KEY) is not None:
            return
        cps = _clamp_speed_input(cps_field.value, speed_unit)
        cps_field.value = _speed_field_props(speed_unit, cps)[2]
        button = button_group.value or DEFAULT_BUTTON
        command = _click_backend_command(cps, button, randomize_checkbox.value)
        widget_process = await start_process(
            page, *command, on_line=on_click_line, on_exit=on_click_exit
        )
        page.session.store.set(_CLICK_PROCESS_KEY, widget_process)
        if indicator_checkbox.value:
            overlay_process = await start_process(page, *_overlay_command(indicator_position))
            page.session.store.set(_OVERLAY_PROCESS_KEY, overlay_process)
        set_running(True)

    async def stop_clicking():
        """Stop the click backend and its overlay indicator, if running."""
        widget_process: WidgetProcess | None = page.session.store.get(_CLICK_PROCESS_KEY)
        if widget_process is not None:
            stop_process(widget_process)
        page.session.store.set(_CLICK_PROCESS_KEY, None)
        await stop_overlay()
        set_running(False)

    async def on_start(e: ft.Event[ft.FilledButton]):
        await start_clicking()

    async def on_stop(e: ft.Event[ft.FilledButton]):
        await stop_clicking()

    start_button.on_click = on_start
    stop_button.on_click = on_stop

    def on_listener_line(data: dict):
        """Route a keybind listener event to the click start/stop path.

        The listener process only ever reports which action fired; it
        doesn't drive the click backend itself, so this dispatches to the
        same start_clicking()/stop_clicking() coroutines the Start/Stop
        buttons use.

        A "toggle" event means the pressed key is bound as both a start
        and a stop keybind for this action - the listener can't tell on
        its own which one that should mean, since it has no idea whether
        clicking is currently running, so it defers that decision here,
        where the real state (_CLICK_PROCESS_KEY) is available.
        """
        event = data.get("event")
        if event == "start":
            page.run_task(start_clicking)
        elif event == "stop":
            page.run_task(stop_clicking)
        elif event == "toggle":
            if page.session.store.get(_CLICK_PROCESS_KEY) is not None:
                page.run_task(stop_clicking)
            else:
                page.run_task(start_clicking)
        elif data.get("error"):
            show_toast(page, data["error"])

    def make_on_listener_exit(process_box: dict):
        """A listener may be replaced (keybinds changed) before its old
        process actually finishes exiting. Only clear the tracked process
        if it's still the one this particular exit belongs to, so a
        stale exit callback can't wipe out a newer listener's state.
        """

        def on_listener_exit(code: int):
            if page.session.store.get(_LISTENER_PROCESS_KEY) is process_box.get("process"):
                page.session.store.set(_LISTENER_PROCESS_KEY, None)
                page.session.store.set(_LISTENER_CONFIG_KEY, None)

        return on_listener_exit

    async def sync_listener():
        """(Re)start the global keybind listener if the bound keys changed.

        Runs on every view build and after every keybind add/remove, so
        the listener always matches what's currently configured. It's
        deliberately not tied to this view's own lifecycle beyond that:
        once started, it keeps listening even after navigating away, the
        same way the click process itself is allowed to keep running.

        In toggle-keybind mode, every key in `toggle_keybinds` is sent as
        both a start and a stop hotkey - the same shared-hotkey NOT gate
        the listener already applies when a key happens to be bound to
        both lists (see the module docstring), just driven from one list
        instead of two.
        """
        if use_toggle_keybinds:
            toggle_hotkeys = [kb["hotkey"] for kb in toggle_keybinds]
            start_hotkeys = toggle_hotkeys
            stop_hotkeys = toggle_hotkeys
        else:
            start_hotkeys = [kb["hotkey"] for kb in start_keybinds]
            stop_hotkeys = [kb["hotkey"] for kb in stop_keybinds]
        config = json.dumps([start_hotkeys, stop_hotkeys])

        existing_process: WidgetProcess | None = page.session.store.get(_LISTENER_PROCESS_KEY)
        existing_config = page.session.store.get(_LISTENER_CONFIG_KEY)
        if existing_config == config:
            return

        if existing_process is not None:
            stop_process(existing_process)
            page.session.store.set(_LISTENER_PROCESS_KEY, None)

        if not start_hotkeys and not stop_hotkeys:
            page.session.store.set(_LISTENER_CONFIG_KEY, None)
            return

        process_box: dict = {}
        command = _keybind_listener_command(start_hotkeys, stop_hotkeys)
        listener_process = await start_process(
            page, *command, on_line=on_listener_line, on_exit=make_on_listener_exit(process_box)
        )
        process_box["process"] = listener_process
        page.session.store.set(_LISTENER_PROCESS_KEY, listener_process)
        page.session.store.set(_LISTENER_CONFIG_KEY, config)

    def render_chips(mounted: bool = True):
        """Rebuild the start/stop keybind chip rows from current state.

        A keybind bound in both lists gets "(toggle)" appended to its
        chip label in each - see the module docstring's note on shared
        start/stop keybinds for what that means at runtime.

        `mounted=False` skips calling `.update()` on the rows, for use
        during initial view construction before the page has rendered
        them yet.
        """
        shared_hotkeys = {kb["hotkey"] for kb in start_keybinds} & {
            kb["hotkey"] for kb in stop_keybinds
        }

        def chip_for(keybind: dict, keybinds: list[dict], setting_key: str):
            def on_delete(e: ft.Event[ft.Chip]):
                keybinds.remove(keybind)
                set_widget_setting(page, WIDGET_ID, setting_key, keybinds)
                render_chips()
                page.run_task(sync_listener)

            label = keybind["label"]
            if keybind["hotkey"] in shared_hotkeys:
                label = f"{label} (toggle)"
            return ft.Chip(label=label, on_delete=on_delete)

        start_chips_row.controls = (
            [chip_for(kb, start_keybinds, "start_keybinds") for kb in start_keybinds]
            if start_keybinds
            else [text_caption("No keybind set.")]
        )
        stop_chips_row.controls = (
            [chip_for(kb, stop_keybinds, "stop_keybinds") for kb in stop_keybinds]
            if stop_keybinds
            else [text_caption("No keybind set.")]
        )

        def toggle_chip_for(keybind: dict):
            def on_delete(e: ft.Event[ft.Chip]):
                toggle_keybinds.remove(keybind)
                set_widget_setting(page, WIDGET_ID, "toggle_keybinds", toggle_keybinds)
                render_chips()
                page.run_task(sync_listener)

            return ft.Chip(label=keybind["label"], on_delete=on_delete)

        toggle_chips_row.controls = (
            [toggle_chip_for(kb) for kb in toggle_keybinds]
            if toggle_keybinds
            else [text_caption("No keybind set.")]
        )
        if mounted:
            start_chips_row.update()
            stop_chips_row.update()
            toggle_chips_row.update()

    capture: dict = {"keybinds": None, "setting_key": None}
    """Which list a captured key should go into, or both None when no
    capture is armed. A plain dict instead of separate variables so
    on_page_keyboard_event (a closure defined once, below) can read
    whatever start_capture() last wrote to it.
    """

    def cancel_capture():
        """Disarm capture and restore all "Add keybind" buttons."""
        capture["keybinds"] = None
        capture["setting_key"] = None
        add_start_button.disabled = False
        add_stop_button.disabled = False
        add_toggle_button.disabled = False
        add_start_button.text = "Add keybind"
        add_stop_button.text = "Add keybind"
        add_toggle_button.text = "Add keybind"
        capture_hint.value = ""
        capture_hint.visible = False

    def on_page_keyboard_event(e: ft.KeyboardEvent):
        """The page's one and only keyboard handler, registered once below.

        start_capture() doesn't assign a fresh `page.on_keyboard_event`
        of its own for each capture - Flet doesn't reliably swap out a
        dynamically-reassigned page-level handler, so a second capture
        could end up silently ignored, or both the old and new handler
        firing together. Registering a single handler up front and
        gating its behavior on the `capture` dict sidesteps that
        entirely: nothing about the handler itself ever changes, only
        the state it reads.

        A no-op whenever no capture is armed (`capture["keybinds"] is
        None`), which is the normal case.
        """
        if capture["keybinds"] is None:
            return

        if e.key == "Escape":
            cancel_capture()
            page.update()
            return

        keybinds = capture["keybinds"]
        setting_key = capture["setting_key"]
        cancel_capture()

        captured = _keyboard_event_to_hotkey(e)
        if captured is None:
            show_toast(page, "That key can't be used as a keybind. Try a different one.")
            page.update()
            return

        label, hotkey = captured
        if any(kb["hotkey"] == hotkey for kb in keybinds):
            show_toast(page, f'"{label}" is already used for this action.')
            page.update()
            return

        keybinds.append({"label": label, "hotkey": hotkey})
        set_widget_setting(page, WIDGET_ID, setting_key, keybinds)
        render_chips()
        page.update()
        page.run_task(sync_listener)

    page.on_keyboard_event = on_page_keyboard_event

    def start_capture(keybinds: list[dict], setting_key: str, add_button: ft.OutlinedButton):
        """Arm on_page_keyboard_event to capture the next key press.

        Disables both "Add keybind" buttons, relabels the one that was
        pressed, and shows an explicit "Press a key…" hint next to them -
        a button label change alone is easy to miss, especially since
        both buttons briefly go from enabled to disabled at the same
        moment the pressed one's own label changes.

        The same start and stop keybind can be captured here without
        conflict - see the module docstring.
        """
        capture["keybinds"] = keybinds
        capture["setting_key"] = setting_key
        add_start_button.disabled = True
        add_stop_button.disabled = True
        add_toggle_button.disabled = True
        add_button.text = "Press a key…"
        capture_hint.value = "Press any key… (Esc to cancel)"
        capture_hint.visible = True
        page.update()

    add_start_button.on_click = lambda e: start_capture(
        start_keybinds, "start_keybinds", add_start_button
    )
    add_stop_button.on_click = lambda e: start_capture(
        stop_keybinds, "stop_keybinds", add_stop_button
    )
    add_toggle_button.on_click = lambda e: start_capture(
        toggle_keybinds, "toggle_keybinds", add_toggle_button
    )

    def on_indicator_change(e: ft.Event[ft.Checkbox]):
        set_widget_setting(page, WIDGET_ID, "show_indicator", e.control.value)

    async def on_pick_position(e: ft.Event[ft.OutlinedButton]):
        nonlocal indicator_position
        pick_position_button.disabled = True
        page.update()
        picked = await _pick_indicator_position()
        pick_position_button.disabled = already_running
        if picked is not None:
            indicator_position = picked
            set_widget_setting(page, WIDGET_ID, "indicator_position", indicator_position)
            position_caption.value = _position_caption_text()
            reset_position_button.visible = True
        page.update()

    def on_reset_position(e: ft.Event[ft.TextButton]):
        nonlocal indicator_position
        indicator_position = None
        set_widget_setting(page, WIDGET_ID, "indicator_position", None)
        position_caption.value = _position_caption_text()
        reset_position_button.visible = False
        page.update()

    pick_position_button.on_click = on_pick_position
    reset_position_button.on_click = on_reset_position

    def on_randomize_change(e: ft.Event[ft.Checkbox]):
        set_widget_setting(page, WIDGET_ID, "randomize_timing", e.control.value)

    indicator_checkbox.on_change = on_indicator_change
    randomize_checkbox.on_change = on_randomize_change

    render_chips(mounted=False)
    page.run_task(sync_listener)

    hero_card = ft.Container(
        content=ft.Row(
            [
                ft.Column(
                    [
                        ft.Row(
                            [status_dot_widget, status_text],
                            spacing=SPACE_SM,
                            vertical_alignment=ft.CrossAxisAlignment.CENTER,
                        ),
                        count_text,
                    ],
                    spacing=SPACE_XS,
                    expand=True,
                ),
                ft.Row([start_button, stop_button], spacing=SPACE_SM),
            ],
            spacing=SPACE_LG,
            vertical_alignment=ft.CrossAxisAlignment.CENTER,
        ),
        padding=SPACE_XL,
        border=card_border(),
        border_radius=radius_hero(page),
    )

    settings_card = ft.Container(
        content=ft.Column(
            [
                text_section("Settings"),
                ft.Row(
                    [cps_field, button_group],
                    spacing=SPACE_LG,
                    vertical_alignment=ft.CrossAxisAlignment.START,
                ),
                ft.Column([indicator_checkbox, randomize_checkbox], spacing=0),
                ft.Row(
                    [pick_position_button, reset_position_button],
                    wrap=True,
                    spacing=SPACE_SM,
                ),
                position_caption,
            ],
            spacing=SPACE_SM,
        ),
        padding=SPACE_SM,
        border=card_border(),
        border_radius=radius_card(page),
    )

    start_stop_section = ft.Column(
        [
            text_label("Turn on with"),
            ft.Row([start_chips_row, add_start_button], wrap=True, spacing=SPACE_SM),
            text_label("Turn off with"),
            ft.Row([stop_chips_row, add_stop_button], wrap=True, spacing=SPACE_SM),
        ],
        spacing=SPACE_SM,
        visible=not use_toggle_keybinds,
    )

    toggle_section = ft.Column(
        [
            text_label("Toggle with"),
            ft.Row([toggle_chips_row, add_toggle_button], wrap=True, spacing=SPACE_SM),
        ],
        spacing=SPACE_SM,
        visible=use_toggle_keybinds,
    )

    keybinds_card = ft.Container(
        content=ft.Column(
            [
                text_section("Keybinds"),
                text_caption(
                    "Any of these keys works globally, even while another window has focus."
                ),
                text_caption(
                    "Off: separate keys turn clicking on and off. On: each key in one "
                    "list turns clicking on if it's off, and off if it's on. Change this "
                    "in Settings -> Widgets -> Autoclicker."
                ),
                capture_hint,
                start_stop_section,
                toggle_section,
            ],
            spacing=SPACE_SM,
        ),
        padding=SPACE_SM,
        border=card_border(),
        border_radius=radius_card(page),
    )

    content = ft.Column(
        [
            text_title("Autoclicker"),
            text_caption(
                "Repeatedly clicks at the current cursor position. Its click "
                "loop runs as a separate platform script, not Python. Move "
                "the cursor to where you want it clicking before pressing Start."
            ),
            hero_card,
            settings_card,
            keybinds_card,
        ],
        spacing=SPACE_LG,
        scroll=ft.ScrollMode.AUTO,
        margin=scroll_margin(),
        horizontal_alignment=ft.CrossAxisAlignment.STRETCH,
    )

    return ft.View(
        route=widget_route("autoclicker"),
        padding=0,
        horizontal_alignment=ft.CrossAxisAlignment.STRETCH,
        controls=[build_layout(page, content)],
    )


def build_settings(page: ft.Page) -> ft.Control:
    """The Autoclicker's Settings section: speed unit and toggle keybinds.

    Speed and click button are already fully set on the Autoclicker
    screen itself each time it's used, so neither is a setting worth
    duplicating here. Speed unit is: it's a display preference the
    Autoclicker screen has no room to ask about every time it opens, for
    whether its speed field works in clicks-per-second or interval-in-
    milliseconds.

    Whether the keybinds section uses one toggle list instead of separate
    start/stop lists is also a preference rather than something set per
    session, so it lives here too, next to speed unit, instead of as a
    switch on the Autoclicker screen itself.
    """

    def on_speed_unit_change(e: ft.Event[ft.RadioGroup]):
        if e.control.value is not None:
            set_widget_setting(page, WIDGET_ID, "speed_unit", e.control.value)

    def on_use_toggle_keybinds_change(e: ft.Event[ft.Switch]):
        set_widget_setting(page, WIDGET_ID, "use_toggle_keybinds", e.control.value)

    speed_unit = get_widget_setting(page, WIDGET_ID, "speed_unit", DEFAULT_SPEED_UNIT)
    use_toggle_keybinds = get_widget_setting(
        page, WIDGET_ID, "use_toggle_keybinds", DEFAULT_USE_TOGGLE_KEYBINDS
    )

    return ft.Column(
        [
            text_label("Speed unit"),
            text_caption(
                "Whether the Autoclicker screen's speed field works in "
                "clicks-per-second or interval-in-milliseconds."
            ),
            ft.RadioGroup(
                value=speed_unit,
                on_change=on_speed_unit_change,
                content=ft.Row(
                    [
                        ft.Radio(value="cps", label="Clicks per second"),
                        ft.Radio(value="ms", label="Interval (ms)"),
                    ]
                ),
            ),
            text_label("Use toggle keybinds"),
            ft.Row(
                [
                    text_caption(
                        "Off: separate keys turn clicking on and off. On: each key in "
                        "one list turns clicking on if it's off, and off if it's on.",
                        expand=True,
                    ),
                    ft.Switch(
                        value=use_toggle_keybinds,
                        on_change=on_use_toggle_keybinds_change,
                        scale=SWITCH_SCALE,
                    ),
                ],
                vertical_alignment=ft.CrossAxisAlignment.CENTER,
            ),
        ],
        spacing=SPACE_SM,
    )


WIDGET = Widget(
    id=WIDGET_ID,
    name="Autoclicker",
    description="Clicks repeatedly at the cursor. Backend runs outside Python.",
    build_view=build_view,
    build_settings=build_settings,
    icon=ft.Icons.MOUSE_OUTLINED,
    selected_icon=ft.Icons.MOUSE,
)
