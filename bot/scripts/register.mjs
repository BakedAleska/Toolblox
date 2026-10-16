// Registers the bot's slash commands with Discord, replacing any registered before.
// Usage: DISCORD_BOT_TOKEN=... npm run register
import { COMMANDS } from "../src/commands.ts";

const applicationId = process.env.DISCORD_APPLICATION_ID ?? "1560793872324370546";
const token = process.env.DISCORD_BOT_TOKEN;
if (!token) {
  console.error("Set DISCORD_BOT_TOKEN, then run this again.");
  process.exit(1);
}

const response = await fetch(`https://discord.com/api/v10/applications/${applicationId}/commands`, {
  method: "PUT",
  headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify(COMMANDS),
});
if (!response.ok) {
  console.error(`Registering commands failed with status ${response.status}: ${await response.text()}`);
  process.exit(1);
}
console.log(`Registered ${COMMANDS.length} commands.`);
