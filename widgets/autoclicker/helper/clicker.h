/*
 * Shared state and the platform interface for the autoclicker helper.
 *
 * clicker.c owns the protocol, keybinds, and click loop. Each platform file (platform_windows.c,
 * platform_macos.m) owns input hooks, clicks, timing, and the indicator.
 */
#ifndef CLICKER_H
#define CLICKER_H

#include <stddef.h>
#include <stdint.h>

#define CLICKER_VERSION "1.10.0"

/* Bind codes for mouse buttons, above every keyboard code. Mouse1 is the left button. */
#define MOUSE_CODE(n) (0x1000 + (n))

enum indicator_state { INDICATOR_OFF, INDICATOR_ON, INDICATOR_PAUSED };

/* Called by the platform's input hook for physical input only. Synthetic input is skipped. */
void core_input(int code, int down);
/* Called by the platform when the focused application changes. */
void core_focus(int roblox_focused);
/* Reports whether keybinds can be read and clicks can be sent. Called by the platform. */
void core_permissions(int keybinds, int clicks);
/* Writes one JSON line to standard output and flushes. Thread-safe. */
void core_emit(const char *format, ...);

/* Current indicator contents, read by the platform when it draws. */
enum indicator_state core_indicator_state(void);
int core_indicator_cps(void);
/*
 * The indicator's top-left corner as fractions of the primary screen, measured from its top-left,
 * or -1 for both when it sits in the default bottom-left spot.
 */
void core_indicator_position(double *x, double *y);
/* The indicator background's opacity, from 0 (clear) to 1 (solid). Text and the dot stay solid. */
double core_indicator_background(void);
/* Whether the indicator is shown. */
int core_indicator_visible(void);
/* Increases whenever the position is set, so the platform moves the indicator only then. */
int core_indicator_position_version(void);
/* Called by the platform when a drag ends, with the new position as in core_indicator_position. */
void core_indicator_moved(double x, double y);

/* Returns the platform code for a KeyboardEvent.code or MouseN name, or -1. */
int platform_key_code(const char *name);
/* Prepares hooks, timers, and the indicator. Returns 0 on success. */
int platform_init(void);
/* Runs the main thread's event loop. Doesn't return. */
void platform_run(void);
/* Asks the indicator to redraw or move. Thread-safe. */
void platform_indicator_changed(void);
/* Sends one press and release of `button` (1 left, 2 right, 3 middle) at the cursor. Returns 1 if sent. */
int platform_click(int button);
uint64_t platform_now_ns(void);
void platform_wait_until_ns(uint64_t deadline);
/* Opens the system's input permission settings. No-op where none are needed. */
void platform_open_permissions(void);

#endif
