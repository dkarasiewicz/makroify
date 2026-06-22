import { discordChannel } from "eve/channels/discord";

/**
 * Discord channel. Eve exposes the interactions endpoint at `/eve/v1/discord`,
 * verifies Discord's Ed25519 signature, ACKs within 3s, and runs the agent in
 * the background — posting the final reply when it completes.
 *
 * Credentials are read from env: DISCORD_PUBLIC_KEY, DISCORD_APPLICATION_ID,
 * DISCORD_BOT_TOKEN (see ../../.env.example).
 */
export default discordChannel({
  onCommand: (_ctx, interaction) => ({
    auth: {
      principalId: interaction.user.id,
      principalType: "user",
      authenticator: "discord",
      attributes: {
        channel_id: interaction.channelId,
        guild_id: interaction.guildId ?? "",
      },
    },
  }),
  events: {
    "message.completed"(eventData, channel) {
      // Skip intermediate tool-call turns; post the final assistant reply.
      if (eventData.finishReason === "tool-calls") return;
      if (eventData.message) channel.discord.post(eventData.message);
    },
  },
});
