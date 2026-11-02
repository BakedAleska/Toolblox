/*
 * The autoclicker helper's shared core.
 *
 * Reads one JSON object per line from standard input and writes one per line to standard output.
 * Clicks run on their own thread at a fixed rate, capped at what this device's timer measured.
 * The reported rate is the measured rate of clicks sent, not the requested one.
 */
#include <pthread.h>
#include <stdarg.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>

#include "clicker.h"

#define MAX_BINDS 16
#define MAX_FIELDS 16
#define MAX_VALUE 1024
#define CPS_LIMIT 1000
#define CALIBRATION_WAITS 100
#define STATUS_INTERVAL_NS 250000000ull
#define SECOND_NS 1000000000ull

enum mode { MODE_TOGGLE, MODE_ENABLE, MODE_DISABLE, MODE_HOLD };

struct bind {
    int code;
    enum mode mode;
    int down;
};

struct field {
    char key[32];
    char value[MAX_VALUE];
};

/*
 * Keys by their KeyboardEvent.code name, with the Windows scan code (0x100 marks an extended key)
 * and the macOS virtual key code. Both are physical positions, like KeyboardEvent.code.
 */
static const struct key {
    const char *name;
    int windows;
    int macos;
} keys[] = {
    {"KeyA", 0x1E, 0x00}, {"KeyB", 0x30, 0x0B}, {"KeyC", 0x2E, 0x08}, {"KeyD", 0x20, 0x02},
    {"KeyE", 0x12, 0x0E}, {"KeyF", 0x21, 0x03}, {"KeyG", 0x22, 0x05}, {"KeyH", 0x23, 0x04},
    {"KeyI", 0x17, 0x22}, {"KeyJ", 0x24, 0x26}, {"KeyK", 0x25, 0x28}, {"KeyL", 0x26, 0x25},
    {"KeyM", 0x32, 0x2E}, {"KeyN", 0x31, 0x2D}, {"KeyO", 0x18, 0x1F}, {"KeyP", 0x19, 0x23},
    {"KeyQ", 0x10, 0x0C}, {"KeyR", 0x13, 0x0F}, {"KeyS", 0x1F, 0x01}, {"KeyT", 0x14, 0x11},
    {"KeyU", 0x16, 0x20}, {"KeyV", 0x2F, 0x09}, {"KeyW", 0x11, 0x0D}, {"KeyX", 0x2D, 0x07},
    {"KeyY", 0x15, 0x10}, {"KeyZ", 0x2C, 0x06},
    {"Digit1", 0x02, 0x12}, {"Digit2", 0x03, 0x13}, {"Digit3", 0x04, 0x14},
    {"Digit4", 0x05, 0x15}, {"Digit5", 0x06, 0x17}, {"Digit6", 0x07, 0x16},
    {"Digit7", 0x08, 0x1A}, {"Digit8", 0x09, 0x1C}, {"Digit9", 0x0A, 0x19},
    {"Digit0", 0x0B, 0x1D},
    {"F1", 0x3B, 0x7A}, {"F2", 0x3C, 0x78}, {"F3", 0x3D, 0x63}, {"F4", 0x3E, 0x76},
    {"F5", 0x3F, 0x60}, {"F6", 0x40, 0x61}, {"F7", 0x41, 0x62}, {"F8", 0x42, 0x64},
    {"F9", 0x43, 0x65}, {"F10", 0x44, 0x6D}, {"F11", 0x57, 0x67}, {"F12", 0x58, 0x6F},
    {"Backquote", 0x29, 0x32}, {"Minus", 0x0C, 0x1B}, {"Equal", 0x0D, 0x18},
    {"BracketLeft", 0x1A, 0x21}, {"BracketRight", 0x1B, 0x1E}, {"Backslash", 0x2B, 0x2A},
    {"Semicolon", 0x27, 0x29}, {"Quote", 0x28, 0x27}, {"Comma", 0x33, 0x2B},
    {"Period", 0x34, 0x2F}, {"Slash", 0x35, 0x2C},
    {"Space", 0x39, 0x31}, {"Tab", 0x0F, 0x30}, {"Enter", 0x1C, 0x24},
    {"Backspace", 0x0E, 0x33}, {"Insert", 0x152, 0x72}, {"Delete", 0x153, 0x75},
    {"Home", 0x147, 0x73}, {"End", 0x14F, 0x77}, {"PageUp", 0x149, 0x74},
    {"PageDown", 0x151, 0x79}, {"ArrowUp", 0x148, 0x7E}, {"ArrowDown", 0x150, 0x7D},
    {"ArrowLeft", 0x14B, 0x7B}, {"ArrowRight", 0x14D, 0x7C},
    {"Numpad0", 0x52, 0x52}, {"Numpad1", 0x4F, 0x53}, {"Numpad2", 0x50, 0x54},
    {"Numpad3", 0x51, 0x55}, {"Numpad4", 0x4B, 0x56}, {"Numpad5", 0x4C, 0x57},
    {"Numpad6", 0x4D, 0x58}, {"Numpad7", 0x47, 0x59}, {"Numpad8", 0x48, 0x5B},
    {"Numpad9", 0x49, 0x5C}, {"NumpadAdd", 0x4E, 0x45}, {"NumpadSubtract", 0x4A, 0x4E},
    {"NumpadMultiply", 0x37, 0x43}, {"NumpadDivide", 0x135, 0x4B},
    {"NumpadDecimal", 0x53, 0x41}, {"NumpadEnter", 0x11C, 0x4C},
};

