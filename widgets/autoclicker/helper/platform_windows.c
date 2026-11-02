/*
 * Windows input, clicks, timing, and indicator for the autoclicker helper.
 *
 * Keybinds come from low-level keyboard and mouse hooks, which see physical input only after
 * skipping events marked as injected. Clicks use SendInput.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <mmsystem.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#include "clicker.h"

#ifndef CREATE_WAITABLE_TIMER_HIGH_RESOLUTION
#define CREATE_WAITABLE_TIMER_HIGH_RESOLUTION 0x00000002
#endif
#ifndef LLMHF_LOWER_IL_INJECTED
#define LLMHF_LOWER_IL_INJECTED 0x00000002
#endif

#define WM_INDICATOR (WM_APP + 1)
/* Marks clicks this helper sends, alongside the system's injected flag. */
#define SYNTHETIC_TAG 0x546F6F6C

static LONGLONG frequency;
static HANDLE timer;
static HWND indicator;
static HFONT font;
static UINT dpi = 96;
/* The position version last applied, and whether the indicator is being dragged. */
static int placed_version = -1;
static int dragging;

uint64_t platform_now_ns(void) {
    LARGE_INTEGER counter;
    QueryPerformanceCounter(&counter);
    LONGLONG seconds = counter.QuadPart / frequency;
    LONGLONG rest = counter.QuadPart % frequency;
    return (uint64_t)seconds * 1000000000ull + (uint64_t)(rest * 1000000000ll / frequency);
}

void platform_wait_until_ns(uint64_t deadline) {
    uint64_t now = platform_now_ns();
    if (deadline <= now) return;
    LARGE_INTEGER due;
    due.QuadPart = -(LONGLONG)((deadline - now) / 100);
    if (!due.QuadPart) due.QuadPart = -1;
    if (SetWaitableTimer(timer, &due, 0, NULL, NULL, FALSE)) WaitForSingleObject(timer, INFINITE);
}

int platform_click(int button) {
    INPUT inputs[2] = {0};
    inputs[0].type = inputs[1].type = INPUT_MOUSE;
    inputs[0].mi.dwFlags = button == 2 ? MOUSEEVENTF_RIGHTDOWN : button == 3 ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_LEFTDOWN;
    inputs[1].mi.dwFlags = button == 2 ? MOUSEEVENTF_RIGHTUP : button == 3 ? MOUSEEVENTF_MIDDLEUP : MOUSEEVENTF_LEFTUP;
    inputs[0].mi.dwExtraInfo = inputs[1].mi.dwExtraInfo = SYNTHETIC_TAG;
    return SendInput(2, inputs, sizeof(INPUT)) == 2;
}

static LRESULT CALLBACK on_key(int code, WPARAM message, LPARAM data) {
    if (code == HC_ACTION) {
        const KBDLLHOOKSTRUCT *key = (const KBDLLHOOKSTRUCT *)data;
        if (!(key->flags & LLKHF_INJECTED)) {
            int scan = (int)key->scanCode | (key->flags & LLKHF_EXTENDED ? 0x100 : 0);
            core_input(scan, message == WM_KEYDOWN || message == WM_SYSKEYDOWN);
        }
    }
    return CallNextHookEx(NULL, code, message, data);
}

static LRESULT CALLBACK on_mouse(int code, WPARAM message, LPARAM data) {
    if (code == HC_ACTION && message != WM_MOUSEMOVE) {
        const MSLLHOOKSTRUCT *mouse = (const MSLLHOOKSTRUCT *)data;
        if (!(mouse->flags & (LLMHF_INJECTED | LLMHF_LOWER_IL_INJECTED)) && mouse->dwExtraInfo != SYNTHETIC_TAG) {
            switch (message) {
            case WM_LBUTTONDOWN: core_input(MOUSE_CODE(1), 1); break;
            case WM_LBUTTONUP: core_input(MOUSE_CODE(1), 0); break;
            case WM_RBUTTONDOWN: core_input(MOUSE_CODE(2), 1); break;
            case WM_RBUTTONUP: core_input(MOUSE_CODE(2), 0); break;
            case WM_MBUTTONDOWN: core_input(MOUSE_CODE(3), 1); break;
            case WM_MBUTTONUP: core_input(MOUSE_CODE(3), 0); break;
            case WM_XBUTTONDOWN:
            case WM_XBUTTONUP:
                core_input(MOUSE_CODE(HIWORD(mouse->mouseData) == XBUTTON1 ? 4 : 5), message == WM_XBUTTONDOWN);
                break;
            default: break;
            }
        }
    }
    return CallNextHookEx(NULL, code, message, data);
}

static int is_roblox(HWND window) {
    DWORD pid = 0;
    if (!window || !GetWindowThreadProcessId(window, &pid) || !pid) return 0;
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!process) return 0;
    wchar_t path[MAX_PATH * 2];
    DWORD length = sizeof path / sizeof path[0];
    int found = 0;
    if (QueryFullProcessImageNameW(process, 0, path, &length)) {
        static const wchar_t name[] = L"\\RobloxPlayerBeta.exe";
        size_t suffix = sizeof name / sizeof name[0] - 1;
        found = length >= suffix && _wcsicmp(path + length - suffix, name) == 0;
    }
    CloseHandle(process);
    return found;
}

