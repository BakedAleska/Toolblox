/*
 * Windows.Media.Ocr from C. MinGW has no header for it, so each method is called by its position
 * in the interface's table, as declared in the Windows SDK's windows.media.ocr.h,
 * windows.graphics.imaging.h, windows.foundation.h, asyncinfo.h, and memorybuffer.h.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <roapi.h>
#include <winstring.h>
#include <string.h>

#include "ocr.h"

/* Every interface here starts with IUnknown, then IInspectable's three methods. */
#define METHOD(object, index) ((*(void ***)(object))[index])
#define FIRST_OWN 6
#define READ_TIMEOUT_MS 3000
/* The padding around the interior, as a share of its height. */
#define PADDING 0.25

typedef HRESULT(WINAPI *query_fn)(void *, REFIID, void **);
typedef ULONG(WINAPI *release_fn)(void *);
typedef HRESULT(WINAPI *get_fn)(void *, void **);
typedef HRESULT(WINAPI *recognize_fn)(void *, void *, void **);
typedef HRESULT(WINAPI *create_fn)(void *, int, int, int, int, void **);
typedef HRESULT(WINAPI *lock_fn)(void *, int, void **);
typedef HRESULT(WINAPI *status_fn)(void *, int *);
typedef HRESULT(WINAPI *bytes_fn)(void *, BYTE **, UINT32 *);

struct plane {
    INT32 start, width, height, stride;
};
typedef HRESULT(WINAPI *plane_fn)(void *, int, struct plane *);

/* IOcrEngineStatics, ISoftwareBitmapFactory, IMemoryBuffer, IMemoryBufferByteAccess, and IAsyncInfo. */
static const GUID OCR_STATICS = {0x5bffa85a, 0x3384, 0x3540, {0x99, 0x40, 0x69, 0x91, 0x20, 0xd4, 0x28, 0xa8}};
static const GUID BITMAP_FACTORY = {0xc99feb69, 0x2d62, 0x4d47, {0xa6, 0xb3, 0x4f, 0xdb, 0x6a, 0x07, 0xfd, 0xf8}};
static const GUID MEMORY_BUFFER = {0xfbc4dd2a, 0x245b, 0x11e4, {0xaf, 0x98, 0x68, 0x94, 0x23, 0x26, 0x0c, 0xf8}};
static const GUID BYTE_ACCESS = {0x5b0d3235, 0x4dba, 0x4d44, {0x86, 0x5e, 0x8f, 0x1d, 0x0e, 0x4f, 0xd0, 0x4d}};
static const GUID ASYNC_INFO = {0x00000036, 0x0000, 0x0000, {0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46}};
enum { STATICS_TRY_CREATE_FROM_USER = FIRST_OWN + 4, FACTORY_CREATE_WITH_ALPHA = FIRST_OWN + 1,
       BITMAP_LOCK = FIRST_OWN + 9, BUFFER_PLANE = FIRST_OWN + 1, MEMORY_REFERENCE = FIRST_OWN,
       BYTES_GET = 3, ENGINE_RECOGNIZE = FIRST_OWN, ASYNC_STATUS = FIRST_OWN + 1, OPERATION_RESULTS = FIRST_OWN + 2,
       RESULT_TEXT = FIRST_OWN + 2 };
enum { FORMAT_BGRA8 = 87, ALPHA_IGNORE = 2, ACCESS_WRITE = 2, STATUS_STARTED = 0, STATUS_COMPLETED = 1 };

static void *engine, *bitmaps;

static void release(void *object) {
    if (object) ((release_fn)METHOD(object, 2))(object);
}

static void *query(void *object, const GUID *iid) {
    void *result = NULL;
    if (object) ((query_fn)METHOD(object, 0))(object, iid, &result);
    return result;
}

static void *factory(const wchar_t *name, const GUID *iid) {
    HSTRING string;
    void *result = NULL;
    if (FAILED(WindowsCreateString(name, (UINT32)wcslen(name), &string))) return NULL;
    if (FAILED(RoGetActivationFactory(string, iid, &result))) result = NULL;
    WindowsDeleteString(string);
    return result;
}

int ocr_start(void) {
    HRESULT started = RoInitialize(RO_INIT_MULTITHREADED);
    if (FAILED(started) && started != RPC_E_CHANGED_MODE) return 0;
    void *statics = factory(L"Windows.Media.Ocr.OcrEngine", &OCR_STATICS);
    if (statics) ((get_fn)METHOD(statics, STATICS_TRY_CREATE_FROM_USER))(statics, &engine);
    release(statics);
    bitmaps = factory(L"Windows.Graphics.Imaging.SoftwareBitmap", &BITMAP_FACTORY);
    return engine && bitmaps;
}

/* Catmull-Rom weights for the four samples around a point `t` of the way between the middle two. */
static void weights(double t, double w[4]) {
    double t2 = t * t, t3 = t2 * t;
    w[0] = (-t3 + 2 * t2 - t) / 2;
    w[1] = (3 * t3 - 5 * t2 + 2) / 2;
    w[2] = (-3 * t3 + 4 * t2 + t) / 2;
    w[3] = (t3 - t2) / 2;
}

static int clamp(int value, int size) {
    return value < 0 ? 0 : value >= size ? size - 1 : value;
}