static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_mutex_t output_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t wake = PTHREAD_COND_INITIALIZER;
static struct bind binds[MAX_BINDS];
static int bind_count;

static atomic_int latched;
static atomic_int held;
static atomic_int roblox_focused;
static atomic_int only_roblox = 1;
static atomic_int button = 1;
static atomic_int target_cps = 10;
static atomic_int measured_cps;
/* The indicator position in ten-thousandths of the screen, or -1 for the default spot. */
static atomic_int position_x = -1;
static atomic_int position_y = -1;
static atomic_int position_version;
/* Indicator background transparency in percent, and whether the indicator is shown. */
static atomic_int transparency = 10;
static atomic_int indicator_visible = 1;
static int max_cps = 1;
static double timer_ms;
static atomic_int force_status;
/* The latest permissions line, repeated when the widget asks for a description. */
static char permissions_line[96];

int platform_key_code(const char *name) {
    if (strncmp(name, "Mouse", 5) == 0 && name[5] >= '1' && name[5] <= '5' && !name[6]) {
        return MOUSE_CODE(name[5] - '0');
    }
    for (size_t i = 0; i < sizeof keys / sizeof keys[0]; i++) {
        if (strcmp(keys[i].name, name) == 0) {
#ifdef _WIN32
            return keys[i].windows;
#else
            return keys[i].macos;
#endif
        }
    }
    return -1;
}

void core_emit(const char *format, ...) {
    va_list arguments;
    va_start(arguments, format);
    pthread_mutex_lock(&output_lock);
    vfprintf(stdout, format, arguments);
    fputc('\n', stdout);
    fflush(stdout);
    pthread_mutex_unlock(&output_lock);
    va_end(arguments);
}

void core_permissions(int keybinds, int clicks) {
    pthread_mutex_lock(&output_lock);
    snprintf(permissions_line, sizeof permissions_line, "{\"type\":\"permissions\",\"keybinds\":%s,\"clicks\":%s}",
             keybinds ? "true" : "false", clicks ? "true" : "false");
    pthread_mutex_unlock(&output_lock);
    core_emit("%s", permissions_line);
}

