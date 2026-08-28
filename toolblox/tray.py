"""The system tray icon shown when "Run in background" is on.

pystray runs its own blocking loop on a background thread, since it isn't
asyncio-aware. Its menu callbacks fire on that thread too, so they must
never touch `page` state directly - they hand off to the page's event
loop via `page.run_task`, which is safe to call from another thread
(it wraps `asyncio.run_coroutine_threadsafe`).
"""

import sys
import threading
from pathlib import Path
from typing import Optional

import flet as ft
from PIL import Image

from toolblox.logs import get_logger
from toolblox.widgets.process import stop_all_processes

try:
    import pystray
except ImportError:
    pystray = None

logger = get_logger(__name__)

_icon: Optional["pystray.Icon"] = None
_icon_lock = threading.Lock()


def _assets_dir() -> Path:
    """Locate the `assets/` folder in both a source checkout and a frozen build.

    A packaged build (see `toolblox/startup.py` and `toolblox/devtools.py`,
    which use the same `sys.frozen` check) ships `assets/` next to
    `sys.executable`; running from source, it sits at the repo root.
    """
    if getattr(sys, "frozen", False):
        return Path(sys.executable).parent / "assets"
    return Path(__file__).resolve().parent.parent / "assets"


def _build_icon_image() -> Image.Image:
    """Load the app's own logo (`assets/logo.png`, a rasterized `logo.svg`) for the tray icon."""
    return Image.open(_assets_dir() / "logo.png").convert("RGBA")


def is_supported() -> bool:
    """Whether a tray icon can be shown on this platform."""
    return pystray is not None and sys.platform in ("win32", "darwin", "linux")


def is_showing() -> bool:
    return _icon is not None


def show(page: ft.Page) -> None:
    """Show the tray icon, if it isn't already showing.

    Safe to call repeatedly; a no-op while the icon is already up.
    """
    global _icon
    if not is_supported():
        return

    with _icon_lock:
        if _icon is not None:
            return

        def on_open(icon, item):
            page.run_task(_restore, page)

        def on_quit(icon, item):
            page.run_task(_quit, page)

        image = _build_icon_image()
        menu = pystray.Menu(
            pystray.MenuItem("Open Toolblox", on_open, default=True),
            pystray.MenuItem("Quit", on_quit),
        )
        _icon = pystray.Icon("toolblox", image, "Toolblox", menu)
        threading.Thread(target=_icon.run, daemon=True).start()


def hide() -> None:
    """Remove the tray icon, if one is showing."""
    global _icon
    with _icon_lock:
        if _icon is None:
            return
        _icon.stop()
        _icon = None


async def _restore(page: ft.Page) -> None:
    """Bring the window back from the tray."""
    hide()
    page.window.skip_task_bar = False
    page.window.visible = True
    await page.window.to_front()
    page.update()


async def _quit(page: ft.Page) -> None:
    """Fully exit the app from the tray menu, bypassing prevent_close."""
    hide()
    stop_all_processes(page)
    page.window.prevent_close = False
    await page.window.destroy()
