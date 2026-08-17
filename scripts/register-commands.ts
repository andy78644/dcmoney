import { commandDefinitions } from "../src/discord/command-definitions";

const applicationId = process.env.DISCORD_APPLICATION_ID;
const botToken = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;

if (applicationId === undefined || botToken === undefined) {
  throw new Error(
    "DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN are required.",
  );
}

const scope =
  guildId === undefined
    ? `applications/${applicationId}/commands`
    : `applications/${applicationId}/guilds/${guildId}/commands`;
const response = await fetch(`https://discord.com/api/v10/${scope}`, {
  method: "PUT",
  headers: {
    authorization: `Bot ${botToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify(commandDefinitions),
});

if (!response.ok) {
  throw new Error(
    `Discord command registration failed (${response.status}): ${await response.text()}`,
  );
}

const commands = (await response.json()) as Array<{ name: string }>;
console.log(
  `Registered ${commands.length} command(s) in ${
    guildId === undefined ? "global" : `guild ${guildId}`
  } scope: ${commands.map(({ name }) => name).join(", ")}`,
);
