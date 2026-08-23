import { formatMinorAmount } from "../domain/money";
import type { Share } from "../domain/accounting";
import type { DiscordInteraction } from "./types";

interface Currency {
  currencyCode: string;
  currencyScale: number;
}

function money(amountMinor: number, currency: Currency): string {
  return `${currency.currencyCode} ${formatMinorAmount(
    amountMinor,
    currency.currencyScale,
  )}`;
}

export function expenseAnnouncement(input: {
  actorUserId: string;
  ledgerName: string;
  description: string;
  payerUserId: string;
  totalAmountMinor: number;
  occurredOn: string;
  shares: readonly Share[];
  currency: Currency;
}): string {
  return [
    `📒 <@${input.actorUserId}> 在「${input.ledgerName}」記了一筆支出`,
    `${input.occurredOn}｜${input.description || "未命名支出"}｜${money(
      input.totalAmountMinor,
      input.currency,
    )}`,
    `付款者：<@${input.payerUserId}>`,
    "分攤：",
    ...input.shares.map(
      ({ userId, amountMinor }) =>
        `• <@${userId}>：${money(amountMinor, input.currency)}`,
    ),
  ].join("\n");
}

export function settlementAnnouncement(input: {
  actorUserId: string;
  ledgerName: string;
  payerUserId: string;
  receiverUserId: string;
  amountMinor: number;
  occurredOn: string;
  currency: Currency;
}): string {
  return [
    `💸 <@${input.actorUserId}> 在「${input.ledgerName}」記了一筆還款`,
    `${input.occurredOn}｜<@${input.payerUserId}> → <@${
      input.receiverUserId
    }>｜${money(input.amountMinor, input.currency)}`,
  ].join("\n");
}

export function changeAnnouncement(input: {
  actorUserId: string;
  ledgerName: string;
  action: "update" | "delete";
  description: string;
  totalAmountMinor: number;
  occurredOn: string;
  currency: Currency;
}): string {
  const verb = input.action === "update" ? "修改" : "刪除";
  const icon = input.action === "update" ? "✏️" : "🗑️";
  return [
    `${icon} <@${input.actorUserId}> ${verb}了「${input.ledgerName}」的一筆紀錄`,
    `${input.occurredOn}｜${input.description || "未命名"}｜${money(
      input.totalAmountMinor,
      input.currency,
    )}`,
  ].join("\n");
}

/**
 * Posts a channel-visible follow-up for the interaction.
 *
 * Uses the interaction token rather than the bot token, so the Worker needs no
 * bot credentials. Runs through `waitUntil` because a follow-up is only valid
 * once Discord has our initial response, and the caller has not returned it yet.
 * Without a token, application id or execution context — as in tests — this is
 * a no-op.
 */
export function announce(
  interaction: DiscordInteraction,
  content: string,
  ctx?: ExecutionContext,
): void {
  const { token, application_id: applicationId } = interaction;
  if (
    token === undefined ||
    applicationId === undefined ||
    ctx === undefined
  ) {
    return;
  }
  const post = fetch(
    `https://discord.com/api/v10/webhooks/${applicationId}/${token}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content,
        allowed_mentions: { parse: [] },
      }),
    },
  ).then(async (response) => {
    if (!response.ok) {
      console.warn("Announcement failed", {
        status: response.status,
        body: await response.text(),
      });
    }
  });
  ctx.waitUntil(post);
}
