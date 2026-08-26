"""Build a distributable Toolblox package with `flet pack`.

Wraps `flet pack` (a PyInstaller-based bundler) with this project's own
packaging needs: the assets/ folder, the app icon, and, on Windows, the
native multi-instance helper. Produces a single zip in dist/, named to
match what installer/Toolblox.nsi downloads and toolblox/updater.py
checks for, and prints its sha256 so both can be updated for a release.

The zip's own top-level exe is ToolbloxApp.exe, not Toolblox.exe - the
app itself is no longer the thing users click. Toolblox.exe
(native/launcher) is the real entry point, built separately by
_build_launcher() and embedded straight into the NSIS installer instead
of shipping inside this zip: it's meant to stay stable across in-place
updates rather than be replaced by every release (see
native/launcher/README.md). A plain version.txt is written into the zip
alongside ToolbloxApp.exe so the launcher can read the installed
version without parsing a PE resource.

Every packaged build is the "beta" release channel - see
toolblox.devtools.release_channel. There's no separate packaged build for
"canary"; that's what running from source already is.

Usage: ``python release/build.py``. Run this on the platform you're
building for - it does not cross-compile. Requires `pyinstaller`
(``pip install -r requirements-dev.txt``); Windows also needs the MSVC
"Desktop development with C++" workload for native/launcher/build.ps1.
"""

import hashlib
import platform
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from toolblox.devtools import REPO_ROOT  # noqa: E402
from toolblox.startup import BUNDLE_ID  # noqa: E402
from toolblox.version import APP_VERSION  # noqa: E402

DIST_DIR = REPO_ROOT / "dist"
BUILD_DIR = REPO_ROOT / "build"


def _numeric_version() -> str:
    """APP_VERSION with any "-suffix" (e.g. "-beta") dropped."""
    return APP_VERSION.split("-")[0]


def _windows_file_version() -> str:
    """APP_VERSION as the 4-part "n.n.n.n" string --file-version needs."""
    parts = _numeric_version().split(".")
    while len(parts) < 4:
        parts.append("0")
    return ".".join(parts[:4])


def _flet_cli() -> str:
    """The `flet` console script next to the running interpreter.

    Not `python -m flet` - flet's CLI is a package, not a runnable
    module, so it only works invoked as its own console script.
    """
    script = Path(sys.executable).parent / ("flet.exe" if sys.platform == "win32" else "flet")
    return str(script) if script.exists() else "flet"


def _run_flet_pack(args: list[str]) -> None:
    """Run `flet pack` from REPO_ROOT, auto-confirming its prompts.

    Raises CalledProcessError on any nonzero exit, which stops main()
    immediately rather than continuing on to zip a partial/failed build.
    """
    subprocess.run(
        [_flet_cli(), "pack", "main.py", *args, "-y"],
        cwd=REPO_ROOT,
        check=True,
    )


def _build_launcher() -> Path:
    """Build Toolblox.exe (native/launcher) with MSVC and return its path.

    Runs native/launcher/build.ps1 via powershell.exe rather than
    reimplementing its vcvars64.bat discovery here - see that script and
    native/launcher/README.md.
    """
    launcher_dir = REPO_ROOT / "native" / "launcher"
    subprocess.run(
        [
            "powershell.exe",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(launcher_dir / "build.ps1"),
        ],
        cwd=launcher_dir,
        check=True,
    )
    return launcher_dir / "Toolblox.exe"


