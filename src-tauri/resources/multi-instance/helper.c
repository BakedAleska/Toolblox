/*
 * multi_instance_helper: closes any ROBLOX_singletonEvent handle held by a
 * running RobloxPlayerBeta.exe process, so the next instance launched
 * doesn't see it, doesn't believe an instance is already running, and
 * doesn't refuse to start / activate the existing window instead.
 *
 * Roblox enforces single-instance on Windows by creating a named event
 * object (ROBLOX_singletonEvent) on launch and bailing out if it already
 * exists. That object is destroyed by the OS once nothing holds a handle
 * to it, so this closes the handle the *already-running* client holds,
 * right before Toolblox launches another account's session. This is the
 * same category of technique used by several existing, widely used
 * open-source Roblox multi-instance tools (e.g. Bloxstrap's multi-instance
 * launching), confirmed here by dumping RobloxPlayerBeta.exe's actual
 * handle table rather than assumed from prior art (some of which refers
 * to a "ROBLOX_singletonMutex" instead; the live handle table on the
 * client versions tested showed an Event by this name, not a Mutant).
 *
 * Only the process ids passed on the command line are touched (decimal
 * pids, space-separated) - see toolblox/roblox/multi_instance.py, which
 * only ever passes pids it hasn't already cleared in a previous call.
 * Earlier versions of this helper self-discovered and closed the handle
 * for *every* running RobloxPlayerBeta.exe process on every single call,
 * including ones that had already been cleared by a previous join. That
 * repeatedly yanks a live handle out from under an already-running,
 * already-stable instance for no benefit (its handle was already gone),
 * and is suspected of contributing to the "closing one account closes
 * the others" report: Roblox appears to keep its own wait tied to this
 * same event for cross-instance signaling, and force-closing that handle
 * out from under an in-flight wait, over and over, is exactly the kind
 * of thing that can misbehave. Bloxstrap - a much more mature project
 * using the same category of technique - has open, unresolved issues with
 * this identical symptom, so this is treated as a mitigation (touch each
 * process once, not repeatedly), not a full fix; the underlying fragility
 * is believed to live in Roblox's own client, outside our control.
 *
 * Implementation notes:
 * - NtQuerySystemInformation / NtQueryObject are undocumented NT internals
 *   without a stable public header, so their prototypes and the handle-
 *   table struct layout are declared here directly (this layout has been
 *   stable across Windows versions and is what tools like Sysinternals
 *   Handle.exe / Process Hacker rely on).
 * - Only handles owned by RobloxPlayerBeta.exe processes are inspected, to
 *   keep this fast and to avoid touching unrelated handles.
 * - NtQueryObject(ObjectNameInformation) is documented to be able to hang
 *   forever on certain handle types (classically, a named pipe waiting for
 *   a client). Every query here runs on its own worker thread with a
 *   timeout, and is simply abandoned (not waited on) if it doesn't return
 *   in time, so one bad handle can't hang the whole helper.
 *
 * Exit code is always 0. This tool is meant to run as a best-effort step
 * before launching Roblox; a failure here should never block the launch
 * itself, so callers should not treat a nonzero exit as fatal (there
 * isn't one, but don't rely on exit codes to mean anything more).
 */

#include <windows.h>
#include <tlhelp32.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>

typedef LONG NTSTATUS;
#define STATUS_SUCCESS ((NTSTATUS)0x00000000L)
#define STATUS_INFO_LENGTH_MISMATCH ((NTSTATUS)0xC0000004L)

typedef struct _UNICODE_STRING {
    USHORT Length;
    USHORT MaximumLength;
    PWSTR Buffer;
} UNICODE_STRING, *PUNICODE_STRING;

typedef struct _SYSTEM_HANDLE_TABLE_ENTRY_INFO {
    USHORT UniqueProcessId;
    USHORT CreatorBackTraceIndex;
    UCHAR ObjectTypeIndex;
    UCHAR HandleAttributes;
    USHORT HandleValue;
    PVOID Object;
    ULONG GrantedAccess;
} SYSTEM_HANDLE_TABLE_ENTRY_INFO, *PSYSTEM_HANDLE_TABLE_ENTRY_INFO;

