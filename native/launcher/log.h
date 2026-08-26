/*
 * Tiny plain-text logger for the launcher, writing to the same DATA_DIR
 * Toolblox's Python side uses (toolblox/config.py: %LOCALAPPDATA%\Toolblox),
 * under logs\launcher.log. Not rotated - this process is small and short-
 * lived, so its log stays small too; unlike toolblox/logs.py's rotating
 * file, there's no risk of it growing unbounded over a long-running app
 * session.
 */
#pragma once

#include <string>

void LogInit();
void LogLine(const std::wstring &line);
void LogLineA(const std::string &line);
