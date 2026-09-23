# Product

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

## Stack

- Tauri 2 provides the native Windows and macOS application shell.
- React, TypeScript, and Vite provide the interface and widget UI layer.
- Rust owns privileged native behavior, security-sensitive data, Roblox integration, process
  control, installation support, and the pre-UI update path.
- Windows releases use an NSIS installer. macOS releases use an application bundle and DMG.

## Users

Toolblox is primarily for Windows-based Roblox players who manage multiple accounts. macOS
users are a supported secondary audience. The project also serves outside contributors who
build and share game-specific widgets.

## Product Purpose

Toolblox lets players manage and launch multiple Roblox accounts safely from one local desktop
app, then extend the app with game-specific widgets. Success means growing it into a useful,
trusted open-source community product.

The current Flet application is the behavioral and visual reference for a full port. The new
application must preserve every core feature and closely reproduce its sleek interface. Legacy
widget implementations aren't part of the initial port, but the widget platform, catalogue,
installation, settings, navigation, data, and process capabilities are required.

## Positioning

Toolblox combines local multi-account Roblox management with an open widget system. Users can
add game-specific tools without giving a hosted service custody of their account sessions or
waiting for every feature to enter the core app.

## Operating Context

Users sign into Roblox through Roblox's own login page, keep several accounts organized, launch
Roblox with a chosen account, and optionally run installed widgets. Contributors develop the
app and widgets from source, while other users install packaged Windows or macOS releases.

Every installed build starts through a native updater. The updater checks for a current,
cryptographically verified release and installs it before opening the main interface. Startup
fails closed when the version check can't be completed, so an outdated application can't run.

The project is primarily implemented and maintained with AI agents. A human briefly reviews
changes before they are merged or released.

## Capabilities and Constraints

- The port must reach functional parity with the Flet application before replacing it.
- Toolblox stores account data locally. It doesn't provide a hosted account service.
- Roblox session cookies must remain protected by operating-system-backed credential storage
  and must never leave the user's computer through Toolblox.
- The app supports Windows and macOS, with Windows prioritized while both platforms remain
  functional.
- The main interface must not load until the native updater confirms the installed version is
  current or installs a cryptographically verified update.
- The update system must reject unsigned, invalid, older, or incompatible update artifacts.
- Installation and updates should use per-user scope where practical so routine operation
  doesn't require administrator access.
- Users can add, remove, annotate, sort, reorder, select, and launch Roblox accounts.
- Users can install, enable, disable, configure, update, and uninstall extensible widgets.
- Module widgets run in the app window with full access to the interface and the host API. They
  can add screens, replace core screens other than Settings, extend any slot, and restyle the app.
  Safety comes from review: only widgets that pass marketplace review are listed in the signed
  catalogue, and unreviewed widgets load only in development builds.
- Roblox session cookies stay in Rust. No widget, and no part of the Toolblox interface, can
  read them.
- A widget that breaks the interface must be recoverable: safe mode starts Toolblox without
  widgets, and every widget contribution renders inside an error boundary.
- Widget catalogue packages must be pinned and verified before extraction or execution.
- Source code is public under the MIT license and should remain practical for outside
  contributors to inspect and extend.
- A commercial code-signing certificate isn't currently viable. Release trust must come from
  cryptographic update signatures and transparent, reproducible evidence without claiming that
  the Windows executable itself is commercially signed.

## Brand Commitments

The product name is Toolblox. Its voice is plain, factual, concise, and reassuring without
making unsupported security claims. User-facing errors state what went wrong and follow with a
question that points toward a likely fix.

The new interface should preserve the current Flet application's sleek character and familiar
information architecture while improving usability, maintainability, and platform-native
behavior.

Safety communication must make local data handling understandable to non-technical users. It
must distinguish what Toolblox can substantiate from what it can't guarantee.

## Evidence on Hand

- The legacy Flet repository contains the complete behavioral and visual migration reference.
- Its credential persistence uses Windows DPAPI and the macOS login Keychain.
- Its login flow uses Roblox's own page rather than collecting a password.
- Its catalogue installer verifies archive hashes before extraction.
- Its source code and MIT license are public.
- Release VirusTotal results are planned once packaged releases are shipping. No results should
  be presented until they exist for the exact published artifacts.
- The project doesn't currently have a paid code-signing certificate. Future copy must not imply
  that releases are commercially signed unless this changes.
- No testimonials, adoption metrics, independent security audit, or formal security
  certification are currently established and must not be fabricated.

## Product Principles

1. Keep user data local and minimize the sensitive data Toolblox handles.
2. Make safety claims specific, understandable, and supported by inspectable evidence.
3. Prevent outdated builds from reaching the main application and verify every update before
   installation.
4. Keep privileged operations in a narrow Rust host with explicit trust boundaries.
5. Keep the core small while enabling community-built, game-specific capabilities through
   reviewed widgets that can extend or reshape any part of the interface.
6. Design changes so AI agents can implement and maintain them reliably, with concise human
   review focused on product judgment and risk.

## Accessibility & Inclusion

Safety and privacy information should be understandable without security expertise. Important
status, warnings, and account states must not rely on color alone. The desktop interface should
remain usable across supported Windows and macOS display sizes, scaling settings, input methods,
and brightness modes.
