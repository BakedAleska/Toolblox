/*
 * Pixel reading for the Rogue Lineage helper. See detect.h.
 *
 * The mana bar is a tall tan frame around a dark mauve interior. Mana fills the interior from the
 * bottom in any color, so a row counts as filled when it isn't the empty interior's color. The
 * colors were measured from the game's interface, which lighting doesn't change.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "detect.h"

#define MAX_RUNS 2048
/* The empty interior's color. Rows are compared after scaling it to their brightness. */
#define EMPTY_R 83
#define EMPTY_G 65
#define EMPTY_B 73
/* How far a channel may sit from the empty color before the row counts as filled. */
#define EMPTY_TOLERANCE 15

struct run {
    int x, top, bottom;
};

static const uint8_t *at(const struct image *image, int x, int y) {
    return image->pixels + (size_t)y * (size_t)image->stride + (size_t)x * 4;
}

static int inside(const struct image *image, int x, int y) {
    return x >= 0 && y >= 0 && x < image->width && y < image->height;
}

/* The frame's tan, loosely, since its thin lines blend with whatever is behind them. */
static int is_frame(const uint8_t *p) {
    int b = p[0], g = p[1], r = p[2];
    return r >= 135 && r - b >= 40 && g - b >= 12 && r - g >= 12;
}

/* The empty interior's mauve at any brightness, including the shading at its ends. */
static int is_empty(int r, int g, int b) {
    double scale = (r + g + b) / (double)(EMPTY_R + EMPTY_G + EMPTY_B);
    if (scale < 0.65 || scale > 1.3 || b < g - 6) return 0;
    return abs(r - (int)(EMPTY_R * scale)) <= EMPTY_TOLERANCE && abs(g - (int)(EMPTY_G * scale)) <= EMPTY_TOLERANCE &&
           abs(b - (int)(EMPTY_B * scale)) <= EMPTY_TOLERANCE;
}

static int empty_at(const struct image *image, int x, int y) {
    const uint8_t *p = at(image, x, y);
    return is_empty(p[2], p[1], p[0]);
}

/* Averages a row across the middle of the bar, away from the frame's edges. */
static void row_color(const struct image *image, const struct bar *bar, int y, int *r, int *g, int *b) {
    int width = bar->fill_right - bar->fill_left + 1;
    int from = bar->fill_left + width / 3, to = bar->fill_right - width / 3;
    int count = to - from + 1;
    *r = *g = *b = 0;
    for (int x = from; x <= to; x++) {
        const uint8_t *p = at(image, x, y);
        *b += p[0], *g += p[1], *r += p[2];
    }
    *r /= count, *g /= count, *b /= count;
}

/* The share of frame-colored pixels in a row between two columns. */
static double frame_share(const struct image *image, int y, int from, int to) {
    int count = 0;
    for (int x = from; x <= to; x++) count += is_frame(at(image, x, y));
    return (double)count / (to - from + 1);
}

/*
 * Checks that two side lines belong to the bar's frame and measures the area mana fills. It works
 * outward from the empty interior, since the scene around the bar can be the frame's color.
 */
static int measure(const struct image *image, int left, int right, int top, int bottom, struct bar *bar) {
    int width = right - left, middle = (left + right) / 2;
    int from = left + width / 4, to = right - width / 4;
    int fill_top = -1;
    for (int y = top - width < 0 ? 0 : top - width, empty = 0; y < bottom && fill_top < 0; y++) {
        empty = empty_at(image, middle, y) ? empty + 1 : 0;
        if (empty == 5) fill_top = y - 4;
    }
    if (fill_top < 0) return 0;
    int top_line = -1, bottom_line = -1;
    for (int y = fill_top - 1; y >= 0 && y >= fill_top - width && top_line < 0; y--) {
        if (frame_share(image, y, from, to) >= 0.7) top_line = y;
    }
    for (int y = fill_top; y < image->height && y <= bottom + width && bottom_line < 0; y++) {
        if (frame_share(image, y, from, to) >= 0.7) bottom_line = y;
    }
    /*
     * ponytail: mana in the frame's tan that is charged while the bar is found reads as the bottom
     * line. Compare against the side lines' ends if that comes up.
     */
    if (top_line < 0 || bottom_line < 0) return 0;
    int fill_bottom = bottom_line - (fill_top - top_line);
    int rows = fill_bottom - fill_top + 1;
    if (rows < 40 || rows < width * 4) return 0;

    int quarter = rows / 4, empty = 0;
    for (int y = fill_top; y < fill_top + quarter; y++) empty += empty_at(image, middle, y);
    if (empty < quarter * 85 / 100) return 0;

    int probe = fill_top + quarter / 2, fill_left = middle, fill_right = middle;
    while (fill_left > left && empty_at(image, fill_left - 1, probe)) fill_left--;
    while (fill_right < right && empty_at(image, fill_right + 1, probe)) fill_right++;
    if (fill_right - fill_left < width / 2 || fill_left == left || fill_right == right) return 0;

    *bar = (struct bar){left, right, top_line, bottom_line, fill_left, fill_right, fill_top, fill_bottom};
    return 1;
}

