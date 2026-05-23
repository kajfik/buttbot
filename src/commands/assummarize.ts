import {
  ApplicationCommandOptionType, ApplicationCommandType, ChatInputCommandInteraction, Collection, Colors,
  EmbedBuilder, Message, MessageFlags, TextBasedChannel
} from "discord.js";
import Anthropic from "@anthropic-ai/sdk";
import { Command } from "../command";
import { ids } from "../config.json";
import { tags } from "../bot";

const SUMMARIZE_CFG = ids.AD.summarize;
const EMBED_DESCRIPTION_LIMIT = 4000;
const FETCH_PAGE_SIZE = 100;

const stateKey = (guildId: string, channelId: string) => `${guildId}:${channelId}`;

const loadState = async(key: string) => {
  const [row] = await tags.summarizeState.findOrCreate({ where: { key } });
  return row;
};

const formatRemaining = (ms: number) => {
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const remMinutes = minutes % 60;
    return `${hours}h ${remMinutes}m`;
  }
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
};

const countNewMessagesSince = async(channel: TextBasedChannel, anchorId: string): Promise<number> => {
  if (!anchorId) return Number.POSITIVE_INFINITY;
  const fetched = await channel.messages.fetch({ after: anchorId, limit: SUMMARIZE_CFG.cooldownMessages });
  return fetched.size;
};

// Collect messages newest-first, paginating until we satisfy BOTH the count floor
// (messageLimit) AND the time-window floor (windowMs), without crossing the anchor
// from the previous summary. Bounded by maxMessages as a safety cap.
const collectMessages = async(channel: TextBasedChannel, anchorId: string | null): Promise<Message[]> => {
  const cutoffTime = Date.now() - SUMMARIZE_CFG.windowMs;
  const anchor = anchorId ? BigInt(anchorId) : null;

  const collected: Message[] = [];
  let beforeId: string | undefined = undefined;

  while (collected.length < SUMMARIZE_CFG.maxMessages) {
    const page: Collection<string, Message> = await channel.messages.fetch({
      limit: FETCH_PAGE_SIZE,
      ...(beforeId ? { before: beforeId } : {}),
    });
    if (page.size === 0) break;

    const pageArr: Message[] = Array.from(page.values());

    let crossedAnchor = false;
    for (const msg of pageArr) {
      if (anchor !== null && BigInt(msg.id) <= anchor) {
        crossedAnchor = true;
        break;
      }
      collected.push(msg);
      if (collected.length >= SUMMARIZE_CFG.maxMessages) break;
    }
    if (crossedAnchor) break;
    if (collected.length >= SUMMARIZE_CFG.maxMessages) break;

    const oldestInPage: Message = pageArr[pageArr.length - 1];
    const haveEnoughByCount = collected.length >= SUMMARIZE_CFG.messageLimit;
    const haveEnoughByTime = oldestInPage.createdTimestamp <= cutoffTime;
    if (haveEnoughByCount && haveEnoughByTime) break;

    beforeId = oldestInPage.id;
  }

  return collected;
};

const buildTranscript = async(messages: Message[]): Promise<{ transcript: string; sentCount: number }> => {
  const optInRows = await tags.summarizeOptIn.findAll();
  const optIn = new Set<string>(optInRows.map(r => r.userID));
  const chronological = [...messages].reverse();
  const lines: string[] = [];
  let sentCount = 0;
  for (const m of chronological) {
    if (m.author.bot) continue;
    if (!optIn.has(m.author.id)) continue;
    const content = m.content?.trim();
    if (!content) continue;
    const name = m.member?.displayName ?? m.author.username;
    lines.push(`${name}: ${content}`);
    sentCount++;
  }
  return { transcript: lines.join("\n"), sentCount };
};

