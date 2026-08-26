import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { LedgerService } from "../../src/application/ledger-service";
import { TransactionService } from "../../src/application/transaction-service";
import { routeInteraction } from "../../src/discord/router";
import type { DiscordInteraction } from "../../src/discord/types";

interface AutocompletePayload {
  data?: { choices?: Array<{ name: string; value: string }> };
}

let sequence = 0;

async function fixture() {
  sequence += 1;
  const guildId = `4400${sequence}`;
  const ownerUserId = `4410${sequence}`;
  const memberA = `4420${sequence}`;
  const ledgers = new LedgerService(env.DB);
  const ledger = await ledgers.create({
    interactionId: `ac-ledger-${sequence}`,
    guildId,
    actorUserId: ownerUserId,
    name: `Autocomplete ${sequence}`,
    currencyCode: "TWD",
    currencyScale: 0,
    displayName: "本人",
  });
  await ledgers.addMember({
    interactionId: `ac-member-${sequence}`,
    ledgerId: ledger.id,
    guildId,
    actorUserId: ownerUserId,
    memberUserId: memberA,
    displayName: "小明",
  });
  return { guildId, ownerUserId, memberA, ledger };
}

async function autocompleteFor(
  interaction: DiscordInteraction,
): Promise<Array<{ name: string; value: string }>> {
  const response = await routeInteraction(interaction, env);
  const body = (await response.json()) as AutocompletePayload;
  return body.data?.choices ?? [];
}

describe("member autocomplete", () => {
  it("suggests only ledger members, by display name", async () => {
    const { guildId, ownerUserId, memberA, ledger } = await fixture();
    const choices = await autocompleteFor({
      id: `ac-${++sequence}`,
      type: 4,
      guild_id: guildId,
      member: { user: { id: ownerUserId } },
      data: {
        name: "expense",
        options: [
          {
            name: "add",
            type: 1,
            options: [
              { name: "ledger", type: 3, value: ledger.id },
              { name: "payer", type: 3, value: "", focused: true },
            ],
          },
        ],
      },
    });

    expect(choices).toEqual([
      { name: "本人", value: ownerUserId },
      { name: "小明", value: memberA },
    ]);
  });

  it("filters suggestions by what was typed", async () => {
    const { guildId, ownerUserId, memberA, ledger } = await fixture();
    const choices = await autocompleteFor({
      id: `ac-${++sequence}`,
      type: 4,
      guild_id: guildId,
      member: { user: { id: ownerUserId } },
      data: {
        name: "settle",
        options: [
          { name: "ledger", type: 3, value: ledger.id },
          { name: "receiver", type: 3, value: "小", focused: true },
        ],
      },
    });

    expect(choices).toEqual([{ name: "小明", value: memberA }]);
  });

  it("returns nothing when no ledger has been chosen yet", async () => {
    const { guildId, ownerUserId } = await fixture();
    const choices = await autocompleteFor({
      id: `ac-${++sequence}`,
      type: 4,
      guild_id: guildId,
      member: { user: { id: ownerUserId } },
      data: {
        name: "settle",
        options: [{ name: "payer", type: 3, value: "", focused: true }],
      },
    });

    expect(choices).toEqual([]);
  });

  it("does not leak members of a ledger the caller cannot access", async () => {
    const { guildId, ledger } = await fixture();
    const stranger = "4499999";
    const choices = await autocompleteFor({
      id: `ac-${++sequence}`,
      type: 4,
      guild_id: guildId,
      member: { user: { id: stranger } },
      data: {
        name: "settle",
        options: [
          { name: "ledger", type: 3, value: ledger.id },
          { name: "payer", type: 3, value: "", focused: true },
        ],
      },
    });

    expect(choices).toEqual([]);
  });
});

describe("settle amount autocomplete", () => {
  it("offers the outstanding amount once payer and receiver are known", async () => {
    const { guildId, ownerUserId, memberA, ledger } = await fixture();
    // Owner pays 300, split evenly: memberA ends up owing 150.
    await new TransactionService(env.DB).createExpense({
      interactionId: `ac-exp-${++sequence}`,
      ledgerId: ledger.id,
      guildId,
      actorUserId: ownerUserId,
      payerUserId: ownerUserId,
      totalAmountMinor: 300,
      shares: [
        { userId: ownerUserId, amountMinor: 150 },
        { userId: memberA, amountMinor: 150 },
      ],
      occurredOn: "2026-08-24",
    });

    const choices = await autocompleteFor({
      id: `ac-${++sequence}`,
      type: 4,
      guild_id: guildId,
      member: { user: { id: ownerUserId } },
      data: {
        name: "settle",
        options: [
          { name: "ledger", type: 3, value: ledger.id },
          { name: "payer", type: 3, value: memberA },
          { name: "receiver", type: 3, value: ownerUserId },
          { name: "amount", type: 3, value: "", focused: true },
        ],
      },
    });

    expect(choices).toEqual([{ name: "全部結清：TWD 150", value: "150" }]);
  });

  it("offers nothing when the payer owes nothing", async () => {
    const { guildId, ownerUserId, memberA, ledger } = await fixture();
    await new TransactionService(env.DB).createExpense({
      interactionId: `ac-exp2-${++sequence}`,
      ledgerId: ledger.id,
      guildId,
      actorUserId: ownerUserId,
      payerUserId: ownerUserId,
      totalAmountMinor: 300,
      shares: [
        { userId: ownerUserId, amountMinor: 150 },
        { userId: memberA, amountMinor: 150 },
      ],
      occurredOn: "2026-08-24",
    });

    const choices = await autocompleteFor({
      id: `ac-${++sequence}`,
      type: 4,
      guild_id: guildId,
      member: { user: { id: ownerUserId } },
      data: {
        name: "settle",
        options: [
          { name: "ledger", type: 3, value: ledger.id },
          { name: "payer", type: 3, value: ownerUserId },
          { name: "receiver", type: 3, value: memberA },
          { name: "amount", type: 3, value: "", focused: true },
        ],
      },
    });

    expect(choices).toEqual([]);
  });
});