int find_bar(const struct image *image, struct bar *bar) {
    static struct run runs[MAX_RUNS];
    int count = 0, width = image->width, height = image->height;
    int shortest = height / 10 < 60 ? 60 : height / 10;
    for (int x = 0; x < width && count < MAX_RUNS; x++) {
        int start = -1, last = -1;
        for (int y = 0; y <= height; y++) {
            int frame = y < height && is_frame(at(image, x, y));
            if (frame) {
                if (start < 0) start = y;
                last = y;
            } else if (start >= 0 && (y == height || y - last > 2)) {
                if (last - start >= shortest && count < MAX_RUNS) runs[count++] = (struct run){x, start, last};
                start = -1;
            }
        }
    }
    long best = 0;
    for (int i = 0; i < count; i++) {
        for (int j = i + 1; j < count; j++) {
            int gap = runs[j].x - runs[i].x;
            if (gap < 8) continue;
            int top = runs[i].top > runs[j].top ? runs[i].top : runs[j].top;
            int bottom = runs[i].bottom < runs[j].bottom ? runs[i].bottom : runs[j].bottom;
            int length = bottom - top;
            if (length < shortest || length * 2 < gap * 9) continue;
            long area = (long)length * gap;
            struct bar found;
            if (area > best && measure(image, runs[i].x, runs[j].x, top, bottom, &found)) {
                best = area;
                *bar = found;
            }
        }
    }
    return best > 0;
}

int bar_present(const struct image *image, const struct bar *bar) {
    int found = 0, checks = 0;
    for (int i = 1; i <= 9; i++) {
        int y = bar->fill_top + (bar->fill_bottom - bar->fill_top) * i / 10;
        for (int side = -1; side <= 1; side += 2) {
            int edge = side < 0 ? bar->fill_left : bar->fill_right, seen = 0;
            for (int x = edge + side; x != edge + side * 6; x += side) seen |= inside(image, x, y) && is_frame(at(image, x, y));
            found += seen;
            checks++;
        }
    }
    return found * 10 >= checks * 6;
}

double read_fill(const struct image *image, const struct bar *bar, uint32_t *color) {
    int rows = bar->fill_bottom - bar->fill_top + 1, filled = 0, misses = 0;
    for (int y = bar->fill_bottom; y >= bar->fill_top && misses < 2; y--) {
        int r, g, b;
        row_color(image, bar, y, &r, &g, &b);
        if (is_empty(r, g, b)) {
            misses++;
        } else {
            filled += 1 + misses;
            misses = 0;
        }
    }
    if (filled >= 3) {
        int r = 0, g = 0, b = 0, count = 0;
        for (int y = bar->fill_bottom - filled / 4; y > bar->fill_bottom - filled + filled / 4; y--, count++) {
            int row_r, row_g, row_b;
            row_color(image, bar, y, &row_r, &row_g, &row_b);
            r += row_r, g += row_g, b += row_b;
        }
        if (count) *color = (uint32_t)(r / count) << 16 | (uint32_t)(g / count) << 8 | (uint32_t)(b / count);
    }
    return 100.0 * filled / rows;
}

/* The prompt's text box: a gray that stays nearly the same over any background. */
static int is_box(const uint8_t *p) {
    int b = p[0], g = p[1], r = p[2];
    return r >= 80 && r <= 160 && g >= 75 && g <= 150 && b >= 60 && b <= 140 && abs(r - g) <= 28 && r - b >= -12 && r - b <= 50;
}

static int near(const uint8_t *a, const uint8_t *b, int tolerance) {
    return abs(a[0] - b[0]) <= tolerance && abs(a[1] - b[1]) <= tolerance && abs(a[2] - b[2]) <= tolerance;
}

