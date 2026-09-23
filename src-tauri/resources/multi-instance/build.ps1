# Rebuilds multi_instance_helper.exe with MSVC.
#
# Needs the "Desktop development with C++" workload (or just the standalone
# Build Tools) installed. Run from a plain PowerShell prompt; this script
# locates vcvars64.bat itself rather than requiring a Developer PowerShell.

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

cmd.exe /c "call `"$vcvars`" >nul && cd /d `"$dir`" && cl.exe /nologo /W4 /O2 helper.c /Fe:multi_instance_helper.exe /link kernel32.lib"

Remove-Item (Join-Path $dir "helper.obj") -ErrorAction SilentlyContinue
Write-Output "Built $(Join-Path $dir 'multi_instance_helper.exe')"
