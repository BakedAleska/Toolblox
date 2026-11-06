/*
 * macOS input, clicks, timing, and indicator for the autoclicker helper.
 *
 * Reading keybinds needs Input Monitoring and sending clicks needs Accessibility. macOS grants
 * both to Toolblox, the app that starts this helper.
 */
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#include <mach/mach_time.h>
#include <pthread.h>
#include <stdatomic.h>
#include <unistd.h>

#include "clicker.h"

/* Marks clicks this helper sends, so its own input hook skips them. */
static const int64_t SYNTHETIC_TAG = 0x546F6F6C;
static NSString *const ROBLOX_BUNDLE = @"com.roblox.RobloxPlayer";

static mach_timebase_info_data_t timebase;
static CGEventSourceRef source;
static CFMachPortRef tap;
static NSPanel *panel;
static atomic_int can_post;
static int reported_listen = -1, reported_post = -1;
/* The position version last applied. */
static int placed_version = -1;


/* Draws the indicator and moves it by drag. */
@interface IndicatorView : NSView
@end

@implementation IndicatorView {
    NSPoint grab;
}

- (BOOL)acceptsFirstMouse:(NSEvent *)event {
    (void)event;
    return YES;
}

- (void)mouseDown:(NSEvent *)event {
    grab = event.locationInWindow;
}

- (void)mouseDragged:(NSEvent *)event {
    (void)event;
    NSPoint pointer = NSEvent.mouseLocation;
    [self.window setFrameOrigin:NSMakePoint(pointer.x - grab.x, pointer.y - grab.y)];
}

- (void)mouseUp:(NSEvent *)event {
    (void)event;
    NSRect screen = NSScreen.screens.firstObject.frame;
    NSRect frame = self.window.frame;
    core_indicator_moved((NSMinX(frame) - NSMinX(screen)) / NSWidth(screen),
                         (NSMaxY(screen) - NSMaxY(frame)) / NSHeight(screen));
}
- (void)drawRect:(NSRect)dirty {
    (void)dirty;
    NSRect bounds = self.bounds;
    /* A clear background keeps a trace of alpha so the whole indicator still takes the mouse. */
    [[NSColor colorWithWhite:0.08 alpha:MAX(core_indicator_background(), 0.02)] setFill];
    [[NSBezierPath bezierPathWithRoundedRect:bounds xRadius:9 yRadius:9] fill];
    enum indicator_state state = core_indicator_state();
    NSColor *dot = state == INDICATOR_ON       ? NSColor.systemGreenColor
                   : state == INDICATOR_PAUSED ? NSColor.systemOrangeColor
                                               : [NSColor colorWithWhite:0.55 alpha:1];
    [dot setFill];
    [[NSBezierPath bezierPathWithOvalInRect:NSMakeRect(12, NSMidY(bounds) - 4, 8, 8)] fill];
    NSString *text = state == INDICATOR_ON && core_indicator_cps()
                         ? [NSString stringWithFormat:@"On · %d CPS", core_indicator_cps()]
                     : state == INDICATOR_ON     ? @"On"
                     : state == INDICATOR_PAUSED ? @"Paused"
                                                 : @"Off";
    NSDictionary *attributes = @{
        NSFontAttributeName : [NSFont monospacedDigitSystemFontOfSize:12 weight:NSFontWeightMedium],
        NSForegroundColorAttributeName : [NSColor colorWithWhite:0.96 alpha:1],
    };
    NSSize size = [text sizeWithAttributes:attributes];
    [text drawAtPoint:NSMakePoint(28, NSMidY(bounds) - size.height / 2) withAttributes:attributes];
}
@end

uint64_t platform_now_ns(void) {
    return mach_absolute_time() * timebase.numer / timebase.denom;
}

void platform_wait_until_ns(uint64_t deadline) {
    mach_wait_until(deadline * timebase.denom / timebase.numer);
}

int platform_click(int button) {
    if (!atomic_load(&can_post)) return 0;
    CGEventRef here = CGEventCreate(NULL);
    CGPoint at = CGEventGetLocation(here);
    CFRelease(here);
    CGEventType down_type = button == 2 ? kCGEventRightMouseDown : button == 3 ? kCGEventOtherMouseDown : kCGEventLeftMouseDown;
    CGEventType up_type = button == 2 ? kCGEventRightMouseUp : button == 3 ? kCGEventOtherMouseUp : kCGEventLeftMouseUp;
    CGMouseButton which = button == 2 ? kCGMouseButtonRight : button == 3 ? kCGMouseButtonCenter : kCGMouseButtonLeft;
    CGEventRef down = CGEventCreateMouseEvent(source, down_type, at, which);
    CGEventRef up = CGEventCreateMouseEvent(source, up_type, at, which);
    int sent = down && up;
    if (sent) {
        CGEventRef events[] = {down, up};
        for (int i = 0; i < 2; i++) {
            CGEventSetIntegerValueField(events[i], kCGMouseEventClickState, 1);
            CGEventSetIntegerValueField(events[i], kCGEventSourceUserData, SYNTHETIC_TAG);
            CGEventPost(kCGHIDEventTap, events[i]);
        }
    }
    if (down) CFRelease(down);
    if (up) CFRelease(up);
    return sent;
}