const formatDuration = (ms: number): string => {
  const totalMinutes = Math.max(1, Math.round(ms / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
};

const callClaude = async(transcript: string): Promise<string> => {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const result = await anthropic.messages.create({
    model: SUMMARIZE_CFG.model,
    max_tokens: 1024,
    system:
      "You summarize recent Discord chat logs. " +
      "Produce a concise summary of the main topics, questions, and conclusions. " +
      "A light, playful tone is welcome — feel free to be a little humorous where it fits naturally, " +
      "but don't force jokes, mock participants, or sacrifice accuracy for the sake of a punchline. " +
      "Use short paragraphs or bullet points. Do not invent details. " +
      "Refer to participants by their display names when relevant. " +
      "The chat log only includes messages from users who have opted in to summarization, so some context " +
      "may be missing — replies to unseen messages, participants in a conversation, or whole sides of a " +
      "discussion may be absent. " +
      "Discord spoiler syntax is ||text||. ONLY wrap content in ||...|| if that exact content appeared " +
      "inside ||...|| in the original messages — in that case you MUST preserve the spoiler tags so it " +
      "stays hidden, and never paraphrase spoilered content out from behind its tags. Do NOT add spoiler " +
      "tags to content that was not spoilered in the source, even if it discusses late-game mechanics, " +
      "endgame content, or anything you might consider a spoiler — only the original author's tagging decides. " +
      "Keep the summary under 3500 characters.",
    messages: [{ role: "user", content: `Summarize the following chat log:\n\n${transcript}` }],
  });

  const text = result.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map(block => block.text)
    .join("")
    .trim();

  if (!text) throw new Error("Claude returned no text content.");
  return text.length > EMBED_DESCRIPTION_LIMIT ? `${text.slice(0, EMBED_DESCRIPTION_LIMIT - 1)}…` : text;
};

export const assummarize: Command = {
  name: "assummarize",
  description: "Summarizes recent discussion in this channel using AI.",
  type: ApplicationCommandType.ChatInput,
  options: [
    {
      name: "action",
      description: "Optional action to perform instead of summarizing.",
      type: ApplicationCommandOptionType.String,
      required: false,
      choices: [
        { name: "Opt in (allow your messages to be included in summaries)", value: "in" },
        { name: "Opt out (exclude your messages from summaries)", value: "out" }
      ]
    }
  ],
  run: async(interaction: ChatInputCommandInteraction) => {
    if (!interaction || !interaction.isChatInputCommand()) return;

    const action = interaction.options.getString("action");

    if (action === "in" || action === "out") {
      if (interaction.guildId !== ids.AD.serverID) {
        await interaction.reply({ content: "This command isn't available in this server.", flags: MessageFlags.Ephemeral });
        return;
      }
      const existing = await tags.summarizeOptIn.findOne({ where: { userID: interaction.user.id } });
      if (action === "in") {
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
      return;
    }

    if (interaction.guildId !== ids.AD.serverID || interaction.channelId !== SUMMARIZE_CFG.channelID) {
      await interaction.reply({ content: "This command isn't available in this channel.", flags: MessageFlags.Ephemeral });
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

    const key = stateKey(interaction.guildId, interaction.channelId);
    const state = await loadState(key);
    const lastAt = Number(state.lastSummaryAt) || 0;
    const now = Date.now();
    const elapsed = now - lastAt;
    const timeRemaining = SUMMARIZE_CFG.cooldownMs - elapsed;

    if (lastAt > 0 && timeRemaining > 0) {
      const unlocksAt = Math.floor((lastAt + SUMMARIZE_CFG.cooldownMs) / 1000);
      const linkLine = state.lastSummaryMessageLink ? `\nLast summary: ${state.lastSummaryMessageLink}` : "";
      await interaction.reply({
        content:
          `On cooldown. Available <t:${unlocksAt}:R> (in ${formatRemaining(timeRemaining)}).` +
          linkLine,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (state.lastSummarizedMessageId) {
      const newCount = await countNewMessagesSince(channel, state.lastSummarizedMessageId);
      if (newCount < SUMMARIZE_CFG.cooldownMessages) {
        const needed = SUMMARIZE_CFG.cooldownMessages - newCount;
        const linkLine = state.lastSummaryMessageLink ? `\nLast summary: ${state.lastSummaryMessageLink}` : "";
        await interaction.reply({
          content:
            `Not enough new messages since the last summary (${newCount}/${SUMMARIZE_CFG.cooldownMessages}). ` +
            `${needed} more needed.` + linkLine,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }

    await interaction.deferReply();

    let collected: Message[];
    try {
      collected = await collectMessages(channel, state.lastSummarizedMessageId || null);
    } catch (err) {
      console.error("assummarize: failed to fetch messages:", err);
      await interaction.editReply({ content: "Couldn't fetch messages to summarize." });
      return;
    }

    const { transcript, sentCount } = await buildTranscript(collected);
    if (!transcript) {
      await interaction.editReply({ content: "There's nothing recent to summarize." });
      return;
    }

    let summary: string;
    try {
      summary = await callClaude(transcript);
    } catch (err) {
      console.error("assummarize: Claude call failed:", err);
      await interaction.editReply({ content: "Summarization failed. Try again later." });
      return;
    }

    const newestTs = collected[0].createdTimestamp;
    const oldestTs = collected[collected.length - 1].createdTimestamp;
    const periodLabel = formatDuration(newestTs - oldestTs);

    const embed = new EmbedBuilder()
      .setColor(Colors.DarkAqua)
      .setTitle(`Channel summary (last ${periodLabel}, ${sentCount}/${collected.length} messages sent to AI)`)
      .setDescription(summary)
      .setFooter({
        text:
          `Requested by ${interaction.user.username} • model: ${SUMMARIZE_CFG.model} • ` +
          `opt in with /assummarize action:in`,
      })
      .setTimestamp();

    if (state.lastSummaryMessageLink) {
      embed.addFields({ name: "Previous summary", value: `[Jump to message](${state.lastSummaryMessageLink})` });
    }

    const replyMessage = await interaction.editReply({ embeds: [embed] });

    const messageLink = `https://discord.com/channels/${interaction.guildId}/${interaction.channelId}/${replyMessage.id}`;
    await state.update({
      lastSummaryAt: String(now),
      lastSummaryMessageLink: messageLink,
      lastSummarizedMessageId: replyMessage.id,
    });
  }
};
