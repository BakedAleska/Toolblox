"""Windows-only bypass for Roblox's singleton-instance check.

Runs the native helper (see native/multi_instance_helper/README.md for how
the bypass works) so a second account's Join can open its own Roblox
window instead of just activating whichever one is already running. Only
meaningful on Windows, since Roblox doesn't enforce the same single-instance
restriction on macOS.

Only ever targets processes that haven't already been cleared by an
earlier call in this run (tracked in `_cleared_pids`). An earlier version
re-closed every running RobloxPlayerBeta.exe process's singleton handle on
every single join, including ones that were already stable from a previous
join - repeatedly yanking a live handle out from under an already-running
instance for no benefit, which is suspected of contributing to reports of
closing one account cascading into the others closing too. This is a
mitigation, not a confirmed fix - see helper.c's top comment for why the
underlying fragility is believed to sit in Roblox's own client.
"""

import subprocess
import sys
from pathlib import Path

from toolblox.logs import get_logger
from toolblox.roblox.process_watch import running_pids

logger = get_logger(__name__)

_cleared_pids: set[int] = set()


def _helper_path() -> Path:
    """Where the helper binary lives, for a source checkout or a packaged build.

    From source, it's the repo's own native/multi_instance_helper/ folder.
    A packaged build has no such folder next to the executable - the
    Windows build (see release/build.py) bundles the helper as PyInstaller
    data under a "native" folder instead, which PyInstaller unpacks under
    sys._MEIPASS at runtime, whether the build is onefile or onedir.
    """
    if getattr(sys, "frozen", False):
        base = Path(getattr(sys, "_MEIPASS", Path(sys.executable).resolve().parent))
        return base / "native" / "multi_instance_helper.exe"
    return (
        Path(__file__).resolve().parent.parent.parent
        / "native"
        / "multi_instance_helper"
        / "multi_instance_helper.exe"
    )


HELPER_PATH = _helper_path()


def clear_singleton_instance() -> None:
    """Best-effort: close the Roblox singleton handle for any newly-seen instance.

    Does nothing on non-Windows platforms, if the helper binary hasn't been
    built, or if every currently running RobloxPlayerBeta.exe process has
    already been cleared by an earlier call. Never raises: a failed bypass
    just means Join behaves like it did before this feature existed, which
    is safe to fall back to.
    """
    if sys.platform != "win32":
        return
    if not HELPER_PATH.exists():
        logger.warning("Multi-instance helper not found at %s", HELPER_PATH)
        return

    current = running_pids()
    new_pids = current - _cleared_pids
    if not new_pids:
        _cleared_pids.intersection_update(current)
        return

    try:
        subprocess.run(
            [str(HELPER_PATH), *(str(pid) for pid in new_pids)],
            timeout=5,
            capture_output=True,
            check=False,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
    except (OSError, subprocess.TimeoutExpired) as e:
        logger.warning("Multi-instance helper failed: %s", e)

    _cleared_pids.intersection_update(current)
    _cleared_pids.update(new_pids)
