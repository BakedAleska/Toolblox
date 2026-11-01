# Toolblox bot

A Discord bot that runs as a Cloudflare Worker. It answers slash commands, posts released
changelogs, and sends the owner, and only the owner (`OWNER_USER_ID`), a daily report at 6 PM New
York time. The bot runs every five minutes, and a report that fails is retried on the next run.
The only thing the app sends the bot is the optional beta survey (see below). The website sends
the platform of each browser's first download.

| Command | Reply |
| --- | --- |
| `/link` | The download link |
| `/docs` | The widget documentation link |
| `/source` | The source code link |
| `/version` | The latest version and its release page |
| `/install` | The install guide |

The daily report gives three totals, each split into Windows and macOS, with its change since the
last report:

| Total | Source |
| --- | --- |
| Downloads | GitHub's counts of `Toolblox-Setup.exe` and `Toolblox.dmg`, the same count the website shows, re-downloads included. Before 0.3.0, Windows updates also downloaded `Toolblox-Setup.exe`, so Windows installers count only from releases with a separate `Toolblox-Update.exe`. |
| Users | First downloads from toolblox.dev, one per browser. Counted from when the website started sending them, and a new browser or cleared site data counts again. |
| Updates | GitHub's counts of `Toolblox-Update.exe` and `Toolblox.app.tar.gz`. Updates are required at startup, so these show installs still in use. Releases without `SHA256SUMS` were also downloaded by each manifest build, so their `.sig` downloads are subtracted. |

The report also lists downloads that weren't a browser's first download from the website
(re-downloads, direct links, and crawlers), and the newest release's own downloads and updates.

## Individual downloads

The first time a browser downloads Toolblox from toolblox.dev, the page stores a note in
`localStorage` and sends `POST /download?platform=windows` or `platform=macos`. The bot accepts
only requests from `https://toolblox.dev`, at most three per address per hour, and adds one to the
`users` count in KV. It stores nothing else. The page's endpoint is `DOWNLOAD_COUNTER` in
`site/src/pages/index.astro`.

## Beta survey

The app posts survey answers to `POST /survey` as JSON: `rating` (1–5), `comment` (up to 2,000
characters), and `version`. The bot DMs them to the owner as an embed. Anyone can call the
endpoint, so it rejects invalid answers and bodies over 16 KB, and accepts three answers per IP
address per hour (`src/limit.ts`). Counts are kept in KV under a hash of the address. The app's endpoint is
`SURVEY_URL` in `src-tauri/src/app_commands.rs`; set it to the deployed `workers.dev` URL followed
by `/survey`. Remove the route with the survey after the beta.

## Setup

1. **Create the Discord application** in the
   [Developer Portal](https://discord.com/developers/applications). Name it `Toolblox`, and use
   the same name for the bot's username in **Bot**. Discord already labels it as a bot, so it
   doesn't need a "bot" suffix there. From **General Information**,
   copy the **Application ID** and **Public Key**. From **Bot**, reset and copy the **Token**.
   No privileged intents are needed.
2. **Share a server with the bot.** Discord bots can DM only users they share a server with. In
   **Installation**, enable **Guild Install** with the `applications.commands` and `bot`
   scopes, then open the install link and add the bot to a private server. Enabling
   **User Install** also lets you use the commands anywhere.
3. **Install and sign in to Cloudflare** from this folder:
   ```sh
   npm install
   npx wrangler login
   ```
4. **Create the KV namespace** and paste the printed `id` into `wrangler.toml`:
   ```sh
   npx wrangler kv namespace create STATE
   ```
5. **Set the public key** in `wrangler.toml` (`DISCORD_PUBLIC_KEY`). It's public, so it isn't a
   secret.
6. **Set the secrets.** Your user ID comes from Discord with Developer Mode on: right-click your
   name, then **Copy User ID**. The GitHub token is optional but avoids GitHub's shared rate
   limit: a fine-grained token with public repository read access and no other permissions.
   ```sh
   npx wrangler secret put DISCORD_BOT_TOKEN
   npx wrangler secret put OWNER_USER_ID
   npx wrangler secret put GITHUB_TOKEN
   ```
7. **Deploy**, then copy the printed `workers.dev` URL:
   ```sh
   npm run deploy
   ```
8. **Connect Discord.** In **General Information**, paste the URL into **Interactions Endpoint
   URL** and save. Discord checks the endpoint before saving.
9. **Register the commands**:
   ```sh
   DISCORD_BOT_TOKEN=... npm run register
   ```
   The application ID is set in `scripts/register.mjs`. `DISCORD_APPLICATION_ID` overrides it.
   Run this again whenever `COMMANDS` in `src/commands.ts` changes.

The first report after deploying shows no change, because there's no earlier report to compare.

## Development

```sh
npm run check   # type-check
npm test        # unit tests
npm run dev     # local Worker; add secrets to .dev.vars (ignored by git)
```

Add a command in `src/commands.ts` (definition and reply), then run `npm run register`.
