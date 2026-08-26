; Toolblox installer (beta).
;
; This is a bootstrapper, not a full offline installer: it downloads the
; actual application build from a GitHub release at install time instead of
; embedding it, so the installer itself stays small. It does embed
; Toolblox.exe (native/launcher, see that folder's README) directly, since
; that's what actually verifies and extracts the downloaded build - see the
; "Toolblox.exe --extract" section below for why.
;
; MyAppVersion, DownloadURL, and DownloadSHA256 have no checked-in default -
; a stale or placeholder value here would compile fine and then fail (or
; silently point at the wrong release) only later, at install time, which
; is a much worse place to discover it. Compiling always requires passing
; all three via makensis's own /D flag:
;   makensis /DMyAppVersion=1.0.0 /DDownloadURL=https://... /DDownloadSHA256=... Toolblox.nsi
; .github/workflows/release.yml does this automatically for a real release,
; computing DownloadSHA256 from the zip `python release/build.py` just
; produced, and building native/launcher/Toolblox.exe first so it's ready
; to embed. For a manual local compile, run both of those first and pass
; the printed sha256 the same way.
;
; Replaces the old Inno Setup script (installer/Toolblox.iss): same overall
; bootstrapper shape (small installer, real build downloaded at install
; time, desktop-shortcut task, launch-on-finish option), rebuilt on NSIS
; with the file-verification/extraction work done by Toolblox.exe itself
; instead of Inno's built-in downloader - see native/launcher/README.md for
; why that logic lives there now instead of in a separate updater helper.

!define MyAppName "Toolblox"
!ifndef MyAppVersion
  !error "MyAppVersion is not defined. Compile with /DMyAppVersion=<version>."
!endif
!define MyAppPublisher "BakedAleska"
!define MyAppExeName "Toolblox.exe"
!define MyAppRepo "BakedAleska/Toolblox"
!ifndef DownloadURL
  !error "DownloadURL is not defined. Compile with /DDownloadURL=<url>."
!endif
!define DownloadFileName "Toolblox-windows.zip"
!ifndef DownloadSHA256
  !error "DownloadSHA256 is not defined. Compile with /DDownloadSHA256=<sha256>."
!endif

!define UninstallRegKey "Software\Microsoft\Windows\CurrentVersion\Uninstall\${MyAppName}"

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "nsDialogs.nsh"
!include "WinMessages.nsh"

Name "${MyAppName}"
OutFile "Output\ToolbloxSetup-${MyAppVersion}.exe"
InstallDir "$LOCALAPPDATA\Programs\${MyAppName}"
InstallDirRegKey HKCU "${UninstallRegKey}" "InstallLocation"
RequestExecutionLevel user
SetCompressor /SOLID lzma
VIProductVersion "${MyAppVersion}.0"
VIAddVersionKey "ProductName" "${MyAppName}"
VIAddVersionKey "CompanyName" "${MyAppPublisher}"
VIAddVersionKey "FileDescription" "${MyAppName} installer (beta)"
VIAddVersionKey "FileVersion" "${MyAppVersion}"

!define MUI_ICON "app_icon.ico"
!define MUI_UNICON "app_icon.ico"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\${MyAppExeName}"
!define MUI_FINISHPAGE_RUN_TEXT "Launch ${MyAppName}"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
Page Custom TasksPageShow TasksPageLeave
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

Var DesktopShortcutCheckbox
Var CreateDesktopShortcut

; A single custom checkbox page for "Create a desktop shortcut" - NSIS's
; stock Components page is meant for optional install *sections*, not a
; single yes/no task, so this is a small hand-rolled page instead (the
; same purpose Toolblox.iss's [Tasks] "desktopicon" entry served).
Function TasksPageShow
    !insertmacro MUI_HEADER_TEXT "Additional Tasks" "Choose additional tasks."
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
        Abort
    ${EndIf}

    ${NSD_CreateCheckBox} 0 0 100% 12u "Create a desktop shortcut"
    Pop $DesktopShortcutCheckbox

    nsDialogs::Show
FunctionEnd

Function TasksPageLeave
    ${NSD_GetState} $DesktopShortcutCheckbox $CreateDesktopShortcut
FunctionEnd

Function .onInit
    ; If an earlier install is registered, run its own uninstaller first
    ; (silently) before laying down a fresh copy - this is the "look for
    ; an existing install and use its uninstaller" behavior asked for,
    ; without requiring the user to do it by hand first. A failure here
    ; isn't treated as fatal: worst case, files just get overwritten by
    ; the install steps below, which the extract step already does
    ; unconditionally.
    ReadRegStr $0 HKCU "${UninstallRegKey}" "UninstallString"
    ${If} $0 != ""
        DetailPrint "Removing the existing ${MyAppName} install..."
        ExecWait '"$0" /S _?=$INSTDIR'
    ${EndIf}
FunctionEnd

Section "Install"
    SetOutPath "$INSTDIR"

    ; Close a running instance so its files aren't locked. Best-effort:
    ; taskkill returns nonzero if the process isn't running, which is the
    ; common case and not an error worth stopping the install over.
    ExecWait 'taskkill /IM ToolbloxApp.exe /F' $0
    ExecWait 'taskkill /IM ${MyAppExeName} /F' $0

    ; Toolblox.exe itself ships embedded in the installer (native/launcher,
    ; built by release/build.py before this script is compiled - see
    ; .github/workflows/release.yml), not downloaded: something has to be
    ; on disk already to verify and extract the actual app build below.
    File "..\native\launcher\${MyAppExeName}"

    DetailPrint "Downloading ${MyAppName}..."
    ExecWait 'curl.exe -fL --retry 3 -o "$TEMP\${DownloadFileName}" "${DownloadURL}"' $0
    ${If} $0 != 0
        MessageBox MB_OK|MB_ICONSTOP "Couldn't download ${MyAppName}. Check your internet connection and try again."
        Abort
    ${EndIf}

    DetailPrint "Verifying and installing ${MyAppName}..."
    ExecWait '"$INSTDIR\${MyAppExeName}" --extract "$TEMP\${DownloadFileName}" "${DownloadSHA256}" "$INSTDIR"' $0
    Delete "$TEMP\${DownloadFileName}"
    ${If} $0 != 0
        MessageBox MB_OK|MB_ICONSTOP "The downloaded ${MyAppName} build didn't verify correctly. Try running the installer again."
        Abort
    ${EndIf}

    CreateDirectory "$SMPROGRAMS\${MyAppName}"
    CreateShortcut "$SMPROGRAMS\${MyAppName}\${MyAppName}.lnk" "$INSTDIR\${MyAppExeName}"
    CreateShortcut "$SMPROGRAMS\${MyAppName}\Uninstall ${MyAppName}.lnk" "$INSTDIR\Uninstall.exe"
    ${If} $CreateDesktopShortcut == ${BST_CHECKED}
        CreateShortcut "$DESKTOP\${MyAppName}.lnk" "$INSTDIR\${MyAppExeName}"
    ${EndIf}

    WriteUninstaller "$INSTDIR\Uninstall.exe"

    WriteRegStr HKCU "${UninstallRegKey}" "DisplayName" "${MyAppName}"
    WriteRegStr HKCU "${UninstallRegKey}" "DisplayVersion" "${MyAppVersion}"
    WriteRegStr HKCU "${UninstallRegKey}" "Publisher" "${MyAppPublisher}"
    WriteRegStr HKCU "${UninstallRegKey}" "InstallLocation" "$INSTDIR"
    WriteRegStr HKCU "${UninstallRegKey}" "DisplayIcon" "$INSTDIR\${MyAppExeName}"
    WriteRegStr HKCU "${UninstallRegKey}" "UninstallString" "$INSTDIR\Uninstall.exe"
    WriteRegStr HKCU "${UninstallRegKey}" "QuietUninstallString" "$INSTDIR\Uninstall.exe /S"
    WriteRegDWORD HKCU "${UninstallRegKey}" "NoModify" 1
    WriteRegDWORD HKCU "${UninstallRegKey}" "NoRepair" 1
SectionEnd

Section "Uninstall"
    ExecWait 'taskkill /IM ToolbloxApp.exe /F' $0
    ExecWait 'taskkill /IM ${MyAppExeName} /F' $0

    RMDir /r "$INSTDIR"

    Delete "$SMPROGRAMS\${MyAppName}\${MyAppName}.lnk"
    Delete "$SMPROGRAMS\${MyAppName}\Uninstall ${MyAppName}.lnk"
    RMDir "$SMPROGRAMS\${MyAppName}"
    Delete "$DESKTOP\${MyAppName}.lnk"

    DeleteRegKey HKCU "${UninstallRegKey}"

    ; Account data, settings, and installed widgets (%LOCALAPPDATA%\Toolblox
    ; - toolblox/config.py's DATA_DIR, deliberately not $INSTDIR) are left
    ; alone: uninstalling the app shouldn't silently delete a user's saved
    ; accounts. They're removing that on purpose if they want it gone.
SectionEnd
