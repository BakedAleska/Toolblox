#include "update.h"

#include "extract.h"
#include "log.h"

#include <windows.h>
#include <shellapi.h>
#include <shlwapi.h>

#include <objbase.h>

#pragma comment(lib, "shlwapi.lib")

namespace {

const int kRenameRetryAttempts = 10;
const DWORD kRenameRetryDelayMs = 500;

std::wstring RandomToken() {
    GUID guid;
    CoCreateGuid(&guid);
    wchar_t buf[40];
    swprintf_s(
        buf, L"%08lx%04x%04x", guid.Data1, guid.Data2, guid.Data3);
    return buf;
}

/* Recursively deletes `path` via SHFileOperation, best-effort - leftover
 * debris from a failed cleanup is not treated as an update failure. */
void DeleteTreeBestEffort(const std::wstring &path) {
    std::wstring doubleNull = path;
    doubleNull.push_back(L'\0');
    doubleNull.push_back(L'\0');

    SHFILEOPSTRUCTW op = {};
    op.wFunc = FO_DELETE;
    op.pFrom = doubleNull.c_str();
    op.fFlags = FOF_NO_UI;
    SHFileOperationW(&op);
}

bool RenameWithRetry(const std::wstring &from, const std::wstring &to) {
    for (int attempt = 0; attempt < kRenameRetryAttempts; attempt++) {
        if (MoveFileExW(from.c_str(), to.c_str(), 0)) {
            return true;
        }
        if (attempt < kRenameRetryAttempts - 1) {
            Sleep(kRenameRetryDelayMs);
        }
    }
    return false;
}

std::wstring ParentDir(const std::wstring &path) {
    wchar_t buf[MAX_PATH];
    wcsncpy_s(buf, path.c_str(), MAX_PATH - 1);
    PathRemoveFileSpecW(buf);
    return buf;
}

std::wstring LastComponent(const std::wstring &path) {
    wchar_t buf[MAX_PATH];
    wcsncpy_s(buf, path.c_str(), MAX_PATH - 1);
    return PathFindFileNameW(buf);
}

} // namespace

bool ExtractFreshInstall(
    const std::wstring &zipPath, const std::wstring &destDir, std::wstring &error) {
    return ExtractZip(zipPath, destDir, error);
}

bool ApplyUpdate(
    const std::wstring &installDir, const std::wstring &zipPath, std::wstring &error) {
    std::wstring parent = ParentDir(installDir);
    std::wstring name = LastComponent(installDir);
    std::wstring token = RandomToken();
    std::wstring stagingDir = parent + L"\\." + name + L"_update_" + token;
    std::wstring oldDir = parent + L"\\." + name + L"_old_" + token;

    if (!CreateDirectoryW(stagingDir.c_str(), nullptr)) {
        error = L"Couldn't create staging directory";
        return false;
    }

    if (!ExtractZip(zipPath, stagingDir, error)) {
        DeleteTreeBestEffort(stagingDir);
        return false;
    }

    /* The downloaded zip only ever contains ToolbloxApp.exe and its
     * support files, not Toolblox.exe itself - the launcher is meant to
     * stay stable across in-place updates rather than ship in every
     * release (see native/launcher/README.md). Since the swap below
     * replaces installDir's entire contents with stagingDir's, the
     * currently-running launcher has to be copied into the staging
     * directory first, or it would vanish along with the rest of the old
     * install directory. */
    wchar_t selfPath[MAX_PATH];
    GetModuleFileNameW(nullptr, selfPath, MAX_PATH);
    std::wstring selfName = LastComponent(selfPath);
    if (!CopyFileW(selfPath, (stagingDir + L"\\" + selfName).c_str(), FALSE)) {
        error = L"Couldn't carry the launcher over into the update";
        DeleteTreeBestEffort(stagingDir);
        return false;
    }

    if (!RenameWithRetry(installDir, oldDir)) {
        error = L"Couldn't move the current install aside";
        DeleteTreeBestEffort(stagingDir);
        return false;
    }

    if (!RenameWithRetry(stagingDir, installDir)) {
        error = L"Couldn't move the update into place";
        RenameWithRetry(oldDir, installDir);
        DeleteTreeBestEffort(stagingDir);
        return false;
    }

    DeleteTreeBestEffort(oldDir);
    LogLine(L"Update applied to " + installDir);
    return true;
}
