/*
 * Bootstrapper helper. Reads one JSON message per line on standard input and writes one JSON
 * message per line on standard output.
 *
 * While on, it sets Roblox's own Maximum frame rate setting, which clients read when they open,
 * and limits every Roblox client except the focused one, as soon as it opens: priority class,
 * Windows efficiency mode (EcoQoS), low memory priority, a hard CPU cap through a job object, a hard
 * working set cap, fewer logical processors, and a lower GPU scheduling priority. Each is a Windows
 * scheduling setting; the helper never reads or writes a client's memory or code. Processes are
 * opened with PROCESS_SET_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA, and
 * PROCESS_TERMINATE, which assigning a job object needs. Turning it off, or closing
 * standard input, restores normal priority and the user's own frame rate setting. It also removes
 * the frame rate flag file earlier versions wrote, which Roblox now ignores.
 *
 * It also reads the Roblox logs written since it started, reports the public address of each
 * server a client joins, and shows a "toast" message at the top of the screen when asked. Nothing
 * else from the logs leaves the helper.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <tlhelp32.h>
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

static CRITICAL_SECTION lock;
/* cpu is a percentage of all cores (0 or 100 for no cap), ram is megabytes (0 for no cap), cores is how many logical processors a client may use (0 for all), and gpu is a GPU scheduling priority class. Each apply bumps generation. */
static struct { int on, fps, eco, cpu, ram, cores, gpu; DWORD priority; unsigned generation; } config;
/* A running client: the config generation it was limited with (0 when it runs normally), its CPU cap job, whether its GPU priority was lowered, and the limits Windows refused. */
typedef struct { DWORD pid; unsigned applied; HANDLE job; int gpu, failed; } Client;
static Client clients[MAX_CLIENTS];
static int client_count;
static int last_clients = -1, last_limited = -1, last_capped = -1, last_failed = -1;

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