/* Fills a BGRA bitmap with the interior resized by bicubic sampling, which keeps small letters sharp, surrounded by its background. */
static void paint(BYTE *bytes, const struct plane *plane, const struct image *image, const struct slot *interior, double scale, int pad) {
    const uint8_t *background = image->pixels + (size_t)interior->top * image->stride +
                                (size_t)(interior->left + (interior->right - interior->left) / 4) * 4;
    int width = interior->right - interior->left + 1, height = interior->bottom - interior->top + 1;
    for (int y = 0; y < plane->height; y++) {
        BYTE *row = bytes + plane->start + (size_t)y * plane->stride;
        for (int x = 0; x < plane->width; x++) {
            double sx = (x - pad + 0.5) / scale - 0.5, sy = (y - pad + 0.5) / scale - 0.5;
            BYTE *out = row + x * 4;
            if (sx < 0 || sy < 0 || sx > width - 1 || sy > height - 1) {
                memcpy(out, background, 3);
            } else {
                int x0 = (int)sx, y0 = (int)sy;
                double wx[4], wy[4], sum[3] = {0, 0, 0};
                weights(sx - x0, wx);
                weights(sy - y0, wy);
                for (int j = 0; j < 4; j++) {
                    int py = clamp(y0 - 1 + j, height);
                    for (int i = 0; i < 4; i++) {
                        const uint8_t *p = image->pixels + (size_t)(interior->top + py) * image->stride +
                                           (size_t)(interior->left + clamp(x0 - 1 + i, width)) * 4;
                        for (int k = 0; k < 3; k++) sum[k] += p[k] * wx[i] * wy[j];
                    }
                }
                for (int k = 0; k < 3; k++) out[k] = (BYTE)(sum[k] < 0 ? 0 : sum[k] > 255 ? 255 : sum[k] + 0.5);
            }
            out[3] = 255;
        }
    }
}

/* Creates a bitmap of the resized interior. The buffer must be released before the engine reads it. */
static void *create_bitmap(const struct image *image, const struct slot *interior, int target) {
    double scale = (double)target / (interior->bottom - interior->top + 1);
    int pad = (int)(target * PADDING + 0.5);
    int width = (int)((interior->right - interior->left + 1) * scale + 0.5) + pad * 2, height = target + pad * 2;
    void *bitmap = NULL, *buffer = NULL, *memory, *reference = NULL, *access;
    BYTE *bytes = NULL;
    UINT32 capacity = 0;
    struct plane plane;
    if (FAILED(((create_fn)METHOD(bitmaps, FACTORY_CREATE_WITH_ALPHA))(bitmaps, FORMAT_BGRA8, width, height, ALPHA_IGNORE, &bitmap))) return NULL;
    int ok = SUCCEEDED(((lock_fn)METHOD(bitmap, BITMAP_LOCK))(bitmap, ACCESS_WRITE, &buffer)) &&
             SUCCEEDED(((plane_fn)METHOD(buffer, BUFFER_PLANE))(buffer, 0, &plane));
    memory = ok ? query(buffer, &MEMORY_BUFFER) : NULL;
    if (memory && FAILED(((get_fn)METHOD(memory, MEMORY_REFERENCE))(memory, &reference))) reference = NULL;
    access = query(reference, &BYTE_ACCESS);
    ok = access && SUCCEEDED(((bytes_fn)METHOD(access, BYTES_GET))(access, &bytes, &capacity)) &&
         plane.width == width && plane.height == height && (UINT32)plane.start + (UINT32)plane.stride * (UINT32)height <= capacity;
    if (ok) paint(bytes, &plane, image, interior, scale, pad);
    release(access);
    release(reference);
    release(memory);
    release(buffer);
    if (!ok) {
        release(bitmap);
        return NULL;
    }
    return bitmap;
}

int ocr_read(const struct image *image, const struct slot *interior, int height, char *text, size_t size) {
    void *bitmap, *operation = NULL, *info, *result = NULL;
    HSTRING string = NULL;
    int status = STATUS_STARTED, ok = 0;
    if (!engine || !bitmaps || !size || !(bitmap = create_bitmap(image, interior, height))) return 0;
    *text = 0;
    if (SUCCEEDED(((recognize_fn)METHOD(engine, ENGINE_RECOGNIZE))(engine, bitmap, &operation)) && (info = query(operation, &ASYNC_INFO))) {
        for (DWORD waited = 0; waited < READ_TIMEOUT_MS && SUCCEEDED(((status_fn)METHOD(info, ASYNC_STATUS))(info, &status)) &&
                               status == STATUS_STARTED; waited++) {
            Sleep(1);
        }
        release(info);
        if (status == STATUS_COMPLETED && SUCCEEDED(((get_fn)METHOD(operation, OPERATION_RESULTS))(operation, &result)) && result &&
            SUCCEEDED(((get_fn)METHOD(result, RESULT_TEXT))(result, (void **)&string))) {
            UINT32 length = 0;
            const wchar_t *characters = WindowsGetStringRawBuffer(string, &length);
            size_t used = 0;
            for (UINT32 i = 0; i < length && used + 1 < size; i++) {
                if (characters[i] >= 32 && characters[i] < 127) text[used++] = (char)characters[i];
            }
            text[used] = 0;
            WindowsDeleteString(string);
            ok = 1;
        }
    }
    release(result);
    release(operation);
    release(bitmap);
    return ok;
}