/* A gray with every channel at least `floor`. */
static int is_light(const uint8_t *p, int floor) {
    int low = p[0] < p[1] ? p[0] : p[1], high = p[0] > p[1] ? p[0] : p[1];
    if (p[2] < low) low = p[2];
    if (p[2] > high) high = p[2];
    return low >= floor && high - low <= 30;
}

/*
 * Checks one clean row of a gray box that spans `from` to `to`. The box's side margins hold no
 * text, so they give its height. A prompt then has lighter text inside it and a bright title
 * centered above it.
 */
static int is_prompt(const struct image *image, int from, int to, int row, struct box *box) {
    int width = to - from + 1, limit = width / 3;
    int probes[4] = {from + 2, from + 4, to - 4, to - 2};
    int top = row, bottom = row;
    for (int direction = -1; direction <= 1; direction += 2) {
        int y = row;
        while (abs(y - row) <= limit && inside(image, from, y + direction)) {
            int same = 0;
            for (int i = 0; i < 4; i++) same += near(at(image, probes[i], y + direction), at(image, probes[i], row), 12);
            if (same < 3) break;
            y += direction;
        }
        if (abs(y - row) > limit) return 0;
        if (direction < 0) top = y;
        else bottom = y;
    }
    int height = bottom - top + 1;
    int lowest = image->height / 90 < 8 ? 8 : image->height / 90;
    if (height < lowest || width < height * 3 || width > height * 14) return 0;

    const uint8_t *reference = at(image, from + width / 2, row);
    int floor = (reference[0] + reference[1] + reference[2]) / 3 + 45;
    long same = 0, text = 0, area = (long)width * height;
    for (int y = top; y <= bottom; y++) {
        for (int x = from; x <= to; x++) {
            const uint8_t *p = at(image, x, y);
            same += near(p, reference, 16);
            text += is_light(p, floor);
        }
    }
    if (same * 100 < area * 60 || text * 100 < area || text * 100 > area * 35) return 0;

    int center = (from + to) / 2;
    long bright = 0, window = 0;
    for (int y = top - height * 22 / 10; y <= top - height * 3 / 10; y++) {
        for (int x = center - height * 2; x <= center + height * 2; x++) {
            if (!inside(image, x, y)) continue;
            window++;
            bright += is_light(at(image, x, y), 225);
        }
    }
    if (window == 0 || bright * 200 < window) return 0;
    if (box) *box = (struct box){from, to, top, bottom};
    return 1;
}

int find_prompt(const struct image *image, struct box *box) {
    int shortest = image->width / 16 < 40 ? 40 : image->width / 16;
    for (int y = 0; y < image->height; y++) {
        int start = -1;
        for (int x = 0; x <= image->width; x++) {
            int gray = x < image->width && is_box(at(image, x, y)) && (start < 0 || near(at(image, x, y), at(image, x - 1, y), 8));
            if (gray) {
                if (start < 0) start = x;
            } else if (start >= 0) {
                if (x - start >= shortest && is_prompt(image, start, x - 1, y, box)) return 1;
                start = x < image->width && is_box(at(image, x, y)) ? x : -1;
            }
        }
    }
    return 0;
}

/* The largest share of the normal drain that still counts as a cast's slowed drain. */
#define CAST_DRAIN_SHARE 0.5
/* The most mana may rise, in percent, and still count as draining. Covers one row of reading noise. */
#define CAST_RISE_LIMIT 0.5

int is_cast(double before, double after, double seconds, double fill_rate) {
    double change = after - before;
    return fill_rate > 0 && seconds > 0 && change <= CAST_RISE_LIMIT && change >= -fill_rate * seconds * CAST_DRAIN_SHARE;
}

/*
 * Typical latency is well under CAST_PROMPT_WAIT_MS. A Gate cast holds mana for longer than the
 * checks span, and other right clicks fail the first one.
 */

int judge_cast(struct cast *cast, double level, unsigned elapsed, int held, int prompt, double fill_rate) {
    if (cast->held == 1 ? held != 1 : held == 0) return CAST_PUT_AWAY;
    if (!cast->prompted) {
        if (!prompt) return elapsed >= CAST_PROMPT_WAIT_MS ? CAST_NO_PROMPT : 0;
        cast->prompted = 1;
        cast->prompt_at = elapsed;
        cast->level = level;
        return 0;
    }
    unsigned since = elapsed - cast->prompt_at;
    int due = (int)(since / CAST_CHECK_MS);
    if (due <= cast->checks) return 0;
    cast->checks = due;
    if (!is_cast(cast->level, level, since / 1000.0, fill_rate)) return CAST_MANA;
    return cast->checks >= CAST_CHECKS;
}

