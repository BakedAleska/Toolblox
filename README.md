<p align="center"><img src="public/assets/logo.svg" width="72" alt=""></p>

<h1 align="center">Toolblox</h1>

<p align="center">A local-first desktop app for managing and launching Roblox accounts.</p>

<p align="center"><a href="https://github.com/BakedAleska/Toolblox/releases/latest/download/Toolblox-Setup.exe"><b>Download for Windows</b></a> · <a href="https://github.com/BakedAleska/Toolblox/releases/latest/download/Toolblox.dmg"><b>Download for macOS</b></a> · <a href="https://toolblox.dev/">Website</a> · <a href="https://github.com/BakedAleska/Toolblox/releases">Releases</a></p>

> [!IMPORTANT]
> Toolblox is installed with **Toolblox-Setup.exe** on Windows and **Toolblox.dmg** on macOS.
> The "Source code (zip)" files on the releases page contain the source code, not the app, and
> can't be run.

## Install

**Windows 10 and 11**

1. Download [Toolblox-Setup.exe](https://github.com/BakedAleska/Toolblox/releases/latest/download/Toolblox-Setup.exe).
2. Open it. If Windows shows "Windows protected your PC", select **More info**, then
   **Run anyway**. Toolblox isn't code-signed yet, so Windows doesn't recognize the publisher.
3. Follow the setup steps. No administrator rights are needed.

Toolblox checks for updates each time it opens and installs them automatically.

**macOS (Apple silicon and Intel)**

The first macOS build is published with the next release.

1. Download [Toolblox.dmg](https://github.com/BakedAleska/Toolblox/releases/latest/download/Toolblox.dmg).
2. Open it and drag Toolblox to Applications.
3. Open Toolblox. If macOS says it can't verify the developer, select **Done**, then open
   **System Settings → Privacy & Security** and select **Open Anyway**. Toolblox isn't
   notarized yet, so macOS doesn't recognize the developer.

Roblox must be installed in Applications.

**Upgrading from 0.1.x**: the older Python version doesn't update itself to this one. Install
Toolblox-Setup.exe once. Accounts, notes, and settings from the older version are imported on
first launch.

## Features

- Add Roblox accounts through the official sign-in page and join games with one or several at
  once.
- Set a default place, override it per account, and rejoin recent places from the dashboard.
- See which accounts are in game, get notified when one disconnects, and optionally rejoin
  automatically.
- Run several Roblox clients at the same time on Windows and macOS.
- Install reviewed widgets from a signed catalogue. No widgets are published yet.

## Privacy and security

- Account names, notes, settings, and widget data stay in the local Toolblox data folder.
- Roblox sessions are stored in Windows Credential Manager or the macOS login Keychain. They
  aren't exposed to the interface, widgets, logs, or any Toolblox server.
- A diagnostic log stays in the data folder and is never uploaded. Cookies, join tickets, and
  launch links are removed before each line is written. **Settings > Diagnostics** can show,
  copy, or open it for bug reports.
- Toolblox has no hosted account database and no telemetry. It contacts Roblox to sign in, join,
  and check status, and GitHub Pages to check for updates and widgets.
- Updates are checked against a signed, short-lived manifest with rollback protection, and each
  installer carries its own signature.
- Widget packages are signed, hash-checked, and reviewed before they're listed. Installed module
  widgets run with the same access as the app, so only install widgets you trust.

Uninstalling keeps local data so an accidental uninstall doesn't erase accounts. Delete
`%LOCALAPPDATA%\Toolblox` to remove it. See [PRIVACY.md](PRIVACY.md) for every network connection
and [SECURITY.md](SECURITY.md) to report a vulnerability.

## Disclaimer

Toolblox isn't affiliated with, endorsed by, or sponsored by Roblox Corporation. Roblox is a
trademark of Roblox Corporation.

Using Toolblox is subject to the [Roblox Terms of Use](https://www.roblox.com/info/terms).
Roblox decides how its terms apply to third-party tools and may restrict accounts that use them.
Toolblox is provided as is, without warranty, under the [MIT License](LICENSE).

## Development

Install Node.js 22, Rust, and the [Tauri prerequisites](https://tauri.app/start/prerequisites/),
then run:

```powershell
npm install
npm run tauri dev
```

`npm run dev` starts only the web interface. `npm run demo` opens the app with sample data.
Debug builds skip the update check. Set `TOOLBLOX_DATA_DIR` to keep debug data separate.

Before opening a pull request:

```powershell
npm run check
npm test
cd src-tauri
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

The [API docs](https://toolblox.dev/api/) are generated from the Rust doc
comments on every change. See [CONTRIBUTING.md](CONTRIBUTING.md),
[docs/RELEASING.md](docs/RELEASING.md) for releases, and [docs/WIDGETS.md](docs/WIDGETS.md) for the
widget contract.

Toolblox is available under the [MIT License](LICENSE). Each release includes
`THIRD-PARTY-NOTICES.txt` with the licenses of the software it's built from.

## Acknowledgements

macOS multiple instances build on research by two community projects. No code from either is
included.

- [multi-roblox-macos](https://github.com/Insadem/multi-roblox-macos) by Insadem identified
  the `/RobloxPlayerUniq` semaphore that Roblox uses as its single-instance lock on macOS.
- [rororo-mac](https://github.com/estevanhernandez-stack-ed/rororo-mac) (MIT License)
  confirmed the technique on current Roblox versions.
