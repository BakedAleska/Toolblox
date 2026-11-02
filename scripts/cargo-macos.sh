#!/bin/sh
# Runs cargo for Tauri on macOS (`build.runner` in `src-tauri/tauri.macos.conf.json`). After a
# debug build, signs the app with the "Toolblox Development" certificate when this Mac has one, so
# the app keeps one code identity across rebuilds and Keychain's "Always Allow" lasts. Release
# builds and Macs without the certificate are unchanged. Create it with
# `scripts/dev-certificate.sh`.
set -eu
cargo "$@"
[ "${1-}" = build ] || exit 0
case " $* " in *" --release "* | *" --profile "*) exit 0 ;; esac
identity="${TOOLBLOX_SIGNING_IDENTITY:-Toolblox Development}"
if ! security find-certificate -c "$identity" >/dev/null 2>&1; then
  echo "Debug build left unsigned. Keychain asks again after each rebuild until scripts/dev-certificate.sh is run." >&2
  exit 0
fi
target_dir="${CARGO_TARGET_DIR:-target}"
triple=$(printf '%s\n' "$@" | awk 'previous == "--target" { print; exit } { previous = $0 }')
binary="$target_dir/${triple:+$triple/}debug/toolblox"
codesign --force --sign "$identity" --identifier com.bakedaleska.toolblox "$binary"