/* Writes a string as a JSON string literal into `out`, which holds `size` bytes. */
static void json_quote(char *out, size_t size, const char *text) {
    size_t used = 0;
    if (size < 3) {
        if (size) out[0] = 0;
        return;
    }
    out[used++] = '"';
    for (const unsigned char *c = (const unsigned char *)text; *c && used + 7 < size; c++) {
        if (*c == '"' || *c == '\\') {
            out[used++] = '\\';
            out[used++] = (char)*c;
        } else if (*c < 0x20) {
            used += (size_t)snprintf(out + used, size - used, "\\u%04x", *c);
        } else {
            out[used++] = (char)*c;
        }
    }
    out[used++] = '"';
    out[used] = 0;
}

static void signal_change(void) {
    pthread_mutex_lock(&lock);
    pthread_cond_signal(&wake);
    pthread_mutex_unlock(&lock);
    platform_indicator_changed();
}

static int clicking(void) {
    return (atomic_load(&latched) || atomic_load(&held)) &&
           (atomic_load(&roblox_focused) || !atomic_load(&only_roblox));
}

enum indicator_state core_indicator_state(void) {
    if (!atomic_load(&latched) && !atomic_load(&held)) return INDICATOR_OFF;
    return clicking() ? INDICATOR_ON : INDICATOR_PAUSED;
}

int core_indicator_cps(void) { return atomic_load(&measured_cps); }

void core_indicator_position(double *x, double *y) {
    int stored_x = atomic_load(&position_x), stored_y = atomic_load(&position_y);
    *x = stored_x < 0 || stored_y < 0 ? -1 : stored_x / 10000.0;
    *y = stored_x < 0 || stored_y < 0 ? -1 : stored_y / 10000.0;
}

int core_indicator_position_version(void) { return atomic_load(&position_version); }

double core_indicator_background(void) { return (100 - atomic_load(&transparency)) / 100.0; }

int core_indicator_visible(void) { return atomic_load(&indicator_visible); }

static int to_fraction(double value) { return value < 0 ? -1 : value > 1 ? 10000 : (int)(value * 10000 + 0.5); }

void core_indicator_moved(double x, double y) {
    atomic_store(&position_x, to_fraction(x));
    atomic_store(&position_y, to_fraction(y));
    core_emit("{\"type\":\"position\",\"x\":%.4f,\"y\":%.4f}", atomic_load(&position_x) / 10000.0,
              atomic_load(&position_y) / 10000.0);
}

void core_input(int code, int down) {
    int changed = 0;
    pthread_mutex_lock(&lock);
    for (int i = 0; i < bind_count; i++) {
        struct bind *bind = &binds[i];
        if (bind->code != code) continue;
        int pressed = down && !bind->down;
        bind->down = down;
        if (bind->mode == MODE_HOLD) {
            int bit = 1 << i;
            int before = atomic_load(&held);
            atomic_store(&held, down ? before | bit : before & ~bit);
            changed |= before != atomic_load(&held);
        } else if (pressed) {
            int before = atomic_load(&latched);
            atomic_store(&latched, bind->mode == MODE_TOGGLE ? !before : bind->mode == MODE_ENABLE);
            changed |= before != atomic_load(&latched);
        }
    }
    if (changed) pthread_cond_signal(&wake);
    pthread_mutex_unlock(&lock);
    if (changed) platform_indicator_changed();
}

void core_focus(int focused) {
    if (atomic_exchange(&roblox_focused, focused) != focused) signal_change();
}


/* Measures the shortest wait this device's timer keeps, and caps clicks per second to match. */
static void calibrate(void) {
    uint64_t total = 0;
    for (int i = 0; i < CALIBRATION_WAITS; i++) {
        uint64_t start = platform_now_ns();
        platform_wait_until_ns(start + 1000000);
        total += platform_now_ns() - start;
    }
    uint64_t mean = total / CALIBRATION_WAITS;
    timer_ms = (double)mean / 1e6;
    max_cps = mean ? (int)(SECOND_NS / mean) : CPS_LIMIT;
    if (max_cps > CPS_LIMIT) max_cps = CPS_LIMIT;
    if (max_cps < 1) max_cps = 1;
    if (atomic_load(&target_cps) > max_cps) atomic_store(&target_cps, max_cps);
}

