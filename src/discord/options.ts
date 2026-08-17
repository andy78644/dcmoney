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
