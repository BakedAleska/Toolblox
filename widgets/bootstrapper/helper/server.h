/*
 * Finds the address of the server a client joined in a Roblox log line. Roblox logs the private
 * address of the game server on the "Joining game" line, and the public address that clients
 * connect through on the UDMUX line, which is the one that locates the server.
 */
#ifndef BOOTSTRAPPER_SERVER_H
#define BOOTSTRAPPER_SERVER_H

#include <stdio.h>
#include <string.h>

#define SERVER_ENTRY "[FLog::Network] UDMUX Address = "

/* Copies the dotted IPv4 address from a UDMUX log line into out. Returns 0 for any other line. */
static int server_address(const char *line, char *out, size_t size) {
    const char *start = strstr(line, SERVER_ENTRY);
    unsigned a, b, c, d;
    int end = 0;
    if (!start) return 0;
    start += sizeof SERVER_ENTRY - 1;
    if (sscanf(start, "%3u.%3u.%3u.%3u%n", &a, &b, &c, &d, &end) != 4 || start[end] != ',') return 0;
    for (int i = 0; i < end; i++) if ((start[i] < '0' || start[i] > '9') && start[i] != '.') return 0;
    if (a > 255 || b > 255 || c > 255 || d > 255) return 0;
    return snprintf(out, size, "%u.%u.%u.%u", a, b, c, d) < (int)size;
}

#endif
