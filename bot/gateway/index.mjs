// Toolblox gateway bot: greets new members in #welcome and rotates the bot's status.
// Usage: DISCORD_BOT_TOKEN=... node index.mjs (Node 24 or later).

/** Discord REST API base URL and the default Gateway URL. */
const API = "https://discord.com/api/v10";
const GATEWAY = "wss://gateway.discord.gg/?v=10&encoding=json";

/** Gateway intents: GUILDS for each server's channels, GUILD_MEMBERS (privileged) for joins. */
const INTENTS = (1 << 0) | (1 << 1);

/** Name of the channel new members are greeted in. */
export const WELCOME_CHANNEL = "welcome";

/** How often the status changes, in milliseconds. */
const STATUS_INTERVAL = 10 * 60 * 1000;

/** Statuses shown under the bot's name, in turn. */
export const STATUSES = [
  "Managing 47 alts responsibly",
  "Joining games so you don't have to click",
  "Sorting accounts by vibes",
  "Reviewing widgets with a magnifying glass",
  "Opening one more Roblox window",
  "Keeping cookies on this device",
  "Counting accounts. Again.",
  "No injection, just organization",
];

/** Close codes after which reconnecting can't succeed. */
const FATAL_CLOSES = {
  4004: "The bot token was rejected. Is DISCORD_BOT_TOKEN current?",
  4013: "The intents aren't valid. Has INTENTS changed?",
  4014: "Server Members Intent is off. Is it on in the Developer Portal under Bot?",
};

/** Gateway opcodes. */
const DISPATCH = 0;
const HEARTBEAT = 1;
const IDENTIFY = 2;
const PRESENCE_UPDATE = 3;
const RESUME = 6;
const RECONNECT = 7;
const INVALID_SESSION = 9;
const HELLO = 10;
const HEARTBEAT_ACK = 11;

/** The greeting that mentions a new member. */
export function welcomeMessage(userId) {
  return [
    `Welcome to Toolblox, <@${userId}>.`,
    "Download Toolblox: https://toolblox.dev/",
    "Install guide: <https://toolblox.dev/docs/install/>",
  ].join("\n");
}

/** The ID of the server's #welcome text channel, or undefined when it has none. */
export function findWelcomeChannel(channels = []) {
  return channels.find((channel) => channel.name === WELCOME_CHANNEL && channel.type === 0)?.id;
}

/** The presence payload showing `text` as a custom status. */
export function presence(text) {
  return { since: null, activities: [{ name: "Custom Status", type: 4, state: text }], status: "online", afk: false };
}

/** Sends a message as the bot, mentioning only `userId`. A rate-limited message is retried up to three times after the wait Discord asks for. */
export async function sendMessage(token, channelId, content, userId) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${API}/channels/${channelId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content, allowed_mentions: { users: [userId] } }),
    });
    if (response.ok) return;
    if (response.status !== 429 || attempt === 3) throw new Error(`Discord returned status ${response.status} for a welcome message.`);
    const { retry_after: wait = 1 } = await response.json().catch(() => ({}));
    await new Promise((resolve) => setTimeout(resolve, wait * 1000));
  }
}

/**
 * Connects to the Gateway and stays connected. A dropped connection resumes the session, so joins
 * during the gap are still delivered; when Discord refuses that, the bot identifies again.
 */
export function run(token) {
  const welcomeChannels = new Map();
  let session = null;
  let sequence = null;
  let statusIndex = Math.floor(Math.random() * STATUSES.length);
  let retryDelay = 1000;

  const connect = () => {
    const socket = new WebSocket(session?.url ?? GATEWAY);
    const send = (op, d) => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ op, d }));
    let firstBeat;
    let heartbeat;
    let statusTimer;
    let acknowledged = true;

    const beat = () => {
      if (!acknowledged) return socket.close(4000, "Heartbeat not acknowledged");
      acknowledged = false;
      send(HEARTBEAT, sequence);
    };

    const rotateStatus = () => {
      statusTimer ??= setInterval(() => {
        statusIndex = (statusIndex + 1) % STATUSES.length;
        send(PRESENCE_UPDATE, presence(STATUSES[statusIndex]));
      }, STATUS_INTERVAL);
    };

    const identify = () => send(IDENTIFY, {
      token,
      intents: INTENTS,
      properties: { os: process.platform, browser: "toolblox-gateway", device: "toolblox-gateway" },
      presence: presence(STATUSES[statusIndex]),
    });

    socket.addEventListener("message", async (event) => {
      const { op, d, s, t } = JSON.parse(event.data);
      if (s !== null && s !== undefined) sequence = s;
      if (op === HELLO) {
        firstBeat = setTimeout(() => {
          beat();
          heartbeat = setInterval(beat, d.heartbeat_interval);
        }, d.heartbeat_interval * Math.random());
        if (session) send(RESUME, { token, session_id: session.id, seq: sequence });
        else identify();
      } else if (op === HEARTBEAT) {
        send(HEARTBEAT, sequence);
      } else if (op === HEARTBEAT_ACK) {
        acknowledged = true;
      } else if (op === RECONNECT) {
        socket.close(4000, "Reconnect requested");
      } else if (op === INVALID_SESSION) {
        if (!d) session = null;
        setTimeout(() => (session ? send(RESUME, { token, session_id: session.id, seq: sequence }) : identify()), 1000 + Math.random() * 4000);
      } else if (op === DISPATCH) {
        if (t === "READY") {
          session = { id: d.session_id, url: `${d.resume_gateway_url}/?v=10&encoding=json` };
          retryDelay = 1000;
          console.log(`Connected as ${d.user.username}.`);
          rotateStatus();
        } else if (t === "RESUMED") {
          retryDelay = 1000;
          rotateStatus();
        } else if (t === "GUILD_CREATE" || t === "GUILD_UPDATE") {
          if (d.channels) welcomeChannels.set(d.id, findWelcomeChannel(d.channels));
        } else if (t === "CHANNEL_CREATE" || t === "CHANNEL_UPDATE" || t === "CHANNEL_DELETE") {
          if (d.guild_id && (d.name === WELCOME_CHANNEL || welcomeChannels.get(d.guild_id) === d.id)) {
            welcomeChannels.set(d.guild_id, t === "CHANNEL_DELETE" ? undefined : findWelcomeChannel([d]));
          }
        } else if (t === "GUILD_MEMBER_ADD" && !d.user.bot) {
          const channel = welcomeChannels.get(d.guild_id);
          if (!channel) return console.warn("A member joined a server without a #welcome channel.");
          await sendMessage(token, channel, welcomeMessage(d.user.id), d.user.id).catch((error) => console.warn(`The welcome message wasn't sent: ${error.message}`));
        }
      }
    });

    socket.addEventListener("close", (event) => {
      clearTimeout(firstBeat);
      clearInterval(heartbeat);
      clearInterval(statusTimer);
      const fatal = FATAL_CLOSES[event.code];
      if (fatal) {
        console.error(fatal);
        process.exit(1);
      }
      if (event.code === 4007 || event.code === 4009) session = null;
      console.warn(`The connection closed with code ${event.code}. Reconnecting in ${retryDelay / 1000} s.`);
      setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 60_000);
    });
  };

  connect();
}

if (import.meta.main) {
  const token = process.env.DISCORD_BOT_TOKEN?.trim();
  if (!token) {
    console.error("DISCORD_BOT_TOKEN isn't set. Is it in the .env file?");
    process.exit(1);
  }
  run(token);
}
