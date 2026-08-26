/*
 * Extracts a .zip's contents into an existing destination folder, using
 * the Shell.Application COM automation object rather than a bundled zip
 * library or NSIS plugin - Windows Explorer's own "extract all" goes
 * through this same object, so it's supported on every target Windows
 * version with no extra dependency to ship or a plugin DLL to vendor.
 */
#pragma once

#include <string>

bool ExtractZip(const std::wstring &zipPath, const std::wstring &destDir, std::wstring &error);
