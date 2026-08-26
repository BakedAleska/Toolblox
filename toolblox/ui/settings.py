"""The Settings screen."""

import asyncio
import sys

import flet as ft

from toolblox import startup, tray
from toolblox.config import WIDGETS_DIR
from toolblox.devtools import dev_widgets_dir, is_dev_environment, reload_current_view, tail_log
from toolblox.roblox.join import extract_place_id
from toolblox.state import (
    get_auto_rejoin,
    get_compact_mode,
    get_multi_instance,
    get_nav_position,
    get_open_on_launch,
    get_place_id,
    get_run_in_background,
    get_show_avatars,
    get_sort_order,
    get_theme_mode,
    get_widget_start_on_launch,
    resolve_theme_mode,
    set_auto_rejoin,
    set_compact_mode,
    set_multi_instance,
    set_nav_position,
    set_open_on_launch,
    set_place_id,
    set_run_in_background,
    set_show_avatars,
    set_sort_order,
    set_theme_mode,
    set_widget_start_on_launch,
)
from toolblox.ui.layout import build_layout
from toolblox.ui.style import (
    SPACE_LG,
    SPACE_MD,
    SPACE_SM,
    SPACE_XS,
    SWITCH_SCALE,
    card_border,
    radius_card,
    scroll_padding,
    section_box,
    text_caption,
    text_label,
    text_section,
    text_title,
    thin_button_style,
)
from toolblox.ui.toast import show_toast
from toolblox.updater import UpdateError, check_for_update
from toolblox.version import APP_VERSION
from toolblox.widgets.loader import discover_widgets

_SETTINGS_FOCUS_WIDGET_KEY = "_settings_focus_widget_id"
_SETTINGS_SCROLL_KEY = "_settings_scroll_offsets"
_DEV_LOG_VISIBLE_KEY = "_dev_log_visible"
_UPDATE_CHECKING_KEY = "_update_checking"
_UPDATE_CHECKED_KEY = "_update_checked"
_UPDATE_INFO_KEY = "_update_info"
_UPDATE_ERROR_KEY = "_update_error"