static void timed_wait(uint64_t nanoseconds) {
    struct timeval now;
    gettimeofday(&now, NULL);
    uint64_t due = (uint64_t)now.tv_sec * SECOND_NS + (uint64_t)now.tv_usec * 1000 + nanoseconds;
    struct timespec until = {(time_t)(due / SECOND_NS), (long)(due % SECOND_NS)};
    pthread_mutex_lock(&lock);
    if (!clicking()) pthread_cond_timedwait(&wake, &lock, &until);
    pthread_mutex_unlock(&lock);
}

/*
 * Clicks at the target rate on fixed deadlines. After a stall longer than one period it starts
 * over instead of sending a burst to catch up.
 */
static void *click_loop(void *unused) {
    (void)unused;
    static uint64_t sent[CPS_LIMIT + 1];
    size_t head = 0, count = 0;
    uint64_t next = 0, last_status = 0;
    char last[128] = "";
    for (;;) {
        uint64_t now = platform_now_ns();
        if (clicking()) {
            uint64_t period = SECOND_NS / (uint64_t)atomic_load(&target_cps);
            if (!next || now > next + period) next = now;
            if (now >= next) {
                if (platform_click(atomic_load(&button))) {
                    sent[head] = now;
                    head = (head + 1) % (CPS_LIMIT + 1);
                    if (count < CPS_LIMIT + 1) count++;
                }
                next += period;
            }
        } else {
            next = 0;
            count = 0;
        }
        while (count && now - sent[(head + CPS_LIMIT + 1 - count) % (CPS_LIMIT + 1)] > SECOND_NS) {
            count--;
        }
        if (count >= 2) {
            uint64_t first = sent[(head + CPS_LIMIT + 1 - count) % (CPS_LIMIT + 1)];
            uint64_t newest = sent[(head + CPS_LIMIT) % (CPS_LIMIT + 1)];
            atomic_store(&measured_cps, newest > first ? (int)(((count - 1) * SECOND_NS + (newest - first) / 2) / (newest - first)) : 0);
        } else {
            atomic_store(&measured_cps, 0);
        }
        int forced = atomic_exchange(&force_status, 0);
        if (forced || now - last_status >= STATUS_INTERVAL_NS) {
            last_status = now;
            static const char *states[] = {"off", "on", "paused"};
            enum indicator_state state = core_indicator_state();
            const char *reason = state == INDICATOR_PAUSED ? "focus" : "";
            char status[128];
            snprintf(status, sizeof status,
                     "{\"type\":\"status\",\"state\":\"%s\",\"reason\":\"%s\",\"cps\":%d,\"target\":%d}",
                     states[state], reason, atomic_load(&measured_cps), atomic_load(&target_cps));
            if (forced || strcmp(status, last)) {
                strcpy(last, status);
                core_emit("%s", status);
                platform_indicator_changed();
            }
        }
        if (clicking()) {
            uint64_t due = next < now + STATUS_INTERVAL_NS ? next : now + STATUS_INTERVAL_NS;
            platform_wait_until_ns(due);
        } else {
            timed_wait(STATUS_INTERVAL_NS);
        }
    }
    return NULL;
}

static int parse_hex(const char *c, unsigned *out) {
    char hex[5] = {0};
    for (int i = 0; i < 4; i++) {
        if (!c[i] || !strchr("0123456789abcdefABCDEF", c[i])) return -1;
        hex[i] = c[i];
    }
    *out = (unsigned)strtoul(hex, NULL, 16);
    return 0;
}

