/*
 * The Rogue Lineage helper for Windows.
 *
 * While Roblox is focused it reads the screen for two overlays, each drawn in its own click-through
 * window. The mana bar overlay reads how full the mana bar is and draws the percentage and the
 * tracked spell ranges over it. The cooldown overlay reads which skill is in each hotbar slot,
 * follows which slot is selected, and starts a skill's cooldown when the left mouse button is
 * pressed while its slot is selected. It shades the slot until the cooldown ends. A slot's name is
 * read with the OCR engine built into Windows, on its own thread, whenever the slot's ink changes.
 *
 * While the cooldown overlay is on, or a widget asks for it, it also watches for the backpack: slots
 * like the hotbar's above it. Open, it reads each slot's name like the hotbar's, shades skills that
 * are cooling down, and tells the widget it's open, so other widgets can react.
 *
 * Automation runs one task at a time on its own thread, started and stopped by its key while Roblox
 * is focused: snap training casts a spell and puts it away while mana stays in the spell's range,
 * and blacksmithing picks each item and clicks the anvil and hammer. Only these tasks send input,
 * with SendInput, and only while the Roblox window they started in is focused. A label over that
 * window shows the task while it runs. Everything they send carries INPUT_TAG, which the hooks skip. The helper never touches the Roblox process.
 *
 * While snap training is on and game sound is allowed, it listens to the focused
 * Roblox process's sound, and only that process's, for the mana-full chime and spell casts (see
 * audio.h). The chime ends snap training's charging, and casts heard are counted.
 *
 * While the cooldown overlay or a task is on, low-level hooks observe the hotbar keys, the task
 * keys, and the left mouse button, and pass every event on unchanged. Its windows are left out of screen capture, so the helper reads the game's pixels and
 * not its own drawing. Screenshots and recordings of the screen leave them out too. Where Windows can't
 * leave them out, the helper reads the focused Roblox window on its own instead (see `source`),
 * and screenshots show the overlays.
 *
 * In debug mode it also labels what both overlays detect on a third click-through window over the
 * Roblox window, and writes each step, and why a step failed, to the Toolblox log. Anything
 * expected but missing from the labels is explained there.
 *
 * It reads one JSON object per line from standard input and writes one per line to standard
 * output. Only the main thread writes.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <mmsystem.h>
#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#include "audio.h"
#include "capture.h"
#include "detect.h"
#include "ocr.h"

#define HELPER_VERSION "1.5.0"
/* The focused process the helper reads, as the end of its path. */
#ifndef TARGET_EXE
#define TARGET_EXE L"\\RobloxPlayerBeta.exe"
#endif

#ifndef WDA_EXCLUDEFROMCAPTURE
#define WDA_EXCLUDEFROMCAPTURE 0x00000011
#endif

#define WM_CONFIGURE (WM_APP + 1)
#define WM_DESCRIBE (WM_APP + 2)
#define WM_TEST (WM_APP + 3)
#define WM_SKILL (WM_APP + 4)
#define WM_HOTBAR_KEY (WM_APP + 5)
#define WM_LEFT_CLICK (WM_APP + 6)
#define WM_SLOT_TEXT (WM_APP + 7)
#define WM_READER (WM_APP + 8)
#define WM_TASK_KEY (WM_APP + 9)
#define WM_TASK_DONE (WM_APP + 10)
#define WM_PICK (WM_APP + 11)
#define WM_AUDIO (WM_APP + 12)
#define TICK_MS 16
/* Time between looks for the bar, the hotbar, and the Gate prompt, on the whole Roblox window. */
#define SEARCH_MS 500
#define PROMPT_MS 500
/* Time between readings of the names in the hotbar's slots. */
#define NAMES_MS 250
/*
 * The selected slot follows the hotbar keys at once. When the screen shows a different selection
 * this long after the last key, such as after a key typed into chat, the screen wins.
 */
#define SELECTION_SYNC_MS 250
/*
 * A right click is a Gate cast when Gate is equipped in the hotbar, its prompt appears soon after,
 * Gate stays equipped, and mana drains slower than it fills at every check (see judge_cast).
 * Other right clicks, such as turning the camera, leave mana filling or draining at its full rate.
 * When the hotbar can't be read, the prompt alone shows that it was Gate. While a cast is judged,
 * the prompt is looked for every CAST_PROMPT_SCAN_MS.
 */
#define CAST_QUIET_MS 1000
#define CAST_PROMPT_SCAN_MS 50
/* Right clicks outside these percentages aren't judged. An empty bar can't cast, and a full bar holds still either way. */
#define CAST_MIN_PERCENT 2
#define CAST_MAX_PERCENT 98
/* The fill rate is measured over windows this long, from rises of at least RATE_MIN percent a second. */
#define RATE_WINDOW_MS 250
#define RATE_MIN 5.0
/* Ticks without the frame, or the hotbar, before it's looked for again. */
#define LOST_TICKS 20
#define STATUS_MS 100
#define FLASH_HOLD_MS 350
#define FLASH_MS 1100
#define FLASH_ALPHA 150
#define MAX_ZONES 16
/* ponytail: a fixed table, as the catalogue is hand-written. Grow it with the catalogue. */
#define MAX_SKILLS 512
#define MAX_COOLDOWN_MS 3600000
#define MANA_UNKNOWN 0xFFFFFFFFu
#define DARK 0x141416
#define LIGHT 0xF5F5F5
/* Debug mode's colors: something found or a supported skill, a name not in the catalogue, and an empty slot. */
#define DEBUG_FOUND 0x2EA043
#define DEBUG_UNKNOWN 0xD29922
#define DEBUG_EMPTY 0x8B8B8B
/* How long debug mode shows the result of a Gate cast. */
#define DEBUG_CAST_MS 3000
/* Text with fewer letters than this, across every reading, doesn't show what a slot holds. */
#define SLOT_MIN_LETTERS 3
/* Hotbar slots that hold nothing, and slots whose name isn't in the catalogue. */
#define SLOT_EMPTY -1
#define SLOT_UNKNOWN -2

enum state { STATE_OFF, STATE_WAITING, STATE_SEARCHING, STATE_TRACKING };

struct zone {
    int min, max;
    uint32_t color;
    wchar_t name[32];
};

struct config {
    int enabled, gate, sound, gate_min, gate_max, zone_count;
    int cooldowns, shade_opacity, countdown, debug, backpack;
    uint32_t shade;
    struct zone zones[MAX_ZONES];
    /*
     * Automation: whether each task is on, the virtual key that starts and stops it, and its
     * settings. Spots on screen are in ten-thousandths of the Roblox window's client area, or -1.
     * `train_name` is the spell snap training casts, as the hotbar shows it. Its slot is found on
     * the hotbar when training starts, and `train_slot` holds it for the task.
     */
    int train, train_key, train_slot, train_min, train_max, train_middle;
    char train_name[32];
    /* Whether game sound may be listened to. */
    int listen;
    int smith, smith_key, smith_steps, smith_slots[SMITH_STEPS], smith_clicks[SMITH_STEPS], smith_count;
    int anvil_x, anvil_y, hammer_x, hammer_y, smith_click_ms, smith_pick_ms, smith_before_ms, smith_after_ms;
};

/* A skill from the catalogue. `ready_at` is when its cooldown ends. */
struct skill {
    char id[32], name[32];
    ULONGLONG cooldown, ready_at;
};

/* A copy of a slot's interior waiting for the OCR thread. `serial` tells a result from an outdated one. */
struct request {
    int pending, serial;
    struct image image;
    struct slot interior;
};

/* The text OCR read from a slot at each of OCR_HEIGHTS, one line each, posted to the main thread. */
struct reading {
    int slot, serial;
    char texts[256];
};

/* A click-through window and the premultiplied pixels drawn into it. */
struct layer {
    HWND window;
    HDC dc, glyph_dc;
    HBITMAP bitmap, glyph_bitmap;
    uint32_t *pixels, *glyph;
    int width, height, shown, x, y;
};

static CRITICAL_SECTION config_lock;
static struct config incoming, config;
static int supported;
/* Why the windows couldn't be left out of capture: the first error and the Windows build it happened on. */
static DWORD support_error, windows_build;

static HWND flash;
static struct layer mana_layer, cooldown_layer, debug_layer, backpack_layer, task_layer;
static HDC screen_dc, capture_dc;
/*
 * Where captures come from. GRAPHICS reads the focused Roblox window through
 * Windows.Graphics.Capture (capture.h), which leaves out the overlays above it. SCREEN copies the
 * screen, which leaves them out only where Windows can exclude them from capture. PRINT renders the
 * window with PrintWindow, the slowest, for where neither works. `frame_blank` is set while the
 * window comes back all black.
 */
enum { SOURCE_SCREEN, SOURCE_GRAPHICS, SOURCE_PRINT };
static const char *const SOURCE_NAMES[] = {"screen", "graphics", "print"};
static int source = SOURCE_SCREEN, frame_blank = -1;
static HDC frame_dc;
static HBITMAP frame_bitmap;
static uint8_t *frame_pixels;
static HWND frame_window;
static int frame_width, frame_height;
static ULONGLONG frame_at;
static HBITMAP capture_bitmap;
static uint8_t *capture_pixels;
static int capture_width, capture_height;
static HFONT pill_font, label_font, flash_font, countdown_font, debug_font, debug_label_font;

/* The bar in Roblox client coordinates, and the client size it was found at. */
static struct bar bar;
static int locked, lost, client_width, client_height;
/* The mana overlay's rectangle in client coordinates. */
static RECT frame;
static int drawn_percent = -1, redraw;
static uint32_t drawn_mana;

static enum state state = STATE_OFF;
static int percent, prompt;
static uint32_t mana = MANA_UNKNOWN;
static ULONGLONG last_search, last_prompt_scan, pending_at, quiet_until, last_status, flash_at;
static int pending, pending_percent, right_down, status_dirty = 1, gate_held = -1;
static struct cast cast;
/* The Gate prompt's text box in client coordinates, while `prompt` is set. */
static struct box prompt_box;
/* How fast mana fills, in percent per second, or 0 until a fill has been seen. Mana drains at the same rate. */
static double fill_rate;
static wchar_t flash_title[64], flash_detail[64];

static struct skill skills[MAX_SKILLS];
static int skill_count;
/*
 * The hotbar's rectangle in client coordinates, and its slots inside that rectangle. `skill_in` holds
 * each slot's index in `skills`, SLOT_EMPTY, or SLOT_UNKNOWN. `interiors` are the slots as last read.
 */
static enum state hotbar_state = STATE_OFF;
static RECT hotbar;
static struct slot slots[HOTBAR_SLOTS], interiors[HOTBAR_SLOTS];
/*
 * The last skill each slot was confidently read as, or -1. A slot reads as empty or changed for a
 * moment while its selection animates, so cooldowns and clicks use this until another name is read.
 */
static int last_skill[HOTBAR_SLOTS];
/*
 * The open backpack: its slots in client coordinates and relative to `pack_box`, which its layer
 * covers, and what each reads. Readings are kept by position across closing and reopening.
 */
#define BACKPACK_SEARCH_MS 100
#define BACKPACK_CLOSE_SEARCHES 3
static struct slot pack[BACKPACK_SLOTS], pack_shades[BACKPACK_SLOTS], pack_box;
static int pack_count, pack_open, pack_missed, pack_sent[BACKPACK_SLOTS], pack_serials[BACKPACK_SLOTS], pack_skill[BACKPACK_SLOTS];
static uint8_t pack_glyphs[BACKPACK_SLOTS][GLYPH_SIZE];
static char pack_texts[BACKPACK_SLOTS][256];
static ULONGLONG last_pack_search;

/* A left click waiting for the next hotbar read to show whether `click_slot` was equipped, or 0. */
static ULONGLONG click_at;
static int click_slot;
/* How long a click waits for the hotbar to show its slot selected, as the game draws a key press a few frames late. */
#define CLICK_CONFIRM_MS 300
/*
 * What each slot showed at the last name read: 0 nothing yet, 1 empty, 2 the glyph in `seen_glyphs`.
 * A slot counts as changed only when two reads in a row agree, so frames mid-animation are skipped.
 */
static int seen[HOTBAR_SLOTS];
static uint8_t seen_glyphs[HOTBAR_SLOTS][GLYPH_SIZE];
static void use_slot(int slot, ULONGLONG now);
static int slot_count, skill_in[HOTBAR_SLOTS], hotbar_locked, hotbar_lost, hotbar_dirty, small_hotbar;
static int selected = -1;
/*
 * Debug mode: what was last written to the log for steps that are logged only when they change,
 * the last Gate cast's result and until when it shows, and a hash of what the debug layer shows.
 */