def SettingsView(page: ft.Page) -> ft.View:
    """The Settings screen: General, Accounts, and Widgets tabs.

    The Widgets tab only shows the manual install path. Browsing and
    installing widgets happens on the Widgets screen itself.
    """

    def on_position_change(e: ft.Event[ft.RadioGroup]):
        if e.control.value is not None:
            set_nav_position(page, e.control.value)
        page.views[-1] = SettingsView(page)
        page.update()

    def on_theme_mode_change(e: ft.Event[ft.RadioGroup]):
        """Switch Appearance between System, Light, and Dark."""
        if e.control.value is not None:
            set_theme_mode(page, e.control.value)
            page.theme_mode = resolve_theme_mode(page)
        page.views[-1] = SettingsView(page)
        page.update()

    def on_show_avatars_change(e: ft.Event[ft.Switch]):
        set_show_avatars(page, e.control.value)

    def on_sort_order_change(e: ft.Event[ft.RadioGroup]):
        if e.control.value is not None:
            set_sort_order(page, e.control.value)

    def on_compact_mode_change(e: ft.Event[ft.Switch]):
        set_compact_mode(page, e.control.value)

    def on_multi_instance_change(e: ft.Event[ft.Switch]):
        set_multi_instance(page, e.control.value)

    def on_auto_rejoin_change(e: ft.Event[ft.Switch]):
        set_auto_rejoin(page, e.control.value)

    def on_reload_widgets(e: ft.Event[ft.Button]):
        """Force-rescan and reimport widgets, then rebuild the current view.

        discover_widgets() always reimports fresh, so the rescan itself
        needs no extra step here - this exists to give a visible,
        on-demand trigger and confirmation, rather than waiting for the
        next real navigation to notice a widget change.
        """
        reload_current_view(page)
        show_toast(page, "Widgets reloaded.")

    def on_toggle_dev_log(e: ft.Event[ft.Button]):
        visible = bool(page.session.store.get(_DEV_LOG_VISIBLE_KEY))
        page.session.store.set(_DEV_LOG_VISIBLE_KEY, not visible)
        rebuild_settings()

    async def on_copy_dev_log(e: ft.Event[ft.IconButton]):
        await page.clipboard.set(tail_log())
        show_toast(page, "Copied.")

    def on_open_on_launch_change(e: ft.Event[ft.Switch]):
        """Toggle both the setting and the actual OS startup registration.

        The setting alone is just what the switch reads back on the next
        Settings build - the registry value (Windows) or LaunchAgent
        plist (macOS) is what actually makes the app start on login, so
        both need to change together.
        """
        set_open_on_launch(page, e.control.value)
        startup.set_enabled(e.control.value)

    def on_run_in_background_change(e: ft.Event[ft.Switch]):
        """Toggle both the setting and the window's live prevent_close.

        Without updating prevent_close here too, turning this off
        wouldn't take effect until the app was restarted - the close
        button would keep minimizing to the tray for the rest of this
        session.
        """
        set_run_in_background(page, e.control.value)
        page.window.prevent_close = e.control.value
        page.update()

    scroll_offsets = page.session.store.get(_SETTINGS_SCROLL_KEY) or {}

    def on_tab_scroll(name: str):
        """Remember a tab's scroll offset so a rebuild (e.g. toggling the
        dev log) can restore it instead of snapping back to the top.
        """

        def handler(e: ft.OnScrollEvent):
            offsets = page.session.store.get(_SETTINGS_SCROLL_KEY) or {}
            offsets[name] = e.pixels
            page.session.store.set(_SETTINGS_SCROLL_KEY, offsets)

        return handler

    def rebuild_settings():
        """Rebuild this view in place, if it's still the one on screen."""
        if not page.views or page.views[-1].route != "/settings":
            return
        page.views[-1] = SettingsView(page)
        page.update()

    async def on_check_for_updates(e: ft.Event[ft.Button]):
        """Check GitHub's latest release and store the result for display."""
        page.session.store.set(_UPDATE_CHECKING_KEY, True)
        rebuild_settings()
        try:
            info = await asyncio.to_thread(check_for_update)
            page.session.store.set(_UPDATE_INFO_KEY, info)
            page.session.store.set(_UPDATE_ERROR_KEY, None)
        except UpdateError as err:
            page.session.store.set(_UPDATE_INFO_KEY, None)
            page.session.store.set(_UPDATE_ERROR_KEY, str(err))
        finally:
            page.session.store.set(_UPDATE_CHECKING_KEY, False)
            page.session.store.set(_UPDATE_CHECKED_KEY, True)
        rebuild_settings()

    def on_place_id_blur(e: ft.Event[ft.TextField]):
        """Parse a pasted place URL or id, and save the extracted id."""
        place_id = extract_place_id(e.control.value or "")
        if not place_id:
            show_toast(
                page,
                "Couldn't find a place ID in the pasted text. Did you include the full game link?",
            )
            return
        set_place_id(page, place_id)
        e.control.value = place_id
        e.control.update()

    async def copy_widgets_path(e: ft.Event[ft.IconButton]):
        """Copy the manual widget install path to the clipboard."""
        await page.clipboard.set(str(WIDGETS_DIR))
        show_toast(page, "Copied.")

    appearance_options = [
        ft.Radio(value="system", label="System"),
        ft.Radio(value="light", label="Light"),
        ft.Radio(value="dark", label="Dark"),
    ]

    valid_appearance_values = {"system", "light", "dark"}
    appearance_value = get_theme_mode(page) if get_theme_mode(page) in valid_appearance_values \
        else "system"

    update_checking = bool(page.session.store.get(_UPDATE_CHECKING_KEY))
    update_checked = bool(page.session.store.get(_UPDATE_CHECKED_KEY))
    update_info = page.session.store.get(_UPDATE_INFO_KEY)
    update_error = page.session.store.get(_UPDATE_ERROR_KEY)

    update_status: ft.Control | None = None
    if update_checking:
        update_status = text_caption("Checking for updates…")
    elif update_error:
        update_status = ft.Text(update_error, size=12, color=ft.Colors.ERROR)
    elif update_info:
        update_status = ft.Text(
            f"Version {update_info.version} is available. "
            "It'll install automatically the next time you restart Toolblox.",
            size=12,
            color=ft.Colors.PRIMARY,
        )
    elif update_checked:
        update_status = text_caption("You're on the latest version.")

    updates_box = (
        [
            section_box(
                page,
                ft.Column(
                    [
                        text_section("Updates"),
                        text_caption(
                            f"You're running version {APP_VERSION}. Toolblox checks for "
                            "updates and installs them automatically each time it starts."
                        ),
                        *([update_status] if update_status is not None else []),
                        ft.Row(
                            [
                                ft.OutlinedButton(
                                    "Check for Updates",
                                    on_click=on_check_for_updates,
                                    disabled=update_checking,
                                    style=thin_button_style(),
                                )
                            ],
                            spacing=SPACE_SM,
                        ),
                    ],
                    spacing=SPACE_SM,
                ),
            )
        ]
        if sys.platform == "win32"
        else []
    )

    dev_mode_controls: list[ft.Control] = []
    if is_dev_environment():
        log_visible = bool(page.session.store.get(_DEV_LOG_VISIBLE_KEY))
        widgets_dir = dev_widgets_dir()
        dev_mode_controls = [
            text_section("Developer tools"),
            text_caption(
                "Running from a source checkout, so widgets are also "
                f"loaded straight from {widgets_dir or 'this repo'}, and "
                "the Catalogue reads this repo's own registry.json - no "
                "install step, no push, needed to see a change."
            ),
            ft.Row(
                [
                    ft.OutlinedButton(
                        "Reload widgets",
                        on_click=on_reload_widgets,
                        style=thin_button_style(),
                    ),
                    ft.OutlinedButton(
                        "Hide log" if log_visible else "Show log",
                        on_click=on_toggle_dev_log,
                        style=thin_button_style(),
                    ),
                ],
                spacing=SPACE_SM,
            ),
            *(
                [
                    ft.Row(
                        [
                            text_label("Log (last 300 lines)", expand=True),
                            ft.IconButton(
                                icon=ft.Icons.COPY,
                                icon_size=16,
                                tooltip="Copy log",
                                on_click=on_copy_dev_log,
                            ),
                        ],
                    ),
                    ft.Container(
                        content=ft.Column(
                            [
                                ft.Text(
                                    tail_log(),
                                    size=11,
                                    font_family="monospace",
                                    selectable=True,
                                ),
                            ],
                            scroll=ft.ScrollMode.AUTO,
                        ),
                        height=220,
                        padding=SPACE_SM,
                        bgcolor=ft.Colors.SURFACE_CONTAINER_LOW,
                        border=card_border(),
                        border_radius=radius_card(page),
                    ),
                ]
                if log_visible
                else []
            ),
        ]

    startup_boxes: list[ft.Control] = []
    if startup.is_supported():
        startup_boxes.append(
            section_box(
                page,
                ft.Column(
                    [
                        text_section("Open on launch"),
                        ft.Row(
                            [
                                text_caption(
                                    "Start Toolblox automatically when you log in.",
                                    expand=True,
                                ),
                                ft.Switch(
                                    value=get_open_on_launch(page),
                                    on_change=on_open_on_launch_change,
                                    scale=SWITCH_SCALE,
                                ),
                            ],
                            vertical_alignment=ft.CrossAxisAlignment.CENTER,
                        ),
                    ],
                    spacing=SPACE_SM,
                ),
            )
        )
    if tray.is_supported():
        startup_boxes.append(
            section_box(
                page,
                ft.Column(
                    [
                        text_section("Run in background"),
                        ft.Row(
                            [
                                text_caption(
                                    "Closing the window keeps Toolblox running in the "
                                    + (
                                        "menu bar"
                                        if sys.platform == "darwin"
                                        else "hidden icons section"
                                    )
                                    + " instead of closing it. Quit from there to close "
                                    "it fully.",
                                    expand=True,
                                ),
                                ft.Switch(
                                    value=get_run_in_background(page),
                                    on_change=on_run_in_background_change,
                                    scale=SWITCH_SCALE,
                                ),
                            ],
                            vertical_alignment=ft.CrossAxisAlignment.CENTER,
                        ),
                    ],
                    spacing=SPACE_SM,
                ),
            )
        )

    general_tab = ft.ListView(
        controls=[
            section_box(
                page,
                ft.Column(
                    [
                        text_section("Sidebar position"),
                        ft.RadioGroup(
                            value=get_nav_position(page),
                            on_change=on_position_change,
                            content=ft.Row(
                                [
                                    ft.Radio(value="left", label="Left"),
                                    ft.Radio(value="right", label="Right"),
                                ]
                            ),
                        ),
                    ],
                    spacing=SPACE_SM,
                ),
            ),
            section_box(
                page,
                ft.Column(
                    [
                        text_section("Appearance"),
                        ft.RadioGroup(
                            value=appearance_value,
                            on_change=on_theme_mode_change,
                            content=ft.Row(appearance_options, wrap=True),
                        ),
                    ],
                    spacing=SPACE_SM,
                ),
            ),
            *startup_boxes,
            *updates_box,
            *(
                [
                    section_box(
                        page,
                        ft.Column(
                            [
                                text_section("Allow multiple Roblox instances",
                                             color=ft.Colors.ERROR),
                                ft.Row(
                                    [
                                        text_caption(
                                            "Lets Join open a second Roblox window "
                                            "instead of just switching to one that's "
                                            "already open, so more than one account "
                                            "can play at once.",
                                            expand=True,
                                        ),
                                        ft.Switch(
                                            value=get_multi_instance(page),
                                            on_change=on_multi_instance_change,
                                            scale=SWITCH_SCALE,
                                        ),
                                    ],
                                    vertical_alignment=ft.CrossAxisAlignment.CENTER,
                                ),
                            ],
                            spacing=SPACE_SM,
                        ),
                    )
                ]
                if sys.platform == "win32"
                else []
            ),
            *(
                [section_box(page, ft.Column(dev_mode_controls, spacing=SPACE_SM))]
                if dev_mode_controls
                else []
            ),
        ],
        spacing=SPACE_MD,
        expand=True,
        padding=scroll_padding(),
        on_scroll=on_tab_scroll("general"),
        build_controls_on_demand=False,
    )

    accounts_tab = ft.ListView(
        controls=[
            section_box(
                page,
                ft.Column(
                    [
                        text_section("Show avatars"),
                        ft.Row(
                            [
                                text_caption(
                                    "Show each account's avatar in the list.", expand=True
                                ),
                                ft.Switch(
                                    value=get_show_avatars(page),
                                    on_change=on_show_avatars_change,
                                    scale=SWITCH_SCALE,
                                ),
                            ],
                            vertical_alignment=ft.CrossAxisAlignment.CENTER,
                        ),
                    ],
                    spacing=SPACE_SM,
                ),
            ),
            section_box(
                page,
                ft.Column(
                    [
                        text_section("Compact mode"),
                        ft.Row(
                            [
                                text_caption(
                                    "Hide notes in the accounts list for a more "
                                    "compact view.",
                                    expand=True,
                                ),
                                ft.Switch(
                                    value=get_compact_mode(page),
                                    on_change=on_compact_mode_change,
                                    scale=SWITCH_SCALE,
                                ),
                            ],
                            vertical_alignment=ft.CrossAxisAlignment.CENTER,
                        ),
                    ],
                    spacing=SPACE_SM,
                ),
            ),
            section_box(
                page,
                ft.Column(
                    [
                        text_section("Auto-rejoin"),
                        ft.Row(
                            [
                                text_caption(
                                    "Automatically rejoin an account when it's "
                                    "detected leaving the place. If an account "
                                    "leaves again right after being auto-rejoined, "
                                    "it stops retrying that account until you join "
                                    "it manually - a safety net in case you forget "
                                    "this is on.",
                                    expand=True,
                                ),
                                ft.Switch(
                                    value=get_auto_rejoin(page),
                                    on_change=on_auto_rejoin_change,
                                    scale=SWITCH_SCALE,
                                ),
                            ],
                            vertical_alignment=ft.CrossAxisAlignment.CENTER,
                        ),
                    ],
                    spacing=SPACE_SM,
                ),
            ),
            section_box(
                page,
                ft.Column(
                    [
                        text_section("Sort order"),
                        ft.RadioGroup(
                            value=get_sort_order(page),
                            on_change=on_sort_order_change,
                            content=ft.Row(
                                [
                                    ft.Radio(value="last_played", label="Last played"),
                                    ft.Radio(value="alphabetical", label="Alphabetical"),
                                    ft.Radio(value="manual", label="Manual"),
                                ]
                            ),
                        ),
                    ],
                    spacing=SPACE_SM,
                ),
            ),
            section_box(
                page,
                ft.Column(
                    [
                        text_section("Place ID"),
                        text_caption(
                            "The place that opens when you press Join. Paste a roblox.com "
                            "game link, or just the numeric ID."
                        ),
                        ft.TextField(
                            value=get_place_id(page),
                            hint_text="https://www.roblox.com/games/1818/... or 1818",
                            on_blur=on_place_id_blur,
                        ),
                    ],
                    spacing=SPACE_SM,
                ),
            ),
        ],
        spacing=SPACE_MD,
        expand=True,
        padding=scroll_padding(),
        on_scroll=on_tab_scroll("accounts"),
        build_controls_on_demand=False,
    )

    WIDGETS_DIR.mkdir(parents=True, exist_ok=True)

    focus_widget_id = page.session.store.get(_SETTINGS_FOCUS_WIDGET_KEY)
    if page.session.store.contains_key(_SETTINGS_FOCUS_WIDGET_KEY):
        page.session.store.remove(_SETTINGS_FOCUS_WIDGET_KEY)

    installed_widgets, _load_errors = discover_widgets(dev_widgets_dir())

    def on_widget_start_on_launch_change(widget_id: str):
        def handler(e: ft.Event[ft.Switch]):
            set_widget_start_on_launch(page, widget_id, e.control.value)

        return handler

    widget_settings_sections: list[ft.Control] = []
    for widget in installed_widgets:
        if widget.build_settings is None and widget.on_app_start is None:
            continue
        section_controls: list[ft.Control] = [
            text_section(widget.name),
        ]
        if widget.on_app_start is not None:
            section_controls.append(
                ft.Row(
                    [
                        ft.Column(
                            [
                                text_label("Start on launch"),
                                text_caption(
                                    f"Start {widget.name} automatically when Toolblox "
                                    "launches."
                                ),
                            ],
                            spacing=SPACE_XS,
                            expand=True,
                        ),
                        ft.Switch(
                            value=get_widget_start_on_launch(page, widget.id),
                            on_change=on_widget_start_on_launch_change(widget.id),
                            scale=SWITCH_SCALE,
                        ),
                    ],
                    vertical_alignment=ft.CrossAxisAlignment.CENTER,
                )
            )
        if widget.build_settings is not None:
            section_controls.append(widget.build_settings(page))
        widget_settings_sections.append(
            ft.Container(
                content=ft.Column(section_controls, spacing=SPACE_MD),
                padding=SPACE_SM,
                border=(
                    ft.Border.all(2, ft.Colors.PRIMARY)
                    if widget.id == focus_widget_id
                    else card_border()
                ),
                border_radius=radius_card(page),
            )
        )

    widgets_tab = ft.ListView(
        controls=[
            text_caption(
                "Widgets are optional and not bundled with the app. To add one "
                "manually, place its folder here. Install and enable them from the "
                "Widgets screen."
            ),
            ft.Row(
                [
                    ft.Text(str(WIDGETS_DIR), size=12, selectable=True, expand=True),
                    ft.IconButton(
                        icon=ft.Icons.COPY,
                        icon_size=16,
                        tooltip="Copy path",
                        on_click=copy_widgets_path,
                    ),
                ]
            ),
            *widget_settings_sections,
        ],
        spacing=SPACE_LG,
        expand=True,
        padding=scroll_padding(),
        on_scroll=on_tab_scroll("widgets"),
        build_controls_on_demand=False,
    )

    for _name, _tab in (
        ("general", general_tab),
        ("accounts", accounts_tab),
        ("widgets", widgets_tab),
    ):
        _offset = scroll_offsets.get(_name)
        if _offset:
            page.run_task(_tab.scroll_to, offset=_offset, duration=0)

    content = ft.Column(
        [
            text_title("Settings"),
            ft.Tabs(
                length=3,
                selected_index=2 if focus_widget_id else 0,
                expand=True,
                content=ft.Column(
                    expand=True,
                    controls=[
                        ft.TabBar(
                            tabs=[
                                ft.Tab(label="General"),
                                ft.Tab(label="Accounts"),
                                ft.Tab(label="Widgets"),
                            ]
                        ),
                        ft.TabBarView(
                            expand=True,
                            controls=[
                                ft.Container(
                                    content=general_tab,
                                    padding=ft.Padding.only(top=SPACE_LG),
                                    expand=True,
                                ),
                                ft.Container(
                                    content=accounts_tab,
                                    padding=ft.Padding.only(top=SPACE_LG),
                                    expand=True,
                                ),
                                ft.Container(
                                    content=widgets_tab,
                                    padding=ft.Padding.only(top=SPACE_LG),
                                    expand=True,
                                ),
                            ],
                        ),
                    ],
                ),
            ),
        ],
        expand=True,
    )

    return ft.View(
        route="/settings",
        padding=0,
        horizontal_alignment=ft.CrossAxisAlignment.STRETCH,
        controls=[build_layout(page, content)],
    )
