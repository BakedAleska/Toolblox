# Releasing Toolblox

Release builds are fail-closed. On every launch they download a signed update manifest and refuse
to open if it's missing, invalid, or expired. Debug builds skip this check.

## Endpoints and keys

| Value | Where it lives |
| --- | --- |
| Update manifest | `https://bakedaleska.github.io/Toolblox/updates/stable.json` and `.sig` |
| Widget catalogue | `https://bakedaleska.github.io/Toolblox/catalogue/v1.json` and `.sig` |
| Manifest public key | `EuDCNgMRTr2hMG4/aNBJH2gFK/i6VAkQRlc1YFSlh1U=` |
| Catalogue public key | `SRsx1ZzYpQGnV6NhPa00Mt5I6xubH3DXuNdGOfbQSVE=` |
| Updater public key | `plugins.updater.pubkey` in `src-tauri/tauri.conf.json` |
| Private keys | Outside the repository. The manifest and catalogue seeds are also the `MANIFEST_PRIVATE_KEY` and `CATALOGUE_PRIVATE_KEY` repository secrets. |

Losing a private key means shipping a new build with a new public key. Leaking one means
rotating it the same way.

## Signed manifest

The Pages workflow (`.github/workflows/pages.yml`) runs `scripts/publish-updates.mjs` twice a
day and whenever a release is published. It reads the latest GitHub release, hashes its
`Toolblox-Setup.exe`, reads `Toolblox-Setup.exe.sig`, and publishes a manifest valid for seven
days together with the download page in `site/`.

GitHub disables scheduled workflows after 60 days without repository activity. If that happens,
installed apps stop opening within seven days. Re-enable the workflow from the Actions tab and run
it manually.

## Windows release

1. Bump the version in `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, and
   `src-tauri/tauri.conf.json`, then commit.
2. Build the installer with the release values set:

   ```powershell
   $env:TOOLBLOX_UPDATE_MANIFEST_URL = "https://bakedaleska.github.io/Toolblox/updates/stable.json"
   $env:TOOLBLOX_MANIFEST_PUBLIC_KEY = "EuDCNgMRTr2hMG4/aNBJH2gFK/i6VAkQRlc1YFSlh1U="
   $env:TOOLBLOX_UPDATER_PUBLIC_KEY = (Get-Content src-tauri/tauri.conf.json | ConvertFrom-Json).plugins.updater.pubkey
   $env:TOOLBLOX_CATALOGUE_URL = "https://bakedaleska.github.io/Toolblox/catalogue/v1.json"
   $env:TOOLBLOX_CATALOGUE_PUBLIC_KEY = "SRsx1ZzYpQGnV6NhPa00Mt5I6xubH3DXuNdGOfbQSVE="
   $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw <path to tauri-updater.key>
   $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = Get-Content -Raw <path to tauri-updater.password>
   npm run tauri build -- --bundles nsis
   ```

3. Rename `src-tauri/target/release/bundle/nsis/Toolblox_<version>_x64-setup.exe` to
   `Toolblox-Setup.exe`, and its `.sig` to `Toolblox-Setup.exe.sig`. The README and download
   page link to `releases/latest/download/Toolblox-Setup.exe`, so the name must stay the same.
4. Publish a GitHub release tagged `v<version>` with only those two files and the SHA-256 in the
   notes. Don't attach ZIP files; people extract them and try to run the app without installing
   it. Publishing triggers the Pages workflow, which moves every installed app to the new version
   on its next launch.

macOS builds need `npm run tauri build -- --bundles app,dmg` on macOS and a `darwin-*` entry in
the manifest. They aren't published yet.
