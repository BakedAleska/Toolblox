/*
 * Toolblox.exe - the app's native entry point.
 *
 * This is not the Flet/Python app itself (that's ToolbloxApp.exe, installed
 * alongside it - see release/build.py). It's a small, deliberately stable
 * launcher: on every start it shows a brief loading window, checks GitHub's
 * latest release against version.txt (written into the install folder at
 * package time), and if a newer build exists, downloads and applies it in
 * place - all before ToolbloxApp.exe ever runs - then launches it. If the
 * check fails for any reason (offline, GitHub unreachable, no matching
 * asset), it fails open: log it and launch the existing app rather than
 * blocking startup.
 *
 * A second, headless mode (--extract <zip> <sha256> <destdir>) reuses the
 * same verify+extract code for the NSIS installer's own first-install step
 * (installer/Toolblox.nsi) - see update.h's ExtractFreshInstall.
 *
 * The update-apply path (see update.h) runs in this same process rather
 * than a separate hand-off exe: unlike the old Python updater
 * (toolblox/updater_helper.py), this process is never the thing being
 * replaced - it only ever replaces files *inside* the install directory,
 * never its own exe - so there's no "can't overwrite my own running image"
 * problem to work around.
 */

#include <windows.h>
#include <commctrl.h>
#include <shellapi.h>
#include <shlwapi.h>

#include <string>
#include <vector>

#include "extract.h"
#include "http.h"
#include "json.h"
#include "log.h"
#include "resource.h"
#include "sha256.h"
#include "update.h"
#include "version.h"

#pragma comment(lib, "comctl32.lib")
#pragma comment(lib, "shlwapi.lib")