static int logged_focus = -1, logged_hotbar_count = -1, logged_held = -2;
static uint32_t logged_mana = MANA_UNKNOWN;
static double logged_rate;
static wchar_t cast_result[96];
static ULONGLONG cast_result_until;
static uint64_t debug_drawn;
static const char *const KEY_NAMES[HOTBAR_SLOTS] = {"1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "-", "="};
/*
 * For each slot: the glyph it had when it was last sent to OCR, the serial of that request, and the
 * text read. A slot is read again only when its glyph changes to a different name.
 */
static uint8_t sent_glyphs[HOTBAR_SLOTS][GLYPH_SIZE];
static int sent[HOTBAR_SLOTS], serials[HOTBAR_SLOTS], reader = 1;
static char texts[HOTBAR_SLOTS][256];
static CRITICAL_SECTION request_lock;
/* Text requests: the hotbar's slots, then the backpack's from HOTBAR_SLOTS on. */
#define ALL_SLOTS (HOTBAR_SLOTS + BACKPACK_SLOTS)
static struct request requests[ALL_SLOTS];
static HANDLE request_ready;
static unsigned held_keys;
static ULONGLONG last_hotbar_search, last_names;
/* When the input thread last saw a hotbar key, before the game could draw its effect. */
static volatile LONG64 key_seen;
static HANDLE watcher;
static DWORD watcher_id;

/*
 * Automation. `job` is the settings a task started with, and `task_window` the Roblox window it
 * sends to. The main thread writes `mana_level` while the mana bar is read, for snap training.
 * ponytail: training sees mana once per TICK_MS tick, later while a full-window scan runs, and a
 * stale level for up to LOST_TICKS after the bar is covered. The band's margin absorbs this; give
 * training its own capture of the bar's column if casts land outside it.
 */
enum task { TASK_NONE, TASK_TRAIN, TASK_SMITH };
static const char *const TASK_NAMES[] = {"", "train", "smith"};
#define INPUT_TAG 0x524C4155
#define SCAN_CHARGE 0x22
#define TRAIN_STEP_MS 5
#define TRAIN_REST_MS 100
#define TRAIN_G_HOLD_MS 200
#define TRAIN_G_GAP_MS 20
/* How long training waits for the mana bar to come back before it stops. */
#define TRAIN_LOST_MS 2000
#define SMITH_ARRIVE_MS 20
#define SMITH_HOLD_MS 5
#define PROGRESS_MS 250
static struct config job;
static HANDLE automation, automation_stop;
static HWND task_window;
static volatile LONG task, task_count, mana_valid;
static volatile double mana_level;
static const char *volatile task_reason;
static int held_charge, held_button, emitted_count = -1;
static DWORD charge_since;
static ULONGLONG last_progress;
/* The task keys the hook watches, by task, and which are held. */
static volatile LONG task_keys[3];
static unsigned task_held;
/* The spot the next left click in Roblox sets: 0 for none, 1 for the anvil, 2 for the hammer. */
static int picking;
static void emit_task(int running, const char *reason);
/*
 * Game sound: the Roblox process listened to, or 0, the listening state, when a failed start may be
 * retried, and what's been heard. `full_at` is when the chime was last heard, by timeGetTime.
 */
enum audio_state { AUDIO_OFF, AUDIO_STARTING, AUDIO_ON, AUDIO_FAILED };
static const char *const AUDIO_STATES[] = {"off", "starting", "listening", "failed"};
#define AUDIO_RETRY_MS 5000
static DWORD audio_process;
static int audio_state, chimes, casts_heard, cast_match;
static long audio_error;
static ULONGLONG audio_retry_at;
static volatile DWORD full_at;
static volatile LONG task_heard;
static void update_audio(ULONGLONG now);
static void show_task(POINT origin);
static void stop_task(void);

static void emit(const char *format, ...) {
    va_list arguments;
    va_start(arguments, format);
    vprintf(format, arguments);
    va_end(arguments);
    putchar('\n');
    fflush(stdout);
}

/*
 * Writes a line to the Toolblox log while debug mode is on. `level` is "info" for each step and
 * "warn" for a step that failed.
 */
static void note(const char *level, const char *format, ...) {
    char message[600], escaped[1400];
    size_t used = 0;
    if (!config.debug) return;
    va_list arguments;
    va_start(arguments, format);
    vsnprintf(message, sizeof message, format, arguments);
    va_end(arguments);
    for (const unsigned char *c = (const unsigned char *)message; *c && used + 7 < sizeof escaped; c++) {
        if (*c == '"' || *c == '\\') {
            escaped[used++] = '\\';
            escaped[used++] = (char)*c;
        } else if (*c < 0x20) {
            used += (size_t)snprintf(escaped + used, sizeof escaped - used, "\\u%04x", *c);
        } else {
            escaped[used++] = (char)*c;
        }
    }
    escaped[used] = 0;
    emit("{\"type\":\"log\",\"level\":\"%s\",\"message\":\"%s\"}", level, escaped);
}

/* Copies the readings of a slot's text, joined by " / ", for the log. */
static void readings(const char *texts, char *out, size_t size) {
    size_t used = 0;
    out[0] = 0;
    for (const char *c = texts; *c && used + 4 < size; c++) {
        if (*c != '\n') out[used++] = *c;
        else if (c[1]) used += (size_t)snprintf(out + used, size - used, " / ");
    }
    out[used] = 0;
}

static int is_target(HWND window) {
    static HWND last;
    static int result;
    if (window == last) return result;
    last = window;
    result = 0;
    DWORD pid = 0;
    if (!window || !GetWindowThreadProcessId(window, &pid) || !pid) return 0;
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!process) return 0;
    wchar_t path[MAX_PATH * 2];
    DWORD length = sizeof path / sizeof path[0];
    if (QueryFullProcessImageNameW(process, 0, path, &length)) {
        static const wchar_t name[] = TARGET_EXE;
        size_t suffix = sizeof name / sizeof name[0] - 1;
        result = length >= suffix && _wcsicmp(path + length - suffix, name) == 0;
    }
    CloseHandle(process);
    return result;
}

static void *create_bitmap(HDC dc, HBITMAP *bitmap, int width, int height) {
    BITMAPINFO info = {0};
    void *pixels = NULL;
    info.bmiHeader.biSize = sizeof info.bmiHeader;
    info.bmiHeader.biWidth = width;
    info.bmiHeader.biHeight = -height;
    info.bmiHeader.biPlanes = 1;
    info.bmiHeader.biBitCount = 32;
    info.bmiHeader.biCompression = BI_RGB;
    HBITMAP created = CreateDIBSection(screen_dc, &info, DIB_RGB_COLORS, &pixels, NULL, 0);
    if (!created) return NULL;
    SelectObject(dc, created);
    if (*bitmap) DeleteObject(*bitmap);
    *bitmap = created;
    return pixels;
}

/* ponytail: PrintWindow renders the whole client at most every PRINT_REUSE_MS, so readings run at about 20 a second there. */
#define PRINT_REUSE_MS 50

/* Renders `window`'s client area with PrintWindow, unless the last frame is recent. */
static int print_frame(HWND window, const uint8_t **pixels, int *width, int *height, int *stride) {
    RECT client;
    if (!GetClientRect(window, &client) || client.right < 1 || client.bottom < 1) return 0;
    ULONGLONG now = GetTickCount64();
    if (window != frame_window || client.right != frame_width || client.bottom != frame_height || now - frame_at >= PRINT_REUSE_MS) {
        if (client.right != frame_width || client.bottom != frame_height) {
            uint8_t *next = create_bitmap(frame_dc, &frame_bitmap, client.right, client.bottom);
            if (!next) return 0;
            frame_pixels = next;
            frame_width = client.right;
            frame_height = client.bottom;
        }
        frame_window = NULL;
        if (!PrintWindow(window, frame_dc, PW_CLIENTONLY | PW_RENDERFULLCONTENT)) return 0;
        GdiFlush();
        frame_window = window;
        frame_at = now;
    }
    *pixels = frame_pixels;
    *width = frame_width;
    *height = frame_height;
    *stride = frame_width * 4;
    return 1;
}

/* Reports when the window's frames start or stop coming back all black. */
static void check_blank(const uint8_t *pixels, int width, int height, int stride) {
    int blank = 1;
    for (int y = 0; y < height && blank; y += 16)
        for (int x = 0; x < width && blank; x += 16) blank = !(*(const uint32_t *)(pixels + (size_t)y * stride + (size_t)x * 4) & 0xffffff);
    if (blank == frame_blank) return;
    frame_blank = blank;
    emit("{\"type\":\"capture\",\"blank\":%s}", blank ? "true" : "false");
    if (blank) note("warn", "The Roblox window comes back black when read on its own (%s), so nothing can be read from it.", SOURCE_NAMES[source]);
}

/*
 * Copies a rectangle of the screen, in screen coordinates. Unless the source is the screen, it's
 * cut from the focused Roblox window's frame, and parts outside the window are black. The image is
 * valid until the next capture.
 */
static int capture(int x, int y, int width, int height, struct image *image) {
    if (width > capture_width || height > capture_height) {
        int next_width = width > capture_width ? width : capture_width;
        int next_height = height > capture_height ? height : capture_height;
        uint8_t *pixels = create_bitmap(capture_dc, &capture_bitmap, next_width, next_height);
        if (!pixels) return 0;
        capture_pixels = pixels;
        capture_width = next_width;
        capture_height = next_height;
    }
    if (source == SOURCE_SCREEN) {
        if (!BitBlt(capture_dc, 0, 0, width, height, screen_dc, x, y, SRCCOPY)) return 0;
        GdiFlush();
    } else {
        HWND window = GetForegroundWindow();
        POINT origin = {0, 0};
        const uint8_t *frame;
        int frame_w, frame_h, stride;
        if (!is_target(window) || !ClientToScreen(window, &origin)) return 0;
        if (!(source == SOURCE_GRAPHICS ? graphics_frame(window, &frame, &frame_w, &frame_h, &stride) : print_frame(window, &frame, &frame_w, &frame_h, &stride))) return 0;
        check_blank(frame, frame_w, frame_h, stride);
        x -= origin.x;
        y -= origin.y;
        for (int row = 0; row < height; row++) {
            uint8_t *out = capture_pixels + (size_t)row * capture_width * 4;
            memset(out, 0, (size_t)width * 4);
            int from_y = y + row, start = x < 0 ? -x : 0, end = x + width > frame_w ? frame_w - x : width;
            if (from_y < 0 || from_y >= frame_h || start >= end) continue;
            memcpy(out + (size_t)start * 4, frame + (size_t)from_y * stride + (size_t)(x + start) * 4, (size_t)(end - start) * 4);
        }
    }
    *image = (struct image){capture_pixels, width, height, capture_width * 4};
    return 1;
}

/* Sizes a layer's pixels. Returns 0 when memory runs out, and the layer then can't be drawn. */
static int resize(struct layer *layer, int width, int height) {
    uint32_t *pixels = create_bitmap(layer->dc, &layer->bitmap, width, height);
    uint32_t *glyph = pixels ? create_bitmap(layer->glyph_dc, &layer->glyph_bitmap, width, height) : NULL;
    if (!glyph) {
        layer->pixels = layer->glyph = NULL;
        layer->width = layer->height = 0;
        return 0;
    }
    layer->pixels = pixels;
    layer->glyph = glyph;
    layer->width = width;
    layer->height = height;
    memset(glyph, 0, (size_t)width * (size_t)height * 4);
    return 1;
}

/* Paints a rectangle over a layer, which holds premultiplied alpha. */
static void blend(struct layer *layer, int left, int top, int right, int bottom, uint32_t color, double alpha) {
    if (left < 0) left = 0;
    if (top < 0) top = 0;
    if (right >= layer->width) right = layer->width - 1;
    if (bottom >= layer->height) bottom = layer->height - 1;
    uint32_t a = (uint32_t)(alpha * 255 + 0.5), keep = 255 - a;
    uint32_t r = (color >> 16 & 0xFF) * a / 255, g = (color >> 8 & 0xFF) * a / 255, b = (color & 0xFF) * a / 255;
    for (int y = top; y <= bottom; y++) {
        for (int x = left; x <= right; x++) {
            uint32_t *pixel = &layer->pixels[y * layer->width + x], under = *pixel;
            *pixel = (a + (under >> 24) * keep / 255) << 24 | (r + (under >> 16 & 0xFF) * keep / 255) << 16 |
                     (g + (under >> 8 & 0xFF) * keep / 255) << 8 | (b + (under & 0xFF) * keep / 255);
        }
    }
}

/* Draws text centered in a rectangle. GDI draws it in white on the glyph bitmap, and its brightness is the coverage. */
static void text(struct layer *layer, const wchar_t *string, int left, int top, int right, int bottom, HFONT font, uint32_t color,
                 double alpha) {
    RECT area = {left < 0 ? 0 : left, top < 0 ? 0 : top, right >= layer->width ? layer->width : right + 1,
                 bottom >= layer->height ? layer->height : bottom + 1};
    SelectObject(layer->glyph_dc, font);
    DrawTextW(layer->glyph_dc, string, -1, &area, DT_SINGLELINE | DT_CENTER | DT_VCENTER | DT_NOPREFIX | DT_END_ELLIPSIS);
    GdiFlush();
    for (int y = area.top; y < area.bottom; y++) {
        for (int x = area.left; x < area.right; x++) {
            uint32_t coverage = layer->glyph[y * layer->width + x] >> 8 & 0xFF;
            layer->glyph[y * layer->width + x] = 0;
            if (!coverage) continue;
            blend(layer, x, y, x, y, color, coverage / 255.0 * alpha);
        }
    }
}

static int text_width(struct layer *layer, const wchar_t *string, HFONT font) {
    SIZE size = {0, 0};
    SelectObject(layer->glyph_dc, font);
    GetTextExtentPoint32W(layer->glyph_dc, string, (int)wcslen(string), &size);
    return size.cx;
}

