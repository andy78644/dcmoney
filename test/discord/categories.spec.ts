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

async function fixture() {
  sequence += 1;
  const guildId = `7710${sequence}`;
  const owner = `7720${sequence}`;
  const friend = `7730${sequence}`;
  const ledgers = new LedgerService(env.DB);
  const ledger = await ledgers.create({
    interactionId: `cat-l-${sequence}`,
    guildId,
    actorUserId: owner,
    name: `Cat ${sequence}`,
    currencyCode: "TWD",
    currencyScale: 0,
  });
  await ledgers.addMember({
    interactionId: `cat-m-${sequence}`,
    ledgerId: ledger.id,
    guildId,
    actorUserId: owner,
    memberUserId: friend,
  });
  return { guildId, owner, friend, ledger, transactions: new TransactionService(env.DB) };
}

const expense = (
  t: TransactionService,
  ledgerId: string,
  guildId: string,
  owner: string,
  friend: string,
  category: string | undefined,
  amount: number,
  day: string,
) =>
  t.createExpense({
    interactionId: `cat-e-${++sequence}`,
    ledgerId,
    guildId,
    actorUserId: owner,
    payerUserId: owner,
    totalAmountMinor: amount,
    shares: [{ userId: friend, amountMinor: amount }],
    occurredOn: day,
    ...(category === undefined ? {} : { category }),
  });

describe("expense categories", () => {
  it("stores a category and leaves it null when omitted", async () => {
    const { guildId, owner, friend, ledger, transactions } = await fixture();
    const tagged = await expense(transactions, ledger.id, guildId, owner, friend, "餐飲", 100, "2026-08-29");
    const bare = await expense(transactions, ledger.id, guildId, owner, friend, undefined, 100, "2026-08-29");
    expect(tagged.category).toBe("餐飲");
    expect(bare.category).toBeNull();
  });

  it("trims blank categories to null rather than storing whitespace", async () => {
    const { guildId, owner, friend, ledger, transactions } = await fixture();
    const spaced = await expense(transactions, ledger.id, guildId, owner, friend, "   ", 100, "2026-08-29");
    expect(spaced.category).toBeNull();
  });

  it("filters the history by category", async () => {
    const { guildId, owner, friend, ledger, transactions } = await fixture();
    await expense(transactions, ledger.id, guildId, owner, friend, "餐飲", 100, "2026-08-29");
    await expense(transactions, ledger.id, guildId, owner, friend, "交通", 200, "2026-08-29");
    const only = await transactions.list({
      ledgerId: ledger.id,
      guildId,
      actorUserId: owner,
      category: "交通",
    });
    expect(only).toHaveLength(1);
    expect(only[0]?.totalAmountMinor).toBe(200);
  });

  it("suggests the categories this ledger has actually used", async () => {
    const { guildId, owner, friend, ledger, transactions } = await fixture();
    await expense(transactions, ledger.id, guildId, owner, friend, "餐飲", 100, "2026-08-27");
    await expense(transactions, ledger.id, guildId, owner, friend, "交通", 100, "2026-08-29");
    await expense(transactions, ledger.id, guildId, owner, friend, "餐飲", 100, "2026-08-28");

    const choices = await json(
      await act(`cat-ac-${++sequence}`, 4, guildId, owner, {
        name: "expense",
        options: [
          {
            name: "add",
            type: 1,
            options: [
              { name: "ledger", type: 3, value: ledger.id },
              { name: "category", type: 3, value: "", focused: true },
            ],
          },
        ],
      }),
    );
    // Most recently used first, and no duplicates.
    expect(choices.data?.choices?.map((c) => c.value)).toEqual(["交通", "餐飲"]);
  });

  it("narrows suggestions by what has been typed", async () => {
    const { guildId, owner, friend, ledger, transactions } = await fixture();
    await expense(transactions, ledger.id, guildId, owner, friend, "餐飲", 100, "2026-08-29");
    await expense(transactions, ledger.id, guildId, owner, friend, "交通", 100, "2026-08-29");
    const choices = await json(
      await act(`cat-ac2-${++sequence}`, 4, guildId, owner, {
        name: "expenses",
        options: [
          { name: "ledger", type: 3, value: ledger.id },
          { name: "category", type: 3, value: "交", focused: true },
        ],
      }),
    );
    expect(choices.data?.choices?.map((c) => c.value)).toEqual(["交通"]);
  });

  it("rejects a category longer than the column allows", async () => {
    const { guildId, owner, friend, ledger, transactions } = await fixture();
    await expect(
      expense(transactions, ledger.id, guildId, owner, friend, "x".repeat(31), 100, "2026-08-29"),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
