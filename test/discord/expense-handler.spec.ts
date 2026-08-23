import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { LedgerService } from "../../src/application/ledger-service";
import { TransactionService } from "../../src/application/transaction-service";
import { routeInteraction } from "../../src/discord/router";
import type { DiscordInteraction } from "../../src/discord/types";

interface ResponsePayload {
  type: number;
  data?: {
    content?: string;
    custom_id?: string;
    components?: Array<{
      components?: Array<{ custom_id?: string }>;
    }>;
  };
}

let sequence = 0;

async function payload(response: Response): Promise<ResponsePayload> {
  return (await response.json()) as ResponsePayload;
}

function firstCustomId(response: ResponsePayload): string {
  const customId = response.data?.components?.[0]?.components?.[0]?.custom_id;
  if (customId === undefined) {
    throw new Error("Response has no component custom ID.");
  }
  return customId;
}

async function fixture() {
  sequence += 1;
  const guildId = `8100${sequence}`;
  const ownerUserId = `8200${sequence}`;
  const memberA = `8300${sequence}`;
  const memberB = `8400${sequence}`;
  const ledgers = new LedgerService(env.DB);
  const ledger = await ledgers.create({
    interactionId: `expense-ledger-${sequence}`,
    guildId,
    actorUserId: ownerUserId,
    name: `Expense ${sequence}`,
    currencyCode: "TWD",
    currencyScale: 0,
  });
  for (const memberUserId of [memberA, memberB]) {
    await ledgers.addMember({
      interactionId: `expense-member-${memberUserId}`,
      ledgerId: ledger.id,
      guildId,
      actorUserId: ownerUserId,
      memberUserId,
    });
  }
  return { guildId, ownerUserId, memberA, memberB, ledger };
}

function baseInteraction(
  id: string,
  type: number,
  guildId: string,
  userId: string,
): DiscordInteraction {
  return {
    id,
    type,
    guild_id: guildId,
    member: { user: { id: userId } },
  };
}

async function startWizard(input: {
  guildId: string;
  userId: string;
  ledgerId: string;
  split: "equal" | "custom";
  amount: string;
}) {
  return payload(
    await routeInteraction(
      {
        ...baseInteraction(
          `expense-start-${++sequence}`,
          2,
          input.guildId,
          input.userId,
        ),
        data: {
          name: "expense",
          options: [
            {
              name: "add",
              type: 1,
              options: [
                { name: "ledger", type: 3, value: input.ledgerId },
                { name: "amount", type: 3, value: input.amount },
                { name: "payer", type: 6, value: input.userId },
                { name: "split", type: 3, value: input.split },
                { name: "description", type: 3, value: "晚餐" },
                { name: "date", type: 3, value: "2026-08-18" },
              ],
            },
          ],
        },
      },
      env,
    ),
  );
}