/* Shows a layer at a screen position, sending its pixels when they changed. */
static void present(struct layer *layer, int x, int y, int changed) {
    if (changed) {
        POINT position = {x, y}, source = {0, 0};
        SIZE size = {layer->width, layer->height};
        BLENDFUNCTION function = {AC_SRC_OVER, 0, 255, AC_SRC_ALPHA};
        UpdateLayeredWindow(layer->window, screen_dc, &position, &size, layer->dc, &source, 0, &function, ULW_ALPHA);
        layer->x = x;
        layer->y = y;
    }
    if (!layer->shown || x != layer->x || y != layer->y) {
        SetWindowPos(layer->window, HWND_TOPMOST, x, y, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
        layer->shown = 1;
        layer->x = x;
        layer->y = y;
    }
}

static void hide(struct layer *layer) {
    if (!layer->shown) return;
    ShowWindow(layer->window, SW_HIDE);
    layer->shown = 0;
}

static uint32_t readable_on(uint32_t color) {
    int luma = (int)(((color >> 16 & 0xFF) * 299 + (color >> 8 & 0xFF) * 587 + (color & 0xFF) * 114) / 1000);
    return luma > 150 ? DARK : LIGHT;
}

static HFONT create_font(int height, int weight) {
    return CreateFontW(-height, 0, 0, 0, weight, FALSE, FALSE, FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                       CLIP_DEFAULT_PRECIS, ANTIALIASED_QUALITY, DEFAULT_PITCH, L"Segoe UI");
}

static int font_height(void) {
    int height = (bar.right - bar.left) / 2;
    return height < 13 ? 13 : height > 30 ? 30 : height;
}

/* Sizes the mana overlay to hold the percentage above the bar and the spell names beside it. */
static void layout(void) {
    int height = font_height(), center = (bar.left + bar.right) / 2;
    if (pill_font) DeleteObject(pill_font);
    if (label_font) DeleteObject(label_font);
    pill_font = create_font(height, FW_BOLD);
    label_font = create_font(height * 4 / 5 < 12 ? 12 : height * 4 / 5, FW_SEMIBOLD);
    int pill = text_width(&mana_layer, L"100", pill_font) + 16, labels = 0;
    for (int i = 0; i < config.zone_count; i++) {
        int width = text_width(&mana_layer, config.zones[i].name, label_font) + 16;
        if (width > labels) labels = width;
    }
    frame.left = (bar.left < center - pill / 2 ? bar.left : center - pill / 2) - 2;
    frame.right = (bar.right + 6 + labels > center + pill / 2 ? bar.right + 6 + labels : center + pill / 2) + 2;
    frame.top = bar.top - (bar.right - bar.left) / 4 - 6 - (height + 8);
    frame.bottom = bar.bottom + 2;
    if (!resize(&mana_layer, frame.right - frame.left, frame.bottom - frame.top)) {
        locked = 0;
        return;
    }
    redraw = 1;
}

/* Draws the spell ranges inside the bar, their names beside it, and the percentage above it. */
static void draw(void) {
    struct layer *layer = &mana_layer;
    int rows = bar.fill_bottom - bar.fill_top + 1, line = (bar.right - bar.left) / 20 < 1 ? 1 : (bar.right - bar.left) / 20;
    int height = font_height(), label = height * 4 / 5 < 12 ? 12 : height * 4 / 5;
    int left = bar.fill_left - frame.left, right = bar.fill_right - frame.left, names = bar.right + 6 - frame.left;
    uint32_t pill = DARK;
    int in_range = 0;
    memset(layer->pixels, 0, (size_t)layer->width * (size_t)layer->height * 4);
    for (int i = 0; i < config.zone_count; i++) {
        const struct zone *zone = &config.zones[i];
        uint32_t color = mana == MANA_UNKNOWN ? zone->color : zone_color(zone->color, mana);
        int active = percent >= zone->min && percent <= zone->max;
        int top = bar.fill_bottom + 1 - rows * zone->max / 100 - frame.top;
        int bottom = bar.fill_bottom - rows * zone->min / 100 - frame.top;
        blend(layer, left, top, right, bottom, color, active ? 0.6 : 0.35);
        blend(layer, left, top, right, top + line - 1, color, 1);
        blend(layer, left, bottom - line + 1, right, bottom, color, 1);
        int middle = (top + bottom) / 2, width = text_width(layer, zone->name, label_font) + 16;
        blend(layer, names, middle - label / 2 - 3, names + width - 1, middle + label / 2 + 3, active ? color : DARK, active ? 1 : 0.8);
        if (!active) blend(layer, names, middle - label / 2 - 3, names + 2, middle + label / 2 + 3, color, 1);
        text(layer, zone->name, names, middle - label / 2 - 3, names + width - 1, middle + label / 2 + 3, label_font,
             active ? readable_on(color) : LIGHT, 1);
        if (active && !in_range) {
            in_range = 1;
            pill = color;
        }
    }
    wchar_t number[8];
    _snwprintf(number, 8, L"%d", percent);
    int center = (bar.left + bar.right) / 2 - frame.left, width = text_width(layer, L"100", pill_font) + 16;
    blend(layer, center - width / 2, 0, center + width / 2, height + 7, pill, in_range ? 1 : 0.85);
    text(layer, number, center - width / 2, 0, center + width / 2, height + 7, pill_font, in_range ? readable_on(pill) : LIGHT, 1);
    drawn_percent = percent;
    drawn_mana = mana;
    redraw = 0;
}

/* Draws the mana overlay when its contents changed and keeps it over the bar as the Roblox window moves. */
static void show_overlay(POINT origin) {
    int changed = redraw || percent != drawn_percent || mana != drawn_mana;
    if (changed) draw();
    present(&mana_layer, origin.x + frame.left, origin.y + frame.top, changed);
}

/* Covers a screen rectangle in red with two lines of text, then fades out. One pulse, no strobe. */
static void start_flash(RECT area, const wchar_t *title) {
    _snwprintf(flash_title, 64, L"%ls", title);
    flash_title[63] = 0;
    _snwprintf(flash_detail, 64, L"Outside %d\x2013%d%%", config.gate_min, config.gate_max);
    flash_detail[63] = 0;
    if (flash_font) DeleteObject(flash_font);
    flash_font = create_font((area.bottom - area.top) / 12, FW_BOLD);
    flash_at = GetTickCount64();
    SetLayeredWindowAttributes(flash, 0, FLASH_ALPHA, LWA_ALPHA);
    SetWindowPos(flash, HWND_TOPMOST, area.left, area.top, area.right - area.left, area.bottom - area.top,
                 SWP_NOACTIVATE | SWP_SHOWWINDOW);
    InvalidateRect(flash, NULL, TRUE);
    SetTimer(flash, 1, TICK_MS, NULL);
    if (config.sound) MessageBeep(MB_ICONHAND);
}

static LRESULT CALLBACK flash_proc(HWND window, UINT message, WPARAM wide, LPARAM data) {
    if (message == WM_TIMER) {
        ULONGLONG elapsed = GetTickCount64() - flash_at;
        if (elapsed >= FLASH_MS) {
            KillTimer(window, 1);
            ShowWindow(window, SW_HIDE);
        } else if (elapsed > FLASH_HOLD_MS) {
            BYTE alpha = (BYTE)(FLASH_ALPHA * (FLASH_MS - elapsed) / (FLASH_MS - FLASH_HOLD_MS));
            SetLayeredWindowAttributes(window, 0, alpha, LWA_ALPHA);
        }
        return 0;
    }
    if (message == WM_PAINT) {
        PAINTSTRUCT paint;
        HDC dc = BeginPaint(window, &paint);
        RECT area;
        GetClientRect(window, &area);
        HBRUSH red = CreateSolidBrush(RGB(200, 30, 30));
        FillRect(dc, &area, red);
        DeleteObject(red);
        SetBkMode(dc, TRANSPARENT);
        SetTextColor(dc, RGB(255, 255, 255));
        HGDIOBJ old = SelectObject(dc, flash_font);
        RECT upper = area, lower = area;
        upper.bottom = lower.top = (area.top + area.bottom) / 2;
        DrawTextW(dc, flash_title, -1, &upper, DT_SINGLELINE | DT_CENTER | DT_BOTTOM | DT_NOPREFIX);
        DrawTextW(dc, flash_detail, -1, &lower, DT_SINGLELINE | DT_CENTER | DT_TOP | DT_NOPREFIX);
        SelectObject(dc, old);
        EndPaint(window, &paint);
        return 0;
    }
    return DefWindowProcW(window, message, wide, data);
}

static void set_state(enum state next) {
    if (next != state) {
        status_dirty = 1;
        if (next == STATE_SEARCHING) {
            note("info", "Mana bar: looking for it in the whole Roblox window every %d ms, by its tan frame around the dark empty "
                 "interior. It's found only while the top quarter of the bar is empty, below about 75%% mana.", SEARCH_MS);
        }
    }
    state = next;
}

static void set_hotbar_state(enum state next) {
    if (next != hotbar_state) {
        status_dirty = 1;
        if (next == STATE_SEARCHING) {
            note("info", "Hotbar: looking for it in the lower half of the Roblox window every %d ms, by the flat color inside its "
                 "slots (#d7cbbf, or #fff8ee when selected).", SEARCH_MS);
        }
    }
    hotbar_state = next;
}

static void emit_status(ULONGLONG now) {
    static const char *names[] = {"off", "waiting", "searching", "tracking"};
    static char last[240];
    char line[240], color[8] = "";
    if (now - last_status < STATUS_MS) return;
    if (mana != MANA_UNKNOWN) snprintf(color, sizeof color, "%06x", (unsigned)(mana & 0xFFFFFF));
    snprintf(line, sizeof line,
             "{\"type\":\"status\",\"state\":\"%s\",\"percent\":%d,\"color\":\"%s\",\"prompt\":%s,\"gate\":%s,\"hotbar\":\"%s\"}",
             names[state], state == STATE_TRACKING ? percent : 0, color, prompt ? "true" : "false", gate_held == 1 ? "true" : "false",
             names[hotbar_state]);
    last_status = now;
    if (!status_dirty && !strcmp(line, last)) return;
    status_dirty = 0;
    strcpy(last, line);
    emit("%s", line);
}

/*
 * Reports each slot's skill ID, "" for an empty slot, or "?" for a name that isn't in the catalogue,
 * and in `names`, the text read from each slot, without quotes or backslashes.
 */
static int find_slot(const char *name);

static void emit_hotbar(void) {
    char line[HOTBAR_SLOTS * 120 + 120];
    int used = snprintf(line, sizeof line, "{\"type\":\"hotbar\",\"selected\":%d,\"reader\":%s,\"small\":%s,\"slots\":[",
                        selected, reader ? "true" : "false", small_hotbar ? "true" : "false");
    for (int i = 0; i < slot_count; i++) {
        const char *id = skill_in[i] >= 0 ? skills[skill_in[i]].id : skill_in[i] == SLOT_UNKNOWN ? "?" : "";
        used += snprintf(line + used, sizeof line - (size_t)used, "%s\"%s\"", i ? "," : "", id);
    }
    used += snprintf(line + used, sizeof line - (size_t)used, "],\"names\":[");
    for (int i = 0; i < slot_count; i++) {
        char name[64];
        size_t length = 0;
        for (const char *c = skill_in[i] == SLOT_EMPTY ? "" : texts[i]; *c && *c != '\n' && length + 1 < sizeof name; c++) {
            if (*c != '"' && *c != '\\') name[length++] = *c;
        }
        name[length] = 0;
        used += snprintf(line + used, sizeof line - (size_t)used, "%s\"%s\"", i ? "," : "", name);
    }
    snprintf(line + used, sizeof line - (size_t)used, "],\"train\":%d}", config.train ? find_slot(config.train_name) : -1);
    hotbar_dirty = 0;
    emit("%s", line);
}

/* Reports a Gate cast and warns when it was out of range. */
static void resolve_cast(RECT area, ULONGLONG now) {
    int ok = pending_percent >= config.gate_min && pending_percent <= config.gate_max;
    pending = 0;
    quiet_until = now + CAST_QUIET_MS;
    emit("{\"type\":\"cast\",\"spell\":\"gate\",\"percent\":%d,\"ok\":%s}", pending_percent, ok ? "true" : "false");
    note("info", "Gate cast confirmed at %d%% mana, %s %d-%d%%.%s", pending_percent, ok ? "inside" : "outside", config.gate_min, config.gate_max,
         ok ? "" : " Flashing the backfire warning.");
    _snwprintf(cast_result, 96, L"Gate cast at %d%%: %ls", pending_percent, ok ? L"in range" : L"out of range");
    cast_result_until = now + DEBUG_CAST_MS;
    if (ok) return;
    wchar_t title[64];
    _snwprintf(title, 64, L"Gate cast at %d%%", pending_percent);
    start_flash(area, title);
}

/*
 * Learns the fill rate, which differs by character, from steady rises. A faster rise replaces it
 * at once, and slower ones, such as a window that starts before the fill does, only nudge it.
 */
static void learn_rate(ULONGLONG now, double level) {
    static ULONGLONG since;
    static double from;
    if (since && now - since < RATE_WINDOW_MS) return;
    if (since && now - since < RATE_WINDOW_MS * 2 && level < 99) {
        double rate = (level - from) * 1000.0 / (double)(now - since);
        if (rate >= RATE_MIN) fill_rate = rate > fill_rate ? rate : fill_rate * 0.9 + rate * 0.1;
    }
    since = now;
    from = level;
}

static void idle(enum state next) {
    set_state(next);
    mana_valid = 0;
    hide(&mana_layer);
    pending = 0;
    prompt = 0;
}

static void hotbar_idle(enum state next) {
    set_hotbar_state(next);
    hide(&cooldown_layer);
}

static void track_mana(ULONGLONG now, POINT origin, int clicked) {
    struct image image;
    if (!locked) {
        if (now - last_search >= SEARCH_MS) {
            last_search = now;
            if (capture(origin.x, origin.y, client_width, client_height, &image) && find_bar(&image, &bar)) {
                locked = 1;
                lost = 0;
                layout();
                note("info", "Mana bar found: its frame runs from %d,%d to %d,%d in the Roblox window, and mana fills rows %d to %d.",
                     bar.left, bar.top, bar.right, bar.bottom, bar.fill_top, bar.fill_bottom);
            }
        }
        if (!locked) {
            idle(STATE_SEARCHING);
            return;
        }
    }

    int x = bar.fill_left - 6 < 0 ? 0 : bar.fill_left - 6, y = bar.fill_top;
    int right = bar.fill_right + 6 >= client_width ? client_width - 1 : bar.fill_right + 6;
    struct bar local = {bar.left - x, bar.right - x, bar.top - y, bar.bottom - y,
                        bar.fill_left - x, bar.fill_right - x, 0, bar.fill_bottom - y};
    if (!capture(origin.x + x, origin.y + y, right - x + 1, bar.fill_bottom - y + 1, &image)) return;
    if (!bar_present(&image, &local)) {
        if (++lost > LOST_TICKS) {
            locked = 0;
            note("warn", "Mana bar lost: its frame wasn't seen beside the fill for %d frames in a row. Is it covered, or did the "
                 "interface change size?", LOST_TICKS);
            idle(STATE_SEARCHING);
        }
        return;
    }
    lost = 0;
    double level = read_fill(&image, &local, &mana);
    int reading = (int)lround(level);
    learn_rate(now, level);
    if (mana != MANA_UNKNOWN && logged_mana == MANA_UNKNOWN) note("info", "Mana color read: #%06x.", (unsigned)(mana & 0xFFFFFF));
    logged_mana = mana;
    if (fill_rate > 0 && fabs(fill_rate - logged_rate) > logged_rate * 0.1) {
        note("info", "Mana fill rate measured: %.1f%% a second. Mana drains at the same rate.", fill_rate);
        logged_rate = fill_rate;
    }
    if (reading != percent || state != STATE_TRACKING) status_dirty = 1;
    percent = reading;
    mana_level = level;
    mana_valid = 1;
    set_state(STATE_TRACKING);

    if (config.enabled && config.gate) {
        int seen = prompt, held = gate_held;
        int candidate = clicked && !pending && held != 0 && now >= quiet_until && fill_rate > 0 && percent >= CAST_MIN_PERCENT &&
                        percent <= CAST_MAX_PERCENT;
        if (candidate || now - last_prompt_scan >= (pending ? CAST_PROMPT_SCAN_MS : PROMPT_MS)) {
            last_prompt_scan = now;
            prompt = capture(origin.x, origin.y, client_width, client_height, &image) && find_prompt(&image, &prompt_box);
        }
        if (prompt != seen) {
            status_dirty = 1;
            if (prompt) {
                note("info", "Gate prompt detected: its text box is at %d,%d in the Roblox window, %d by %d.", prompt_box.left, prompt_box.top,
                     prompt_box.right - prompt_box.left + 1, prompt_box.bottom - prompt_box.top + 1);
            } else {
                note("info", "Gate prompt is no longer on screen.");
            }
        }
        if (clicked && !candidate) {
            if (pending) note("info", "Right click ignored: a Gate cast is already being judged.");
            else if (held == 0) note("info", "Right click ignored: Gate isn't equipped in the hotbar.");
            else if (now < quiet_until) note("info", "Right click ignored: it came within %d ms of the last Gate cast.", CAST_QUIET_MS);
            else if (fill_rate <= 0) note("warn", "Right click ignored: the mana fill rate isn't measured yet. Charging mana once measures it.");
            else note("info", "Right click ignored at %d%% mana: casts are judged between %d%% and %d%%.", percent, CAST_MIN_PERCENT, CAST_MAX_PERCENT);
        }
        if (candidate) {
            pending = 1;
            pending_at = now;
            pending_percent = percent;
            cast = (struct cast){.held = held};
            note("info", "Right click at %d%% mana (%.1f%%) with Gate %s: judging a Gate cast. Waiting up to %d ms for the Gate prompt.",
                 percent, level, held == 1 ? "equipped" : "possibly equipped, as the hotbar can't tell", CAST_PROMPT_WAIT_MS);
        }
        if (pending) {
            int checks = cast.checks, prompted = cast.prompted;
            unsigned elapsed = (unsigned)(now - pending_at);
            int verdict = judge_cast(&cast, level, elapsed, held, prompt, fill_rate);
            if (cast.prompted && !prompted) {
                note("info", "Gate prompt appeared %u ms after the right click. Mana is %.1f%%; checking it every %d ms, %d times.", elapsed,
                     level, CAST_CHECK_MS, CAST_CHECKS);
            }
            if (verdict >= 0 && cast.checks > checks) {
                note("info", "Mana check %d of %d passed: %.1f%% to %.1f%% over %u ms, slower than it fills or drains without a cast.",
                     cast.checks, CAST_CHECKS, cast.level, level, elapsed - cast.prompt_at);
            }
            if (verdict == CAST_PUT_AWAY) note("warn", "Gate cast rejected: Gate stopped being equipped %u ms after the right click.", elapsed);
            if (verdict == CAST_NO_PROMPT) {
                note("warn", "Gate cast rejected: the Gate prompt didn't appear within %d ms of the right click. If it did appear, it wasn't "
                     "recognized; see the earlier Gate prompt lines.", CAST_PROMPT_WAIT_MS);
            }
            if (verdict == CAST_MANA) {
                note("warn", "Gate cast rejected at mana check %d of %d: mana went from %.1f%% to %.1f%% over %u ms, as it does without a cast. "
                     "The fill rate is %.1f%% a second.", cast.checks, CAST_CHECKS, cast.level, level, elapsed - cast.prompt_at, fill_rate);
            }
            if (verdict) pending = 0;
            if (verdict > 0) {
                RECT area = {origin.x, origin.y, origin.x + client_width, origin.y + client_height};
                resolve_cast(area, now);
            }
        }
    } else {
        pending = 0;
        prompt = 0;
    }
    if (config.enabled) show_overlay(origin);
    else hide(&mana_layer);
}

/* Returns the skill named by any of the texts read from a slot, or SLOT_UNKNOWN. */
static int match_texts(const char *read) {
    const char *names[MAX_SKILLS];
    for (int k = 0; k < skill_count; k++) names[k] = skills[k].name;
    int found = match_lines(read, names, skill_count);
    return found >= 0 ? found : SLOT_UNKNOWN;
}

/*
 * Returns 1 when slot `slot` shows `name`, 0 when it shows something else or nothing, and -1 when
 * it can't tell: the slot hasn't been read, too little of its text was read, or the hotbar is
 * smaller than OCR reads reliably and the text matches nothing.
 */
static int slot_says(int slot, const char *name) {
    if (slot < 0 || slot >= slot_count || skill_in[slot] == SLOT_EMPTY) return 0;
    if (match_lines(texts[slot], &name, 1) == 0) return 1;
    return small_hotbar || letter_count(texts[slot]) < SLOT_MIN_LETTERS ? -1 : 0;
}

/* Returns the hotbar slot that shows `name`, or -1 when none does or the hotbar isn't read yet. */
static int find_slot(const char *name) {
    if (!name[0] || hotbar_state != STATE_TRACKING) return -1;
    for (int i = 0; i < slot_count; i++)
        if (slot_says(i, name) == 1) return i;
    return -1;
}

/*
 * Returns 1 when the selected slot shows `name`, 0 when another slot or none is selected, and -1
 * when the hotbar can't tell: it isn't found, or names can't be read yet. While the hotbar is
 * briefly hidden, the last selection stands.
 */
static int equipped(const char *name) {
    if (!hotbar_locked || !reader) return -1;
    return selected < 0 ? 0 : slot_says(selected, name);
}

/* Hands a copy of a slot's interior to the OCR thread, replacing a request it hasn't started. */
static void request_text(int slot, int serial, const struct image *image, const struct slot *interior) {
    int width = interior->right - interior->left + 1, height = interior->bottom - interior->top + 1;
    uint8_t *pixels = malloc((size_t)width * (size_t)height * 4);
    if (!pixels) return;
    for (int y = 0; y < height; y++) {
        memcpy(pixels + (size_t)y * width * 4, image->pixels + (size_t)(interior->top + y) * image->stride + (size_t)interior->left * 4,
               (size_t)width * 4);
    }
    EnterCriticalSection(&request_lock);
    struct request *request = &requests[slot];
    free((void *)request->image.pixels);
    *request = (struct request){1, serial, {pixels, width, height, width * 4}, {0, width - 1, 0, height - 1}};
    LeaveCriticalSection(&request_lock);
    SetEvent(request_ready);
}

/*
 * Sends a slot to OCR when its glyph shows a different name than the last one sent. Selecting a
 * slot doesn't change what it holds, so a slot that has been read isn't read again while it's
 * selected, `shown`, and what it says stays known while it's equipped.
 */
static void read_names(const struct image *image, int shown) {
    for (int i = 0; i < slot_count; i++) {
        uint8_t glyph[GLYPH_SIZE];
        struct slot interior;
        if (i == shown && sent[i] && texts[i][0]) continue;
        int empty = read_slot(image, &slots[i], &interior) < 0 || !read_glyph(image, &interior, glyph);
        int steady = empty ? seen[i] == 1 : seen[i] == 2 && glyph_distance(glyph, seen_glyphs[i]) <= GLYPH_MATCH;
        seen[i] = empty ? 1 : 2;
        if (!empty) memcpy(seen_glyphs[i], glyph, GLYPH_SIZE);
        if (!steady) continue;
        if (empty) {
            if (skill_in[i] == SLOT_EMPTY && !sent[i]) continue;
            note("info", "Slot %s is empty.", KEY_NAMES[i]);
            skill_in[i] = SLOT_EMPTY;
            sent[i] = 0;
            serials[i]++;
            hotbar_dirty = 1;
            continue;
        }
        if (sent[i] && glyph_distance(glyph, sent_glyphs[i]) <= GLYPH_MATCH) continue;
        memcpy(sent_glyphs[i], glyph, GLYPH_SIZE);
        sent[i] = 1;
        serials[i]++;
        skill_in[i] = SLOT_UNKNOWN;
        texts[i][0] = 0;
        hotbar_dirty = 1;
        note("info", "Slot %s changed: reading its name with text recognition.", KEY_NAMES[i]);
        request_text(i, serials[i], image, &interior);
    }
}

/* Reads the requested slots' text. Every height is read, so the main thread can match any of them. */
static DWORD WINAPI read_text(void *unused) {
    (void)unused;
    static const int heights[] = OCR_HEIGHTS;
    if (!ocr_start()) {
        PostMessageW(mana_layer.window, WM_READER, 0, 0);
        return 0;
    }
    for (;;) {
        WaitForSingleObject(request_ready, INFINITE);
        for (int i = 0; i < ALL_SLOTS; i++) {
            EnterCriticalSection(&request_lock);
            struct request request = requests[i];
            requests[i].pending = 0;
            requests[i].image.pixels = NULL;
            LeaveCriticalSection(&request_lock);
            if (!request.pending) continue;
            struct reading *reading = calloc(1, sizeof *reading);
            if (reading) {
                size_t used = 0;
                reading->slot = i;
                reading->serial = request.serial;
                for (size_t k = 0; k < sizeof heights / sizeof heights[0]; k++) {
                    char text[80];
                    if (!ocr_read(&request.image, &request.interior, heights[k], text, sizeof text)) continue;
                    used += (size_t)snprintf(reading->texts + used, sizeof reading->texts - used, "%s\n", text);
                    if (used >= sizeof reading->texts) break;
                }
                if (!PostMessageW(mana_layer.window, WM_SLOT_TEXT, 0, (LPARAM)reading)) free(reading);
            }
            free((void *)request.image.pixels);
        }
    }
}

/* Locks onto the hotbar in the lower part of the Roblox window. Returns 1 when it's found. */
static int find_slots(POINT origin) {
    struct image image;
    int top = client_height / 2;
    if (!capture(origin.x, origin.y + top, client_width, client_height - top, &image)) return 0;
    int found = find_hotbar(&image, slots);
    if (found < HOTBAR_MIN_SLOTS) {
        if (found != logged_hotbar_count && found == 0) {
            note("warn", "Hotbar not found: no slot interiors in the lower half of the Roblox window. Is the hotbar on screen and uncovered?");
        } else if (found != logged_hotbar_count) {
            note("warn", "Hotbar not found: the best row has %d slot interior%s, and %d are needed.", found, found == 1 ? "" : "s", HOTBAR_MIN_SLOTS);
        }
        logged_hotbar_count = found;
        return 0;
    }
    int same = found == slot_count;
    slot_count = found;
    hotbar = (RECT){client_width, client_height, 0, 0};
    for (int i = 0; i < slot_count; i++) {
        int margin = (slots[i].right - slots[i].left) / 6;
        if (slots[i].left - margin < hotbar.left) hotbar.left = slots[i].left - margin;
        if (slots[i].right + margin > hotbar.right) hotbar.right = slots[i].right + margin;
        if (slots[i].top + top - margin < hotbar.top) hotbar.top = slots[i].top + top - margin;
        if (slots[i].bottom + top + margin > hotbar.bottom) hotbar.bottom = slots[i].bottom + top + margin;
    }
    if (hotbar.left < 0) hotbar.left = 0;
    if (hotbar.right >= client_width) hotbar.right = client_width - 1;
    if (hotbar.bottom >= client_height) hotbar.bottom = client_height - 1;
    small_hotbar = 0;
    for (int i = 0; i < slot_count; i++) {
        slots[i].left -= hotbar.left;
        slots[i].right -= hotbar.left;
        slots[i].top += top - hotbar.top;
        slots[i].bottom += top - hotbar.top;
        interiors[i] = slots[i];
        if (slots[i].bottom - slots[i].top + 1 < SLOT_READABLE_HEIGHT) small_hotbar = 1;
        if (same) continue;
        skill_in[i] = SLOT_EMPTY;
        last_skill[i] = -1;
        sent[i] = 0;
        seen[i] = 0;
        serials[i]++;
    }
    if (!resize(&cooldown_layer, hotbar.right - hotbar.left + 1, hotbar.bottom - hotbar.top + 1)) {
        note("warn", "Hotbar found, but its overlay couldn't be sized. Is memory running low?");
        return 0;
    }
    note("info", "Hotbar found: %d slots from %ld,%ld to %ld,%ld in the Roblox window. Slot interiors are %d by %d pixels.%s", slot_count,
         hotbar.left, hotbar.top, hotbar.right, hotbar.bottom, slots[0].right - slots[0].left + 1, slots[0].bottom - slots[0].top + 1,
         same ? " The skill each slot held is kept." : "");
    if (small_hotbar) {
        note("warn", "Hotbar slots are %d pixels tall, under the %d that text recognition reads reliably, so names may go unread. A larger "
             "Roblox window makes them larger.", slots[0].bottom - slots[0].top + 1, SLOT_READABLE_HEIGHT);
    }
    int height = (slots[0].bottom - slots[0].top + 1) * 2 / 5;
    if (countdown_font) DeleteObject(countdown_font);
    countdown_font = create_font(height < 12 ? 12 : height, FW_BOLD);
    if (debug_font) DeleteObject(debug_font);
    debug_font = create_font(height * 3 / 5 < 11 ? 11 : height * 3 / 5, FW_NORMAL);
    last_names = 0;
    hotbar_dirty = 1;
    return 1;
}

static void outline(struct layer *layer, int left, int top, int right, int bottom, int line, uint32_t color, double alpha) {
    blend(layer, left, top, right, top + line - 1, color, alpha);
    blend(layer, left, bottom - line + 1, right, bottom, color, alpha);
    blend(layer, left, top + line, left + line - 1, bottom - line, color, alpha);
    blend(layer, right - line + 1, top + line, right, bottom - line, color, alpha);
}

/* Shades each slot whose skill is cooling down, from the bottom up to the share of time left. */
/* Shades each of `count` slots, at `boxes` inside `layer`, whose skill in `skill_of` is cooling down. */
static void draw_cooldowns(struct layer *layer, const struct slot *boxes, const int *skill_of, int count, int x, int y, ULONGLONG now) {
    int active = 0;
    memset(layer->pixels, 0, (size_t)layer->width * (size_t)layer->height * 4);
    for (int i = 0; i < count; i++) {
        if (skill_of[i] < 0 || skills[skill_of[i]].ready_at <= now) continue;
        const struct skill *skill = &skills[skill_of[i]];
        const struct slot *box = &boxes[i];
        ULONGLONG left = skill->ready_at - now;
        int height = box->bottom - box->top + 1, shaded = (int)((double)height * (double)left / (double)skill->cooldown + 0.5);
        active = 1;
        blend(layer, box->left, box->bottom - shaded + 1, box->right, box->bottom, config.shade, config.shade_opacity / 100.0);
        if (!config.countdown) continue;
        wchar_t seconds[16];
        _snwprintf(seconds, 16, L"%llu", (left + 999) / 1000);
        for (int dy = -1; dy <= 1; dy++) {
            for (int dx = -1; dx <= 1; dx++) {
                if (dx || dy) text(layer, seconds, box->left + dx, box->top + dy, box->right + dx, box->bottom + dy, countdown_font, DARK, 1);
            }
        }
        text(layer, seconds, box->left, box->top, box->right, box->bottom, countdown_font, LIGHT, 1);
    }
    if (active) present(layer, x, y, 1);
    else hide(layer);
}

static void show_cooldowns(ULONGLONG now, POINT origin) {
    draw_cooldowns(&cooldown_layer, interiors, last_skill, slot_count, origin.x + hotbar.left, origin.y + hotbar.top, now);
}

/* Records whether the backpack is open, logs it, and tells the widget at once. */
static void set_backpack(int open) {
    pack_missed = 0;
    if (open == pack_open) return;
    pack_open = open;
    if (!open) hide(&backpack_layer);
    if (open) {
        int rows = 1;
        for (int i = 1; i < pack_count; i++) rows += pack[i].top > pack[i - 1].bottom;
        note("info", "Backpack opened: %d slot%s in %d row%s above the hotbar.", pack_count, pack_count == 1 ? "" : "s", rows, rows == 1 ? "" : "s");
    } else {
        note("info", "Backpack closed.");
    }
    emit("{\"type\":\"backpack\",\"open\":%s}", open ? "true" : "false");
}

/*
 * Looks for the backpack every BACKPACK_SEARCH_MS above the hotbar, with slots as wide as the
 * hotbar's when it's found. It's open from the first search that finds slots, and closed after
 * BACKPACK_CLOSE_SEARCHES that don't. A slot whose ink changed is read again.
 */
static void track_backpack(ULONGLONG now, POINT origin) {
    static struct slot found[BACKPACK_SLOTS];
    struct image image;
    if (now - last_pack_search >= BACKPACK_SEARCH_MS) {
        last_pack_search = now;
        int limit = hotbar_locked ? hotbar.top - 2 : client_height * 3 / 4, width = 0;
        if (hotbar_locked && slot_count) width = interiors[0].right - interiors[0].left + 1;
        if (limit < 1 || !capture(origin.x, origin.y, client_width, limit, &image)) return;
        int count = find_backpack(&image, limit, width, found);
        if (!count) {
            if (pack_open && ++pack_missed >= BACKPACK_CLOSE_SEARCHES) set_backpack(0);
            return;
        }
        pack_count = count;
        memcpy(pack, found, sizeof found[0] * (size_t)count);
        pack_box = pack[0];
        for (int i = 1; i < count; i++) {
            if (pack[i].left < pack_box.left) pack_box.left = pack[i].left;
            if (pack[i].right > pack_box.right) pack_box.right = pack[i].right;
            if (pack[i].top < pack_box.top) pack_box.top = pack[i].top;
            if (pack[i].bottom > pack_box.bottom) pack_box.bottom = pack[i].bottom;
        }
        for (int i = 0; i < count; i++) {
            pack_shades[i] = (struct slot){pack[i].left - pack_box.left, pack[i].right - pack_box.left, pack[i].top - pack_box.top,
                                           pack[i].bottom - pack_box.top};
        }
        resize(&backpack_layer, pack_box.right - pack_box.left + 1, pack_box.bottom - pack_box.top + 1);
        set_backpack(1);
        for (int i = 0; i < count; i++) {
            uint8_t glyph[GLYPH_SIZE];
            if (!reader) {
                pack_skill[i] = SLOT_UNKNOWN;
                continue;
            }
            if (!read_glyph(&image, &pack[i], glyph)) {
                pack_skill[i] = SLOT_EMPTY;
                pack_sent[i] = 0;
                continue;
            }
            if (pack_sent[i] && glyph_distance(glyph, pack_glyphs[i]) <= GLYPH_MATCH) continue;
            memcpy(pack_glyphs[i], glyph, GLYPH_SIZE);
            pack_sent[i] = 1;
            pack_skill[i] = SLOT_UNKNOWN;
            pack_texts[i][0] = 0;
            request_text(HOTBAR_SLOTS + i, ++pack_serials[i], &image, &pack[i]);
        }
    }
    if (pack_open && config.cooldowns) {
        draw_cooldowns(&backpack_layer, pack_shades, pack_skill, pack_count, origin.x + pack_box.left, origin.y + pack_box.top, now);
    } else {
        hide(&backpack_layer);
    }
}

/*
 * Decides a pending left click once the hotbar shows its slot selected, with `shown` the slot it
 * shows now, or -1. The click counts from when it happened. It doesn't count when another slot is
 * selected first, which is a slot passed over, or when CLICK_CONFIRM_MS pass without the slot shown.
 */
static void confirm_click(ULONGLONG now, int shown) {
    if (!click_at) return;
    if (selected != click_slot) {
        note("info", "Left click with slot %s selected, but slot %s was selected before the hotbar showed slot %s, so it was passed over and no "
             "cooldown starts.", KEY_NAMES[click_slot], selected >= 0 ? KEY_NAMES[selected] : "none", KEY_NAMES[click_slot]);
    } else if (shown == click_slot) {
        use_slot(click_slot, click_at);
    } else if (now - click_at >= CLICK_CONFIRM_MS) {
        note("info", "Left click with slot %s selected by key, but the hotbar didn't show it selected within %d ms, so it wasn't equipped and no "
             "cooldown starts.", KEY_NAMES[click_slot], CLICK_CONFIRM_MS);
    } else {
        return;
    }
    click_at = 0;
}

static void track_hotbar(ULONGLONG now, POINT origin) {
    struct image image;
    if (!hotbar_locked) {
        hotbar_idle(STATE_SEARCHING);
        if (now - last_hotbar_search >= SEARCH_MS) {
            last_hotbar_search = now;
            hotbar_locked = find_slots(origin);
            hotbar_lost = 0;
        }
        if (!hotbar_locked) return;
        logged_hotbar_count = -1;
    }
    if (!capture(origin.x + hotbar.left, origin.y + hotbar.top, hotbar.right - hotbar.left + 1, hotbar.bottom - hotbar.top + 1, &image)) return;
    int missing = 0, shown = -1;
    for (int i = 0; i < slot_count; i++) {
        int reading = read_slot(&image, &slots[i], &interiors[i]);
        if (reading < 0) missing++;
        else if (reading) shown = i;
    }
    if (missing * 2 > slot_count) {
        confirm_click(now, -1);
        if (++hotbar_lost > LOST_TICKS) {
            hotbar_locked = 0;
            note("warn", "Hotbar hidden: %d of %d slots weren't seen for %d frames in a row. Is it covered, or did the interface change size?",
                 missing, slot_count, LOST_TICKS);
            hotbar_idle(STATE_SEARCHING);
            return;
        }
        show_cooldowns(now, origin);
        return;
    }
    hotbar_lost = 0;
    confirm_click(now, shown);
    if (now - last_names >= NAMES_MS) {
        last_names = now;
        read_names(&image, shown);
    }
    if (shown != selected && (LONG64)now - key_seen >= SELECTION_SYNC_MS) {
        if (shown >= 0) note("info", "Slot %s is selected on screen.", KEY_NAMES[shown]);
        else note("info", "No slot is selected on screen.");
        selected = shown;
        hotbar_dirty = 1;
    }
    set_hotbar_state(STATE_TRACKING);
    show_cooldowns(now, origin);
}

/* Starts `skill`'s cooldown as of `at` and tells the widget. */
static void start_cooldown(struct skill *skill, int slot, ULONGLONG at) {
    skill->ready_at = at + skill->cooldown;
    emit("{\"type\":\"cooldown\",\"skill\":\"%s\",\"slot\":%d}", skill->id, slot);
}

/*
 * Records a left click in the Roblox window for the selected slot. The next hotbar read decides
 * whether it used the slot's skill: keys only predict the selection, and a slot passed over quickly
 * is never equipped. A click on the hotbar itself selects a slot rather than using one.
 */
static void use_skill(POINT point) {
    HWND window = GetForegroundWindow();
    POINT origin = {0, 0};
    RECT client;
    if (selected < 0 || selected >= slot_count) return;
    if (hotbar_state != STATE_TRACKING) {
        note("info", "Left click ignored: the hotbar isn't being tracked right now, so which skill was used can't be told.");
        return;
    }
    if (!is_target(window) || !GetClientRect(window, &client) || !ClientToScreen(window, &origin)) return;
    point.x -= origin.x;
    point.y -= origin.y;
    if (point.x < 0 || point.y < 0 || point.x >= client.right || point.y >= client.bottom) return;
    if (point.x >= hotbar.left && point.x <= hotbar.right && point.y >= hotbar.top && point.y <= hotbar.bottom) {
        note("info", "Left click on the hotbar: it selects a slot, so no cooldown starts.");
        return;
    }
    click_slot = selected;
    click_at = GetTickCount64();
}

/*
 * Uses the skill in `slot` for a left click at `now`, once the hotbar read after the click showed
 * the slot highlighted, which is when the game has it equipped.
 */
static void use_slot(int slot, ULONGLONG now) {
    if (last_skill[slot] < 0) {
        char read[200];
        readings(texts[slot], read, sizeof read);
        note("info", "Left click with slot %s selected: no cooldown, as its name (\"%s\") isn't a skill in skills.js.", KEY_NAMES[slot], read);
        return;
    }
    struct skill *skill = &skills[last_skill[slot]];
    if (now < skill->ready_at) {
        note("info", "Left click ignored: %s in slot %s is cooling down for %.1f s more.", skill->name, KEY_NAMES[slot],
             (double)(skill->ready_at - now) / 1000.0);
        return;
    }
    note("info", "Left click with %s selected in slot %s: its %.1f s cooldown starts.", skill->name, KEY_NAMES[slot], (double)skill->cooldown / 1000.0);
    start_cooldown(skill, slot, now);
}

/* A hotbar key press in the Roblox window. The same key again clears the selection, as in the game. */
static void press_key(int slot) {
    if (!is_target(GetForegroundWindow())) return;
    note("info", "Key %s pressed: slot %s %s.", KEY_NAMES[slot], KEY_NAMES[slot], selected == slot ? "deselected" : "selected");
    selected = selected == slot ? -1 : slot;
    hotbar_dirty = 1;
}

/*
 * The hooks run on their own thread, which only passes events to the main thread, so input never
 * waits on a screen capture. The hotbar keys are 1 to 0, then - and =, by their position on the
 * keyboard. Held keys repeat, and only the first press counts.
 */
static LRESULT CALLBACK on_key(int code, WPARAM message, LPARAM data) {
    const KBDLLHOOKSTRUCT *key = (const KBDLLHOOKSTRUCT *)data;
    int slot = (int)key->scanCode - 2, up = message == WM_KEYUP || message == WM_SYSKEYUP;
    if (code != HC_ACTION || key->dwExtraInfo == INPUT_TAG) return CallNextHookEx(NULL, code, message, data);
    for (int which = TASK_TRAIN; which <= TASK_SMITH && !(key->flags & LLKHF_INJECTED); which++) {
        if (!task_keys[which] || key->vkCode != (DWORD)task_keys[which]) continue;
        if (up) {
            task_held &= ~(1u << which);
        } else if (!(task_held & 1u << which)) {
            task_held |= 1u << which;
            PostMessageW(mana_layer.window, WM_TASK_KEY, (WPARAM)which, 0);
        }
    }
    if (slot >= 0 && slot < HOTBAR_SLOTS && !(key->flags & LLKHF_EXTENDED)) {
        unsigned bit = 1u << slot;
        if (up) {
            held_keys &= ~bit;
        } else if (!(held_keys & bit)) {
            held_keys |= bit;
            InterlockedExchange64(&key_seen, (LONG64)GetTickCount64());
            PostMessageW(mana_layer.window, WM_HOTBAR_KEY, (WPARAM)slot, 0);
        }
    }
    return CallNextHookEx(NULL, code, message, data);
}

static LRESULT CALLBACK on_mouse(int code, WPARAM message, LPARAM data) {
    const MSLLHOOKSTRUCT *mouse = (const MSLLHOOKSTRUCT *)data;
    if (code == HC_ACTION && message == WM_LBUTTONDOWN && mouse->dwExtraInfo != INPUT_TAG) {
        PostMessageW(mana_layer.window, WM_LEFT_CLICK, (WPARAM)(LONG_PTR)mouse->pt.x, (LPARAM)mouse->pt.y);
    }
    return CallNextHookEx(NULL, code, message, data);
}

static DWORD WINAPI watch_input(void *ready) {
    MSG message;
    HINSTANCE instance = GetModuleHandleW(NULL);
    PeekMessageW(&message, NULL, 0, 0, PM_NOREMOVE);
    held_keys = 0;
    task_held = 0;
    HHOOK keyboard = SetWindowsHookExW(WH_KEYBOARD_LL, on_key, instance, 0);
    HHOOK mouse = SetWindowsHookExW(WH_MOUSE_LL, on_mouse, instance, 0);
    SetEvent(ready);
    while (GetMessageW(&message, NULL, 0, 0) > 0) DispatchMessageW(&message);
    if (keyboard) UnhookWindowsHookEx(keyboard);
    if (mouse) UnhookWindowsHookEx(mouse);
    return 0;
}

/* Watches input only while it's needed. The thread's queue exists before this returns, so it can always be stopped. */
static void hook_input(int on) {
    if (on && !watcher) {
        HANDLE ready = CreateEventW(NULL, TRUE, FALSE, NULL);
        if (!ready) return;
        watcher = CreateThread(NULL, 0, watch_input, ready, 0, &watcher_id);
        if (watcher) WaitForSingleObject(ready, INFINITE);
        CloseHandle(ready);
    } else if (!on && watcher) {
        PostThreadMessageW(watcher_id, WM_QUIT, 0, 0);
        CloseHandle(watcher);
        watcher = NULL;
    }
}

/* Mixes a value into a hash of what the debug layer shows. */
static uint64_t mix(uint64_t hash, long long value) {
    return (hash ^ (uint64_t)value) * 1099511628211ull;
}

/* Draws a label on a dark band with an edge in `color`, kept on the layer. Returns where it went. */
static RECT label(struct layer *layer, int x, int y, const wchar_t *string, uint32_t color, HFONT font, int height) {
    int width = text_width(layer, string, font) + 16;
    if (x + width > layer->width) x = layer->width - width;
    if (x < 0) x = 0;
    if (y + height > layer->height) y = layer->height - height;
    if (y < 0) y = 0;
    blend(layer, x, y, x + width - 1, y + height - 1, DARK, 0.85);
    blend(layer, x, y, x + 2, y + height - 1, color, 1);
    text(layer, string, x + 3, y, x + width - 1, y + height - 1, font, LIGHT, 1);
    return (RECT){x, y, x + width - 1, y + height - 1};
}

/* Draws a line from the middle of a label's top or bottom edge, up or down to `y`, then across to `x`. */
static void leader(struct layer *layer, RECT from, int x, int y, uint32_t color) {
    int middle = (from.left + from.right) / 2, start = y > from.bottom ? from.bottom + 1 : from.top - 1;
    blend(layer, middle - 1, start < y ? start : y, middle, start < y ? y : start, color, 1);
    blend(layer, middle < x ? middle : x, y - 1, middle < x ? x : middle, y, color, 1);
}

/*
 * Labels the mana bar, the Gate state, and the Gate prompt. The bar's labels stack upward above it,
 * clear of the percentage drawn over its top and of the hotbar below it. Without the bar, they
 * stack downward from the top right.
 */
static void debug_mana(struct layer *layer, ULONGLONG now, HFONT font, int band) {
    wchar_t string[160];
    int found = locked && state == STATE_TRACKING, x = found ? bar.left - 3 : client_width;
    int y = found ? bar.top - 3 - band * 3 : 8 + band + 6, step = found ? -(band + 6) : band + 6;
    if (found) {
        RECT frame = {bar.left - 3, bar.top - 3, bar.right + 3, bar.bottom + 3};
        int rows = bar.fill_bottom - bar.fill_top + 1, level = bar.fill_bottom - rows * percent / 100;
        outline(layer, frame.left, frame.top, frame.right, frame.bottom, 2, DEBUG_FOUND, 1);
        blend(layer, frame.left - 12 < 0 ? 0 : frame.left - 12, level - 1, frame.left - 1, level, DEBUG_FOUND, 1);
        int used = _snwprintf(string, 160, L"Mana bar: %d%%", percent);
        if (mana != MANA_UNKNOWN) used += _snwprintf(string + used, 160 - used, L", color #%06x", (unsigned)(mana & 0xFFFFFF));
        if (fill_rate > 0) _snwprintf(string + used, 160 - used, L", fills %.1f%% a second", fill_rate);
        RECT mark = label(layer, x, y, string, DEBUG_FOUND, font, band);
        leader(layer, mark, frame.right + 1, frame.top + band, DEBUG_FOUND);
        y = mark.top + step;
    }
    if (!config.gate) return;
    if (gate_held == 1) _snwprintf(string, 160, L"Gate: equipped in slot %hs", KEY_NAMES[selected]);
    else if (gate_held == 0) _snwprintf(string, 160, L"Gate: not equipped");
    else _snwprintf(string, 160, L"Gate: equipped or not can't be told, so the prompt alone counts");
    y = label(layer, x, y, string, gate_held == 1 ? DEBUG_FOUND : DEBUG_UNKNOWN, font, band).top + step;
    if (pending && !cast.prompted) {
        _snwprintf(string, 160, L"Gate cast: waiting for the prompt, %llu ms", (now - pending_at) / 100 * 100);
        y = label(layer, x, y, string, DEBUG_UNKNOWN, font, band).top + step;
    } else if (pending) {
        _snwprintf(string, 160, L"Gate cast: prompt seen, %d of %d mana checks passed", cast.checks, CAST_CHECKS);
        y = label(layer, x, y, string, DEBUG_UNKNOWN, font, band).top + step;
    }
    if (now < cast_result_until) label(layer, x, y, cast_result, DEBUG_FOUND, font, band);
    if (prompt) {
        const struct box *box = &prompt_box;
        outline(layer, box->left - 3, box->top - 3, box->right + 3, box->bottom + 3, 2, DEBUG_FOUND, 1);
        RECT mark = label(layer, box->left, box->bottom + 4 + band, L"Gate text prompt detected", DEBUG_FOUND, font, band);
        leader(layer, mark, box->left + 12, box->bottom + 4, DEBUG_FOUND);
    }
}

/* Appends to `string`, which holds `size` characters, and stops at its end instead of overflowing. */
static void append(wchar_t *string, int size, int *used, const wchar_t *format, ...) {
    if (*used >= size - 1) return;
    va_list arguments;
    va_start(arguments, format);
    int written = _vsnwprintf(string + *used, (size_t)(size - *used), format, arguments);
    va_end(arguments);
    *used = written < 0 ? size - 1 : *used + written;
    string[*used] = 0;
}

/*
 * Labels the hotbar and each slot above it: green for a supported skill, amber for any other name,
 * and gray for an empty slot, with a thicker outline for the selected slot.
 */
static void debug_hotbar(struct layer *layer, HFONT font, int band) {
    wchar_t string[160];
    int slot_band = band - 4, top = hotbar.top - slot_band - 2;
    outline(layer, hotbar.left, hotbar.top, hotbar.right, hotbar.bottom, 1, LIGHT, 0.8);
    for (int i = 0; i < slot_count; i++) {
        struct slot box = interiors[i];
        uint32_t color = skill_in[i] >= 0 ? DEBUG_FOUND : skill_in[i] == SLOT_UNKNOWN ? DEBUG_UNKNOWN : DEBUG_EMPTY;
        wchar_t name[64] = L"Empty";
        box.left += hotbar.left, box.right += hotbar.left, box.top += hotbar.top, box.bottom += hotbar.top;
        int line = i == selected ? 4 : 2;
        outline(layer, box.left - line - 1, box.top - line - 1, box.right + line + 1, box.bottom + line + 1, line, color, 1);
        if (skill_in[i] >= 0) {
            MultiByteToWideChar(CP_UTF8, 0, skills[skill_in[i]].name, -1, name, 64);
        } else if (skill_in[i] == SLOT_UNKNOWN) {
            char read[64];
            snprintf(read, sizeof read, "%.*s", (int)strcspn(texts[i], "\n"), texts[i]);
            if (!*read || !MultiByteToWideChar(CP_UTF8, 0, read, -1, name, 64)) wcscpy(name, L"Reading\u2026");
        }
        blend(layer, box.left - 2, top, box.right + 2, top + slot_band - 1, DARK, 0.85);
        blend(layer, box.left - 2, top + slot_band - 2, box.right + 2, top + slot_band - 1, color, 1);
        text(layer, name, box.left - 1, top, box.right + 1, top + slot_band - 3, debug_font, color, 1);
    }
    int used = 0;
    append(string, 160, &used, L"Hotbar: %d slots", slot_count);
    if (selected >= 0) append(string, 160, &used, L", slot %hs selected", KEY_NAMES[selected]);
    if (small_hotbar) append(string, 160, &used, L", too small to read every name");
    if (!config.cooldowns) append(string, 160, &used, L", read for Gate only: cooldown overlay off");
    RECT mark = label(layer, hotbar.left, top - band - 14, string, small_hotbar || !config.cooldowns ? DEBUG_UNKNOWN : DEBUG_FOUND, font, band);
    leader(layer, mark, hotbar.left, top - 2, small_hotbar ? DEBUG_UNKNOWN : DEBUG_FOUND);
}

/*
 * Outlines each backpack slot: green for a supported skill, which is named inside it, amber for any
 * other name, and gray for an empty or unread slot. Returns the bottom of its summary label.
 */
static int debug_backpack(struct layer *layer, HFONT font, int band) {
    wchar_t string[160];
    int supported_count = 0;
    for (int i = 0; i < pack_count; i++) {
        const struct slot *box = &pack[i];
        uint32_t color = pack_skill[i] >= 0 ? DEBUG_FOUND : pack_skill[i] == SLOT_UNKNOWN && pack_texts[i][0] ? DEBUG_UNKNOWN : DEBUG_EMPTY;
        outline(layer, box->left - 3, box->top - 3, box->right + 3, box->bottom + 3, 2, color, 1);
        if (pack_skill[i] < 0) continue;
        wchar_t name[64];
        int band_top = box->bottom - (box->bottom - box->top) / 3;
        supported_count++;
        MultiByteToWideChar(CP_UTF8, 0, skills[pack_skill[i]].name, -1, name, 64);
        blend(layer, box->left, band_top, box->right, box->bottom, DARK, 0.85);
        text(layer, name, box->left, band_top, box->right, box->bottom, debug_font, color, 1);
    }
    _snwprintf(string, 160, L"Backpack open: %d slots, %d with a supported skill", pack_count, supported_count);
    return label(layer, pack_box.left, pack_box.bottom + 8, string, DEBUG_FOUND, font, band).bottom;
}

/*
 * Debug mode: labels what both overlays detect, each with a line to where it was found, over the
 * Roblox window. Only what's found is shown, and the log explains anything missing. The layer is
 * redrawn only when what it shows changes.
 */
static void show_debug(ULONGLONG now, POINT origin) {
    struct layer *layer = &debug_layer;
    int line = client_height / 60 < 13 ? 13 : client_height / 60, band = line + 8;
    long long values[] = {client_width, client_height, locked, state, bar.left, bar.top, bar.right, bar.bottom, percent, mana,
                          (long long)(fill_rate * 10), prompt, prompt_box.left, prompt_box.top, prompt_box.right, prompt_box.bottom,
                          pending, cast.prompted, cast.checks, pending && !cast.prompted ? (long long)((now - pending_at) / 100) : 0,
                          now < cast_result_until, gate_held, hotbar_locked, hotbar_lost > 0, hotbar_state, hotbar.left, hotbar.top,
                          slot_count, selected, small_hotbar, config.enabled, config.gate, config.cooldowns};
    uint64_t hash = 1469598103934665603ull;
    for (size_t i = 0; i < sizeof values / sizeof values[0]; i++) hash = mix(hash, values[i]);
    for (int i = 0; i < slot_count; i++) {
        hash = mix(mix(mix(hash, skill_in[i]), interiors[i].left * 4096 + interiors[i].right), interiors[i].top * 4096 + interiors[i].bottom);
        for (const char *c = texts[i]; *c; c++) hash = mix(hash, *c);
    }
    hash = mix(mix(mix(hash, pack_open), pack_count), pack_box.left * 4096 + pack_box.top);
    for (int i = 0; pack_open && i < pack_count; i++) hash = mix(mix(hash, pack_skill[i]), pack[i].left * 4096 + pack[i].top);
    if (layer->width != client_width || layer->height != client_height) {
        debug_drawn = 0;
        if (!resize(layer, client_width, client_height)) {
            note("warn", "Debug labels couldn't be drawn: a %d by %d layer couldn't be made. Is memory running low?", client_width, client_height);
            hide(layer);
            return;
        }
        if (debug_label_font) DeleteObject(debug_label_font);
        debug_label_font = create_font(line, FW_SEMIBOLD);
    }
    if (hash == debug_drawn) {
        present(layer, origin.x, origin.y, 0);
        return;
    }
    debug_drawn = hash;
    memset(layer->pixels, 0, (size_t)layer->width * (size_t)layer->height * 4);
    int header = 8;
    if (pack_open) header = debug_backpack(layer, debug_label_font, band) + 6;
    label(layer, 8, header, L"Rogue Lineage debug mode. Anything expected but missing here is explained in the Toolblox log.", LIGHT,
          debug_label_font, band);
    if (config.enabled) debug_mana(layer, now, debug_label_font, band);
    if (hotbar_locked && hotbar_state == STATE_TRACKING && !hotbar_lost) debug_hotbar(layer, debug_label_font, band);
    present(layer, origin.x, origin.y, 1);
}

/* Logs whether Gate is equipped when that changes, and why it can't be told. */
static void note_gate(int held) {
    char read[200];
    if (held == logged_held) return;
    logged_held = held;
    if (held == 1) {
        note("info", "Gate is equipped in slot %s.", KEY_NAMES[selected]);
    } else if (held == 0 && selected < 0) {
        note("info", "Gate isn't equipped: no hotbar slot is selected.");
    } else if (held == 0) {
        readings(texts[selected], read, sizeof read);
        note("info", "Gate isn't equipped: slot %s is selected and reads \"%s\".", KEY_NAMES[selected], read);
    } else {
        note("warn", "Whether Gate is equipped can't be told: %s. Right clicks count as Gate casts by the Gate prompt alone.",
             !hotbar_locked ? "the hotbar isn't found" : !reader ? "text recognition isn't available"
             : small_hotbar ? "the selected slot's name is too small to read" : "the selected slot's name isn't read yet");
    }
}

/* Starts debug mode: forgets what was logged, so every step is logged again, and logs what's on. */
static void start_debug(void) {
    logged_focus = -1;
    logged_hotbar_count = -1;
    logged_held = -2;
    logged_mana = MANA_UNKNOWN;
    logged_rate = 0;
    debug_drawn = 0;
    note("info", "Debug mode on. Helper %s. Mana bar overlay %s, Gate backfire warning %s (%d-%d%%), cooldown overlay %s, backpack %s. %d skill%s "
         "in skills.js. Text recognition %s.", HELPER_VERSION, config.enabled ? "on" : "off", config.gate ? "on" : "off", config.gate_min,
         config.gate_max, config.cooldowns ? "on" : "off",
         config.cooldowns || config.backpack ? "watched" : "not watched", skill_count, skill_count == 1 ? "" : "s", reader ? "available" : "unavailable");
    if (!reader) {
        note("warn", "Text recognition isn't available: Windows has no OCR language for this user, so hotbar names can't be read. Is a "
             "language with optical character recognition installed in Windows settings?");
    }
    if (config.enabled && !config.gate) note("info", "The Gate prompt isn't looked for while the Gate backfire warning is off.");
    if (!config.cooldowns) note("info", "Left clicks and hotbar keys aren't watched, so no cooldown starts, while the cooldown overlay is off.");
    if (!config.cooldowns && !(config.enabled && config.gate) && !config.smith) {
        note("info", "The hotbar isn't read while the cooldown overlay, the Gate backfire warning, and blacksmithing are all off.");
    }
    if (config.train || config.smith) {
        note("info", "Automation on: snap training %s (key code %d), blacksmithing %s (key code %d). Keys start and stop it only while Roblox "
             "is focused.", config.train ? "on" : "off", config.train_key, config.smith ? "on" : "off", config.smith_key);
    }
    if (locked) note("info", "Mana bar tracked: its frame runs from %d,%d to %d,%d.", bar.left, bar.top, bar.right, bar.bottom);
    if (hotbar_locked) note("info", "Hotbar tracked: %d slots from %ld,%ld to %ld,%ld.", slot_count, hotbar.left, hotbar.top, hotbar.right, hotbar.bottom);
}

static void tick(void) {
    ULONGLONG now = GetTickCount64();
    HWND window = GetForegroundWindow();
    RECT client = {0, 0, 0, 0};
    POINT origin = {0, 0};
    int down = (GetAsyncKeyState(VK_RBUTTON) & 0x8000) != 0, clicked = down && !right_down;
    right_down = down;
    update_audio(now);
    if (!supported || (!config.enabled && !config.cooldowns && !config.backpack && !config.train && !config.smith)) {
        idle(STATE_OFF);
        hotbar_idle(STATE_OFF);
        set_backpack(0);
        if (source == SOURCE_GRAPHICS) graphics_stop();
        hide(&debug_layer);
        hide(&task_layer);
        return;
    }
    int focused = is_target(window) && !IsIconic(window) && GetClientRect(window, &client) && ClientToScreen(window, &origin) &&
                  client.right >= 100 && client.bottom >= 100;
    if (focused != logged_focus) {
        if (focused) {
            note("info", "Roblox is focused: its window's client area is %ld by %ld, at %ld,%ld on screen.", client.right, client.bottom,
                 origin.x, origin.y);
        } else {
            note("info", "Roblox isn't the focused window, or it's minimized or under 100 by 100 pixels, so nothing is read. Reading "
                 "resumes when RobloxPlayerBeta.exe is focused.");
        }
        logged_focus = focused;
    }
    if (!focused) {
        idle(config.enabled ? STATE_WAITING : STATE_OFF);
        hotbar_idle(config.cooldowns ? STATE_WAITING : STATE_OFF);
        set_backpack(0);
        hide(&debug_layer);
        hide(&task_layer);
        return;
    }
    if (client.right != client_width || client.bottom != client_height) {
        if (client_width) {
            note("info", "Roblox window resized to %ld by %ld: finding the mana bar and hotbar again.", client.right, client.bottom);
        }
        client_width = client.right;
        client_height = client.bottom;
        locked = 0;
        hotbar_locked = 0;
    }
    if (config.cooldowns || (config.enabled && config.gate) || config.smith || config.train) track_hotbar(now, origin);
    else hotbar_idle(STATE_OFF);
    if (config.cooldowns || config.backpack) track_backpack(now, origin);
    else set_backpack(0);
    int held = config.enabled && config.gate ? equipped("Gate") : -1;
    if (held != gate_held) status_dirty = 1;
    gate_held = held;
    if (config.enabled && config.gate) note_gate(held);
    if (config.enabled || config.train) track_mana(now, origin, clicked);
    else idle(STATE_OFF);
    if (hotbar_dirty && hotbar_locked) emit_hotbar();
    if (automation && task_count != emitted_count && now - last_progress >= PROGRESS_MS) emit_task(1, NULL);
    if (config.debug) show_debug(now, origin);
    else hide(&debug_layer);
    show_task(origin);
}

/*
 * The label over the Roblox window while a task runs: the task, its progress, and the key that
 * stops it. It's redrawn when the progress or the window's width changes.
 */
static void show_task(POINT origin) {
    static LONG drawn_count = -1;
    static int drawn_width;
    static HFONT font;
    struct layer *layer = &task_layer;
    if (!automation) {
        hide(layer);
        drawn_count = -1;
        return;
    }
    int changed = task_count != drawn_count || client_width != drawn_width;
    if (changed) {
        wchar_t string[96];
        int height = client_height / 45 < 13 ? 13 : client_height / 45 > 22 ? 22 : client_height / 45;
        int key = (task == TASK_TRAIN ? job.train_key : job.smith_key) - 0x70 + 1;
        _snwprintf(string, 96, task == TASK_TRAIN ? L"Snap training: %ld casts \x00B7 F%d stops" : L"Blacksmithing: %ld made \x00B7 F%d stops",
                   (long)task_count, key);
        if (font) DeleteObject(font);
        font = create_font(height, FW_SEMIBOLD);
        int width = text_width(layer, string, font) + 24, band = height + 12;
        if ((layer->width != width || layer->height != band) && !resize(layer, width, band)) return;
        memset(layer->pixels, 0, (size_t)layer->width * (size_t)layer->height * 4);
        blend(layer, 0, 0, width - 1, band - 1, DARK, 0.85);
        blend(layer, 0, 0, 2, band - 1, DEBUG_FOUND, 1);
        text(layer, string, 6, 0, width - 1, band - 1, font, LIGHT, 1);
        drawn_count = task_count;
        drawn_width = client_width;
    }
    present(layer, origin.x + (client_width - layer->width) / 2, origin.y + 8, changed);
}

/* Hooks input while the cooldown overlay or a task is on, or while a spot is being set. */
static void listen_input(void) {
    hook_input(supported && (config.cooldowns || config.train || config.smith || picking));
}

/* Reports the task that runs or last ran: whether it's running, how many it has done, and why it stopped. */
static void emit_task(int running, const char *reason) {
    emitted_count = (int)task_count;
    last_progress = GetTickCount64();
    emit("{\"type\":\"automation\",\"task\":\"%s\",\"running\":%s,\"count\":%d,\"heard\":%ld,\"reason\":\"%s\"}", TASK_NAMES[task],
         running ? "true" : "false", emitted_count, (long)task_heard, reason ? reason : "");
}

static void emit_audio(void) {
    emit("{\"type\":\"audio\",\"state\":\"%s\",\"chimes\":%d,\"casts\":%d,\"match\":%d,\"error\":\"%08lx\"}", AUDIO_STATES[audio_state], chimes,
         casts_heard, cast_match, (unsigned long)audio_error);
}

/*
 * Listens to the focused Roblox process while snap training is on and game sound is allowed, and
 * stops otherwise. Another Roblox window coming into focus moves listening to its process.
 */
static void update_audio(ULONGLONG now) {
    int needed = supported && config.listen && config.train;
    DWORD process = 0;
    HWND window = GetForegroundWindow();
    if (needed && is_target(window)) GetWindowThreadProcessId(window, &process);
    if (!needed && audio_process) {
        audio_stop();
        audio_process = 0;
        audio_state = AUDIO_OFF;
        emit_audio();
    } else if (needed && process && process != audio_process && now >= audio_retry_at) {
        audio_stop();
        audio_process = process;
        audio_state = audio_start(mana_layer.window, WM_AUDIO, process) ? AUDIO_STARTING : AUDIO_FAILED;
        if (audio_state == AUDIO_FAILED) audio_retry_at = now + AUDIO_RETRY_MS;
        note("info", "Game sound: listening to Roblox's process %lu.", (unsigned long)process);
        emit_audio();
    }
}

/* Handles what the listening thread posts. */
static void audio_event(WPARAM event, LPARAM data) {
    if (event == AUDIO_LISTENING) {
        audio_state = AUDIO_ON;
        audio_error = 0;
        note("info", "Game sound: listening for the mana-full chime and spell casts.");
    } else if (event == AUDIO_ENDED) {
        if (!data) return;
        audio_state = AUDIO_FAILED;
        audio_error = (long)data;
        audio_process = 0;
        audio_retry_at = GetTickCount64() + AUDIO_RETRY_MS;
        note("warn", "Game sound stopped with error %08lx. It's tried again in %d seconds. Process loopback needs Windows 10 version 2004 or later.",
             (unsigned long)data, AUDIO_RETRY_MS / 1000);
    } else if (event == AUDIO_CHIME) {
        full_at = timeGetTime();
        chimes++;
        note("info", "Game sound: mana-full chime heard.");
    } else if (event == AUDIO_CAST) {
        casts_heard++;
        cast_match = (int)data;
        if (automation && task == TASK_TRAIN) InterlockedIncrement(&task_heard);
        note("info", "Game sound: spell cast heard, matching the recorded cast sound by %.3f.", data / 1000.0);
    }
    emit_audio();
}

static void send_key(int scan, int up) {
    INPUT input = {0};
    input.type = INPUT_KEYBOARD;
    input.ki.wScan = (WORD)scan;
    input.ki.dwFlags = KEYEVENTF_SCANCODE | (up ? KEYEVENTF_KEYUP : 0);
    input.ki.dwExtraInfo = INPUT_TAG;
    SendInput(1, &input, sizeof input);
}

static void send_button(int up) {
    INPUT input = {0};
    input.type = INPUT_MOUSE;
    input.mi.dwFlags = up ? MOUSEEVENTF_LEFTUP : MOUSEEVENTF_LEFTDOWN;
    input.mi.dwExtraInfo = INPUT_TAG;
    SendInput(1, &input, sizeof input);
}

/* Moves the cursor with a mouse move event too, as the game learns where the cursor is only from those. */
static void send_move(int x, int y) {
    int left = GetSystemMetrics(SM_XVIRTUALSCREEN), top = GetSystemMetrics(SM_YVIRTUALSCREEN);
    int width = GetSystemMetrics(SM_CXVIRTUALSCREEN), height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
    INPUT input = {0};
    SetCursorPos(x, y);
    input.type = INPUT_MOUSE;
    input.mi.dx = (LONG)((long long)(x - left) * 65535 / (width > 1 ? width - 1 : 1));
    input.mi.dy = (LONG)((long long)(y - top) * 65535 / (height > 1 ? height - 1 : 1));
    input.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
    input.mi.dwExtraInfo = INPUT_TAG;
    SendInput(1, &input, sizeof input);
}

/* Presses and lets go of a key. Both are sent, so a key is never left down. */
static void tap(int scan) {
    send_key(scan, 0);
    Sleep(1);
    send_key(scan, 1);
}

/*
 * Waits `ms` on the task thread. Returns 0 when the task should stop: it was stopped, or the Roblox
 * window it started in is no longer focused, which is checked before anything is sent.
 */
static int task_wait(DWORD ms) {
    if (WaitForSingleObject(automation_stop, ms) == WAIT_OBJECT_0) return 0;
    if (GetForegroundWindow() == task_window) return 1;
    task_reason = "Roblox isn't focused";
    return 0;
}

static void hold_charge(int down) {
    if (down == held_charge) return;
    send_key(SCAN_CHARGE, !down);
    held_charge = down;
    charge_since = timeGetTime();
}

/*
 * While casting, the charge key is pressed for TRAIN_G_HOLD_MS every TRAIN_G_GAP_MS to keep mana
 * up, and let go once mana reaches `high`, as the Rogue Lineage Assist Tool does.
 */
static void spam_charge(double high) {
    DWORD since = timeGetTime() - charge_since;
    if (mana_level >= high) hold_charge(0);
    else if (since >= (held_charge ? TRAIN_G_HOLD_MS : TRAIN_G_GAP_MS)) hold_charge(!held_charge);
}

/* Waits `ms` while keeping the charge key going. Returns 0 when the task should stop. */
static int rest(DWORD ms, double high) {
    DWORD start = timeGetTime();
    for (;;) {
        spam_charge(high);
        if (timeGetTime() - start >= ms) return 1;
        if (!task_wait(2)) return 0;
    }
}

/* Equips the spell, casts it, and puts it away before the cast finishes, then rests. */
static int snap(int slot, double high) {
    tap(slot + 2);
    Sleep(TRAIN_STEP_MS);
    send_button(0);
    Sleep(1);
    send_button(1);
    Sleep(TRAIN_STEP_MS);
    tap(slot + 2);
    return rest(TRAIN_REST_MS, high);
}

/* Returns 1 when the mana-full chime was heard at or after `since`, by timeGetTime. */
static int heard_full(DWORD since) {
    DWORD at = full_at;
    return at && (LONG)(at - since) >= 0;
}

static void run_training(void) {
    double low, high;
    int phase = -1;
    DWORD since = 0, lost = 0, pause = 0;
    train_band(job.train_min, job.train_max, job.train_middle, &low, &high);
    while (task_wait(pause)) {
        DWORD now = timeGetTime();
        pause = 2;
        if (!mana_valid) {
            hold_charge(0);
            if (!lost) lost = now;
            if (now - lost < TRAIN_LOST_MS) continue;
            task_reason = "the mana bar isn't found";
            return;
        }
        lost = 0;
        double level = mana_level;
        int next = phase < 0 ? train_start(level, low) : train_next(phase, level, low, high, now - since, heard_full(since));
        if (next != phase) {
            phase = next;
            since = now;
        }
        if (phase == TRAIN_CHARGE) {
            hold_charge(1);
        } else if (phase == TRAIN_RECOVER || level > high) {
            hold_charge(0);
        } else {
            if (!snap(job.train_slot, high)) return;
            InterlockedIncrement(&task_count);
            pause = 0;
        }
    }
}

/*
 * Returns 1 when the hotbar shows slot `slot` empty, which is how running out of an item shows.
 * ponytail: reads the main thread's hotbar state without a lock; a stale read only delays the stop.
 */
static int slot_empty(int slot) {
    return hotbar_locked && slot < slot_count && seen[slot] == 1 && skill_in[slot] == SLOT_EMPTY;
}

/* Moves to a spot and clicks it. Returns 0 when the task should stop. */
static int click_spot(int x, int y) {
    RECT client;
    POINT origin = {0, 0};
    if (!task_wait(0) || !GetClientRect(task_window, &client) || !ClientToScreen(task_window, &origin)) return 0;
    send_move(origin.x + (int)((long long)client.right * x / 10000), origin.y + (int)((long long)client.bottom * y / 10000));
    if (!task_wait(SMITH_ARRIVE_MS)) return 0;
    held_button = 1;
    send_button(0);
    Sleep(SMITH_HOLD_MS);
    send_button(1);
    held_button = 0;
    return 1;
}

static void run_smithing(void) {
    struct smith_action actions[SMITH_ACTIONS];
    int count = smith_actions(job.smith_slots, job.smith_clicks, job.smith_steps, actions);
    for (int made = 0; made < job.smith_count; made++) {
        for (int i = 0; i < count; i++) {
            const struct smith_action *action = &actions[i];
            if (action->kind == SMITH_PICK) {
                if (slot_empty(action->slot)) {
                    task_reason = "a step's hotbar slot is empty";
                    return;
                }
                if (!task_wait(0)) return;
                tap(action->slot + 2);
                if (!task_wait((DWORD)job.smith_pick_ms)) return;
            } else if (action->kind == SMITH_ANVIL) {
                if (!click_spot(job.anvil_x, job.anvil_y) || !task_wait((DWORD)job.smith_click_ms)) return;
            } else {
                if (!task_wait((DWORD)job.smith_before_ms) || !click_spot(job.hammer_x, job.hammer_y)) return;
                InterlockedIncrement(&task_count);
                if (!task_wait((DWORD)job.smith_after_ms)) return;
            }
        }
    }
    task_reason = "finished";
}

/* Runs the task, lets go of anything it holds, and tells the main thread it ended. */
static DWORD WINAPI run_task(void *unused) {
    (void)unused;
    held_charge = held_button = 0;
    charge_since = timeGetTime();
    if (task == TASK_TRAIN) run_training();
    else run_smithing();
    if (held_charge) send_key(SCAN_CHARGE, 1);
    if (held_button) send_button(1);
    held_charge = held_button = 0;
    PostMessageW(mana_layer.window, WM_TASK_DONE, 0, 0);
    return 0;
}

/* Returns why task `which` can't start, or NULL. */
static const char *task_problem(int which) {
    if (which == TASK_TRAIN) {
        if (!config.train_name[0] || config.train_max <= config.train_min) return "no spell is set";
        if (hotbar_state != STATE_TRACKING) return "the hotbar isn't found";
        if (find_slot(config.train_name) < 0) return "the spell isn't on the hotbar";
        return mana_valid ? NULL : "the mana bar isn't found";
    }
    if (!config.smith_steps) return "no steps are set";
    if (config.anvil_x < 0 || config.anvil_y < 0) return "the anvil isn't set";
    return config.hammer_x < 0 || config.hammer_y < 0 ? "the hammer isn't set" : NULL;
}

static void start_task(int which) {
    const char *problem = task_problem(which);
    task = which;
    task_count = 0;
    task_heard = 0;
    if (problem) {
        note("warn", "%s didn't start: %s.", which == TASK_TRAIN ? "Snap training" : "Blacksmithing", problem);
        emit_task(0, problem);
        return;
    }
    job = config;
    if (which == TASK_TRAIN) job.train_slot = find_slot(job.train_name);
    task_window = GetForegroundWindow();
    task_reason = "stopped";
    ResetEvent(automation_stop);
    timeBeginPeriod(1);
    automation = CreateThread(NULL, 0, run_task, NULL, 0, NULL);
    if (!automation) {
        timeEndPeriod(1);
        emit_task(0, "the task couldn't start");
        return;
    }
    note("info", "%s started.", which == TASK_TRAIN ? "Snap training" : "Blacksmithing");
    emit_task(1, NULL);
}

static void stop_task(void) {
    if (automation) SetEvent(automation_stop);
}

static void finish_task(void) {
    if (!automation) return;
    WaitForSingleObject(automation, INFINITE);
    CloseHandle(automation);
    automation = NULL;
    timeEndPeriod(1);
    note("info", "%s ended after %ld: %s.", task == TASK_TRAIN ? "Snap training" : "Blacksmithing", task_count, task_reason);
    emit_task(0, task_reason);
}

/* A task key, pressed while Roblox is focused. It stops whatever task runs, or starts its own. */
static void press_task(int which) {
    if (!is_target(GetForegroundWindow())) return;
    if (automation) stop_task();
    else if (which == TASK_TRAIN ? config.train : config.smith) start_task(which);
}

/* Sets the spot being picked to a left click inside the Roblox window. Clicks elsewhere are ignored. */
static void pick_spot(POINT point) {
    HWND window = GetForegroundWindow();
    POINT origin = {0, 0};
    RECT client;
    if (!is_target(window) || !GetClientRect(window, &client) || !ClientToScreen(window, &origin)) return;
    point.x -= origin.x;
    point.y -= origin.y;
    if (point.x < 0 || point.y < 0 || point.x >= client.right || point.y >= client.bottom) return;
    emit("{\"type\":\"spot\",\"spot\":\"%s\",\"x\":%ld,\"y\":%ld}", picking == 1 ? "anvil" : "hammer", point.x * 10000 / client.right,
         point.y * 10000 / client.bottom);
    picking = 0;
    listen_input();
}

static LRESULT CALLBACK overlay_proc(HWND window, UINT message, WPARAM wide, LPARAM data) {
    switch (message) {
    case WM_TIMER:
        tick();
        emit_status(GetTickCount64());
        return 0;
    case WM_CONFIGURE: {
        struct config before = config;
        EnterCriticalSection(&config_lock);
        config = incoming;
        LeaveCriticalSection(&config_lock);
        if (config.debug && !before.debug) start_debug();
        else {
            if (config.enabled != before.enabled) note("info", "Mana bar overlay turned %s.", config.enabled ? "on" : "off");
            if (config.gate != before.gate) note("info", "Gate backfire warning turned %s.", config.gate ? "on" : "off");
            if (config.train != before.train || strcmp(config.train_name, before.train_name)) hotbar_dirty = 1;
            if (config.cooldowns != before.cooldowns) {
                note("info", "Cooldown overlay turned %s.%s", config.cooldowns ? "on" : "off",
                     config.cooldowns ? " Hotbar keys and left clicks in Roblox are watched." : "");
            }
            if (config.backpack != before.backpack) {
                note("info", "Another widget %s watching the backpack.", config.backpack ? "started" : "stopped");
            }
        }
        if (locked) layout();
        task_keys[TASK_TRAIN] = config.train ? config.train_key : 0;
        task_keys[TASK_SMITH] = config.smith ? config.smith_key : 0;
        if (automation && !(task == TASK_TRAIN ? config.train : config.smith)) stop_task();
        listen_input();
        status_dirty = 1;
        return 0;
    }
    case WM_TASK_KEY:
        press_task((int)wide);
        return 0;
    case WM_TASK_DONE:
        finish_task();
        return 0;
    case WM_AUDIO:
        audio_event(wide, data);
        return 0;
    case WM_PICK:
        picking = (int)wide;
        if (picking) note("info", "Waiting for a left click in Roblox to set the %s.", picking == 1 ? "anvil" : "hammer");
        listen_input();
        return 0;
    case WM_HOTBAR_KEY:
        press_key((int)wide);
        return 0;
    case WM_LEFT_CLICK:
        if (picking) pick_spot((POINT){(LONG)(LONG_PTR)wide, (LONG)data});
        else if (config.cooldowns) use_skill((POINT){(LONG)(LONG_PTR)wide, (LONG)data});
        return 0;
    case WM_SLOT_TEXT: {
        struct reading *reading = (struct reading *)data;
        int in_pack = reading->slot - HOTBAR_SLOTS;
        if (in_pack >= 0 && reading->serial == pack_serials[in_pack]) {
            int found = match_texts(reading->texts);
            char read[200];
            memcpy(pack_texts[in_pack], reading->texts, sizeof pack_texts[0]);
            pack_skill[in_pack] = found;
            readings(reading->texts, read, sizeof read);
            if (found >= 0) note("info", "Backpack slot %d reads \"%s\": %s.", in_pack + 1, read, skills[found].name);
            else note("info", "Backpack slot %d reads \"%s\", which isn't a skill in skills.js.", in_pack + 1, read);
        } else if (reading->slot < slot_count && reading->serial == serials[reading->slot]) {
            int slot = reading->slot, found = match_texts(reading->texts);
            char read[200];
            memcpy(texts[slot], reading->texts, sizeof texts[0]);
            skill_in[slot] = found;
            if (found >= 0 || letter_count(reading->texts) >= SLOT_MIN_LETTERS) last_skill[slot] = found >= 0 ? found : -1;
            hotbar_dirty = 1;
            readings(reading->texts, read, sizeof read);
            if (found >= 0) {
                note("info", "Slot %s reads \"%s\": %s, with a %.1f s cooldown.", KEY_NAMES[slot], read, skills[found].name,
                     (double)skills[found].cooldown / 1000.0);
            } else if (letter_count(reading->texts) < SLOT_MIN_LETTERS) {
                note("warn", "Slot %s: too little text was read (\"%s\"). Is the hotbar large enough to read?", KEY_NAMES[slot], read);
            } else {
                note("info", "Slot %s reads \"%s\", which isn't a skill in skills.js.", KEY_NAMES[slot], read);
            }
        }
        free(reading);
        return 0;
    }
    case WM_READER:
        reader = 0;
        hotbar_dirty = 1;
        note("warn", "Text recognition isn't available: Windows has no OCR language for this user, so hotbar names can't be read.");
        return 0;
    case WM_SKILL: {
        struct skill *skill = (struct skill *)data;
        int index = 0;
        while (index < skill_count && strcmp(skills[index].id, skill->id)) index++;
        if (index < MAX_SKILLS) {
            skill->ready_at = index < skill_count ? skills[index].ready_at : 0;
            skills[index] = *skill;
            if (index == skill_count) skill_count++;
            for (int i = 0; i < slot_count; i++) {
                if (skill_in[i] != SLOT_EMPTY && texts[i][0]) skill_in[i] = match_texts(texts[i]);
                if (skill_in[i] >= 0) last_skill[i] = skill_in[i];
            }
            for (int i = 0; i < pack_count; i++) {
                if (pack_skill[i] != SLOT_EMPTY && pack_texts[i][0]) pack_skill[i] = match_texts(pack_texts[i]);
            }
            hotbar_dirty = 1;
        }
        free(skill);
        return 0;
    }
    case WM_DESCRIBE:
        emitted_count = -1;
        emit_audio();
        emit("{\"type\":\"ready\",\"version\":\"%s\",\"supported\":%s,\"error\":%lu,\"build\":%lu,\"capture\":\"%s\"}", HELPER_VERSION,
             supported ? "true" : "false", support_error, windows_build, SOURCE_NAMES[source]);
        status_dirty = 1;
        hotbar_dirty = 1;
        return 0;
    case WM_TEST: {
        RECT area = {0, 0, GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)};
        HWND target = GetForegroundWindow();
        POINT origin = {0, 0};
        RECT client;
        if (is_target(target) && GetClientRect(target, &client) && ClientToScreen(target, &origin)) {
            area = (RECT){origin.x, origin.y, origin.x + client.right, origin.y + client.bottom};
        }
        start_flash(area, L"Warning test");
        return 0;
    }
    default:
        return DefWindowProcW(window, message, wide, data);
    }
}