static int write_text(const wchar_t *path, const char *text) {
    HANDLE file = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    DWORD written = 0, length = (DWORD)strlen(text);
    if (file == INVALID_HANDLE_VALUE) return 0;
    BOOL ok = WriteFile(file, text, length, &written, NULL);
    CloseHandle(file);
    return ok && written == length;
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

/*
 * Brings Roblox's Maximum frame rate setting in line with the config. The user's own value is kept
 * in a file beside the settings while the cap holds, and written back when it's turned off.
 * Returns 1 when the cap holds.
 */
static int sync_cap(void) {
    wchar_t root[MAX_PATH], path[MAX_PATH], saved[MAX_PATH];
    char text[64 * 1024], updated[64 * 1024], value[16];
    int old = 0;
    DWORD length = GetEnvironmentVariableW(L"LOCALAPPDATA", root, MAX_PATH);
    if (!length || length >= MAX_PATH || swprintf(path, MAX_PATH, L"%ls\\Roblox\\GlobalBasicSettings_13.xml", root) < 0
        || swprintf(saved, MAX_PATH, L"%ls" CAP_SUFFIX, path) < 0 || !read_small(path, text, sizeof text)) return 0;
    int holding = GetFileAttributesW(saved) != INVALID_FILE_ATTRIBUTES;
    if (config.on && config.fps) {
        if (!cap_replace(text, config.fps, updated, sizeof updated, &old)) return 0;
        if (old == config.fps) return 1;
        snprintf(value, sizeof value, "%d", old);
        if (!holding && !write_text(saved, value)) return 0;
        return write_text(path, updated);
    }
    /* ponytail: a client opened while capped writes the cap back when it closes after this; turning the cap on and off again fixes it. */
    if (holding && read_small(saved, value, sizeof value) && cap_replace(text, atoi(value), updated, sizeof updated, &old)
        && write_text(path, updated)) DeleteFileW(saved);
    return 0;
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
 * turns the job's cap off. Returns the FAIL_ bits for limits Windows refused.
 */
static int limit_client(Client *client, int limit) {
    int failed = 0;
    HANDLE process = OpenProcess(PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SET_QUOTA | PROCESS_TERMINATE, FALSE, client->pid);
    if (!process) return FAIL_PRIORITY | FAIL_ECO | FAIL_MEMORY | FAIL_CPU | FAIL_RAM | FAIL_CORES | FAIL_GPU;

    if (!SetPriorityClass(process, limit ? config.priority : NORMAL_PRIORITY_CLASS)) failed |= FAIL_PRIORITY;

    PROCESS_POWER_THROTTLING_STATE throttling = { PROCESS_POWER_THROTTLING_CURRENT_VERSION, 0, 0 };
    if (limit && config.eco) throttling.ControlMask = throttling.StateMask = PROCESS_POWER_THROTTLING_EXECUTION_SPEED;
    if (!SetProcessInformation(process, ProcessPowerThrottling, &throttling, sizeof throttling)) failed |= FAIL_ECO;

    MEMORY_PRIORITY_INFORMATION memory = { limit ? MEMORY_PRIORITY_LOW : MEMORY_PRIORITY_NORMAL };
    if (!SetProcessInformation(process, ProcessMemoryPriority, &memory, sizeof memory)) failed |= FAIL_MEMORY;

    int cpu = limit && config.cpu > 0 && config.cpu < 100;
    if (cpu && !client->job) {
        client->job = CreateJobObjectW(NULL, NULL);
        if (client->job && !AssignProcessToJobObject(client->job, process)) { CloseHandle(client->job); client->job = NULL; }
    }
    if (client->job) {
        JOBOBJECT_CPU_RATE_CONTROL_INFORMATION rate = { 0 };
        if (cpu) rate.ControlFlags = JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP, rate.CpuRate = (DWORD)config.cpu * 100;
        if (!SetInformationJobObject(client->job, JobObjectCpuRateControlInformation, &rate, sizeof rate) && cpu) failed |= FAIL_CPU;
    } else if (cpu) failed |= FAIL_CPU;

    SIZE_T low, high;
    DWORD flags;
    if (limit && config.ram > 0) {
        SIZE_T cap = (SIZE_T)config.ram << 20;
        if (!SetProcessWorkingSetSizeEx(process, cap / 4, cap, QUOTA_LIMITS_HARDWS_MIN_DISABLE | QUOTA_LIMITS_HARDWS_MAX_ENABLE)) failed |= FAIL_RAM;
    } else if (GetProcessWorkingSetSizeEx(process, &low, &high, &flags) && flags & QUOTA_LIMITS_HARDWS_MAX_ENABLE)
        SetProcessWorkingSetSizeEx(process, low, high, QUOTA_LIMITS_HARDWS_MIN_DISABLE | QUOTA_LIMITS_HARDWS_MAX_DISABLE);

    DWORD_PTR mask, system;
    if (GetProcessAffinityMask(process, &mask, &system)) {
        DWORD_PTR wanted = system;
        if (limit && config.cores > 0)
            for (int bit = sizeof wanted * 8 - 1, kept = 0; bit >= 0; bit--)
                if (system >> bit & 1) { if (kept < config.cores) kept++; else wanted &= ~((DWORD_PTR)1 << bit); }
        if (wanted != mask && !SetProcessAffinityMask(process, wanted) && limit && config.cores > 0) failed |= FAIL_CORES;
    } else if (limit && config.cores > 0) failed |= FAIL_CORES;

    if ((limit && config.gpu != 2) || client->gpu) {
        if (!set_gpu_priority(process, limit ? config.gpu : 2) && limit) failed |= FAIL_GPU;
        client->gpu = limit && config.gpu != 2;
    }

    CloseHandle(process);
    return failed;
}

#define MAX_LOGS 64
typedef struct { wchar_t name[MAX_PATH]; LONGLONG offset; int seen; } Log;
static Log logs[MAX_LOGS];
static int log_count;
static ULONGLONG started;

static int tracked(DWORD pid) {
    for (int i = 0; i < client_count; i++) if (clients[i].pid == pid) return i;
    return -1;
}

/* Applies the config to every running client and forgets clients that exited. */
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
            clients[index] = (Client){ .pid = live[i] };
        }
        Client *client = &clients[index];
        unsigned wanted = config.on && live[i] != focused ? config.generation : 0;
        if (wanted != client->applied) {
            client->failed = limit_client(client, wanted != 0);
            client->applied = wanted;
        }
        if (client->applied) (*limited)++, *failed |= client->failed;
    }
}

static void tick(void) {
    int running, limited, failed, capped = sync_cap();
    sync_clients(&running, &limited, &failed);
    if (running != last_clients || limited != last_limited || capped != last_capped || failed != last_failed) {
        char line[200];
        snprintf(line, sizeof line, "{\"type\":\"status\",\"on\":%s,\"clients\":%d,\"limited\":%d,\"capped\":%s,\"failed\":%d}",
            config.on ? "true" : "false", running, limited, capped ? "true" : "false", failed);
        send_line(line);
        last_clients = running, last_limited = limited, last_capped = capped, last_failed = failed;
    }
}

static ULONGLONG file_time(FILETIME time) {
    return (ULONGLONG)time.dwHighDateTime << 32 | time.dwLowDateTime;
}

