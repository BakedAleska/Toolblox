"""Check GitHub Releases for a newer build.

Windows only. Actually applying an update is no longer this module's job:
native/launcher (Toolblox.exe, the app's own entry point - see that
folder's README) checks for and applies updates itself, automatically,
every time it starts, before ToolbloxApp.exe ever runs. This module now
only powers the informational "Check for Updates" button in Settings, so
a curious user can see whether a newer version exists without waiting
for the next restart - it just reports what it finds, since the actual
download/verify/apply work happens on the native side.
"""

import re
import sys
from dataclasses import dataclass
from typing import Optional

import httpx

from toolblox.logs import get_logger
from toolblox.version import APP_VERSION

logger = get_logger(__name__)

GITHUB_RELEASES_API = "https://api.github.com/repos/BakedAleska/Toolblox/releases/latest"
WINDOWS_ZIP_ASSET_PATTERN = re.compile(r"^Toolblox-.*-windows\.zip$")


class UpdateError(Exception):
    """Raised when checking for or downloading an update fails."""


@dataclass
class UpdateInfo:
    """One available update, as read from GitHub's latest release."""

    version: str
    download_url: str
    release_notes: str


def _version_key(raw: str) -> tuple:
    """An ordering key for versions like "0.1.0-beta", "1.2.0", or "v1.0.0".

    Splits the dot-separated numeric part into ints and treats a
    "-suffix" (e.g. "beta", "rc1") as older than the same numbers with no
    suffix, so "1.0.0" outranks "1.0.0-beta". Not a full semver parser,
    but enough to order this project's own release tags.
    """
    raw = raw.lstrip("vV")
    numeric, _, suffix = raw.partition("-")
    parts = tuple(int(p) if p.isdigit() else 0 for p in numeric.split("."))
    return (parts, 0 if suffix else 1, suffix)


def is_newer(candidate: str, current: str) -> bool:
    """Whether `candidate` outranks `current` under _version_key()."""
    return _version_key(candidate) > _version_key(current)


def check_for_update() -> Optional[UpdateInfo]:
    """Check GitHub's latest release for a newer Windows build.

    Blocking. Call via asyncio.to_thread. Returns None on Windows if
    already up to date, and unconditionally on any other platform since
    there's no in-place updater for it there yet. Raises UpdateError
    with a user-facing message if the release can't be read.
    """
    if sys.platform != "win32":
        return None

    try:
        response = httpx.get(
            GITHUB_RELEASES_API,
            timeout=15,
            headers={"Accept": "application/vnd.github+json"},
        )
        response.raise_for_status()
        data = response.json()
    except (httpx.HTTPError, ValueError) as e:
        logger.warning("Couldn't check for updates: %s", e)
        raise UpdateError(f"Couldn't reach GitHub to check for updates. ({e})") from e

    tag = str(data.get("tag_name") or "").strip()
    if not tag:
        raise UpdateError("The latest release on GitHub has no version tag.")

    if not is_newer(tag, APP_VERSION):
        return None

    download_url = None
    for asset in data.get("assets") or []:
        name = asset.get("name") or ""
        if WINDOWS_ZIP_ASSET_PATTERN.match(name):
            download_url = asset.get("browser_download_url")

    if not download_url:
        raise UpdateError(f"Version {tag} is out, but its release has no Windows build attached.")

    return UpdateInfo(
        version=tag.lstrip("vV"),
        download_url=download_url,
        release_notes=str(data.get("body") or ""),
    )
