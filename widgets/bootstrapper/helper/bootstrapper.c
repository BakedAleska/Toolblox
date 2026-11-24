/*
 * Bootstrapper helper. Reads one JSON message per line on standard input and writes one JSON
 * message per line on standard output.
 *
 * While on, it sets Roblox's own Maximum frame rate, Graphics quality, and Volume settings, which clients read when they open,
 * and limits the Roblox clients opened since it was turned on, except the focused one. Clients
 * already open are left alone, a client is limited only once the account in it is known and listed,
 * and a "set" message limits or frees a single client. Anything left by an earlier run, or inherited
 * from a limited client that opened another, is undone. Limits: priority class,
 * Windows efficiency mode (EcoQoS), low memory priority, a hard CPU cap through a job object, a hard
 * working set cap, fewer logical processors, and a lower GPU scheduling priority. Each is a Windows
 * scheduling setting; the helper never reads or writes a client's memory or code. Processes are
 * opened with PROCESS_SET_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA, and
 * PROCESS_TERMINATE, which assigning a job object needs. Turning it off, or closing
 * standard input, restores normal priority and the user's own settings. It also removes
 * the frame rate flag file earlier versions wrote, which Roblox now ignores.
 *
 * It also reads the Roblox logs written since it started, reports the public address of each
 * server a client joins and the user ID in each client, and shows a "toast" message at the top of
 * the screen when asked. Nothing else from the logs leaves the helper. Windows' Restart Manager
 * finds the client that has a log open.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <tlhelp32.h>
#include <restartmanager.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>

#include "flags.h"
#include "json.h"
#include "server.h"
#include "cap.h"

#define MAX_CLIENTS 256
#define CLIENT_EXE L"RobloxPlayerBeta.exe"
#define BACKUP_SUFFIX L".toolblox-backup"
#define CAP_SUFFIX L".toolblox-framerate"
#define GRAPHICS_SUFFIX L".toolblox-graphics"
#define VOLUME_SUFFIX L".toolblox-volume"

static CRITICAL_SECTION lock;
/* fps and graphics are 0, and volume (0 to 10) is -1, to leave the user's own setting. cpu is a percentage of all cores (0 or 100 for no cap), ram is megabytes (0 for no cap), cores is how many logical processors a client may use (0 for all), and gpu is a GPU scheduling priority class. Each apply bumps generation. */
static struct { int on, fps, graphics, volume, eco, cpu, ram, cores, gpu; DWORD priority; unsigned generation; } config;
/* A running client: whether it opened while on, whether a set message limits or frees it (-1 for neither), whether the limits apply to it, the user ID in it (empty until it joins), the config generation it was limited with (0 when it runs normally, UNKNOWN when new), its CPU cap job, whether its GPU priority was lowered (-1 when new), and the limits Windows refused. */
#define UNKNOWN 0xFFFFFFFFu
typedef struct { DWORD pid; int fresh, forced, enrolled; char user[24]; unsigned applied; HANDLE job; int gpu, failed; } Client;
static Client clients[MAX_CLIENTS];
static int client_count;
/* The user IDs to limit, as ",12,34,". */
static char accounts[16 * 1024];
static char last_status[MAX_CLIENTS * 80 + 256];

static void send_line(const char *line) {
    fputs(line, stdout);
    fputc('\n', stdout);
    fflush(stdout);
}

static void send_error(const char *message) {
    char quoted[512], line[600];
    json_quote(quoted, sizeof quoted, message);
    snprintf(line, sizeof line, "{\"type\":\"error\",\"message\":%s}", quoted);
    send_line(line);
}

/* Reads a small file as text. Returns 0 when it's missing or larger than size - 1. */
static int read_small(const wchar_t *path, char *out, DWORD size) {
    HANDLE file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING, 0, NULL);
    DWORD read = 0;
    if (file == INVALID_HANDLE_VALUE) return 0;
    BOOL ok = ReadFile(file, out, size - 1, &read, NULL);
    CloseHandle(file);
    if (!ok || read >= size - 1) return 0;
    out[read] = 0;
    return 1;
}

