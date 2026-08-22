# Rogue Lineage

Tracks Rogue Lineage characters: username, class, race, freeform notes, and a
repeatable list of items, each with an optional quantity.

A character's username is always typed in by hand. If it's similar to one of
Toolblox's own tracked accounts, press Tab while the field is focused to
autofill the full match. Once it's an exact match, the character starts
syncing with that account automatically: its username and avatar follow the
account from then on, and it falls back to standalone again if the account
is later removed from Toolblox.

Class, race, and item choices come from `reference.json` in this folder, a
starting list assembled from the Rogue Lineage Fandom wiki, not a full
scrape. It's a plain, hand-editable JSON file - extend it any time by adding
entries to its `classes`, `races`, or `items` arrays. Every dropdown built
from that list also offers "Other...", so an incomplete list never blocks
entering real data.

## Mana bar overlay

Pins a rectangle, with shaded highlight bands inside it, directly on top of
an in-game resource bar - by default only while Roblox is open. Unlike the
Image Overlay widget, which pins a picture, this draws shapes at whatever
area and highlights are configured, so it's never off-size or off-position
the way a picture can be when the real bar doesn't match its exact
dimensions.

1. Press "Pick area on screen...", then click and drag over the real bar in
   the game. Press Enter to confirm, or type the X/Y/Width/Height fields
   directly.
2. The fill direction isn't a separate choice - it's guessed from the
   area's own shape. A taller-than-wide area is treated as a vertical bar
   (0% at the bottom, 100% at the top); a wider-than-tall one as horizontal
   (0% at the left, 100% at the right). The screen shows which one your
   current area was read as.
3. Under "Style", pick the border color and width of the rectangle itself -
   defaults to a cyan, 2px outline, but either can be changed to whatever
   stands out best against your own game's colors.
4. Add highlights as percent ranges along that direction (e.g. 0% to 30%)
   with a color and a transparency from 0 to 1 (0 is fully opaque, 1 is
   fully see-through - defaults to 0.5), to mark thresholds like ability
   costs. Each shows as a translucent band inside the rectangle, with real
   per-band alpha rather than a dithered pattern. A highlight can also have
   a name, shown next to it in this list so a crowded set of ranges stays
   readable - it's never drawn on the overlay itself. Press the pencil icon
   on an existing highlight to load it back into the fields above and edit
   any of these values; the Add button becomes a checkmark while editing.
5. Press On to arm it. It shows only while Roblox is the active
   (foreground) window - not just open in the background - and hides the
   moment you alt-tab away from it, checked about once a second; press Off
   to disarm it entirely.

This is the "dumb" version: the area and highlights are placed by hand.
Finding the bar itself via image recognition, instead of picking the area
manually, is a possible future addition, not implemented yet.

Click-through (letting clicks pass to whatever's underneath, Windows only)
is under Settings, not on this screen - see Image Overlay's README for why.

## Keybinds

Remaps a physical key to one of Rogue Lineage's own hotbar keys - 1, 2, 3, 4,
5, 6, 7, 8, 9, 0, -, = - system-wide, not just while Toolblox has focus.

1. Press "Add keybind", then press the key you want to press in-game (any
   key, letter, number, or function key).
2. Pick which of the 1-9, 0, -, = keys it should send instead, from the
   dropdown next to it.
3. It's active automatically as soon as it's added - there's no separate
   on/off switch, only "Only while Roblox is the active window" (on by
   default), which pauses it the moment you alt-tab away.

Windows only - this needs a low-level keyboard hook to swallow the original
key and inject the replacement, which the `keyboard` library this runs on
doesn't support on macOS.

## Installing

Running Toolblox from source (`python main.py` in this repo) picks this
widget up automatically - no install step needed. To use it in a packaged
build, copy this `rogue_lineage` folder into the widgets folder shown in
Settings -> Widgets.

## Data

Characters are stored at `<DATA_DIR>/rogue_lineage.json`, independent of
`accounts.json` - deleting or editing this file only affects the Rogue
Lineage roster, not tracked accounts.