/*
 * Copies a field's value from a one-line JSON object. Returns 0 when the field is missing.
 * ponytail: no escapes or nesting, since main.js sends only numbers, booleans, and plain names.
 * Use a real parser if messages grow.
 */
static int field(const char *line, const char *key, char *out, size_t size) {
    char pattern[40];
    snprintf(pattern, sizeof pattern, "\"%s\":", key);
    const char *c = strstr(line, pattern);
    if (!c) return 0;
    c += strlen(pattern);
    int quoted = *c == '"';
    size_t used = 0;
    if (quoted) c++;
    while (*c && (quoted ? *c != '"' : *c != ',' && *c != '}') && used + 1 < size) out[used++] = *c++;
    out[used] = 0;
    return 1;
}

/* Reads a whole number from `low` to `high`, or returns `fallback`. */
static int bounded(const char *value, int low, int high, int fallback) {
    char *end;
    long number = strtol(value, &end, 10);
    return end == value || *end || number < low || number > high ? fallback : (int)number;
}

static int percentage(const char *value, int fallback) {
    int number = atoi(value);
    return *value < '0' || *value > '9' ? fallback : number > 100 ? 100 : number;
}

/* Reads a configure message. Zones are "min:max:rrggbb:name" joined by ";". */
static void configure(const char *line) {
    static char value[2048];
    struct config next = {0};
    next.sound = 1;
    next.gate_min = 75;
    next.gate_max = 85;
    next.shade = DARK;
    next.shade_opacity = 60;
    next.countdown = 1;
    if (field(line, "backpack", value, sizeof value)) next.backpack = !strcmp(value, "true");
    if (field(line, "enabled", value, sizeof value)) next.enabled = !strcmp(value, "true");
    if (field(line, "gate", value, sizeof value)) next.gate = !strcmp(value, "true");
    if (field(line, "sound", value, sizeof value)) next.sound = !strcmp(value, "true");
    if (field(line, "gateMin", value, sizeof value)) next.gate_min = percentage(value, 75);
    if (field(line, "gateMax", value, sizeof value)) next.gate_max = percentage(value, 85);
    if (field(line, "cooldowns", value, sizeof value)) next.cooldowns = !strcmp(value, "true");
    if (field(line, "countdown", value, sizeof value)) next.countdown = !strcmp(value, "true");
    if (field(line, "debug", value, sizeof value)) next.debug = !strcmp(value, "true");
    if (field(line, "shadeOpacity", value, sizeof value)) next.shade_opacity = percentage(value, 60);
    if (field(line, "shade", value, sizeof value) && strlen(value) == 6 && strspn(value, "0123456789abcdefABCDEF") == 6) {
        next.shade = (uint32_t)strtoul(value, NULL, 16);
    }
    next.train_slot = -1;
    next.train_middle = 60;
    next.anvil_x = next.anvil_y = next.hammer_x = next.hammer_y = -1;
    next.smith_count = 1;
    next.smith_click_ms = 100;
    next.smith_pick_ms = 20;
    next.smith_before_ms = 250;
    next.smith_after_ms = 300;
    next.listen = 1;
    if (field(line, "listen", value, sizeof value)) next.listen = !strcmp(value, "true");
    if (field(line, "train", value, sizeof value)) next.train = !strcmp(value, "true");
    if (field(line, "trainKey", value, sizeof value)) next.train_key = bounded(value, 0, 0xFE, 0);
    if (field(line, "trainName", value, sizeof value)) {
        size_t length = 0;
        for (const char *c = value; *c && length + 1 < sizeof next.train_name; c++)
            if (*c >= ' ' && *c <= '~') next.train_name[length++] = *c;
        next.train_name[length] = 0;
    }
    if (field(line, "trainMin", value, sizeof value)) next.train_min = bounded(value, 0, 100, 0);
    if (field(line, "trainMax", value, sizeof value)) next.train_max = bounded(value, 0, 100, 0);
    if (field(line, "trainMiddle", value, sizeof value)) next.train_middle = bounded(value, 10, 100, 60);
    if (field(line, "smith", value, sizeof value)) next.smith = !strcmp(value, "true");
    if (field(line, "smithKey", value, sizeof value)) next.smith_key = bounded(value, 0, 0xFE, 0);
    if (field(line, "smithCount", value, sizeof value)) next.smith_count = bounded(value, 1, 9999, 1);
    if (field(line, "anvilX", value, sizeof value)) next.anvil_x = bounded(value, -1, 10000, -1);
    if (field(line, "anvilY", value, sizeof value)) next.anvil_y = bounded(value, -1, 10000, -1);
    if (field(line, "hammerX", value, sizeof value)) next.hammer_x = bounded(value, -1, 10000, -1);
    if (field(line, "hammerY", value, sizeof value)) next.hammer_y = bounded(value, -1, 10000, -1);
    if (field(line, "smithClick", value, sizeof value)) next.smith_click_ms = bounded(value, 0, 5000, 100);
    if (field(line, "smithPick", value, sizeof value)) next.smith_pick_ms = bounded(value, 0, 5000, 20);
    if (field(line, "smithBefore", value, sizeof value)) next.smith_before_ms = bounded(value, 0, 5000, 250);
    if (field(line, "smithAfter", value, sizeof value)) next.smith_after_ms = bounded(value, 0, 5000, 300);
    if (field(line, "smithSteps", value, sizeof value)) {
        for (char *item = strtok(value, ";"); item && next.smith_steps < SMITH_STEPS; item = strtok(NULL, ";")) {
            int slot, clicks;
            if (sscanf(item, "%d:%d", &slot, &clicks) != 2 || slot < 0 || slot >= HOTBAR_SLOTS || clicks < 1 || clicks > SMITH_CLICKS) continue;
            next.smith_slots[next.smith_steps] = slot;
            next.smith_clicks[next.smith_steps++] = clicks;
        }
    }
    if (field(line, "zones", value, sizeof value)) {
        for (char *item = strtok(value, ";"); item && next.zone_count < MAX_ZONES; item = strtok(NULL, ";")) {
            struct zone *zone = &next.zones[next.zone_count];
            unsigned color = 0;
            char name[64] = "";
            if (sscanf(item, "%d:%d:%6x:%63[^;]", &zone->min, &zone->max, &color, name) != 4) continue;
            if (zone->min < 0 || zone->max > 100 || zone->min > zone->max) continue;
            if (!MultiByteToWideChar(CP_UTF8, 0, name, -1, zone->name, 32)) continue;
            zone->color = color;
            next.zone_count++;
        }
    }
    EnterCriticalSection(&config_lock);
    incoming = next;
    LeaveCriticalSection(&config_lock);
    PostMessageW(mana_layer.window, WM_CONFIGURE, 0, 0);
}

