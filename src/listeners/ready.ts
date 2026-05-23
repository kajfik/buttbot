import { Client } from "discord.js";
import { Model, ModelStatic, Sequelize } from "sequelize";
import { Commands } from "../commands";

export default (client: Client, databases: Sequelize[], tagsArray: ModelStatic<Model>[]): void => {
  client.on("clientReady", async() => {
    if (!client.user || !client.application) {
      console.log("Missing user or application. Restart the bot.");
      return;
    }

    for (const database of databases) {
      await database.authenticate();
      await database.query("PRAGMA journal_mode=WAL;");
      await database.query("PRAGMA synchronous=NORMAL;");
      await database.query("PRAGMA busy_timeout=5000;");
      console.log(`Authenticated ${database.getDatabaseName()}`);
    }

    for (const tag of tagsArray) {
      await tag.sync();
      console.log(`Synced ${tag.name}`);
    }

    try {
      await client.application.commands.set(Commands);
      console.log("Commands globally deployed.");
    } catch (e) {
      console.log(e);
    }

    console.log(`${client.user.username} is online`);
  });
};