describe("expense interaction wizard", () => {
  it("creates an equally split expense only after confirmation", async () => {
    const { guildId, ownerUserId, memberA, memberB, ledger } = await fixture();
    const start = await startWizard({
      guildId,
      userId: ownerUserId,
      ledgerId: ledger.id,
      split: "equal",
      amount: "100",
    });
    expect(start.type).toBe(4);
    const participantCustomId = firstCustomId(start);

    const selected = await payload(
      await routeInteraction(
        {
          ...baseInteraction(
            `expense-select-${++sequence}`,
            3,
            guildId,
            ownerUserId,
          ),
          data: {
            custom_id: participantCustomId,
            values: [ownerUserId, memberA, memberB],
          },
        },
        env,
      ),
    );
    expect(selected.type).toBe(7);
    expect(selected.data?.content).toContain(`<@${ownerUserId}>：TWD 34`);
    const confirmCustomId = firstCustomId(selected);

    const confirmed = await payload(
      await routeInteraction(
        {
          ...baseInteraction(
            `expense-confirm-${++sequence}`,
            3,
            guildId,
            ownerUserId,
          ),
          data: { custom_id: confirmCustomId },
        },
        env,
      ),
    );
    expect(confirmed.type).toBe(7);
    expect(confirmed.data?.content).toContain("已記錄支出");

    await expect(
      new TransactionService(env.DB).getSuggestions({
        ledgerId: ledger.id,
        guildId,
        actorUserId: memberA,
      }),
    ).resolves.toEqual([
      {
        debtorUserId: memberA,
        creditorUserId: ownerUserId,
        amountMinor: 33,
      },
      {
        debtorUserId: memberB,
        creditorUserId: ownerUserId,
        amountMinor: 33,
      },
    ]);
  });

  it("collects custom shares one participant at a time", async () => {
    const { guildId, ownerUserId, memberA, memberB, ledger } = await fixture();
    const start = await startWizard({
      guildId,
      userId: ownerUserId,
      ledgerId: ledger.id,
      split: "custom",
      amount: "100",
    });
    const selected = await payload(
      await routeInteraction(
        {
          ...baseInteraction(
            `custom-select-${++sequence}`,
            3,
            guildId,
            ownerUserId,
          ),
          data: {
            custom_id: firstCustomId(start),
            values: [memberA, memberB],
          },
        },
        env,
      ),
    );

    let nextButton = firstCustomId(selected);
    for (const [index, amount] of ["60", "40"].entries()) {
      const amountModal = await payload(
        await routeInteraction(
          {
            ...baseInteraction(
              `custom-button-${index}-${++sequence}`,
              3,
              guildId,
              ownerUserId,
            ),
            data: { custom_id: nextButton },
          },
          env,
        ),
      );
      expect(amountModal.type).toBe(9);
      const modalCustomId = amountModal.data?.custom_id;
      if (modalCustomId === undefined) {
        throw new Error("Modal response has no custom ID.");
      }
      const submitted = await payload(
        await routeInteraction(
          {
            ...baseInteraction(
              `custom-modal-${index}-${++sequence}`,
              5,
              guildId,
              ownerUserId,
            ),
            data: {
              custom_id: modalCustomId,
              components: [
                {
                  components: [{ custom_id: "amount", value: amount }],
                },
              ],
            },
          },
          env,
        ),
      );
      nextButton = firstCustomId(submitted);
    }

    const confirmed = await payload(
      await routeInteraction(
        {
          ...baseInteraction(
            `custom-confirm-${++sequence}`,
            3,
            guildId,
            ownerUserId,
          ),
          data: { custom_id: nextButton },
        },
        env,
      ),
    );
    expect(confirmed.data?.content).toContain("已記錄支出");
    await expect(
      new TransactionService(env.DB).getSuggestions({
        ledgerId: ledger.id,
        guildId,
        actorUserId: ownerUserId,
      }),
    ).resolves.toEqual([
      {
        debtorUserId: memberA,
        creditorUserId: ownerUserId,
        amountMinor: 60,
      },
      {
        debtorUserId: memberB,
        creditorUserId: ownerUserId,
        amountMinor: 40,
      },
    ]);
  });

  it("prevents another member from taking over a wizard session", async () => {
    const { guildId, ownerUserId, memberA, ledger } = await fixture();
    const start = await startWizard({
      guildId,
      userId: ownerUserId,
      ledgerId: ledger.id,
      split: "equal",
      amount: "100",
    });
    const response = await payload(
      await routeInteraction(
        {
          ...baseInteraction(
            `hijack-${++sequence}`,
            3,
            guildId,
            memberA,
          ),
          data: {
            custom_id: firstCustomId(start),
            values: [memberA],
          },
        },
        env,
      ),
    );
    expect(response.data?.content).toContain("找不到指定");
  });
});

describe("participant picker", () => {
  it("only offers ledger members, labelled by display name", async () => {
    const { guildId, ownerUserId, memberA, memberB, ledger } = await fixture();
    const start = await startWizard({
      guildId,
      userId: ownerUserId,
      ledgerId: ledger.id,
      split: "equal",
      amount: "300",
    });

    const select = (
      start.data?.components?.[0] as {
        components?: Array<{
          type?: number;
          options?: Array<{ label: string; value: string }>;
          max_values?: number;
        }>;
      }
    )?.components?.[0];

    // 3 = string select. A user select (5) would list the whole server.
    expect(select?.type).toBe(3);
    expect(select?.options?.map(({ value }) => value)).toEqual([
      ownerUserId,
      memberA,
      memberB,
    ]);
    expect(select?.max_values).toBe(3);
  });

  it("rejects a payer who is not a ledger member", async () => {
    const { guildId, ownerUserId, ledger } = await fixture();
    const outsider = "9999999999";
    const response = await payload(
      await routeInteraction(
        {
          ...baseInteraction(
            `expense-outsider-${++sequence}`,
            2,
            guildId,
            ownerUserId,
          ),
          data: {
            name: "expense",
            options: [
              {
                name: "add",
                type: 1,
                options: [
                  { name: "ledger", type: 3, value: ledger.id },
                  { name: "amount", type: 3, value: "300" },
                  { name: "payer", type: 6, value: outsider },
                  { name: "split", type: 3, value: "equal" },
                ],
              },
            ],
          },
        },
        env,
      ),
    );

    expect(response.data?.content).toContain(outsider);
    expect(response.data?.content).toContain("不是");
    expect(response.data?.components ?? []).toHaveLength(0);
  });
});
