import { Client, GatewayIntentBits, Partials } from "discord.js";
import { DataTypes, Model, Sequelize } from "sequelize";
import path from "node:path";
import interactionCreate from "./listeners/interactionCreate";
import clientReady from "./listeners/ready";

console.log("Starting bot...");

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [
    Partials.Message,
    Partials.Channel,
    Partials.User,
  ],
});

client.on("error", (err) => {
  console.error("Discord client error:", err);
});
client.on("warn", (info) => {
  console.warn("Discord client warning:", info);
});

const SQLITE_DIR =
  process.env.SQLITE_DIR ||
  process.env.RAILWAY_VOLUME_MOUNT_PATH ||
  process.cwd();

const databaseCreator = (name: string) =>
  new Sequelize({
    dialect: "sqlite",
    storage: path.join(SQLITE_DIR, `${name}.sqlite`),
    logging: false,
    pool: {
      max: 1,
      min: 0,
      idle: 5000,
      acquire: 20000,
    },
    retry: {
      match: [/SQLITE_BUSY/, /SequelizeTimeoutError/],
      max: 5,
    },
  });

const summarizeStateDatabase = databaseCreator("summarizeState");
export class SummarizeState extends Model {
  declare key: string;
  declare lastSummaryAt: string;
  declare lastSummaryMessageLink: string;
  declare lastSummarizedMessageId: string;
}
SummarizeState.init(
  {
    key: { type: DataTypes.STRING, allowNull: false, unique: true },
    lastSummaryAt: { type: DataTypes.STRING, allowNull: false, defaultValue: "0" },
    lastSummaryMessageLink: { type: DataTypes.STRING, allowNull: false, defaultValue: "" },
    lastSummarizedMessageId: { type: DataTypes.STRING, allowNull: false, defaultValue: "" },
  },
  { sequelize: summarizeStateDatabase, modelName: "SummarizeState" }
);

const summarizeOptInDatabase = databaseCreator("summarizeOptIn");
export class SummarizeOptIn extends Model {
  declare userID: string;
}
SummarizeOptIn.init(
  {
    userID: { type: DataTypes.STRING, allowNull: false, unique: true },
  },
  { sequelize: summarizeOptInDatabase, modelName: "SummarizeOptIn" }
);

const summarizeNickDatabase = databaseCreator("summarizeNick");
export class SummarizeNick extends Model {
  declare userID: string;
  declare nick: string;
}
SummarizeNick.init(
  {
    userID: { type: DataTypes.STRING, allowNull: false, unique: true },
    nick: { type: DataTypes.STRING, allowNull: false },
  },
  { sequelize: summarizeNickDatabase, modelName: "SummarizeNick" }
);

const summarizePronounDatabase = databaseCreator("summarizePronoun");
export class SummarizePronoun extends Model {
  declare userID: string;
  declare pronoun: string;
}
SummarizePronoun.init(
  {
    userID: { type: DataTypes.STRING, allowNull: false, unique: true },
    pronoun: { type: DataTypes.STRING, allowNull: false },
  },
  { sequelize: summarizePronounDatabase, modelName: "SummarizePronoun" }
);

export const tags = {
  summarizeState: SummarizeState,
  summarizeOptIn: SummarizeOptIn,
  summarizeNick: SummarizeNick,
  summarizePronoun: SummarizePronoun,
};

clientReady(
  client,
  [summarizeStateDatabase, summarizeOptInDatabase, summarizeNickDatabase, summarizePronounDatabase],
  [SummarizeState, SummarizeOptIn, SummarizeNick, SummarizePronoun]
);
interactionCreate(client);

client
  .login(process.env.DISCORD_TOKEN)
  .catch((err) => console.error("Failed to login:", err));