static int luma(uint32_t color) {
    return (int)(((color >> 16 & 0xFF) * 299 + (color >> 8 & 0xFF) * 587 + (color & 0xFF) * 114) / 1000);
}

uint32_t zone_color(uint32_t spell, uint32_t mana) {
    int distance = 0, toward = luma(mana) < 140 ? 255 : 0;
    uint32_t shade = 0;
    for (int shift = 0; shift <= 16; shift += 8) {
        int a = (int)(spell >> shift & 0xFF), b = (int)(mana >> shift & 0xFF);
        distance += (a - b) * (a - b);
        shade |= (uint32_t)((a + toward) / 2) << shift;
    }
    return distance < 110 * 110 ? shade : spell;
}

/*
 * The hotbar is a row of slots: a dark frame, a thin bevel, and a flat interior with the skill's
 * name in dark ink. A selected slot's interior is lighter, and it's a little larger. The flat
 * interior keeps its exact color at any window size, while the frame and bevel blend with their
 * surroundings when the interface is scaled, so slots are found by their interiors alone.
 */
static const uint8_t SLOT_PLAIN[] = {0xBF, 0xCB, 0xD7}, SLOT_SELECTED[] = {0xEE, 0xF8, 0xFF};
#define SLOT_TOLERANCE 3
/* The narrowest interior, in pixels: a fifth of its width in a 1920 by 1080 window. */
#define SLOT_MIN_WIDTH 10
/* Slots in a row are within this share of the middle slot's width. The selected slot is wider. */
#define SLOT_WIDTH_SPREAD 0.25
/* Ink at or below this brightness counts in full, and a pixel counts as ink from INK_EDGE of 255. */
#define INK_LUMA 60
#define INK_EDGE 96

/* 1 for a plain interior pixel, 2 for a selected one, 0 for anything else. */
static int slot_color(const struct image *image, int x, int y) {
    const uint8_t *p = at(image, x, y);
    return near(p, SLOT_PLAIN, SLOT_TOLERANCE) ? 1 : near(p, SLOT_SELECTED, SLOT_TOLERANCE) ? 2 : 0;
}

static int pixel_luma(const uint8_t *p) {
    return (p[2] * 299 + p[1] * 587 + p[0] * 114) / 1000;
}

/*
 * Extends a run of interior found on one row up and down its first and last columns. A long name's
 * ink can reach both for a few rows, so gaps shorter than a quarter of the width are crossed.
 * Returns 1 when the result is slot-shaped, which a gap between letters isn't.
 */
static int span(const struct image *image, struct slot *slot, int kind) {
    int width = slot->right - slot->left + 1, gap = width / 4;
    for (int y = slot->top - 1; y >= 0 && slot->top - y <= gap; y--) {
        if (slot_color(image, slot->left, y) == kind || slot_color(image, slot->right, y) == kind) slot->top = y;
    }
    for (int y = slot->bottom + 1; y < image->height && y - slot->bottom <= gap; y++) {
        if (slot_color(image, slot->left, y) == kind || slot_color(image, slot->right, y) == kind) slot->bottom = y;
    }
    int height = slot->bottom - slot->top + 1;
    return height * 2 >= width && height <= width * 2;
}

static int by_width(const void *a, const void *b) {
    const struct slot *x = a, *y = b;
    return (x->right - x->left) - (y->right - y->left);
}

/* Keeps the runs within SLOT_WIDTH_SPREAD of the middle run's width, in order. Returns how many. */
static int regular(struct slot *row, int count) {
    struct slot sorted[HOTBAR_SLOTS * 2];
    if (!count) return 0;
    memcpy(sorted, row, sizeof row[0] * (size_t)count);
    qsort(sorted, (size_t)count, sizeof sorted[0], by_width);
    double middle = sorted[count / 2].right - sorted[count / 2].left + 1;
    int kept = 0;
    for (int i = 0; i < count; i++) {
        double width = row[i].right - row[i].left + 1;
        if (width >= middle * (1 - SLOT_WIDTH_SPREAD) && width <= middle * (1 + SLOT_WIDTH_SPREAD)) row[kept++] = row[i];
    }
    return kept;
}