/* Replaces a file in one step, so a reader never sees part of it. */
static int write_text(const wchar_t *path, const char *text) {
    wchar_t temporary[MAX_PATH];
    if (swprintf(temporary, MAX_PATH, L"%ls.toolblox-new", path) < 0) return 0;
    HANDLE file = CreateFileW(temporary, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    DWORD written = 0, length = (DWORD)strlen(text);
    if (file == INVALID_HANDLE_VALUE) return 0;
    BOOL ok = WriteFile(file, text, length, &written, NULL);
    CloseHandle(file);
    if (ok && written == length && MoveFileExW(temporary, path, MOVEFILE_REPLACE_EXISTING)) return 1;
    DeleteFileW(temporary);
    return 0;
}

/* Removes the ClientAppSettings.json an earlier version wrote to one version folder, and puts back the user's own. Roblox now ignores that flag. */
static void clean_folder(const wchar_t *version) {
    wchar_t path[MAX_PATH], backup[MAX_PATH];
    char text[4096];
    if (swprintf(path, MAX_PATH, L"%ls\\ClientSettings\\ClientAppSettings.json", version) < 0
        || swprintf(backup, MAX_PATH, L"%ls%ls", path, BACKUP_SUFFIX) < 0) return;
    int exists = GetFileAttributesW(path) != INVALID_FILE_ATTRIBUTES;
    int ours = exists && read_small(path, text, sizeof text) && flags_ours(text);
    if (ours) DeleteFileW(path);
    if (ours || !exists) MoveFileExW(backup, path, 0);
}

/* Cleans every Roblox version folder under %LOCALAPPDATA%\Roblox\Versions. */
static void clean_flags(void) {
    wchar_t root[MAX_PATH], pattern[MAX_PATH], version[MAX_PATH], exe[MAX_PATH];
    WIN32_FIND_DATAW found;
    DWORD length = GetEnvironmentVariableW(L"LOCALAPPDATA", root, MAX_PATH);
    if (!length || length >= MAX_PATH) return;
    swprintf(pattern, MAX_PATH, L"%ls\\Roblox\\Versions\\*", root);
    HANDLE search = FindFirstFileW(pattern, &found);
    if (search == INVALID_HANDLE_VALUE) return;
    do {
        if (!(found.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) || found.cFileName[0] == L'.') continue;
        if (swprintf(version, MAX_PATH, L"%ls\\Roblox\\Versions\\%ls", root, found.cFileName) < 0
            || swprintf(exe, MAX_PATH, L"%ls\\" CLIENT_EXE, version) < 0
            || GetFileAttributesW(exe) == INVALID_FILE_ATTRIBUTES) continue;
        clean_folder(version);
    } while (FindNextFileW(search, &found));
    FindClose(search);
}

static int near_value(double a, double b) {
    return a > b - 0.001 && a < b + 0.001;
}

/* One of Roblox's own settings. quiet counts ticks without clients since it was released. */
typedef struct { const char *entry; const wchar_t *suffix; int quiet; } Setting;
static Setting fps_setting = { FPS_ENTRY, CAP_SUFFIX, 0 }, graphics_setting = { GRAPHICS_ENTRY, GRAPHICS_SUFFIX, 0 }, volume_setting = { VOLUME_ENTRY, VOLUME_SUFFIX, 0 };

/*
 * Brings a setting in line with wanted, or releases it when negative. A file beside the settings
 * keeps the user's own value and the value written. Clients opened while it held write that value
 * back when they close, so after release the file stays, and the user's value is restored again,
 * until no clients have been open for a few seconds. A value that's neither of the two is the
 * user's new choice and is kept. Returns 1 when the setting holds.
 */
static int sync_setting(Setting *setting, double wanted) {
    wchar_t root[MAX_PATH], path[MAX_PATH], saved[MAX_PATH];
    char text[64 * 1024], updated[64 * 1024], value[64];
    double current = 0, own = 0, held = -1;
    DWORD length = GetEnvironmentVariableW(L"LOCALAPPDATA", root, MAX_PATH);
    if (!length || length >= MAX_PATH || swprintf(path, MAX_PATH, L"%ls\\Roblox\\GlobalBasicSettings_13.xml", root) < 0
        || swprintf(saved, MAX_PATH, L"%ls%ls", path, setting->suffix) < 0) return 0;
    int fields = read_small(saved, value, sizeof value) ? sscanf(value, "%lf %lf", &own, &held) : 0;
    if (wanted < 0 && fields < 1) return 0;
    if (!read_small(path, text, sizeof text) || !strstr(text, "</roblox>")
        || !cap_replace(text, setting->entry, wanted >= 0 ? wanted : own, updated, sizeof updated, &current)) return 0;
    if (wanted >= 0) {
        setting->quiet = 0;
        if (fields < 1) own = current;
        if (fields < 2 || !near_value(held, wanted)) {
            snprintf(value, sizeof value, "%.7g %.7g", own, wanted);
            if (!write_text(saved, value)) return 0;
        }
        return near_value(current, wanted) || write_text(path, updated);
    }
    if (!near_value(current, own)) {
        if (fields < 2 || near_value(current, held)) {
            if (!write_text(path, updated)) return 0;
        } else {
            snprintf(value, sizeof value, "%.7g %.7g", current, held);
            write_text(saved, value);
        }
    }
    setting->quiet = client_count ? 0 : setting->quiet + 1;
    if (setting->quiet > 5) DeleteFileW(saved);
    return 0;
}

/* Returns 1 when the frame rate cap holds. */
static int sync_settings(void) {
    sync_setting(&graphics_setting, config.on && config.graphics ? config.graphics : -1);
    sync_setting(&volume_setting, config.on && config.volume >= 0 ? config.volume / 10.0 : -1);
    return sync_setting(&fps_setting, config.on && config.fps ? config.fps : -1);
}

/* Bits for each limit, reported as "failed" when Windows refuses it. */
enum { FAIL_PRIORITY = 1, FAIL_ECO = 2, FAIL_MEMORY = 4, FAIL_CPU = 8, FAIL_RAM = 16, FAIL_CORES = 32, FAIL_GPU = 64 };

typedef LONG(APIENTRY *SetGpuPriority)(HANDLE, int);

/* Sets the GPU scheduling priority through gdi32: 0 idle, 1 below normal, 2 normal. Returns 0 when Windows refuses it. */
static int set_gpu_priority(HANDLE process, int priority) {
    static SetGpuPriority set;
    static int loaded;
    if (!loaded) {
        loaded = 1;
        HMODULE gdi = LoadLibraryW(L"gdi32.dll");
        if (gdi) set = (SetGpuPriority)(void *)GetProcAddress(gdi, "D3DKMTSetProcessSchedulingPriorityClass");
    }
    return set && set(process, priority) == 0;
}

/*
 * Applies every limit in the config to a client when limit is 1, or returns it to normal when 0.
 * The CPU cap uses a job object per client. A process can't leave a job, so returning to normal
 * turns the job's cap off. Clients that a limited client opens stay out of its job. Returns the
 * FAIL_ bits for limits, or returns to normal, that Windows refused.
 */
static int limit_client(Client *client, int limit) {
    int failed = 0;
    HANDLE process = OpenProcess(PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SET_QUOTA | PROCESS_TERMINATE, FALSE, client->pid);
    if (!process) return FAIL_PRIORITY | FAIL_ECO | FAIL_MEMORY | FAIL_CPU | FAIL_RAM | FAIL_CORES | FAIL_GPU;

    DWORD priority = GetPriorityClass(process);
    if (limit ? !SetPriorityClass(process, config.priority)
        : (priority == IDLE_PRIORITY_CLASS || priority == BELOW_NORMAL_PRIORITY_CLASS) && !SetPriorityClass(process, NORMAL_PRIORITY_CLASS)) failed |= FAIL_PRIORITY;

    PROCESS_POWER_THROTTLING_STATE throttling = { PROCESS_POWER_THROTTLING_CURRENT_VERSION, 0, 0 };
    if (limit && config.eco) throttling.ControlMask = throttling.StateMask = PROCESS_POWER_THROTTLING_EXECUTION_SPEED;
    if (!SetProcessInformation(process, ProcessPowerThrottling, &throttling, sizeof throttling)) failed |= FAIL_ECO;

    MEMORY_PRIORITY_INFORMATION memory = { limit ? MEMORY_PRIORITY_LOW : MEMORY_PRIORITY_NORMAL };
    if (!SetProcessInformation(process, ProcessMemoryPriority, &memory, sizeof memory)) failed |= FAIL_MEMORY;

    int cpu = limit && config.cpu > 0 && config.cpu < 100;
    if (cpu && !client->job) {
        client->job = CreateJobObjectW(NULL, NULL);
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = { .BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK };
        if (client->job) SetInformationJobObject(client->job, JobObjectExtendedLimitInformation, &limits, sizeof limits);
        if (client->job && !AssignProcessToJobObject(client->job, process)) { CloseHandle(client->job); client->job = NULL; }
    }
    if (client->job) {
        JOBOBJECT_CPU_RATE_CONTROL_INFORMATION rate = { 0 };
        if (cpu) rate.ControlFlags = JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP, rate.CpuRate = (DWORD)config.cpu * 100;
        if (!SetInformationJobObject(client->job, JobObjectCpuRateControlInformation, &rate, sizeof rate)) failed |= FAIL_CPU;
    } else if (cpu) failed |= FAIL_CPU;

    SIZE_T low, high;
    DWORD flags;
    if (limit && config.ram > 0) {
        SIZE_T cap = (SIZE_T)config.ram << 20;
        if (!SetProcessWorkingSetSizeEx(process, cap / 4, cap, QUOTA_LIMITS_HARDWS_MIN_DISABLE | QUOTA_LIMITS_HARDWS_MAX_ENABLE)) failed |= FAIL_RAM;
    } else if (GetProcessWorkingSetSizeEx(process, &low, &high, &flags) && flags & QUOTA_LIMITS_HARDWS_MAX_ENABLE
        && !SetProcessWorkingSetSizeEx(process, low, high, QUOTA_LIMITS_HARDWS_MIN_DISABLE | QUOTA_LIMITS_HARDWS_MAX_DISABLE)) failed |= FAIL_RAM;

    DWORD_PTR mask, system;
    if (GetProcessAffinityMask(process, &mask, &system)) {
        DWORD_PTR wanted = system;
        if (limit && config.cores > 0)
            for (int bit = sizeof wanted * 8 - 1, kept = 0; bit >= 0; bit--)
                if (system >> bit & 1) { if (kept < config.cores) kept++; else wanted &= ~((DWORD_PTR)1 << bit); }
        if (wanted != mask && !SetProcessAffinityMask(process, wanted)) failed |= FAIL_CORES;
    } else if (limit && config.cores > 0) failed |= FAIL_CORES;

    if ((limit && config.gpu != 2) || client->gpu) {
        if (!set_gpu_priority(process, limit ? config.gpu : 2) && (limit || client->gpu > 0)) failed |= FAIL_GPU;
        else client->gpu = limit && config.gpu != 2;
    }

    CloseHandle(process);
    return failed;
}

#define MAX_LOGS 64
typedef struct { wchar_t name[MAX_PATH]; LONGLONG offset; int seen, tries; char user[24]; } Log;
static Log logs[MAX_LOGS];
static int log_count;
static ULONGLONG started;

static int tracked(DWORD pid) {
    for (int i = 0; i < client_count; i++) if (clients[i].pid == pid) return i;
    return -1;
}

/* Enrolls listed accounts in clients opened while on, applies the config to enrolled clients, and forgets clients that exited. A client that isn't returned to normal is tried again each time. */
static void sync_clients(int *running, int *limited, int *failed) {
    DWORD focused = 0, live[MAX_CLIENTS];
    int live_count = 0;
    PROCESSENTRY32W entry = { .dwSize = sizeof entry };
    GetWindowThreadProcessId(GetForegroundWindow(), &focused);
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot != INVALID_HANDLE_VALUE) {
        for (BOOL more = Process32FirstW(snapshot, &entry); more && live_count < MAX_CLIENTS; more = Process32NextW(snapshot, &entry))
            if (!_wcsicmp(entry.szExeFile, CLIENT_EXE)) live[live_count++] = entry.th32ProcessID;
        CloseHandle(snapshot);
    }
    for (int i = client_count - 1; i >= 0; i--) {
        int alive = 0;
        for (int j = 0; j < live_count; j++) alive |= live[j] == clients[i].pid;
        if (alive) continue;
        if (clients[i].job) CloseHandle(clients[i].job);
        clients[i] = clients[--client_count];
    }
    *running = live_count;
    *limited = *failed = 0;
    for (int i = 0; i < live_count; i++) {
        int index = tracked(live[i]);
        if (index < 0) {
            if (client_count == MAX_CLIENTS) continue;
            index = client_count++;
            clients[index] = (Client){ .pid = live[i], .fresh = config.on, .forced = -1, .applied = UNKNOWN, .gpu = -1 };
        }
        Client *client = &clients[index];
        client->enrolled = client->forced >= 0 ? client->forced : client->fresh && user_listed(accounts, client->user);
        unsigned wanted = config.on && client->enrolled && live[i] != focused ? config.generation : 0;
        if (wanted != client->applied) {
            client->failed = limit_client(client, wanted != 0);
            client->applied = !wanted && client->failed ? UNKNOWN : wanted;
        }
        *limited += wanted != 0;
        *failed |= client->failed;
    }
}

