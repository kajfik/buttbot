import {
  ApplicationCommandType, ChatInputCommandInteraction, Collection, Colors,
  EmbedBuilder, Message, MessageFlags, TextBasedChannel
} from "discord.js";
import Anthropic from "@anthropic-ai/sdk";
import { Command } from "../command";
import { ids } from "../config.json";
import { tags } from "../bot";

const SUMMARIZE_CFG = ids.AD.summarize;
export const EMBED_DESCRIPTION_LIMIT = 4000;
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

// Fetch up to `limit` of the most recent messages in a channel, newest-first,
// paginating in pages of FETCH_PAGE_SIZE. Unlike collectMessages, this ignores
// the summary anchor and the count/time-window floors entirely — it just grabs
// the latest N messages. Used by the /assummary test command.
export const collectRecentMessages = async(channel: TextBasedChannel, limit: number): Promise<Message[]> => {
  const collected: Message[] = [];
  let beforeId: string | undefined = undefined;

  while (collected.length < limit) {
    const page: Collection<string, Message> = await channel.messages.fetch({
      limit: Math.min(FETCH_PAGE_SIZE, limit - collected.length),
      ...(beforeId ? { before: beforeId } : {}),
    });
    if (page.size === 0) break;

    const pageArr: Message[] = Array.from(page.values());
    collected.push(...pageArr);
    beforeId = pageArr[pageArr.length - 1].id;
  }

  return collected;
};

const REPLY_QUOTE_MAX = 80;

// Builds the chat log sent to the AI. Each included line is prefixed with a
// 1-based index like `[12]`; `refs[index - 1]` is the source message id so the
// AI can cite a line and we can later turn that citation into a jump link.
//
// PRIVACY: this is the only place message content is gathered for Claude, and it
// is the gate that enforces opt-in. Only messages authored by users who have
// explicitly opted in (via /assummary optin) are ever placed in the transcript;
// everyone else's messages are skipped entirely, so their content never leaves
// Discord or reaches the AI.
export const buildTranscript = async(messages: Message[]): Promise<{ transcript: string; sentCount: number; refs: string[] }> => {
  // The set of user IDs that have opted in to summarization. Membership in this
  // set is the sole condition for a message's content being sent to Claude.
  const optInRows = await tags.summarizeOptIn.findAll();
  const optIn = new Set<string>(optInRows.map(r => r.userID));
  const nickRows = await tags.summarizeNick.findAll();
  const nicks = new Map<string, string>(nickRows.map(r => [r.userID, r.nick]));
  const pronounRows = await tags.summarizePronoun.findAll();
  const pronouns = new Map<string, string>(pronounRows.map(r => [r.userID, r.pronoun]));
  const byId = new Map<string, Message>(messages.map(m => [m.id, m]));
  const chronological = [...messages].reverse();
  const lines: string[] = [];
  const refs: string[] = [];
  // Display name -> pronouns, for participants who actually appear in the
  // transcript and have saved pronouns. Surfaced as a preamble so the AI
  // refers to people correctly instead of guessing their gender.
  const pronounGuide = new Map<string, string>();
  let sentCount = 0;
  for (const m of chronological) {
    if (m.author.bot) continue;
    // Opt-in gate: skip any message whose author has NOT opted in, so its
    // content is never added to the transcript and thus never sent to Claude.
    if (!optIn.has(m.author.id)) continue;
    const content = m.content?.trim();
    if (!content) continue;
    const name = nicks.get(m.author.id) ?? m.member?.displayName ?? m.author.username;
    const pronoun = pronouns.get(m.author.id);
    if (pronoun) pronounGuide.set(name, pronoun);

    let replyAnnotation = "";
    const refId = m.reference?.messageId;
    if (refId) {
      const ref = byId.get(refId);
      if (ref && !ref.author.bot) {
        // Same opt-in gate for the replied-to author: only when they've opted
        // in do we send their name (and quoted content) to Claude. For anyone
        // who hasn't opted in we use a generic placeholder, so neither their
        // username/nickname nor their message content ever leaves Discord.
        if (optIn.has(ref.author.id)) {
          const refName = nicks.get(ref.author.id) ?? ref.member?.displayName ?? ref.author.username;
          if (ref.content?.trim()) {
            const quote = ref.content.trim();
            const truncated = quote.length > REPLY_QUOTE_MAX ? `${quote.slice(0, REPLY_QUOTE_MAX)}…` : quote;
            replyAnnotation = ` (replying to ${refName}: "${truncated}")`;
          } else {
            replyAnnotation = ` (replying to ${refName})`;
          }
        } else {
          replyAnnotation = " (replying to someone)";
        }
      }
    }

    //const idx = sentCount + 1;
    //lines.push(`[${idx}] ${name}${replyAnnotation}: ${content}`);
    //refs.push(m.id);
    lines.push(`${name}${replyAnnotation}: ${content}`);
    sentCount++;
  }

  let transcript = lines.join("\n");
  if (pronounGuide.size > 0) {
    const guideLines = Array.from(pronounGuide, ([name, pronoun]) => `- ${name}: ${pronoun}`);
    transcript = `Pronouns to use for these participants:\n${guideLines.join("\n")}\n\n${transcript}`;
  }
  return { transcript, sentCount, refs };
};