int find_hotbar(const struct image *image, struct slot slots[HOTBAR_SLOTS]) {
    int best = 0;
    for (int y = 0; y < image->height; y++) {
        struct slot row[HOTBAR_SLOTS * 2];
        int count = 0;
        for (int x = 0; x < image->width && count < HOTBAR_SLOTS * 2; x++) {
            int kind = slot_color(image, x, y);
            if (!kind) continue;
            int end = x;
            while (end + 1 < image->width && slot_color(image, end + 1, y) == kind) end++;
            struct slot slot = {x, end, y, y};
            if (end - x + 1 >= SLOT_MIN_WIDTH && span(image, &slot, kind)) row[count++] = slot;
            x = end;
        }
        count = regular(row, count);
        if (count > HOTBAR_SLOTS) count = HOTBAR_SLOTS;
        if (count > best || (count && count == best && row[0].top > slots[0].bottom)) {
            best = count;
            memcpy(slots, row, sizeof row[0] * (size_t)count);
        }
    }
    return best;
}

static int reading_order(const void *a, const void *b) {
    const struct slot *x = a, *y = b;
    int height = x->bottom - x->top + 1;
    if (y->top - x->top > height / 2) return -1;
    if (x->top - y->top > height / 2) return 1;
    return x->left - y->left;
}

static int overlaps(const struct slot *a, const struct slot *b) {
    return a->left <= b->right && b->left <= a->right && a->top <= b->bottom && b->top <= a->bottom;
}

int find_backpack(const struct image *image, int limit, int width, struct slot slots[BACKPACK_SLOTS]) {
    int count = 0;
    if (limit > image->height) limit = image->height;
    for (int y = 0; y < limit && count < BACKPACK_SLOTS; y += 2) {
        for (int x = 0; x < image->width && count < BACKPACK_SLOTS; x++) {
            int kind = slot_color(image, x, y);
            if (!kind) continue;
            int end = x;
            while (end + 1 < image->width && slot_color(image, end + 1, y) == kind) end++;
            struct slot run = {x, end, y, y}, interior;
            x = end;
            if (end - run.left + 1 < SLOT_MIN_WIDTH || !span(image, &run, kind) || read_slot(image, &run, &interior) < 0) continue;
            int found = 0;
            for (int i = 0; i < count && !found; i++) found = overlaps(&slots[i], &interior);
            int across = interior.right - interior.left + 1, high = interior.bottom - interior.top + 1;
            if (!found && interior.bottom < limit && high * 2 >= across && high <= across * 2) slots[count++] = interior;
        }
    }
    if (!count) return 0;
    if (!width) {
        struct slot sorted[BACKPACK_SLOTS];
        memcpy(sorted, slots, sizeof slots[0] * (size_t)count);
        qsort(sorted, (size_t)count, sizeof sorted[0], by_width);
        width = sorted[count / 2].right - sorted[count / 2].left + 1;
    }
    int kept = 0;
    for (int i = 0; i < count; i++) {
        double across = slots[i].right - slots[i].left + 1;
        if (across >= width * (1 - SLOT_WIDTH_SPREAD) && across <= width * (1 + SLOT_WIDTH_SPREAD)) slots[kept++] = slots[i];
    }
    qsort(slots, (size_t)kept, sizeof slots[0], reading_order);
    return kept;
}

static int side(const struct slot *interior) {
    return interior->left + (interior->right - interior->left) / 4;
}

/*
 * Samples the interior on two rows near its top and bottom edges, which names never reach, and
 * measures it from there. The height is measured a quarter of the way across, clear of the key
 * label that overlaps the middle of the top edge.
 */
int read_slot(const struct image *image, const struct slot *slot, struct slot *interior) {
    int x = (slot->left + slot->right) / 2, height = slot->bottom - slot->top + 1;
    int upper = slot->top + height / 8, lower = slot->bottom - height / 8;
    if (!inside(image, slot->left, slot->top) || !inside(image, slot->right, slot->bottom)) return -1;
    int kind = slot_color(image, x, upper);
    if (!kind || slot_color(image, x, lower) != kind) return -1;
    *interior = (struct slot){x, x, upper, lower};
    while (interior->left > 0 && slot_color(image, interior->left - 1, upper) == kind) interior->left--;
    while (interior->right + 1 < image->width && slot_color(image, interior->right + 1, upper) == kind) interior->right++;
    x = side(interior);
    while (interior->top > 0 && slot_color(image, x, interior->top - 1) == kind) interior->top--;
    while (interior->bottom + 1 < image->height && slot_color(image, x, interior->bottom + 1) == kind) interior->bottom++;
    return kind == 2;
}

