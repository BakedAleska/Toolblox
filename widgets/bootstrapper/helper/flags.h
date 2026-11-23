/*
 * The ClientAppSettings.json the helper writes. A file is the helper's own only when it holds
 * exactly the frame rate flag in this format, so a file the user wrote is never mistaken for it.
 */
#ifndef BOOTSTRAPPER_FLAGS_H
#define BOOTSTRAPPER_FLAGS_H

#include <stdio.h>
#include <string.h>

#define FLAGS_FORMAT "{\"DFIntTaskSchedulerTargetFps\":%d}"
#define FPS_MIN 5
#define FPS_MAX 240

static int flags_text(char *out, size_t size, int fps) {
    return snprintf(out, size, FLAGS_FORMAT, fps);
}

/* Returns 1 when text is a file the helper wrote. */
static int flags_ours(const char *text) {
    int fps = 0, end = 0;
    char again[64];
    if (sscanf(text, FLAGS_FORMAT "%n", &fps, &end) != 1 || !end || text[end]) return 0;
    flags_text(again, sizeof again, fps);
    return !strcmp(again, text);
}

#endif
