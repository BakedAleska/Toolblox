# Notes

Feature ideas to keep, change, or drop. Not a commitment; `PRODUCT.md` is still the authority.

## Accounts

### Ideas from EXOpanda Multi
- Window tiling, per-account place, FastFlags, and window size: built in 0.3.2.
- A live panel per account (uptime, FPS): dropped.

### Ruled out
- A box for pasting cookies. It puts secrets in JavaScript and normalizes the most common
  Roblox scam.
- Reading cookies from browsers or the Roblox client. It breaks "No injection" and looks like an
  infostealer.

## Advanced settings

Built in 0.3.2: FastFlags and client settings (frame rate cap, graphics quality, window size),
each with per-account overrides. Window tiling, client priority, and CPU cores per client are
normal settings, because they use OS APIs only. FastFlag presets: dropped.

- A "See advanced settings" button in Settings opens a new Advanced tab, after a confirmation.
- Holds options that write Roblox's configuration files. All of them are off by default, and
  each asks for confirmation before it turns on.
- Safe mode turns them all off.
- **Wording matters:** "No injection" means no exploits: no code in Roblox's process and no
  access to its memory. Writing configuration files Roblox reads isn't injection, so the
  commitment stays unconditional. Never write "unless" or "only when" next to it; players read
  that as "sometimes injects". Disclose the files on the Advanced tab, in the FAQ, and in the docs.
- Each item on the list shows:
  - its name and one sentence on what it does;
  - exactly what it reads, writes, or connects to (file paths, hosts, API endpoints);
  - links to the API docs it uses and to the source file that does it.
- Goal: easy to verify. Dedicated users can check the code against the list, and everyone else
  can rely on that wider review instead of trusting one developer.
- A test that pins the list to the code, like `SECRET_ACCESS`, so no file read, write, or host
  can be added without updating the list.

### Server region overlay
- Shows the server region in a small widget over the Roblox window, like Bloxstrap.
- How Bloxstrap does it: it reads the server IP from Roblox's log files, then looks it up with a
  geolocation service.
- That breaks two commitments: "No injection" (reading Roblox's files) and "Data stays on this
  device" (a connection to a third-party service, with the server IP sent to it).
- The overlay itself isn't injection: it's a separate transparent window kept on top of
  Roblox's window. Windows first. macOS needs its own path or an "unsupported" state.
- Alternative: ship it as a catalogue widget instead of a core feature. Widgets can already
  connect to services their authors choose, which keeps the core app's promises unchanged.

## Widgets in the main repo (decided)

One repo. Widgets live in `widgets/<id>/`, and a new catalogue entry is one PR. Already
recorded in `AGENTS.md` and `PRODUCT.md` (Planned Widget Capabilities). This setup ships as its
own version after 0.3.2, before any widget.

To build:
- [ ] `.github/CODEOWNERS` requiring maintainer review for everything outside `widgets/`.
- [ ] A CI check that fails a widget PR touching files outside its own `widgets/<id>/` folder.
- [ ] Path filters in `ci.yml`, so widget PRs skip the app build and app PRs skip widget checks.
- [ ] Widget checks: manifest validation, package build, hash, size limit, and a `LICENSE` with
      an OSI-approved license.
- [ ] Catalogue publishing on `widgets/**` changes, separate from `release.yml`. Signing
      already runs in `pages.yml` on `main`. Keep `CATALOGUE_PRIVATE_KEY` out of every
      workflow that runs PR code.
- [ ] Build `catalogue.json` entries from `widgets/` in `scripts/publish-updates.mjs` (it writes
      `entries: []` today).
- [ ] Update the docs site's "Getting a widget listed" steps (`catalogue.mdx`) once the PR flow
      works.
- [ ] Labels and commit scopes such as `feat(widget-<id>):` to keep widget work separate in
      history.
- Revisit a separate catalogue repo only if widget PRs start to bury app work.

## Widgets to build

### Bootstrapper (included widget)
- Does what Bloxstrap does: FastFlags, the server region, custom fonts and cursors, Discord
  status, launch options.
- One of the widgets that ship with the app. Region and per-account FastFlags could live here
  instead of in core.
- Lives in `widgets/` if the main-repo plan goes ahead.
- If it ships with the app, it counts as Toolblox for the commitments. So it's off by default,
  and everything it reads, writes, or connects to goes on the Advanced list.

## Performance for many accounts

Built in 0.3.2. Facts that shaped it:
- Roblox's FastFlag allowlist (September 2025) ignores `DFIntTaskSchedulerTargetFps`, so the
  frame rate cap goes through `FramerateCap` in `GlobalBasicSettings_<n>.xml` instead.
- Graphics quality uses `SavedQualityLevel` (Roblox's 1–10 slider) in the same file.
  `DFIntDebugFRMQualityLevelOverride` is allowlisted if that turns out not to apply.
- Both files are shared by every account, so a batch with different per-account values launches
  one at a time: write, launch, wait for the client plus 3 seconds, then the next.
- macOS paths for the settings file (`~/Library/Roblox`) aren't verified on a Mac yet.

## Download tracking

Built in `bot/` (Cloudflare Worker, slash commands). Setup steps are in `bot/README.md`.

- A Cloudflare Worker polls GitHub's release `download_count` every five minutes and DMs the
  owner the installer total, split by platform. Updates aren't counted. The app itself reports
  nothing, which keeps "Data stays on this device" true.
- Slash commands: `/link`, `/docs`, `/source`, `/version`, `/install`.
- The same bot can serve a future Toolblox Discord server.

## Tutorials

Built: `toolblox.dev/docs/install/`, linked from the download section and `/install`.