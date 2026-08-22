"""The shared page shell: nav rail plus content area, used by every view."""

import asyncio
from typing import NamedTuple

import flet as ft

from toolblox.devtools import is_dev_environment
from toolblox.state import get_nav_position
from toolblox.ui.style import SPACE_MD, SPACE_SM, SPACE_XL, SPACE_XS, radius_card
from toolblox.version import display_version
from toolblox.widgets.loader import get_enabled_widgets

GITHUB_BAR_HEIGHT = 48
"""Height of the fixed GitHub-link bar pinned to the bottom of the nav sidebar."""

_SCROLL_OFFSET_KEY = "_nav_widgets_scroll_offset"
_SCROLL_CONTROL_KEY = "_nav_widgets_scroll_control"


class _CoreDestination(NamedTuple):
    route: str
    icon: str
    selected_icon: str
    label: str


CORE_DESTINATIONS = [
    _CoreDestination("/", ft.Icons.DASHBOARD_OUTLINED, ft.Icons.DASHBOARD, "Dashboard"),
    _CoreDestination("/accounts", ft.Icons.PEOPLE_OUTLINE, ft.Icons.PEOPLE, "Accounts"),
    _CoreDestination("/widgets", ft.Icons.EXTENSION_OUTLINED, ft.Icons.EXTENSION, "Widgets"),
    _CoreDestination("/settings", ft.Icons.SETTINGS_OUTLINED, ft.Icons.SETTINGS, "Settings"),
]

CORE_ROUTES = [d.route for d in CORE_DESTINATIONS]


def widget_route(widget_id: str) -> str:
    """The route a widget's own view is built at."""
    return f"/widgets/{widget_id}"


_RESTORE_ATTEMPTS = 5
_RESTORE_RETRY_DELAY = 0.03


async def restore_nav_scroll(page: ft.Page) -> None:
    """Reapply the widget nav list's saved scroll offset after a route rebuild.

    Every navigation rebuilds the whole page.views stack from scratch, which
    creates a brand new scrollable control with no memory of where the user
    had scrolled to. `build_layout` stores the live control and its last
    reported offset in `page.session.store` as it builds; this replays that
    offset once the new control has actually been added to the page, so
    clicking a widget doesn't visually reset the list to the top. Call this
    after `page.update()` in the route change handler.

    Only does this when landing on a widget's own route. The four core
    destinations (Dashboard/Accounts/Widgets/Settings) always sit in the
    list's first few rows, reachable with no scrolling at all, so they
    have no need for a remembered offset - and reapplying one anyway
    would still show the same reset-then-snap-back flicker described
    below, on every single core navigation, for no benefit. Restoring is
    limited to the one case the feature exists for: staying put when
    a scrolled-down widget list is used to jump between widgets.

    The new control reaches the Flutter client asynchronously, and a
    `scroll_to` sent before the client has finished laying it out is silently
    dropped rather than queued. Sending it once, immediately, means the jump
    either lands too early and does nothing (the list stays reset at the
    top) or arrives late enough to visibly snap into place after the reset
    is already on screen. Retrying a few times a beat apart re-sends the
    same offset until the client has actually mounted the list, so it lands
    on the first attempt that's not too early.
    """
    if not page.route.startswith("/widgets/"):
        return
    control = page.session.store.get(_SCROLL_CONTROL_KEY)
    offset = page.session.store.get(_SCROLL_OFFSET_KEY)
    if control is None or not offset:
        return
    for attempt in range(_RESTORE_ATTEMPTS):
        try:
            await control.scroll_to(offset=offset, duration=0)
        except Exception:
            return
        if attempt < _RESTORE_ATTEMPTS - 1:
            await asyncio.sleep(_RESTORE_RETRY_DELAY)


