import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { LedgerService } from "../../src/application/ledger-service";
import { TransactionService } from "../../src/application/transaction-service";
import { todayInTaipei } from "../../src/discord/date";
import { routeInteraction } from "../../src/discord/router";
import type { DiscordInteraction } from "../../src/discord/types";

interface Component {
  custom_id?: string;
  label?: string;
  options?: Array<{ value: string }>;
}

interface ResponsePayload {
  type: number;
  data?: {
    content?: string;
    custom_id?: string;
    components?: Array<{ components?: Component[] }>;
  };
}

let sequence = 0;

async function payload(response: Response): Promise<ResponsePayload> {
  return (await response.json()) as ResponsePayload;
}

function interaction(
  id: string,
  type: number,
  guildId: string,
  userId: string,
  data: DiscordInteraction["data"],
): DiscordInteraction {
  return {
    id,
    type,
    guild_id: guildId,
    member: { user: { id: userId } },
    ...(data === undefined ? {} : { data }),
  };
}

function componentByPrefix(
  response: ResponsePayload,
  prefix: string,
): Component & { custom_id: string } {
  const components = response.data?.components?.flatMap(
    (row) => row.components ?? [],
  );
  const component = components?.find((item) =>
    item.custom_id?.startsWith(prefix),
  );
  if (component?.custom_id === undefined) {
    throw new Error(`No component starts with ${prefix}.`);
  }
  return component as Component & { custom_id: string };
}

async function fixture() {
  sequence += 1;
  const guildId = `9100${sequence}`;
  const ownerUserId = `9200${sequence}`;
  const memberUserId = `9300${sequence}`;
  const ledgers = new LedgerService(env.DB);
  const ledger = await ledgers.create({
    interactionId: `query-ledger-${sequence}`,
    guildId,
    actorUserId: ownerUserId,
    name: `Query ${sequence}`,
    currencyCode: "TWD",
    currencyScale: 0,
  });
  await ledgers.addMember({
    interactionId: `query-member-${sequence}`,
    ledgerId: ledger.id,
    guildId,
    actorUserId: ownerUserId,
    memberUserId,
  });
  const transactions = new TransactionService(env.DB);
  const expense = await transactions.createExpense({
    interactionId: `query-expense-${sequence}`,
    ledgerId: ledger.id,
    guildId,
    actorUserId: ownerUserId,
    payerUserId: ownerUserId,
    totalAmountMinor: 100,
    shares: [{ userId: memberUserId, amountMinor: 100 }],
    description: "午餐",
    occurredOn: "2026-08-18",
  });
  return {
    guildId,
    ownerUserId,
    memberUserId,
    ledger,
    expense,
    transactions,
  };
}

describe("history, balances and settlement interactions", () => {
  it("lists filtered transactions and opens an expense detail", async () => {
    const { guildId, memberUserId, ledger, expense } = await fixture();
    const list = await payload(
      await routeInteraction(
        interaction(`history-${++sequence}`, 2, guildId, memberUserId, {
          name: "expenses",
          options: [
            { name: "ledger", type: 3, value: ledger.id },
            { name: "member", type: 6, value: memberUserId },
            { name: "start_date", type: 3, value: "2026-08-01" },
          ],
        }),
        env,
      ),
    );
    expect(list.type).toBe(4);
    expect(list.data?.content).toContain("午餐");
    const select = componentByPrefix(list, "history_select:");
    expect(select.options?.[0]?.value).toBe(expense.id);

    const detail = await payload(
      await routeInteraction(
        interaction(`history-select-${++sequence}`, 3, guildId, memberUserId, {
          custom_id: select.custom_id,
          values: [expense.id],
        }),
        env,
      ),
    );
    expect(detail.type).toBe(7);
    expect(detail.data?.content).toContain("支出明細");
    expect(detail.data?.content).toContain(`<@${memberUserId}>：TWD 100`);
  });

  it("records a partial settlement from the balance flow", async () => {
    const { guildId, ownerUserId, memberUserId, ledger, transactions } =
      await fixture();
    const balances = await payload(
      await routeInteraction(
        interaction(`balances-${++sequence}`, 2, guildId, memberUserId, {
          name: "balances",
          options: [{ name: "ledger", type: 3, value: ledger.id }],
        }),
        env,
      ),
    );
    expect(balances.data?.content).toContain("簡化後欠款");
    const select = componentByPrefix(balances, "balance_select:");

    const selected = await payload(
      await routeInteraction(
        interaction(`balance-select-${++sequence}`, 3, guildId, memberUserId, {
          custom_id: select.custom_id,
          values: ["0"],
        }),
        env,
      ),
    );
    const partial = componentByPrefix(selected, "balance_partial:");
    const amountModal = await payload(
      await routeInteraction(
        interaction(`balance-partial-${++sequence}`, 3, guildId, memberUserId, {
          custom_id: partial.custom_id,
        }),
        env,
      ),
    );
    expect(amountModal.type).toBe(9);
    const modalCustomId = amountModal.data?.custom_id;
    if (modalCustomId === undefined) {
      throw new Error("Partial settlement modal has no custom ID.");
    }

    const settled = await payload(
      await routeInteraction(
        interaction(`balance-submit-${++sequence}`, 5, guildId, memberUserId, {
          custom_id: modalCustomId,
          components: [
            { components: [{ custom_id: "amount", value: "40" }] },
          ],
        }),
        env,
      ),
    );
    expect(settled.data?.content).toContain("部分還款 TWD 40");
    await expect(
      transactions.getSuggestions({
        ledgerId: ledger.id,
        guildId,
        actorUserId: ownerUserId,
      }),
    ).resolves.toEqual([
      {
        debtorUserId: memberUserId,
        creditorUserId: ownerUserId,
        amountMinor: 60,
      },
    ]);
  });

  it("supports direct full settlement and read-only historical balances", async () => {
    const { guildId, ownerUserId, memberUserId, ledger, transactions } =
      await fixture();
    const historical = await payload(
      await routeInteraction(
        interaction(`historical-${++sequence}`, 2, guildId, ownerUserId, {
          name: "balances",
          options: [
            { name: "ledger", type: 3, value: ledger.id },
            { name: "as_of", type: 3, value: "2026-08-18" },
          ],
        }),
        env,
      ),
    );
    expect(historical.data?.content).toContain("截至 2026-08-18");
    expect(historical.data?.components).toEqual([]);

    const settled = await payload(
      await routeInteraction(
        interaction(`direct-settle-${++sequence}`, 2, guildId, ownerUserId, {
          name: "settle",
          options: [
            { name: "ledger", type: 3, value: ledger.id },
            { name: "payer", type: 6, value: memberUserId },
            { name: "receiver", type: 6, value: ownerUserId },
          ],
        }),
        env,
      ),
    );
    expect(settled.data?.content).toContain("已記錄還款");
    await expect(
      transactions.getSuggestions({
        ledgerId: ledger.id,
        guildId,
        actorUserId: ownerUserId,
      }),
    ).resolves.toEqual([]);
  });
});

describe("Taipei date default", () => {
  it("uses the Taipei calendar day at the UTC boundary", () => {
    expect(todayInTaipei(new Date("2026-08-17T16:30:00.000Z"))).toBe(
      "2026-08-18",
    );
  });
});
