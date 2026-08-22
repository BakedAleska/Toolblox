"""Global key remapper backend for the Rogue Lineage widget's Keybinds section.

Uses the `keyboard` library rather than pynput, which every other backend in
this project uses for hotkey listening. pynput's global suppress mode blocks
every key at once, not a chosen few, so it can't do a selective remap; a
remap needs to swallow one specific physical key system-wide and inject a
different one in its place, which is what `keyboard.remap_key` does via a
low-level Windows hook.

Windows only. The `keyboard` library needs a uinput device and root on
Linux, and has no macOS backend at all, so this refuses to start on any
other platform rather than silently doing nothing.

Usage: key_remapper.py <pairs_json> [--stop-when-chat-open]
`pairs_json` is a JSON list of [input_key, output_key] pairs, both
`keyboard` library key names, e.g. '[["y", "9"], ["f13", "1"]]'.

`--stop-when-chat-open` pauses every remap while Roblox's own chat box is
open, so an input key types into chat instead of triggering its remapped
hotbar key. There's no OS-level signal for "Roblox's chat is open" - this
infers it from the same key/mouse activity that opens and closes the chat
in-game: pressing "/" opens it, and either pressing Enter or clicking
anywhere closes it. This is a heuristic, not a read of Roblox's own UI
state, so it can drift out of sync with the real chat box in edge cases
(e.g. "/" typed while already in another text field) - it's meant to
cover the common case, not be exact.

Prints one {"error": "..."} line and exits on any failure. With
`--stop-when-chat-open`, also prints {"status": "chat_open"} and
{"status": "chat_closed"} lines as that heuristic flips. Otherwise stays
silent and blocks until killed.
"""

import argparse
import json
import sys


def _print(data: dict) -> None:
    print(json.dumps(data), flush=True)


def main() -> None:
    if sys.platform != "win32":
        _print({"error": "Keybind remapping is only supported on Windows."})
        sys.exit(1)

    parser = argparse.ArgumentParser()
    parser.add_argument("pairs_json")
    parser.add_argument("--stop-when-chat-open", action="store_true")
    try:
        args = parser.parse_args()
    except SystemExit:
        _print({"error": "key_remapper.py needs a keybind pairs argument."})
        sys.exit(1)

    try:
        pairs = json.loads(args.pairs_json)
    except ValueError:
        _print({"error": "Couldn't parse the keybind pairs."})
        sys.exit(1)

    if not pairs:
        _print({"error": "No keybinds were configured."})
        sys.exit(1)

    import keyboard

    def apply_remaps():
        for input_key, output_key in pairs:
            keyboard.remap_key(input_key, output_key)

    def clear_remaps():
        for input_key, output_key in pairs:
            keyboard.unremap_key(input_key)

    try:
        apply_remaps()

        if args.stop_when_chat_open:
            from pynput import mouse

            chat_open = False

            def on_slash(_event):
                nonlocal chat_open
                if not chat_open:
                    chat_open = True
                    clear_remaps()
                    _print({"status": "chat_open"})

            def on_enter(_event):
                nonlocal chat_open
                if chat_open:
                    chat_open = False
                    apply_remaps()
                    _print({"status": "chat_closed"})

            def on_click(x, y, button, pressed):
                if pressed:
                    on_enter(None)

            keyboard.on_press_key("/", on_slash)
            keyboard.on_press_key("enter", on_enter)
            mouse.Listener(on_click=on_click).start()

        keyboard.wait()
    except Exception as exc:
        _print({"error": f"Key remapper failed to start: {exc}"})
        sys.exit(1)


if __name__ == "__main__":
    main()
