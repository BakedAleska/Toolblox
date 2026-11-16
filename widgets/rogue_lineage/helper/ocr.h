/*
 * Text recognition for the Rogue Lineage helper, with the OCR engine built into Windows 10 and
 * later. Windows only.
 */
#ifndef OCR_H
#define OCR_H

#include <stddef.h>

#include "detect.h"

/*
 * The heights, in pixels, a slot's interior is resized to before it's read, tried in order until
 * one reads a known name. Small serif text reads best enlarged, and a fixed height reads a slot
 * the same way at any window size.
 */
#define OCR_HEIGHTS {141, 188, 94}

/* Starts the engine for the calling thread. Returns 0 when Windows has no OCR language for the user. */
int ocr_start(void);
/*
 * Reads the text in a slot's interior, resized to `height` pixels tall and padded with the
 * interior's own color so letters at its edges read whole. `text` receives printable ASCII, with
 * lines joined by spaces. Returns 0 when reading fails.
 */
int ocr_read(const struct image *image, const struct slot *interior, int height, char *text, size_t size);

#endif
