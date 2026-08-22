"""Shared visual constants and helpers, so every card and container uses
the same corner rounding and border style.
"""

import flet as ft

RADIUS_CARD = 12
"""Default radius for bordered cards and list items. Used by account
cards, widget squares, dashboard account tiles, and the nav rail's
widget rows.
"""

RADIUS_HERO = 16
"""Default radius for large, single prominent containers, such as the
Dashboard's hero card.
"""

RADIUS_PILL = 999
"""Radius for fully rounded chip and pill elements. Flutter clamps this
to half the container's shorter side, so it always produces a full pill.
"""

RADIUS_MENU = 8
"""Radius for a floating menu or dropdown, such as a search field's
autofill suggestions. Deliberately smaller than RADIUS_CARD - a shallow
row-height panel reads as overly circular at the card radius, the same
way a small button looks rounder than a large one at the same pixel
radius.
"""

DIALOG_WIDTH = 440
"""Content width for every ft.AlertDialog in the app, so pop-up windows
read as one consistent size instead of each dialog sizing itself to its
own content. Reference size is Rogue Lineage's add-character dialog.
"""

SWITCH_SCALE = 0.8
"""Scale for every ft.Switch in the app, so on/off toggles read as a
compact control next to a settings row instead of Flutter's oversized
default."""

SPACE_XS = 4
"""Spacing between a label and its own caption directly beneath it."""

SPACE_SM = 8
"""Spacing between closely related controls in a row, or list item
spacing in compact mode."""

SPACE_MD = 12
"""Default row/column spacing. The most common gap in the app - reach
for this first."""

SPACE_LG = 16
"""Spacing between distinct sections on the same screen."""

SPACE_XL = 24
"""Spacing for a hero card's internal breathing room, and the app-wide
outer padding around every screen's content area (see
`multitool.ui.layout.build_layout`). Rare - most spacing should use a
smaller step."""


def text_title(value: str, **kwargs: object) -> ft.Text:
    """A view's own title, e.g. "Dashboard" or "Settings". One per screen,
    always the first thing on it.
    """
    return ft.Text(value, size=24, weight=ft.FontWeight.BOLD, **kwargs)


def text_heading(value: str, **kwargs: object) -> ft.Text:
    """A widget's own hero/status value, e.g. Autoclicker's "Running" /
    "Stopped" state or the Mana bar overlay's run state. Sits between
    text_title and text_section: bigger and heavier than any label so it
    reads as the one focal point of a hero card, but not screen-title
    weight, since it's a state word, not the screen's own name.
    """
    return ft.Text(value, size=18, weight=ft.FontWeight.W_600, **kwargs)


def text_section(value: str, **kwargs: object) -> ft.Text:
    """A titled group inside a screen, e.g. "Appearance" or "Danger Zone"."""
    return ft.Text(value, size=14, weight=ft.FontWeight.W_600, **kwargs)


def text_label(value: str, **kwargs: object) -> ft.Text:
    """A single control's own name, e.g. "Show avatars" next to its switch."""
    return ft.Text(value, size=14, weight=ft.FontWeight.W_500, **kwargs)


def text_caption(value: str, **kwargs: object) -> ft.Text:
    """Muted helper or secondary text under a label or section."""
    return ft.Text(value, size=12, color=ft.Colors.ON_SURFACE_VARIANT, **kwargs)

SCROLL_GUTTER = 12
"""Space reserved on the trailing edge of every vertically scrolling
list or column, so the scrollbar rendered there never sits on top of a
button, switch, or other edge-aligned control. Paired with the app-wide
ScrollbarTheme built by app_theme() below, which sets the scrollbar's
own thickness and color. Applied via scroll_padding() for controls with
a padding property (ListView, GridView) and scroll_margin() for
controls that only have margin (Column, Row).
"""