typedef struct _SYSTEM_HANDLE_INFORMATION {
    ULONG NumberOfHandles;
    SYSTEM_HANDLE_TABLE_ENTRY_INFO Handles[1];
} SYSTEM_HANDLE_INFORMATION, *PSYSTEM_HANDLE_INFORMATION;

typedef struct _OBJECT_NAME_INFORMATION {
    UNICODE_STRING Name;
} OBJECT_NAME_INFORMATION, *POBJECT_NAME_INFORMATION;

#define SystemHandleInformation 16
#define ObjectNameInformation 1

typedef NTSTATUS(NTAPI *NtQuerySystemInformation_t)(
    ULONG SystemInformationClass, PVOID SystemInformation,
    ULONG SystemInformationLength, PULONG ReturnLength);

typedef NTSTATUS(NTAPI *NtQueryObject_t)(
    HANDLE Handle, ULONG ObjectInformationClass, PVOID ObjectInformation,
    ULONG ObjectInformationLength, PULONG ReturnLength);

static NtQuerySystemInformation_t NtQuerySystemInformation;
static NtQueryObject_t NtQueryObject;

static const wchar_t TARGET_PROCESS_NAME[] = L"RobloxPlayerBeta.exe";
static const wchar_t TARGET_OBJECT_SUBSTRING[] = L"ROBLOX_singletonEvent";

/* Args/result for the timeout-guarded NtQueryObject(ObjectNameInformation)
 * call. buffer is fixed-size: object names we care about are short, and a
 * too-small buffer just means "no match", which is fine.
 */
typedef struct _NAME_QUERY_CTX {
    HANDLE handle;
    wchar_t buffer[512];
    BOOL matched;
} NAME_QUERY_CTX;

static DWORD WINAPI query_object_name_thread(LPVOID param) {
    NAME_QUERY_CTX *ctx = (NAME_QUERY_CTX *)param;
    BYTE local_buf[1024];
    ULONG return_length = 0;
    NTSTATUS status = NtQueryObject(
        ctx->handle, ObjectNameInformation, local_buf, sizeof(local_buf), &return_length);
    if (status == STATUS_SUCCESS) {
        POBJECT_NAME_INFORMATION name_info = (POBJECT_NAME_INFORMATION)local_buf;
        if (name_info->Name.Buffer != NULL && name_info->Name.Length > 0) {
            size_t chars = name_info->Name.Length / sizeof(wchar_t);
            if (chars >= (sizeof(ctx->buffer) / sizeof(wchar_t))) {
                chars = (sizeof(ctx->buffer) / sizeof(wchar_t)) - 1;
            }
            wmemcpy(ctx->buffer, name_info->Name.Buffer, chars);
            ctx->buffer[chars] = L'\0';
            ctx->matched = (wcsstr(ctx->buffer, TARGET_OBJECT_SUBSTRING) != NULL);
        }
    }
    return 0;
}

/* Query a handle's kernel object name with a timeout, since
 * NtQueryObject can hang indefinitely on some handle types. Returns TRUE
 * only if the query completed in time and the name contains
 * TARGET_OBJECT_SUBSTRING. A thread that times out is abandoned (not
 * waited on or cleaned up) rather than risking a hang here; this process
 * is short-lived and exits shortly after regardless.
 */
static BOOL handle_name_matches(HANDLE handle) {
    NAME_QUERY_CTX *ctx = (NAME_QUERY_CTX *)calloc(1, sizeof(NAME_QUERY_CTX));
    if (!ctx) {
        return FALSE;
    }
    ctx->handle = handle;

    HANDLE thread = CreateThread(NULL, 0, query_object_name_thread, ctx, 0, NULL);
    if (!thread) {
        free(ctx);
        return FALSE;
    }

    BOOL matched = FALSE;
    if (WaitForSingleObject(thread, 150) == WAIT_OBJECT_0) {
        matched = ctx->matched;
        free(ctx);
    }
    /* On timeout, ctx is intentionally leaked: the abandoned thread may
     * still be reading it. */
    CloseHandle(thread);
    return matched;
}