static void tick(void) {
    int running, limited, failed, capped = sync_settings();
    sync_clients(&running, &limited, &failed);
    static char line[sizeof last_status];
    int length = snprintf(line, sizeof line, "{\"type\":\"status\",\"on\":%s,\"clients\":%d,\"limited\":%d,\"capped\":%s,\"failed\":%d,\"open\":[",
        config.on ? "true" : "false", running, limited, capped ? "true" : "false", failed);
    for (int i = 0; i < client_count; i++)
        length += snprintf(line + length, sizeof line - length, "%s{\"pid\":%lu,\"user\":\"%s\",\"enrolled\":%s}",
            i ? "," : "", clients[i].pid, clients[i].user, clients[i].enrolled ? "true" : "false");
    snprintf(line + length, sizeof line - length, "]}");
    if (strcmp(line, last_status)) {
        send_line(line);
        strcpy(last_status, line);
    }
}

static ULONGLONG file_time(FILETIME time) {
    return (ULONGLONG)time.dwHighDateTime << 32 | time.dwLowDateTime;
}

/* Records the user on the client that has the log open. Returns 0 when there's none. */
static int match_client(const wchar_t *path, const char *user) {
    DWORD session, reason;
    int matched = 0;
    UINT needed = 0, count = 8;
    RM_PROCESS_INFO users[8];
    WCHAR key[CCH_RM_SESSION_KEY + 1] = { 0 };
    if (RmStartSession(&session, 0, key) != ERROR_SUCCESS) return 0;
    if (RmRegisterResources(session, 1, &path, 0, NULL, 0, NULL) == ERROR_SUCCESS
        && RmGetList(session, &needed, &count, users, &reason) == ERROR_SUCCESS)
        for (UINT i = 0; i < count; i++) {
            int index = tracked(users[i].Process.dwProcessId);
            if (index < 0) continue;
            matched = 1;
            if (!strcmp(clients[index].user, user)) continue;
            if (*clients[index].user) clients[index].forced = -1;
            strcpy(clients[index].user, user);
        }
    RmEndSession(session);
    return matched;
}

