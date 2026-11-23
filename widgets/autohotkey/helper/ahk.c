/*
 * AutoHotkey helper. Reads one JSON message per line on standard input and writes one JSON message
 * per line on standard output.
 *
 * Scripts are launched through the `.ahk` file association, so AutoHotkey's launcher picks the
 * version. Running scripts are found through AutoHotkey's main windows, whose titles start with the
 * script's full path, and are reloaded or stopped with the commands from its tray menu.
 */
#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <windows.h>
#include <shellapi.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <stdio.h>
#include <wchar.h>

#include "json.h"

#define TEXT_MAX 4096
#define PATH_WIDE 1024
#define AHK_RELOAD 65303
#define AHK_EXIT 65307
#define DOWNLOAD_URL L"https://www.autohotkey.com/"
#define DOCS_URL L"https://www.autohotkey.com/docs/v2/"
#define TEMPLATE "#Requires AutoHotkey v2.0\r\n#SingleInstance Force\r\n\r\n"

static void send_line(const char *line) {
    fputs(line, stdout);
    fputc('\n', stdout);
    fflush(stdout);
}

static void to_utf8(const wchar_t *wide, char *out, int size) {
    if (!WideCharToMultiByte(CP_UTF8, 0, wide, -1, out, size, NULL, NULL)) *out = 0;
}

static int to_wide(const char *text, wchar_t *out, int size) {
    return MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text, -1, out, size) > 0;
}

/* Sends `{"type":type,"key":value}` with value as a JSON string. */
static void send_field(const char *type, const char *key, const wchar_t *value) {
    char text[TEXT_MAX], quoted[TEXT_MAX * 2], line[TEXT_MAX * 2 + 128];
    to_utf8(value, text, sizeof text);
    json_quote(quoted, sizeof quoted, text);
    snprintf(line, sizeof line, "{\"type\":\"%s\",\"%s\":%s}", type, key, quoted);
    send_line(line);
}

static void send_error(const char *message) {
    char quoted[1024], line[1100];
    json_quote(quoted, sizeof quoted, message);
    snprintf(line, sizeof line, "{\"type\":\"error\",\"message\":%s}", quoted);
    send_line(line);
}

static int same_path(const wchar_t *a, const wchar_t *b) {
    return CompareStringOrdinal(a, -1, b, -1, TRUE) == CSTR_EQUAL;
}

static int has_extension(const wchar_t *path) {
    size_t length = wcslen(path);
    return length > 4 && same_path(path + length - 4, L".ahk");
}

/* Reads a path field and makes it absolute, with long names when it exists. */
static int read_path(const char *line, const char *key, wchar_t *out) {
    char text[TEXT_MAX];
    wchar_t wide[PATH_WIDE];
    if (!json_get(line, key, text, sizeof text) || !*text || !to_wide(text, wide, PATH_WIDE)) return 0;
    DWORD length = GetFullPathNameW(wide, PATH_WIDE, out, NULL);
    if (!length || length >= PATH_WIDE) return 0;
    wcscpy(wide, out);
    length = GetLongPathNameW(wide, out, PATH_WIDE);
    if (!length || length >= PATH_WIDE) wcscpy(out, wide);
    length = (DWORD)wcslen(out);
    while (length > 3 && (out[length - 1] == L'\\' || out[length - 1] == L'/')) out[--length] = 0;
    return 1;
}

static int install_dir(wchar_t *out) {
    DWORD size = PATH_WIDE * sizeof(wchar_t);
    if (RegGetValueW(HKEY_LOCAL_MACHINE, L"SOFTWARE\\AutoHotkey", L"InstallDir", RRF_RT_REG_SZ, NULL, out, &size) == ERROR_SUCCESS) return 1;
    size = PATH_WIDE * sizeof(wchar_t);
    return RegGetValueW(HKEY_CURRENT_USER, L"SOFTWARE\\AutoHotkey", L"InstallDir", RRF_RT_REG_SZ, NULL, out, &size) == ERROR_SUCCESS;
}

