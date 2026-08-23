export interface DiscordEnv extends Env {
  DISCORD_PUBLIC_KEY: string;
}

export interface DiscordUser {
  id: string;
  username?: string;
  global_name?: string | null;
}

export interface ResolvedData {
  users?: Record<string, DiscordUser>;
  members?: Record<string, { nick?: string | null }>;
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
  resolved?: ResolvedData;
  components?: Array<{
    components?: Array<{ custom_id?: string; value?: string }>;
  }>;
}

export interface DiscordInteraction {
  id: string;
  type: number;
  token?: string;
  application_id?: string;
  guild_id?: string;
  member?: { user: DiscordUser; nick?: string | null };
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