def _build_windows() -> Path:
    """Pack the Windows build and return its onedir output folder.

    --onedir keeps the app as a folder of files rather than a single
    exe, matching how installer/Toolblox.nsi extracts its downloaded
    zip straight into $INSTDIR - a single-file exe would have nowhere to
    put the native multi-instance helper or the assets/ folder alongside
    it.

    The packaged exe is named ToolbloxApp, not Toolblox: Toolblox.exe is
    now native/launcher's job (built here too, via _build_launcher(), but
    kept out of this zip - see this module's docstring for why). A plain
    version.txt is written into the packaged folder afterward so the
    launcher can read the installed version.

    --collect-all pythonnet/clr_loader: pywebview's Windows backend
    loads the .NET runtime through pythonnet and clr_loader.
    PyInstaller's static import analysis only grabs their importable
    modules, not the runtime config and support files clr_loader needs
    to actually initialize the CLR at startup. Without them, the exe
    still builds and imports fine, but fails at runtime on a clean
    machine with "Failed to resolve Python.Runtime.Loader.Initialize"
    the first time a user opens the Roblox login window - the exact
    failure a clean machine hits that a dev environment with .NET
    tooling already installed doesn't.

    Each --collect-all value below is its own repeated
    --pyinstaller-build-args=<value> rather than one occurrence with
    both values space-separated: flet-cli's --pyinstaller-build-args
    uses argparse's nargs="*", which refuses to consume a "-"-prefixed
    token as a plain value (it reads as an unrecognized flag instead)
    unless it's attached with "=" - and that "=" form only ever
    supplies one value per occurrence of the flag.
    """
    helper = (
        REPO_ROOT / "native" / "multi_instance_helper" / "multi_instance_helper.exe"
    )
    if not helper.exists():
        raise SystemExit(
            f"Missing {helper}. Build it first: see native/multi_instance_helper/README.md."
        )

    _build_launcher()

    _run_flet_pack(
        [
            "--name",
            "ToolbloxApp",
            "--icon",
            "installer/app_icon.ico",
            "--product-name",
            "Toolblox",
            "--product-version",
            _numeric_version(),
            "--file-version",
            _windows_file_version(),
            "--company-name",
            "BakedAleska",
            "--copyright",
            "BakedAleska",
            "--onedir",
            "--add-data",
            "assets:assets",
            "--add-binary",
            f"{helper}:native",
            "--distpath",
            str(DIST_DIR),
            "--pyinstaller-build-args=--collect-all=pythonnet",
            "--pyinstaller-build-args=--collect-all=clr_loader",
        ]
    )
    bundle = DIST_DIR / "ToolbloxApp"
    (bundle / "version.txt").write_text(APP_VERSION + "\n", encoding="utf-8")
    return bundle


def _build_macos() -> Path:
    """Pack the macOS build and return the resulting .app bundle.

    Unsigned - Gatekeeper will require a right-click -> Open the first
    time a user runs it. Signing/notarization is a deliberately
    deferred decision.
    """
    _run_flet_pack(
        [
            "--name",
            "Toolblox",
            "--icon",
            "installer/app_icon.icns",
            "--bundle-id",
            BUNDLE_ID,
            "--product-name",
            "Toolblox",
            "--product-version",
            _numeric_version(),
            "--add-data",
            "assets:assets",
        ]
    )
    return DIST_DIR / "Toolblox.app"


def _zip_bundle(bundle: Path, dest: Path, *, flatten: bool) -> None:
    """Zip `bundle` to `dest`.

    flatten=True writes paths relative to the bundle itself, so its
    *contents* land at the zip root (what installer/Toolblox.nsi's
    "Toolblox.exe --extract" step expects to extract straight into
    $INSTDIR). flatten=False keeps the
    bundle's own folder name as the zip's top-level entry (what a
    macOS .app needs, so unzipping it hands back a real .app to drag
    into Applications instead of loose Contents/ files).

    as_posix() on the arcname matters on Windows: zipfile stores
    whatever separator relative_to() gives it verbatim, which on
    Windows is a backslash, and the ZIP spec requires "/" - a
    backslash-named entry extracts as a flat, oddly-named file instead
    of a real subdirectory.
    """
    dest.unlink(missing_ok=True)
    root = bundle if flatten else bundle.parent
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in bundle.rglob("*"):
            if path.is_file():
                zf.write(path, path.relative_to(root).as_posix())


def main() -> None:
    """Build this platform's package, zip it, and print its sha256.

    Dispatches on the host OS rather than cross-compiling. Removes
    PyInstaller's own build/ scratch directory afterward so it doesn't
    linger between runs; dist/ (the zip itself) is left in place.
    """
    DIST_DIR.mkdir(exist_ok=True)
    system = platform.system()

    if system == "Windows":
        bundle = _build_windows()
        zip_path = DIST_DIR / f"Toolblox-{APP_VERSION}-windows.zip"
        _zip_bundle(bundle, zip_path, flatten=True)
    elif system == "Darwin":
        bundle = _build_macos()
        zip_path = DIST_DIR / f"Toolblox-{APP_VERSION}-macos.zip"
        _zip_bundle(bundle, zip_path, flatten=False)
    else:
        raise SystemExit(f"Unsupported platform for packaging: {system}")

    if BUILD_DIR.exists():
        shutil.rmtree(BUILD_DIR)

    with zip_path.open("rb") as f:
        digest = hashlib.file_digest(f, "sha256").hexdigest()
    print(f"Built {zip_path}")
    print(f"sha256: {digest}")


if __name__ == "__main__":
    main()