namespace {

const wchar_t *kGitHubLatestReleaseUrl =
    L"https://api.github.com/repos/BakedAleska/Toolblox/releases/latest";
const wchar_t *kAppExeName = L"ToolbloxApp.exe";
const wchar_t *kWindowClass = L"ToolbloxLauncherSplash";

const UINT WM_APP_STATUS = WM_APP + 1;
const UINT WM_APP_DONE = WM_APP + 2;

enum Status {
    kStatusChecking = 0,
    kStatusDownloading,
    kStatusInstalling,
    kStatusStarting,
};

const wchar_t *StatusText(Status status) {
    switch (status) {
        case kStatusChecking:
            return L"Checking for updates...";
        case kStatusDownloading:
            return L"Downloading update...";
        case kStatusInstalling:
            return L"Installing update...";
        case kStatusStarting:
        default:
            return L"Starting Toolblox...";
    }
}

HWND g_statusLabel = nullptr;
HWND g_progressBar = nullptr;

std::wstring ToWide(const std::string &s) {
    return std::wstring(s.begin(), s.end());
}

bool StartsWith(const std::string &s, const char *prefix) {
    size_t len = strlen(prefix);
    return s.size() >= len && s.compare(0, len, prefix) == 0;
}

bool EndsWith(const std::string &s, const char *suffix) {
    size_t len = strlen(suffix);
    return s.size() >= len && s.compare(s.size() - len, len, suffix) == 0;
}

bool MatchesWindowsZipName(const std::string &name) {
    return StartsWith(name, "Toolblox-") && EndsWith(name, "-windows.zip");
}

/* First 64-hex-char whitespace-delimited token in `text`, lowercased.
 * Mirrors toolblox/updater.py's _fetch_expected_sha256 parsing of the
 * plain-text `<zip>.sha256` companion file release.yml publishes. */
std::string ParseHexDigest(const std::string &text) {
    size_t i = 0;
    while (i < text.size() && isspace((unsigned char)text[i])) {
        i++;
    }
    size_t start = i;
    while (i < text.size() && !isspace((unsigned char)text[i])) {
        i++;
    }
    std::string token = text.substr(start, i - start);
    if (token.size() != 64) {
        return "";
    }
    for (char &c : token) {
        if (!isxdigit((unsigned char)c)) {
            return "";
        }
        c = (char)tolower((unsigned char)c);
    }
    return token;
}

/* Shell.Application's NameSpace() call (see extract.cpp) needs a fully
 * qualified path - a relative one silently fails to resolve to a folder.
 * NSIS always passes absolute paths, but this guards the CLI path too. */
std::wstring AbsolutePath(const std::wstring &path) {
    wchar_t buf[MAX_PATH];
    DWORD len = GetFullPathNameW(path.c_str(), MAX_PATH, buf, nullptr);
    if (len == 0 || len >= MAX_PATH) {
        return path;
    }
    return buf;
}

std::wstring GetInstallDir() {
    wchar_t path[MAX_PATH];
    GetModuleFileNameW(nullptr, path, MAX_PATH);
    PathRemoveFileSpecW(path);
    return path;
}

bool LaunchApp(const std::wstring &installDir, std::wstring &error) {
    std::wstring exePath = installDir + L"\\" + kAppExeName;
    if (!PathFileExistsW(exePath.c_str())) {
        error = L"This install is missing " + std::wstring(kAppExeName) +
                L". Reinstall Toolblox to fix it.";
        return false;
    }

    STARTUPINFOW si = {};
    si.cb = sizeof(si);
    PROCESS_INFORMATION pi = {};
    std::wstring cmd = L"\"" + exePath + L"\"";
    BOOL ok = CreateProcessW(
        exePath.c_str(), &cmd[0], nullptr, nullptr, FALSE, 0, nullptr, installDir.c_str(), &si,
        &pi);
    if (!ok) {
        error = L"Couldn't start " + std::wstring(kAppExeName);
        return false;
    }
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
    return true;
}

/* Checks GitHub, downloads and applies an update if one is available.
 * Never treated as fatal by the caller - any failure here just means the
 * existing install gets launched as-is. `hwnd` is used only to post
 * status updates to the splash window (nullptr in headless callers, which
 * there are none of on this path). */
void CheckAndApplyUpdate(HWND hwnd, const std::wstring &installDir) {
    if (hwnd) {
        PostMessageW(hwnd, WM_APP_STATUS, kStatusChecking, 0);
    }

    std::string currentVersion = ReadVersionFile(installDir);
    if (currentVersion.empty()) {
        currentVersion = "0.0.0";
    }

    std::string body;
    std::wstring error;
    if (!HttpGetString(kGitHubLatestReleaseUrl, body, error)) {
        LogLine(L"Update check failed: " + error);
        return;
    }

    std::string tag = JsonFindString(body, "tag_name");
    if (tag.empty()) {
        LogLine(L"Update check: release had no tag_name");
        return;
    }
    if (!IsNewerVersion(tag, currentVersion)) {
        LogLineA("Up to date (" + currentVersion + ", latest is " + tag + ")");
        return;
    }

    std::string downloadUrl, sha256Url;
    for (const std::string &asset : JsonFindArrayObjects(body, "assets")) {
        std::string name = JsonFindString(asset, "name");
        if (EndsWith(name, ".sha256")) {
            std::string baseName = name.substr(0, name.size() - 7);
            if (MatchesWindowsZipName(baseName)) {
                sha256Url = JsonFindString(asset, "browser_download_url");
            }
        } else if (MatchesWindowsZipName(name)) {
            downloadUrl = JsonFindString(asset, "browser_download_url");
        }
    }
    if (downloadUrl.empty() || sha256Url.empty()) {
        LogLineA("Update check: release " + tag + " has no usable Windows build asset");
        return;
    }

    if (hwnd) {
        PostMessageW(hwnd, WM_APP_STATUS, kStatusDownloading, 0);
    }

    wchar_t tempDir[MAX_PATH];
    GetTempPathW(MAX_PATH, tempDir);
    std::wstring zipPath = std::wstring(tempDir) + L"Toolblox-update.zip";

    if (!HttpDownloadToFile(ToWide(downloadUrl), zipPath, error)) {
        LogLine(L"Update download failed: " + error);
        return;
    }

    std::string shaBody;
    if (!HttpGetString(ToWide(sha256Url), shaBody, error)) {
        LogLine(L"Couldn't fetch update checksum: " + error);
        DeleteFileW(zipPath.c_str());
        return;
    }
    std::string expectedDigest = ParseHexDigest(shaBody);
    if (expectedDigest.empty()) {
        LogLine(L"Update checksum file looked malformed");
        DeleteFileW(zipPath.c_str());
        return;
    }

    if (hwnd) {
        PostMessageW(hwnd, WM_APP_STATUS, kStatusInstalling, 0);
    }

    std::string actualDigest;
    if (!Sha256File(zipPath, actualDigest) || actualDigest != expectedDigest) {
        LogLineA("Update checksum mismatch for " + tag + " - refusing to apply it");
        DeleteFileW(zipPath.c_str());
        return;
    }

    if (!ApplyUpdate(installDir, zipPath, error)) {
        LogLine(L"Couldn't apply update: " + error);
        DeleteFileW(zipPath.c_str());
        return;
    }

    DeleteFileW(zipPath.c_str());
    LogLineA("Updated to " + tag);
}

DWORD WINAPI WorkerThread(LPVOID param) {
    HWND hwnd = (HWND)param;
    std::wstring installDir = GetInstallDir();

    CheckAndApplyUpdate(hwnd, installDir);

    PostMessageW(hwnd, WM_APP_STATUS, kStatusStarting, 0);

    std::wstring error;
    bool launched = LaunchApp(installDir, error);
    if (!launched) {
        LogLine(L"Fatal: " + error);
    }
    PostMessageW(hwnd, WM_APP_DONE, launched ? 0 : 1, (LPARAM)new std::wstring(error));
    return 0;
}

LRESULT CALLBACK SplashWndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    switch (msg) {
        case WM_CREATE: {
            RECT rc;
            GetClientRect(hwnd, &rc);
            g_statusLabel = CreateWindowExW(
                0, L"STATIC", StatusText(kStatusChecking), WS_CHILD | WS_VISIBLE | SS_CENTER,
                16, 20, rc.right - 32, 24, hwnd, nullptr, GetModuleHandleW(nullptr), nullptr);
            g_progressBar = CreateWindowExW(
                0, PROGRESS_CLASSW, nullptr, WS_CHILD | WS_VISIBLE | PBS_MARQUEE, 16, 56,
                rc.right - 32, 12, hwnd, nullptr, GetModuleHandleW(nullptr), nullptr);
            SendMessageW(g_progressBar, PBM_SETMARQUEE, TRUE, 30);
            return 0;
        }
        case WM_APP_STATUS: {
            SetWindowTextW(g_statusLabel, StatusText((Status)wParam));
            return 0;
        }
        case WM_APP_DONE: {
            std::wstring *error = (std::wstring *)lParam;
            if (wParam != 0 && error && !error->empty()) {
                MessageBoxW(hwnd, error->c_str(), L"Toolblox", MB_OK | MB_ICONERROR);
            }
            delete error;
            DestroyWindow(hwnd);
            return 0;
        }
        case WM_DESTROY:
            PostQuitMessage(0);
            return 0;
        default:
            return DefWindowProcW(hwnd, msg, wParam, lParam);
    }
}

