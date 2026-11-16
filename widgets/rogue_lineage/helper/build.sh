#!/bin/sh
# Checks the pixel reading against drawn frames and the screenshots in fixtures/, and on Windows
# the text reading too, then builds the Windows helper into ../optional-bin. Run it from an MSYS2
# MinGW shell on Windows, or anywhere MinGW-w64 is installed. There is no macOS helper yet.
set -eu
cd "$(dirname "$0")"
out=../optional-bin
mkdir -p "$out"
flags="-std=c11 -O2 -Wall -Wextra"
reader=""
case "$(uname -s)" in MINGW* | MSYS* | CYGWIN*) reader="ocr.c -lruntimeobject" ;; esac
cc $flags test.c detect.c $reader -lm -o detect-test
./detect-test
rm -f detect-test detect-test.exe
windows_cc=gcc
command -v x86_64-w64-mingw32-gcc >/dev/null 2>&1 && windows_cc=x86_64-w64-mingw32-gcc
"$windows_cc" $flags -mwindows -static manabar.c detect.c ocr.c -lruntimeobject -o "$out/manabar.exe"
strip "$out/manabar.exe" 2>/dev/null || x86_64-w64-mingw32-strip "$out/manabar.exe"
