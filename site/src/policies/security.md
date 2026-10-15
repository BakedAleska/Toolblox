---
title: Security policy
description: How to check a download is genuine, how Toolblox protects your sessions, and how to report a vulnerability.
updated: October 15, 2026
---

### Verify a download

Toolblox doesn't have a paid Windows code-signing certificate, and macOS builds are ad-hoc signed
but not notarized by Apple. Both systems show a warning the first time Toolblox opens. On macOS,
select **Done**, then open **System Settings → Privacy & Security** and select **Open Anyway**.
Before running a download:

1. Download Toolblox only from the [download section](/#download) of this website. Its button
   links to the official GitHub release.
2. Compare the file's SHA-256 digest with the one published in the release notes. On Windows, in
   PowerShell:

   ```
   Get-FileHash .\Toolblox-Setup.exe
   ```

   On macOS, in Terminal:

   ```
   shasum -a 256 ~/Downloads/Toolblox.dmg
   ```

3. If the digests don't match, or the release has no digest, don't run the file.

Scanning the file with an antivirus service such as [VirusTotal](https://www.virustotal.com) is
supporting evidence, not a guarantee. Installed copies also verify a signed update manifest and the
signature of every update before the main window opens. Development builds identify themselves as
Canary and aren't releases.

### How sessions are protected

Toolblox stores Roblox sessions in Windows Credential Manager or the macOS login Keychain. Sessions
never reach the app's interface, widgets, logs, account files, or error messages, and Toolblox has
no server or telemetry that could receive them. Accounts are added through Roblox's own sign-in
page, so Toolblox never sees a password.

### Report a vulnerability

Don't open a public issue for an unpatched vulnerability involving sessions, updates, widget
isolation, or running code. Contact the repository owner privately through
[GitHub](https://github.com/BakedAleska). Include the affected version, platform, steps to
reproduce, and expected impact. Remove Roblox sessions, authentication tickets, and personal data
from every report.
