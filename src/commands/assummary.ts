import {
  ApplicationCommandOptionType, ApplicationCommandType, ChatInputCommandInteraction,
  Colors, EmbedBuilder, Message, MessageFlags, TextBasedChannel
} from "discord.js";
import { Command } from "../command";
import { ids } from "../config.json";
import { tags } from "../bot";
import {
  EMBED_DESCRIPTION_LIMIT, buildTranscript, callClaude, collectRecentMessages,
  formatDuration, linkifyCitations
} from "./assummarize";

const TEST_MESSAGE_LIMIT = 200;

const SUMMARIZE_CFG = ids.AD.summarize;

const stateKey = (guildId: string, channelId: string) => `${guildId}:${channelId}`;

// Count messages posted after the last summarized message, capped at the
// cooldown threshold (mirrors the check in assummarize.ts).
const countNewMessagesSince = async(channel: TextBasedChannel, anchorId: string): Promise<number> => {
  const fetched = await channel.messages.fetch({ after: anchorId, limit: SUMMARIZE_CFG.cooldownMessages });
  return fetched.size;
};

// Build a line describing when /assummarize can next be run in this channel.
// /assummarize requires BOTH the time cooldown to elapse AND enough new
// messages since the last summary, so we surface whichever is still blocking.
// `newCount` is null when the message count couldn't be determined (no prior
// summary anchor, or the channel fetch failed), in which case it's omitted.
const nextAvailableLine = (lastSummaryAt: number, newCount: number | null): string => {
  const reasons: string[] = [];

  const unlocksAt = lastSummaryAt + SUMMARIZE_CFG.cooldownMs;
  if (lastSummaryAt > 0 && Date.now() < unlocksAt) {
    reasons.push(`off time cooldown <t:${Math.floor(unlocksAt / 1000)}:R>`);
  }

  if (newCount !== null && newCount < SUMMARIZE_CFG.cooldownMessages) {
    const needed = SUMMARIZE_CFG.cooldownMessages - newCount;
    reasons.push(`${needed} more new message${needed === 1 ? "" : "s"} (${newCount}/${SUMMARIZE_CFG.cooldownMessages}) are posted`);
  }

  if (reasons.length === 0) return "\n/assummarize is available now.";
  return `\n/assummarize will be available once ${reasons.join(" and ")}.`;
};

