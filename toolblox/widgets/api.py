"""The contract a widget must implement, and shared helpers for it."""

from dataclasses import dataclass
from typing import Any, Callable, Optional

import flet as ft


@dataclass
class DashboardTile:
    """A single at-a-glance module a widget contributes to the Dashboard.

    `build` returns only the tile's inner content, such as an icon and a
    line of text. The Dashboard wraps it in the standard card chrome, so
    widget tiles look consistent with the built-in ones.
    """

    id: str
    """Unique (per-widget) id for this tile, e.g. "playtime"."""

    build: Callable[[ft.Page], ft.Control]
    """Given the page, return the tile's inner content."""

    wide: bool = False
    """If True, the tile spans two grid columns instead of one."""


@dataclass
class Widget:
    """The contract a widget module must satisfy.

    A widget lives at `<widgets folder>/<your_folder>/widget.py` and must
    expose a module-level `WIDGET` variable holding one of these.
    """

    id: str
    """Short, unique, filesystem-and-route-safe id, e.g. "rogue_lineage"."""

    name: str
    """Display name shown in the nav rail and Settings, e.g. "Rogue Lineage"."""

    build_view: Callable[[ft.Page], ft.View]
    """Same shape as the built-in views (DashboardView, AccountsView, ...):
    given the page, return the ft.View shown when this widget's nav item is
    selected."""

    icon: Optional[Any] = None
    """A ft.Icons value for the nav item. Defaults to ft.Icons.EXTENSION."""

    selected_icon: Optional[Any] = None
    """A ft.Icons value used when this widget's nav item is selected.
    Falls back to `icon` if not given."""

    dashboard_tiles: Optional[Callable[[ft.Page], list[DashboardTile]]] = None
    """Optional: given the page, return the tiles this widget contributes
    to the Dashboard. Called fresh on every Dashboard build, so tiles can
    reflect current state. Omit, or return [], to contribute nothing."""

    description: str = ""
    """Short, one-line description shown on the widget's square on the
    Widgets screen and in its tooltip."""

    logo: Optional[str] = None
    """Optional image src (a path or URL) shown on the widget's square
    instead of `icon`. Falls back to `icon` if not given."""

    logo_size: float = 1.0
    """Scale factor applied to `logo` (or `icon`, if no logo is set)
    wherever this widget's glyph is drawn: its square on the Widgets
    screen and its row in the sidebar nav rail. 1.0 is the standard
    size every other widget uses; e.g. 1.5 draws it 50% larger, useful
    for a logo that reads small at the default size."""

    build_settings: Optional[Callable[[ft.Page], ft.Control]] = None
    """Optional: given the page, return this widget's settings content.

    If set, the widget gets its own titled section under Settings ->
    Widgets, and a settings button appears on its square on the Widgets
    screen that jumps straight there. Omit if the widget has no settings
    of its own.

    For a widget with enough settings that one flat section gets hard to
    scan, return an `ft.Tabs` control here with `ft.TabBar(secondary=True,
    ...)` instead of a plain Column. `secondary=True` gives a nested tab
    bar styled to sit inside the outer Settings tabs, rather than looking
    like a second top-level tab row."""

    on_app_start: Optional[Callable[[ft.Page], Any]] = None
    """Optional: run this widget's own startup behavior once the app has
    finished launching, e.g. auto-starting a backend process (see
    toolblox/widgets/process.py) instead of waiting for the user to open
    this widget's screen and start it by hand. May be a plain function or
    an async one; an awaitable return value is awaited.

    Setting this gives the widget a "Start on launch" toggle under
    Settings -> Widgets automatically. The hook only runs if that toggle
    is on *and* the widget itself is enabled - it's never called just
    because this field is set. Omit if the widget has nothing to do at
    startup."""


def get_widget_data(account: dict, widget_id: str) -> dict:
    """Read this widget's namespaced data out of an account dict.

    Returns {} if nothing has been stored yet.
    """
    return account.get("widget_data", {}).get(widget_id, {})


def set_widget_data(account: dict, widget_id: str, data: dict) -> None:
    """Write this widget's namespaced data into an account dict, in place.

    This only mutates the dict in memory. The caller must still save the
    account list with toolblox.data.accounts.save(...).
    """
    account.setdefault("widget_data", {})[widget_id] = data
