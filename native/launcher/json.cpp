#include "json.h"

std::string JsonFindString(const std::string &json, const std::string &key) {
    std::string needle = "\"" + key + "\"";
    size_t pos = json.find(needle);
    if (pos == std::string::npos) {
        return "";
    }
    pos = json.find(':', pos + needle.size());
    if (pos == std::string::npos) {
        return "";
    }
    pos = json.find('"', pos);
    if (pos == std::string::npos) {
        return "";
    }
    pos++;
    std::string out;
    while (pos < json.size() && json[pos] != '"') {
        if (json[pos] == '\\' && pos + 1 < json.size()) {
            pos++;
        }
        out.push_back(json[pos]);
        pos++;
    }
    return out;
}

std::vector<std::string> JsonFindArrayObjects(const std::string &json, const std::string &key) {
    std::vector<std::string> objects;
    std::string needle = "\"" + key + "\"";
    size_t pos = json.find(needle);
    if (pos == std::string::npos) {
        return objects;
    }
    pos = json.find('[', pos);
    if (pos == std::string::npos) {
        return objects;
    }

    int depth = 0;
    size_t objectStart = std::string::npos;
    for (size_t i = pos; i < json.size(); i++) {
        char c = json[i];
        if (c == '{') {
            if (depth == 0) {
                objectStart = i;
            }
            depth++;
        } else if (c == '}') {
            depth--;
            if (depth == 0 && objectStart != std::string::npos) {
                objects.push_back(json.substr(objectStart, i - objectStart + 1));
                objectStart = std::string::npos;
            }
        } else if (c == ']' && depth == 0) {
            break;
        }
    }
    return objects;
}
