/* SHA-256 of a file, via Windows' own CNG (bcrypt.h) - no third-party
 * crypto library needed. */
#pragma once

#include <string>

bool Sha256File(const std::wstring &path, std::string &outHexLower);
