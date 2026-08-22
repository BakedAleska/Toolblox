"""Read and write app settings for the current page.

Each setting has a get and a set function below. Both go through
_get_settings, which caches the loaded settings dict on the page's
session so repeated reads in one build don't hit disk each time. Never
read or write toolblox.data.settings directly from UI code.
"""

import flet as ft

from toolblox.data import settings as settings_store

NAV_POSITION_KEY = "sidebar_pos"
DEFAULT_NAV_POSITION = settings_store.DEFAULTS[NAV_POSITION_KEY]

THEME_MODE_KEY = "theme_mode"
DEFAULT_THEME_MODE = settings_store.DEFAULTS[THEME_MODE_KEY]
BUILT_IN_THEME_MODES = {
    "system": ft.ThemeMode.SYSTEM,
    "light": ft.ThemeMode.LIGHT,
    "dark": ft.ThemeMode.DARK,
}
"""The Appearance choices."""

SHOW_AVATARS_KEY = "show_avatars"
DEFAULT_SHOW_AVATARS = settings_store.DEFAULTS[SHOW_AVATARS_KEY]

SORT_ORDER_KEY = "sort_order"
DEFAULT_SORT_ORDER = settings_store.DEFAULTS[SORT_ORDER_KEY]

COMPACT_MODE_KEY = "compact_mode"
DEFAULT_COMPACT_MODE = settings_store.DEFAULTS[COMPACT_MODE_KEY]

PLACE_ID_KEY = "place_id"
DEFAULT_PLACE_ID = settings_store.DEFAULTS[PLACE_ID_KEY]

DISABLED_WIDGETS_KEY = "disabled_widgets"
DEFAULT_DISABLED_WIDGETS = settings_store.DEFAULTS[DISABLED_WIDGETS_KEY]

WIDGET_SETTINGS_KEY = "widget_settings"
DEFAULT_WIDGET_SETTINGS = settings_store.DEFAULTS[WIDGET_SETTINGS_KEY]

MULTI_INSTANCE_KEY = "multi_instance"
DEFAULT_MULTI_INSTANCE = settings_store.DEFAULTS[MULTI_INSTANCE_KEY]

OPEN_ON_LAUNCH_KEY = "open_on_launch"
DEFAULT_OPEN_ON_LAUNCH = settings_store.DEFAULTS[OPEN_ON_LAUNCH_KEY]

RUN_IN_BACKGROUND_KEY = "run_in_background"
DEFAULT_RUN_IN_BACKGROUND = settings_store.DEFAULTS[RUN_IN_BACKGROUND_KEY]

WIDGETS_START_ON_LAUNCH_KEY = "widgets_start_on_launch"
DEFAULT_WIDGETS_START_ON_LAUNCH = settings_store.DEFAULTS[WIDGETS_START_ON_LAUNCH_KEY]

_SETTINGS_CACHE_KEY = "_settings_cache"


def _get_settings(page: ft.Page) -> dict:
    """Return the settings dict for this page, loading it once and caching
    it in the page's session for later calls.
    """
    cached = page.session.store.get(_SETTINGS_CACHE_KEY)
    if cached is None:
        cached = settings_store.load()
        page.session.store.set(_SETTINGS_CACHE_KEY, cached)
    return cached


def get_nav_position(page: ft.Page) -> str:
    return _get_settings(page).get(NAV_POSITION_KEY, DEFAULT_NAV_POSITION)


def set_nav_position(page: ft.Page, position: str) -> None:
    current = _get_settings(page)
    current[NAV_POSITION_KEY] = position
    page.session.store.set(_SETTINGS_CACHE_KEY, current)
    settings_store.save(current)


def get_theme_mode(page: ft.Page) -> str:
    return _get_settings(page).get(THEME_MODE_KEY, DEFAULT_THEME_MODE)


def set_theme_mode(page: ft.Page, mode: str) -> None:
    current = _get_settings(page)
    current[THEME_MODE_KEY] = mode
    page.session.store.set(_SETTINGS_CACHE_KEY, current)
    settings_store.save(current)


def get_show_avatars(page: ft.Page) -> bool:
    return _get_settings(page).get(SHOW_AVATARS_KEY, DEFAULT_SHOW_AVATARS)


def set_show_avatars(page: ft.Page, value: bool) -> None:
    current = _get_settings(page)
    current[SHOW_AVATARS_KEY] = value
    page.session.store.set(_SETTINGS_CACHE_KEY, current)
    settings_store.save(current)


def get_sort_order(page: ft.Page) -> str:
    return _get_settings(page).get(SORT_ORDER_KEY, DEFAULT_SORT_ORDER)


def set_sort_order(page: ft.Page, value: str) -> None:
    current = _get_settings(page)
    current[SORT_ORDER_KEY] = value
    page.session.store.set(_SETTINGS_CACHE_KEY, current)
    settings_store.save(current)


def get_compact_mode(page: ft.Page) -> bool:
    return _get_settings(page).get(COMPACT_MODE_KEY, DEFAULT_COMPACT_MODE)


def set_compact_mode(page: ft.Page, value: bool) -> None:
    current = _get_settings(page)
    current[COMPACT_MODE_KEY] = value
    page.session.store.set(_SETTINGS_CACHE_KEY, current)
    settings_store.save(current)


def get_place_id(page: ft.Page) -> str:
    return _get_settings(page).get(PLACE_ID_KEY, DEFAULT_PLACE_ID)


def set_place_id(page: ft.Page, value: str) -> None:
    current = _get_settings(page)
    current[PLACE_ID_KEY] = value
    page.session.store.set(_SETTINGS_CACHE_KEY, current)
    settings_store.save(current)