static void CALLBACK on_foreground(HWINEVENTHOOK hook, DWORD event, HWND window, LONG object, LONG child,
                                   DWORD thread, DWORD time) {
    (void)hook, (void)event, (void)object, (void)child, (void)thread, (void)time;
    core_focus(is_roblox(window));
    SetWindowPos(indicator, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
}

static int scaled(int value) { return MulDiv(value, (int)dpi, 96); }

/* Places the indicator at its saved position on the primary screen, kept fully on screen. */
static void place_indicator(void) {
    int width = scaled(128), height = scaled(28), margin = scaled(12);
    int screen_width = GetSystemMetrics(SM_CXSCREEN), screen_height = GetSystemMetrics(SM_CYSCREEN);
    double fraction_x, fraction_y;
    core_indicator_position(&fraction_x, &fraction_y);
    int x = fraction_x < 0 ? margin : (int)(fraction_x * screen_width);
    int y = fraction_y < 0 ? screen_height - margin - height : (int)(fraction_y * screen_height);
    x = x < 0 ? 0 : x > screen_width - width ? screen_width - width : x;
    y = y < 0 ? 0 : y > screen_height - height ? screen_height - height : y;
    SetWindowPos(indicator, HWND_TOPMOST, x, y, width, height, SWP_NOACTIVATE);
}

static double clamp01(double value) { return value < 0 ? 0 : value > 1 ? 1 : value; }

/*
 * Draws the indicator with per-pixel alpha, so its background can be see-through while the text
 * and dot stay solid. The text is drawn white on black first and its brightness is used as coverage.
 */
static void render_indicator(void) {
    int width = scaled(128), height = scaled(28);
    BITMAPINFO info = {0};
    info.bmiHeader.biSize = sizeof info.bmiHeader;
    info.bmiHeader.biWidth = width;
    info.bmiHeader.biHeight = -height;
    info.bmiHeader.biPlanes = 1;
    info.bmiHeader.biBitCount = 32;
    info.bmiHeader.biCompression = BI_RGB;
    HDC screen = GetDC(NULL);
    HDC dc = CreateCompatibleDC(screen);
    uint32_t *pixels = NULL;
    HBITMAP bitmap = CreateDIBSection(screen, &info, DIB_RGB_COLORS, (void **)&pixels, NULL, 0);
    if (!bitmap) {
        DeleteDC(dc);
        ReleaseDC(NULL, screen);
        return;
    }
    HGDIOBJ old_bitmap = SelectObject(dc, bitmap);
    memset(pixels, 0, (size_t)width * (size_t)height * 4);

    enum indicator_state state = core_indicator_state();
    wchar_t text[32];
    if (state == INDICATOR_ON) _snwprintf(text, 32, L"On \x00B7 %d CPS", core_indicator_cps());
    else wcscpy(text, state == INDICATOR_PAUSED ? L"Paused" : L"Off");
    text[31] = 0;
    SetBkMode(dc, TRANSPARENT);
    SetTextColor(dc, RGB(255, 255, 255));
    HGDIOBJ old_font = SelectObject(dc, font);
    RECT area = {scaled(28), 0, width, height};
    DrawTextW(dc, text, -1, &area, DT_SINGLELINE | DT_VCENTER | DT_LEFT | DT_NOPREFIX);
    SelectObject(dc, old_font);
    GdiFlush();

    COLORREF color = state == INDICATOR_ON ? RGB(34, 197, 94) : state == INDICATOR_PAUSED ? RGB(245, 158, 11)
                                                                                         : RGB(140, 140, 145);
    /* A clear background keeps a trace of alpha so the whole indicator still takes the mouse. */
    double background = core_indicator_background() < 0.02 ? 0.02 : core_indicator_background();
    double radius = scaled(9), dot_radius = scaled(8) / 2.0, dot_x = scaled(12) + dot_radius, dot_y = height / 2.0;
    for (int y = 0; y < height; y++) {
        for (int x = 0; x < width; x++) {
            uint32_t *pixel = &pixels[y * width + x];
            double px = x + 0.5, py = y + 0.5;
            double cx = px < radius ? radius : px > width - radius ? width - radius : px;
            double cy = py < radius ? radius : py > height - radius ? height - radius : py;
            double shape = clamp01(radius - sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy)) + 0.5);
            double dot = clamp01(dot_radius - sqrt((px - dot_x) * (px - dot_x) + (py - dot_y) * (py - dot_y)) + 0.5);
            double glyph = ((*pixel >> 8) & 0xFF) / 255.0;
            double a = background * shape, r = 20 * a, g = 20 * a, b = 22 * a;
            r = GetRValue(color) * dot + r * (1 - dot);
            g = GetGValue(color) * dot + g * (1 - dot);
            b = GetBValue(color) * dot + b * (1 - dot);
            a = dot + a * (1 - dot);
            r = 245 * glyph + r * (1 - glyph);
            g = 245 * glyph + g * (1 - glyph);
            b = 245 * glyph + b * (1 - glyph);
            a = glyph + a * (1 - glyph);
            *pixel = (uint32_t)(a * 255 + 0.5) << 24 | (uint32_t)(r + 0.5) << 16 | (uint32_t)(g + 0.5) << 8 |
                     (uint32_t)(b + 0.5);
        }
    }

    POINT origin = {0, 0};
    SIZE size = {width, height};
    BLENDFUNCTION blend = {AC_SRC_OVER, 0, 255, AC_SRC_ALPHA};
    UpdateLayeredWindow(indicator, screen, NULL, &size, dc, &origin, 0, &blend, ULW_ALPHA);
    SelectObject(dc, old_bitmap);
    DeleteObject(bitmap);
    DeleteDC(dc);
    ReleaseDC(NULL, screen);
}

