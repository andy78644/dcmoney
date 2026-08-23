import { ApplicationError } from "../application/errors";
import type {
  CommandOption,
  DiscordInteraction,
} from "./types";

export function requireGuildId(interaction: DiscordInteraction): string {
  if (interaction.guild_id === undefined) {
    throw new ApplicationError(
      "INVALID_INPUT",
      "This command can only be used in a Discord server.",
    );
  }
  return interaction.guild_id;
}

export function requireActorUserId(interaction: DiscordInteraction): string {
  const userId = interaction.member?.user.id ?? interaction.user?.id;
  if (userId === undefined) {
    throw new ApplicationError("INVALID_INPUT", "Discord user is missing.");
  }
  return userId;
}

export function actorDisplayName(
  interaction: DiscordInteraction,
): string | undefined {
  const nick = interaction.member?.nick;
  if (typeof nick === "string" && nick.length > 0) {
    return nick;
  }
  const user = interaction.member?.user ?? interaction.user;
  const globalName = user?.global_name;
  if (typeof globalName === "string" && globalName.length > 0) {
    return globalName;
  }
  return user?.username;
}

export function resolvedDisplayName(
  interaction: DiscordInteraction,
  userId: string,
): string | undefined {
  const resolved = interaction.data?.resolved;
  const nick = resolved?.members?.[userId]?.nick;
  if (typeof nick === "string" && nick.length > 0) {
    return nick;
  }
  const user = resolved?.users?.[userId];
  const globalName = user?.global_name;
  if (typeof globalName === "string" && globalName.length > 0) {
    return globalName;
  }
  return user?.username;
}

export function getSubcommand(
  options: CommandOption[] | undefined,
): { group?: string; name: string; options: CommandOption[] } {
  const first = options?.[0];
  if (first === undefined || (first.type !== 1 && first.type !== 2)) {
    throw new ApplicationError("INVALID_INPUT", "Subcommand is missing.");
  }
  if (first.type === 1) {
    return { name: first.name, options: first.options ?? [] };
  }
  const nested = first.options?.[0];
  if (nested === undefined || nested.type !== 1) {
    throw new ApplicationError("INVALID_INPUT", "Subcommand is missing.");
  }
  return {
    group: first.name,
    name: nested.name,
    options: nested.options ?? [],
  };
}

export function requiredString(
  options: readonly CommandOption[],
  name: string,
): string {
  const value = options.find((option) => option.name === name)?.value;
  if (typeof value !== "string" || value.length === 0) {
    throw new ApplicationError(
      "INVALID_INPUT",
      `Required option ${name} is missing.`,
    );
  }
  return value;
}

export function optionalString(
  options: readonly CommandOption[],
  name: string,
): string | undefined {
  const value = options.find((option) => option.name === name)?.value;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function optionalBoolean(
  options: readonly CommandOption[],
  name: string,
): boolean {
  return options.find((option) => option.name === name)?.value === true;
}

export function optionalInteger(
  options: readonly CommandOption[],
  name: string,
): number | undefined {
  const value = options.find((option) => option.name === name)?.value;
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

export function modalValue(
  interaction: DiscordInteraction,
  customId: string,
): string {
  for (const row of interaction.data?.components ?? []) {
    const component = row.components?.find(
      (candidate) => candidate.custom_id === customId,
    );
    if (component?.value !== undefined) {
      return component.value;
    }
  }
  throw new ApplicationError(
    "INVALID_INPUT",
    `Modal value ${customId} is missing.`,
  );
}

/** Finds an option's value anywhere in the (possibly nested) option tree. */
export function findOptionValue(
  options: readonly CommandOption[] | undefined,
  name: string,
): string | undefined {
  for (const option of options ?? []) {
    if (option.name === name && typeof option.value === "string") {
      return option.value;
    }
    const nested = findOptionValue(option.options, name);
    if (nested !== undefined) {
      return nested;
    }
  }
  return undefined;
}

export function findFocusedOption(
  options: readonly CommandOption[] | undefined,
): CommandOption | undefined {
  for (const option of options ?? []) {
    if (option.focused === true) {
      return option;
    }
    const nested = findFocusedOption(option.options);
    if (nested !== undefined) {
      return nested;
    }
  }
  return undefined;
}
