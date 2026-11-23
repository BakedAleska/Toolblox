/*
 * Windows.Graphics.Capture from C, through the interfaces in MinGW's windows.graphics.capture.h.
 * The frame pool is free-threaded, so frames are taken by polling and no dispatcher queue is needed.
 * Each new frame is copied from the GPU into one buffer, and only while it's asked for.
 */
#define INITGUID
#define COBJMACROS
#define WIDL_using_Windows_Graphics_Capture
#include <windows.h>
#include <d3d11.h>
#include <dwmapi.h>
#include <roapi.h>
#include <winstring.h>
#include <windows.graphics.capture.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.h>
#include <stdlib.h>
#include <string.h>

#include "capture.h"

typedef __x_ABI_CWindows_CGraphics_CCapture_CIGraphicsCaptureItem Item;
typedef __x_ABI_CWindows_CGraphics_CCapture_CIDirect3D11CaptureFramePool Pool;
typedef __x_ABI_CWindows_CGraphics_CCapture_CIDirect3D11CaptureFramePoolStatics2 PoolStatics;
typedef __x_ABI_CWindows_CGraphics_CCapture_CIDirect3D11CaptureFrame Frame;
typedef __x_ABI_CWindows_CGraphics_CCapture_CIGraphicsCaptureSession Session;
typedef __x_ABI_CWindows_CGraphics_CCapture_CIGraphicsCaptureSession2 Session2;
typedef __x_ABI_CWindows_CGraphics_CCapture_CIGraphicsCaptureSession3 Session3;
typedef __x_ABI_CWindows_CGraphics_CCapture_CIGraphicsCaptureSessionStatics SessionStatics;
typedef __x_ABI_CWindows_CGraphics_CDirectX_CDirect3D11_CIDirect3DDevice Device;
typedef __x_ABI_CWindows_CGraphics_CDirectX_CDirect3D11_CIDirect3DSurface Surface;
typedef __x_ABI_CWindows_CFoundation_CIClosable Closable;
typedef __x_ABI_CWindows_CGraphics_CSizeInt32 Size;

/* IDirect3DDxgiInterfaceAccess, from the Windows SDK's windows.graphics.directx.direct3d11.interop.h, which MinGW lacks. */
static const GUID DXGI_ACCESS = {0xa9b3d012, 0x3df2, 0x4ee3, {0xb8, 0xd1, 0x86, 0x95, 0xf4, 0x57, 0xd3, 0xc1}};
typedef struct Access { struct { void *unknown[3]; HRESULT(WINAPI *get_interface)(struct Access *, REFIID, void **); } *lpVtbl; } Access;
HRESULT WINAPI CreateDirect3D11DeviceFromDXGIDevice(IDXGIDevice *device, IInspectable **result);

#define FORMAT_BGRA8 87
#define BUFFERS 2
/* How long the first frame of a new capture is waited for, so a reading isn't skipped. */
#define FIRST_FRAME_MS 200

static ID3D11Device *d3d;
static ID3D11DeviceContext *context;
static Device *device;
static PoolStatics *pools;
static IGraphicsCaptureItemInterop *items;

static HWND captured;
static Item *item;
static Pool *pool;
static Session *session;
static Size pool_size;
static int borderless;

static ID3D11Texture2D *staging;
static UINT staging_width, staging_height;
static uint8_t *pixels_buffer;
static int frame_width, frame_height, have_frame;

static void *factory(const wchar_t *name, const GUID *iid) {
    HSTRING string;
    void *result = NULL;
    if (FAILED(WindowsCreateString(name, (UINT32)wcslen(name), &string))) return NULL;
    if (FAILED(RoGetActivationFactory(string, iid, &result))) result = NULL;
    WindowsDeleteString(string);
    return result;
}

static void close_object(IUnknown *object) {
    Closable *closable = NULL;
    if (!object) return;
    if (SUCCEEDED(IUnknown_QueryInterface(object, &IID___x_ABI_CWindows_CFoundation_CIClosable, (void **)&closable))) {
        __x_ABI_CWindows_CFoundation_CIClosable_Close(closable);
        __x_ABI_CWindows_CFoundation_CIClosable_Release(closable);
    }
    IUnknown_Release(object);
}

