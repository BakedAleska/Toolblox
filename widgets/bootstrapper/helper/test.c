/* Checks which ClientAppSettings.json files the helper treats as its own, the server address parser, and the frame rate setting edit. */
#include <assert.h>

#include "flags.h"
#include "server.h"
#include "cap.h"

int main(void) {
    char text[64];
    flags_text(text, sizeof text, 30);
    assert(!strcmp(text, "{\"DFIntTaskSchedulerTargetFps\":30}"));
    assert(flags_ours(text));
    assert(flags_ours("{\"DFIntTaskSchedulerTargetFps\":240}"));
    assert(!flags_ours("{\"DFIntTaskSchedulerTargetFps\":30,\"FFlagOther\":true}"));
    assert(!flags_ours("{\"DFIntTaskSchedulerTargetFps\": 30}"));
    assert(!flags_ours("{\"DFIntTaskSchedulerTargetFps\":+30}"));
    assert(!flags_ours("{\"DFIntTaskSchedulerTargetFps\":30}\n"));
    assert(!flags_ours("{\"DFIntTaskSchedulerTargetFps\":30"));
    assert(!flags_ours("{}"));
    assert(!flags_ours(""));

    char address[16];
    assert(server_address("2026-11-18T23:05:01.899Z,1.899446,1e00,7 [FLog::Network] UDMUX Address = 128.116.53.33, Port = 65011 | RCC Server Address = 10.221.42.77, Port = 65011", address, sizeof address));
    assert(!strcmp(address, "128.116.53.33"));
    assert(!server_address("[FLog::Output] ! Joining game 'x' place 1 at 10.37.8.228", address, sizeof address));
    assert(!server_address("[FLog::Network] UDMUX Address = 128.116.256.1, Port = 1", address, sizeof address));
    assert(!server_address("[FLog::Network] UDMUX Address = 128.116.2.33.4, Port = 1", address, sizeof address));
    assert(!server_address("[FLog::Network] UDMUX Address = 128.116.-2.33, Port = 1", address, sizeof address));
    assert(!server_address("[FLog::Network] UDMUX Address = 1280.116.2.33, Port = 1", address, sizeof address));
    assert(!server_address("[FLog::Network] UDMUX Address = 128.116.2.33/evil, Port = 1", address, sizeof address));
    char settings[256];
    int old = 0;
    assert(cap_replace("<Item>\n\t<int name=\"FramerateCap\">240</int>\n</Item>", 30, settings, sizeof settings, &old));
    assert(old == 240 && !strcmp(settings, "<Item>\n\t<int name=\"FramerateCap\">30</int>\n</Item>"));
    assert(cap_replace("<int name=\"FramerateCap\">-1</int>", 60, settings, sizeof settings, &old) && old == -1);
    assert(!cap_replace("<int name=\"FramerateCap\"></int>", 30, settings, sizeof settings, &old));
    assert(!cap_replace("<int name=\"FramerateCap\">30 </int>", 30, settings, sizeof settings, &old));
    assert(!cap_replace("<int name=\"Other\">30</int>", 30, settings, sizeof settings, &old));
    assert(!cap_replace("<int name=\"FramerateCap\">240</int>", 30, settings, 10, &old));
    return 0;
}