/*
 * Reads each complete line added to a log since the last read, up to limit. Reports server
 * addresses when report is 1, and matches the last user that joined to its client, trying again on
 * later reads when the client isn't known yet.
 */
static void read_log(const wchar_t *path, Log *log, LONGLONG limit, int report) {
    static char buffer[64 * 1024];
    HANDLE file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, 0, NULL);
    LARGE_INTEGER size, position = { .QuadPart = log->offset };
    DWORD read;
    char user[sizeof clients->user] = "";
    if (file == INVALID_HANDLE_VALUE) return;
    while (log->offset < limit && GetFileSizeEx(file, &size) && size.QuadPart > log->offset && SetFilePointerEx(file, position, NULL, FILE_BEGIN)
           && ReadFile(file, buffer, sizeof buffer - 1, &read, NULL) && read) {
        buffer[read] = 0;
        char *end = strrchr(buffer, '\n');
        if (!end) { if (read < sizeof buffer - 1) break; end = buffer + read - 1; }
        *end = 0;
        for (char *line = buffer, *next; line; line = next) {
            char address[16], message[64];
            if ((next = strchr(line, '\n'))) *next++ = 0;
            joined_user(line, user, sizeof user);
            if (report && server_address(line, address, sizeof address)) {
                snprintf(message, sizeof message, "{\"type\":\"server\",\"address\":\"%s\"}", address);
                send_line(message);
            }
        }
        log->offset += end - buffer + 1;
        position.QuadPart = log->offset;
    }
    CloseHandle(file);
    if (*user) strcpy(log->user, user), log->tries = 10;
    if (log->tries && (log->tries--, match_client(path, log->user))) log->tries = 0;
}

