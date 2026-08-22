"""The Widgets screen: the Catalogue banner and the grid of installed widgets.

The Catalogue only renders on the "canary" release channel (see
toolblox.devtools.release_channel) - a packaged "beta" build shows just
the installed-widgets grid, with no shop, no background fetch, and no
update badges, since those all depend on a fetched Catalogue.
"""

import asyncio

import flet as ft

from toolblox.devtools import dev_registry_path, dev_widgets_dir, release_channel
from toolblox.state import get_disabled_widgets, remove_widget_settings, set_widget_enabled
from toolblox.ui.layout import build_layout, widget_route
from toolblox.ui.style import (
    SPACE_LG,
    SPACE_MD,
    SPACE_SM,
    SPACE_XS,
    SWITCH_SCALE,
    card_border,
    radius_card,
    scroll_margin,
    scroll_padding,
    text_caption,
    text_section,
    text_title,
)
from toolblox.ui.toast import show_confirm_toast, show_toast
from toolblox.widgets.catalog import (
    CatalogEntry,
    fetch_registry,
    get_cached_registry,
    set_cached_registry,
)
from toolblox.widgets.installer import (
    WidgetInstallError,
    has_update,
    install_widget,
    is_installing,
    mark_installing,
    uninstall_widget,
    unmark_installing,
)
from toolblox.widgets.loader import discover_widgets

_CATALOGUE_FETCHED_KEY = "_widget_catalogue_fetched"
_CATALOGUE_ERROR_KEY = "_widget_catalogue_error"
_SETTINGS_FOCUS_WIDGET_KEY = "_settings_focus_widget_id"

INSTALLED_PER_ROW = 4
"""Installed widgets are laid out in a GridView with this many columns, so
each card's size is however wide 1/4 of the available row is, rather than a
fixed pixel size. That keeps the grid flush against both edges with even
gaps, instead of leaving leftover space before the row wraps when there
aren't enough widgets installed to fill a fixed-size row exactly."""

CATALOGUE_SIZE = 104
"""Catalogue tiles are app-icon-style: tap to install, no controls, so
they read like a smaller, denser shop shelf next to the installed grid."""

INSTALLED_SECTION_TOP_GAP = 64
"""Shrinks the installed-widgets section's forced height below the full
window height, by this much. installed_section is held to a fixed
height so scrolling can carry the Catalogue completely out of view (see
WidgetsView's docstring) - but sizing it to the *entire* window let the
scroll go one step further than that, past the point the Catalogue was
already gone, and start eating into the installed grid's own rows from
the top. Trimming the forced height by a fixed gap stops the scroll
short of that, leaving this much breathing room above the installed
grid at max scroll instead."""

CARD_PADDING = SPACE_SM
"""Matches the app-wide card-tier padding used by `section_box()` in
multitool.ui.style, so the Widgets screen's squares read as the same
box tier as every other bordered card in the app."""
ICON_CHIP_SIZE = 56
BADGE_SIZE = 18
HOVER_ZONE_SIZE = ICON_CHIP_SIZE + 12
"""Size of the invisible hit box, pinned to a card's top-left corner,
that triggers its description showcase. A little bigger than the icon
chip itself so it's forgiving to aim for, but still small enough that
the rest of the card (including the switch/settings/delete row) keeps
its normal click and tooltip behavior."""

HOVER_HINT_SIZE = 20
"""Size of the small badge drawn in a card's top-left corner to hint
that hovering there shows the widget's description."""
DESCRIPTION_HOVER_DELAY = 1.0
"""Seconds a description showcase waits, once shown, before it starts
auto-scrolling - gives the reader a moment to start reading the top of
the description before it moves, the same pattern long tooltips and
now-playing marquees use."""

DESCRIPTION_SCROLL_DURATION = 4000
"""Duration, in milliseconds, of the auto-scroll animation that carries
a description showcase from top to bottom."""


