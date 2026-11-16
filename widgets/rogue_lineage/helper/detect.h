/*
 * Pixel reading for the Rogue Lineage helper: finds the mana bar, reads how full it is, spots the
 * Gate prompt, finds the hotbar's slots, and reads the name in each. Everything here works on a
 * captured image and touches no platform API, so test.c runs it on drawn frames and screenshots.
 */
#ifndef DETECT_H
#define DETECT_H

#include <stdint.h>

/* A top-down image with four bytes per pixel in blue, green, red, unused order. */
struct image {
    const uint8_t *pixels;
    int width, height, stride;
};

/*
 * The mana bar in image coordinates, all inclusive. `left`, `right`, `top`, and `bottom` are the
 * side lines and the lines nearest the interior. The `fill_` fields bound the area mana fills, from
 * the bottom up.
 */
struct bar {
    int left, right, top, bottom;
    int fill_left, fill_right, fill_top, fill_bottom;
};

/* Finds the mana bar's frame. The bar must be less than three quarters full. Returns 1 if found. */
int find_bar(const struct image *image, struct bar *bar);
/* Returns 1 while the frame still lines both sides of the area mana fills. */
int bar_present(const struct image *image, const struct bar *bar);
/*
 * Returns how full the bar is, from 0 to 100. `color` receives the mana color as 0xRRGGBB when at
 * least three rows are filled, and is left alone otherwise.
 */
double read_fill(const struct image *image, const struct bar *bar, uint32_t *color);
/* A rectangle in image coordinates, all inclusive. */
struct box {
    int left, right, top, bottom;
};
/* Returns 1 when the Gate prompt, a titled text box, is in the image, and its text box in `box` when that's set. */
int find_prompt(const struct image *image, struct box *box);
/*
 * Returns 1 when mana that went from `before` to `after` percent over `seconds` shows a cast.
 * `fill_rate` is how fast mana fills, in percent per second, which is also how fast it drains.
 * A cast slows the drain to a fraction of that. Without one, mana keeps filling or drains in full.
 */
int is_cast(double before, double after, double seconds, double fill_rate);
/*
 * A right click being judged as a Gate cast: whether Gate was equipped at the click (1, or -1 when
 * the hotbar couldn't tell), when the prompt appeared and the mana level then, and how many mana
 * checks have passed since.
 */
struct cast {
    int held, prompted;
    unsigned prompt_at;
    double level;
    int checks;
};
/*
 * Judges a cast `elapsed` milliseconds after the click, from the mana level, whether Gate is
 * equipped now (1, 0, or -1 for unknown), and whether its prompt is on screen. The server opens
 * the prompt after a round trip, so it has CAST_PROMPT_WAIT_MS to appear. From then on, mana is
 * checked every CAST_CHECK_MS. Returns 1 once CAST_CHECKS checks have passed, 0 while it's still
 * being judged, and one of the CAST_ reasons below when it isn't a Gate cast.
 */
#define CAST_PUT_AWAY -1
#define CAST_NO_PROMPT -2
#define CAST_MANA -3
#define CAST_PROMPT_WAIT_MS 1000
#define CAST_CHECK_MS 150
#define CAST_CHECKS 3
int judge_cast(struct cast *cast, double level, unsigned elapsed, int held, int prompt, double fill_rate);
/* Returns `spell`, or a lighter or darker shade of it when it's too close to `mana` to tell apart. */
uint32_t zone_color(uint32_t spell, uint32_t mana);

#define HOTBAR_SLOTS 12
#define GLYPH_WIDTH 32
#define GLYPH_HEIGHT 16
#define GLYPH_SIZE (GLYPH_WIDTH * GLYPH_HEIGHT)
/*
 * The shortest interior, in pixels, whose name OCR reads reliably: the hotbar at three quarters of
 * its size in a 1920 by 1080 window. Names in shorter slots are read, but one that matches nothing
 * doesn't show what the slot holds.
 */
#define SLOT_READABLE_HEIGHT 40
/* The largest glyph_distance at which two glyphs are the same name. */
#define GLYPH_MATCH 600

/* A hotbar slot's interior in image coordinates, all inclusive. */
struct slot {
    int left, right, top, bottom;
};

/* The fewest slots in a row that count as the hotbar. */
#define HOTBAR_MIN_SLOTS 3
/*
 * Finds the row with the most slots, left to right, and returns how many it has. It's the hotbar
 * when that's at least HOTBAR_MIN_SLOTS. Of rows with as many, the lowest wins, as the backpack's
 * rows sit above the hotbar.
 */
int find_hotbar(const struct image *image, struct slot slots[HOTBAR_SLOTS]);

/* The most backpack slots kept. */
#define BACKPACK_SLOTS 128
/*
 * Finds the open backpack's slot interiors above row `limit`, in reading order, and returns how
 * many. Slots within SLOT_WIDTH_SPREAD of `width` count, or of the middle slot's width when it's 0.
 */
int find_backpack(const struct image *image, int limit, int width, struct slot slots[BACKPACK_SLOTS]);
/*
 * Returns 1 when the slot is selected, 0 when it isn't, and -1 when it's no longer on screen.
 * `interior` receives the slot's current interior, which grows while the slot is selected.
 */
int read_slot(const struct image *image, const struct slot *slot, struct slot *interior);
/*
 * Reads the name written in a slot's interior as a grid of ink coverage from 0 to 15. The name's
 * bounds are stretched to fill the grid, so a selected slot's larger name reads the same. Returns 0
 * when the slot is empty.
 */
int read_glyph(const struct image *image, const struct slot *interior, uint8_t glyph[GLYPH_SIZE]);
/* Returns how different two glyphs are, from 0 for identical to 15 * GLYPH_SIZE. */
int glyph_distance(const uint8_t *a, const uint8_t *b);

/* The most letters of a name that are compared. */
#define NAME_LETTERS 63
/*
 * Returns the index of the name that text read by OCR spells, or -1 when none is close enough.
 * Only letters count, without case. A name of fewer than 8 letters may differ by one letter, and a
 * longer one by one in four.
 */
int match_name(const char *text, const char *const *names, int count);
/* Returns how many ASCII letters `text` holds. */
int letter_count(const char *text);
/* Returns the index of the name that any line of `text` matches, as match_name does, or -1. */
int match_lines(const char *text, const char *const *names, int count);

#endif
