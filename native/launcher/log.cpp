#include "log.h"

#include <windows.h>
#include <shlobj.h>

#include <cstdio>

static std::wstring g_logPath;

static std::wstring LogDir() {
    PWSTR localAppData = nullptr;
    std::wstring dir;
    if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &localAppData))) {
        dir = localAppData;
        CoTaskMemFree(localAppData);
    }
    if (dir.empty()) {
        return L"";
    }
    return dir + L"\\Toolblox\\logs";
}

void LogInit() {
    std::wstring dir = LogDir();
    if (dir.empty()) {
        return;
    }
    SHCreateDirectoryExW(nullptr, dir.c_str(), nullptr);
    g_logPath = dir + L"\\launcher.log";
}

static void AppendLine(const std::wstring &line) {
    if (g_logPath.empty()) {
        return;
    }
    FILE *f = nullptr;
    if (_wfopen_s(&f, g_logPath.c_str(), L"a, ccs=UTF-8") != 0 || !f) {
        return;
    }
    SYSTEMTIME st;
    GetLocalTime(&st);
    fwprintf(
        f, L"%04d-%02d-%02d %02d:%02d:%02d %s\n", st.wYear, st.wMonth, st.wDay, st.wHour,
        st.wMinute, st.wSecond, line.c_str());
    fclose(f);
}

void LogLine(const std::wstring &line) {
    AppendLine(line);
}

void LogLineA(const std::string &line) {
    AppendLine(std::wstring(line.begin(), line.end()));
}