/* Returns the size of a log a running client has open, or -1. Folder listings show stale sizes and times for open files. */
static LONGLONG open_log_size(const wchar_t *path) {
    LARGE_INTEGER size;
    HANDLE file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
    if (file != INVALID_HANDLE_VALUE) { CloseHandle(file); return -1; }
    if (GetLastError() != ERROR_SHARING_VIOLATION) return -1;
    file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, 0, NULL);
    if (file == INVALID_HANDLE_VALUE) return -1;
    BOOL ok = GetFileSizeEx(file, &size);
    CloseHandle(file);
    return ok ? size.QuadPart : -1;
}

/* Reads the client logs in %LOCALAPPDATA%\Roblox\logs written since the helper started, and those open when it started. The latter are searched near their start for the user in them, then read from their end. */
static void watch_logs(void) {
    static int scanned;
    wchar_t root[MAX_PATH], pattern[MAX_PATH], path[MAX_PATH];
    WIN32_FIND_DATAW found;
    DWORD length = GetEnvironmentVariableW(L"LOCALAPPDATA", root, MAX_PATH);
    if (!length || length >= MAX_PATH || swprintf(pattern, MAX_PATH, L"%ls\\Roblox\\logs\\*_Player_*.log", root) < 0) return;
    for (int i = 0; i < log_count; i++) logs[i].seen = 0;
    HANDLE search = FindFirstFileW(pattern, &found);
    if (search != INVALID_HANDLE_VALUE) {
        do {
            if (wcsstr(found.cFileName, L"CrashHandler") || swprintf(path, MAX_PATH, L"%ls\\Roblox\\logs\\%ls", root, found.cFileName) < 0) continue;
            int index = 0;
            while (index < log_count && wcscmp(logs[index].name, found.cFileName)) index++;
            if (index == log_count) {
                int old = file_time(found.ftCreationTime) < started;
                LONGLONG size = old && !scanned ? open_log_size(path) : -1;
                if (log_count == MAX_LOGS || (size < 0 && file_time(found.ftLastWriteTime) < started)) continue;
                log_count++;
                logs[index] = (Log){ 0 };
                wcscpy(logs[index].name, found.cFileName);
                if (old) {
                    read_log(path, &logs[index], 1 << 20, 0);
                    logs[index].offset = size >= 0 ? size : (LONGLONG)found.nFileSizeHigh << 32 | found.nFileSizeLow;
                }
            }
            logs[index].seen = 1;
            read_log(path, &logs[index], MAXLONGLONG, 1);
        } while (FindNextFileW(search, &found));
        FindClose(search);
    }
    scanned = 1;
    for (int i = log_count - 1; i >= 0; i--) if (!logs[i].seen) logs[i] = logs[--log_count];
}