/*
 * Reads a skills message, the whole catalogue in one line as "id:name:milliseconds" joined by ";".
 * IDs hold lowercase letters, digits, "_", and "-", and names the text shown in the hotbar. Entries
 * that don't fit are skipped.
 */
static void add_skills(const char *line) {
    static char value[8192];
    if (!field(line, "value", value, sizeof value)) return;
    for (char *item = strtok(value, ";"); item; item = strtok(NULL, ";")) {
        char id[32], name[32];
        long milliseconds;
        if (sscanf(item, "%31[^:]:%31[^:]:%ld", id, name, &milliseconds) != 3) continue;
        if (strspn(id, "abcdefghijklmnopqrstuvwxyz0123456789_-") != strlen(id) || milliseconds <= 0 || milliseconds > MAX_COOLDOWN_MS) continue;
        struct skill *skill = calloc(1, sizeof *skill);
        if (!skill) return;
        strcpy(skill->id, id);
        strcpy(skill->name, name);
        skill->cooldown = (ULONGLONG)milliseconds;
        if (!PostMessageW(mana_layer.window, WM_SKILL, 0, (LPARAM)skill)) free(skill);
    }
}

/* Exits when standard input closes, so the helper never outlives Toolblox. */
static DWORD WINAPI read_input(void *unused) {
    (void)unused;
    static char line[8192];
    char type[32];
    while (fgets(line, sizeof line, stdin)) {
        if (!field(line, "type", type, sizeof type)) continue;
        if (!strcmp(type, "configure")) configure(line);
        else if (!strcmp(type, "skills")) add_skills(line);
        else if (!strcmp(type, "describe")) PostMessageW(mana_layer.window, WM_DESCRIBE, 0, 0);
        else if (!strcmp(type, "test")) PostMessageW(mana_layer.window, WM_TEST, 0, 0);
        else if (!strcmp(type, "pick")) {
            char spot[16] = "";
            field(line, "spot", spot, sizeof spot);
            PostMessageW(mana_layer.window, WM_PICK, !strcmp(spot, "anvil") ? 1 : !strcmp(spot, "hammer") ? 2 : 0, 0);
        }
    }
    HANDLE running = automation;
    if (running) {
        SetEvent(automation_stop);
        WaitForSingleObject(running, 1000);
    }
    ExitProcess(0);
}