/* Reports the server address in each complete line added to a log since the last read. */
static void read_log(const wchar_t *path, Log *log) {
    static char buffer[64 * 1024];
    HANDLE file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, 0, NULL);
    LARGE_INTEGER size, position = { .QuadPart = log->offset };
    DWORD read;
    if (file == INVALID_HANDLE_VALUE) return;
    while (GetFileSizeEx(file, &size) && size.QuadPart > log->offset && SetFilePointerEx(file, position, NULL, FILE_BEGIN)
           && ReadFile(file, buffer, sizeof buffer - 1, &read, NULL) && read) {
        buffer[read] = 0;
        char *end = strrchr(buffer, '\n');
        if (!end) { if (read < sizeof buffer - 1) break; end = buffer + read - 1; }
        *end = 0;
        for (char *line = buffer, *next; line; line = next) {
            char address[16], message[64];
            if ((next = strchr(line, '\n'))) *next++ = 0;
            if (server_address(line, address, sizeof address)) {
                snprintf(message, sizeof message, "{\"type\":\"server\",\"address\":\"%s\"}", address);
                send_line(message);
            }
        }
        log->offset += end - buffer + 1;
        position.QuadPart = log->offset;
    }
    CloseHandle(file);
}

/* Reads the client logs in %LOCALAPPDATA%\Roblox\logs written since the helper started. */
static void watch_logs(void) {
    wchar_t root[MAX_PATH], pattern[MAX_PATH], path[MAX_PATH];
    WIN32_FIND_DATAW found;
    DWORD length = GetEnvironmentVariableW(L"LOCALAPPDATA", root, MAX_PATH);
    if (!length || length >= MAX_PATH || swprintf(pattern, MAX_PATH, L"%ls\\Roblox\\logs\\*_Player_*.log", root) < 0) return;
    for (int i = 0; i < log_count; i++) logs[i].seen = 0;
    HANDLE search = FindFirstFileW(pattern, &found);
    if (search != INVALID_HANDLE_VALUE) {
        do {
            if (wcsstr(found.cFileName, L"CrashHandler") || file_time(found.ftLastWriteTime) < started
                || swprintf(path, MAX_PATH, L"%ls\\Roblox\\logs\\%ls", root, found.cFileName) < 0) continue;
            int index = 0;
            while (index < log_count && wcscmp(logs[index].name, found.cFileName)) index++;
            if (index == log_count) {
                if (log_count == MAX_LOGS) continue;
                log_count++;
                wcscpy(logs[index].name, found.cFileName);
                logs[index].offset = file_time(found.ftCreationTime) < started ? (LONGLONG)found.nFileSizeHigh << 32 | found.nFileSizeLow : 0;
            }
            logs[index].seen = 1;
            read_log(path, &logs[index]);
        } while (FindNextFileW(search, &found));
        FindClose(search);
    }
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
        config.on = 1;
        config.fps = cap >= FPS_MIN && cap <= FPS_MAX ? cap : 0;
        config.eco = !strcmp(eco, "on");
        config.priority = !strcmp(priority, "idle") ? IDLE_PRIORITY_CLASS : !strcmp(priority, "below") ? BELOW_NORMAL_PRIORITY_CLASS : NORMAL_PRIORITY_CLASS;
        config.cpu = json_get(line, "cpu", number, sizeof number) ? atoi(number) : 0;
        config.ram = json_get(line, "ram", number, sizeof number) ? atoi(number) : 0;
        config.cores = json_get(line, "cores", number, sizeof number) ? atoi(number) : 0;
        if (config.cpu < 0 || config.cpu > 100) config.cpu = 0;
        if (config.ram < 0 || config.ram > 1 << 20) config.ram = 0;
        if (config.cores < 0) config.cores = 0;
        config.gpu = !json_get(line, "gpu", gpu, sizeof gpu) ? 2 : !strcmp(gpu, "idle") ? 0 : !strcmp(gpu, "below") ? 1 : 2;
        if (!++config.generation) config.generation = 1;
    } else if (!strcmp(type, "clear")) config.on = 0;
    else if (!strcmp(type, "toast")) {
        char title[64], text[128];
        if (json_get(line, "title", title, sizeof title) && json_get(line, "text", text, sizeof text)) show_toast(title, text);
        else send_error("The toast message isn't valid.");
        LeaveCriticalSection(&lock);
        return;
    } else send_error("The message isn't supported.");
    last_clients = -1;
    tick();
    LeaveCriticalSection(&lock);
}

int main(void) {
    char line[1024];
    BOOL(WINAPI * set_awareness)(HANDLE) = (BOOL(WINAPI *)(HANDLE))(void *)GetProcAddress(GetModuleHandleW(L"user32.dll"), "SetProcessDpiAwarenessContext");
    if (set_awareness) set_awareness((HANDLE)-4);
    InitializeCriticalSection(&lock);
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
    tick();
    return 0;
}
