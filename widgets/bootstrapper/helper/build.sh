#!/bin/sh
# Tests the flags file check and builds the Windows helper into ../optional-bin. Needs MinGW-w64;
# on Windows, run it from an MSYS2 MinGW shell.
set -eu
cd "$(dirname "$0")"
gcc -std=c11 -Wall -Wextra test.c -o bootstrapper-test
./bootstrapper-test
rm -f bootstrapper-test bootstrapper-test.exe
case "$(uname -s)" in
Darwin|Linux) windows_cc=x86_64-w64-mingw32-gcc ;;
*) windows_cc=gcc ;;
esac
mkdir -p ../optional-bin
"$windows_cc" -std=c11 -O2 -Wall -Wextra -mwindows -static bootstrapper.c -o ../optional-bin/bootstrapper.exe
strip ../optional-bin/bootstrapper.exe 2>/dev/null || x86_64-w64-mingw32-strip ../optional-bin/bootstrapper.exe