static CGEventRef on_event(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *info) {
    (void)proxy;
    (void)info;
    if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
        CGEventTapEnable(tap, true);
        return event;
    }
    if (CGEventGetIntegerValueField(event, kCGEventSourceUserData) == SYNTHETIC_TAG) return event;
    switch (type) {
    case kCGEventKeyDown:
    case kCGEventKeyUp:
        core_input((int)CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode), type == kCGEventKeyDown);
        break;
    case kCGEventLeftMouseDown:
    case kCGEventLeftMouseUp:
        core_input(MOUSE_CODE(1), type == kCGEventLeftMouseDown);
        break;
    case kCGEventRightMouseDown:
    case kCGEventRightMouseUp:
        core_input(MOUSE_CODE(2), type == kCGEventRightMouseDown);
        break;
    case kCGEventOtherMouseDown:
    case kCGEventOtherMouseUp: {
        int64_t number = CGEventGetIntegerValueField(event, kCGMouseEventButtonNumber);
        if (number >= 2 && number <= 4) core_input(MOUSE_CODE((int)number + 1), type == kCGEventOtherMouseDown);
        break;
    }
    default:
        break;
    }
    return event;
}

/* Creates the input tap once Input Monitoring is granted, and reports permission changes. */
static void check_permissions(void) {
    int listen = CGPreflightListenEventAccess();
    int post = CGPreflightPostEventAccess();
    atomic_store(&can_post, post);
    if (listen && !tap) {
        CGEventMask mask = CGEventMaskBit(kCGEventKeyDown) | CGEventMaskBit(kCGEventKeyUp) |
                           CGEventMaskBit(kCGEventLeftMouseDown) | CGEventMaskBit(kCGEventLeftMouseUp) |
                           CGEventMaskBit(kCGEventRightMouseDown) | CGEventMaskBit(kCGEventRightMouseUp) |
                           CGEventMaskBit(kCGEventOtherMouseDown) | CGEventMaskBit(kCGEventOtherMouseUp);
        tap = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionListenOnly, mask,
                               on_event, NULL);
        if (tap) {
            CFRunLoopSourceRef loop_source = CFMachPortCreateRunLoopSource(NULL, tap, 0);
            CFRunLoopAddSource(CFRunLoopGetMain(), loop_source, kCFRunLoopCommonModes);
            CFRelease(loop_source);
        }
    }
    int input = listen && tap;
    if (input != reported_listen || post != reported_post) {
        reported_listen = input;
        reported_post = post;
        core_permissions(input, post);
    }
}

/* Places the indicator at its saved position on the primary screen, kept fully on screen. */
static void place_panel(void) {
    NSRect screen = NSScreen.screens.firstObject.frame;
    NSSize size = panel.frame.size;
    double fraction_x, fraction_y;
    core_indicator_position(&fraction_x, &fraction_y);
    CGFloat x = fraction_x < 0 ? NSMinX(screen) + 12 : NSMinX(screen) + fraction_x * NSWidth(screen);
    CGFloat y = fraction_y < 0 ? NSMinY(screen) + 12 : NSMaxY(screen) - fraction_y * NSHeight(screen) - size.height;
    x = MIN(MAX(x, NSMinX(screen)), NSMaxX(screen) - size.width);
    y = MIN(MAX(y, NSMinY(screen)), NSMaxY(screen) - size.height);
    [panel setFrameOrigin:NSMakePoint(x, y)];
}

void platform_indicator_changed(void) {
    dispatch_async(dispatch_get_main_queue(), ^{
      if (placed_version != core_indicator_position_version()) {
          placed_version = core_indicator_position_version();
          place_panel();
      }
      [panel.contentView setNeedsDisplay:YES];
      if (!core_indicator_visible()) [panel orderOut:nil];
      else if (!panel.visible) [panel orderFrontRegardless];
    });
}

int platform_init(void) {
    mach_timebase_info(&timebase);
    source = CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    panel = [[NSPanel alloc] initWithContentRect:NSMakeRect(0, 0, 128, 28)
                                       styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
                                         backing:NSBackingStoreBuffered
                                           defer:NO];
    panel.level = NSStatusWindowLevel;
    panel.opaque = NO;
    panel.backgroundColor = NSColor.clearColor;
    panel.hasShadow = NO;
    panel.hidesOnDeactivate = NO;
    panel.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces |
                               NSWindowCollectionBehaviorFullScreenAuxiliary |
                               NSWindowCollectionBehaviorStationary | NSWindowCollectionBehaviorIgnoresCycle;
    panel.contentView = [[IndicatorView alloc] initWithFrame:NSMakeRect(0, 0, 128, 28)];
    return 0;
}

void platform_run(void) {
    if (!CGPreflightListenEventAccess()) CGRequestListenEventAccess();
    if (!CGPreflightPostEventAccess()) CGRequestPostEventAccess();
    check_permissions();
    [NSTimer scheduledTimerWithTimeInterval:2 repeats:YES block:^(NSTimer *timer) {
      (void)timer;
      check_permissions();
    }];
    NSWorkspace *workspace = NSWorkspace.sharedWorkspace;
    core_focus([workspace.frontmostApplication.bundleIdentifier isEqualToString:ROBLOX_BUNDLE]);
    [workspace.notificationCenter addObserverForName:NSWorkspaceDidActivateApplicationNotification
                                              object:nil
                                               queue:NSOperationQueue.mainQueue
                                          usingBlock:^(NSNotification *note) {
                                            NSRunningApplication *app = note.userInfo[NSWorkspaceApplicationKey];
                                            core_focus([app.bundleIdentifier isEqualToString:ROBLOX_BUNDLE]);
                                          }];
    placed_version = core_indicator_position_version();
    place_panel();
    if (core_indicator_visible()) [panel orderFrontRegardless];
    [NSApp run];
}

void platform_open_permissions(void) {
    dispatch_async(dispatch_get_main_queue(), ^{
      NSString *pane = reported_listen ? @"Privacy_Accessibility" : @"Privacy_ListenEvent";
      NSString *link = [@"x-apple.systempreferences:com.apple.preference.security?" stringByAppendingString:pane];
      [NSWorkspace.sharedWorkspace openURL:[NSURL URLWithString:link]];
    });
}
