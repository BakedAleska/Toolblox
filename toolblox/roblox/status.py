"""Track each account's live status dot: grey (idle), red (crashed), or
green (in a place).

Status lives only in the page session, never on disk - it reflects live
state and should come back unknown (grey) on every app restart. Two
sources feed it:

- poll_presence() batches a Roblox presence lookup for every tracked
  account not currently being watched after a Join, called on a repeating
  timer from the Accounts screen while it's on top.
- watch_join() follows up one Join click, watching the local Roblox
  process to catch a launch that never starts (or dies before presence
  confirms it made it into a place) as a crash, without waiting for the
  next ambient presence poll.

Both write through _set_status rather than mutating page state from a
thread: the polling and process checks they depend on run in
asyncio.to_thread, and every page.session.store write happens back on the
calling coroutine after awaiting those, per this project's async rule.
"""

import asyncio
import time
from typing import Callable

import flet as ft

from toolblox.logs import get_logger
from toolblox.roblox.presence import IN_GAME, fetch_presence
from toolblox.roblox.process_watch import running_pids

logger = get_logger(__name__)

GREY = "grey"
RED = "red"
GREEN = "green"

_STATUS_KEY = "_account_status"
_WATCHING_KEY = "_account_watching"

LAUNCH_GRACE_SECONDS = 15
"""How long to wait, after a Join, for a new Roblox process to appear
before treating the launch itself as a crash."""

CONNECT_TIMEOUT_SECONDS = 90
"""How long to keep watching a launched process for presence to confirm
it reached a place, before giving up - the process is still alive at
that point, just unconfirmed, so status is left grey rather than red."""

WATCH_POLL_SECONDS = 5
"""How often watch_join checks presence and the watched process while
actively following up a Join."""

AMBIENT_POLL_SECONDS = 20
"""How often the Accounts screen re-polls presence for every account not
mid-watch, while it's the visible view."""


def get_status(page: ft.Page, user_id: int) -> str:
    return (page.session.store.get(_STATUS_KEY) or {}).get(user_id, GREY)


def _set_status(page: ft.Page, user_id: int, status: str) -> None:
    statuses = dict(page.session.store.get(_STATUS_KEY) or {})
    statuses[user_id] = status
    page.session.store.set(_STATUS_KEY, statuses)


def _is_watching(page: ft.Page, user_id: int) -> bool:
    return user_id in (page.session.store.get(_WATCHING_KEY) or set())


def _set_watching(page: ft.Page, user_id: int, watching: bool) -> None:
    ids = set(page.session.store.get(_WATCHING_KEY) or set())
    if watching:
        ids.add(user_id)
    else:
        ids.discard(user_id)
    page.session.store.set(_WATCHING_KEY, ids)


async def watch_join(
    page: ft.Page,
    user_id: int,
    before_pids: set[int],
    cookie: str,
    on_change: Callable[[], None],
) -> None:
    """Resolve one account's status after a Join click.

    before_pids is a snapshot of running Roblox processes taken right
    before the Join was launched, so a newly appeared pid can be told
    apart from one that was already running for another account. Calls
    on_change() after every status change so the caller can refresh its
    view; on_change is never called if nothing changed.
    """
    _set_watching(page, user_id, True)
    try:
        watched_pids: set[int] = set()
        deadline = time.monotonic() + LAUNCH_GRACE_SECONDS
        while time.monotonic() < deadline:
            pids = await asyncio.to_thread(running_pids)
            new_pids = pids - before_pids
            if new_pids:
                watched_pids = new_pids
                break
            await asyncio.sleep(1)

        if not watched_pids:
            _set_status(page, user_id, RED)
            on_change()
            return

        deadline = time.monotonic() + CONNECT_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            presence, pids = await asyncio.gather(
                asyncio.to_thread(fetch_presence, cookie, [user_id]),
                asyncio.to_thread(running_pids),
            )
            if presence.get(user_id) == IN_GAME:
                _set_status(page, user_id, GREEN)
                on_change()
                return
            if not (watched_pids & pids):
                _set_status(page, user_id, RED)
                on_change()
                return
            await asyncio.sleep(WATCH_POLL_SECONDS)
    finally:
        _set_watching(page, user_id, False)


async def poll_presence(
    page: ft.Page,
    accounts: list[dict],
    on_change: Callable[[], None],
    on_left: Callable[[dict], None] | None = None,
) -> None:
    """Refresh status for every account with a saved session that isn't
    currently being watched after a Join, from one batched presence
    request.

    Calls on_left(account), if given, for every account caught going from
    GREEN to GREY in this poll - i.e. it was in a place and now isn't,
    which is the ambient signal for "left the place" (as opposed to a
    crash, which watch_join catches separately). Used to drive auto-rejoin.
    """
    watchable = [
        a for a in accounts if a.get("security_cookie") and not _is_watching(page, a["id"])
    ]
    if not watchable:
        return

    cookie = watchable[0]["security_cookie"]
    presence = await asyncio.to_thread(fetch_presence, cookie, [a["id"] for a in watchable])

    changed = False
    for account in watchable:
        status = GREEN if presence.get(account["id"]) == IN_GAME else GREY
        previous = get_status(page, account["id"])
        if previous != status:
            _set_status(page, account["id"], status)
            changed = True
            if on_left is not None and previous == GREEN and status == GREY:
                on_left(account)

    if changed:
        on_change()