export const assummary: Command = {
  name: "assummary",
  description: "Look up info about channel summaries.",
  type: ApplicationCommandType.ChatInput,
  options: [
    {
      name: "latest",
      description: "Show a link to the most recent summary in this channel.",
      type: ApplicationCommandOptionType.Subcommand
    },
    {
      name: "optin",
      description: "Allow your messages to be included in summaries.",
      type: ApplicationCommandOptionType.Subcommand
    },
    {
      name: "optout",
      description: "Exclude your messages from summaries.",
      type: ApplicationCommandOptionType.Subcommand
    },
    {
      name: "setnick",
      description: "Set a custom nickname to use in /assummarize summaries.",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "nick",
          description: "The name buttbot should call you in summaries.",
          type: ApplicationCommandOptionType.String,
          required: true,
          minLength: 1,
          maxLength: 32
        }
      ]
    },
    {
      name: "deletenick",
      description: "Remove your custom summary nickname.",
      type: ApplicationCommandOptionType.Subcommand
    },
    {
      name: "test",
      description: "Show an ephemeral summary of the last 200 messages (no cooldown).",
      type: ApplicationCommandOptionType.Subcommand
    }
  ],
  run: async(interaction: ChatInputCommandInteraction) => {
    if (!interaction || !interaction.isChatInputCommand()) return;

    const guildId = interaction.guildId;
    const isTestServer = !!ids.testServerID && guildId === ids.testServerID;
    if (!guildId || (guildId !== ids.AD.serverID && !isTestServer)) {
      await interaction.reply({ content: "This command isn't available in this server.", flags: MessageFlags.Ephemeral });
      return;
    }

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === "test") {
      // Owner-only debug command: runs a one-off /assummarize over the last
      // TEST_MESSAGE_LIMIT messages and shows it only to the caller. It ignores
      // the channel restriction, the cooldowns, and the summary anchor, and
      // never persists state, so it's safe to spam while iterating on prompts.
      if (interaction.user.id !== ids.kajfik) {
        await interaction.reply({ content: "This command isn't available to you.", flags: MessageFlags.Ephemeral });
        return;
      }

      const channel = interaction.channel;
      if (!channel || !channel.isTextBased()) {
        await interaction.reply({ content: "I can't read messages in this channel.", flags: MessageFlags.Ephemeral });
        return;
      }

      if (!process.env.ANTHROPIC_API_KEY) {
        await interaction.reply({ content: "AI summarization isn't configured (missing API key). Tell an admin.", flags: MessageFlags.Ephemeral });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      let collected: Message[];
      try {
        collected = await collectRecentMessages(channel, TEST_MESSAGE_LIMIT);
      } catch (err) {
        console.error("assummary test: failed to fetch messages:", err);
        await interaction.editReply({ content: "Couldn't fetch messages to summarize." });
        return;
      }

      const { transcript, sentCount, refs } = await buildTranscript(collected);
      if (!transcript) {
        await interaction.editReply({ content: "There's nothing recent to summarize." });
        return;
      }

      let summary: string;
      try {
        summary = await callClaude(transcript);
      } catch (err) {
        console.error("assummary test: Claude call failed:", err);
        await interaction.editReply({ content: "Summarization failed. Try again later." });
        return;
      }

      const newestTs = collected[0].createdTimestamp;
      const oldestTs = collected[collected.length - 1].createdTimestamp;
      const periodLabel = formatDuration(newestTs - oldestTs);

      const linkBase = `https://discord.com/channels/${interaction.guildId}/${interaction.channelId}`;
      const cited = linkifyCitations(summary, refs, linkBase);
      const description = cited.length > EMBED_DESCRIPTION_LIMIT
        ? `${cited.slice(0, EMBED_DESCRIPTION_LIMIT - 1)}…`
        : cited;

      const embed = new EmbedBuilder()
        .setColor(Colors.DarkAqua)
        .setTitle(`Channel summary (test, last ${periodLabel}, ${sentCount}/${collected.length} messages sent to AI)`)
        .setDescription(description)
        .setFooter({
          text: `Requested by ${interaction.user.username} • model: ${SUMMARIZE_CFG.model} • test command`,
        })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (subcommand === "latest") {
      const key = stateKey(guildId, interaction.channelId);
      const [state] = await tags.summarizeState.findOrCreate({ where: { key } });

      let newCount: number | null = null;
      if (state.lastSummarizedMessageId && interaction.channel?.isTextBased()) {
        try {
          newCount = await countNewMessagesSince(interaction.channel, state.lastSummarizedMessageId);
        } catch (err) {
          console.error("assummary latest: failed to count new messages:", err);
        }
      }

      const availability = nextAvailableLine(Number(state.lastSummaryAt) || 0, newCount);
      if (state.lastSummaryMessageLink) {
        await interaction.reply({
          content: `Latest summary: ${state.lastSummaryMessageLink}${availability}`,
          flags: MessageFlags.Ephemeral,
        });
      } else {
        await interaction.reply({
          content: `No summary has been generated in this channel yet.${availability}`,
          flags: MessageFlags.Ephemeral,
        });
      }
      return;
    }

    if (subcommand === "setnick") {
      const rawNick = interaction.options.getString("nick", true);
      const nick = rawNick.replace(/\s+/g, " ").trim();
      if (!nick) {
        await interaction.reply({
          content: "Your nickname can't be empty.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await tags.summarizeNick.upsert({ userID: interaction.user.id, nick });
      await interaction.reply({
        content: `Your summary nickname is now "${nick}".`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (subcommand === "deletenick") {
      const existing = await tags.summarizeNick.findOne({ where: { userID: interaction.user.id } });
      if (existing) {
        await existing.destroy();
        await interaction.reply({
          content: "Your custom summary nickname has been removed.",
          flags: MessageFlags.Ephemeral,
        });
      } else {
        await interaction.reply({
          content: "You don't have a custom summary nickname set.",
          flags: MessageFlags.Ephemeral,
        });
      }
      return;
    }

    if (subcommand === "optin" || subcommand === "optout") {
      const existing = await tags.summarizeOptIn.findOne({ where: { userID: interaction.user.id } });
      if (subcommand === "optin") {
        if (existing) {
          await interaction.reply({
            content: "You're already opted in. Your messages can be included in /assummarize output.",
            flags: MessageFlags.Ephemeral,
          });
        } else {
          await tags.summarizeOptIn.create({ userID: interaction.user.id });
          await interaction.reply({
            content: "You have opted in. Your messages may now be included in /assummarize output.",
            flags: MessageFlags.Ephemeral,
          });
        }
      } else if (existing) {
        await existing.destroy();
        await interaction.reply({
          content: "You have opted out. Your messages will no longer be included in /assummarize output.",
          flags: MessageFlags.Ephemeral,
        });
      } else {
        await interaction.reply({
          content: "You're already opted out. Your messages are not included in /assummarize output.",
          flags: MessageFlags.Ephemeral,
        });
      }
    }
  }
};
