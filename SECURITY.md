# Security

## Report a vulnerability

Don't open a public issue for an unpatched vulnerability involving credentials, updates, widget
isolation, or arbitrary code execution. Contact the repository owner privately through GitHub.
Include the affected version, platform, reproduction steps, and expected impact. Remove Roblox
sessions, authentication tickets, and personal data from every report.

## Verify a release

Toolblox doesn't currently use a paid Windows Authenticode certificate. Before running an
installer downloaded from a release:

1. Download only from the repository's official Releases page.
2. Compare its SHA-256 digest with the digest published on that release.
3. Check the artifact-specific VirusTotal link and confirm its digest is identical.
4. If the release has no matching hash and scan result, don't run it.

A clean scan is supporting evidence, not a guarantee. Packaged builds also verify a signed update
manifest and the updater artifact before the main interface opens. Development builds identify
themselves as Canary and aren't release artifacts.

## Sensitive data

Toolblox stores Roblox sessions in the operating system credential store. Secrets aren't part of
frontend state, widget messages, account JSON, or error output. The app has no telemetry or hosted
account service.