static int file_exists(const wchar_t *path) {
    DWORD attributes = GetFileAttributesW(path);
    return attributes != INVALID_FILE_ATTRIBUTES && !(attributes & FILE_ATTRIBUTE_DIRECTORY);
}

/* Opens a file, folder, or URL with its registered handler. */
static int shell(const wchar_t *verb, const wchar_t *file, const wchar_t *parameters) {
    SHELLEXECUTEINFOW info;
    ZeroMemory(&info, sizeof info);
    info.cbSize = sizeof info;
    info.fMask = SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI;
    info.lpVerb = verb;
    info.lpFile = file;
    info.lpParameters = parameters;
    info.nShow = SW_SHOWNORMAL;
    return ShellExecuteExW(&info);
}

/* The script path in an AutoHotkey main window's title, which reads `<path> - AutoHotkey v<version>`. */
static int window_script(HWND window, wchar_t *out) {
    wchar_t name[32];
    if (!GetClassNameW(window, name, 32) || wcscmp(name, L"AutoHotkey")) return 0;
    if (!GetWindowTextW(window, out, PATH_WIDE)) return 0;
    wchar_t *suffix = NULL;
    for (wchar_t *found = out; (found = wcsstr(found, L" - AutoHotkey")); found++) suffix = found;
    if (!suffix) return 0;
    *suffix = 0;
    return 1;
}

struct find { const wchar_t *path; HWND window; };

static BOOL CALLBACK find_window(HWND window, LPARAM data) {
    struct find *find = (struct find *)data;
    wchar_t script[PATH_WIDE];
    if (window_script(window, script) && same_path(script, find->path)) { find->window = window; return FALSE; }
    return TRUE;
}

static HWND script_window(const wchar_t *path) {
    struct find find = { path, NULL };
    EnumWindows(find_window, (LPARAM)&find);
    return find.window;
}

/* Sends each running script, leaving out AutoHotkey's own, such as its launcher and Window Spy. */
static BOOL CALLBACK list_window(HWND window, LPARAM data) {
    const wchar_t *own = (const wchar_t *)data;
    wchar_t script[PATH_WIDE];
    if (!window_script(window, script)) return TRUE;
    size_t length = wcslen(own);
    if (length && CompareStringOrdinal(script, (int)min(length, wcslen(script)), own, (int)length, TRUE) == CSTR_EQUAL && script[length] == L'\\') return TRUE;
    send_field("running", "path", script);
    return TRUE;
}

/* A path the helper acts on: a script directly in the scripts folder, or one that's running. */
static int read_script(const char *line, wchar_t *path) {
    wchar_t folder[PATH_WIDE], parent[PATH_WIDE];
    if (!read_path(line, "path", path) || !has_extension(path)) { send_error("The script path isn't valid. Can the list be refreshed?"); return 0; }
    if (script_window(path)) return 1;
    wcscpy(parent, path);
    wchar_t *slash = wcsrchr(parent, L'\\');
    if (slash) *slash = 0;
    if (!read_path(line, "folder", folder) || !slash || !same_path(parent, folder)) { send_error("The script isn't in the scripts folder. Can the list be refreshed?"); return 0; }
    if (!file_exists(path)) { send_error("The script wasn't found. Was it moved or deleted?"); return 0; }
    return 1;
}

