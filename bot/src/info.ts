import { syncMessages } from "./discord.ts";

/** KV key for what was posted in each info channel. */
const POSTED_KEY = "info";

/** The messages in each info channel, in order. Editing one updates the channel on the next run. */
export const INFO_CHANNELS: { name: string; channel: string; messages: object[] }[] = [
  {
    name: "rules",
    channel: "1566577082476265543",
    messages: [
      { content: "By participating in this server and / or downloading Toolblox you agree to these guidelines." },
      {
        embeds: [{
          title: "Rules",
          description: `**1. Be respectful.** No harassment, hate speech, threats, or personal attacks.

**2. Follow Discord's rules.** The Discord Terms of Service and Community Guidelines apply here, including the minimum age.

**3. No exploits or cheats.** Don't share, request, or discuss exploits, cheats, executors, or injectors. This includes bypassing bans or game rules.

**4. No account trading.** Don't buy, sell, trade, or give away Roblox accounts, Robux, or limiteds.

**5. Never share login details.** Don't post passwords, cookies, session tokens, or authentication tickets, even in DMs. Remove them from screenshots and logs. Staff will never ask for them.

**6. No unofficial downloads.** Don't post modified builds, reuploads, or files from unknown sources. Toolblox comes only from https://toolblox.dev.

**7. No scams or selling Toolblox.** Toolblox is free. If anyone asks you to pay for it, report them to staff.

**8. No spam or advertising.** No unsolicited promotion, server invites, mass mentions, or DM advertising.

**9. Keep content appropriate.** No NSFW, gore, or shocking content. Roblox has many younger players, so keep this server suitable for them.

**10. Keep personal information private.** Don't post anyone's personal information, including your own.

**11. Use the right channel.** Keep conversations on topic, and post bug reports with your Toolblox version and platform.

**12. Report security issues privately.** Don't post unpatched vulnerabilities in the server. Contact the repository owner privately through GitHub: https://github.com/BakedAleska/Toolblox/blob/main/SECURITY.md

Staff decisions are final. Breaking these rules can lead to a warning, timeout, kick, or ban, depending on severity.`,
        }],
      },
    ],
  },
  {
    name: "faq",
    channel: "1566586052112552116",
    messages: [
      {
        embeds: [{
          title: "About Toolblox",
          description: `**What is Toolblox?**
A free desktop app for managing and launching multiple Roblox accounts, with widgets that add game-specific tools.

**Is it free?**
Yes. There are no ads or paid features, and the source code is public under the MIT License. If anyone asks you to pay for it, report it.

**Where do I download it?**
Only from https://toolblox.dev. The files on the GitHub releases page are used by the installer and updater, and the "Source code" archives can't be run.

**Which platforms are supported?**
Windows and macOS. The macOS app runs on Apple silicon and Intel Macs and supports multiple Roblox instances.

**Is Toolblox made by Roblox?**
No. Toolblox is an independent project and isn't affiliated with or endorsed by Roblox Corporation.`,
        }],
      },
      {
        embeds: [{
          title: "Safety and privacy",
          description: `**Does Toolblox inject into Roblox?**
No. Toolblox never injects code into Roblox, reads or changes its memory, or provides exploits, cheats, or any in-game advantage. It signs in through Roblox's own page and launches Roblox the same way the Roblox website does.

**How do multiple instances work?**
Roblox normally allows one client at a time. On Windows, Toolblox closes Roblox's single-instance handle. On macOS, it removes the name of Roblox's single-instance semaphore. Neither involves injecting code or accessing Roblox's memory.

**Can I get banned for using Toolblox?**
Toolblox shouldn't break any Roblox rules and is safe to use. Roblox decides how its terms are enforced, so no outside app can promise how they'll be applied.

**Can Toolblox see my password?**
No. Accounts are added through Roblox's own sign-in page. Toolblox stores only the login token Roblox provides, and keeps it in Windows Credential Manager or the macOS Keychain.

**Does my data leave my computer?**
Not to Toolblox. There's no Toolblox server, account service, or telemetry. The app connects only to Roblox and to GitHub for updates and widgets. Installed widgets can connect to other services, and the app lists each widget's permissions before it's installed.

Every connection is listed in the privacy policy: https://toolblox.dev/legal/#privacy`,
        }],
      },
      {
        embeds: [{
          title: "Install and updates",
          description: `**Why does Windows show a warning?**
Toolblox doesn't currently have a paid code-signing certificate. Select **More info**, then **Run anyway**, but only for a file downloaded from https://toolblox.dev or the official GitHub page.

**Why does macOS say it can't verify Toolblox?**
Toolblox isn't notarized by Apple. Select **Done**, open **System Settings → Privacy & Security**, and select **Open Anyway**. Only do this for a file from the official sources above.

**Why won't Toolblox open without an internet connection?**
Toolblox checks for a verified update every time it starts, and it won't open if that check can't finish. Check your connection, then try again.`,
        }],
      },
      {
        embeds: [{
          title: "Widgets",
          description: `**What are widgets?**
Add-ons that bring game-specific tools into Toolblox. Install them from the Widgets page.

**Are widgets safe?**
Every widget passes review before it's listed, and packages are signed and verified before they're installed. Widgets can't read your Roblox login, inject code into Roblox, or provide exploits or cheats.

**Can I make my own widget?**
Yes. The developer docs cover building and submitting one: https://toolblox.dev/docs/`,
        }],
      },
      {
        embeds: [{
          title: "Help",
          description: `**How do I report a bug?**
Post your Toolblox version, your platform, and the steps that caused it. Remove any login details from screenshots and logs first.`,
        }],
      },
    ],
  },
];

/** The text last posted in each channel and the messages holding it. */
type Posted = Record<string, { content: string; messageIds: string[] }>;

/** Posts each info channel's messages once, and edits them when `INFO_CHANNELS` changes. */
export async function syncInfo(token: string, state: KVNamespace): Promise<void> {
  const posted = (await state.get<Posted>(POSTED_KEY, "json")) ?? {};
  const save = () => state.put(POSTED_KEY, JSON.stringify(posted));
  for (const { name, channel, messages } of INFO_CHANNELS) {
    const content = JSON.stringify(messages);
    if (posted[name]?.content === content) continue;
    const messageIds = posted[name]?.messageIds ?? [];
    posted[name] = { content: posted[name]?.content ?? "", messageIds };
    await syncMessages(token, channel, messages, messageIds, save);
    posted[name].content = content;
    await save();
  }
}