static HWND create_window(const wchar_t *name, WNDPROC proc) {
    WNDCLASSW type = {0};
    type.lpfnWndProc = proc;
    type.hInstance = GetModuleHandleW(NULL);
    type.lpszClassName = name;
    if (!RegisterClassW(&type)) return NULL;
    return CreateWindowExW(WS_EX_TOPMOST | WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, name,
                           L"Rogue Lineage", WS_POPUP, 0, 0, 1, 1, NULL, NULL, type.hInstance, NULL);
}

/* Leaves a window out of screen capture, and records the first failure's error code. */
static int exclude(HWND window) {
    if (SetWindowDisplayAffinity(window, WDA_EXCLUDEFROMCAPTURE)) return 1;
    if (!support_error) support_error = GetLastError();
    return 0;
}

/* The Windows build number. GetVersionEx reports an older version to programs without a manifest. */
static DWORD read_windows_build(void) {
    RTL_OSVERSIONINFOW info = {0};
    info.dwOSVersionInfoSize = sizeof info;
    LONG(WINAPI * get_version)(RTL_OSVERSIONINFOW *) = (LONG(WINAPI *)(RTL_OSVERSIONINFOW *))(void *)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion");
    return get_version && get_version(&info) == 0 ? info.dwBuildNumber : 0;
}