static void describe(void) {
    wchar_t dir[PATH_WIDE], version[64] = L"", *documents = NULL, folder[PATH_WIDE] = L"";
    DWORD size = sizeof version;
    int installed = install_dir(dir);
    if (installed && RegGetValueW(HKEY_LOCAL_MACHINE, L"SOFTWARE\\AutoHotkey", L"Version", RRF_RT_REG_SZ, NULL, version, &size) != ERROR_SUCCESS) {
        size = sizeof version;
        RegGetValueW(HKEY_CURRENT_USER, L"SOFTWARE\\AutoHotkey", L"Version", RRF_RT_REG_SZ, NULL, version, &size);
    }
    if (SUCCEEDED(SHGetKnownFolderPath(&FOLDERID_Documents, 0, NULL, &documents))) _snwprintf(folder, PATH_WIDE - 1, L"%ls\\AutoHotkey", documents);
    CoTaskMemFree(documents);
    char folder8[TEXT_MAX], version8[128], quoted_folder[TEXT_MAX * 2], quoted_version[256], line[TEXT_MAX * 2 + 512];
    to_utf8(folder, folder8, sizeof folder8);
    to_utf8(version, version8, sizeof version8);
    json_quote(quoted_folder, sizeof quoted_folder, folder8);
    json_quote(quoted_version, sizeof quoted_version, version8);
    snprintf(line, sizeof line, "{\"type\":\"ready\",\"installed\":%s,\"version\":%s,\"folder\":%s}", installed ? "true" : "false", quoted_version, quoted_folder);
    send_line(line);
}

/* Sends a `script` line per `.ahk` file in the folder and a `running` line per running script, then `listed`. */
static void list(const char *line) {
    wchar_t folder[PATH_WIDE], pattern[PATH_WIDE + 8], path[PATH_WIDE];
    if (read_path(line, "folder", folder)) {
        _snwprintf(pattern, PATH_WIDE + 7, L"%ls\\*.ahk", folder);
        pattern[PATH_WIDE + 7] = 0;
        WIN32_FIND_DATAW item;
        HANDLE search = FindFirstFileW(pattern, &item);
        if (search != INVALID_HANDLE_VALUE) {
            do {
                if (item.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY || !has_extension(item.cFileName)) continue;
                if (_snwprintf(path, PATH_WIDE, L"%ls\\%ls", folder, item.cFileName) < 0) continue;
                char text[TEXT_MAX], quoted[TEXT_MAX * 2], out[TEXT_MAX * 2 + 128];
                ULONGLONG modified = ((ULONGLONG)item.ftLastWriteTime.dwHighDateTime << 32 | item.ftLastWriteTime.dwLowDateTime) / 10000 - 11644473600000ull;
                to_utf8(path, text, sizeof text);
                json_quote(quoted, sizeof quoted, text);
                snprintf(out, sizeof out, "{\"type\":\"script\",\"path\":%s,\"modified\":%llu}", quoted, modified);
                send_line(out);
            } while (FindNextFileW(search, &item));
            FindClose(search);
        }
    }
    wchar_t own[PATH_WIDE] = L"";
    if (!install_dir(own)) own[0] = 0;
    EnumWindows(list_window, (LPARAM)own);
    send_line("{\"type\":\"listed\"}");
}

static void command(const char *line, WPARAM id, const char *verb) {
    wchar_t path[PATH_WIDE];
    char message[256];
    if (!read_path(line, "path", path)) return send_error("The script path isn't valid. Can the list be refreshed?");
    HWND window = script_window(path);
    if (!window) return send_error("The script isn't running. Can the list be refreshed?");
    if (!PostMessageW(window, WM_COMMAND, id, 0)) {
        snprintf(message, sizeof message, "The script couldn't be %s. Is it running as administrator?", verb);
        send_error(message);
    }
}

static void run(const char *line) {
    wchar_t path[PATH_WIDE];
    if (!read_script(line, path)) return;
    if (!shell(L"open", path, NULL)) send_error("The script didn't start. Is AutoHotkey installed?");
}

/*
 * Opens the script in Visual Studio Code when chosen, found through its `vscode:` link handler, and
 * otherwise with the `.ahk` edit command and then Notepad.
 */
