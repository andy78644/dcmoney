export interface DiscordEnv extends Env {
  DISCORD_PUBLIC_KEY: string;
}

export interface DiscordUser {
  id: string;
  username?: string;
}

export interface CommandOption {
  name: string;
  type: number;
  value?: string | number | boolean;
  focused?: boolean;
  options?: CommandOption[];
}

export interface InteractionData {
  name?: string;
  options?: CommandOption[];
  custom_id?: string;
  values?: string[];
  components?: Array<{
    components?: Array<{ custom_id?: string; value?: string }>;
  }>;
}

export interface DiscordInteraction {
  id: string;
  type: number;
  guild_id?: string;
  member?: { user: DiscordUser };
  user?: DiscordUser;
  data?: InteractionData;
}

export interface InteractionChoice {
  name: string;
  value: string;
}

export interface InteractionResponseData {
  content?: string;
  flags?: number;
  allowed_mentions?: { parse: string[] };
  choices?: InteractionChoice[];
  components?: unknown[];
  custom_id?: string;
  title?: string;
}

export interface InteractionResponse {
  type: number;
  data?: InteractionResponseData;
}
