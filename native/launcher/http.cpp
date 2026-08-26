#include "http.h"

#include <windows.h>
#include <winhttp.h>

#include <vector>

#pragma comment(lib, "winhttp.lib")

static const wchar_t *kUserAgent = L"Toolblox-Launcher/1.0";

namespace {

/* RAII wrappers so every early-return path still closes its WinHTTP
 * handles - WinHttpCloseHandle has to be called in child-before-parent
 * order (request, then connect, then session), which a bare struct with
 * a destructor gets right without every call site repeating it. */
struct HInternet {
    HINTERNET h = nullptr;
    ~HInternet() {
        if (h) {
            WinHttpCloseHandle(h);
        }
    }
};

bool CrackUrl(const std::wstring &url, URL_COMPONENTS &out, std::wstring &host, std::wstring &path) {
    ZeroMemory(&out, sizeof(out));
    out.dwStructSize = sizeof(out);
    wchar_t hostBuf[256] = {0};
    wchar_t pathBuf[2048] = {0};
    out.lpszHostName = hostBuf;
    out.dwHostNameLength = ARRAYSIZE(hostBuf);
    out.lpszUrlPath = pathBuf;
    out.dwUrlPathLength = ARRAYSIZE(pathBuf);
    if (!WinHttpCrackUrl(url.c_str(), 0, 0, &out)) {
        return false;
    }
    host = hostBuf;
    path = pathBuf;
    if (out.lpszExtraInfo && out.dwExtraInfoLength > 0) {
        path.append(out.lpszExtraInfo, out.dwExtraInfoLength);
    }
    return true;
}

/* Opens a request against `url`, following redirects itself (WinHTTP
 * auto-follows by default, but GitHub's asset download URLs redirect from
 * api.github.com/objects.githubusercontent.com across hosts, which needs a
 * fresh WinHttpOpenRequest against the new host - handled here in a small
 * loop rather than relying on WinHTTP's same-host redirect handling). On
 * success, hSession/hConnect/hRequest are left open and owned by the
 * caller (via the HInternet wrappers passed in), positioned after a
 * successful WinHttpReceiveResponse.
 */
bool OpenAndSend(
    HInternet &session, HInternet &connect, HInternet &request, std::wstring url,
    std::wstring &error) {
    session.h = WinHttpOpen(
        kUserAgent, WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, WINHTTP_NO_PROXY_NAME,
        WINHTTP_NO_PROXY_BYPASS, 0);
    if (!session.h) {
        error = L"WinHttpOpen failed";
        return false;
    }
    WinHttpSetTimeouts(session.h, 15000, 15000, 30000, 30000);

    for (int redirects = 0; redirects < 5; redirects++) {
        URL_COMPONENTS parts;
        std::wstring host, path;
        if (!CrackUrl(url, parts, host, path)) {
            error = L"Couldn't parse URL: " + url;
            return false;
        }

        if (connect.h) {
            WinHttpCloseHandle(connect.h);
            connect.h = nullptr;
        }
        connect.h = WinHttpConnect(session.h, host.c_str(), parts.nPort, 0);
        if (!connect.h) {
            error = L"WinHttpConnect failed for " + host;
            return false;
        }

        DWORD flags = (parts.nScheme == INTERNET_SCHEME_HTTPS) ? WINHTTP_FLAG_SECURE : 0;
        if (request.h) {
            WinHttpCloseHandle(request.h);
            request.h = nullptr;
        }
        request.h = WinHttpOpenRequest(
            connect.h, L"GET", path.c_str(), nullptr, WINHTTP_NO_REFERER,
            WINHTTP_DEFAULT_ACCEPT_TYPES, flags);
        if (!request.h) {
            error = L"WinHttpOpenRequest failed";
            return false;
        }
        WinHttpSetOption(
            request.h, WINHTTP_OPTION_DISABLE_FEATURE, nullptr, 0); /* no-op, keeps defaults */

        static const wchar_t *headers = L"Accept: application/vnd.github+json\r\n";
        if (!WinHttpSendRequest(
                request.h, headers, (DWORD)-1L, WINHTTP_NO_REQUEST_DATA, 0, 0, 0)) {
            error = L"WinHttpSendRequest failed";
            return false;
        }
        if (!WinHttpReceiveResponse(request.h, nullptr)) {
            error = L"WinHttpReceiveResponse failed";
            return false;
        }

        DWORD statusCode = 0;
        DWORD statusSize = sizeof(statusCode);
        WinHttpQueryHeaders(
            request.h, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, nullptr,
            &statusCode, &statusSize, nullptr);

        if (statusCode == 301 || statusCode == 302 || statusCode == 303 || statusCode == 307 ||
            statusCode == 308) {
            wchar_t locationBuf[2048] = {0};
            DWORD locationSize = sizeof(locationBuf);
            if (!WinHttpQueryHeaders(
                    request.h, WINHTTP_QUERY_LOCATION, nullptr, locationBuf, &locationSize,
                    nullptr)) {
                error = L"Redirect with no Location header";
                return false;
            }
            url = locationBuf;
            continue;
        }

        if (statusCode < 200 || statusCode >= 300) {
            error = L"HTTP status " + std::to_wstring(statusCode) + L" for " + url;
            return false;
        }
        return true;
    }

    error = L"Too many redirects";
    return false;
}

} // namespace