static void edit(const char *line) {
    wchar_t path[PATH_WIDE];
    char editor[16];
    if (!read_script(line, path)) return;
    wchar_t quoted[PATH_WIDE + 2], command[PATH_WIDE];
    _snwprintf(quoted, PATH_WIDE + 1, L"\"%ls\"", path);
    quoted[PATH_WIDE + 1] = 0;
    DWORD size = sizeof command;
    if (json_get(line, "editor", editor, sizeof editor) && !strcmp(editor, "vscode")
        && RegGetValueW(HKEY_CLASSES_ROOT, L"vscode\\shell\\open\\command", NULL, RRF_RT_REG_SZ, NULL, command, &size) == ERROR_SUCCESS
        && command[0] == L'"') {
        wchar_t *end = wcschr(command + 1, L'"');
        if (end) {
            *end = 0;
            if (file_exists(command + 1) && shell(L"open", command + 1, quoted)) return;
        }
    }
    if (shell(L"edit", path, NULL)) return;
    if (!shell(L"open", L"notepad.exe", quoted)) send_error("No editor opened. Is an editor set for AutoHotkey scripts?");
}

/* Creates a script from the template. Names are file names without folders, and existing files are kept. */
static void create(const char *line) {
    wchar_t folder[PATH_WIDE], name[256], path[PATH_WIDE];
    char text[512];
    if (!read_path(line, "folder", folder)) return send_error("The scripts folder isn't valid. Can it be chosen again in settings?");
    if (!json_get(line, "name", text, sizeof text) || !to_wide(text, name, 256)) return send_error("The script name is too long. Can it be shortened?");
    size_t length = wcslen(name);
    if (length > 4 && same_path(name + length - 4, L".ahk")) name[length -= 4] = 0;
    if (!length) return send_error("The script needs a name.");
    if (length > 100) return send_error("Script names can be up to 100 characters. Can it be shortened?");
    if ( name[length - 1] == L'.' || name[length - 1] == L' ' || name[0] == L' ' || wcspbrk(name, L"\\/:*?\"<>|")) return send_error("Script names can't contain \\ / : * ? \" < > |. Can another name be used?");
    for (size_t i = 0; i < length; i++) if (name[i] < 0x20) return send_error("Script names can't contain control characters. Can another name be used?");
    static const wchar_t *reserved[] = { L"CON", L"PRN", L"AUX", L"NUL", L"COM1", L"COM2", L"COM3", L"COM4", L"COM5", L"COM6", L"COM7", L"COM8", L"COM9", L"LPT1", L"LPT2", L"LPT3", L"LPT4", L"LPT5", L"LPT6", L"LPT7", L"LPT8", L"LPT9" };
    wchar_t base[256];
    wcscpy(base, name);
    wchar_t *dot = wcschr(base, L'.');
    if (dot) *dot = 0;
    for (size_t i = 0; i < sizeof reserved / sizeof *reserved; i++) if (same_path(base, reserved[i])) return send_error("Windows reserves that name. Can another name be used?");
    if (_snwprintf(path, PATH_WIDE, L"%ls\\%ls.ahk", folder, name) < 0) return send_error("The script path is too long. Can the name be shortened?");
    int created = SHCreateDirectoryExW(NULL, folder, NULL);
    if (created != ERROR_SUCCESS && created != ERROR_ALREADY_EXISTS && created != ERROR_FILE_EXISTS) return send_error("The scripts folder couldn't be created. Is it writable?");
    HANDLE file = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) return send_error(GetLastError() == ERROR_FILE_EXISTS ? "A script with that name already exists. Can another name be used?" : "The script couldn't be created. Is the folder writable?");
    DWORD written;
    WriteFile(file, TEMPLATE, (DWORD)strlen(TEMPLATE), &written, NULL);
    CloseHandle(file);
    send_field("created", "path", path);
}

static void open_folder(const char *line) {
    wchar_t folder[PATH_WIDE];
    if (!read_path(line, "folder", folder)) return send_error("The scripts folder isn't valid. Can it be chosen again in settings?");
    SHCreateDirectoryExW(NULL, folder, NULL);
    if (!shell(L"open", folder, NULL)) send_error("The scripts folder didn't open. Does it still exist?");
}