static int encode_utf8(unsigned code, char *out, size_t size, size_t *used) {
    unsigned char bytes[4];
    size_t length = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    static const unsigned char leads[] = {0, 0, 0xC0, 0xE0, 0xF0};
    for (size_t i = length; i-- > 1;) {
        bytes[i] = (unsigned char)(0x80 | (code & 0x3F));
        code >>= 6;
    }
    bytes[0] = (unsigned char)(leads[length] | code);
    if (*used + length >= size) return -1;
    memcpy(out + *used, bytes, length);
    *used += length;
    return 0;
}

static int parse_string(const char **cursor, char *out, size_t size) {
    const char *c = *cursor;
    size_t used = 0;
    if (*c++ != '"') return -1;
    while (*c != '"') {
        unsigned code = (unsigned char)*c++;
        if (!code) return -1;
        if (code == '\\') {
            char escape = *c++;
            const char *simple = escape ? strchr("\"\\/bfnrt", escape) : NULL;
            if (simple) {
                code = (unsigned char)"\"\\/\b\f\n\r\t"[simple - "\"\\/bfnrt"];
            } else if (escape == 'u') {
                if (parse_hex(c, &code)) return -1;
                c += 4;
                unsigned low;
                if (code >= 0xD800 && code < 0xDC00 && c[0] == '\\' && c[1] == 'u' &&
                    !parse_hex(c + 2, &low) && low >= 0xDC00 && low <= 0xDFFF) {
                    code = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00);
                    c += 6;
                }
            } else {
                return -1;
            }
            if (encode_utf8(code, out, size, &used)) return -1;
        } else {
            if (used + 1 >= size) return -1;
            out[used++] = (char)code;
        }
    }
    out[used] = 0;
    *cursor = c + 1;
    return 0;
}

/* Parses an object whose values are strings, numbers, booleans, or null. Returns the field count. */
static int parse_object(const char *text, struct field *fields) {
    const char *c = text;
    int count = 0;
#define SKIP() while (*c == ' ' || *c == '\t' || *c == '\r' || *c == '\n') c++
    SKIP();
    if (*c++ != '{') return -1;
    SKIP();
    if (*c == '}') return 0;
    for (;;) {
        if (count == MAX_FIELDS) return -1;
        struct field *field = &fields[count++];
        SKIP();
        if (parse_string(&c, field->key, sizeof field->key)) return -1;
        SKIP();
        if (*c++ != ':') return -1;
        SKIP();
        if (*c == '"') {
            if (parse_string(&c, field->value, sizeof field->value)) return -1;
        } else {
            size_t length = strspn(c, "-+.0123456789eEtruefalsn");
            if (!length || length >= sizeof field->value) return -1;
            memcpy(field->value, c, length);
            field->value[length] = 0;
            c += length;
        }
        SKIP();
        if (*c == ',') {
            c++;
            continue;
        }
        if (*c++ != '}') return -1;
        SKIP();
        return *c ? -1 : count;
    }
#undef SKIP
}

static const char *get(struct field *fields, int count, const char *key) {
    for (int i = 0; i < count; i++) {
        if (strcmp(fields[i].key, key) == 0) return fields[i].value;
    }
    return NULL;
}

static void emit_error(const char *message) {
    char quoted[512];
    json_quote(quoted, sizeof quoted, message);
    core_emit("{\"type\":\"error\",\"message\":%s}", quoted);
}

/* Replaces every keybind from a list such as "F6:toggle,Mouse5:hold". */
static void set_binds(const char *list) {
    static const char *modes[] = {"toggle", "enable", "disable", "hold"};
    struct bind next[MAX_BINDS];
    int next_count = 0, rejected = 0;
    char copy[MAX_VALUE];
    snprintf(copy, sizeof copy, "%s", list ? list : "");
    for (char *item = strtok(copy, ","); item; item = strtok(NULL, ",")) {
        char *mode = strchr(item, ':');
        int found = -1;
        if (mode) *mode++ = 0;
        for (int i = 0; mode && i < 4; i++) {
            if (strcmp(mode, modes[i]) == 0) found = i;
        }
        int code = platform_key_code(item);
        if (code < 0 || found < 0 || next_count == MAX_BINDS) rejected++;
        else next[next_count++] = (struct bind){code, (enum mode)found, 0};
    }
    pthread_mutex_lock(&lock);
    memcpy(binds, next, (size_t)next_count * sizeof next[0]);
    bind_count = next_count;
    atomic_store(&held, 0);
    pthread_mutex_unlock(&lock);
    signal_change();
    if (rejected) emit_error("A keybind wasn't added. Is its key supported on this device?");
}