static int create_layer(struct layer *layer, const wchar_t *name, WNDPROC proc) {
    layer->window = create_window(name, proc);
    layer->dc = CreateCompatibleDC(screen_dc);
    layer->glyph_dc = CreateCompatibleDC(screen_dc);
    if (!layer->window || !layer->dc || !layer->glyph_dc) return 0;
    SetBkMode(layer->glyph_dc, TRANSPARENT);
    SetTextColor(layer->glyph_dc, RGB(255, 255, 255));
    return 1;
}

int main(void) {
    HMODULE user = GetModuleHandleW(L"user32.dll");
    BOOL(WINAPI * set_awareness)(HANDLE) = (BOOL(WINAPI *)(HANDLE))(void *)GetProcAddress(user, "SetProcessDpiAwarenessContext");
    if (set_awareness) set_awareness((HANDLE)-4);
    else SetProcessDPIAware();

    InitializeCriticalSection(&config_lock);
    InitializeCriticalSection(&request_lock);
    request_ready = CreateEventW(NULL, FALSE, FALSE, NULL);
    automation_stop = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (!automation_stop) return 1;
    screen_dc = GetDC(NULL);
    capture_dc = CreateCompatibleDC(screen_dc);
    if (!screen_dc || !capture_dc) return 1;
    if (!create_layer(&mana_layer, L"ToolbloxRogueLineageOverlay", overlay_proc) ||
        !create_layer(&cooldown_layer, L"ToolbloxRogueLineageCooldowns", DefWindowProcW) ||
        !create_layer(&debug_layer, L"ToolbloxRogueLineageDebug", DefWindowProcW) ||
        !create_layer(&backpack_layer, L"ToolbloxRogueLineageBackpack", DefWindowProcW) ||
        !create_layer(&task_layer, L"ToolbloxRogueLineageTask", DefWindowProcW)) return 1;
    flash = create_window(L"ToolbloxRogueLineageWarning", flash_proc);
    if (!flash) return 1;
    windows_build = read_windows_build();
    int excluded = exclude(mana_layer.window) && exclude(cooldown_layer.window) && exclude(debug_layer.window) &&
                   exclude(backpack_layer.window) && exclude(task_layer.window) && exclude(flash);
    frame_dc = CreateCompatibleDC(screen_dc);
    /*
     * Windows.Graphics.Capture is preferred where its border can be turned off, which is Windows 11,
     * and used anywhere the screen can't leave the overlays out. TOOLBLOX_RL_SOURCE picks a source,
     * to test each one on one device.
     */
    const char *forced = getenv("TOOLBLOX_RL_SOURCE");
    int graphics = graphics_start();
    if (forced && !strcmp(forced, "graphics") && graphics) source = SOURCE_GRAPHICS;
    else if (forced && !strcmp(forced, "print") && frame_dc) source = SOURCE_PRINT;
    else if (forced && !strcmp(forced, "screen")) source = SOURCE_SCREEN;
    else if (graphics && (windows_build >= 22000 || !excluded)) source = SOURCE_GRAPHICS;
    else if (!excluded && frame_dc) source = SOURCE_PRINT;
    supported = excluded || source != SOURCE_SCREEN;

    PostMessageW(mana_layer.window, WM_DESCRIBE, 0, 0);
    CreateThread(NULL, 0, read_input, NULL, 0, NULL);
    if (!request_ready || !CreateThread(NULL, 0, read_text, NULL, 0, NULL)) reader = 0;
    SetTimer(mana_layer.window, 1, TICK_MS, NULL);
    MSG message;
    while (GetMessageW(&message, NULL, 0, 0) > 0) DispatchMessageW(&message);
    return 0;
}
