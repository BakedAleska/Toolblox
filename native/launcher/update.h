/*
 * Applies a downloaded, already sha256-verified update zip to a live
 * install directory. Ported from toolblox/updater_helper.py's
 * apply_update(), now folded into the launcher itself: since Toolblox.exe
 * is a thin native front door rather than the app process, it never needs
 * to replace its own running image the way the old Python updater did, so
 * this can run in the same process that just downloaded the update - no
 * separate hand-off exe required.
 */
#pragma once

#include <string>

/* Extracts `zipPath` into a fresh staging directory next to `installDir`,
 * then swaps it in with two directory renames, so a failed/interrupted
 * extraction never corrupts a working install. Leaves `installDir`
 * untouched on failure. */
bool ApplyUpdate(const std::wstring &installDir, const std::wstring &zipPath, std::wstring &error);

/* Direct extract straight into `destDir` with no staging/swap - what the
 * NSIS installer uses for a brand-new install, where there's no existing
 * install to protect. */
bool ExtractFreshInstall(
    const std::wstring &zipPath, const std::wstring &destDir, std::wstring &error);