static void describe(void) {
    core_emit("{\"type\":\"ready\",\"version\":\"%s\",\"maxCps\":%d,\"timerMs\":%.3f}", CLICKER_VERSION,
              max_cps, timer_ms);
    pthread_mutex_lock(&output_lock);
    char permissions[sizeof permissions_line];
    snprintf(permissions, sizeof permissions, "%s", permissions_line);
    pthread_mutex_unlock(&output_lock);
    if (*permissions) core_emit("%s", permissions);
    atomic_store(&force_status, 1);
    signal_change();
}

static void handle(const char *line) {
    static struct field fields[MAX_FIELDS];
    int count = parse_object(line, fields);
    const char *type = count > 0 ? get(fields, count, "type") : NULL;
    if (!type) {
        fprintf(stderr, "Ignored a line that isn't a message.\n");
        return;
    }
    if (strcmp(type, "configure") == 0) {
        const char *value;
        if ((value = get(fields, count, "cps"))) {
            int cps = atoi(value);
            atomic_store(&target_cps, cps < 1 ? 1 : cps > max_cps ? max_cps : cps);
        }
        if ((value = get(fields, count, "button"))) atomic_store(&button, !strcmp(value, "right") ? 2 : !strcmp(value, "middle") ? 3 : 1);
        if ((value = get(fields, count, "onlyRoblox"))) atomic_store(&only_roblox, strcmp(value, "false") != 0);
        if ((value = get(fields, count, "transparency"))) {
            int percent = atoi(value);
            atomic_store(&transparency, percent < 0 ? 0 : percent > 100 ? 100 : percent);
        }
        if ((value = get(fields, count, "indicator"))) atomic_store(&indicator_visible, strcmp(value, "false") != 0);
        const char *x = get(fields, count, "x"), *y = get(fields, count, "y");
        if (x && y) {
            atomic_store(&position_x, to_fraction(atof(x)));
            atomic_store(&position_y, to_fraction(atof(y)));
            atomic_fetch_add(&position_version, 1);
        }
        signal_change();
    } else if (strcmp(type, "binds") == 0) {
        set_binds(get(fields, count, "value"));
    } else if (strcmp(type, "action") == 0) {
        const char *action = get(fields, count, "action");
        if (!action) return;
        if (strcmp(action, "toggle") == 0) atomic_store(&latched, !atomic_load(&latched));
        else if (strcmp(action, "enable") == 0) atomic_store(&latched, 1);
        else if (strcmp(action, "disable") == 0) atomic_store(&latched, 0);
        signal_change();
    } else if (strcmp(type, "describe") == 0) {
        describe();
    } else if (strcmp(type, "permissions") == 0) {
        platform_open_permissions();
    } else if (strcmp(type, "quit") == 0) {
        core_emit("{\"type\":\"bye\"}");
        exit(0);
    } else {
        fprintf(stderr, "Ignored a message with an unknown type.\n");
    }
}

/* Exits when standard input closes, so the helper never outlives Toolblox. */
static void *read_input(void *unused) {
    (void)unused;
    static char line[64 * 1024 + 2];
    while (fgets(line, sizeof line, stdin)) handle(line);
    exit(0);
    return NULL;
}

int main(void) {
    if (platform_init()) return 1;
    calibrate();
    describe();
    pthread_t input, clicker;
    pthread_create(&clicker, NULL, click_loop, NULL);
    pthread_create(&input, NULL, read_input, NULL);
    platform_run();
    return 0;
}
