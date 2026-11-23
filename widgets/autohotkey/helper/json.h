/*
 * Minimal JSON for the helper's one-line messages: flat objects with string, number, boolean, or
 * null values. Strings are UTF-8.
 */
#ifndef AHK_JSON_H
#define AHK_JSON_H

#include <stddef.h>
#include <stdio.h>
#include <string.h>

static const char *json_space(const char *s) {
    while (*s == ' ' || *s == '\t' || *s == '\r' || *s == '\n') s++;
    return s;
}

static int json_hex4(const char *s, unsigned *value) {
    *value = 0;
    for (int i = 0; i < 4; i++) {
        char c = s[i];
        unsigned digit = c >= '0' && c <= '9' ? (unsigned)(c - '0') : c >= 'a' && c <= 'f' ? (unsigned)(c - 'a' + 10) : c >= 'A' && c <= 'F' ? (unsigned)(c - 'A' + 10) : 16;
        if (digit == 16) return 0;
        *value = *value * 16 + digit;
    }
    return 1;
}

/* Appends one code point as UTF-8. Returns 0 when it doesn't fit. */
static int json_put(char *out, size_t size, size_t *length, unsigned point) {
    char bytes[4];
    size_t count;
    if (point < 0x80) { bytes[0] = (char)point; count = 1; }
    else if (point < 0x800) { bytes[0] = (char)(0xC0 | point >> 6); bytes[1] = (char)(0x80 | (point & 0x3F)); count = 2; }
    else if (point < 0x10000) { bytes[0] = (char)(0xE0 | point >> 12); bytes[1] = (char)(0x80 | (point >> 6 & 0x3F)); bytes[2] = (char)(0x80 | (point & 0x3F)); count = 3; }
    else { bytes[0] = (char)(0xF0 | point >> 18); bytes[1] = (char)(0x80 | (point >> 12 & 0x3F)); bytes[2] = (char)(0x80 | (point >> 6 & 0x3F)); bytes[3] = (char)(0x80 | (point & 0x3F)); count = 4; }
    if (*length + count >= size) return 0;
    memcpy(out + *length, bytes, count);
    *length += count;
    return 1;
}

/* Reads a string starting at its opening quote. Returns the position after the closing quote, or NULL. */
static const char *json_string(const char *s, char *out, size_t size) {
    size_t length = 0;
    if (*s++ != '"' || !size) return NULL;
    while (*s && *s != '"') {
        unsigned point = (unsigned char)*s++;
        if (point < 0x20) return NULL;
        if (point == '\\') {
            char escape = *s++;
            switch (escape) {
            case '"': case '\\': case '/': point = (unsigned char)escape; break;
            case 'b': point = '\b'; break;
            case 'f': point = '\f'; break;
            case 'n': point = '\n'; break;
            case 'r': point = '\r'; break;
            case 't': point = '\t'; break;
            case 'u': {
                if (!json_hex4(s, &point)) return NULL;
                s += 4;
                if (point >= 0xD800 && point < 0xDC00) {
                    unsigned low;
                    if (s[0] != '\\' || s[1] != 'u' || !json_hex4(s + 2, &low) || low < 0xDC00 || low > 0xDFFF) return NULL;
                    s += 6;
                    point = 0x10000 + ((point - 0xD800) << 10) + (low - 0xDC00);
                } else if (point >= 0xDC00 && point < 0xE000) return NULL;
                if (!point) return NULL;
                break;
            }
            default: return NULL;
            }
            if (!json_put(out, size, &length, point)) return NULL;
        } else {
            if (length + 1 >= size) return NULL;
            out[length++] = (char)point;
        }
    }
    if (*s != '"') return NULL;
    out[length] = 0;
    return s + 1;
}

/* Copies the string value of a top-level key into out. Returns 0 when it's missing, not a string, or too long. */
static int json_get(const char *s, const char *key, char *out, size_t size) {
    char name[64];
    s = json_space(s);
    if (*s++ != '{') return 0;
    for (;;) {
        s = json_space(s);
        if (*s == '}') return 0;
        if (!(s = json_string(s, name, sizeof name))) return 0;
        s = json_space(s);
        if (*s++ != ':') return 0;
        s = json_space(s);
        int match = !strcmp(name, key);
        if (*s == '"') {
            if (match) return json_string(s, out, size) != NULL;
            static char skipped[64 * 1024];
            if (!(s = json_string(s, skipped, sizeof skipped))) return 0;
        } else {
            if (match || *s == '{' || *s == '[') return 0;
            while (*s && *s != ',' && *s != '}') s++;
        }
        s = json_space(s);
        if (*s == ',') s++;
        else return 0;
    }
}

/* Writes text as a quoted JSON string. Output is cut to fit. */
static void json_quote(char *out, size_t size, const char *text) {
    size_t length = 0;
    if (size < 3) { if (size) *out = 0; return; }
    out[length++] = '"';
    for (; *text && length + 8 < size; text++) {
        unsigned char c = (unsigned char)*text;
        if (c == '"' || c == '\\') { out[length++] = '\\'; out[length++] = (char)c; }
        else if (c < 0x20) length += (size_t)snprintf(out + length, size - length, "\\u%04x", c);
        else out[length++] = (char)c;
    }
    out[length++] = '"';
    out[length] = 0;
}

#endif