#define TOAST_SLIDE_MS 220
#define TOAST_HOLD_MS 4000
static HWND toast;
static wchar_t toast_title[64], toast_text[128];
static ULONGLONG toast_shown;
static int toast_left, toast_width, toast_height, toast_top, toast_margin;

/* Eases the toast down from above the top edge, holds it, then raises it back off the screen. */
static void toast_step(HWND window) {
    ULONGLONG elapsed = GetTickCount64() - toast_shown;
    BOOL animate = TRUE;
    SystemParametersInfoW(SPI_GETCLIENTAREAANIMATION, 0, &animate, 0);
    if (elapsed >= TOAST_SLIDE_MS * 2 + TOAST_HOLD_MS) { KillTimer(window, 1); ShowWindow(window, SW_HIDE); return; }
    double shown = !animate ? 1 : elapsed < TOAST_SLIDE_MS ? (double)elapsed / TOAST_SLIDE_MS
        : elapsed > TOAST_SLIDE_MS + TOAST_HOLD_MS ? (double)(TOAST_SLIDE_MS * 2 + TOAST_HOLD_MS - elapsed) / TOAST_SLIDE_MS : 1;
    shown = 1 - (1 - shown) * (1 - shown) * (1 - shown);
    int y = toast_top - toast_height + (int)((toast_height + toast_margin) * shown);
    SetWindowPos(window, HWND_TOPMOST, toast_left, y, toast_width, toast_height, SWP_NOACTIVATE | SWP_SHOWWINDOW);
}

