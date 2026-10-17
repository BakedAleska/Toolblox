# Toolblox bot

A Discord bot that runs as a Cloudflare Worker. It answers slash commands, and every five
minutes it checks GitHub's release download counts and sends a DM to the owner, and only the
owner (`OWNER_USER_ID`), when they grow.
The Toolblox app doesn't report anything. The counts are GitHub's public release data.

| Command | Reply |
| --- | --- |
| `/link` | The download link |
| `/docs` | The widget documentation link |
| `/source` | The source code link |
| `/version` | The latest version and its release page |
| `/install` | The install guide |

Each DM gives the total, then splits it into Windows (`Toolblox-Setup.exe`) and macOS
(`Toolblox.dmg`), the same count the website shows. Updates aren't counted. Before 0.3.0, Windows
updates also downloaded `Toolblox-Setup.exe`, so Windows installers count only from releases with
a separate `Toolblox-Update.exe`. These are download counts, not installs or active users.

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

The first check after deploying sends "Download tracking started" with the current totals.

## Development

```sh
npm run check   # type-check
npm test        # unit tests
npm run dev     # local Worker; add secrets to .dev.vars (ignored by git)
```

Add a command in `src/commands.ts` (definition and reply), then run `npm run register`.
