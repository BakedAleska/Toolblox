# Privacy

Last updated: October 14, 2026

Toolblox is a desktop app that runs on your device. It has no accounts, servers, analytics, or
telemetry, and the project doesn't collect, receive, sell, or share personal information.

## Data stored on this device

| Data | Where it's stored |
| --- | --- |
| Roblox sessions | Windows Credential Manager or the macOS login Keychain |
| Account names, user IDs, avatar links, and notes | The Toolblox data folder |
| Settings, recent places, and widget data | The Toolblox data folder |
| Diagnostic log | The Toolblox data folder, with sessions, join tickets, and launch links removed |

The data folder is `%LOCALAPPDATA%\Toolblox` on Windows and
`~/Library/Application Support/Toolblox` on macOS. Uninstalling keeps it. To erase everything, remove each account in
Toolblox, which also deletes its stored session, then delete the folder.

The diagnostic log is never uploaded. It leaves this device only if you copy or attach it
yourself, such as in a bug report.

## Network connections

Toolblox connects to these services directly. Each one receives your IP address and the
details of the request, under its own privacy policy.

- **Roblox** (`roblox.com`, `rbxcdn.com`, and their subdomains): to sign in through Roblox's
  own page, read account and game details, load avatars, check whether accounts are in game, and
  join games. The [Roblox privacy policy](https://www.roblox.com/info/privacy) applies.
- **GitHub** (`toolblox.dev`, `github.com`, and `githubusercontent.com`): to check for and
  download updates and the widget catalogue. Widget packages download from the address the
  catalogue lists for each one. GitHub's public release statistics count
  downloads of each file, including automatic updates, and show totals only. The
  [GitHub privacy statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement)
  applies.

## Widgets

Widgets are made by third parties. An installed widget can read the data Toolblox shows,
including account names and user IDs, and can connect to services its author chooses. No widget
can read Roblox sessions. Catalogue review checks what each widget sends and where, but each
widget's author is responsible for how it handles data. Only install widgets you trust.

## Children

Toolblox doesn't collect personal information from anyone, including children under 13.

## Changes and contact

Changes to this policy are published in this file, and its history is public in the repository.
Ask questions in a [GitHub issue](https://github.com/BakedAleska/Toolblox/issues).