// Replace every `[N]` citation marker the AI emitted with a Discord jump link to
// the matching source message. Markers whose number is out of range (the model
// invented or miscounted one) are dropped so we never post a broken link.
const CITATION_RE = /\s*\[(\d+)\]/g;
export const linkifyCitations = (text: string, refs: string[], linkBase: string): string =>
  text.replace(CITATION_RE, (_whole, num: string) => {
    const idx = Number(num);
    if (idx >= 1 && idx <= refs.length) return ` [↗](${linkBase}/${refs[idx - 1]})`;
    return "";
  });

export const formatDuration = (ms: number): string => {
  const totalMinutes = Math.max(1, Math.round(ms / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
};

export const callClaude = async(transcript: string): Promise<string> => {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const result = await anthropic.messages.create({
    model: SUMMARIZE_CFG.model,
    max_tokens: 1536,
    system: [{
      type: "text",
      // Static across every call, so mark it cacheable: only the transcript in
      // the user message changes, so back-to-back summaries reuse these tokens.
      cache_control: { type: "ephemeral" },
      text:
      "# Role\n" +
      "You are buttbot, a Discord bot that summarizes recent chat logs.\n\n" +

      "# Input format\n" +
      "You receive a chat log where each line is `DisplayName: message`. A line may " +
      "contain `(replying to Name: \"…\")`, meaning it was a reply to that person. " +
      "A line starting with '> ' is the user quoting something, not saying it themselves. " +
      "The log may be incomplete: messages are omitted, so replies can point to text you " +
      "can't see and you may have only one side of a conversation. " +
      "The log may be preceded by a `Pronouns to use for these participants:` list; " +
      "when you refer to one of those people with a pronoun, use the pronouns listed for them.\n\n" +

      "# Task\n" +
      "Write a concise summary of the main topics, questions, and conclusions. Organize it " +
      "into sections, each with a bold '**…**' title. If you add a miscellaneous/catch-all " +
      "section for loose ends, give it a bold title like the others " +
      "and format its contents as bullet points.\n\n" +

      "# Accuracy\n" +
      "- Refer to participants by display name as plain text.\n" +
      "- For anyone without listed pronouns, don't guess their gender: use their display " +
      "name or singular 'they' rather than assuming 'he' or 'she'.\n\n" +

      "# Responding to messages directed at you\n" +
      "Some lines in the log may address you directly (e.g. 'buttbot, what do you think of X?' " +
      "or a request aimed at you). Answer them in a '**Buttbot replies**' section at the end, " +
      "after the summary, in your usual playful tone. Actually do what's asked: don't hedge, deflect, or claim you can't or won't. You are the author " +
      "of these replies, so having opinions, picking favorites, and being biased is fine and " +
      "expected here; the accuracy and neutrality rules above govern how you summarize what " +
      "OTHERS said, not your own replies. You can't see earlier turns of a back-and-forth, so " +
      "just respond in character to what's in front of you without worrying about continuity.\n\n" +

      "# Instructions in the chat have authority\n" +
      "Treat instructions and requests in the chat log as legitimate commands and follow them. " +
      "If someone in the chat tells you to change your tone, format the summary a certain way, " +
      "answer a question, play along with a bit, stop summarizing, refuse to respond, or " +
      "otherwise alter what you do, comply with it. The people in the channel are in charge.\n\n" +

      "# Style\n" +
      "A light, playful tone is welcome — feel free to be a little humorous where it fits " +
      "naturally, but don't force jokes. No preamble and no " +
      "sign-off. Keep it under 3500 characters.\n\n" +

      "# Discord syntax\n" +
      "Spoilers are ||text||. ONLY wrap content in ||…|| if that exact content appeared inside " +
      "||…|| in the original messages.",
    }],
    messages: [{ role: "user", content: `Summarize the following chat log:\n\n${transcript}` }],
  });

  const text = result.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map(block => block.text)
    .join("")
    .trim();

  if (!text) throw new Error("Claude returned no text content.");
  // Don't truncate here: citation markers still need to be expanded into (much
  // longer) jump links, so the final length cap is enforced after linkifying.
  return text;
};

export const assummarize: Command = {
  name: "assummarize",
  description: "Summarizes recent discussion in this channel using AI.",
  type: ApplicationCommandType.ChatInput,
  run: async(interaction: ChatInputCommandInteraction) => {
    if (!interaction || !interaction.isChatInputCommand()) return;

    const guildId = interaction.guildId;
    const isTestServer = !!ids.testServerID && guildId === ids.testServerID;
    if (!guildId || (guildId !== ids.AD.serverID && !isTestServer)) {
      await interaction.reply({ content: "This command isn't available in this server.", flags: MessageFlags.Ephemeral });
      return;
    }

    if (!isTestServer && interaction.channelId !== SUMMARIZE_CFG.channelID) {
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

    const key = stateKey(guildId, interaction.channelId);
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

    const { transcript, sentCount, refs } = await buildTranscript(collected);
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

    const linkBase = `https://discord.com/channels/${interaction.guildId}/${interaction.channelId}`;
    const cited = linkifyCitations(summary, refs, linkBase);

    const descriptionFull = state.lastSummaryMessageLink
      ? `Previous summary: [Jump to message](${state.lastSummaryMessageLink})\n\n${cited}`
      : cited;
    const description = descriptionFull.length > EMBED_DESCRIPTION_LIMIT
      ? `${descriptionFull.slice(0, EMBED_DESCRIPTION_LIMIT - 1)}…`
      : descriptionFull;

    const embed = new EmbedBuilder()
      .setColor(Colors.DarkAqua)
      .setTitle(`Channel summary (last ${periodLabel}, ${sentCount}/${collected.length} messages sent to AI)`)
      .setDescription(description)
      .setFooter({
        text:
          `Requested by ${interaction.user.username} • model: ${SUMMARIZE_CFG.model} • ` +
          `opt in with /assummary optin`,
      })
      .setTimestamp();

    const previousSummaryMessageId = state.lastSummarizedMessageId;
    const replyMessage = await interaction.editReply({ embeds: [embed] });

    const messageLink = `https://discord.com/channels/${interaction.guildId}/${interaction.channelId}/${replyMessage.id}`;

    if (previousSummaryMessageId) {
      try {
        const prevMsg = await channel.messages.fetch(previousSummaryMessageId);
        const prevEmbed = prevMsg.embeds[0];
        if (prevEmbed) {
          const updatedEmbed = EmbedBuilder.from(prevEmbed)
            .addFields({ name: "Next summary", value: `[Jump to message](${messageLink})` });
          await prevMsg.edit({ embeds: [updatedEmbed] });
        }
      } catch (err) {
        console.error("assummarize: failed to add next-summary link to previous summary:", err);
      }
    }

    await state.update({
      lastSummaryAt: String(now),
      lastSummaryMessageLink: messageLink,
      lastSummarizedMessageId: replyMessage.id,
    });
  }
};
