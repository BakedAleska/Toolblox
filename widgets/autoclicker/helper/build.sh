#!/bin/sh
# Builds the helper into ../optional-bin. On macOS, builds the universal macOS helper and, when
# MinGW-w64 is installed, the Windows helper too. On Windows, run it from an MSYS2 MinGW shell.
set -eu
cd "$(dirname "$0")"
out=../optional-bin
mkdir -p "$out"
flags="-std=c11 -O2 -Wall -Wextra"
case "$(uname -s)" in
Darwin)
  for arch in arm64 x86_64; do
    clang $flags -fobjc-arc -arch "$arch" -mmacosx-version-min=11.0 \
      -framework AppKit -framework ApplicationServices \
      clicker.c platform_macos.m -o "autoclicker-$arch"
  done
  lipo -create -output "$out/autoclicker-macos" autoclicker-arm64 autoclicker-x86_64
  rm autoclicker-arm64 autoclicker-x86_64
  codesign --force --sign - "$out/autoclicker-macos"
  chmod +x "$out/autoclicker-macos"
  windows_cc=x86_64-w64-mingw32-gcc
  ;;
*)
  windows_cc=gcc
  ;;
esac
if command -v "$windows_cc" >/dev/null 2>&1; then
  "$windows_cc" $flags -mwindows -static clicker.c platform_windows.c -lwinmm -o "$out/autoclicker.exe"
  strip "$out/autoclicker.exe" 2>/dev/null || x86_64-w64-mingw32-strip "$out/autoclicker.exe"
fi
