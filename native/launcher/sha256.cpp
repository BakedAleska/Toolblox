#include "sha256.h"

#include <windows.h>
#include <bcrypt.h>

#include <vector>

#pragma comment(lib, "bcrypt.lib")

bool Sha256File(const std::wstring &path, std::string &outHexLower) {
    outHexLower.clear();

    HANDLE file = CreateFileW(
        path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) {
        return false;
    }

    BCRYPT_ALG_HANDLE alg = nullptr;
    bool ok = false;
    if (BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, nullptr, 0) == 0) {
        BCRYPT_HASH_HANDLE hash = nullptr;
        if (BCryptCreateHash(alg, &hash, nullptr, 0, nullptr, 0, 0) == 0) {
            std::vector<BYTE> buffer(64 * 1024);
            DWORD read = 0;
            bool readOk = true;
            while (ReadFile(file, buffer.data(), (DWORD)buffer.size(), &read, nullptr) &&
                   read > 0) {
                if (BCryptHashData(hash, buffer.data(), read, 0) != 0) {
                    readOk = false;
                    break;
                }
            }
            if (readOk) {
                BYTE digest[32];
                if (BCryptFinishHash(hash, digest, sizeof(digest), 0) == 0) {
                    static const char *kHex = "0123456789abcdef";
                    outHexLower.reserve(64);
                    for (BYTE b : digest) {
                        outHexLower.push_back(kHex[b >> 4]);
                        outHexLower.push_back(kHex[b & 0xF]);
                    }
                    ok = true;
                }
            }
            BCryptDestroyHash(hash);
        }
        BCryptCloseAlgorithmProvider(alg, 0);
    }

    CloseHandle(file);
    return ok;
}