/* Shows or hides the indicator to match the setting. */
static void show_indicator(void) {
    int visible = core_indicator_visible();
    if (visible != (IsWindowVisible(indicator) != 0)) ShowWindow(indicator, visible ? SW_SHOWNOACTIVATE : SW_HIDE);
}

static LRESULT CALLBACK indicator_proc(HWND window, UINT message, WPARAM wide, LPARAM data) {
    switch (message) {
    case WM_INDICATOR:
        if (!dragging && placed_version != core_indicator_position_version()) {
            placed_version = core_indicator_position_version();
            place_indicator();
        }
        render_indicator();
        show_indicator();
        return 0;
    case WM_NCHITTEST:
        return HTCAPTION;
    case WM_SETCURSOR:
        SetCursor(LoadCursor(NULL, IDC_SIZEALL));
        return TRUE;
    case WM_ENTERSIZEMOVE:
        dragging = 1;
        return 0;
    case WM_EXITSIZEMOVE: {
        dragging = 0;
        RECT bounds;
        GetWindowRect(window, &bounds);
        core_indicator_moved((double)bounds.left / GetSystemMetrics(SM_CXSCREEN),
                             (double)bounds.top / GetSystemMetrics(SM_CYSCREEN));
        return 0;
    }
    default:
        break;
    }
    return DefWindowProcW(window, message, wide, data);
}

void platform_indicator_changed(void) {
    if (indicator) PostMessageW(indicator, WM_INDICATOR, 0, 0);
}

int platform_init(void) {
    LARGE_INTEGER counter_frequency;
    QueryPerformanceFrequency(&counter_frequency);
    frequency = counter_frequency.QuadPart;
    timer = CreateWaitableTimerExW(NULL, NULL, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS);
    if (!timer) {
        timeBeginPeriod(1);
        timer = CreateWaitableTimerW(NULL, TRUE, NULL);
    }
    if (!timer) return 1;

    HMODULE user = GetModuleHandleW(L"user32.dll");
    BOOL(WINAPI * set_awareness)(HANDLE) = (BOOL(WINAPI *)(HANDLE))(void *)GetProcAddress(user, "SetProcessDpiAwarenessContext");
    UINT(WINAPI * system_dpi)(void) = (UINT(WINAPI *)(void))(void *)GetProcAddress(user, "GetDpiForSystem");
    if (set_awareness) set_awareness((HANDLE)-4);
    else SetProcessDPIAware();
    if (system_dpi) dpi = system_dpi();

    HINSTANCE instance = GetModuleHandleW(NULL);
    WNDCLASSW type = {0};
    type.lpfnWndProc = indicator_proc;
    type.hInstance = instance;
    type.lpszClassName = L"ToolbloxAutoclickerIndicator";
    if (!RegisterClassW(&type)) return 1;
    indicator = CreateWindowExW(WS_EX_TOPMOST | WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                                type.lpszClassName, L"Autoclicker", WS_POPUP, 0, 0, scaled(128), scaled(28), NULL, NULL,
                                instance, NULL);
    if (!indicator) return 1;
    font = CreateFontW(-scaled(12), 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                       CLIP_DEFAULT_PRECIS, ANTIALIASED_QUALITY, DEFAULT_PITCH, L"Segoe UI");
    return 0;
}

/* Hooks are installed here, after calibration, so input never waits on a thread that isn't pumping messages. */
void platform_run(void) {
    HINSTANCE instance = GetModuleHandleW(NULL);
    int hooked = SetWindowsHookExW(WH_KEYBOARD_LL, on_key, instance, 0) && SetWindowsHookExW(WH_MOUSE_LL, on_mouse, instance, 0);
    core_permissions(hooked, 1);
    SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, NULL, on_foreground, 0, 0, WINEVENT_OUTOFCONTEXT);
    core_focus(is_roblox(GetForegroundWindow()));
    placed_version = core_indicator_position_version();
    place_indicator();
    render_indicator();
    show_indicator();
    MSG message;
    while (GetMessageW(&message, NULL, 0, 0) > 0) {
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }
}

void platform_open_permissions(void) {}
