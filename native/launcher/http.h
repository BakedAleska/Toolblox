/*
 * Minimal HTTPS client on top of WinHTTP - just what the launcher needs:
 * a small GET-to-string (the GitHub releases API response, a companion
 * .sha256 text file) and a streaming GET-to-file (the release build zip,
 * which can be tens of megabytes). No third-party HTTP library, since
 * WinHTTP with TLS ships as part of Windows itself.
 */
#pragma once

#include <string>

bool HttpGetString(const std::wstring &url, std::string &outBody, std::wstring &error);

bool HttpDownloadToFile(
    const std::wstring &url, const std::wstring &destPath, std::wstring &error);