/* How much of a pixel is ink, from 0 to 255, against the interior's brightness. */
static int ink(const struct image *image, int x, int y, int background) {
    int value = (background - pixel_luma(at(image, x, y))) * 255 / (background - INK_LUMA);
    return value < 0 ? 0 : value > 255 ? 255 : value;
}

int read_glyph(const struct image *image, const struct slot *interior, uint8_t glyph[GLYPH_SIZE]) {
    int background = pixel_luma(at(image, side(interior), interior->top)), margin = (interior->bottom - interior->top + 1) / 8;
    int left = interior->right, right = interior->left - 1, top = interior->bottom, bottom = interior->top - 1;
    for (int y = interior->top + margin; y <= interior->bottom - margin; y++) {
        for (int x = interior->left; x <= interior->right; x++) {
            if (ink(image, x, y, background) < INK_EDGE) continue;
            if (x < left) left = x;
            if (x > right) right = x;
            if (y < top) top = y;
            if (y > bottom) bottom = y;
        }
    }
    memset(glyph, 0, GLYPH_SIZE);
    if (right < left) return 0;
    double width = right - left + 1, height = bottom - top + 1;
    for (int row = 0; row < GLYPH_HEIGHT; row++) {
        for (int column = 0; column < GLYPH_WIDTH; column++) {
            int total = 0;
            for (int sy = 0; sy < 3; sy++) {
                for (int sx = 0; sx < 3; sx++) {
                    int x = left + (int)((column * 3 + sx + 0.5) * width / (GLYPH_WIDTH * 3));
                    int y = top + (int)((row * 3 + sy + 0.5) * height / (GLYPH_HEIGHT * 3));
                    total += ink(image, x, y, background);
                }
            }
            glyph[row * GLYPH_WIDTH + column] = (uint8_t)((total * 15 + 9 * 127) / (9 * 255));
        }
    }
    return 1;
}

int glyph_distance(const uint8_t *a, const uint8_t *b) {
    int distance = 0;
    for (int i = 0; i < GLYPH_SIZE; i++) distance += abs(a[i] - b[i]);
    return distance;
}

/* Lowercase letters only, so spacing, line breaks, and punctuation read by OCR don't count. */
static size_t letters(const char *text, char *out, size_t size) {
    size_t used = 0;
    for (; *text && used + 1 < size; text++) {
        char c = *text;
        if (c >= 'A' && c <= 'Z') c = (char)(c - 'A' + 'a');
        if (c >= 'a' && c <= 'z') out[used++] = c;
    }
    out[used] = 0;
    return used;
}

/* Levenshtein distance between two strings of at most NAME_LETTERS letters. */
static int edits(const char *a, size_t a_length, const char *b, size_t b_length) {
    int row[NAME_LETTERS + 1];
    for (size_t j = 0; j <= b_length; j++) row[j] = (int)j;
    for (size_t i = 1; i <= a_length; i++) {
        int diagonal = row[0];
        row[0] = (int)i;
        for (size_t j = 1; j <= b_length; j++) {
            int above = row[j], cost = diagonal + (a[i - 1] != b[j - 1]);
            if (above + 1 < cost) cost = above + 1;
            if (row[j - 1] + 1 < cost) cost = row[j - 1] + 1;
            diagonal = above;
            row[j] = cost;
        }
    }
    return row[b_length];
}

int match_name(const char *text, const char *const *names, int count) {
    char read[NAME_LETTERS + 1], name[NAME_LETTERS + 1];
    size_t length = letters(text, read, sizeof read);
    int best = -1, best_edits = 0;
    if (!length) return -1;
    for (int i = 0; i < count; i++) {
        size_t name_length = letters(names[i], name, sizeof name);
        int allowed = name_length < 8 ? 1 : (int)name_length / 4, distance = edits(read, length, name, name_length);
        if (name_length && distance <= allowed && (best < 0 || distance < best_edits)) {
            best = i;
            best_edits = distance;
        }
    }
    return best;
}

int match_lines(const char *text, const char *const *names, int count) {
    char line[128];
    while (*text) {
        size_t length = strcspn(text, "\n");
        snprintf(line, sizeof line, "%.*s", (int)length, text);
        int found = match_name(line, names, count);
        if (found >= 0) return found;
        text += length + (text[length] == '\n');
    }
    return -1;
}

int letter_count(const char *text) {
    int count = 0;
    for (; *text; text++) count += (*text >= 'a' && *text <= 'z') || (*text >= 'A' && *text <= 'Z');
    return count;
}
