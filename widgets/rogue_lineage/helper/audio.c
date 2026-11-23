/*
 * Process loopback capture for the Rogue Lineage helper. See audio.h.
 *
 * The audio client is activated asynchronously for the virtual process loopback device, with the
 * target process in the activation parameters, then captures 16-bit stereo at AUDIO_RATE, which
 * Windows converts the process's sound to. Each packet is mixed to mono and fed to both detectors.
 */
#define COBJMACROS
#include "audio.h"

#include <initguid.h>
#include <audioclient.h>
#include <mmdeviceapi.h>
#include <stdint.h>

#include "detect.h"

#define AUDIO_RATE 48000
/* The capture buffer's length, in 100-nanosecond units. */
#define AUDIO_BUFFER 200000
#define ACTIVATE_WAIT_MS 5000

/* Activation parameters for process loopback, from audioclientactivationparams.h, which MinGW lacks. */
struct loopback_params {
    DWORD target;
    int mode;
};
struct activation_params {
    int type;
    struct loopback_params loopback;
};
#define ACTIVATION_PROCESS_LOOPBACK 1
#define LOOPBACK_INCLUDE_TREE 0

DEFINE_GUID(LOCAL_IID_IAgileObject, 0x94ea2b94, 0xe9cc, 0x49e0, 0xc0, 0xff, 0xee, 0x64, 0xca, 0x8f, 0x5b, 0x90);
DEFINE_GUID(LOCAL_IID_IAudioClient, 0x1cb9ad4c, 0xdbfa, 0x4c32, 0xb1, 0x78, 0xc2, 0xf5, 0x68, 0xa7, 0x03, 0xb2);
DEFINE_GUID(LOCAL_IID_IAudioCaptureClient, 0xc8adbd64, 0xe71e, 0x48a0, 0xa4, 0xde, 0x18, 0x5c, 0x39, 0x5c, 0xd3, 0x17);
DEFINE_GUID(LOCAL_IID_IActivateAudioInterfaceCompletionHandler, 0x41d949ab, 0x9862, 0x444a, 0x80, 0xf6, 0xc2, 0x61, 0x33, 0x4d, 0xa5, 0xeb);

/* A completion handler that signals an event. It lives on the listening thread's stack until activation ends. */
struct handler {
    IActivateAudioInterfaceCompletionHandler iface;
    HANDLE done;
};

static HRESULT STDMETHODCALLTYPE handler_query(IActivateAudioInterfaceCompletionHandler *self, REFIID id, void **out) {
    if (IsEqualIID(id, &IID_IUnknown) || IsEqualIID(id, &LOCAL_IID_IActivateAudioInterfaceCompletionHandler) ||
        IsEqualIID(id, &LOCAL_IID_IAgileObject)) {
        *out = self;
        return S_OK;
    }
    *out = NULL;
    return E_NOINTERFACE;
}

static ULONG STDMETHODCALLTYPE handler_add_ref(IActivateAudioInterfaceCompletionHandler *self) {
    (void)self;
    return 1;
}

static ULONG STDMETHODCALLTYPE handler_release(IActivateAudioInterfaceCompletionHandler *self) {
    (void)self;
    return 1;
}

static HRESULT STDMETHODCALLTYPE handler_completed(IActivateAudioInterfaceCompletionHandler *self, IActivateAudioInterfaceAsyncOperation *operation) {
    (void)operation;
    SetEvent(((struct handler *)self)->done);
    return S_OK;
}

static IActivateAudioInterfaceCompletionHandlerVtbl handler_table = {handler_query, handler_add_ref, handler_release, handler_completed};

typedef HRESULT(WINAPI *activate_function)(LPCWSTR, REFIID, PROPVARIANT *, IActivateAudioInterfaceCompletionHandler *,
                                            IActivateAudioInterfaceAsyncOperation **);

static HANDLE thread, stop;
static HWND target_window;
static UINT target_message;
static DWORD target_process;

/* Feeds a packet of 16-bit stereo to both detectors and posts what they heard. */
static void listen(const int16_t *frames, UINT32 count, int silent, struct ding *ding, struct cast_sound *cast) {
    float mono[1024];
    while (count) {
        UINT32 part = count < 1024 ? count : 1024;
        for (UINT32 i = 0; i < part; i++) mono[i] = silent ? 0 : (frames[i * 2] + frames[i * 2 + 1]) / 65536.0f;
        for (int heard = ding_feed(ding, mono, (int)part, AUDIO_RATE); heard > 0; heard--) {
            PostMessageW(target_window, target_message, AUDIO_CHIME, 0);
        }
        for (int heard = cast_sound_feed(cast, mono, (int)part, AUDIO_RATE); heard > 0; heard--) {
            PostMessageW(target_window, target_message, AUDIO_CAST, (LPARAM)(cast->score * 1000));
        }
        if (!silent) frames += part * 2;
        count -= part;
    }
}

