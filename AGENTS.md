# Toolblox

Toolblox is a Windows-first, macOS-supported Tauri 2 desktop app for managing Roblox accounts
and installing reviewed game-specific widgets. `PRODUCT.md` is the product authority. The
legacy Flet implementation lives at `../Multitool` and is the behavioral and visual parity
reference during the port.

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
- Keep the implementation small. Prefer standard-library and native platform behavior over new
  dependencies or speculative abstractions.

## Code style

- Use plain, factual doc comments for non-obvious behavior. Avoid explanatory inline comments.
- Keep user-facing text short, neutral, and professional. Use sentence case, short noun or verb
  phrases for labels, and one factual sentence for descriptions. Avoid conversational filler and
  second-person asides. Use one term per concept, such as "In game", "permissions", and "this
  device". Use contractions consistently.
- Error messages state what failed, followed by a question that points toward recovery.
- Validate every trust boundary and redact cookies, tickets, authorization headers, and launch
  URLs from logs and errors.
- Preserve Windows and macOS behavior together. Platform-specific code must have a sibling path
  or an explicit unsupported state.

## UI parity

- Preserve the legacy information architecture with a minimal, neutral visual language.
- Build UI from Tailwind CSS and the shadcn/ui components in `src/components/ui` (Base UI,
  `base-nova` style). Add components with `npx shadcn@latest add <name>`. Theme tokens live in
  `src/index.css`. Don't add libraries that inject `<style>` tags at runtime; the CSP blocks them.
- Design for the default 900×500 window first. Content caps at `max-w-5xl` for fullscreen. The
  sidebar is user-resizable and snaps to icon-only when dragged narrow.
- Menus opened from a field sit flush with that field: pass the field as `anchor` to
  `DropdownMenuContent`, align to its start, and match its width (`className="min-w-0"`).
- Keep the palette neutral. Don't use purple accents. Status colors are `success`, `warning`,
  and `destructive`, and status is never conveyed by color alone.
- Use semantic HTML, visible keyboard focus, labelled controls, reduced-motion support, and
  responsive layouts. Fix inaccessible Flet interactions rather than reproducing them.
- Use the shared spacing scale: 4, 8, 12, 16, and 24 pixels.
- Radii: 8 pixels for controls (`rounded-lg`), 12 for panels (`rounded-xl`), 16 for the hero
  (`rounded-2xl`). Surfaces use tonal layering and hairline rings; only floating layers (menus,
  dialogs, toasts) get shadows. Group related rows in one `Panel` with dividers.
- Do not add actual widgets during the initial port. Implement and test the host contract.

## Verification

- Frontend changes run `npm run check` and relevant tests.
- Rust changes run `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, and
  `cargo test` from `src-tauri`.
- Security-sensitive branches, parsers, persistence, migration, updater decisions, widget
  packaging, and safe mode require focused tests.
- Do not claim parity from a build alone. Verify each workflow against the legacy implementation.