def build_layout(page: ft.Page, content: ft.Control) -> ft.Control:
    """Wrap page content in the shared nav rail and content area.

    Every view calls this to get the same nav rail, so a new view only
    needs to build its own content.

    Core destinations and enabled widgets are both rendered as plain
    clickable rows in a single scrollable `Column`, rather than using
    `ft.NavigationRail`. NavigationRail requires a bounded height and can't
    be nested as a shrink-to-content sibling of another scrollable control
    (a plain `Column` gives non-expanding children unbounded height, which
    NavigationRail rejects), and it exposes no scroll controller or
    `on_scroll` either way. A hand-rendered list sidesteps both problems and
    lets its scroll position be tracked and restored (see
    `restore_nav_scroll`) across the full-tree rebuild every navigation
    already does.
    """
    current_route = page.route

    async def go_to_route(route: str):
        await page.push_route(route)

    async def go_to_widget(widget_id: str):
        await page.push_route(widget_route(widget_id))

    def on_nav_scroll(e: ft.OnScrollEvent):
        page.session.store.set(_SCROLL_OFFSET_KEY, e.pixels)

    def nav_row(
        icon: str,
        label: str,
        selected: bool,
        on_click,
        logo: str | None = None,
        logo_size: float = 1.0,
    ) -> ft.Control:
        """A single nav rail row.

        `logo` renders in place of `icon` when given, the same
        icon-or-logo fallback `toolblox/ui/widgets.py::_icon_chip` uses for a
        widget's square on the Widgets screen - so a widget's own image
        shows in the nav rail too, not just there. `logo_size` scales that
        glyph, mirroring Widget.logo_size.

        The glyph sits in a fixed 24x24 box (unclipped) rather than being
        sized directly, so a `logo_size` above 1.0 makes the image visually
        bigger without growing the row's own layout size. Without that box,
        a bigger glyph grew the row's Column - and so the selected-row
        highlight painted behind it - to match, so a widget with an
        enlarged logo got a taller/wider blue highlight than every other
        row. Keeping the box's declared size constant keeps the highlight
        the same size across every widget regardless of its logo_size.

        The colored chip and the clickable area are two separate
        containers, not one. `nav_list` is a scrolling `Column`, and
        Flet stretches a scrolling `Column`'s children to its own full
        cross-axis width regardless of `horizontal_alignment` - so a
        bgcolor painted directly on a row's outer container spanned the
        whole sidebar width instead of hugging the icon/label. The outer
        container here stays transparent and full width (so the entire
        row is still clickable, not just the text), while `chip` - the
        one actually painted `SECONDARY_CONTAINER` when selected - is an
        inner container with no stretch source of its own, so it shrinks
        to its icon+label content and `alignment=CENTER` centers that
        chip within the wide, invisible outer row.

        `glyph_box` is a `Stack`, not a `Container`, for the same reason:
        a `logo_size` above 1.0 makes `glyph` itself bigger than the
        24x24 box, and a plain `Container` asked to hold a bigger child
        without clipping it lets that child's size leak into the
        Container's own reported width - which was exactly why a widget
        with an enlarged logo (e.g. Rogue Lineage's 1.5) ended up with a
        selected-row highlight stretching the full sidebar width instead
        of hugging its icon/label like every other row. A `Stack` with
        an explicit width/height reports that fixed size to its parent
        regardless of an oversized, centered child, so the bigger glyph
        still paints past the box's edges (unclipped, same visual result
        as before) without growing the row's own layout size.
        """
        glyph_size = round(24 * logo_size)
        glyph = (
            ft.Image(src=logo, width=glyph_size, height=glyph_size, fit=ft.BoxFit.CONTAIN)
            if logo
            else ft.Icon(icon, size=glyph_size)
        )
        glyph_box = ft.Stack(
            [glyph],
            width=24,
            height=24,
            alignment=ft.Alignment.CENTER,
        )
        chip = ft.Container(
            content=ft.Column(
                [glyph_box, ft.Text(label, size=12)],
                horizontal_alignment=ft.CrossAxisAlignment.CENTER,
                spacing=4,
            ),
            padding=ft.Padding.symmetric(vertical=SPACE_SM, horizontal=SPACE_XS),
            border_radius=radius_card(page),
            bgcolor=ft.Colors.SECONDARY_CONTAINER if selected else None,
        )
        return ft.Container(content=chip, alignment=ft.Alignment.CENTER, on_click=on_click)

    rows: list[ft.Control] = []
    for dest in CORE_DESTINATIONS:
        selected = current_route == dest.route
        rows.append(
            nav_row(
                dest.selected_icon if selected else dest.icon,
                dest.label,
                selected,
                lambda e, route=dest.route: page.run_task(go_to_route, route),
            )
        )

    widgets = get_enabled_widgets(page)
    if widgets:
        rows.append(
            ft.Container(
                width=48,
                height=1,
                bgcolor=ft.Colors.OUTLINE_VARIANT,
                margin=ft.Margin.symmetric(horizontal=SPACE_MD, vertical=SPACE_SM),
            )
        )
        for widget in widgets:
            selected = current_route == widget_route(widget.id)
            icon = (widget.selected_icon if selected else None) or widget.icon or ft.Icons.EXTENSION
            rows.append(
                nav_row(
                    icon,
                    widget.name,
                    selected,
                    lambda e, wid=widget.id: page.run_task(go_to_widget, wid),
                    logo=widget.logo,
                    logo_size=widget.logo_size,
                )
            )
    rows.append(ft.Container(height=GITHUB_BAR_HEIGHT))

    nav_list = ft.Column(
        rows,
        spacing=4,
        horizontal_alignment=ft.CrossAxisAlignment.CENTER,
        scroll=ft.ScrollMode.ALWAYS,
        on_scroll=on_nav_scroll,
    )
    page.session.store.set(_SCROLL_CONTROL_KEY, nav_list)

    github_button = ft.IconButton(
        icon=ft.Image(
            src="github.svg",
            width=20,
            height=20,
            color=ft.Colors.ON_SURFACE,
            color_blend_mode=ft.BlendMode.SRC_IN,
        ),
        tooltip="Open the Toolblox repo on GitHub",
        url="https://github.com/BakedAleska",
    )

    nav_sidebar = ft.Stack(
        [
            nav_list,
            ft.Container(
                content=github_button,
                left=0,
                right=0,
                bottom=0,
                height=GITHUB_BAR_HEIGHT,
                alignment=ft.Alignment.CENTER,
                bgcolor=ft.Colors.SURFACE,
            ),
        ]
    )

    content_area = ft.Container(content=content, expand=True, padding=SPACE_XL)
    divider = ft.VerticalDivider(width=1)

    if get_nav_position(page) == "right":
        row_controls = [content_area, divider, nav_sidebar]
    else:
        row_controls = [nav_sidebar, divider, content_area]

    row = ft.Row(row_controls, expand=True, spacing=0)

    is_canary = is_dev_environment()
    version_badge = ft.Container(
        content=ft.Text(
            f"v{display_version()}",
            size=10,
            color=ft.Colors.ON_SURFACE_VARIANT,
            tooltip=(
                "Running from a source checkout: widgets and the Catalogue "
                "load straight from this repo instead of an installed copy."
                if is_canary
                else "The installed, publicly released build."
            ),
        ),
        right=8,
        bottom=8,
    )

    return ft.Stack([row, version_badge], expand=True)