static HFONT toast_font(int height, int weight) {
    return CreateFontW(-height, 0, 0, 0, weight, FALSE, FALSE, FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                       CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Segoe UI");
}

static LRESULT CALLBACK toast_proc(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
    if (message == WM_APP) {
        HMONITOR monitor = MonitorFromWindow(GetForegroundWindow(), MONITOR_DEFAULTTOPRIMARY);
        MONITORINFO info = { .cbSize = sizeof info };
        HDC dc = GetDC(window);
        int scale = GetDeviceCaps(dc, LOGPIXELSY);
        HFONT title = toast_font(12 * scale / 96, FW_NORMAL), text = toast_font(15 * scale / 96, FW_SEMIBOLD);
        SIZE title_size, text_size;
        SelectObject(dc, title);
        GetTextExtentPoint32W(dc, toast_title, (int)wcslen(toast_title), &title_size);
        SelectObject(dc, text);
        GetTextExtentPoint32W(dc, toast_text, (int)wcslen(toast_text), &text_size);
        ReleaseDC(window, dc);
        DeleteObject(title);
        DeleteObject(text);
        GetMonitorInfoW(monitor, &info);
        int padding = 16 * scale / 96;
        toast_width = max(title_size.cx, text_size.cx) + padding * 2;
        toast_height = title_size.cy + text_size.cy + padding * 3 / 2;
        toast_margin = 16 * scale / 96;
        toast_top = info.rcWork.top;
        toast_left = info.rcWork.left + (info.rcWork.right - info.rcWork.left - toast_width) / 2;
        SetWindowRgn(window, CreateRoundRectRgn(0, 0, toast_width + 1, toast_height + 1, 18 * scale / 96, 18 * scale / 96), FALSE);
        InvalidateRect(window, NULL, TRUE);
        toast_shown = GetTickCount64();
        SetTimer(window, 1, 15, NULL);
        toast_step(window);
        return 0;
    }
    if (message == WM_TIMER) { toast_step(window); return 0; }
    if (message == WM_PAINT) {
        PAINTSTRUCT paint;
        RECT area;
        HDC dc = BeginPaint(window, &paint);
        int scale = GetDeviceCaps(dc, LOGPIXELSY), padding = 16 * scale / 96;
        HFONT title = toast_font(12 * scale / 96, FW_NORMAL), text = toast_font(15 * scale / 96, FW_SEMIBOLD);
        HBRUSH background = CreateSolidBrush(RGB(24, 24, 27));
        GetClientRect(window, &area);
        FillRect(dc, &area, background);
        SetBkMode(dc, TRANSPARENT);
        area.left += padding, area.right -= padding, area.top += padding * 3 / 4;
        SelectObject(dc, title);
        SetTextColor(dc, RGB(161, 161, 170));
        area.top += DrawTextW(dc, toast_title, -1, &area, DT_SINGLELINE | DT_CENTER | DT_NOPREFIX);
        SelectObject(dc, text);
        SetTextColor(dc, RGB(250, 250, 250));
        DrawTextW(dc, toast_text, -1, &area, DT_SINGLELINE | DT_CENTER | DT_NOPREFIX | DT_END_ELLIPSIS);
        DeleteObject(background);
        DeleteObject(title);
        DeleteObject(text);
        EndPaint(window, &paint);
        return 0;
    }
    return DefWindowProcW(window, message, wparam, lparam);
}

/* Owns the toast window. It never takes focus and lets clicks through to the window under it. */
static DWORD WINAPI toast_loop(LPVOID unused) {
    WNDCLASSW type = { .lpfnWndProc = toast_proc, .hInstance = GetModuleHandleW(NULL), .lpszClassName = L"ToolbloxBootstrapperToast" };
    MSG message;
    (void)unused;
    if (!RegisterClassW(&type)) return 0;
    toast = CreateWindowExW(WS_EX_TOPMOST | WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, type.lpszClassName,
                            L"Bootstrapper", WS_POPUP, 0, 0, 1, 1, NULL, NULL, type.hInstance, NULL);
    if (!toast) return 0;
    SetLayeredWindowAttributes(toast, 0, 242, LWA_ALPHA);
    while (GetMessageW(&message, NULL, 0, 0) > 0) DispatchMessageW(&message);
    return 0;
}

/* Shows a toast with a short title above the text. Called with the lock held. */
static void show_toast(const char *title, const char *text) {
    if (!toast) { send_error("The toast window isn't available."); return; }
    if (!MultiByteToWideChar(CP_UTF8, 0, title, -1, toast_title, 64) || !MultiByteToWideChar(CP_UTF8, 0, text, -1, toast_text, 128)) {
        send_error("The toast text is too long.");
        return;
    }
    PostMessageW(toast, WM_APP, 0, 0);
}

static DWORD WINAPI loop(LPVOID unused) {
    (void)unused;
    for (;;) {
        Sleep(1000);
        EnterCriticalSection(&lock);
        tick();
        watch_logs();
        LeaveCriticalSection(&lock);
    }
    return 0;
}

static void handle(const char *line) {
    char type[16], fps[8], priority[16], eco[8], number[16], gpu[16];
    if (!json_get(line, "type", type, sizeof type)) { send_error("The message isn't valid."); return; }
    EnterCriticalSection(&lock);
    if (!strcmp(type, "apply") && json_get(line, "fps", fps, sizeof fps) && json_get(line, "priority", priority, sizeof priority) && json_get(line, "eco", eco, sizeof eco)) {
        int cap = atoi(fps);
        if (!config.on) tick();
        if (!json_get(line, "accounts", accounts, sizeof accounts)) *accounts = 0;
        config.on = 1;
        config.fps = cap >= FPS_MIN && cap <= FPS_MAX ? cap : 0;
        config.graphics = json_get(line, "graphics", number, sizeof number) ? atoi(number) : 0;
        if (config.graphics < 0 || config.graphics > 10) config.graphics = 0;
        config.volume = json_get(line, "volume", number, sizeof number) ? atoi(number) : -1;
        if (config.volume < 0 || config.volume > 10) config.volume = -1;
        config.eco = !strcmp(eco, "on");
        config.priority = !strcmp(priority, "idle") ? IDLE_PRIORITY_CLASS : !strcmp(priority, "below") ? BELOW_NORMAL_PRIORITY_CLASS : NORMAL_PRIORITY_CLASS;
        config.cpu = json_get(line, "cpu", number, sizeof number) ? atoi(number) : 0;
        config.ram = json_get(line, "ram", number, sizeof number) ? atoi(number) : 0;
        config.cores = json_get(line, "cores", number, sizeof number) ? atoi(number) : 0;
        if (config.cpu < 0 || config.cpu > 100) config.cpu = 0;
        if (config.ram < 0 || config.ram > 1 << 20) config.ram = 0;
        if (config.cores < 0) config.cores = 0;
        config.gpu = !json_get(line, "gpu", gpu, sizeof gpu) ? 2 : !strcmp(gpu, "idle") ? 0 : !strcmp(gpu, "below") ? 1 : 2;
        if (++config.generation == UNKNOWN) config.generation = 1;
    } else if (!strcmp(type, "clear")) config.on = 0;
    else if (!strcmp(type, "set") && json_get(line, "pid", number, sizeof number) && json_get(line, "on", eco, sizeof eco)) {
        int index = tracked(strtoul(number, NULL, 10));
        if (index >= 0) clients[index].forced = !strcmp(eco, "on");
    } else if (!strcmp(type, "toast")) {
        char title[64], text[128];
        if (json_get(line, "title", title, sizeof title) && json_get(line, "text", text, sizeof text)) show_toast(title, text);
        else send_error("The toast message isn't valid.");
        LeaveCriticalSection(&lock);
        return;
    } else send_error("The message isn't supported.");
    *last_status = 0;
    tick();
    LeaveCriticalSection(&lock);
}

int main(void) {
    static char line[32 * 1024];
    BOOL(WINAPI * set_awareness)(HANDLE) = (BOOL(WINAPI *)(HANDLE))(void *)GetProcAddress(GetModuleHandleW(L"user32.dll"), "SetProcessDpiAwarenessContext");
    if (set_awareness) set_awareness((HANDLE)-4);
    InitializeCriticalSection(&lock);
    HANDLE only = CreateMutexW(NULL, FALSE, L"Local\\ToolbloxBootstrapper");
    DWORD turn = only ? WaitForSingleObject(only, 3000) : WAIT_OBJECT_0;
    if (turn != WAIT_OBJECT_0 && turn != WAIT_ABANDONED) {
        send_error("Another Toolblox is running the Bootstrapper. Is it closed?");
        return 1;
    }
    FILETIME now;
    GetSystemTimeAsFileTime(&now);
    started = file_time(now);
    clean_flags();
    CreateThread(NULL, 0, toast_loop, NULL, 0, NULL);
    send_line("{\"type\":\"ready\"}");
    CreateThread(NULL, 0, loop, NULL, 0, NULL);
    while (fgets(line, sizeof line, stdin)) handle(line);
    EnterCriticalSection(&lock);
    config.on = 0;
    for (int attempt = 0, running, limited, failed = 1; attempt < 3 && failed; attempt++) {
        sync_settings();
        sync_clients(&running, &limited, &failed);
        if (failed) Sleep(100);
    }
    return 0;
}
