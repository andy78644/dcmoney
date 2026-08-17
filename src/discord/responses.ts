import {
  InteractionResponseFlags,
  InteractionResponseType,
} from "discord-interactions";

import type {
  InteractionChoice,
  InteractionResponse,
} from "./types";

export function interactionJson(
  payload: InteractionResponse,
  init?: ResponseInit,
): Response {
  return Response.json(payload, init);
}

export function ephemeral(content: string): Response {
  return interactionJson({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content,
      flags: InteractionResponseFlags.EPHEMERAL,
      allowed_mentions: { parse: [] },
    },
  });
}

export function autocomplete(choices: InteractionChoice[]): Response {
  return interactionJson({
    type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
    data: { choices: choices.slice(0, 25) },
  });
}
