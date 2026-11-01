---
title: Privacy policy
description: What Toolblox stores, where it's stored, and every service it connects to.
updated: October 31, 2026
---

Toolblox is a desktop app that runs on your device. It has no accounts, servers, analytics, or
telemetry, and the project doesn't collect, sell, or share personal information. The only data
the project receives is what Discord sends when someone uses the
[Toolblox Discord bot](#discord-bot), beta survey answers that someone chooses to send, and the
platform of each browser's first download from [this website](#this-website).

### Data stored on this device

| Data | Where it's stored |
| --- | --- |
| Roblox sessions | Windows Credential Manager or the macOS login Keychain |
| Account names, user IDs, avatar links, and notes | The Toolblox data folder |
| Settings, recent places, and widget data | The Toolblox data folder |
| Diagnostic log | The Toolblox data folder, with sessions, join tickets, and launch links removed |

The data folder is `%LOCALAPPDATA%\Toolblox` on Windows and
`~/Library/Application Support/Toolblox` on macOS. Uninstalling keeps it. To erase everything,
remove each account in Toolblox, which also deletes its stored session, then delete the folder.

The diagnostic log is never uploaded. It leaves this device only if you copy or attach it
yourself, such as in a bug report.

### Network connections

Toolblox connects to these services directly. Each one receives your IP address and the details
of the request, under its own privacy policy.

- **Roblox** (`roblox.com`, `rbxcdn.com`, and their subdomains): to sign in through Roblox's own
  page, read account and game details, load avatars, check whether accounts are in game, and join
  games. The [Roblox privacy policy](https://www.roblox.com/info/privacy) applies.
- **GitHub** (`toolblox.dev`, `github.com`, and `githubusercontent.com`): to check for and
  download updates and the widget catalogue. Widget packages download from the address the
  catalogue lists for each one. GitHub's public release statistics count downloads of each file,
  including automatic updates, and show totals only. The
  [GitHub privacy statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement)
  applies.
- **Toolblox Discord bot** (`workers.dev`): only when **Send** is selected in the optional beta
  survey. It receives the rating, the comment, and the Toolblox version, and sends them to the
  developer as a Discord message. See [Discord bot](#discord-bot).

### This website

toolblox.dev is hosted on GitHub Pages, so GitHub receives your IP address and the pages you
request. The website sets no cookies. To show the latest version, the download count, and the
number of GitHub stars, your browser asks the GitHub API for public repository details. Downloads
come from GitHub's release servers.

The first time you download Toolblox from this website, your browser stores a note that a
download happened, and the website tells the [Toolblox Discord bot](#discord-bot) whether it was
for Windows or macOS. The note holds no identifier, and nothing is sent on later downloads. To
stop it, clear this website's data or block requests to `workers.dev`.

### Widgets

Widgets are made by third parties. An installed widget can read the data Toolblox shows, including
account names and user IDs, and can connect to services its author chooses. No widget can read
Roblox sessions. Catalogue review checks what each widget sends and where, but each widget's author
is responsible for how it handles data. Only install widgets you trust.

### Discord bot

The Toolblox Discord bot runs on Cloudflare Workers. When someone uses one of its commands,
Discord sends the bot the command name and the details Discord includes with every command, such
as the user's ID and username and the server and channel it was used in. The bot uses them only
to reply, and doesn't store or share them. To answer `/version`, the bot asks the GitHub API for
public release details.

Beta survey answers sent from the app are delivered to the developer as a Discord direct message
and aren't stored by the bot. To limit spam, the bot keeps a count of answers for each IP address
for one hour. The address is stored only as a one-way hash.

The bot also stores total release download counts from GitHub's public statistics, and a count
of first downloads from this website for each platform. Neither contains personal information. To
limit spam, the bot keeps a count of first downloads for each IP address for one hour, stored only
as a one-way hash. Cloudflare receives each request under the
[Cloudflare privacy policy](https://www.cloudflare.com/privacypolicy/), and Discord's
[privacy policy](https://discord.com/privacy) applies to everything sent through Discord.

### Children

Toolblox doesn't collect personal information from anyone, including children under 13.

### Changes and contact

Changes to this policy are published here, and its full history is public in the
[source code](https://github.com/BakedAleska/Toolblox/commits/main/site/src/legal/privacy.md). Ask
questions in a [GitHub issue](https://github.com/BakedAleska/Toolblox/issues).