bool HttpGetString(const std::wstring &url, std::string &outBody, std::wstring &error) {
    HInternet session, connect, request;
    if (!OpenAndSend(session, connect, request, url, error)) {
        return false;
    }

    outBody.clear();
    for (;;) {
        DWORD available = 0;
        if (!WinHttpQueryDataAvailable(request.h, &available)) {
            error = L"WinHttpQueryDataAvailable failed";
            return false;
        }
        if (available == 0) {
            break;
        }
        std::vector<char> buffer(available);
        DWORD read = 0;
        if (!WinHttpReadData(request.h, buffer.data(), available, &read)) {
            error = L"WinHttpReadData failed";
            return false;
        }
        outBody.append(buffer.data(), read);
        if (outBody.size() > 8 * 1024 * 1024) {
            error = L"Response too large";
            return false;
        }
    }
    return true;
}

bool HttpDownloadToFile(
    const std::wstring &url, const std::wstring &destPath, std::wstring &error) {
    HInternet session, connect, request;
    if (!OpenAndSend(session, connect, request, url, error)) {
        return false;
    }

    HANDLE file = CreateFileW(
        destPath.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL,
        nullptr);
    if (file == INVALID_HANDLE_VALUE) {
        error = L"Couldn't create " + destPath;
        return false;
    }

    const DWORD kMaxBytes = 200u * 1024 * 1024;
    unsigned long long total = 0;
    std::vector<char> buffer(64 * 1024);
    bool ok = true;
    for (;;) {
        DWORD available = 0;
        if (!WinHttpQueryDataAvailable(request.h, &available)) {
            error = L"WinHttpQueryDataAvailable failed";
            ok = false;
            break;
        }
        if (available == 0) {
            break;
        }
        DWORD toRead = available < (DWORD)buffer.size() ? available : (DWORD)buffer.size();
        DWORD read = 0;
        if (!WinHttpReadData(request.h, buffer.data(), toRead, &read)) {
            error = L"WinHttpReadData failed";
            ok = false;
            break;
        }
        total += read;
        if (total > kMaxBytes) {
            error = L"Download exceeded the size limit";
            ok = false;
            break;
        }
        DWORD written = 0;
        if (!WriteFile(file, buffer.data(), read, &written, nullptr) || written != read) {
            error = L"Couldn't write to " + destPath;
            ok = false;
            break;
        }
    }

    CloseHandle(file);
    if (!ok) {
        DeleteFileW(destPath.c_str());
    }
    return ok;
}
