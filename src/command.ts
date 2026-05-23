/* eslint-disable no-unused-vars */
import { ChatInputApplicationCommandData, ChatInputCommandInteraction, Client } from "discord.js";

export interface Command extends ChatInputApplicationCommandData {
  run: (interaction: ChatInputCommandInteraction, client: Client) => void;
}