static DWORD WINAPI capture(void *unused) {
    (void)unused;
    static struct ding ding;
    static struct cast_sound cast;
    struct activation_params params = {ACTIVATION_PROCESS_LOOPBACK, {target_process, LOOPBACK_INCLUDE_TREE}};
    struct handler handler = {{&handler_table}, CreateEventW(NULL, FALSE, FALSE, NULL)};
    HANDLE ready = CreateEventW(NULL, FALSE, FALSE, NULL);
    IActivateAudioInterfaceAsyncOperation *operation = NULL;
    IUnknown *activated = NULL;
    IAudioClient *client = NULL;
    IAudioCaptureClient *reader = NULL;
    HRESULT result = CoInitializeEx(NULL, COINIT_MULTITHREADED);
    int initialized = SUCCEEDED(result);
    activate_function activate = (activate_function)(void *)GetProcAddress(LoadLibraryW(L"mmdevapi.dll"), "ActivateAudioInterfaceAsync");
    PROPVARIANT variant;
    memset(&variant, 0, sizeof variant);
    variant.vt = VT_BLOB;
    variant.blob.cbSize = sizeof params;
    variant.blob.pBlobData = (BYTE *)&params;
    ding_reset(&ding);
    cast_sound_reset(&cast, CAST_MATCH);
    if (!initialized || !handler.done || !ready) goto done;
    result = activate ? activate(L"VAD\\Process_Loopback", &LOCAL_IID_IAudioClient, &variant, &handler.iface, &operation) : E_NOTIMPL;
    if (FAILED(result)) goto done;
    if (WaitForSingleObject(handler.done, ACTIVATE_WAIT_MS) != WAIT_OBJECT_0) {
        result = HRESULT_FROM_WIN32(ERROR_TIMEOUT);
        goto done;
    }
    HRESULT activation = E_FAIL;
    result = IActivateAudioInterfaceAsyncOperation_GetActivateResult(operation, &activation, &activated);
    if (SUCCEEDED(result)) result = activation;
    if (SUCCEEDED(result)) result = IUnknown_QueryInterface(activated, &LOCAL_IID_IAudioClient, (void **)&client);
    if (FAILED(result)) goto done;
    WAVEFORMATEX format = {WAVE_FORMAT_PCM, 2, AUDIO_RATE, AUDIO_RATE * 4, 4, 16, 0};
    result = IAudioClient_Initialize(client, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                                     AUDIO_BUFFER, 0, &format, NULL);
    if (SUCCEEDED(result)) result = IAudioClient_SetEventHandle(client, ready);
    if (SUCCEEDED(result)) result = IAudioClient_GetService(client, &LOCAL_IID_IAudioCaptureClient, (void **)&reader);
    if (SUCCEEDED(result)) result = IAudioClient_Start(client);
    if (FAILED(result)) goto done;
    PostMessageW(target_window, target_message, AUDIO_LISTENING, 0);
    HANDLE waits[2] = {stop, ready};
    for (;;) {
        DWORD woke = WaitForMultipleObjects(2, waits, FALSE, 1000);
        if (woke == WAIT_OBJECT_0) {
            result = S_OK;
            break;
        }
        UINT32 frames = 0;
        while (SUCCEEDED(result = IAudioCaptureClient_GetNextPacketSize(reader, &frames)) && frames) {
            BYTE *data;
            DWORD flags;
            result = IAudioCaptureClient_GetBuffer(reader, &data, &frames, &flags, NULL, NULL);
            if (FAILED(result)) break;
            listen((const int16_t *)data, frames, (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0, &ding, &cast);
            IAudioCaptureClient_ReleaseBuffer(reader, frames);
        }
        if (FAILED(result)) break;
    }
    IAudioClient_Stop(client);
done:
    if (reader) IAudioCaptureClient_Release(reader);
    if (client) IAudioClient_Release(client);
    if (activated) IUnknown_Release(activated);
    if (operation) IActivateAudioInterfaceAsyncOperation_Release(operation);
    if (handler.done) CloseHandle(handler.done);
    if (ready) CloseHandle(ready);
    if (initialized) CoUninitialize();
    PostMessageW(target_window, target_message, AUDIO_ENDED, (LPARAM)(SUCCEEDED(result) ? 0 : result));
    return 0;
}

int audio_start(HWND window, UINT message, DWORD process) {
    audio_stop();
    if (!stop) stop = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (!stop) return 0;
    ResetEvent(stop);
    target_window = window;
    target_message = message;
    target_process = process;
    thread = CreateThread(NULL, 0, capture, NULL, 0, NULL);
    return thread != NULL;
}

void audio_stop(void) {
    if (!thread) return;
    SetEvent(stop);
    WaitForSingleObject(thread, 3000);
    CloseHandle(thread);
    thread = NULL;
}
