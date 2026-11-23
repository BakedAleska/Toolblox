/*
 * Game sound for the Rogue Lineage helper: listens to one process tree's sound with Windows' process
 * loopback capture, which hears only that process and needs Windows 10 version 2004 or later. The
 * sound is read in memory, as it plays, by the detectors in detect.h, and never stored. Windows only.
 */
#ifndef AUDIO_H
#define AUDIO_H

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

/* What the listening thread posts to the window, as `wParam`. */
enum audio_event {
    /* Listening started. */
    AUDIO_LISTENING,
    /* Listening ended; `lParam` holds the HRESULT that ended it, or 0 when it was stopped. */
    AUDIO_ENDED,
    /* The mana-full chime. */
    AUDIO_CHIME,
    /* A spell cast; `lParam` holds the match in thousandths. */
    AUDIO_CAST,
};

/* Starts listening to `process` and its children, posting `message` to `window`. Returns 0 when it couldn't start. */
int audio_start(HWND window, UINT message, DWORD process);
/* Stops listening and waits for the thread. Safe to call when it isn't listening. */
void audio_stop(void);

#endif
