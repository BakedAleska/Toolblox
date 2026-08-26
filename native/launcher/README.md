# launcher

The native Windows entry point for Toolblox, `Toolblox.exe`. This is not the
Flet/Python app itself - that's `ToolbloxApp.exe`, built by `release/build.py`
and installed right next to this exe. `Toolblox.exe` is what users actually
click (the Start Menu shortcut, the desktop shortcut, the taskbar pin all
point at it): it shows a brief loading window, checks GitHub's latest
release against `version.txt` (written into the install folder at package
time - see `release/build.py`), and if a newer build exists, downloads and
applies it in place before ever starting `ToolbloxApp.exe`.

Replaces the old Inno Setup + Python `ToolbloxUpdater.exe` combination:
Inno Setup only ever built the *installer*; the actual update-in-place
logic (`toolblox/updater_helper.py`) was a separate PyInstaller build
because the old `Toolblox.exe` *was* the running Python app, and a process
can't overwrite its own currently-mapped exe/DLLs. Since this launcher is
never itself the thing being replaced - it only ever touches files inside
the install directory, never its own image - that whole hand-off dance is
gone. Update-apply just runs in this same process.

## What it does

1. Reads `version.txt` next to itself for the currently installed version.
2. GETs `https://api.github.com/repos/BakedAleska/Toolblox/releases/latest`.
3. If the release's tag is newer (see `version.cpp`'s `IsNewerVersion`,
   ported from `toolblox/updater.py`'s `_version_key`/`is_newer`):
   - Downloads the release's `Toolblox-*-windows.zip` asset and its
     `.sha256` companion file.
   - Verifies the zip's SHA-256 against that companion before touching
     anything (`sha256.cpp`, via Windows' own CNG/`bcrypt.h` - no
     third-party crypto).
   - Extracts it into a fresh staging directory next to the install, then
     swaps it in with two directory renames (`update.cpp::ApplyUpdate`,
     ported from `toolblox/updater_helper.py::apply_update`) - so a
     failed/interrupted extraction never corrupts a working install.
4. Launches `ToolbloxApp.exe` from the (possibly just-updated) install
   directory, and exits.

Any failure along the way - offline, GitHub unreachable, no matching
release asset, a checksum mismatch, an extraction failure - is logged to
`%LOCALAPPDATA%\Toolblox\logs\launcher.log` and treated as non-fatal: the
existing install just launches as-is. The only failure this launcher
surfaces to the user with a message box is a genuinely broken install -
`ToolbloxApp.exe` missing entirely.

Zip extraction (`extract.cpp`) goes through the `Shell.Application` COM
automation object (the same one Explorer's own "Extract All" uses), not a
bundled zip library - it's supported on every target Windows version with
nothing extra to vendor.

## `--extract` mode

`Toolblox.exe --extract <zip> <sha256> <destdir>` runs headlessly (no
window): verifies `<zip>`'s SHA-256 against `<sha256>`, extracts it
straight into `<destdir>` (no staging/swap - there's nothing live to
protect yet), and exits with 0 on success or 1 on failure. This is what
`installer/Toolblox.nsi` shells out to for a brand-new install, reusing
the exact same verify/extract code the auto-updater uses rather than
duplicating it in NSIS script or a separate tool.

## Building

Requires the MSVC "Desktop development with C++" workload (or just the
standalone Build Tools). Run `build.ps1` from a plain PowerShell prompt -
it locates `vcvars64.bat` itself, the same pattern
`native/multi_instance_helper/build.ps1` uses:

```powershell
.\native\launcher\build.ps1
```

Produces `Toolblox.exe` next to the source files. `release/build.py`
builds this automatically as part of packaging a Windows release and
copies it into the packaged folder.

No external dependencies beyond the Windows SDK (WinHTTP for the network
calls, CNG/`bcrypt.h` for SHA-256, `Shell.Application` COM for
extraction) - nothing to vendor, nothing pulled from the network at build
time.
