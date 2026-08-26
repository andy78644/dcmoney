import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { LedgerService } from "../../src/application/ledger-service";
import { TransactionService } from "../../src/application/transaction-service";
import { routeInteraction } from "../../src/discord/router";

let sequence = 0;

interface Reply {
  data?: { content?: string; choices?: Array<{ name: string; value: string }> };
}
const json = async (r: Response) => (await r.json()) as Reply;

const act = (id: string, type: number, guildId: string, userId: string, data: unknown) =>
  routeInteraction(
    { id, type, guild_id: guildId, member: { user: { id: userId } }, data } as never,
    env,
  );

/** Debtor owes two different people, so "their whole debt" is the wrong number. */
async function twoCreditors() {
  sequence += 1;
  const guildId = `2210${sequence}`;
  const debtor = `2220${sequence}`;
  const alice = `2230${sequence}`;
  const bob = `2240${sequence}`;
  const ledgers = new LedgerService(env.DB);
  const ledger = await ledgers.create({
    interactionId: `sa-l-${sequence}`,
    guildId,
    actorUserId: debtor,
    name: `Settle ${sequence}`,
    currencyCode: "TWD",
    currencyScale: 0,
  });
  for (const id of [alice, bob]) {
    await ledgers.addMember({
      interactionId: `sa-m-${id}-${sequence}`,
      ledgerId: ledger.id,
      guildId,
      actorUserId: debtor,
      memberUserId: id,
    });
  }
  const transactions = new TransactionService(env.DB);
  // Alice fronts 100 for the debtor, Bob fronts 200.
  await transactions.createExpense({
    interactionId: `sa-e1-${sequence}`,
    ledgerId: ledger.id,
    guildId,
    actorUserId: debtor,
    payerUserId: alice,
    totalAmountMinor: 100,
    shares: [{ userId: debtor, amountMinor: 100 }],
    occurredOn: "2026-08-27",
  });
  await transactions.createExpense({
    interactionId: `sa-e2-${sequence}`,
    ledgerId: ledger.id,
    guildId,
    actorUserId: debtor,
    payerUserId: bob,
    totalAmountMinor: 200,
    shares: [{ userId: debtor, amountMinor: 200 }],
    occurredOn: "2026-08-27",
  });
  return { guildId, debtor, alice, bob, ledger, transactions };
}

const settle = (
  guildId: string,
  actor: string,
  ledgerId: string,
  payer: string,
  receiver: string,
  amount?: string,
) =>
  act(`sa-cmd-${++sequence}`, 2, guildId, actor, {
    name: "settle",
    options: [
      { name: "ledger", type: 3, value: ledgerId },
      { name: "payer", type: 3, value: payer },
      { name: "receiver", type: 3, value: receiver },
      ...(amount === undefined ? [] : [{ name: "amount", type: 3, value: amount }]),
    ],
  });

describe("/settle without an amount", () => {
  it("settles what this pair owes, not the payer's whole debt", async () => {
    const { guildId, debtor, alice, ledger, transactions } = await twoCreditors();
    // Total debt is 300, but only 100 of it is owed to Alice.
    await expect(
      transactions.getMemberDebt({
        ledgerId: ledger.id,
        guildId,
        actorUserId: debtor,
        memberUserId: debtor,
      }),
    ).resolves.toBe(300);

    const done = await json(
      await settle(guildId, debtor, ledger.id, debtor, alice),
    );
    expect(done.data?.content).toContain("TWD 100");
    expect(done.data?.content).not.toContain("300");

    // Alice is square; Bob is still owed 200.
    await expect(
      transactions.getSuggestions({
        ledgerId: ledger.id,
        guildId,
        actorUserId: debtor,
      }),
    ).resolves.toEqual([
      { debtorUserId: debtor, creditorUserId: expect.any(String), amountMinor: 200 },
    ]);
  });

  it("asks for an amount when the pair is not in the suggestions", async () => {
    const { guildId, debtor, alice, bob, ledger } = await twoCreditors();
    // Alice owes nobody, so alice -> bob is not a suggested settlement.
    const refused = await json(
      await settle(guildId, debtor, ledger.id, alice, bob),
    );
    expect(refused.data?.content).toContain("無法自動判斷金額");
  });

  it("still allows an explicit payment outside the suggested pairing", async () => {
    const { guildId, debtor, alice, bob, ledger, transactions } =
      await twoCreditors();
    // The debtor hands Alice 150 even though the graph pairs only 100 with her.
    const done = await json(
      await settle(guildId, debtor, ledger.id, debtor, alice, "150"),
    );
    expect(done.data?.content).toContain("TWD 150");
    // Alice was owed 100 and received 150, so she now owes 50 onward. Bob is
    // still owed his 200, now made up of two obligations.
    await expect(
      transactions.getSuggestions({
        ledgerId: ledger.id,
        guildId,
        actorUserId: debtor,
      }),
    ).resolves.toEqual([
      { debtorUserId: debtor, creditorUserId: bob, amountMinor: 150 },
      { debtorUserId: alice, creditorUserId: bob, amountMinor: 50 },
    ]);
  });

  it("suggests the pair amount in autocomplete, never the total", async () => {
    const { guildId, debtor, alice, ledger } = await twoCreditors();
    const choices = await json(
      await act(`sa-ac-${++sequence}`, 4, guildId, debtor, {
        name: "settle",
        options: [
          { name: "ledger", type: 3, value: ledger.id },
          { name: "payer", type: 3, value: debtor },
          { name: "receiver", type: 3, value: alice },
          { name: "amount", type: 3, value: "", focused: true },
        ],
      }),
    );
    expect(choices.data?.choices).toEqual([
      { name: "依建議結清：TWD 100", value: "100" },
    ]);
  });
});