int graphics_start(void) {
    HRESULT started = RoInitialize(RO_INIT_MULTITHREADED);
    if (FAILED(started) && started != RPC_E_CHANGED_MODE) return 0;
    SessionStatics *statics = factory(L"Windows.Graphics.Capture.GraphicsCaptureSession", &IID___x_ABI_CWindows_CGraphics_CCapture_CIGraphicsCaptureSessionStatics);
    boolean supported = 0;
    if (!statics) return 0;
    __x_ABI_CWindows_CGraphics_CCapture_CIGraphicsCaptureSessionStatics_IsSupported(statics, &supported);
    __x_ABI_CWindows_CGraphics_CCapture_CIGraphicsCaptureSessionStatics_Release(statics);
    if (!supported) return 0;
    pools = factory(L"Windows.Graphics.Capture.Direct3D11CaptureFramePool", &IID___x_ABI_CWindows_CGraphics_CCapture_CIDirect3D11CaptureFramePoolStatics2);
    items = factory(L"Windows.Graphics.Capture.GraphicsCaptureItem", &IID_IGraphicsCaptureItemInterop);
    if (!pools || !items) return 0;
    if (FAILED(D3D11CreateDevice(NULL, D3D_DRIVER_TYPE_HARDWARE, NULL, D3D11_CREATE_DEVICE_BGRA_SUPPORT, NULL, 0, D3D11_SDK_VERSION, &d3d, NULL, &context))) return 0;
    IDXGIDevice *dxgi = NULL;
    IInspectable *inspectable = NULL;
    if (FAILED(ID3D11Device_QueryInterface(d3d, &IID_IDXGIDevice, (void **)&dxgi))) return 0;
    HRESULT made = CreateDirect3D11DeviceFromDXGIDevice(dxgi, &inspectable);
    IDXGIDevice_Release(dxgi);
    if (FAILED(made)) return 0;
    made = IInspectable_QueryInterface(inspectable, &IID___x_ABI_CWindows_CGraphics_CDirectX_CDirect3D11_CIDirect3DDevice, (void **)&device);
    IInspectable_Release(inspectable);
    return SUCCEEDED(made);
}

void graphics_stop(void) {
    if (session) close_object((IUnknown *)session);
    if (pool) close_object((IUnknown *)pool);
    if (item) __x_ABI_CWindows_CGraphics_CCapture_CIGraphicsCaptureItem_Release(item);
    session = NULL;
    pool = NULL;
    item = NULL;
    captured = NULL;
    have_frame = 0;
}

int graphics_borderless(void) {
    return borderless;
}

static int begin(HWND window) {
    graphics_stop();
    if (FAILED(IGraphicsCaptureItemInterop_CreateForWindow(items, window, &IID___x_ABI_CWindows_CGraphics_CCapture_CIGraphicsCaptureItem, (void **)&item))) {
        item = NULL;
        return 0;
    }
    __x_ABI_CWindows_CGraphics_CCapture_CIGraphicsCaptureItem_get_Size(item, &pool_size);
    if (FAILED(__x_ABI_CWindows_CGraphics_CCapture_CIDirect3D11CaptureFramePoolStatics2_CreateFreeThreaded(pools, device, FORMAT_BGRA8, BUFFERS, pool_size, &pool)) ||
        FAILED(__x_ABI_CWindows_CGraphics_CCapture_CIDirect3D11CaptureFramePool_CreateCaptureSession(pool, item, &session))) {
        graphics_stop();
        return 0;
    }
    Session2 *cursor = NULL;
    Session3 *border = NULL;
    if (SUCCEEDED(__x_ABI_CWindows_CGraphics_CCapture_CIGraphicsCaptureSession_QueryInterface(session, &IID___x_ABI_CWindows_CGraphics_CCapture_CIGraphicsCaptureSession2, (void **)&cursor))) {
        __x_ABI_CWindows_CGraphics_CCapture_CIGraphicsCaptureSession2_put_IsCursorCaptureEnabled(cursor, 0);
        __x_ABI_CWindows_CGraphics_CCapture_CIGraphicsCaptureSession2_Release(cursor);
    }
    borderless = 0;
    if (SUCCEEDED(__x_ABI_CWindows_CGraphics_CCapture_CIGraphicsCaptureSession_QueryInterface(session, &IID___x_ABI_CWindows_CGraphics_CCapture_CIGraphicsCaptureSession3, (void **)&border))) {
        borderless = SUCCEEDED(__x_ABI_CWindows_CGraphics_CCapture_CIGraphicsCaptureSession3_put_IsBorderRequired(border, 0));
        __x_ABI_CWindows_CGraphics_CCapture_CIGraphicsCaptureSession3_Release(border);
    }
    if (FAILED(__x_ABI_CWindows_CGraphics_CCapture_CIGraphicsCaptureSession_StartCapture(session))) {
        graphics_stop();
        return 0;
    }
    captured = window;
    return 1;
}