def _icon_chip(
    page: ft.Page,
    icon: object,
    logo: str | None,
    *,
    active: bool,
    size: int,
    logo_size: float = 1.0,
) -> ft.Control:
    """A rounded, tinted square holding a widget's icon or logo.

    `active` drives the tint: the accent-tinted PRIMARY_CONTAINER for an
    installable or enabled widget, a neutral SURFACE_CONTAINER_HIGHEST for
    a disabled one. This is how card state is shown instead of dimming
    the whole card, which made text hard to read.

    `logo_size` scales the glyph within the fixed-size chip (see
    Widget.logo_size), so a widget can ask for a larger glyph without the
    chip itself, or the grid it sits in, changing size.
    """
    fg = ft.Colors.ON_PRIMARY_CONTAINER if active else ft.Colors.ON_SURFACE_VARIANT
    bg = ft.Colors.PRIMARY_CONTAINER if active else ft.Colors.SURFACE_CONTAINER_HIGHEST
    icon_size = round(size * 0.5 * logo_size)
    inner = (
        ft.Image(src=logo, width=icon_size, height=icon_size, fit=ft.BoxFit.CONTAIN)
        if logo
        else ft.Icon(icon or ft.Icons.EXTENSION, size=icon_size, color=fg)
    )
    return ft.Container(
        content=inner,
        width=size,
        height=size,
        bgcolor=bg,
        border_radius=radius_card(page),
        alignment=ft.Alignment.CENTER,
    )


