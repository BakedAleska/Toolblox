/*
 * Not a general JSON parser - a small purpose-built scanner for the one
 * shape of document this launcher ever reads: GitHub's "latest release"
 * API response. Safe to keep this minimal because the input always comes
 * straight from api.github.com over TLS, not from anything user-supplied.
 */
#pragma once

#include <string>
#include <vector>

/* First top-level occurrence of "key": "value" (string values only). */
std::string JsonFindString(const std::string &json, const std::string &key);

/* Every {...} object inside the array at "key": [ ... ], as raw substrings
 * (not parsed further) - callers run JsonFindString on each one. */
std::vector<std::string> JsonFindArrayObjects(const std::string &json, const std::string &key);
