# Contributing

Open an issue before a large behavior or architecture change. Small fixes can go directly to a
pull request with a focused explanation and verification results.

Toolblox is maintained primarily with AI coding agents and brief human review. Generated changes
receive the same review standard as handwritten changes. The author is responsible for checking
the diff, tests, permissions, dependencies, and user-facing claims before merge.

Keep secrets and network access in Rust. Widgets and React must not receive Roblox sessions,
authentication tickets, updater keys, or unrestricted filesystem and process access. Add focused
tests when a parser, migration, persistence path, updater decision, archive boundary, or permission
rule changes.

Follow the verification commands in the README. Windows and macOS must remain supported even when
a change is developed on only one platform.
