/*
 * Checks detect.c on drawn frames, and the hotbar reading on screenshots in `fixtures/`. On Windows
 * it also checks ocr.c: `gcc -std=c11 -O2 -Wall -Wextra test.c detect.c ocr.c -lruntimeobject -o test
 * && ./test`. build.sh runs it before building the helper.
 *
 * `./test screenshot.bmp` prints the text read from every hotbar slot in a 24- or 32-bit BMP instead.
 */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "detect.h"

#define WIDTH 1280
#define HEIGHT 720
#define SAND 0xC5A960
#define FRAME 0xD9A871
#define EMPTY 0x534049

/* The bright interface's frame and empty interior, which some scenes show. */
#define BRIGHT_FRAME 0xFFFFC9
#define BRIGHT_EMPTY 0x977888

static uint8_t pixels[WIDTH * HEIGHT * 4];
static uint32_t frame_color = FRAME, empty_color = EMPTY;
static const struct image image = {pixels, WIDTH, HEIGHT, WIDTH * 4};
static int failures;

#define CHECK(condition) \
    do { \
        if (!(condition)) { \
            printf("FAILED line %d: %s\n", __LINE__, #condition); \
            failures++; \
        } \
    } while (0)

static void rect(int left, int top, int right, int bottom, uint32_t color) {
    for (int y = top; y <= bottom; y++) {
        for (int x = left; x <= right; x++) {
            uint8_t *p = pixels + ((size_t)y * WIDTH + x) * 4;
            p[0] = color & 0xFF, p[1] = color >> 8 & 0xFF, p[2] = color >> 16 & 0xFF;
        }
    }
}

/* A scene with some variation, so nothing is found by flat color alone. */
static void scene(uint32_t color) {
    rect(0, 0, WIDTH - 1, HEIGHT - 1, color);
    for (int y = 0; y < HEIGHT; y += 37) rect(0, y, WIDTH - 1, y + 5, 0x3D2A13);
}

/*
 * Draws the bar like the game does: an outer line, a dark gap, an inner line at the ends, then the
 * interior. Returns the interior's first and last rows through `fill_top` and `fill_bottom`.
 */
static void draw_bar(int left, int top, int width, int height, int *fill_top, int *fill_bottom) {
    int line = width / 18 < 1 ? 1 : width / 18;
    rect(left, top, left + width - 1, top + height - 1, frame_color);
    rect(left + line, top + line, left + width - 1 - line, top + height - 1 - line, 0x4B341C);
    rect(left + line, top + line * 2, left + width - 1 - line, top + line * 3 - 1, frame_color);
    rect(left + line, top + height - line * 3, left + width - 1 - line, top + height - 1 - line * 2, frame_color);
    *fill_top = top + line * 3;
    *fill_bottom = top + height - 1 - line * 3;
    rect(left + line * 2, *fill_top, left + width - 1 - line * 2, *fill_bottom, empty_color);
}

static void draw_mana(const struct bar *bar, double percent, uint32_t color) {
    int rows = bar->fill_bottom - bar->fill_top + 1;
    rect(bar->fill_left, bar->fill_top, bar->fill_right, bar->fill_bottom, empty_color);
    int filled = (int)lround(rows * percent / 100);
    if (filled) rect(bar->fill_left, bar->fill_bottom - filled + 1, bar->fill_right, bar->fill_bottom, color);
}

/* A text box with a line of text marks, under a title when `title` is set. */
static void draw_prompt(int center, int top, int height, int title) {
    int half = height * 3;
    rect(center - half - height, top - height * 2, center + half + height, top + height + height / 2, 0xB49C7B);
    rect(center - half, top, center + half, top + height - 1, 0x827461);
    for (int x = center - half + height / 2; x < center + half / 2; x += 6) {
        rect(x, top + height / 3, x + 2, top + height * 2 / 3, 0xCFCFCF);
    }
    if (!title) return;
    for (int x = center - height / 2; x < center + height / 2; x += 6) {
        rect(x, top - height * 12 / 10, x + 3, top - height * 9 / 10, 0xFCFCFB);
    }
}

static void test_bar(int left, int top, int width, int height) {
    static const double levels[] = {0, 21, 50, 74, 80, 100};
    static const uint32_t colors[] = {0x8F9B27, 0x2A6BD9, 0xE04040, 0xF2F2F2, 0x151515};
    int fill_top, fill_bottom;
    struct bar bar;
    scene(SAND);
    draw_bar(left, top, width, height, &fill_top, &fill_bottom);
    CHECK(find_bar(&image, &bar));
    CHECK(abs(bar.fill_top - fill_top) <= 1 && abs(bar.fill_bottom - fill_bottom) <= 1);
    CHECK(bar.fill_left > left && bar.fill_right < left + width - 1);
    CHECK(bar_present(&image, &bar));
    for (size_t c = 0; c < sizeof colors / sizeof colors[0]; c++) {
        for (size_t i = 0; i < sizeof levels / sizeof levels[0]; i++) {
            uint32_t color = 0;
            draw_mana(&bar, levels[i], colors[c]);
            double percent = read_fill(&image, &bar, &color);
            CHECK(fabs(percent - levels[i]) <= 1.5);
            CHECK(levels[i] == 0 ? color == 0 : color == colors[c]);
        }
    }
    /* Lines a few rows tall across the empty part, or across the fill, don't move the reading. */
    int rows = bar.fill_bottom - bar.fill_top + 1;
    uint32_t color = 0;
    draw_mana(&bar, 50, 0x2A6BD9);
    rect(bar.fill_left, bar.fill_bottom - rows * 8 / 10, bar.fill_right, bar.fill_bottom - rows * 8 / 10 + 2, 0xE04040);
    CHECK(fabs(read_fill(&image, &bar, &color) - 50) <= 1.5);
    draw_mana(&bar, 50, 0x2A6BD9);
    rect(bar.fill_left, bar.fill_bottom - rows * 3 / 10, bar.fill_right, bar.fill_bottom - rows * 3 / 10 + 2, empty_color);
    CHECK(fabs(read_fill(&image, &bar, &color) - 50) <= 1.5);
    draw_mana(&bar, 60, 0x8F9B27);
    struct bar again;
    CHECK(find_bar(&image, &again) && again.fill_top == bar.fill_top);
    draw_mana(&bar, 90, 0x8F9B27);
    CHECK(!find_bar(&image, &again));
    scene(0x20303A);
    CHECK(!bar_present(&image, &bar));
}

/* Loads a bottom-up or top-down BMP with 24 or 32 bits per pixel. The pixels are never freed. */
static int load_bmp(const char *path, struct image *out) {
    FILE *file = fopen(path, "rb");
    if (!file) return 0;
    fseek(file, 0, SEEK_END);
    long size = ftell(file);
    fseek(file, 0, SEEK_SET);
    uint8_t *data = size > 54 ? malloc((size_t)size) : NULL;
    int ok = data && fread(data, 1, (size_t)size, file) == (size_t)size;
    fclose(file);
    if (!ok || data[0] != 'B' || data[1] != 'M') return 0;
    int32_t offset, width, height;
    uint16_t bits;
    memcpy(&offset, data + 10, 4);
    memcpy(&width, data + 18, 4);
    memcpy(&height, data + 22, 4);
    memcpy(&bits, data + 28, 2);
    int bottom_up = height > 0, rows = abs(height), bytes = bits / 8, stride = (width * bytes + 3) & ~3;
    if ((bits != 24 && bits != 32) || width <= 0 || offset + (long)stride * rows > size) return 0;
    uint8_t *pixels = malloc((size_t)width * (size_t)rows * 4);
    if (!pixels) return 0;
    for (int y = 0; y < rows; y++) {
        const uint8_t *from = data + offset + (size_t)(bottom_up ? rows - 1 - y : y) * (size_t)stride;
        for (int x = 0; x < width; x++) memcpy(pixels + ((size_t)y * width + x) * 4, from + x * bytes, 3);
    }
    free(data);
    *out = (struct image){pixels, width, rows, width * 4};
    return 1;
}

/* A screenshot's hotbar: each slot's interior, whether it's selected, and its glyph. */
struct hotbar {
    struct image shot;
    int count, selected[HOTBAR_SLOTS];
    struct slot interiors[HOTBAR_SLOTS];
    uint8_t glyphs[HOTBAR_SLOTS][GLYPH_SIZE];
};

static int measure_hotbar(struct hotbar *hotbar) {
    struct slot slots[HOTBAR_SLOTS];
    hotbar->count = find_hotbar(&hotbar->shot, slots);
    for (int i = 0; i < hotbar->count; i++) {
        hotbar->selected[i] = read_slot(&hotbar->shot, &slots[i], &hotbar->interiors[i]);
        if (hotbar->selected[i] < 0 || !read_glyph(&hotbar->shot, &hotbar->interiors[i], hotbar->glyphs[i])) memset(hotbar->glyphs[i], 0, GLYPH_SIZE);
    }
    return hotbar->count;
}

static int read_hotbar(const char *path, struct hotbar *hotbar) {
    if (load_bmp(path, &hotbar->shot)) return measure_hotbar(hotbar);
    printf("Couldn't read %s\n", path);
    return 0;
}

/*
 * Resizes an image by `factor`, averaging the source area under each pixel, so edges blend as they
 * do when the game draws its interface at another window size. The pixels are never freed.
 */
static struct image resize_image(const struct image *source, double factor) {
    int width = (int)lround(source->width * factor), height = (int)lround(source->height * factor);
    uint8_t *pixels = calloc((size_t)width * (size_t)height, 4);
    for (int y = 0; y < height && pixels; y++) {
        double top = y / factor, bottom = (y + 1) / factor;
        for (int x = 0; x < width; x++) {
            double left = x / factor, right = (x + 1) / factor, sum[3] = {0, 0, 0}, total = 0;
            for (int sy = (int)top; sy < bottom && sy < source->height; sy++) {
                double h = fmin(bottom, sy + 1) - fmax(top, sy);
                for (int sx = (int)left; sx < right && sx < source->width; sx++) {
                    double w = (fmin(right, sx + 1) - fmax(left, sx)) * h;
                    const uint8_t *p = source->pixels + (size_t)sy * source->stride + (size_t)sx * 4;
                    for (int k = 0; k < 3; k++) sum[k] += p[k] * w;
                    total += w;
                }
            }
            for (int k = 0; k < 3; k++) pixels[((size_t)y * width + x) * 4 + k] = (uint8_t)lround(sum[k] / total);
        }
    }
    return (struct image){pixels, width, height, width * 4};
}

#ifdef _WIN32
#include "ocr.h"
/* Reads a slot at each of the helper's heights, as it does, and returns the first that names a skill. */
static int read_name(const struct hotbar *hotbar, int slot, const char *const *names, int count, char *text, size_t size) {
    static const int heights[] = OCR_HEIGHTS;
    for (size_t i = 0; i < sizeof heights / sizeof heights[0]; i++) {
        int found = ocr_read(&hotbar->shot, &hotbar->interiors[slot], heights[i], text, size) ? match_name(text, names, count) : -1;
        if (found >= 0) return found;
    }
    return -1;
}
#endif

/* Prints the text OCR reads from each slot, which is the name to add to `../skills.js`. */
static int print_names(int count, char **paths) {
#ifdef _WIN32
    if (!ocr_start()) {
        printf("Windows has no OCR language for this user.\n");
        return 1;
    }
    for (int file = 0; file < count; file++) {
        static struct hotbar hotbar;
        char text[128] = "";
        printf("%s: %d slots\n", paths[file], read_hotbar(paths[file], &hotbar));
        for (int i = 0; i < hotbar.count; i++) {
            ocr_read(&hotbar.shot, &hotbar.interiors[i], 141, text, sizeof text);
            printf("%d%s %s\n", i + 1, hotbar.selected[i] ? " (selected)" : "", text);
        }
    }
    return 0;
#else
    (void)count, (void)paths;
    printf("Reading names needs Windows.\n");
    return 1;
#endif
}

static const char *const paths[] = {"fixtures/skills.bmp", "fixtures/skills-selected.bmp", "fixtures/spells.bmp"};
static const char *const all_names[] = {"Spear", "Tidal Trident", "Skewer", "Deep Sacrifice", "Gelidus", "Harpoon",
    "Serpent Strike", "Armis", "Ignis", "Ocean's Protection", "Fisherman's Trap", "Hunter's Focus",
    "Sagitta Sol", "Trickstus", "Scrupus", "Tenebris", "Gelidus", "Viribus", "Manus Dei", "Telorum", "Trahere", "Hoppa", "Igelti", "Gate"};
static const int offsets[] = {0, 0, HOTBAR_SLOTS};

/*
 * Checks the three fixture hotbars at one size: every slot is found, only the selected one reads
 * as selected, each glyph matches the same name and no other, and on Windows, OCR names every slot.
 */
static void check_hotbars(struct hotbar hotbars[3], double factor, int reader) {
    int before = failures;
    for (int file = 0; file < 3; file++) {
        CHECK(hotbars[file].count == HOTBAR_SLOTS);
        for (int i = 0; i < hotbars[file].count; i++) CHECK(hotbars[file].selected[i] == (file == 1 && i == 1));
    }
    if (failures != before) {
        printf("At %.2f times the size, the hotbar wasn't read.\n", factor);
        return;
    }
    for (int a = 0; a < 3 * HOTBAR_SLOTS; a++) {
        for (int b = a + 1; b < 3 * HOTBAR_SLOTS; b++) {
            int same = !strcmp(all_names[offsets[a / HOTBAR_SLOTS] + a % HOTBAR_SLOTS], all_names[offsets[b / HOTBAR_SLOTS] + b % HOTBAR_SLOTS]);
            int distance = glyph_distance(hotbars[a / HOTBAR_SLOTS].glyphs[a % HOTBAR_SLOTS], hotbars[b / HOTBAR_SLOTS].glyphs[b % HOTBAR_SLOTS]);
            /* A selected slot isn't read again, so its glyph only has to match its plain self at full size. */
            if (same && factor != 1 && (hotbars[a / HOTBAR_SLOTS].selected[a % HOTBAR_SLOTS] || hotbars[b / HOTBAR_SLOTS].selected[b % HOTBAR_SLOTS])) continue;
            if (same ? distance > GLYPH_MATCH : distance <= GLYPH_MATCH) {
                printf("At %.2f times, the glyphs of %s and %s are %d apart.\n", factor, all_names[offsets[a / HOTBAR_SLOTS] + a % HOTBAR_SLOTS],
                       all_names[offsets[b / HOTBAR_SLOTS] + b % HOTBAR_SLOTS], distance);
            }
            CHECK(same ? distance <= GLYPH_MATCH : distance > GLYPH_MATCH);
        }
    }
#ifdef _WIN32
    int count = sizeof all_names / sizeof all_names[0];
    for (int file = 0; file < 3 && reader; file++) {
        for (int i = 0; i < HOTBAR_SLOTS; i++) {
            char text[128] = "";
            int found = read_name(&hotbars[file], i, all_names, count, text, sizeof text);
            const char *expected = all_names[offsets[file] + i];
            const struct slot *interior = &hotbars[file].interiors[i];
            /* Below SLOT_READABLE_HEIGHT a name may go unread, but it's never read as another name. */
            if (interior->bottom - interior->top + 1 < SLOT_READABLE_HEIGHT && found < 0) continue;
            if (found < 0 || strcmp(all_names[found], expected)) printf("At %.2f times, %s slot %d read \"%s\", not %s\n", factor, paths[file], i + 1, text, expected);
            CHECK(found >= 0 && !strcmp(all_names[found], expected));
        }
    }
#else
    (void)reader;
#endif
}

/*
 * The fixtures are the hotbar in three screenshots at 1920 by 1080: skills, the same skills with
 * the second slot selected, and spells. They're checked as taken, then resized from half to twice
 * the size, which covers windows from 960 by 540 to 3840 by 2160 when the interface scales with
 * the window. At three quarters and larger, OCR must name every slot.
 */
static void test_hotbar(void) {
    static const double factors[] = {0.5, 0.6, 0.67, 0.7, 0.75, 0.9, 1.25, 1.5, 2};
    static struct hotbar hotbars[3], resized[3];
    int reader = 0;
#ifdef _WIN32
    reader = ocr_start();
    if (!reader) printf("Skipped the OCR checks: Windows has no OCR language for this user.\n");
#endif
    for (int file = 0; file < 3; file++) read_hotbar(paths[file], &hotbars[file]);
    check_hotbars(hotbars, 1, reader);
    for (size_t f = 0; f < sizeof factors / sizeof factors[0]; f++) {
        for (int file = 0; file < 3; file++) {
            resized[file].shot = resize_image(&hotbars[file].shot, factors[f]);
            measure_hotbar(&resized[file]);
        }
        check_hotbars(resized, factors[f], reader);
        for (int file = 0; file < 3; file++) free((void *)resized[file].shot.pixels);
    }
    struct slot slots[HOTBAR_SLOTS];
    scene(SAND);
    CHECK(find_hotbar(&image, slots) == 0);
    rect(100, 600, 159, 659, 0xD7CBBF);
    rect(200, 600, 259, 659, 0xD7CBBF);
    CHECK(find_hotbar(&image, slots) == 2);
}

/*
 * The mana bar in a screenshot at 1920 by 1080, empty, found and read at the same sizes as the
 * hotbar, with mana drawn into it at each.
 */
static void test_mana(void) {
    static const double factors[] = {1, 0.5, 0.6, 0.75, 0.9, 1.25, 1.5, 2};
    struct image shot;
    if (!load_bmp("fixtures/mana.bmp", &shot)) {
        CHECK(!"fixtures/mana.bmp loads");
        return;
    }
    for (size_t f = 0; f < sizeof factors / sizeof factors[0]; f++) {
        struct image resized = resize_image(&shot, factors[f]);
        struct bar bar;
        uint32_t color = 0;
        int found = find_bar(&resized, &bar);
        if (!found) printf("At %.2f times the size, the mana bar wasn't found.\n", factors[f]);
        CHECK(found);
        if (found) {
            CHECK(fabs((bar.fill_bottom - bar.fill_top + 1) - 343 * factors[f]) <= 2 + 4 * factors[f]);
            CHECK(bar_present(&resized, &bar));
            CHECK(read_fill(&resized, &bar, &color) <= 1.5);
            int rows = bar.fill_bottom - bar.fill_top + 1;
            for (int y = bar.fill_bottom - rows / 2 + 1; y <= bar.fill_bottom; y++) {
                for (int x = bar.fill_left; x <= bar.fill_right; x++) memcpy((uint8_t *)resized.pixels + (size_t)y * resized.stride + (size_t)x * 4, "\xD9\x6B\x2A", 3);
            }
            double level = read_fill(&resized, &bar, &color);
            if (fabs(level - 50) > 2) printf("At %.2f times the size, half the mana bar read %.1f%%.\n", factors[f], level);
            CHECK(fabs(level - 50) <= 2 && color == 0x2A6BD9);
        }
        free((void *)resized.pixels);
    }
}

/* The backpack open in a 971 by 552 window: rows of 13, 13, and 1 slots, 54 pixels wide. */
static void test_backpack(void) {
    struct image shot;
    static struct slot slots[BACKPACK_SLOTS];
    if (!load_bmp("fixtures/backpack.bmp", &shot)) {
        CHECK(!"fixtures/backpack.bmp loads");
        return;
    }
    int count = find_backpack(&shot, shot.height, 0, slots);
    CHECK(count == 27);
    CHECK(find_backpack(&shot, shot.height, 54, slots) == 27);
    CHECK(find_backpack(&shot, shot.height, 30, slots) == 0);
    CHECK(find_backpack(&shot, 150, 54, slots) == 26);
    count = find_backpack(&shot, shot.height, 54, slots);
    for (int i = 0; i < count; i++) {
        int row = i / 13, column = i % 13;
        CHECK(slots[i].right - slots[i].left + 1 == 54);
        CHECK(slots[i].left == 21 + column * 70 && slots[i].top > 15 + row * 70 && slots[i].top < 30 + row * 70);
    }
    struct slot bar[HOTBAR_SLOTS];
    CHECK(find_hotbar(&shot, bar) == 12 && bar[0].top > 70);
#ifdef _WIN32
    static const char *const names[] = {"Triple Strike", "Idol of the Forgotten", "Scroll of Viribus", "Sagitta Sol"};
    static const int at[] = {2, 15, 26, 5};
    for (int i = 0; i < 4 && ocr_start(); i++) {
        char text[128] = "";
        ocr_read(&shot, &slots[at[i]], 141, text, sizeof text);
        CHECK(match_lines(text, names, 4) == i);
    }
#endif
    free((void *)shot.pixels);
}

static void test_names(void) {
    static const char *const names[] = {"Skewer", "Spear", "Fisherman's Trap", "Igelti", "Ignis", "Gate"};
    CHECK(match_name("Skewer", names, 6) == 0);
    CHECK(match_name("SKEWER", names, 6) == 0);
    CHECK(match_name("Skewcr", names, 6) == 0);
    CHECK(match_name("2isherman s Trap", names, 6) == 2);
    CHECK(match_name("lgelti", names, 6) == 3);
    CHECK(match_name("I gnis", names, 6) == 4);
    CHECK(match_name("Igni", names, 6) == 4);
    CHECK(match_name("Ig", names, 6) == -1);
    CHECK(match_name("Sagitta Sol", names, 6) == -1);
    CHECK(match_name("Sword", names, 6) == -1);
    CHECK(match_name("", names, 6) == -1);
    CHECK(match_name("--", names, 6) == -1);
    CHECK(match_lines("Gale\nGate\n", (const char *const[]){"Gate"}, 1) == 0);
    CHECK(match_lines("Skewer\n", (const char *const[]){"Gate"}, 1) == -1);
    CHECK(match_lines("", (const char *const[]){"Gate"}, 1) == -1);
    CHECK(match_name("Tenris", (const char *const[]){"Tenebris", "Telorum"}, 2) == 0);
    CHECK(match_name(": ishman s Trap", names, 6) == 2);
    CHECK(match_name("Gale", names, 6) == 5);
    CHECK(match_name("Gl", names, 6) == -1);
    CHECK(letter_count("H o\n,\n") == 2);
}


#define SOUND_RATE 48000
static float sound[SOUND_RATE * 3];

/* Adds a sine tone to `sound`, from and for a number of seconds, fading in and out over 5 ms. */
static void tone(double from, double seconds, double frequency, double amplitude) {
    int start = (int)(from * SOUND_RATE), length = (int)(seconds * SOUND_RATE), fade = SOUND_RATE / 200;
    for (int i = 0; i < length; i++) {
        double edge = i < fade ? (double)i / fade : length - i < fade ? (double)(length - i) / fade : 1;
        sound[start + i] += (float)(amplitude * edge * sin(2 * 3.14159265358979 * frequency * i / SOUND_RATE));
    }
}

/* Feeds `sound` to the chime detector in 10 ms pieces, as capture delivers it, and returns how many it heard. */
static int chimes(void) {
    struct ding ding;
    int heard = 0;
    ding_reset(&ding);
    for (int i = 0; i < SOUND_RATE * 3; i += SOUND_RATE / 100) heard += ding_feed(&ding, sound + i, SOUND_RATE / 100, SOUND_RATE);
    return heard;
}

/* Adds a short burst shaped like the recorded cast sound: a tone in the middle of each band, as loud as the band. */
static void burst(double from) {
    double edges[CAST_BANDS + 1];
    cast_band_edges(SOUND_RATE, edges);
    int start = (int)(from * SOUND_RATE), length = SOUND_RATE / 25;
    for (int band = 0; band < CAST_BANDS; band++) {
        double frequency = sqrt(edges[band] * edges[band + 1]);
        for (int i = 0; i < length; i++) {
            double decay = exp(-6.0 * i / length);
            sound[start + i] += (float)(0.2 * CAST_TEMPLATE[band] * decay * sin(2 * 3.14159265358979 * frequency * i / SOUND_RATE));
        }
    }
}

static int casts(double *score) {
    struct cast_sound cast;
    int heard = 0;
    cast_sound_reset(&cast, CAST_MATCH);
    for (int i = 0; i < SOUND_RATE * 3; i += SOUND_RATE / 100) heard += cast_sound_feed(&cast, sound + i, SOUND_RATE / 100, SOUND_RATE);
    *score = cast.score;
    return heard;
}

static void test_sound(void) {
    double score;
    memset(sound, 0, sizeof sound);
    CHECK(chimes() == 0);
    /* The chime: the low tone, then the high one. */
    tone(0.5, 0.1, 3200, 0.3);
    tone(0.6, 0.15, 4800, 0.3);
    CHECK(chimes() == 1);
    /* Quiet chimes count too, and a second one after the echo window. */
    memset(sound, 0, sizeof sound);
    tone(0.5, 0.1, 3200, 0.03);
    tone(0.6, 0.15, 4800, 0.03);
    tone(1.6, 0.1, 3200, 0.3);
    tone(1.7, 0.15, 4800, 0.3);
    CHECK(chimes() == 2);
    /* Only the high tone, the tones the other way round, or a tone too long after isn't the chime. */
    memset(sound, 0, sizeof sound);
    tone(0.6, 0.15, 4800, 0.3);
    CHECK(chimes() == 0);
    memset(sound, 0, sizeof sound);
    tone(0.5, 0.1, 4800, 0.3);
    tone(0.65, 0.1, 3200, 0.3);
    CHECK(chimes() == 0);
    memset(sound, 0, sizeof sound);
    tone(0.5, 0.1, 3200, 0.3);
    tone(1.2, 0.1, 4800, 0.3);
    CHECK(chimes() == 0);
    /* Both tones under loud noise across the spectrum don't stand out, so it isn't heard. */
    memset(sound, 0, sizeof sound);
    srand(1);
    for (int i = 0; i < SOUND_RATE * 3; i++) sound[i] = (float)(rand() / (double)RAND_MAX - 0.5);
    tone(0.5, 0.1, 3200, 0.01);
    tone(0.6, 0.15, 4800, 0.01);
    CHECK(chimes() == 0);

    /* A cast's burst after quiet is heard, once per burst. */
    memset(sound, 0, sizeof sound);
    CHECK(casts(&score) == 0);
    burst(0.5);
    burst(1.5);
    CHECK(casts(&score) == 2 && score >= CAST_MATCH);
    /* A burst of another shape isn't. */
    memset(sound, 0, sizeof sound);
    tone(0.5, 0.04, 2000, 0.3);
    CHECK(casts(&score) == 0 && score < CAST_MATCH);
}

int main(int argc, char **argv) {
    if (argc > 1) return print_names(argc - 1, argv + 1);
    struct bar bar;
    scene(SAND);
    CHECK(!find_bar(&image, &bar));
    scene(0x777777);
    CHECK(!find_bar(&image, &bar));
    test_bar(30, 200, 24, 250);
    test_bar(60, 120, 46, 480);
    test_bar(900, 10, 74, 700);
    frame_color = BRIGHT_FRAME, empty_color = BRIGHT_EMPTY;
    test_bar(60, 120, 46, 480);
    frame_color = FRAME, empty_color = EMPTY;

    scene(SAND);
    CHECK(!find_prompt(&image, NULL));
    scene(0x86796A);
    CHECK(!find_prompt(&image, NULL));
    for (int height = 16; height <= 64; height *= 2) {
        scene(SAND);
        draw_prompt(640, 300, height, 1);
        struct box box;
        CHECK(find_prompt(&image, &box) && box.left == 640 - height * 3 && box.right == 640 + height * 3 && box.top == 300 &&
              box.bottom == 300 + height - 1);
        scene(0x20303A);
        draw_prompt(400, 500, height, 1);
        CHECK(find_prompt(&image, NULL));
        scene(SAND);
        draw_prompt(640, 300, height, 0);
        CHECK(!find_prompt(&image, NULL));
    }

    /* At 30% a second, mana moves 13.5% in 0.45 seconds. A cast drains a fraction of that. */
    CHECK(is_cast(60, 59, 0.45, 30));
    CHECK(is_cast(60, 60, 0.45, 30));
    CHECK(!is_cast(60, 46.5, 0.45, 30));
    CHECK(!is_cast(60, 73.5, 0.45, 30));
    CHECK(!is_cast(60, 59, 0.45, 0));
    CHECK(is_cast(60, 59.5, 0.45, 5));
    CHECK(!is_cast(60, 57.7, 0.45, 5));

    /*
     * The prompt appears a round trip after the click. Then the cast is confirmed after three
     * mana checks, 150 ms apart, while Gate stays equipped.
     */
    struct cast cast = {.held = 1};
    CHECK(judge_cast(&cast, 70, 16, 1, 0, 30) == 0);
    CHECK(judge_cast(&cast, 66, 180, 1, 0, 30) == 0);
    CHECK(judge_cast(&cast, 64, 250, 1, 1, 30) == 0);
    CHECK(judge_cast(&cast, 63.8, 400, 1, 0, 30) == 0);
    CHECK(judge_cast(&cast, 63.6, 550, 1, 0, 30) == 0);
    CHECK(judge_cast(&cast, 63.4, 700, 1, 0, 30) == 1);
    /* No prompt within a second means it wasn't a cast. */
    cast = (struct cast){.held = 1};
    CHECK(judge_cast(&cast, 60, 990, 1, 0, 30) == 0);
    CHECK(judge_cast(&cast, 60, 1000, 1, 0, 30) == CAST_NO_PROMPT);
    /* Putting Gate away at any point ends it, and so does a hotbar that can no longer tell. */
    cast = (struct cast){.held = 1};
    CHECK(judge_cast(&cast, 60, 100, 1, 0, 30) == 0);
    CHECK(judge_cast(&cast, 60, 120, 0, 0, 30) == CAST_PUT_AWAY);
    cast = (struct cast){.held = 1};
    CHECK(judge_cast(&cast, 60, 200, 1, 1, 30) == 0);
    CHECK(judge_cast(&cast, 60, 220, -1, 0, 30) == CAST_PUT_AWAY);
    /* Without a hotbar reading, only a later reading of another slot ends it. */
    cast = (struct cast){.held = -1};
    CHECK(judge_cast(&cast, 60, 200, -1, 1, 30) == 0);
    CHECK(judge_cast(&cast, 60, 220, 0, 1, 30) == CAST_PUT_AWAY);
    /* Filling at the full rate after the prompt, as while turning the camera, fails the first check. */
    cast = (struct cast){.held = 1};
    CHECK(judge_cast(&cast, 60, 200, 1, 1, 30) == 0);
    CHECK(judge_cast(&cast, 64.5, 350, 1, 1, 30) == CAST_MANA);
    /* So does draining at the full rate, at the last check. */
    cast = (struct cast){.held = 1};
    CHECK(judge_cast(&cast, 60, 200, 1, 1, 30) == 0);
    CHECK(judge_cast(&cast, 59, 350, 1, 1, 30) == 0);
    CHECK(judge_cast(&cast, 58, 500, 1, 1, 30) == 0);
    CHECK(judge_cast(&cast, 46.5, 650, 1, 1, 30) == CAST_MANA);

    CHECK(zone_color(0xEF4444, 0xE04040) != 0xEF4444);
    CHECK(zone_color(0xEF4444, 0x2A6BD9) == 0xEF4444);
    CHECK(zone_color(0x202020, 0x151515) > 0x202020);
    CHECK(zone_color(0xF0F0F0, 0xF2F2F2) < 0xF0F0F0);

    /* Snap training casts in the middle of a range, and charges when mana falls below it. */
    double low, high;
    train_band(75, 85, 60, &low, &high);
    CHECK(fabs(low - 77) < 0.01 && fabs(high - 83) < 0.01);
    train_band(75, 85, 100, &low, &high);
    CHECK(fabs(low - 75) < 0.01 && fabs(high - 85) < 0.01);
    train_band(50, 52, 60, &low, &high);
    CHECK(fabs(low - 49.5) < 0.01 && fabs(high - 52.5) < 0.01);
    CHECK(train_start(70, 78) == TRAIN_CHARGE && train_start(80, 78) == TRAIN_CAST && train_start(90, 78) == TRAIN_CAST);
    CHECK(train_next(TRAIN_CHARGE, 81, 78, 82, 100, 0) == TRAIN_CHARGE);
    CHECK(train_next(TRAIN_CHARGE, 82, 78, 82, 100, 0) == TRAIN_CAST);
    CHECK(train_next(TRAIN_CHARGE, 70, 78, 82, 100, 1) == TRAIN_CAST);
    CHECK(train_next(TRAIN_CHARGE, 60, 78, 82, TRAIN_CHARGE_MAX_MS, 0) == TRAIN_CAST);
    CHECK(train_next(TRAIN_CAST, 78, 78, 82, 5000, 0) == TRAIN_CAST);
    CHECK(train_next(TRAIN_CAST, 77.9, 78, 82, 5000, 0) == TRAIN_RECOVER);
    CHECK(train_next(TRAIN_RECOVER, 70, 78, 82, TRAIN_RECOVER_MS - 1, 0) == TRAIN_RECOVER);
    CHECK(train_next(TRAIN_RECOVER, 70, 78, 82, TRAIN_RECOVER_MS, 0) == TRAIN_CHARGE);

    /* A weapon picks each step's item before every anvil click, then hammers once. */
    struct smith_action actions[SMITH_ACTIONS];
    int slots[] = {2, 5}, clicks[] = {2, 1};
    int count = smith_actions(slots, clicks, 2, actions);
    CHECK(count == 7);
    CHECK(actions[0].kind == SMITH_PICK && actions[0].slot == 2 && actions[1].kind == SMITH_ANVIL);
    CHECK(actions[2].kind == SMITH_PICK && actions[2].slot == 2 && actions[3].kind == SMITH_ANVIL);
    CHECK(actions[4].kind == SMITH_PICK && actions[4].slot == 5 && actions[5].kind == SMITH_ANVIL);
    CHECK(actions[6].kind == SMITH_HAMMER);
    int many[SMITH_STEPS + 2] = {0}, most[SMITH_STEPS + 2];
    for (int i = 0; i < SMITH_STEPS + 2; i++) most[i] = 99;
    CHECK(smith_actions(many, most, SMITH_STEPS + 2, actions) == SMITH_ACTIONS);

    test_sound();
    test_hotbar();
    test_mana();
    test_names();
    test_backpack();

    printf(failures ? "%d checks failed\n" : "All checks passed\n", failures);
    return failures != 0;
}
