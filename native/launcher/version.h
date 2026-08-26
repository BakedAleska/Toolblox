/*
 * Version string handling, ported from toolblox/updater.py's _version_key
 * and is_newer so both sides order releases the same way ("1.0.0" outranks
 * "1.0.0-beta").
 */
#pragma once

#include <string>

std::string ReadVersionFile(const std::wstring &installDir);

bool IsNewerVersion(const std::string &candidate, const std::string &current);
