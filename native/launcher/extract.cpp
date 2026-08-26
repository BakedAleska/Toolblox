#include "extract.h"

#include <windows.h>
#include <shldisp.h>
#include <shlobj.h>

#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "oleaut32.lib")

namespace {

/* CopyHere flags (the same FOF_* values SHFileOperation uses, packed into
 * the VARIANT int this dispatch call takes): silent, no confirmation
 * dialogs, no error UI (checked via HRESULT instead), don't ask before
 * creating the destination folder. */
const long kCopyFlags = FOF_SILENT | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_NOCONFIRMMKDIR;

/* Raw VARIANT/BSTR helpers instead of the comdef.h _variant_t/_bstr_t
 * wrappers, so this doesn't need comsuppw.lib linked in - just the
 * ole32/oleaut32 import libs every COM caller already needs. */
struct AutoBstr {
    BSTR value;
    explicit AutoBstr(const std::wstring &s) : value(SysAllocString(s.c_str())) {}
    ~AutoBstr() {
        if (value) {
            SysFreeString(value);
        }
    }
};

bool GetNamespaceFolder(IShellDispatch *shell, const std::wstring &path, Folder **outFolder) {
    AutoBstr bstr(path);
    VARIANT v;
    VariantInit(&v);
    v.vt = VT_BSTR;
    v.bstrVal = bstr.value;
    bool ok = SUCCEEDED(shell->NameSpace(v, outFolder)) && *outFolder != nullptr;
    return ok;
}

} // namespace

bool ExtractZip(const std::wstring &zipPath, const std::wstring &destDir, std::wstring &error) {
    SHCreateDirectoryExW(nullptr, destDir.c_str(), nullptr);

    HRESULT coInit = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    bool weInitialized = SUCCEEDED(coInit);

    bool ok = false;
    IShellDispatch *shell = nullptr;
    HRESULT hr = CoCreateInstance(
        CLSID_Shell, nullptr, CLSCTX_INPROC_SERVER, IID_IShellDispatch, (void **)&shell);
    if (FAILED(hr) || !shell) {
        error = L"Couldn't start Shell.Application";
        if (weInitialized) {
            CoUninitialize();
        }
        return false;
    }

    Folder *zipFolder = nullptr;
    Folder *destFolder = nullptr;
    if (!GetNamespaceFolder(shell, zipPath, &zipFolder)) {
        error = L"Couldn't open the update archive: " + zipPath;
        goto cleanup;
    }
    if (!GetNamespaceFolder(shell, destDir, &destFolder)) {
        error = L"Couldn't open the destination folder: " + destDir;
        goto cleanup;
    }

    {
        FolderItems *items = nullptr;
        if (FAILED(zipFolder->Items(&items)) || !items) {
            error = L"Couldn't read the update archive's contents";
            goto cleanup;
        }
        VARIANT itemsVariant;
        VariantInit(&itemsVariant);
        itemsVariant.vt = VT_DISPATCH;
        itemsVariant.pdispVal = items;

        VARIANT flagsVariant;
        VariantInit(&flagsVariant);
        flagsVariant.vt = VT_I4;
        flagsVariant.lVal = kCopyFlags;

        HRESULT copyHr = destFolder->CopyHere(itemsVariant, flagsVariant);
        items->Release();
        if (FAILED(copyHr)) {
            error = L"Extraction failed";
            goto cleanup;
        }
        ok = true;
    }

cleanup:
    if (zipFolder) {
        zipFolder->Release();
    }
    if (destFolder) {
        destFolder->Release();
    }
    shell->Release();
    if (weInitialized) {
        CoUninitialize();
    }
    return ok;
}
