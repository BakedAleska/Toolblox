/*
 * Roblox's own Maximum frame rate, Graphics quality, and Volume settings, the FramerateCap,
 * SavedQualityLevel, and MasterVolume entries in GlobalBasicSettings_13.xml. Every client reads them when it opens.
 */
#ifndef BOOTSTRAPPER_CAP_H
#define BOOTSTRAPPER_CAP_H

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define FPS_ENTRY "<int name=\"FramerateCap\">"
/* 0 is automatic and 1 to 10 are the levels in Roblox's menu. */
#define GRAPHICS_ENTRY "<token name=\"SavedQualityLevel\">"
/* 0 to 1. */
#define VOLUME_ENTRY "<float name=\"MasterVolume\">"

/* Copies settings into out with the entry set to value, and stores the previous value in old. Returns 0 when the entry is missing or out is too small. */
static int cap_replace(const char *settings, const char *entry, double value, char *out, size_t size, double *old) {
    const char *start = strstr(settings, entry), *end;
    char *after;
    if (!start) return 0;
    start += strlen(entry);
    double previous = strtod(start, &after);
    if (after == start || strncmp(after, "</", 2)) return 0;
    end = after;
    *old = previous;
    int written = snprintf(out, size, "%.*s%.7g%s", (int)(start - settings), settings, value, end);
    return written > 0 && (size_t)written < size;
}

#endif
