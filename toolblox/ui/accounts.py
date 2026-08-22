"""The Accounts screen: list, add, remove, join, and reorder tracked accounts."""

import asyncio
import json
import sys
import time
from pathlib import Path

import flet as ft
import httpx

from toolblox.data import accounts as accounts_store
from toolblox.logs import get_logger
from toolblox.roblox import status as status_tracker
from toolblox.roblox.login import LOGIN_ARG
from toolblox.roblox.process_watch import running_pids
from toolblox.state import get_auto_rejoin, get_compact_mode, get_show_avatars, get_sort_order
from toolblox.ui.join_action import join_with_account
from toolblox.ui.layout import build_layout
from toolblox.ui.style import (
    SPACE_MD,
    SPACE_SM,
    SPACE_XS,
    card_border,
    radius_card,
    scroll_padding,
    text_label,
    text_title,
    thin_button_style,
)
from toolblox.ui.toast import show_confirm_toast, show_toast

logger = get_logger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parents[2]

AVATAR_SIZE = 56
COMPACT_AVATAR_SIZE = 28

USER_URL = "https://users.roblox.com/v1/users/{user_id}"
THUMBNAIL_URL = "https://thumbnails.roblox.com/v1/users/avatar-headshot"

_GENERATION_KEY = "_accounts_view_generation"
_SELECT_MODE_KEY = "_accounts_select_mode"
_SELECTED_IDS_KEY = "_accounts_selected_ids"
_AUTO_REJOIN_STATE_KEY = "_auto_rejoin_state"

BATCH_JOIN_STAGGER_SECONDS = 2
"""Delay between each account's launch in a batch join, giving a launched
instance time to actually spawn before the next one's singleton-bypass
runs. See multi_instance.py's own docstring for why that ordering matters.
"""

AUTO_REJOIN_GRACE_SECONDS = 90
"""How soon after an auto-rejoin an account has to be seen leaving again
before auto-rejoin gives up on it. Meant to catch the case where rejoining
doesn't actually stick (e.g. banned from the place, server full), so it
doesn't loop forever - see handle_account_left()'s docstring.
"""

STATUS_COLORS = {
    status_tracker.GREY: ft.Colors.OUTLINE_VARIANT,
    status_tracker.RED: ft.Colors.ERROR,
    status_tracker.GREEN: ft.Colors.GREEN,
}
STATUS_LABELS = {
    status_tracker.GREY: "Not in a place",
    status_tracker.RED: "Roblox may have crashed",
    status_tracker.GREEN: "In a place",
}


def fetch_profile(user_id: int) -> dict:
    """Fetch a user's display name and avatar URL from Roblox's public APIs.

    Missing pieces are left out of the result instead of raising. Used
    to backfill accounts added before these fields were tracked.
    """
    profile = {}

    try:
        response = httpx.get(USER_URL.format(user_id=user_id), timeout=10)
        response.raise_for_status()
        data = response.json()
        profile["display_name"] = data.get("displayName") or data.get("name")
    except (httpx.HTTPError, ValueError) as e:
        logger.warning("Couldn't fetch display name for user %s: %s", user_id, e)

    try:
        response = httpx.get(
            THUMBNAIL_URL,
            params={
                "userIds": user_id,
                "size": "150x150",
                "format": "Png",
                "isCircular": "false",
            },
            timeout=10,
        )
        response.raise_for_status()
        data = response.json().get("data") or []
        if data:
            profile["avatar_url"] = data[0]["imageUrl"]
    except (httpx.HTTPError, KeyError, IndexError, ValueError) as e:
        logger.warning("Couldn't fetch avatar for user %s: %s", user_id, e)

    return profile


def sort_accounts(accounts: list[dict], sort_order: str) -> list[dict]:
    """Sort accounts for display, according to the given sort order.

    "manual" returns the list as stored. Drag reordering writes the new
    order to disk directly, so no sorting is needed here for that case.
    "last_played" puts the most recently played account first, falling
    back to an account's added_at if it's never been played.
    """
    if sort_order == "alphabetical":
        return sorted(accounts, key=lambda a: (a.get("display_name") or a["name"]).lower())
    if sort_order == "manual":
        return list(accounts)
    return sorted(
        accounts,
        key=lambda a: a.get("last_played_at") or a.get("added_at", 0),
        reverse=True,
    )


