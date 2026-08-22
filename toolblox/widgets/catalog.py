"""Fetch and cache the Catalogue: the list of widgets available to install."""

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import flet as ft
import httpx

from toolblox.config import WIDGET_REGISTRY_URL
from toolblox.logs import get_logger

logger = get_logger(__name__)

_REGISTRY_CACHE_KEY = "_widget_catalog_cache"


@dataclass
class WidgetSource:
    """Where one Catalogue entry's code lives, pinned to an exact commit.

    local is a Developer Mode escape hatch: when true, path is a local
    directory on disk (a working copy, uncommitted) that install_widget()
    copies from directly instead of downloading a GitHub archive - owner/
    repo/ref are unused and left empty. See toolblox.devtools.dev_registry_path.
    """

    owner: str
    repo: str
    ref: str
    path: str
    local: bool = False


@dataclass
class CatalogEntry:
    """One widget listed in the Catalogue, as read from registry.json."""

    id: str
    name: str
    description: str
    author: str
    version: str
    icon: Optional[str]
    logo: Optional[str]
    logo_size: float
    source: WidgetSource
    sha256: str
    homepage: str


def fetch_registry(local_path: Optional[str] = None) -> tuple[list[CatalogEntry], Optional[str]]:
    """Fetch and parse the widget Catalogue.

    Never raises. Returns ([], error_message) on any failure, following
    the same (list, errors) convention as
    toolblox.widgets.loader.discover_widgets(). A malformed entry is skipped
    rather than failing the whole fetch.

    local_path, when given, is read as a local registry.json instead of
    fetching WIDGET_REGISTRY_URL - Developer Mode's way of testing
    registry entries (including local: true ones) without pushing
    anything. See toolblox.devtools.dev_registry_path.
    """
    if local_path:
        try:
            data = json.loads(Path(local_path).read_text())
        except (OSError, ValueError) as e:
            logger.warning("Couldn't read local registry at %s: %s", local_path, e)
            return [], str(e)
    else:
        try:
            response = httpx.get(WIDGET_REGISTRY_URL, timeout=15)
            response.raise_for_status()
            data = response.json()
        except (httpx.HTTPError, ValueError) as e:
            logger.warning("Couldn't fetch widget registry from %s: %s", WIDGET_REGISTRY_URL, e)
            return [], str(e)

    entries: list[CatalogEntry] = []
    for raw in data.get("widgets", []):
        try:
            source_raw = raw["source"]
            entries.append(
                CatalogEntry(
                    id=raw["id"],
                    name=raw["name"],
                    description=raw.get("description", ""),
                    author=raw.get("author", ""),
                    version=raw.get("version", ""),
                    icon=raw.get("icon"),
                    logo=raw.get("logo"),
                    logo_size=float(raw.get("logo_size", 1.0)),
                    source=WidgetSource(
                        owner=source_raw.get("owner", ""),
                        repo=source_raw.get("repo", ""),
                        ref=source_raw.get("ref", ""),
                        path=source_raw["path"],
                        local=bool(source_raw.get("local", False)),
                    ),
                    sha256=raw.get("sha256", ""),
                    homepage=raw.get("homepage", ""),
                )
            )
        except (KeyError, TypeError) as e:
            logger.warning("Skipped malformed registry entry: %s", e)
            continue

    return entries, None


def get_cached_registry(page: ft.Page) -> list[CatalogEntry]:
    """The Catalogue entries cached for this page, or an empty list."""
    return page.session.store.get(_REGISTRY_CACHE_KEY) or []


def set_cached_registry(page: ft.Page, entries: list[CatalogEntry]) -> None:
    """Cache the Catalogue entries for this page."""
    page.session.store.set(_REGISTRY_CACHE_KEY, entries)
