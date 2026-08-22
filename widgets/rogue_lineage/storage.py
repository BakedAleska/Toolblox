"""Persistence for the Rogue Lineage character roster.

Characters are stored as a JSON list at ``<DATA_DIR>/rogue_lineage.json``,
a standalone store owned by this widget - not a namespace inside
accounts.json, since a roster entry doesn't have to correspond to a
tracked Toolblox account. A character can instead be linked to one, via
its ``account_id`` field, and kept in sync with it (see
``sync_with_accounts``).
"""

import json
import time
import uuid

from toolblox.config import DATA_DIR
from toolblox.logs import get_logger

logger = get_logger(__name__)

ROSTER_FILE = DATA_DIR / "rogue_lineage.json"


def load_roster() -> list[dict]:
    """Read the character roster from disk.

    Returns an empty list if the file is missing or can't be parsed. A
    bad file shouldn't crash the app.
    """
    if not ROSTER_FILE.exists():
        return []
    try:
        return json.loads(ROSTER_FILE.read_text())
    except (json.JSONDecodeError, OSError) as e:
        logger.error("Couldn't read %s, falling back to empty: %s", ROSTER_FILE, e)
        return []


def save_roster(characters: list[dict]) -> None:
    """Write the character roster to disk, replacing whatever was there."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    ROSTER_FILE.write_text(json.dumps(characters, indent=2))


def new_character(
    *,
    account_id: int | None,
    username: str,
    display_name: str | None,
    avatar_url: str | None,
    class_name: str,
    race: str,
    notes: str,
    items: list[dict],
) -> dict:
    """Build a fresh character dict with a new id and timestamp."""
    return {
        "char_id": uuid.uuid4().hex,
        "account_id": account_id,
        "username": username,
        "display_name": display_name,
        "avatar_url": avatar_url,
        "class_name": class_name,
        "race": race,
        "notes": notes,
        "items": items,
        "added_at": time.time(),
    }


def sync_with_accounts(
    characters: list[dict], accounts: list[dict]
) -> tuple[list[dict], bool]:
    """Reconcile the roster against the current tracked accounts list.

    A character linked to an account (``account_id`` set) has its
    username/display_name/avatar_url refreshed from that account. If the
    account no longer exists, the character is unlinked (``account_id``
    cleared) but kept in the roster with its last-known synced fields, now
    editable as a standalone entry.

    A character not yet linked (``account_id`` is None) is linked
    automatically the moment a tracked account's username
    case-insensitively matches its own - this is what lets a character
    entered by hand start syncing the moment its account gets added to
    Toolblox, without the user having to re-link it.

    Returns the (possibly mutated) list and whether anything changed, so
    the caller only needs to save and re-render when it did.
    """
    accounts_by_id = {a["id"]: a for a in accounts}
    changed = False

    for character in characters:
        account_id = character.get("account_id")

        if account_id is not None:
            account = accounts_by_id.get(account_id)
            if account is None:
                character["account_id"] = None
                changed = True
                continue
            for field, key in (
                ("username", "name"),
                ("display_name", "display_name"),
                ("avatar_url", "avatar_url"),
            ):
                value = account.get(key)
                if character.get(field) != value:
                    character[field] = value
                    changed = True
            continue

        username = (character.get("username") or "").strip().lower()
        if not username:
            continue
        match = next(
            (a for a in accounts if a.get("name", "").strip().lower() == username), None
        )
        if match is not None:
            character["account_id"] = match["id"]
            character["username"] = match["name"]
            character["display_name"] = match.get("display_name")
            character["avatar_url"] = match.get("avatar_url")
            changed = True

    return characters, changed


def export_roster(characters: list[dict]) -> str:
    """Serialize the roster into portable JSON for exporting.

    Drops char_id and account_id, since those are local identifiers that
    mean nothing on the machine importing the file. A freshly imported
    character starts unlinked and syncs to a matching account by username
    on its own, the same way a hand-typed character does (see
    sync_with_accounts).
    """
    portable = [
        {
            "username": character.get("username", ""),
            "class_name": character.get("class_name", ""),
            "race": character.get("race", ""),
            "notes": character.get("notes", ""),
            "items": character.get("items", []),
        }
        for character in characters
    ]
    return json.dumps(portable, indent=2)


def import_roster(text: str) -> list[dict]:
    """Parse exported JSON text into fresh character dicts, each with a
    new char_id and no account link.

    Raises ValueError, with a message safe to show the user directly, if
    text isn't a valid roster export.
    """
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        raise ValueError("That file isn't valid JSON.") from e
    if not isinstance(data, list):
        raise ValueError("That file doesn't contain a character list.")

    characters = []
    for entry in data:
        if not isinstance(entry, dict):
            continue
        username = (entry.get("username") or "").strip()
        if not username:
            continue
        characters.append(
            new_character(
                account_id=None,
                username=username,
                display_name=None,
                avatar_url=None,
                class_name=entry.get("class_name", ""),
                race=entry.get("race", ""),
                notes=entry.get("notes", ""),
                items=entry.get("items", []),
            )
        )
    return characters
