/* Checks keybind modes against stub platform functions. Built and run by build.sh. */
#define main clicker_main
#include "clicker.c"
#undef main
#include <assert.h>
int platform_init(void) { return 0; }
void platform_run(void) {}
void platform_indicator_changed(void) {}
int platform_click(int b) { (void)b; return 0; }
static uint64_t fake_now = 1;
uint64_t platform_now_ns(void) { return fake_now; }
void platform_wait_until_ns(uint64_t d) { (void)d; }
void platform_open_permissions(void) {}
static void press(int c) { core_input(c, 1); core_input(c, 0); }
int main(void) {
    set_binds("KeyA:toggle,KeyB:pause,KeyC:enable,KeyD:disable"); int ka = platform_key_code("KeyA"), kb = platform_key_code("KeyB");
    press(kb); assert(latched == 1); press(kb); assert(latched == 0);
    press(platform_key_code("KeyC")); assert(latched == 1); press(platform_key_code("KeyD")); assert(latched == 0);
    press(kb); press(ka); assert(armed == 0 && latched == 0);
    press(kb); press(platform_key_code("KeyC")); assert(latched == 0);
    press(ka); assert(armed == 1 && latched == 0); press(kb); assert(latched == 1);
    handle("{\"type\":\"configure\",\"on\":false}\n"); handle("{\"type\":\"configure\",\"on\":true}\n"); assert(latched == 0);
    int e = platform_key_code("KeyE"), a = platform_key_code("KeyA");
    set_binds("KeyE:spam,Mouse1:spam,KeyA:pause"); atomic_store(&only_roblox, 0);
    uint64_t ms = 1000000;
    core_input(e, 1); fake_now += 2000 * ms; core_input(e, 1); update_timed(fake_now); assert(!clicking());
    core_input(e, 0); update_timed(fake_now); assert(!clicking());
    fake_now += 300 * ms; core_input(e, 1); fake_now += 50 * ms; core_input(e, 0); update_timed(fake_now); assert(!clicking());
    fake_now += 150 * ms; core_input(e, 1); update_timed(fake_now); assert(!clicking());
    fake_now += 50 * ms; core_input(e, 0); fake_now += 100 * ms; core_input(e, 1); update_timed(fake_now); assert(clicking() && latched == 0);
    fake_now += 50 * ms; core_input(e, 0); update_timed(fake_now); assert(clicking());
    assert(update_timed(fake_now) == fake_now + SPAM_GAP_NS);
    fake_now += SPAM_GAP_NS; update_timed(fake_now); assert(!clicking());
    fake_now += 100 * ms; press(e); fake_now += 100 * ms; core_input(e, 1); update_timed(fake_now); assert(clicking());
    fake_now += SPAM_GAP_NS; core_input(e, 1); update_timed(fake_now); assert(!clicking());
    core_input(e, 0); fake_now += 1000 * ms; update_timed(fake_now); assert(!clicking());
    press(MOUSE_CODE(1)); fake_now += 100 * ms; core_input(MOUSE_CODE(1), 1); core_input(e, 1); fake_now += 50 * ms; core_input(e, 0);
    fake_now += 50 * ms; core_input(e, 1); update_timed(fake_now); assert(clicking()); press(a); assert(clicking() && latched == 1);
    press(a); fake_now += SPAM_GAP_NS; update_timed(fake_now); assert(!clicking());
    set_binds("Mouse1:hold"); int m = MOUSE_CODE(1);
    core_input(m, 1); fake_now += 100 * ms; update_timed(fake_now); assert(!clicking());
    core_input(m, 0); update_timed(fake_now); assert(!clicking());
    core_input(m, 1); assert(update_timed(fake_now) == fake_now + HOLD_DELAY_NS);
    fake_now += HOLD_DELAY_NS; update_timed(fake_now); assert(clicking());
    core_input(m, 0); assert(!clicking()); update_timed(fake_now); assert(!clicking());
    assert(core_indicator_state() == INDICATOR_PAUSED);
    core_input(m, 1); fake_now += HOLD_DELAY_NS; update_timed(fake_now); assert(clicking());
    handle("{\"type\":\"configure\",\"on\":false}\n"); assert(!clicking() && core_indicator_state() == INDICATOR_OFF);
    core_input(m, 0); core_input(m, 1); fake_now += HOLD_DELAY_NS; update_timed(fake_now); assert(!clicking());
    core_input(m, 0); handle("{\"type\":\"configure\",\"on\":true}\n"); assert(core_indicator_state() == INDICATOR_PAUSED);
    core_input(m, 1); fake_now += HOLD_DELAY_NS; update_timed(fake_now); assert(clicking() && core_indicator_state() == INDICATOR_ON);
    set_binds("F6:toggle,Mouse1:hold"); int f6 = platform_key_code("F6");
    set_armed(0);
    press(f6); assert(armed == 1 && core_indicator_state() == INDICATOR_PAUSED);
    core_input(m, 1); fake_now += HOLD_DELAY_NS; update_timed(fake_now); assert(clicking());
    press(f6); assert(armed == 0 && !clicking() && core_indicator_state() == INDICATOR_OFF);
    core_input(m, 0); core_input(m, 1); fake_now += HOLD_DELAY_NS; update_timed(fake_now); assert(!clicking());
    core_input(m, 0); press(f6); assert(armed == 1);
    handle("{\"type\":\"configure\",\"on\":false,\"alwaysOn\":true}\n"); assert(core_indicator_state() == INDICATOR_PAUSED);
    core_input(m, 1); fake_now += HOLD_DELAY_NS; update_timed(fake_now); assert(clicking()); core_input(m, 0); assert(!clicking());
    press(f6); assert(armed == 0 && latched == 1 && clicking()); press(f6); assert(latched == 0 && !clicking());
    press(f6); handle("{\"type\":\"configure\",\"alwaysOn\":false}\n"); assert(latched == 0 && !clicking() && core_indicator_state() == INDICATOR_OFF);
    puts("All checks passed");
}