def AccountsView(page: ft.Page) -> ft.View:
    """The Accounts screen.

    Every mutation, such as add, remove, reorder, or edit notes, reads
    the current list from disk with accounts_store.load(), applies the
    change, writes it back, and calls refresh() to rebuild the view.
    There is no in-memory account store beyond that load and save pair.
    """

    def refresh():
        """Rebuild this view in place, if it's still the one on screen."""
        if not page.views or page.views[-1].route != "/accounts":
            return
        page.views[-1] = AccountsView(page)
        page.update()

    search_field = ft.TextField(
        hint_text="Search...",
        prefix_icon=ft.Icons.SEARCH,
        dense=True,
        expand=True,
        on_change=lambda e: render_account_list(),
    )

    def account_matches(account: dict) -> bool:
        query = (search_field.value or "").strip().lower()
        if not query:
            return True
        haystack = " ".join(
            [account.get("name", ""), account.get("display_name") or "", account.get("notes") or ""]
        ).lower()
        return query in haystack

    async def backfill_missing_profiles():
        """Fill in display_name and avatar_url for older accounts.

        Runs once per view build and calls refresh() only if something
        changed.
        """
        current = accounts_store.load()
        missing = [a for a in current if not a.get("avatar_url") or not a.get("display_name")]
        if not missing:
            return

        changed = False
        for account in missing:
            profile = await asyncio.to_thread(fetch_profile, account["id"])
            if profile.get("display_name") and not account.get("display_name"):
                account["display_name"] = profile["display_name"]
                changed = True
            if profile.get("avatar_url") and not account.get("avatar_url"):
                account["avatar_url"] = profile["avatar_url"]
                changed = True

        if changed:
            accounts_store.save(current)
            refresh()

    def _get_auto_rejoin_entry(user_id: int) -> dict:
        return (page.session.store.get(_AUTO_REJOIN_STATE_KEY) or {}).get(user_id, {})

    def _set_auto_rejoin_entry(user_id: int, entry: dict) -> None:
        state = dict(page.session.store.get(_AUTO_REJOIN_STATE_KEY) or {})
        state[user_id] = entry
        page.session.store.set(_AUTO_REJOIN_STATE_KEY, state)

    def reset_auto_rejoin_state(user_id: int) -> None:
        """Clear any auto-rejoin bookkeeping for one account.

        Called before a manual Join, so pressing Join yourself always
        gives auto-rejoin a clean slate - the built-in fix for forgetting
        the setting is on and finding it's gone quiet on some account.
        """
        state = dict(page.session.store.get(_AUTO_REJOIN_STATE_KEY) or {})
        if state.pop(user_id, None) is not None:
            page.session.store.set(_AUTO_REJOIN_STATE_KEY, state)

    def handle_account_left(account: dict):
        """Auto-rejoin one account after it's detected leaving its place.

        Safety: if this account was already auto-rejoined less than
        AUTO_REJOIN_GRACE_SECONDS ago and is now leaving again, that
        rejoin evidently didn't stick (banned, server full, ...) - stop
        retrying it and leave it suspended until a manual Join resets it,
        rather than looping forever in the background.
        """
        if not get_auto_rejoin(page):
            return

        user_id = account["id"]
        entry = _get_auto_rejoin_entry(user_id)
        if entry.get("suspended"):
            return

        last_rejoin_at = entry.get("last_rejoin_at")
        if last_rejoin_at is not None and time.time() - last_rejoin_at < AUTO_REJOIN_GRACE_SECONDS:
            _set_auto_rejoin_entry(user_id, {"suspended": True})
            label = account.get("display_name") or account["name"]
            logger.info("Auto-rejoin suspended for %s (left again right after rejoining)", label)
            show_toast(
                page,
                f"Auto-rejoin paused for {label}. It left again right after rejoining, "
                "so it won't keep retrying. Join it manually to resume auto-rejoin.",
            )
            return

        _set_auto_rejoin_entry(user_id, {"last_rejoin_at": time.time()})
        page.run_task(do_join, account)

    async def poll_status_loop(generation: int):
        """Repeatedly refresh every account's status dot from presence.

        Runs on a timer for as long as this exact view build is the one
        on screen, tracked by generation rather than route alone - a
        route match isn't enough, since refresh() replaces this view
        with a new build (and a new loop) that would otherwise run
        alongside this one, doubling up forever.
        """
        while True:
            if (
                not page.views
                or page.views[-1].route != "/accounts"
                or page.session.store.get(_GENERATION_KEY) != generation
            ):
                return
            await status_tracker.poll_presence(
                page, accounts_store.load(), refresh, on_left=handle_account_left
            )
            await asyncio.sleep(status_tracker.AMBIENT_POLL_SECONDS)

    async def do_join(account: dict):
        """Join with one account, then watch for a crash or an in-place status.

        Snapshots running Roblox processes before the join dispatches, so
        watch_join can tell a newly launched process apart from one that
        was already open for another account.
        """
        before_pids = await asyncio.to_thread(running_pids)
        cookie = account.get("security_cookie")
        launched = await join_with_account(page, account)
        if launched and cookie:
            page.run_task(
                status_tracker.watch_join, page, account["id"], before_pids, cookie, refresh
            )

    def start_manual_join(account: dict):
        """Reset any auto-rejoin suspension for this account, then join it."""
        reset_auto_rejoin_state(account["id"])
        page.run_task(do_join, account)

    async def do_batch_join(accounts: list[dict]):
        """Join with each of the given accounts, one after another.

        A short stagger runs between launches (see
        BATCH_JOIN_STAGGER_SECONDS) so each Roblox instance has time to
        actually spawn before the next account's singleton-bypass looks
        at the running process list.
        """
        for i, account in enumerate(accounts):
            reset_auto_rejoin_state(account["id"])
            await do_join(account)
            if i < len(accounts) - 1:
                await asyncio.sleep(BATCH_JOIN_STAGGER_SECONDS)

    def add_account(payload: dict):
        """Add a newly logged in account, unless it's already tracked."""
        current = accounts_store.load()
        if not any(a["id"] == payload["id"] for a in current):
            current.append(
                {
                    "id": payload["id"],
                    "name": payload["name"],
                    "display_name": payload.get("display_name") or payload["name"],
                    "avatar_url": payload.get("avatar_url"),
                    "notes": "",
                    "added_at": time.time(),
                    "security_cookie": payload.get("security_cookie"),
                }
            )
            accounts_store.save(current)
        refresh()

    def remove_account(user_id: int):
        """Remove one account by id."""
        current = accounts_store.load()
        current = [a for a in current if a["id"] != user_id]
        accounts_store.save(current)
        reset_auto_rejoin_state(user_id)
        selected = get_selected_ids()
        if user_id in selected:
            selected.discard(user_id)
            page.session.store.set(_SELECTED_IDS_KEY, selected)
        refresh()

    def save_notes(user_id: int, notes: str):
        """Save an edited notes field for one account."""
        current = accounts_store.load()
        for a in current:
            if a["id"] == user_id:
                a["notes"] = notes
                break
        accounts_store.save(current)

    def is_select_mode() -> bool:
        return bool(page.session.store.get(_SELECT_MODE_KEY))

    def get_selected_ids() -> set[int]:
        return set(page.session.store.get(_SELECTED_IDS_KEY) or set())

    def toggle_select_mode(e: ft.Event[ft.IconButton]):
        """Enter or leave batch-select mode, clearing any selection either way."""
        page.session.store.set(_SELECT_MODE_KEY, not is_select_mode())
        page.session.store.set(_SELECTED_IDS_KEY, set())
        refresh()

    def toggle_selected(user_id: int, value: bool):
        """Add or remove one account from the current batch selection.

        Only updates the checkbox's own row and the toolbar's selected
        count/button state directly, rather than rebuilding the whole
        view, so checking boxes stays snappy.
        """
        selected = get_selected_ids()
        if value:
            selected.add(user_id)
        else:
            selected.discard(user_id)
        page.session.store.set(_SELECTED_IDS_KEY, selected)
        selected_count_text.value = f"{len(selected)} selected"
        selected_count_text.update()
        join_selected_button.disabled = not selected
        join_selected_button.update()

    def select_all(e: ft.Event[ft.TextButton]):
        visible_ids = {a["id"] for a in sort_accounts(accounts_store.load(), sort_order)
                       if account_matches(a)}
        page.session.store.set(_SELECTED_IDS_KEY, visible_ids)
        refresh()

    def clear_selection(e: ft.Event[ft.TextButton]):
        page.session.store.set(_SELECTED_IDS_KEY, set())
        refresh()

    async def on_join_selected(e: ft.Event[ft.FilledButton]):
        selected = get_selected_ids()
        if not selected:
            return
        current = {a["id"]: a for a in accounts_store.load()}
        targets = [current[uid] for uid in selected if uid in current]
        join_selected_button.disabled = True
        join_selected_button.update()
        try:
            await do_batch_join(targets)
        finally:
            join_selected_button.disabled = not get_selected_ids()
            join_selected_button.update()

    async def open_add_account(e: ft.Event[ft.IconButton]):
        """Run the Roblox login flow and add the resulting account.

        Spawns ``python -m toolblox.roblox.login`` as a subprocess (or, for
        a frozen build, this same exe relaunched with LOGIN_ARG - see that
        module's docstring) and reads the JSON line it prints to stdout on
        success.
        """
        add_button.disabled = True
        page.update()

        if getattr(sys, "frozen", False):
            command = [sys.executable, LOGIN_ARG]
        else:
            command = [sys.executable, "-m", "toolblox.roblox.login"]

        try:
            proc = await asyncio.create_subprocess_exec(
                *command,
                cwd=PROJECT_ROOT,
                stdout=asyncio.subprocess.PIPE,
            )
            line = await proc.stdout.readline()
            await proc.wait()
        finally:
            add_button.disabled = False
            page.update()

        if not line:
            return

        try:
            payload = json.loads(line)
        except json.JSONDecodeError as e:
            logger.warning("Couldn't parse login subprocess output %r: %s", line, e)
            return

        add_account(payload)

    def build_account_card(account: dict, sort_order: str) -> ft.Control:
        """Build one account row, with its play, remove, and drag controls.

        The controls are placed as Stack overlays with fixed top and
        right offsets. The one exception is compact mode with manual
        sort, where play, remove, and the drag handle sit together in a
        real Row instead, so Flet can center them against each other's
        actual size instead of relying on fixed offsets. In that row the
        order is play, remove, then drag handle.

        Outside compact mode, the drag handle's top offset lines up with
        the bottom of the avatar frame. The handle's own padding is set
        to match IconButton's default padding, so it sits flush with the
        play and remove buttons next to it.

        The status dot sits below the drag handle, centered on the same
        column as the play/remove buttons and drag handle rather than
        tucked into the raw corner. When there's no drag handle (manual
        sort is off), it centers under the play button's column instead
        of the remove button's, since remove sits at the same right
        offset the handle would otherwise occupy. When avatars are shown
        outside compact mode, its vertical center lines up with the
        bottom edge of the avatar frame instead of the card's bottom
        edge.
        """
        username = account["name"]
        display_name = account.get("display_name") or username
        if display_name and display_name != username:
            header_text = f"({display_name}) {username}"
        else:
            header_text = username

        compact = get_compact_mode(page)
        avatar_size = COMPACT_AVATAR_SIZE if compact else AVATAR_SIZE
        show_avatars = get_show_avatars(page)

        row_controls: list[ft.Control] = []

        if is_select_mode():
            row_controls.append(
                ft.Checkbox(
                    value=account["id"] in get_selected_ids(),
                    on_change=lambda e, uid=account["id"]: toggle_selected(uid, e.control.value),
                )
            )

        dot_size = 8 if compact else 10
        account_status = status_tracker.get_status(page, account["id"])
        status_dot = ft.Container(
            width=dot_size,
            height=dot_size,
            bgcolor=STATUS_COLORS[account_status],
            border=ft.Border.all(2, ft.Colors.SURFACE),
            border_radius=dot_size / 2,
            tooltip=STATUS_LABELS[account_status],
        )

        if show_avatars:
            avatar_url = account.get("avatar_url")
            avatar_content = (
                ft.Image(src=avatar_url, width=avatar_size, height=avatar_size, fit=ft.BoxFit.COVER)
                if avatar_url
                else ft.Icon(ft.Icons.PERSON, size=avatar_size * 0.6)
            )

            row_controls.append(
                ft.Container(
                    content=avatar_content,
                    width=avatar_size,
                    height=avatar_size,
                    bgcolor=ft.Colors.SURFACE_CONTAINER_HIGHEST,
                    alignment=ft.Alignment.CENTER,
                )
            )

        column_controls: list[ft.Control] = [text_label(header_text)]

        if not compact:
            column_controls.append(
                ft.TextField(
                    value=account.get("notes", ""),
                    hint_text="Notes...",
                    multiline=True,
                    dense=True,
                    border=ft.InputBorder.NONE,
                    content_padding=ft.Padding.symmetric(vertical=SPACE_XS, horizontal=0),
                    text_size=12,
                    hint_style=ft.TextStyle(color=ft.Colors.ON_SURFACE_VARIANT, size=12),
                    on_blur=lambda e, uid=account["id"]: save_notes(uid, e.control.value),
                )
            )

        is_manual = sort_order == "manual" and not (search_field.value or "").strip()
        compact_row = compact and is_manual

        row_controls.append(ft.Column(column_controls, expand=True, spacing=2))

        card_padding = SPACE_XS if compact else SPACE_SM
        button_clearance = 100 if compact_row else 64
        card = ft.Container(
            content=ft.Row(
                row_controls,
                spacing=12,
                vertical_alignment=ft.CrossAxisAlignment.CENTER
                if compact
                else ft.CrossAxisAlignment.START,
            ),
            padding=ft.Padding.only(
                left=card_padding,
                top=card_padding,
                bottom=card_padding,
                right=card_padding + button_clearance,
            ),
            border=card_border(),
            border_radius=radius_card(page),
        )

        stack_controls = [card]

        handle_icon_size = 18
        handle_padding = SPACE_SM
        handle_box_size = handle_icon_size + handle_padding * 2

        status_dot.right = (
            2 + (handle_box_size - dot_size) / 2
            if is_manual
            else 34 + (handle_box_size - dot_size) / 2
        )
        if show_avatars and not compact:
            avatar_bottom = card_padding + avatar_size
            status_dot.top = avatar_bottom - dot_size / 2
        else:
            status_dot.bottom = 2

        drag_handle_widget = None

        if is_manual:

            def on_handle_hover(e: ft.Event[ft.Container]):
                """Fade the drag handle in and out on hover."""
                e.control.opacity = 1.0 if e.data == "true" else 0.4
                e.control.update()

            drag_handle_widget = ft.ReorderableDragHandle(
                content=ft.Container(
                    content=ft.Icon(
                        ft.Icons.DRAG_INDICATOR,
                        size=handle_icon_size,
                        color=ft.Colors.ON_SURFACE_VARIANT,
                    ),
                    alignment=ft.Alignment.CENTER,
                    padding=handle_padding,
                    border_radius=handle_box_size / 2,
                    opacity=0.4,
                    animate_opacity=150,
                    on_hover=on_handle_hover,
                ),
                mouse_cursor=ft.MouseCursor.GRAB,
            )

        play_button = ft.IconButton(
            icon=ft.Icons.PLAY_CIRCLE_OUTLINE,
            icon_size=18,
            tooltip="Join place",
            on_click=lambda e, a=account: start_manual_join(a),
        )

        remove_button = ft.IconButton(
            icon=ft.Icons.REMOVE_CIRCLE_OUTLINE,
            icon_size=18,
            tooltip="Remove account",
            on_click=lambda e, uid=account["id"], label=header_text: show_confirm_toast(
                page, f"Remove {label}?", lambda: remove_account(uid)
            ),
        )

        if compact_row:
            stack_controls.append(
                ft.Container(
                    content=ft.Row(
                        [play_button, remove_button, drag_handle_widget],
                        spacing=0,
                        vertical_alignment=ft.CrossAxisAlignment.CENTER,
                    ),
                    top=0,
                    bottom=0,
                    right=0,
                    alignment=ft.Alignment.CENTER_RIGHT,
                )
            )
        else:
            play_button.top = 2
            play_button.right = 34
            remove_button.top = 2
            remove_button.right = 2
            stack_controls.extend([play_button, remove_button])

            if drag_handle_widget is not None:
                if compact:
                    handle_top = 2
                else:
                    handle_top = (
                        card_padding + avatar_size - handle_box_size - 4 if show_avatars else 2
                    )
                stack_controls.append(
                    ft.Container(content=drag_handle_widget, top=handle_top, right=2)
                )

        stack_controls.append(status_dot)

        return ft.Stack(stack_controls)

    sort_order = get_sort_order(page)
    list_spacing = 8 if get_compact_mode(page) else 14

    def render_account_list(mounted: bool = True):
        """Recompute the filtered, sorted account list in place.

        Only the list control's own contents change here - the search
        field itself is never rebuilt, so typing doesn't lose focus or
        reset what's been typed the way a full AccountsView(page) rebuild
        would.
        """
        sorted_accounts = sort_accounts(accounts_store.load(), sort_order)
        accounts = [a for a in sorted_accounts if account_matches(a)]
        if sort_order == "manual":
            account_list.controls = [
                ft.Container(
                    content=build_account_card(a, sort_order),
                    key=str(a["id"]),
                    margin=ft.Margin.only(bottom=list_spacing),
                )
                for a in accounts
            ]
        else:
            account_list.controls = [build_account_card(a, sort_order) for a in accounts]
        if mounted:
            account_list.update()

    if sort_order == "manual":

        def on_reorder(e: ft.OnReorderEvent):
            """Move one account to its new position and save the order.

            Only reachable while unfiltered: build_account_card hides the
            drag handle whenever a search is active, since the displayed
            indices then no longer line up with accounts_store.load()'s
            raw order, which this handler assumes.
            """
            current = accounts_store.load()
            item = current.pop(e.old_index)
            current.insert(e.new_index, item)
            accounts_store.save(current)
            refresh()

        account_list: ft.Control = ft.ReorderableListView(
            controls=[],
            expand=True,
            show_default_drag_handles=False,
            on_reorder=on_reorder,
            padding=scroll_padding(),
        )
    else:
        account_list = ft.ListView(
            controls=[], expand=True, spacing=list_spacing, padding=scroll_padding()
        )

    render_account_list(mounted=False)

    add_button = ft.IconButton(
        icon=ft.Icons.ADD,
        tooltip="Add account",
        on_click=open_add_account,
    )

    select_mode = is_select_mode()
    selected_count = len(get_selected_ids())

    select_toggle_button = ft.IconButton(
        icon=ft.Icons.CHECKLIST if not select_mode else ft.Icons.CLOSE,
        tooltip="Cancel selecting" if select_mode else "Select accounts to join",
        on_click=toggle_select_mode,
    )

    header_controls: list[ft.Control] = [text_title("Accounts"), search_field]
    if not select_mode:
        header_controls.append(add_button)
    header_controls.append(select_toggle_button)

    content_controls: list[ft.Control] = [
        ft.Row(
            header_controls,
            spacing=SPACE_MD,
            vertical_alignment=ft.CrossAxisAlignment.CENTER,
        ),
    ]

    if select_mode:
        selected_count_text = text_label(f"{selected_count} selected")
        join_selected_button = ft.FilledButton(
            "Join Selected",
            icon=ft.Icons.PLAY_CIRCLE_OUTLINE,
            on_click=on_join_selected,
            disabled=selected_count == 0,
            style=thin_button_style(),
        )
        content_controls.append(
            ft.Row(
                [
                    ft.TextButton("Select all", on_click=select_all),
                    ft.TextButton("Select none", on_click=clear_selection),
                    selected_count_text,
                    join_selected_button,
                ],
                spacing=SPACE_SM,
                vertical_alignment=ft.CrossAxisAlignment.CENTER,
            )
        )

    content_controls.append(account_list)

    content = ft.Column(content_controls, expand=True)

    page.run_task(backfill_missing_profiles)

    generation = (page.session.store.get(_GENERATION_KEY) or 0) + 1
    page.session.store.set(_GENERATION_KEY, generation)
    page.run_task(poll_status_loop, generation)

    return ft.View(
        route="/accounts",
        padding=0,
        horizontal_alignment=ft.CrossAxisAlignment.STRETCH,
        controls=[build_layout(page, content)],
    )