/* Copies a frame's texture into the pixel buffer. */
static int take(Frame *frame) {
    Surface *surface = NULL;
    Access *access = NULL;
    ID3D11Texture2D *texture = NULL;
    Size size;
    int ok = 0;
    __x_ABI_CWindows_CGraphics_CCapture_CIDirect3D11CaptureFrame_get_ContentSize(frame, &size);
    if (size.Width != pool_size.Width || size.Height != pool_size.Height) {
        /* The window was resized: later frames come at the new size. */
        pool_size = size;
        __x_ABI_CWindows_CGraphics_CCapture_CIDirect3D11CaptureFramePool_Recreate(pool, device, FORMAT_BGRA8, BUFFERS, size);
        return 0;
    }
    if (FAILED(__x_ABI_CWindows_CGraphics_CCapture_CIDirect3D11CaptureFrame_get_Surface(frame, &surface))) return 0;
    if (SUCCEEDED(IUnknown_QueryInterface((IUnknown *)surface, &DXGI_ACCESS, (void **)&access)) &&
        SUCCEEDED(access->lpVtbl->get_interface(access, &IID_ID3D11Texture2D, (void **)&texture))) {
        D3D11_TEXTURE2D_DESC description;
        ID3D11Texture2D_GetDesc(texture, &description);
        if (!staging || description.Width != staging_width || description.Height != staging_height) {
            if (staging) ID3D11Texture2D_Release(staging);
            staging = NULL;
            uint8_t *grown = realloc(pixels_buffer, (size_t)description.Width * description.Height * 4);
            if (grown) pixels_buffer = grown;
            description.Usage = D3D11_USAGE_STAGING;
            description.BindFlags = 0;
            description.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
            description.MiscFlags = 0;
            if (grown && SUCCEEDED(ID3D11Device_CreateTexture2D(d3d, &description, NULL, &staging))) {
                staging_width = description.Width;
                staging_height = description.Height;
            } else {
                staging = NULL;
            }
        }
        D3D11_MAPPED_SUBRESOURCE mapped;
        if (staging) {
            ID3D11DeviceContext_CopyResource(context, (ID3D11Resource *)staging, (ID3D11Resource *)texture);
            if (SUCCEEDED(ID3D11DeviceContext_Map(context, (ID3D11Resource *)staging, 0, D3D11_MAP_READ, 0, &mapped))) {
                int width = size.Width < (INT32)staging_width ? size.Width : (int)staging_width;
                int height = size.Height < (INT32)staging_height ? size.Height : (int)staging_height;
                for (int row = 0; row < height; row++)
                    memcpy(pixels_buffer + (size_t)row * staging_width * 4, (uint8_t *)mapped.pData + (size_t)row * mapped.RowPitch, (size_t)width * 4);
                ID3D11DeviceContext_Unmap(context, (ID3D11Resource *)staging, 0);
                frame_width = width;
                frame_height = height;
                ok = 1;
            }
        }
    }
    if (texture) ID3D11Texture2D_Release(texture);
    if (access) IUnknown_Release((IUnknown *)access);
    __x_ABI_CWindows_CGraphics_CDirectX_CDirect3D11_CIDirect3DSurface_Release(surface);
    return ok;
}

/* Takes the newest frame waiting in the pool, if any, and closes the rest. */
static int drain(void) {
    Frame *newest = NULL, *frame = NULL;
    while (SUCCEEDED(__x_ABI_CWindows_CGraphics_CCapture_CIDirect3D11CaptureFramePool_TryGetNextFrame(pool, &frame)) && frame) {
        if (newest) close_object((IUnknown *)newest);
        newest = frame;
        frame = NULL;
    }
    if (!newest) return 0;
    int ok = take(newest);
    close_object((IUnknown *)newest);
    return ok;
}

int graphics_frame(HWND window, const uint8_t **pixels, int *width, int *height, int *stride) {
    if (!device || !window) return 0;
    if (window != captured) {
        if (!begin(window)) return 0;
        for (ULONGLONG until = GetTickCount64() + FIRST_FRAME_MS; !have_frame && GetTickCount64() < until; Sleep(5)) have_frame = drain();
    } else if (drain()) {
        have_frame = 1;
    }
    if (!have_frame) return 0;
    /* The frame covers the window's visible bounds; the client area starts inside them. */
    RECT bounds;
    POINT origin = {0, 0};
    RECT client;
    if (FAILED(DwmGetWindowAttribute(window, DWMWA_EXTENDED_FRAME_BOUNDS, &bounds, sizeof bounds)) || !ClientToScreen(window, &origin) || !GetClientRect(window, &client)) return 0;
    int left = origin.x - bounds.left, top = origin.y - bounds.top;
    if (left < 0) left = 0;
    if (top < 0) top = 0;
    int visible_width = frame_width - left, visible_height = frame_height - top;
    *width = client.right < visible_width ? client.right : visible_width;
    *height = client.bottom < visible_height ? client.bottom : visible_height;
    if (*width < 1 || *height < 1) return 0;
    *stride = (int)staging_width * 4;
    *pixels = pixels_buffer + (size_t)top * *stride + (size_t)left * 4;
    return 1;
}