HWND CreateSplashWindow(HINSTANCE instance) {
    WNDCLASSW wc = {};
    wc.lpfnWndProc = SplashWndProc;
    wc.hInstance = instance;
    wc.lpszClassName = kWindowClass;
    wc.hbrBackground = (HBRUSH)(COLOR_WINDOW + 1);
    wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    wc.hIcon = LoadIconW(instance, MAKEINTRESOURCEW(IDI_APPICON));
    RegisterClassW(&wc);

    const int width = 320;
    const int height = 110;
    int screenWidth = GetSystemMetrics(SM_CXSCREEN);
    int screenHeight = GetSystemMetrics(SM_CYSCREEN);

    HWND hwnd = CreateWindowExW(
        WS_EX_TOOLWINDOW | WS_EX_TOPMOST, kWindowClass, L"Toolblox",
        WS_POPUP | WS_BORDER, (screenWidth - width) / 2, (screenHeight - height) / 2, width,
        height, nullptr, nullptr, instance, nullptr);
    return hwnd;
}

int RunNormalMode(HINSTANCE instance) {
    LogInit();
    INITCOMMONCONTROLSEX icc = {sizeof(icc), ICC_PROGRESS_CLASS};
    InitCommonControlsEx(&icc);

    HWND hwnd = CreateSplashWindow(instance);
    ShowWindow(hwnd, SW_SHOW);
    UpdateWindow(hwnd);

    CreateThread(nullptr, 0, WorkerThread, hwnd, 0, nullptr);

    MSG msg;
    while (GetMessageW(&msg, nullptr, 0, 0)) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
    return 0;
}

int RunExtractMode(const std::vector<std::wstring> &args) {
    LogInit();
    if (args.size() < 5) {
        LogLine(L"--extract needs <zip> <sha256> <destdir>");
        return 1;
    }
    std::wstring zipPath = AbsolutePath(args[2]);
    std::string expectedDigest;
    for (wchar_t c : args[3]) {
        expectedDigest.push_back((char)towlower(c));
    }
    std::wstring destDir = AbsolutePath(args[4]);

    std::string actualDigest;
    if (!Sha256File(zipPath, actualDigest) || actualDigest != expectedDigest) {
        LogLine(L"--extract: checksum mismatch for " + zipPath);
        return 1;
    }

    std::wstring error;
    if (!ExtractFreshInstall(zipPath, destDir, error)) {
        LogLine(L"--extract failed: " + error);
        return 1;
    }
    return 0;
}

} // namespace

int APIENTRY wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int) {
    /* A shortcut with no explicit "Start in" folder makes Explorer launch
     * this process with its own install directory as the current
     * directory, which on Windows blocks renaming that directory later -
     * exactly what ApplyUpdate's staged swap needs to do. Moving off it
     * immediately, before anything else runs, avoids holding that
     * implicit lock for no reason. */
    wchar_t tempDir[MAX_PATH];
    if (GetTempPathW(MAX_PATH, tempDir) > 0) {
        SetCurrentDirectoryW(tempDir);
    }

    int argc = 0;
    LPWSTR *argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    std::vector<std::wstring> args;
    for (int i = 0; i < argc; i++) {
        args.push_back(argv[i]);
    }
    LocalFree(argv);

    if (args.size() >= 2 && args[1] == L"--extract") {
        return RunExtractMode(args);
    }
    return RunNormalMode(instance);
}
