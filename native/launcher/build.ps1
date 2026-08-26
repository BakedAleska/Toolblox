# Rebuilds Toolblox.exe (the native launcher) with MSVC.
#
# Needs the "Desktop development with C++" workload (or just the standalone
# Build Tools). Run from a plain PowerShell prompt; this script locates
# vcvars64.bat itself rather than requiring a Developer PowerShell - the
# same pattern native/multi_instance_helper/build.ps1 uses.

$ErrorActionPreference = "Stop"

$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $vswhere)) {
    throw "vswhere.exe not found. Install Visual Studio Build Tools first."
}

$vsPath = & $vswhere -latest -products '*' `
    -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
    -property installationPath
if (-not $vsPath) {
    throw "No Visual Studio install with the C++ build tools was found."
}

$vcvars = Join-Path $vsPath "VC\Auxiliary\Build\vcvars64.bat"
$dir = $PSScriptRoot

$sources = "main.cpp http.cpp json.cpp sha256.cpp version.cpp extract.cpp update.cpp log.cpp"
$libs = "user32.lib gdi32.lib comctl32.lib shell32.lib shlwapi.lib ole32.lib oleaut32.lib " +
        "winhttp.lib bcrypt.lib comdlg32.lib"

Remove-Item (Join-Path $dir "Toolblox.exe") -ErrorAction SilentlyContinue

$rc = "rc.exe /nologo /fo launcher.res launcher.rc"
$cl = "cl.exe /nologo /W4 /EHsc /O2 /DUNICODE /D_UNICODE $sources launcher.res " +
      "/Fe:Toolblox.exe /link $libs /SUBSYSTEM:WINDOWS"

cmd.exe /c "call `"$vcvars`" >nul && cd /d `"$dir`" && $rc && $cl"

if (-not (Test-Path (Join-Path $dir "Toolblox.exe"))) {
    throw "Build failed - see compiler output above."
}
Remove-Item (Join-Path $dir "*.obj") -ErrorAction SilentlyContinue
Remove-Item (Join-Path $dir "*.res") -ErrorAction SilentlyContinue
Write-Output "Built $(Join-Path $dir 'Toolblox.exe')"
