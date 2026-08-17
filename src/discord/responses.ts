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

export function ephemeral(content: string, components: unknown[] = []): Response {
  return interactionJson({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content,
      flags: InteractionResponseFlags.EPHEMERAL,
      allowed_mentions: { parse: [] },
      components,
    },
  });
}

export function updateMessage(
  content: string,
  components: unknown[] = [],
): Response {
  return interactionJson({
    type: InteractionResponseType.UPDATE_MESSAGE,
    data: {
      content,
      components,
      allowed_mentions: { parse: [] },
    },
  });
}

export function modal(input: {
  customId: string;
  title: string;
  fields: Array<{
    customId: string;
    label: string;
    value?: string;
    placeholder?: string;
    required?: boolean;
    maxLength?: number;
    style?: 1 | 2;
  }>;
}): Response {
  return interactionJson({
    type: InteractionResponseType.MODAL,
    data: {
      custom_id: input.customId,
      title: input.title,
      components: input.fields.map((field) => ({
        type: 1,
        components: [
          {
            type: 4,
            custom_id: field.customId,
            label: field.label,
            style: field.style ?? 1,
            required: field.required ?? true,
            ...(field.value === undefined ? {} : { value: field.value }),
            ...(field.placeholder === undefined
              ? {}
              : { placeholder: field.placeholder }),
            ...(field.maxLength === undefined
              ? {}
              : { max_length: field.maxLength }),
          },
        ],
      })),
    },
  });
}

export function autocomplete(choices: InteractionChoice[]): Response {
  return interactionJson({
    type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
    data: { choices: choices.slice(0, 25) },
  });
}
