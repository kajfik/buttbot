import { ChatInputCommandInteraction, Client, Interaction, MessageFlags } from "discord.js";
import { Commands } from "../commands";
import { ids } from "../config.json";

export default (client: Client): void => {
  client.on("interactionCreate", async(interaction: Interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        await handleSlashCommand(client, interaction as ChatInputCommandInteraction);
      }
    } catch (error) {
      console.log(error);
    }
  });
};

const handleSlashCommand = async(client: Client, interaction: ChatInputCommandInteraction): Promise<void> => {
  const command = Commands.find(c => c.name === interaction.commandName);

  if (!command) {
    await interaction.reply({ content: `Command ${interaction.commandName} not found`, flags: MessageFlags.Ephemeral });
    return;
  }

  try {
    await command.run(interaction, client);
  } catch (error) {
    console.log(error);
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: `Error running command ${interaction.commandName} <@${ids.kajfik}>`, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content: `Error running command ${interaction.commandName} <@${ids.kajfik}>`, flags: MessageFlags.Ephemeral });
    }
  }
};