SCROLLBAR_THICKNESS = 6
"""Width of every scrollbar in the app, in logical pixels. Kept slim and
uniform (see app_theme's scrollbar_theme) so a scrollbar reads as a
quiet edge detail rather than competing with the content next to it.
"""


def scroll_padding() -> ft.Padding:
    """Trailing-edge clearance for a scrollable control that has its own
    padding property, such as ListView or GridView. See SCROLL_GUTTER.
    """
    return ft.Padding.only(right=SCROLL_GUTTER)


def scroll_margin() -> ft.Margin:
    """Trailing-edge clearance for a scrollable control that only has
    margin, such as Column or Row. See SCROLL_GUTTER.
    """
    return ft.Margin.only(right=SCROLL_GUTTER)


def thin_button_style() -> ft.ButtonStyle:
    """A shorter button, for buttons sitting in a settings form instead
    of standing alone as a primary call to action.

    Returns a fresh ButtonStyle on each call, matching card_border's
    no-shared-mutable-property convention.
    """
    return ft.ButtonStyle(padding=ft.Padding.symmetric(horizontal=SPACE_LG, vertical=SPACE_SM))


def radius_card(page: ft.Page) -> float:
    return RADIUS_CARD


def radius_hero(page: ft.Page) -> float:
    return RADIUS_HERO


def radius_menu(page: ft.Page) -> float:
    return RADIUS_MENU


def status_dot(color: str, *, size: int = 8) -> ft.Container:
    """A small filled circle for an at-a-glance running/stopped/error
    state, the same visual idiom the Accounts screen uses for each
    account's presence dot. Pass a semantic color role, e.g.
    `ft.Colors.GREEN` for running, `ft.Colors.ERROR` for an error state,
    or `ft.Colors.OUTLINE_VARIANT` for idle/neutral.
    """
    return ft.Container(width=size, height=size, bgcolor=color, border_radius=size / 2)


def card_border() -> ft.Border:
    """The standard 1px outline used on every bordered card.

    Returns a fresh Border on each call. Flet controls shouldn't share
    one mutable property object.
    """
    return ft.Border.all(1, ft.Colors.OUTLINE_VARIANT)


def section_box(page: ft.Page, content: ft.Control) -> ft.Container:
    """A bordered box grouping one screen section's controls - a
    Settings section, or a widget's own feature box (e.g. Rogue
    Lineage's Characters and Mana bar overlay boxes).

    Same visual motif as every other card-tier box in the app: card_border()
    + radius_card() + SPACE_SM padding. This is the app-wide reference
    padding for a card-tier box - keep it in sync with any card-tier box
    built by hand elsewhere rather than picking a new value there. Kept
    tight deliberately: a box's height should track its content, not
    generous padding, so boxes stacked on the same screen read close in
    height to each other.
    """
    return ft.Container(
        content=content,
        padding=SPACE_SM,
        border=card_border(),
        border_radius=radius_card(page),
    )


def app_theme() -> ft.Theme:
    """The app's single, fixed Theme.

    Page transitions are always disabled: instant view switches are a
    deliberate choice for this app. The scrollbar is kept thin and
    uniform across every scrollable list, grid, and column.
    """
    return ft.Theme(
        page_transitions=ft.PageTransitionsTheme(
            windows=ft.PageTransitionTheme.NONE,
            macos=ft.PageTransitionTheme.NONE,
            linux=ft.PageTransitionTheme.NONE,
            android=ft.PageTransitionTheme.NONE,
            ios=ft.PageTransitionTheme.NONE,
        ),
        scrollbar_theme=ft.ScrollbarTheme(
            thickness=SCROLLBAR_THICKNESS,
            radius=SCROLLBAR_THICKNESS / 2,
            thumb_color=ft.Colors.OUTLINE_VARIANT,
            track_color=ft.Colors.TRANSPARENT,
            track_visibility=False,
            thumb_visibility=False,
            interactive=True,
            cross_axis_margin=2,
            main_axis_margin=2,
        ),
    )