def get_disabled_widgets(page: ft.Page) -> list[str]:
    return _get_settings(page).get(DISABLED_WIDGETS_KEY, DEFAULT_DISABLED_WIDGETS)


def set_widget_enabled(page: ft.Page, widget_id: str, enabled: bool) -> None:
    """Add or remove a widget id from the disabled_widgets list.

    Enabled widgets are simply absent from the list; there's no
    separate "enabled" list to keep in sync.
    """
    current = _get_settings(page)
    disabled = list(current.get(DISABLED_WIDGETS_KEY, DEFAULT_DISABLED_WIDGETS))
    if enabled and widget_id in disabled:
        disabled.remove(widget_id)
    elif not enabled and widget_id not in disabled:
        disabled.append(widget_id)
    current[DISABLED_WIDGETS_KEY] = disabled
    page.session.store.set(_SETTINGS_CACHE_KEY, current)
    settings_store.save(current)


def remove_widget_settings(page: ft.Page, widget_id: str) -> None:
    """Discard a widget's disabled-state entry and stored settings.

    Call this after uninstalling a widget, so a reinstall starts clean
    instead of inheriting stale settings from before.
    """
    current = _get_settings(page)
    disabled = [
        w for w in current.get(DISABLED_WIDGETS_KEY, DEFAULT_DISABLED_WIDGETS) if w != widget_id
    ]
    widget_settings = {
        k: v
        for k, v in current.get(WIDGET_SETTINGS_KEY, DEFAULT_WIDGET_SETTINGS).items()
        if k != widget_id
    }
    started = [
        w
        for w in current.get(WIDGETS_START_ON_LAUNCH_KEY, DEFAULT_WIDGETS_START_ON_LAUNCH)
        if w != widget_id
    ]
    current[DISABLED_WIDGETS_KEY] = disabled
    current[WIDGET_SETTINGS_KEY] = widget_settings
    current[WIDGETS_START_ON_LAUNCH_KEY] = started
    page.session.store.set(_SETTINGS_CACHE_KEY, current)
    settings_store.save(current)


def get_widget_setting(page: ft.Page, widget_id: str, key: str, default=None):
    """Read one persisted setting for a widget's own Settings section.

    Namespaced per widget id so two widgets can use the same key name
    without colliding.
    """
    widget_settings = _get_settings(page).get(WIDGET_SETTINGS_KEY, DEFAULT_WIDGET_SETTINGS)
    return widget_settings.get(widget_id, {}).get(key, default)


def set_widget_setting(page: ft.Page, widget_id: str, key: str, value) -> None:
    current = _get_settings(page)
    widget_settings = dict(current.get(WIDGET_SETTINGS_KEY, DEFAULT_WIDGET_SETTINGS))
    widget_settings[widget_id] = {**widget_settings.get(widget_id, {}), key: value}
    current[WIDGET_SETTINGS_KEY] = widget_settings
    page.session.store.set(_SETTINGS_CACHE_KEY, current)
    settings_store.save(current)


def get_multi_instance(page: ft.Page) -> bool:
    return _get_settings(page).get(MULTI_INSTANCE_KEY, DEFAULT_MULTI_INSTANCE)


def set_multi_instance(page: ft.Page, value: bool) -> None:
    current = _get_settings(page)
    current[MULTI_INSTANCE_KEY] = value
    page.session.store.set(_SETTINGS_CACHE_KEY, current)
    settings_store.save(current)


def get_open_on_launch(page: ft.Page) -> bool:
    return _get_settings(page).get(OPEN_ON_LAUNCH_KEY, DEFAULT_OPEN_ON_LAUNCH)


def set_open_on_launch(page: ft.Page, value: bool) -> None:
    current = _get_settings(page)
    current[OPEN_ON_LAUNCH_KEY] = value
    page.session.store.set(_SETTINGS_CACHE_KEY, current)
    settings_store.save(current)


def get_run_in_background(page: ft.Page) -> bool:
    return _get_settings(page).get(RUN_IN_BACKGROUND_KEY, DEFAULT_RUN_IN_BACKGROUND)


def set_run_in_background(page: ft.Page, value: bool) -> None:
    current = _get_settings(page)
    current[RUN_IN_BACKGROUND_KEY] = value
    page.session.store.set(_SETTINGS_CACHE_KEY, current)
    settings_store.save(current)


def get_widget_start_on_launch(page: ft.Page, widget_id: str) -> bool:
    """Whether widget_id should have its on_app_start hook run at launch."""
    started = _get_settings(page).get(
        WIDGETS_START_ON_LAUNCH_KEY, DEFAULT_WIDGETS_START_ON_LAUNCH
    )
    return widget_id in started


def set_widget_start_on_launch(page: ft.Page, widget_id: str, value: bool) -> None:
    current = _get_settings(page)
    started = list(current.get(WIDGETS_START_ON_LAUNCH_KEY, DEFAULT_WIDGETS_START_ON_LAUNCH))
    if value and widget_id not in started:
        started.append(widget_id)
    elif not value and widget_id in started:
        started.remove(widget_id)
    current[WIDGETS_START_ON_LAUNCH_KEY] = started
    page.session.store.set(_SETTINGS_CACHE_KEY, current)
    settings_store.save(current)


def resolve_theme_mode(page: ft.Page) -> ft.ThemeMode:
    """The ft.ThemeMode to render at, given the current Appearance choice."""
    return BUILT_IN_THEME_MODES.get(get_theme_mode(page), ft.ThemeMode.SYSTEM)
