#ifndef CAPTURE_H
#define CAPTURE_H

#include <windows.h>
#include <stdint.h>

/*
 * Windows.Graphics.Capture for one window: the GPU hands over each frame the window draws, without
 * the windows above it. Windows 10 version 1903 or later. Call from one thread only.
 */

/* Sets up the GPU device. Returns 0 when Windows.Graphics.Capture can't be used on this device. */
int graphics_start(void);

/*
 * The latest frame of `window`'s client area, starting a capture of it if it isn't captured yet.
 * The pixels are BGRA rows `stride` bytes apart, valid until the next call. Returns 0 while no frame
 * has arrived yet or the window can't be captured.
 */
int graphics_frame(HWND window, const uint8_t **pixels, int *width, int *height, int *stride);

/* Whether the yellow border Windows draws around a captured window could be turned off. */
int graphics_borderless(void);

/* Stops capturing, which also removes the border. The next `graphics_frame` starts again. */
void graphics_stop(void);

#endif
