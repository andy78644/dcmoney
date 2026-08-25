import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { LedgerService } from "../../src/application/ledger-service";
import { TransactionService } from "../../src/application/transaction-service";
import { routeInteraction } from "../../src/discord/router";

let sequence = 0;

interface Field {
  custom_id?: string;
  value?: string;
  values?: string[];
  type?: number;
  options?: Array<{ label: string; value: string; default?: boolean }>;
}
interface Reply {
  type?: number;
  data?: {
    content?: string;
    custom_id?: string;
    components?: Array<{
      type?: number;
      label?: string;
      component?: Field;
      components?: Field[];
    }>;
  };
}

const json = async (r: Response) => (await r.json()) as Reply;

const act = (id: string, type: number, guildId: string, userId: string, data: unknown) =>
  routeInteraction(
    { id, type, guild_id: guildId, member: { user: { id: userId } }, data } as never,
    env,
  );

async function fixture() {
  sequence += 1;
  const guildId = `4410${sequence}`;
  const owner = `4420${sequence}`;
  const friend = `4430${sequence}`;
  const ledgers = new LedgerService(env.DB);
  const ledger = await ledgers.create({
    interactionId: `em-l-${sequence}`,
    guildId,
    actorUserId: owner,
    name: `Edit ${sequence}`,
    currencyCode: "TWD",
    currencyScale: 0,
    displayName: "阿肥",
  });
  await ledgers.addMember({
    interactionId: `em-m-${sequence}`,
    ledgerId: ledger.id,
    guildId,
    actorUserId: owner,
    memberUserId: friend,
    displayName: "小明",
  });
  const expense = await new TransactionService(env.DB).createExpense({
    interactionId: `em-e-${sequence}`,
    ledgerId: ledger.id,
    guildId,
    actorUserId: owner,
    payerUserId: owner,
    totalAmountMinor: 300,
    shares: [
      { userId: owner, amountMinor: 150 },
      { userId: friend, amountMinor: 150 },
    ],
    description: "午餐",
    occurredOn: "2026-08-24",
  });
  return { guildId, owner, friend, ledger, expense };
}

/** Drives /expenses → select → edit, returning the modal. */
async function openEditModal(
  guildId: string,
  userId: string,
  ledgerId: string,
  transactionId: string,
) {
  const list = await json(
    await act(`em-list-${++sequence}`, 2, guildId, userId, {
      name: "expenses",
      options: [{ name: "ledger", type: 3, value: ledgerId }],
    }),
  );
  const select = list.data?.components?.[0]?.components?.[0];
  const detail = await json(
    await act(`em-sel-${++sequence}`, 3, guildId, userId, {
      custom_id: select?.custom_id,
      values: [transactionId],
    }),
  );
  const editButton = (detail.data?.components?.[0]?.components ?? []).find(
    (c) => c.custom_id?.startsWith("history_edit:"),
  );
  return json(
    await act(`em-open-${++sequence}`, 3, guildId, userId, {
      custom_id: editButton?.custom_id,
    }),
  );
}

describe("expense edit form", () => {
  it("offers the payer as a named select, not a raw id box", async () => {
    const { guildId, owner, friend, ledger, expense } = await fixture();
    const m = await openEditModal(guildId, owner, ledger.id, expense.id);

    const payer = m.data?.components?.find(
      (c) => c.component?.custom_id === "payer",
    );
    // 18 = Label, the wrapper that lets a modal carry a select at all.
    expect(payer?.type).toBe(18);
    expect(payer?.component?.type).toBe(3);
    expect(payer?.component?.options).toEqual([
      { label: "阿肥", value: owner, default: true },
      { label: "小明", value: friend },
    ]);
  });

  it("prefills shares with names rather than ids", async () => {
    const { guildId, owner, ledger, expense } = await fixture();
    const m = await openEditModal(guildId, owner, ledger.id, expense.id);
    const shares = m.data?.components?.find(
      (c) => c.component?.custom_id === "shares",
    );
    expect(shares?.component?.value).toBe("阿肥=150\n小明=150");
  });

  it("accepts shares written by display name", async () => {
    const { guildId, owner, friend, ledger, expense } = await fixture();
    const m = await openEditModal(guildId, owner, ledger.id, expense.id);
    const done = await json(
      await act(`em-sub-${++sequence}`, 5, guildId, owner, {
        custom_id: m.data?.custom_id,
        components: [
          { type: 18, component: { custom_id: "amount", value: "400" } },
          { type: 18, component: { custom_id: "date", value: "2026-08-25" } },
          { type: 18, component: { custom_id: "payer", values: [friend] } },
          {
            type: 18,
            component: { custom_id: "shares", value: "阿肥=250\n小明=150" },
          },
          { type: 18, component: { custom_id: "description", value: "晚餐" } },
        ],
      }),
    );
    expect(done.data?.content).toContain("已更新紀錄");

    const updated = await new TransactionService(env.DB).get({
      ledgerId: ledger.id,
      guildId,
      actorUserId: owner,
      transactionId: expense.id,
    });
    expect(updated).toMatchObject({
      totalAmountMinor: 400,
      payerUserId: friend,
      description: "晚餐",
    });
    expect(updated.type === "expense" && updated.shares).toEqual([
      { userId: owner, amountMinor: 250 },
      { userId: friend, amountMinor: 150 },
    ]);
  });

  it("splits evenly among the same people when shares are left blank", async () => {
    const { guildId, owner, friend, ledger, expense } = await fixture();
    const m = await openEditModal(guildId, owner, ledger.id, expense.id);
    const done = await json(
      await act(`em-blank-${++sequence}`, 5, guildId, owner, {
        custom_id: m.data?.custom_id,
        components: [
          { type: 18, component: { custom_id: "amount", value: "500" } },
          { type: 18, component: { custom_id: "date", value: "2026-08-24" } },
          { type: 18, component: { custom_id: "payer", values: [owner] } },
          { type: 18, component: { custom_id: "shares", value: "" } },
          { type: 18, component: { custom_id: "description", value: "午餐" } },
        ],
      }),
    );
    expect(done.data?.content).toContain("已更新紀錄");

    const updated = await new TransactionService(env.DB).get({
      ledgerId: ledger.id,
      guildId,
      actorUserId: owner,
      transactionId: expense.id,
    });
    expect(updated.type === "expense" && updated.shares).toEqual([
      { userId: owner, amountMinor: 250 },
      { userId: friend, amountMinor: 250 },
    ]);
  });

  it("says which name it could not resolve", async () => {
    const { guildId, owner, ledger, expense } = await fixture();
    const m = await openEditModal(guildId, owner, ledger.id, expense.id);
    const failed = await json(
      await act(`em-bad-${++sequence}`, 5, guildId, owner, {
        custom_id: m.data?.custom_id,
        components: [
          { type: 18, component: { custom_id: "amount", value: "300" } },
          { type: 18, component: { custom_id: "date", value: "2026-08-24" } },
          { type: 18, component: { custom_id: "payer", values: [owner] } },
          {
            type: 18,
            component: { custom_id: "shares", value: "不存在的人=300" },
          },
          { type: 18, component: { custom_id: "description", value: "" } },
        ],
      }),
    );
    expect(failed.data?.content).toContain("不存在的人");
  });
});
