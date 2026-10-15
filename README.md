<p align="center"><img src="public/assets/logo.svg" width="72" alt=""></p>

<h1 align="center">Toolblox</h1>

<p align="center">The source code for Toolblox, a free, open-source Roblox account manager.</p>

> [!IMPORTANT]
> **Looking to download Toolblox?** Get it from **[toolblox.dev](https://toolblox.dev/#download)**.
> This repository is for development. The files on the releases page are used by the installer
> and updater, and the "Source code" archives can't be run.

## Development

Install Node.js 22, Rust, and the [Tauri prerequisites](https://tauri.app/start/prerequisites/),
then run:

```sh
npm install
npm run tauri dev
```

`npm run dev` starts only the web interface. `npm run demo` opens the app with sample data. Debug
builds skip the update check and identify themselves as Canary. Set `TOOLBLOX_DATA_DIR` to keep
debug data separate from an installed copy.

Before opening a pull request:

```sh
npm run check
npm test
cd src-tauri
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

## Project layout

| Path | Contents |
| --- | --- |
| `src` | The React interface |
| `src-tauri` | The Rust app: persistence, credentials, Roblox, updates, and widgets |
| `site` | [toolblox.dev](https://toolblox.dev): the download page, policies, and developer docs |
| `scripts` | Release, update manifest, and license notice scripts |
| `docs` | Release process and the widget contract |

## Documentation

- [Developer docs](https://toolblox.dev/docs/) for the app and widgets
- [API docs](https://toolblox.dev/api/), generated from the Rust doc comments on every change
- [CONTRIBUTING.md](CONTRIBUTING.md) before opening an issue or pull request
- [docs/RELEASING.md](docs/RELEASING.md) for releases and [docs/WIDGETS.md](docs/WIDGETS.md) for
  the widget contract
- [PRODUCT.md](PRODUCT.md) for the product's commitments and scope

## Policies

The [privacy policy, security policy, and legal notices](https://toolblox.dev/policies/) are
published on the website, from `site/src/policies` and `site/src/pages/policies.astro`. Report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md).

Toolblox isn't affiliated with or endorsed by Roblox Corporation. It's available under the
[MIT License](LICENSE), and each release includes `THIRD-PARTY-NOTICES.txt` with the licenses of
the software it's built from.

## Acknowledgements

macOS multiple instances build on research by two community projects. No code from either is
included.

- [multi-roblox-macos](https://github.com/Insadem/multi-roblox-macos) by Insadem identified
  the `/RobloxPlayerUniq` semaphore that Roblox uses as its single-instance lock on macOS.
- [rororo-mac](https://github.com/estevanhernandez-stack-ed/rororo-mac) (MIT License)
  confirmed the technique on current Roblox versions.
