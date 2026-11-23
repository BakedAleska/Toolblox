/* Checks the JSON reader and writer the helper uses for its messages. */
#include <assert.h>

#include "json.h"

int main(void) {
    char out[256], quoted[512];
    const char *line = "{\"type\":\"run\", \"n\":1, \"ok\":true, \"path\":\"C:\\\\My \\\"Scripts\\\"\\/a\\u00e9\\ud83d\\ude00\u00f1.ahk\"}";
    assert(json_get(line, "type", out, sizeof out) && !strcmp(out, "run"));
    assert(json_get(line, "path", out, sizeof out) && !strcmp(out, "C:\\My \"Scripts\"/a\xc3\xa9\xf0\x9f\x98\x80\xc3\xb1.ahk"));
    assert(!json_get(line, "n", out, sizeof out));
    assert(!json_get(line, "missing", out, sizeof out));
    assert(!json_get("{\"path\":\"x\\\",\\\"type\\\":\\\"evil\"}", "type", out, sizeof out));
    assert(!json_get("{\"path\":\"a\\u0000b\"}", "path", out, sizeof out));
    assert(!json_get("{\"path\":\"\\ud83d\"}", "path", out, sizeof out));
    assert(!json_get("{\"path\":\"abcdef\"}", "path", out, 4));
    assert(!json_get("{\"path\":\"abc", "path", out, sizeof out));
    assert(!json_get("[\"path\"]", "path", out, sizeof out));
    json_quote(quoted, sizeof quoted, "C:\\a \"b\"\n");
    assert(!strcmp(quoted, "\"C:\\\\a \\\"b\\\"\\u000a\""));
    return 0;
}
