import {
  ApplicationCommandType, ChatInputCommandInteraction, Collection, Colors,
  EmbedBuilder, Message, MessageFlags, TextBasedChannel
} from "discord.js";
import Anthropic from "@anthropic-ai/sdk";
import { Command } from "../command";
import { ids } from "../config.json";
import { tags } from "../bot";

const SUMMARIZE_CFG = ids.AD.summarize;
export const EMBED_DESCRIPTION_LIMIT = 3900;
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
  const byId = new Map<string, Message>(messages.map(m => [m.id, m]));
  const chronological = [...messages].reverse();
  const lines: string[] = [];
  const refs: string[] = [];
  let sentCount = 0;
  for (const m of chronological) {
    if (m.author.bot) continue;
    // Opt-in gate: skip any message whose author has NOT opted in, so its
    // content is never added to the transcript and thus never sent to Claude.
    if (!optIn.has(m.author.id)) continue;
    const content = m.content?.trim();
    if (!content) continue;
    const name = nicks.get(m.author.id) ?? m.member?.displayName ?? m.author.username;

    let replyAnnotation = "";
    const refId = m.reference?.messageId;
    if (refId) {
      const ref = byId.get(refId);
      if (ref && !ref.author.bot) {
        const refName = nicks.get(ref.author.id) ?? ref.member?.displayName ?? ref.author.username;
        // Same opt-in gate for quoted replies: we only include the quoted text
        // when the replied-to author has also opted in. Otherwise we mention
        // only that it was a reply, never that user's actual message content.
        if (optIn.has(ref.author.id) && ref.content?.trim()) {
          const quote = ref.content.trim();
          const truncated = quote.length > REPLY_QUOTE_MAX ? `${quote.slice(0, REPLY_QUOTE_MAX)}…` : quote;
          replyAnnotation = ` (replying to ${refName}: "${truncated}")`;
        } else {
          replyAnnotation = ` (replying to ${refName})`;
        }
      }
    }

    const idx = sentCount + 1;
    lines.push(`[${idx}] ${name}${replyAnnotation}: ${content}`);
    refs.push(m.id);
    sentCount++;
  }
  return { transcript: lines.join("\n"), sentCount, refs };
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
    max_tokens: 1024,
    system: [{
      type: "text",
      // Static across every call, so mark it cacheable: only the transcript in
      // the user message changes, so back-to-back summaries reuse these tokens.
      cache_control: { type: "ephemeral" },
      text:
      "You are buttbot, a Discord bot. You summarize recent Discord chat logs. " +
      "Produce a concise summary of the main topics, questions, and conclusions. " +
      "A light, playful tone is welcome — feel free to be a little humorous where it fits naturally, " +
      "but don't force jokes, mock participants, or sacrifice accuracy for the sake of a punchline. " +
      //"Organize the summary into sections, each with a short title. Each section body can be either a short " +
      //"paragraph of text or bullet points. Do not invent details. " +
      "Refer to participants by their display names when relevant. " +
      "The chat log may be incomplete — some messages are omitted, so replies can point to text you can't " +
      "see and you may only have one side of a conversation. Don't guess at missing content or assume a " +
      "conversation is complete; summarize only what's present. " +
      "Discord spoiler syntax is ||text||. ONLY wrap content in ||...|| if that exact content appeared " +
      "inside ||...|| in the original messages. " +
      "In Discord, a line starting with '> ' is a quote — the user is quoting something (often from " +
      "another message), not saying it themselves. " +
      //"Each message in the log is prefixed with a bracketed number like [12]. Each citation becomes a link " +
      //"in the final post. Give each section " +
      //"EXACTLY ONE citation, placed in the section title: " +
      //"When you cite, append the matching bracketed " +
      //"number to the title, e.g. \"Database migration [12]\". Use a single number per citation rather than " +
      //"stacking several. Only ever use numbers that appear in the log. " +
      //"Distinguish opinions from facts: when a participant shares a subjective reaction, judgment, or " +
      //"characterization, attribute it to them and prefer direct quotes rather than " +
      //"restating their opinion as if it were objective truth. " +
      //"Some messages are jokes, sarcasm, hyperbole, memes, or bits. Do NOT restate an obvious joke or " +
      //"absurd exaggeration as if it were a serious, literal claim someone made. When unsure whether something is serious, " +
      //"quote it directly instead of paraphrasing it into a factual assertion. " +
      "Output only the summary itself: no preamble (e.g. \"Here's a summary...\") and no closing remarks or sign-off. " +
      "Keep the summary under 3500 characters.",
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
