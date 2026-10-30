# Toolblox

Toolblox is a Windows-first, macOS-supported Tauri 2 desktop app for managing Roblox accounts
and installing reviewed game-specific widgets. `PRODUCT.md` is the product authority.

## Stack and boundaries

- React, TypeScript, and Vite render the interface.
- Rust owns persistence, credentials, network calls, Roblox launch behavior, processes, updates,
  the system tray, autostart, and widget packaging.
- Secrets never cross into JavaScript. React receives account display data and opaque IDs only.
  This also applies to widgets, which run in the same JavaScript context as the interface.
- Module widgets (`src/widgets/host.tsx`) are full-trust: they receive the host API, the app's
  React components, and every IPC method. Don't add artificial limits to that API. Safety comes
  from catalogue review, signed and hash-pinned packages, safe mode, and error boundaries.
- Remote pages receive no Tauri capabilities. Legacy iframe widget surfaces stay sandboxed.
- Tests pin every place a session secret is read or exposed (`SECRET_ACCESS` in
  `credentials.rs`) and the main webview's permissions and CSP (`lib.rs`). Changing either list
  needs security review. Widget IPC responses that contain a session cookie are blocked.
- Keep the implementation small. Prefer standard-library and native platform behavior over new
  dependencies or speculative abstractions.

## Code style

- Use plain, factual doc comments for non-obvious behavior. Avoid explanatory inline comments.
- Repeat the three core commitments in `PRODUCT.md` (free and open source, no injection, data
  stays on this device) with their exact titles. Never claim Roblox Terms of Use compliance, and
  don't add a feature that would make a commitment untrue.
- Keep user-facing text short, neutral, and professional. Use sentence case, short noun or verb
  phrases for labels, and one factual sentence for descriptions. Avoid conversational filler and
  second-person asides. Use one term per concept, such as "In game", "permissions", and "this
  device". Use contractions consistently.
- Error messages state what failed, followed by a question that points toward recovery.
- Validate every trust boundary and redact cookies, tickets, authorization headers, and launch
  URLs from logs and errors.
- Preserve Windows and macOS behavior together. Platform-specific code must have a sibling path
  or an explicit unsupported state.

## UI

- Keep the information architecture stable, with a minimal, neutral visual language.
- Build UI from Tailwind CSS and the shadcn/ui components in `src/components/ui` (Base UI,
  `base-nova` style). Add components with `npx shadcn@latest add <name>`. Theme tokens live in
  `src/index.css`. Don't add libraries that inject `<style>` tags at runtime; the CSP blocks them.
- Design for the default 900×500 window first. Larger windows get more columns, not more
  whitespace: `Screen` is a container capped at `max-w-[120rem]`, and pages switch layout with
  `@5xl:` and wider container queries. The sidebar is user-resizable and snaps to icon-only when
  dragged narrow.
- Menus opened from a field sit flush with that field: pass the field as `anchor` to
  `DropdownMenuContent`, align to its start, match its width (`className="min-w-0"`), and pass
  `arrow={false}`. Other menus keep the arrow that points at their trigger.
- Style only through the tokens in `src/theme.css`. Never hardcode a color, radius, or shadow
  color, in class names or inline styles. A custom theme overrides these tokens, and
  `src/globals.test.ts` enforces this. Add a token when a new value is needed.
- Keep the palette neutral. Don't use purple accents. Status colors are `success`, `warning`,
  and `destructive`, and status is never conveyed by color alone.
- Use semantic HTML, visible keyboard focus, labelled controls, reduced-motion support, and
  responsive layouts.
- Dialogs use `Modal` with one of two fixed sizes: `portrait` for forms and lists, `landscape`
  for short messages and confirmations. Related dialogs share a size. Don't add other sizes.
- Use the shared spacing scale: 4, 8, 12, 16, and 24 pixels.
- Radii: 6 pixels for controls (`rounded-lg`), 9 for panels (`rounded-xl`), 12 for the hero
  (`rounded-2xl`). Surfaces use tonal layering and hairline rings; only floating layers (menus,
  dialogs, toasts) get shadows. Group related rows in one `Panel` with dividers.
- Catalogue widgets live only in `widgets/<id>/`, each with its own `LICENSE`. App code never
  imports from `widgets/`. App tests cover the host contract, not specific widgets.
- A widget pull request changes only its own `widgets/<id>/` folder. Only the workflow that runs
  on `main` after merge can use the catalogue signing key.

## Changelogs

- Each version has `changelogs/<version>.md`, such as `changelogs/0.4.0-beta.md`. Every
  user-facing change adds a line to the unreleased version's file, marked `*Unreleased*` until the
  release sets the date.
- Write for players, in plain language, with enough detail to find and use each change. The bot
  posts each file to Discord as embeds: use headings, bold, and bullets only, no tables or HTML.
- A line with only `---` starts a new message. Separate new features, changes, and fixes this
  way. Keep each message under 4,096 characters.
- Describe what changed for the user, not the code. Leave out refactors, tests, and CI.

## Verification

- Frontend changes run `npm run check` and relevant tests.
- Rust changes run `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, and
  `cargo test` from `src-tauri`.
- Security-sensitive branches, parsers, persistence, migration, updater decisions, widget
  packaging, and safe mode require focused tests.
- Don't claim a workflow works from a build alone. Verify it in the running app.
