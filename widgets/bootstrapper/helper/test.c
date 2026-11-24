/* Checks which ClientAppSettings.json files the helper treats as its own, the server address and user ID parsers, and the Roblox settings edit. */
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

    char user[24];
    assert(joined_user("2026-11-23T22:43:49.813Z,151.8,254c,6 [FLog::GameJoinLoadTime] Report game_join_loadtime: placeid:52, join_time:0, clienttime:17.5, userid:12345, x:1", user, sizeof user));
    assert(!strcmp(user, "12345"));
    assert(joined_user("[FLog::GameJoinLoadTime] Report game_join_loadtime: placeid:52, userid:7\r", user, sizeof user) && !strcmp(user, "7"));
    assert(!joined_user("[FLog::Output] placeid:52, userid:12345,", user, sizeof user));
    assert(!joined_user("[FLog::GameJoinLoadTime] Report game_join_loadtime: placeid:52", user, sizeof user));
    assert(!joined_user("[FLog::GameJoinLoadTime] Report game_join_loadtime: userid:,", user, sizeof user));
    assert(!joined_user("[FLog::GameJoinLoadTime] Report game_join_loadtime: userid:12\"3,", user, sizeof user));
    assert(!joined_user("[FLog::GameJoinLoadTime] Report game_join_loadtime: userid:1234567890123456789012345,", user, sizeof user));

    assert(user_listed(",12,34,", "12") && user_listed(",12,34,", "34"));
    assert(!user_listed(",12,34,", "2") && !user_listed(",12,34,", "1") && !user_listed(",12,34,", "") && !user_listed("", "12") && !user_listed(",", ""));

    char settings[256];
    double old = 0;
    assert(cap_replace("<Item>\n\t<int name=\"FramerateCap\">240</int>\n</Item>", FPS_ENTRY, 30, settings, sizeof settings, &old));
    assert(old == 240 && !strcmp(settings, "<Item>\n\t<int name=\"FramerateCap\">30</int>\n</Item>"));
    assert(cap_replace("<int name=\"FramerateCap\">-1</int>", FPS_ENTRY, 60, settings, sizeof settings, &old) && old == -1);
    assert(!cap_replace("<int name=\"FramerateCap\"></int>", FPS_ENTRY, 30, settings, sizeof settings, &old));
    assert(!cap_replace("<int name=\"FramerateCap\">30 </int>", FPS_ENTRY, 30, settings, sizeof settings, &old));
    assert(!cap_replace("<int name=\"Other\">30</int>", FPS_ENTRY, 30, settings, sizeof settings, &old));
    assert(!cap_replace("<int name=\"FramerateCap\">240</int>", FPS_ENTRY, 30, settings, 10, &old));
    assert(cap_replace("<token name=\"SavedQualityLevel\">0</token>", GRAPHICS_ENTRY, 1, settings, sizeof settings, &old));
    assert(old == 0 && !strcmp(settings, "<token name=\"SavedQualityLevel\">1</token>"));
    assert(cap_replace("<float name=\"MasterVolumeStudio\">1</float><float name=\"MasterVolume\">0.5</float>", VOLUME_ENTRY, 0.1, settings, sizeof settings, &old));
    assert(old == 0.5 && !strcmp(settings, "<float name=\"MasterVolumeStudio\">1</float><float name=\"MasterVolume\">0.1</float>"));
    assert(!cap_replace("<token name=\"SavedQualityLevel\">5", GRAPHICS_ENTRY, 1, settings, sizeof settings, &old));
    return 0;
}
