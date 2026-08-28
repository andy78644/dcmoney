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
    flags?: number;
    allowed_mentions?: { parse: string[] };
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

  it("allows any ledger member to edit an expense from its detail", async () => {
    const { guildId, ownerUserId, memberUserId, ledger, expense, transactions } =
      await fixture();
    const list = await payload(
      await routeInteraction(
        interaction(`edit-list-${++sequence}`, 2, guildId, memberUserId, {
          name: "expenses",
          options: [{ name: "ledger", type: 3, value: ledger.id }],
        }),
        env,
      ),
    );
    const select = componentByPrefix(list, "history_select:");
    const detail = await payload(
      await routeInteraction(
        interaction(`edit-select-${++sequence}`, 3, guildId, memberUserId, {
          custom_id: select.custom_id,
          values: [expense.id],
        }),
        env,
      ),
    );
    const edit = componentByPrefix(detail, "history_edit:");
    const editModal = await payload(
      await routeInteraction(
        interaction(`edit-button-${++sequence}`, 3, guildId, memberUserId, {
          custom_id: edit.custom_id,
        }),
        env,
      ),
    );
    expect(editModal.type).toBe(9);
    const editCustomId = editModal.data?.custom_id;
    if (editCustomId === undefined) {
      throw new Error("Edit modal has no custom ID.");
    }

    const edited = await payload(
      await routeInteraction(
        interaction(`edit-submit-${++sequence}`, 5, guildId, memberUserId, {
          custom_id: editCustomId,
          components: [
            { components: [{ custom_id: "amount", value: "150" }] },
            { components: [{ custom_id: "date", value: "2026-08-19" }] },
            { components: [{ custom_id: "payer", value: ownerUserId }] },
            {
              components: [
                { custom_id: "shares", value: `${memberUserId}=150` },
              ],
            },
            {
              components: [
                { custom_id: "description", value: "更新後的午餐" },
              ],
            },
          ],
        }),
        env,
      ),
    );
    expect(edited.data?.content).toContain("已更新紀錄");
    await expect(
      transactions.get({
        ledgerId: ledger.id,
        guildId,
        actorUserId: ownerUserId,
        transactionId: expense.id,
      }),
    ).resolves.toMatchObject({
      revision: 2,
      totalAmountMinor: 150,
      description: "更新後的午餐",
      occurredOn: "2026-08-19",
    });
  });

  it("requires confirmation before soft deleting a transaction", async () => {
    const { guildId, ownerUserId, memberUserId, ledger, expense, transactions } =
      await fixture();
    const list = await payload(
      await routeInteraction(
        interaction(`delete-list-${++sequence}`, 2, guildId, memberUserId, {
          name: "expenses",
          options: [{ name: "ledger", type: 3, value: ledger.id }],
        }),
        env,
      ),
    );
    const select = componentByPrefix(list, "history_select:");
    const detail = await payload(
      await routeInteraction(
        interaction(`delete-select-${++sequence}`, 3, guildId, memberUserId, {
          custom_id: select.custom_id,
          values: [expense.id],
        }),
        env,
      ),
    );
    const deleteButton = componentByPrefix(detail, "history_delete:");
    const warning = await payload(
      await routeInteraction(
        interaction(`delete-button-${++sequence}`, 3, guildId, memberUserId, {
          custom_id: deleteButton.custom_id,
        }),
        env,
      ),
    );
    expect(warning.data?.content).toContain("確定要刪除");

    const confirm = componentByPrefix(warning, "history_delete_confirm:");
    const deleted = await payload(
      await routeInteraction(
        interaction(`delete-confirm-${++sequence}`, 3, guildId, memberUserId, {
          custom_id: confirm.custom_id,
        }),
        env,
      ),
    );
    expect(deleted.data?.content).toContain("已刪除紀錄");
    await expect(
      transactions.list({
        ledgerId: ledger.id,
        guildId,
        actorUserId: ownerUserId,
      }),
    ).resolves.toEqual([]);
    await expect(
      transactions.getSuggestions({
        ledgerId: ledger.id,
        guildId,
        actorUserId: ownerUserId,
      }),
    ).resolves.toEqual([]);
  });

  it("edits a settlement from the same history interface", async () => {
    const { guildId, ownerUserId, memberUserId, ledger, transactions } =
      await fixture();
    const settlement = await transactions.createSettlement({
      interactionId: `edit-settlement-create-${++sequence}`,
      ledgerId: ledger.id,
      guildId,
      actorUserId: memberUserId,
      payerUserId: memberUserId,
      receiverUserId: ownerUserId,
      amountMinor: 40,
      description: "先還一點",
      occurredOn: "2026-08-18",
    });
    const list = await payload(
      await routeInteraction(
        interaction(
          `edit-settlement-list-${++sequence}`,
          2,
          guildId,
          ownerUserId,
          {
            name: "expenses",
            options: [
              { name: "ledger", type: 3, value: ledger.id },
              { name: "kind", type: 3, value: "settlement" },
            ],
          },
        ),
        env,
      ),
    );
    const select = componentByPrefix(list, "history_select:");
    const detail = await payload(
      await routeInteraction(
        interaction(
          `edit-settlement-select-${++sequence}`,
          3,
          guildId,
          ownerUserId,
          { custom_id: select.custom_id, values: [settlement.id] },
        ),
        env,
      ),
    );
    const edit = componentByPrefix(detail, "history_edit:");
    const editModal = await payload(
      await routeInteraction(
        interaction(
          `edit-settlement-button-${++sequence}`,
          3,
          guildId,
          ownerUserId,
          { custom_id: edit.custom_id },
        ),
        env,
      ),
    );
    const editCustomId = editModal.data?.custom_id;
    if (editCustomId === undefined) {
      throw new Error("Settlement edit modal has no custom ID.");
    }
    const edited = await payload(
      await routeInteraction(
        interaction(
          `edit-settlement-submit-${++sequence}`,
          5,
          guildId,
          ownerUserId,
          {
            custom_id: editCustomId,
            components: [
              { components: [{ custom_id: "amount", value: "50" }] },
              { components: [{ custom_id: "date", value: "2026-08-19" }] },
              {
                components: [{ custom_id: "payer", value: memberUserId }],
              },
              {
                components: [{ custom_id: "receiver", value: ownerUserId }],
              },
              {
                components: [
                  { custom_id: "description", value: "改為還 50" },
                ],
              },
            ],
          },
        ),
        env,
      ),
    );
    expect(edited.data?.content).toContain("已更新紀錄");
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
        amountMinor: 50,
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

async function balanceFixture() {
  const guildId = `7710${++sequence}`;
  const ownerUserId = `7720${sequence}`;
  const memberA = `7730${sequence}`;
  const ledgers = new LedgerService(env.DB);
  const ledger = await ledgers.create({
    interactionId: `pub-ledger-${sequence}`,
    guildId,
    actorUserId: ownerUserId,
    name: `Public ${sequence}`,
    currencyCode: "TWD",
    currencyScale: 0,
  });
  await ledgers.addMember({
    interactionId: `pub-member-${sequence}`,
    ledgerId: ledger.id,
    guildId,
    actorUserId: ownerUserId,
    memberUserId: memberA,
  });
  await new TransactionService(env.DB).createExpense({
    interactionId: `pub-expense-${sequence}`,
    ledgerId: ledger.id,
    guildId,
    actorUserId: ownerUserId,
    payerUserId: ownerUserId,
    totalAmountMinor: 200,
    shares: [
      { userId: ownerUserId, amountMinor: 100 },
      { userId: memberA, amountMinor: 100 },
    ],
    occurredOn: "2026-08-24",
  });
  return { guildId, ownerUserId, memberA, ledger };
}

function balancesCommand(
  guildId: string,
  userId: string,
  ledgerId: string,
  isPublic: boolean,
) {
  return {
    id: `pub-cmd-${++sequence}`,
    type: 2,
    guild_id: guildId,
    member: { user: { id: userId } },
    data: {
      name: "balances",
      options: [
        { name: "ledger", type: 3, value: ledgerId },
        { name: "public", type: 5, value: isPublic },
      ],
    },
  } as never;
}

describe("public balances", () => {
  it("drops the ephemeral flag and the settle controls when public", async () => {
    const { guildId, ownerUserId, memberA, ledger } = await balanceFixture();

    const privateReply = await payload(
      await routeInteraction(
        balancesCommand(guildId, ownerUserId, ledger.id, false),
        env,
      ),
    );
    const publicReply = await payload(
      await routeInteraction(
        balancesCommand(guildId, ownerUserId, ledger.id, true),
        env,
      ),
    );

    // 64 is the ephemeral flag.
    expect(privateReply.data?.flags).toBe(64);
    expect(publicReply.data?.flags).toBeUndefined();

    // Same numbers either way.
    expect(publicReply.data?.content).toContain(`<@${memberA}>`);
    expect(publicReply.data?.content).toBe(privateReply.data?.content);

    // The private reply keeps the settle picker; the public one is read-only.
    expect(privateReply.data?.components?.length).toBeGreaterThan(0);
    expect(publicReply.data?.components ?? []).toHaveLength(0);

    // Mentions must stay inert once the message is visible to the channel.
    expect(publicReply.data?.allowed_mentions).toEqual({ parse: [] });
  });
});

describe("balance picker labels", () => {
  it("names the two people instead of printing their ids", async () => {
    sequence += 1;
    const guildId = `8810${sequence}`;
    const owner = `8820${sequence}`;
    const friend = `8830${sequence}`;
    const ledgers = new LedgerService(env.DB);
    const ledger = await ledgers.create({
      interactionId: `bl-l-${sequence}`,
      guildId,
      actorUserId: owner,
      name: `Picker ${sequence}`,
      currencyCode: "TWD",
      currencyScale: 0,
      displayName: "阿肥",
    });
    await ledgers.addMember({
      interactionId: `bl-m-${sequence}`,
      ledgerId: ledger.id,
      guildId,
      actorUserId: owner,
      memberUserId: friend,
      displayName: "小明",
    });
    await new TransactionService(env.DB).createExpense({
      interactionId: `bl-e-${sequence}`,
      ledgerId: ledger.id,
      guildId,
      actorUserId: owner,
      payerUserId: owner,
      totalAmountMinor: 400,
      shares: [{ userId: friend, amountMinor: 400 }],
      occurredOn: "2026-08-29",
    });

    const shown = await payload(
      await routeInteraction(
        {
          id: `bl-cmd-${++sequence}`,
          type: 2,
          guild_id: guildId,
          member: { user: { id: owner } },
          data: {
            name: "balances",
            options: [{ name: "ledger", type: 3, value: ledger.id }],
          },
        } as never,
        env,
      ),
    );

    const option = (
      shown.data?.components?.[0]?.components?.[0] as unknown as {
        options?: Array<{ label: string; description: string }>;
      }
    )?.options?.[0];

    expect(option?.label).toBe("小明 → 阿肥");
    expect(option?.description).toBe("TWD 400");
    // The ids must not leak into text Discord will not render as a mention.
    expect(option?.label).not.toContain(friend);
    expect(option?.description).not.toContain(owner);
  });
});