def WidgetsView(page: ft.Page) -> ft.View:
    """The Widgets screen.

    On the "canary" channel, the Catalogue is fetched once per session,
    on the first build. The fetched flag is read fresh at the top of
    every build and set inside background_refresh_catalogue itself,
    before it calls refresh(). This guard matters: refresh() rebuilds
    this view, so an unconditional fetch here would trigger another
    fetch on every rebuild, without end. On "beta", none of this runs -
    the Catalogue section, its background fetch, and the per-widget
    update badges it feeds are skipped entirely.

    The installed-widgets section is wrapped in a container held to
    nearly the full window height (see INSTALLED_SECTION_TOP_GAP), even
    when it only has one short row of widgets in it. That's deliberate:
    it guarantees there's always enough room to scroll the Catalogue
    completely out of view above it, so the first row of installed
    widgets can reach near the top of the screen, rather than the page
    only scrolling as far as its actual content.
    """

    def refresh():
        """Rebuild this view in place, if it's still the one on screen."""
        if not page.views or page.views[-1].route != "/widgets":
            return
        page.views[-1] = WidgetsView(page)
        page.update()

    def on_toggle(widget_id: str, enable: bool):
        """Enable or disable one installed widget."""
        set_widget_enabled(page, widget_id, enable)
        refresh()

    async def open_widget_settings(widget_id: str):
        """Jump to Settings -> Widgets, focused on one widget's section."""
        page.session.store.set(_SETTINGS_FOCUS_WIDGET_KEY, widget_id)
        await page.push_route("/settings")

    async def go_to_widget(widget_id: str):
        """Open an installed widget's own view, same as clicking it in the nav rail."""
        await page.push_route(widget_route(widget_id))

    async def on_install(entry: CatalogEntry):
        """Download and install one Catalogue entry."""
        mark_installing(page, entry.id)
        refresh()
        try:
            await asyncio.to_thread(install_widget, entry)
            set_widget_enabled(page, entry.id, True)
        except WidgetInstallError as e:
            show_toast(page, str(e))
        finally:
            unmark_installing(page, entry.id)
            refresh()

    async def on_uninstall(widget_id: str):
        """Remove an installed widget's folder and its stored settings."""
        await asyncio.to_thread(uninstall_widget, widget_id)
        remove_widget_settings(page, widget_id)
        refresh()

    async def on_update(entry: CatalogEntry):
        """Reinstall a Catalogue entry over its currently installed copy.

        Unlike on_install, this leaves the widget's enabled state alone -
        updating a disabled widget shouldn't silently re-enable it.
        """
        mark_installing(page, entry.id)
        refresh()
        try:
            await asyncio.to_thread(install_widget, entry)
        except WidgetInstallError as e:
            show_toast(page, str(e))
        finally:
            unmark_installing(page, entry.id)
            refresh()

    async def background_refresh_catalogue():
        """Fetch the Catalogue, then refresh this view.

        See WidgetsView's docstring for the guard that keeps this from
        running more than once per session. Running from a source
        checkout, reads the repo's own registry.json instead of
        WIDGET_REGISTRY_URL - see toolblox.devtools.dev_registry_path.
        """
        local_path = dev_registry_path()
        entries, error = await asyncio.to_thread(
            fetch_registry, str(local_path) if local_path else None
        )
        if error is None:
            set_cached_registry(page, entries)
        page.session.store.set(_CATALOGUE_FETCHED_KEY, True)
        page.session.store.set(_CATALOGUE_ERROR_KEY, error)
        refresh()

    catalogue_enabled = release_channel() == "canary"

    widgets, load_errors = discover_widgets(dev_widgets_dir())
    disabled_ids = set(get_disabled_widgets(page))
    local_ids = {w.id for w in widgets}

    def build_installed_square(widget) -> ft.Control:
        """Build one installed widget's card.

        Clicking anywhere on the card opens the widget's own view, same as
        clicking it in the nav rail. The Switch, settings button, and
        delete button sit in a separate overlay layer on top (a sibling in
        the Stack, not a descendant of the clickable card) so their own
        clicks are handled by them instead of by the card's on_click -
        the same layering trick this file already used for the old
        settings-button overlay.

        The icon chip's tint mirrors the enabled state instead of dimming
        the whole card, so the name and description stay legible either
        way. A widget with `build_settings` set also gets a settings
        button that jumps to its section under Settings -> Widgets. The
        delete button uninstalls it after a confirmation prompt, removing
        its folder from disk.

        hover_zone is one control pinned to the card's actual top-left
        corner (HOVER_ZONE_SIZE, independent of wherever the centered
        icon chip renders): a slightly bigger, otherwise invisible hit
        box with a small hint badge (HOVER_HINT_SIZE) drawn inside it.
        The hover handler lives on that outer box rather than the badge
        itself - Flet Stacks hit-test top to bottom and stop at the
        first hit, so a sibling badge sitting on top of a separate
        hover control would swallow the pointer and the control
        underneath would never see it. Hovering the zone swaps the
        whole card for a description showcase: a full-card overlay, on
        top of everything else including the footer's
        switch/settings/delete row, that shows nothing but the widget's
        description. If the description is long enough to need it, the
        overlay waits
        DESCRIPTION_HOVER_DELAY seconds and then auto-scrolls itself
        top to bottom over DESCRIPTION_SCROLL_DURATION ms, the same
        pattern other apps use for descriptions too long to fit in
        place. The overlay stays out of the hit-test tree
        (`ignore_interactions`) while hidden, so it never steals clicks
        from the card or its footer buttons when the widget isn't
        being hovered.

        A widget whose Catalogue entry has a different sha256 than the
        one recorded at install time gets an update badge in the card's
        top-right corner, swapped for a progress ring while the update
        is running - see has_update() and on_update(). It's a separate
        Stack overlay rather than part of the settings/uninstall row so
        it doesn't push those buttons outward when it appears.
        """
        enabled = widget.id not in disabled_ids
        registry_entry = registry_by_id.get(widget.id)
        updatable = registry_entry is not None and has_update(registry_entry)
        updating = is_installing(page, widget.id)

        overlay_ref: ft.Ref[ft.Container] = ft.Ref()
        description_ref: ft.Ref[ft.Column] = ft.Ref()
        hover_state = {"token": 0}

        async def auto_scroll_description(token: int):
            await asyncio.sleep(DESCRIPTION_HOVER_DELAY)
            if hover_state["token"] != token or description_ref.current is None:
                return
            await description_ref.current.scroll_to(
                offset=-1, duration=DESCRIPTION_SCROLL_DURATION
            )

        def show_description(e: ft.Event[ft.Container]):
            if not e.data or overlay_ref.current is None:
                return
            hover_state["token"] += 1
            overlay_ref.current.opacity = 1
            overlay_ref.current.ignore_interactions = False
            overlay_ref.current.update()
            page.run_task(auto_scroll_description, hover_state["token"])

        def hide_description(e: ft.Event[ft.Container]):
            if e.data or overlay_ref.current is None:
                return
            hover_state["token"] += 1
            overlay_ref.current.opacity = 0
            overlay_ref.current.ignore_interactions = True
            overlay_ref.current.update()
            if description_ref.current is not None:
                page.run_task(description_ref.current.scroll_to, offset=0, duration=0)

        trailing_actions: list[ft.Control] = []
        if widget.build_settings is not None:
            trailing_actions.append(
                ft.IconButton(
                    icon=ft.Icons.SETTINGS_OUTLINED,
                    icon_size=16,
                    tooltip=f"{widget.name} settings",
                    on_click=lambda e, wid=widget.id: page.run_task(open_widget_settings, wid),
                )
            )
        trailing_actions.append(
            ft.IconButton(
                icon=ft.Icons.DELETE_OUTLINE,
                icon_size=16,
                tooltip=f"Uninstall {widget.name}",
                on_click=lambda e, wid=widget.id, name=widget.name: show_confirm_toast(
                    page,
                    f"Uninstall {name}? This removes it from your computer.",
                    lambda wid=wid: page.run_task(on_uninstall, wid),
                    confirm_label="Uninstall",
                ),
            )
        )

        card_body = ft.Container(
            content=ft.Column(
                [
                    _icon_chip(
                        page,
                        widget.icon,
                        widget.logo,
                        active=enabled,
                        size=ICON_CHIP_SIZE,
                        logo_size=widget.logo_size,
                    ),
                    ft.Text(
                        widget.name,
                        size=12,
                        weight=ft.FontWeight.W_600,
                        text_align=ft.TextAlign.CENTER,
                        max_lines=1,
                        overflow=ft.TextOverflow.ELLIPSIS,
                    ),
                    ft.Container(height=42),
                ],
                horizontal_alignment=ft.CrossAxisAlignment.CENTER,
                spacing=SPACE_SM,
            ),
            expand=True,
            padding=CARD_PADDING,
            border=card_border(),
            border_radius=radius_card(page),
            tooltip=f"Open {widget.name}",
            on_click=lambda e, wid=widget.id: page.run_task(go_to_widget, wid),
        )

        hover_zone = ft.Container(
            content=ft.Container(
                content=ft.Icon(
                    ft.Icons.INFO_OUTLINE_ROUNDED,
                    size=round(HOVER_HINT_SIZE * 0.6),
                    color=ft.Colors.ON_SURFACE_VARIANT,
                ),
                width=HOVER_HINT_SIZE,
                height=HOVER_HINT_SIZE,
                alignment=ft.Alignment.CENTER,
            ),
            width=HOVER_ZONE_SIZE,
            height=HOVER_ZONE_SIZE,
            padding=SPACE_XS,
            alignment=ft.Alignment.TOP_LEFT,
            bgcolor=ft.Colors.TRANSPARENT,
            tooltip="Show description",
            top=0,
            left=0,
            on_hover=show_description,
        )

        description_overlay = ft.Container(
            ref=overlay_ref,
            content=ft.Column(
                [
                    text_caption(
                        widget.description or "No description provided.",
                        text_align=ft.TextAlign.CENTER,
                    ),
                ],
                ref=description_ref,
                scroll=ft.ScrollMode.HIDDEN,
                horizontal_alignment=ft.CrossAxisAlignment.CENTER,
                alignment=ft.MainAxisAlignment.CENTER,
                expand=True,
            ),
            bgcolor=ft.Colors.SURFACE_CONTAINER_LOW,
            border=card_border(),
            border_radius=radius_card(page),
            padding=CARD_PADDING,
            alignment=ft.Alignment.CENTER,
            opacity=0,
            animate_opacity=150,
            ignore_interactions=True,
            on_hover=hide_description,
            expand=True,
        )

        footer_overlay = ft.Container(
            content=ft.Column(
                [
                    ft.Divider(),
                    ft.Row(
                        [
                            ft.Switch(
                                value=enabled,
                                scale=SWITCH_SCALE,
                                tooltip="Enabled" if enabled else "Disabled",
                                on_change=lambda e, wid=widget.id: on_toggle(
                                    wid, e.control.value
                                ),
                            ),
                            ft.Row(trailing_actions, spacing=0),
                        ],
                        alignment=ft.MainAxisAlignment.SPACE_BETWEEN,
                    ),
                ],
                spacing=SPACE_SM,
            ),
            left=CARD_PADDING,
            right=CARD_PADDING,
            bottom=CARD_PADDING,
        )

        stack_children = [card_body, hover_zone, footer_overlay, description_overlay]
        if updating:
            stack_children.append(
                ft.Container(
                    content=ft.ProgressRing(width=14, height=14, stroke_width=2),
                    top=6,
                    right=6,
                )
            )
        elif updatable:
            stack_children.append(
                ft.Container(
                    content=ft.IconButton(
                        icon=ft.Icons.SYSTEM_UPDATE_ALT,
                        icon_size=16,
                        icon_color=ft.Colors.PRIMARY,
                        tooltip=(
                            f"Update {widget.name} to version {registry_entry.version}"
                            if registry_entry.version
                            else f"Update {widget.name}"
                        ),
                        on_click=lambda e, ent=registry_entry: page.run_task(on_update, ent),
                    ),
                    top=0,
                    right=0,
                )
            )

        return ft.Stack(stack_children, expand=True)

    def build_catalogue_square(entry: CatalogEntry) -> ft.Control:
        """Build one Catalogue entry's tile.

        The logo (or, absent one, a placeholder Material icon) sits at a
        fixed glyph size on a neutral background, the same area either
        way, so a tile with a real logo and one still on the placeholder
        look consistent side by side instead of the real ones jumping out
        as bigger. A single tap anywhere installs it. The name sits at
        the bottom in plain black text, and an "add" badge sits in the
        top-right corner. No separate button or description on the tile
        itself - that detail lives in the tooltip instead.

        The clip and the border live on two separate, nested containers
        rather than one: putting `clip_behavior` and `border` on the
        same container clips the border itself away at the rounded
        corners, leaving the tile looking square and borderless. The
        inner container clips the logo/icon content to the rounded
        shape; the outer one, unclipped, is what actually draws the
        visible border.
        """
        installing = is_installing(page, entry.id)
        icon = (getattr(ft.Icons, entry.icon, None) if entry.icon else None) or ft.Icons.WIDGETS
        glyph_size = round(CATALOGUE_SIZE * 0.35 * entry.logo_size)

        logo_fill: ft.Control = ft.Container(
            content=(
                ft.Image(
                    src=entry.logo,
                    width=glyph_size,
                    height=glyph_size,
                    fit=ft.BoxFit.CONTAIN,
                )
                if entry.logo
                else ft.Icon(icon, size=glyph_size, color=ft.Colors.ON_SURFACE_VARIANT)
            ),
            width=CATALOGUE_SIZE,
            height=CATALOGUE_SIZE,
            bgcolor=ft.Colors.SURFACE_CONTAINER_LOW,
            alignment=ft.Alignment.CENTER,
        )

        badge = ft.Container(
            content=(
                ft.ProgressRing(width=10, height=10, stroke_width=2, color=ft.Colors.ON_PRIMARY)
                if installing
                else ft.Icon(ft.Icons.ADD, size=14, color=ft.Colors.ON_PRIMARY)
            ),
            width=BADGE_SIZE,
            height=BADGE_SIZE,
            bgcolor=ft.Colors.PRIMARY,
            border=ft.Border.all(2, ft.Colors.SURFACE_CONTAINER_LOW),
            border_radius=BADGE_SIZE / 2,
            alignment=ft.Alignment.CENTER,
        )

        name_overlay = ft.Container(
            content=ft.Text(
                entry.name,
                size=12,
                weight=ft.FontWeight.W_600,
                color=ft.Colors.WHITE,
                text_align=ft.TextAlign.CENTER,
                max_lines=1,
                overflow=ft.TextOverflow.ELLIPSIS,
            ),
            gradient=ft.LinearGradient(
                begin=ft.Alignment.TOP_CENTER,
                end=ft.Alignment.BOTTOM_CENTER,
                colors=[ft.Colors.TRANSPARENT, ft.Colors.with_opacity(0.75, ft.Colors.BLACK)],
            ),
            padding=ft.Padding(6, 20, 6, 8),
            left=0,
            right=0,
            bottom=0,
        )

        tooltip = entry.name
        if entry.description:
            tooltip = f"{entry.name}: {entry.description}"
        if installing:
            tooltip = f"Installing {entry.name}…"

        clipped_content = ft.Container(
            content=ft.Stack(
                [
                    logo_fill,
                    name_overlay,
                    ft.Container(content=badge, top=6, right=6),
                ],
                width=CATALOGUE_SIZE,
                height=CATALOGUE_SIZE,
            ),
            width=CATALOGUE_SIZE,
            height=CATALOGUE_SIZE,
            border_radius=radius_card(page),
            clip_behavior=ft.ClipBehavior.ANTI_ALIAS,
        )

        return ft.Container(
            content=clipped_content,
            width=CATALOGUE_SIZE,
            height=CATALOGUE_SIZE,
            border=card_border(),
            border_radius=radius_card(page),
            opacity=0.7 if installing else 1.0,
            tooltip=tooltip,
            on_click=(
                None if installing else (lambda e, ent=entry: page.run_task(on_install, ent))
            ),
        )

    registry_by_id: dict[str, CatalogEntry] = {}
    catalogue_fetched = False

    if catalogue_enabled:
        catalogue_fetched = page.session.store.get(_CATALOGUE_FETCHED_KEY)
        catalogue_error = page.session.store.get(_CATALOGUE_ERROR_KEY)
        all_entries = get_cached_registry(page)
        registry_by_id = {e.id: e for e in all_entries}
        catalogue_entries = [e for e in all_entries if e.id not in local_ids]

        if not catalogue_fetched:
            catalogue_content: ft.Control = text_caption("Loading…", italic=True)
        elif catalogue_error:
            catalogue_content = ft.Text(
                f"Couldn't reach the catalogue. Is your connection working? ({catalogue_error})",
                size=12,
                color=ft.Colors.ERROR,
            )
        elif catalogue_entries:
            catalogue_content = ft.Row(
                [build_catalogue_square(e) for e in catalogue_entries],
                scroll=ft.ScrollMode.AUTO,
                spacing=SPACE_MD,
            )
        else:
            catalogue_content = text_caption("No new widgets available.", italic=True)

        catalogue_banner = ft.Column(
            [
                text_section("Catalogue"),
                catalogue_content,
            ],
            spacing=SPACE_SM,
        )

    if widgets:
        installed_content: ft.Control = ft.GridView(
            [build_installed_square(w) for w in widgets],
            runs_count=INSTALLED_PER_ROW,
            child_aspect_ratio=1.0,
            spacing=SPACE_MD,
            run_spacing=SPACE_MD,
            expand=True,
            padding=scroll_padding(),
        )
    elif catalogue_enabled:
        installed_content = text_caption(
            "No widgets installed. Install one from the Catalogue above, or add one "
            "manually from Settings.",
            italic=True,
        )
    else:
        installed_content = text_caption(
            "No widgets installed. Add one manually from Settings.",
            italic=True,
        )

    installed_section = ft.Container(
        content=installed_content,
        height=max((page.height or 600) - INSTALLED_SECTION_TOP_GAP, 0),
        alignment=ft.Alignment.TOP_LEFT,
    )

    body: list[ft.Control] = (
        [catalogue_banner, ft.Divider(), installed_section]
        if catalogue_enabled
        else [installed_section]
    )

    if load_errors:
        for folder_name, error in load_errors:
            body.append(
                ft.Text(
                    f"{folder_name} failed to load. Did you edit its widget.py recently? ({error})",
                    size=12,
                    color=ft.Colors.ERROR,
                )
            )

    content = ft.Column(
        [
            text_title("Widgets"),
            *body,
        ],
        spacing=SPACE_LG,
        expand=True,
        scroll=ft.ScrollMode.AUTO,
        margin=scroll_margin(),
    )

    if catalogue_enabled and not catalogue_fetched:
        page.run_task(background_refresh_catalogue)

    return ft.View(
        route="/widgets",
        padding=0,
        horizontal_alignment=ft.CrossAxisAlignment.STRETCH,
        controls=[build_layout(page, content)],
    )
