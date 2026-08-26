#include "version.h"

#include <windows.h>

#include <fstream>
#include <sstream>
#include <vector>

std::string ReadVersionFile(const std::wstring &installDir) {
    std::wstring path = installDir + L"\\version.txt";
    std::ifstream f(path);
    if (!f.is_open()) {
        return "";
    }
    std::string line;
    std::getline(f, line);
    while (!line.empty() && (line.back() == '\r' || line.back() == '\n' || line.back() == ' ')) {
        line.pop_back();
    }
    return line;
}

namespace {

struct VersionKey {
    std::vector<int> parts;
    int noSuffixRank; /* 1 if no suffix (outranks any suffix), 0 otherwise */
    std::string suffix;
};

VersionKey ParseVersionKey(const std::string &raw) {
    std::string s = raw;
    size_t start = 0;
    while (start < s.size() && (s[start] == 'v' || s[start] == 'V')) {
        start++;
    }
    s = s.substr(start);

    std::string numeric = s;
    std::string suffix;
    size_t dash = s.find('-');
    if (dash != std::string::npos) {
        numeric = s.substr(0, dash);
        suffix = s.substr(dash + 1);
    }

    VersionKey key;
    key.noSuffixRank = suffix.empty() ? 1 : 0;
    key.suffix = suffix;

    std::stringstream ss(numeric);
    std::string part;
    while (std::getline(ss, part, '.')) {
        int value = 0;
        for (char c : part) {
            if (c < '0' || c > '9') {
                value = 0;
                break;
            }
        }
        try {
            value = part.empty() ? 0 : std::stoi(part);
        } catch (...) {
            value = 0;
        }
        key.parts.push_back(value);
    }
    return key;
}

int CompareParts(const std::vector<int> &a, const std::vector<int> &b) {
    size_t n = a.size() > b.size() ? a.size() : b.size();
    for (size_t i = 0; i < n; i++) {
        int av = i < a.size() ? a[i] : 0;
        int bv = i < b.size() ? b[i] : 0;
        if (av != bv) {
            return av < bv ? -1 : 1;
        }
    }
    return 0;
}

} // namespace

bool IsNewerVersion(const std::string &candidate, const std::string &current) {
    VersionKey c = ParseVersionKey(candidate);
    VersionKey k = ParseVersionKey(current);

    int cmp = CompareParts(c.parts, k.parts);
    if (cmp != 0) {
        return cmp > 0;
    }
    if (c.noSuffixRank != k.noSuffixRank) {
        return c.noSuffixRank > k.noSuffixRank;
    }
    return c.suffix > k.suffix;
}