static PSYSTEM_HANDLE_INFORMATION query_all_handles(void) {
    ULONG buffer_size = 1 << 20;
    PSYSTEM_HANDLE_INFORMATION info = NULL;
    for (;;) {
        info = (PSYSTEM_HANDLE_INFORMATION)malloc(buffer_size);
        if (!info) {
            return NULL;
        }
        ULONG return_length = 0;
        NTSTATUS status = NtQuerySystemInformation(
            SystemHandleInformation, info, buffer_size, &return_length);
        if (status == STATUS_SUCCESS) {
            return info;
        }
        free(info);
        if (status != STATUS_INFO_LENGTH_MISMATCH) {
            return NULL;
        }
        buffer_size *= 2;
        if (buffer_size > (256u << 20)) {
            return NULL;
        }
    }
}

/* Every currently running process id whose image name matches
 * TARGET_PROCESS_NAME. Returns the count written into pids (capped at
 * max_pids).
 */
static int find_target_pids(DWORD *pids, int max_pids) {
    int count = 0;
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) {
        return 0;
    }
    PROCESSENTRY32W entry;
    entry.dwSize = sizeof(entry);
    if (Process32FirstW(snapshot, &entry)) {
        do {
            if (_wcsicmp(entry.szExeFile, TARGET_PROCESS_NAME) == 0 && count < max_pids) {
                pids[count++] = entry.th32ProcessID;
            }
        } while (Process32NextW(snapshot, &entry));
    }
    CloseHandle(snapshot);
    return count;
}

static void close_singleton_handle_for_pid(DWORD pid, PSYSTEM_HANDLE_INFORMATION handles) {
    HANDLE process = OpenProcess(
        PROCESS_DUP_HANDLE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!process) {
        return;
    }

    for (ULONG i = 0; i < handles->NumberOfHandles; i++) {
        PSYSTEM_HANDLE_TABLE_ENTRY_INFO entry = &handles->Handles[i];
        if (entry->UniqueProcessId != (USHORT)pid) {
            continue;
        }

        HANDLE local_dup = NULL;
        if (!DuplicateHandle(
                process, (HANDLE)(UINT_PTR)entry->HandleValue, GetCurrentProcess(),
                &local_dup, 0, FALSE, DUPLICATE_SAME_ACCESS)) {
            continue;
        }

        BOOL matched = handle_name_matches(local_dup);
        CloseHandle(local_dup);

        if (matched) {
            DuplicateHandle(
                process, (HANDLE)(UINT_PTR)entry->HandleValue, NULL, NULL, 0, FALSE,
                DUPLICATE_CLOSE_SOURCE);
        }
    }

    CloseHandle(process);
}

/* Parse the command-line pids (decimal strings) into requested[], filtered
 * down to only the ones that are still a real, currently running
 * RobloxPlayerBeta.exe process - a stale or reused pid passed in by the
 * caller is silently ignored rather than acted on.
 */
static int resolve_requested_pids(int argc, wchar_t *argv[], DWORD *out_pids, int max_pids) {
    DWORD running[64];
    int running_count = find_target_pids(running, 64);
    if (running_count == 0) {
        return 0;
    }

    int count = 0;
    for (int i = 1; i < argc && count < max_pids; i++) {
        DWORD requested = (DWORD)_wtoi(argv[i]);
        if (requested == 0) {
            continue;
        }
        for (int j = 0; j < running_count; j++) {
            if (running[j] == requested) {
                out_pids[count++] = requested;
                break;
            }
        }
    }
    return count;
}

int wmain(int argc, wchar_t *argv[]) {
    if (argc <= 1) {
        return 0;
    }

    HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    if (!ntdll) {
        return 0;
    }
    NtQuerySystemInformation =
        (NtQuerySystemInformation_t)GetProcAddress(ntdll, "NtQuerySystemInformation");
    NtQueryObject = (NtQueryObject_t)GetProcAddress(ntdll, "NtQueryObject");
    if (!NtQuerySystemInformation || !NtQueryObject) {
        return 0;
    }

    DWORD pids[64];
    int pid_count = resolve_requested_pids(argc, argv, pids, 64);
    if (pid_count == 0) {
        return 0;
    }

    PSYSTEM_HANDLE_INFORMATION handles = query_all_handles();
    if (!handles) {
        return 0;
    }

    for (int i = 0; i < pid_count; i++) {
        close_singleton_handle_for_pid(pids[i], handles);
    }

    free(handles);
    return 0;
}