/* Opens Window Spy, or the help file, from the AutoHotkey installation. */
static void open_tool(const wchar_t *const *candidates, const wchar_t *fallback, const char *error) {
    wchar_t dir[PATH_WIDE], path[PATH_WIDE];
    if (install_dir(dir)) {
        for (; *candidates; candidates++) {
            _snwprintf(path, PATH_WIDE - 1, L"%ls\\%ls", dir, *candidates);
            path[PATH_WIDE - 1] = 0;
            if (file_exists(path) && shell(L"open", path, NULL)) return;
        }
    }
    if (!fallback || !shell(L"open", fallback, NULL)) send_error(error);
}

/* Shows the folder picker and sends `folder` when it closes, with the chosen path unless cancelled. */
static void pick(const char *line) {
    wchar_t current[PATH_WIDE];
    IFileOpenDialog *dialog;
    if (FAILED(CoCreateInstance(&CLSID_FileOpenDialog, NULL, CLSCTX_INPROC_SERVER, &IID_IFileOpenDialog, (void **)&dialog))) {
        send_line("{\"type\":\"folder\"}");
        return send_error("The folder picker didn't open. Does retrying help?");
    }
    int sent = 0;
    FILEOPENDIALOGOPTIONS options;
    if (SUCCEEDED(IFileOpenDialog_GetOptions(dialog, &options))) IFileOpenDialog_SetOptions(dialog, options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM);
    IFileOpenDialog_SetTitle(dialog, L"Scripts folder");
    IShellItem *item;
    if (read_path(line, "folder", current) && SUCCEEDED(SHCreateItemFromParsingName(current, NULL, &IID_IShellItem, (void **)&item))) {
        IFileOpenDialog_SetFolder(dialog, item);
        IShellItem_Release(item);
    }
    if (SUCCEEDED(IFileOpenDialog_Show(dialog, GetForegroundWindow())) && SUCCEEDED(IFileOpenDialog_GetResult(dialog, &item))) {
        wchar_t *path;
        if (SUCCEEDED(IShellItem_GetDisplayName(item, SIGDN_FILESYSPATH, &path))) {
            send_field("folder", "path", path);
            sent = 1;
            CoTaskMemFree(path);
        }
        IShellItem_Release(item);
    }
    IFileOpenDialog_Release(dialog);
    if (!sent) send_line("{\"type\":\"folder\"}");
}

static void handle(const char *line) {
    char type[32];
    static const wchar_t *const spy[] = { L"UX\\WindowSpy.ahk", L"WindowSpy.ahk", NULL };
    static const wchar_t *const docs[] = { L"v2\\AutoHotkey.chm", L"AutoHotkey.chm", NULL };
    if (!json_get(line, "type", type, sizeof type)) return send_error("The helper received a message it can't read. Does restarting the widget help?");
    if (!strcmp(type, "describe")) describe();
    else if (!strcmp(type, "list")) list(line);
    else if (!strcmp(type, "run")) run(line);
    else if (!strcmp(type, "reload")) command(line, AHK_RELOAD, "reloaded");
    else if (!strcmp(type, "stop")) command(line, AHK_EXIT, "stopped");
    else if (!strcmp(type, "edit")) edit(line);
    else if (!strcmp(type, "create")) create(line);
    else if (!strcmp(type, "folder")) open_folder(line);
    else if (!strcmp(type, "pick")) pick(line);
    else if (!strcmp(type, "spy")) open_tool(spy, NULL, "Window Spy didn't open. Is AutoHotkey installed?");
    else if (!strcmp(type, "docs")) open_tool(docs, DOCS_URL, "The documentation didn't open. Does retrying help?");
    else if (!strcmp(type, "download")) { if (!shell(L"open", DOWNLOAD_URL, NULL)) send_error("The browser didn't open. Does retrying help?"); }
    else send_error("The helper doesn't support that message. Is the widget up to date?");
}

int main(void) {
    static char line[64 * 1024 + 2];
    static const DWORD streams[] = { STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE };
    for (int i = 0; i < 3; i++) SetHandleInformation(GetStdHandle(streams[i]), HANDLE_FLAG_INHERIT, 0);
    CoInitializeEx(NULL, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
    while (fgets(line, sizeof line, stdin)) handle(line);
    CoUninitialize();
    return 0;
}
