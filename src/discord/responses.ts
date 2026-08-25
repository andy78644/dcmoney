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

/** Visible to everyone in the channel. Mentions stay inert. */
export function publicMessage(content: string): Response {
  return interactionJson({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content,
      allowed_mentions: { parse: [] },
      components: [],
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

export interface ModalTextField {
  kind?: "text";
  customId: string;
  label: string;
  description?: string;
  value?: string;
  placeholder?: string;
  required?: boolean;
  maxLength?: number;
  style?: 1 | 2;
}

export interface ModalSelectField {
  kind: "select";
  customId: string;
  label: string;
  description?: string;
  required?: boolean;
  options: Array<{ label: string; value: string; default?: boolean }>;
}

export type ModalField = ModalTextField | ModalSelectField;

/**
 * Builds a modal.
 *
 * Every field is wrapped in a Label (type 18), the component that lets a modal
 * carry select menus rather than text inputs alone. Discord allows five
 * top-level components.
 */
export function modal(input: {
  customId: string;
  title: string;
  fields: ModalField[];
}): Response {
  return interactionJson({
    type: InteractionResponseType.MODAL,
    data: {
      custom_id: input.customId,
      title: input.title,
      components: input.fields.map((field) => ({
        type: 18,
        label: field.label,
        ...(field.description === undefined
          ? {}
          : { description: field.description }),
        component:
          field.kind === "select"
            ? {
                type: 3,
                custom_id: field.customId,
                required: field.required ?? true,
                min_values: field.required === false ? 0 : 1,
                max_values: 1,
                options: field.options.map(({ label, value, default: isDefault }) => ({
                  label: label.slice(0, 100),
                  value,
                  ...(isDefault === true ? { default: true } : {}),
                })),
              }
            : {
                type: 4,
                custom_id: field.customId,
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
