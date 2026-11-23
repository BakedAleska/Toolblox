/*
 * Roblox's own Maximum frame rate setting, the FramerateCap entry in GlobalBasicSettings_13.xml.
 * Every client reads it when it opens.
 */
#ifndef BOOTSTRAPPER_CAP_H
#define BOOTSTRAPPER_CAP_H

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CAP_ENTRY "<int name=\"FramerateCap\">"

/* Copies settings into out with FramerateCap set to value, and stores the previous value in old. Returns 0 when the entry is missing or out is too small. */
static int cap_replace(const char *settings, int value, char *out, size_t size, int *old) {
    const char *start = strstr(settings, CAP_ENTRY), *end;
    char *after;
    if (!start) return 0;
    start += sizeof CAP_ENTRY - 1;
    long previous = strtol(start, &after, 10);
    if (after == start || strncmp(after, "</int>", 6)) return 0;
    end = after;
    *old = (int)previous;
    int written = snprintf(out, size, "%.*s%d%s", (int)(start - settings), settings, value, end);
    return written > 0 && (size_t)written < size;
}

#endif
