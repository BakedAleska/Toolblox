# Toolblox bot

The Toolblox Discord bot has two parts that share one Discord application and token:

- **Worker** (`src/`): a Cloudflare Worker that answers slash commands and posts released
  changelogs to #changelogs every five minutes. It stays up without a server.
- **Gateway** (`gateway/`): a small Node process, run on an always-on server, that greets new
  members in #welcome and rotates the bot's status. Discord sends member joins only over a
  persistent Gateway connection, which a Worker can't keep open.

| Command | Reply |
| --- | --- |
| `/link` | The download link |
| `/docs` | The widget documentation link |
| `/source` | The source code link |
| `/version` | The latest version and its release page |
| `/install` | The install guide |

Download and update counts are public at [toolblox.dev/stats](https://toolblox.dev/stats/),
read from GitHub's release statistics in the browser.

## Discord application

1. **Create the application** in the
   [Developer Portal](https://discord.com/developers/applications). Name it `Toolblox`, and use
   the same name for the bot's username in **Bot**. From **General Information**, copy the
   **Application ID** and **Public Key**. From **Bot**, reset and copy the **Token**.
2. **Turn on Server Members Intent** in **Bot → Privileged Gateway Intents**. The Gateway needs it
   to receive joins.
3. **Install the bot.** In **Installation**, enable **Guild Install** with the
   `applications.commands` and `bot` scopes, then open the install link and add the bot to the
   server. Enabling **User Install** also lets you use the commands anywhere.
4. **Give the bot access** to #changelogs and #welcome: **View Channel** and **Send Messages**.

## Worker setup

1. **Install and sign in to Cloudflare** from this folder:
   ```sh
   npm install
   npx wrangler login
   ```
2. **Create the KV namespace** and paste the printed `id` into `wrangler.toml`:
   ```sh
   npx wrangler kv namespace create STATE
   ```
3. **Set the public key** in `wrangler.toml` (`DISCORD_PUBLIC_KEY`). It's public, so it isn't a
   secret.
4. **Set the secrets.** The GitHub token is optional but avoids GitHub's shared rate limit: a
   fine-grained token with public repository read access and no other permissions.
   ```sh
   npx wrangler secret put DISCORD_BOT_TOKEN
   npx wrangler secret put GITHUB_TOKEN
   ```
5. **Deploy**, then copy the printed `workers.dev` URL:
   ```sh
   npm run deploy
   ```
6. **Connect Discord.** In **General Information**, paste the URL into **Interactions Endpoint
   URL** and save. Discord checks the endpoint before saving.
7. **Register the commands**:
   ```sh
   DISCORD_BOT_TOKEN=... npm run register
   ```
   The application ID is set in `scripts/register.mjs`. `DISCORD_APPLICATION_ID` overrides it.
   Run this again whenever `COMMANDS` in `src/commands.ts` changes.

## Gateway setup

The Gateway has no dependencies. It needs Node 24 or later, or Docker.

With Docker, copy the `gateway` folder to the server, then from that folder:

```sh
echo "DISCORD_BOT_TOKEN=..." > .env
chmod 600 .env
docker compose up -d
docker compose logs -f   # shows "Connected as Toolblox."
```

The container runs as an unprivileged user with a read-only file system, makes only outgoing
connections, and restarts on its own. To update it, copy the new `index.mjs` and run
`docker compose restart`.

The bot greets each member who joins in the server's #welcome channel, mentioning them with the
download link and install guide. Members who join while the Gateway is down aren't greeted. Edit
`STATUSES` in `gateway/index.mjs` to change the rotating status, and `welcomeMessage` to change
the greeting. A rejected token or a missing Server Members Intent exits with the reason in the
log, and Docker retries with growing delays until it's fixed.

## Development

```sh
npm run check   # type-check the Worker
npm test        # unit tests for the Worker and Gateway
npm run dev     # local Worker; add secrets to .dev.vars (ignored by git)
```

Add a command in `src/commands.ts` (definition and reply), then run `npm run register`.
