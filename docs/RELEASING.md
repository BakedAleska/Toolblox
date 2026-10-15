# Releasing Toolblox

## Publish a release

1. Open **Actions → Release → Run workflow** on `main`.
2. Enter the new version without the leading `v`, such as `0.3.0-beta`. It must be newer than
   the current one.
3. Run it. Tick **Build only** first to test a build without publishing anything.

The workflow sets the version in every file, runs the checks, builds and signs the Windows
installer on Windows and the universal macOS app on macOS in parallel, commits
`chore(release): <version>`, tags `v<version>`, and publishes a GitHub release with
`Toolblox-Setup.exe`, `Toolblox.dmg`, their updater files, notes generated from `feat`, `fix`,
and `perf` commits, and both SHA-256 digests. It then deploys the update manifest, so installed apps update the next
time they open.

Use Conventional Commits so the notes stay accurate. `scripts/set-version.mjs` and
`scripts/release-notes.mjs` can also run locally.

## Update manifest

Release builds are fail-closed. On every launch they download a signed update manifest and refuse
to open if it's missing, invalid, or expired. Debug builds skip this check.

The Pages workflow (`.github/workflows/pages.yml`) re-signs the manifest daily, after every
release, and on demand. Each manifest is valid for seven days. The workflow re-enables itself on
every run, because GitHub disables scheduled workflows after 60 days without repository activity.
GitHub notifies the account that last changed the schedule when a scheduled run fails.

If the manifest ever expires, run **Actions → Pages → Run workflow**. Installed apps open again
on their next launch.

## Pages deployments

`pages.yml` is the only workflow that deploys GitHub Pages. The Release and Docs workflows call
it instead of deploying themselves, and only `main` may deploy to the `github-pages` environment.
Deploys run one at a time. After each one, every deployment except the newest successful one is
deleted, so the repository keeps a single deployment.

The site contains the Astro project in `site/` (the download page, and the widget docs built with
Starlight under `/docs/`), the update manifest and widget catalogue, and the API docs under
`/api/`. The Docs workflow regenerates the API docs with rustdoc whenever Rust
code changes and replaces the `docs` branch with a single commit of the output.

## Domain

`toolblox.dev` is registered with Cloudflare. A Cloudflare Worker named `toolblox-site`, routed
to `toolblox.dev/*`, serves the Pages site at that domain:

```js
export default {
  fetch(request) {
    const { pathname, search } = new URL(request.url);
    return fetch(`https://bakedaleska.github.io/Toolblox${pathname}${search}`);
  },
};
```

The app's HTTP client doesn't follow redirects, and builds up to 0.2.0 beta fetch from
`bakedaleska.github.io`. Don't add a `CNAME` to Pages or a Cloudflare redirect rule: either one
answers one set of builds with a redirect, and those apps stop opening once their manifest
expires. Builds made after 0.2.0 beta fetch from `toolblox.dev`. Once no supported build uses
`github.io`, Pages can take the custom domain directly and the Worker can be removed.

## Endpoints and keys

| Value | Where it lives |
| --- | --- |
| Update manifest | `https://toolblox.dev/updates/stable.json` and `.sig` |
| Widget catalogue | `https://toolblox.dev/catalogue/v1.json` and `.sig` |
| Manifest public key | `EuDCNgMRTr2hMG4/aNBJH2gFK/i6VAkQRlc1YFSlh1U=` |
| Catalogue public key | `SRsx1ZzYpQGnV6NhPa00Mt5I6xubH3DXuNdGOfbQSVE=` |
| Updater public key | `plugins.updater.pubkey` in `src-tauri/tauri.conf.json` |

The private keys are the `MANIFEST_PRIVATE_KEY`, `CATALOGUE_PRIVATE_KEY`,
`TAURI_SIGNING_PRIVATE_KEY`, and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` repository secrets. GitHub
secrets can't be read back, so keep an offline copy. Losing or leaking a key means shipping a
build with a new public key, which existing installs can't update to automatically.

## Assets

Every release has one download per platform, `Toolblox-Setup.exe` for Windows and
`Toolblox.dmg` for macOS. The updater uses `Toolblox-Update.exe` (the same bytes as the Windows
installer), `Toolblox.app.tar.gz` (the universal macOS app, listed as `darwin-aarch64` and
`darwin-x86_64` in the manifest), and their `.sig` files. Releases also include
`THIRD-PARTY-NOTICES.txt`, which `scripts/third-party-notices.mjs` generates from
the Rust crates and npm packages in the build. Settings links to the notices of the installed
version. The README and download page link to
`releases/latest/download/Toolblox-Setup.exe` and `releases/latest/download/Toolblox.dmg`, so
the names must not change. Don't attach ZIP
files; people extract them and try to run the app without installing it.

macOS builds are ad-hoc signed (`tauri.macos.conf.json`) and not notarized. The manifest lists
the macOS archive only when the latest release has one. Release builds refuse to open without an
entry for their platform, so every release must include both platforms.

## Usage

Toolblox has no telemetry. Updates and manifest builds download `Toolblox-Update.exe` and
`Toolblox.app.tar.gz`, so the `Toolblox-Setup.exe` and `Toolblox.dmg` counts are manual downloads
only and the `Toolblox-Update.exe` count approximates updates. Releases without `Toolblox-Update.exe` mix both, plus one download per
Pages deploy, and the download page leaves them out:

```sh
gh api repos/BakedAleska/Toolblox/releases --jq '.[] | "\(.tag_name) \([.assets[] | "\(.name)=\(.download_count)"] | join(" "))"'
```
