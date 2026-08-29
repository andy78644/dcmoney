import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { LedgerService } from "../../src/application/ledger-service";
import { TransactionService } from "../../src/application/transaction-service";
import { routeInteraction } from "../../src/discord/router";

let sequence = 0;
interface Reply { data?: { content?: string; flags?: number } }
const json = async (r: Response) => (await r.json()) as Reply;

async function fixture() {
  sequence += 1;
  const guildId = `6610${sequence}`;
  const a = `6620${sequence}`;
  const b = `6630${sequence}`;
  const ledgers = new LedgerService(env.DB);
  const ledger = await ledgers.create({
    interactionId: `sm-l-${sequence}`,
    guildId, actorUserId: a, name: `Sum ${sequence}`,
    currencyCode: "TWD", currencyScale: 0,
  });
  await ledgers.addMember({
    interactionId: `sm-m-${sequence}`, ledgerId: ledger.id, guildId,
    actorUserId: a, memberUserId: b,
  });
  const t = new TransactionService(env.DB);
  // a pays 300 split evenly; b pays 100 all their own.
  await t.createExpense({
    interactionId: `sm-e1-${sequence}`, ledgerId: ledger.id, guildId,
    actorUserId: a, payerUserId: a, totalAmountMinor: 300,
    shares: [{ userId: a, amountMinor: 150 }, { userId: b, amountMinor: 150 }],
    category: "餐飲", occurredOn: "2026-08-20",
  });
  await t.createExpense({
    interactionId: `sm-e2-${sequence}`, ledgerId: ledger.id, guildId,
    actorUserId: b, payerUserId: b, totalAmountMinor: 100,
    shares: [{ userId: b, amountMinor: 100 }],
    category: "交通", occurredOn: "2026-08-25",
  });
  return { guildId, a, b, ledger, t };
}

const summary = (guildId: string, user: string, ledgerId: string, extra: unknown[] = []) =>
  routeInteraction(
    {
      id: `sm-cmd-${++sequence}`, type: 2, guild_id: guildId,
      member: { user: { id: user } },
      data: { name: "summary", options: [{ name: "ledger", type: 3, value: ledgerId }, ...extra] },
    } as never,
    env,
  );

describe("/summary", () => {
  it("reports the total, each member's paid vs share, and categories", async () => {
    const { guildId, a, b, ledger } = await fixture();
    const out = (await json(await summary(guildId, a, ledger.id))).data?.content ?? "";

    expect(out).toContain("總支出：TWD 400，共 2 筆");
    // a paid 300, was allocated 150 → owed 150 back.
    expect(out).toContain(`<@${a}>：付出 TWD 300｜分攤 TWD 150｜應收 TWD 150`);
    // b paid 100, was allocated 250 → owes 150.
    expect(out).toContain(`<@${b}>：付出 TWD 100｜分攤 TWD 250｜應付 TWD 150`);
    expect(out).toContain("餐飲：TWD 300（75%）");
    expect(out).toContain("交通：TWD 100（25%）");
  });

  it("honours a date range", async () => {
    const { guildId, a, ledger } = await fixture();
    const out = (
      await json(
        await summary(guildId, a, ledger.id, [
          { name: "end_date", type: 3, value: "2026-08-20" },
        ]),
      )
    ).data?.content ?? "";
    expect(out).toContain("總支出：TWD 300，共 1 筆");
    expect(out).not.toContain("交通");
  });

  it("says so when the range holds nothing", async () => {
    const { guildId, a, ledger } = await fixture();
    const out = (
      await json(
        await summary(guildId, a, ledger.id, [
          { name: "start_date", type: 3, value: "2027-01-01" },
        ]),
      )
    ).data?.content ?? "";
    expect(out).toContain("沒有支出");
  });

  it("can be shown to the channel", async () => {
    const { guildId, a, ledger } = await fixture();
    const shown = await json(
      await summary(guildId, a, ledger.id, [{ name: "public", type: 5, value: true }]),
    );
    expect(shown.data?.flags).toBeUndefined();
  });

  it("refuses a non-member", async () => {
    const { guildId, ledger } = await fixture();
    const out = (await json(await summary(guildId, "6699999", ledger.id))).data?.content ?? "";
    expect(out).toContain("沒有權限");
  });
});
