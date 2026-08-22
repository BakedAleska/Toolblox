"""Helpers behind Developer Mode: a version/channel badge in the nav rail's
corner (see toolblox/ui/layout.py) plus a couple of tools in Settings ->
General -> Danger Zone, all of it automatic rather than a setting.

Developer Mode exists so widget and fork development doesn't need a
commit-and-push round trip to see a change working. It turns itself on
by detecting a source checkout (see is_dev_environment) rather than
needing a switch flipped or a path typed in by hand: run the app from
this repo and widgets/ and registry.json are read from the repo
directly; run a packaged build and none of this is present.
"""

import sys
from pathlib import Path
from typing import Optional

from toolblox.logs import LOG_FILE

REPO_ROOT = Path(__file__).resolve().parent.parent


def is_dev_environment() -> bool:
    """Whether the app is running from a source checkout, not a packaged build.

    A frozen build (see toolblox/startup.py, which uses the same
    sys.frozen check for its own purposes) sets sys.frozen; running via
    `python main.py` from an IDE or a repo checkout does not. This one
    check is what Developer Mode gates on everywhere - there's nothing
    to configure, and nothing here can accidentally ship turned on,
    since a packaged build is never running from source.
    """
    return not getattr(sys, "frozen", False)


def release_channel() -> str:
    """The build's release channel: "beta" or "canary".

    A packaged build is always "beta" - the curated, publicly
    advertised release with no Catalogue. A source checkout is always
    "canary" - there's no separate packaged Canary build.
    """
    return "canary" if is_dev_environment() else "beta"


def dev_widgets_dir() -> Optional[Path]:
    """This repo's widgets/ folder, if running from source, else None.

    Passed straight to toolblox.widgets.loader.discover_widgets() as
    its extra_dir, so editing a widget's source under widgets/ shows up
    without installing it into WIDGETS_DIR first.
    """
    if not is_dev_environment():
        return None
    candidate = REPO_ROOT / "widgets"
    return candidate if candidate.is_dir() else None


def dev_registry_path() -> Optional[Path]:
    """This repo's registry.json, if running from source, else None.

    Lets the Catalogue be exercised against the repo's own registry
    (including any local: true entries added for testing) instead of
    the one published on GitHub.
    """
    if not is_dev_environment():
        return None
    candidate = REPO_ROOT / "registry.json"
    return candidate if candidate.is_file() else None


def reload_current_view(page) -> None:
    """Force the view currently on screen to rebuild from scratch.

    Replays the page's own route-change handler against its current
    route, which is exactly what a real navigation does - and since
    toolblox.widgets.loader.discover_widgets() always reimports widget
    code fresh, this is what makes an edit to a widget's source show up
    immediately instead of waiting for the next real navigation.
    """
    if page.on_route_change is not None:
        page.on_route_change(page.route)


def tail_log(lines: int = 300) -> str:
    """The last `lines` lines of the app's log file.

    Lets Developer Mode show recent log activity in-app, without
    needing to go find <DATA_DIR>/logs/toolblox.log on disk.
    """
    if not LOG_FILE.exists():
        return "No log file yet."
    try:
        content = LOG_FILE.read_text(encoding="utf-8", errors="replace")
    except OSError as e:
        return f"Couldn't read the log file: {e}"
    return "\n".join(content.splitlines()[-lines:]) or "Log file is empty."
