import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { LedgerService } from "../../src/application/ledger-service";
import {
  changeAnnouncement,
  expenseAnnouncement,
  memberAddedAnnouncement,
  settlementAnnouncement,
} from "../../src/discord/announce";
import { routeInteraction } from "../../src/discord/router";

let sequence = 0;

describe("announcement text", () => {
  it("names the recorder, the payer and every share", () => {
    const text = expenseAnnouncement({
      actorUserId: "111",
      ledgerName: "旅遊",
      description: "民宿",
      payerUserId: "222",
      totalAmountMinor: 900,
      occurredOn: "2026-08-24",
      shares: [
        { userId: "222", amountMinor: 600 },
        { userId: "333", amountMinor: 300 },
      ],
      currency: { currencyCode: "TWD", currencyScale: 0 },
    });
    expect(text).toContain("<@111> 在「旅遊」記了一筆支出");
    expect(text).toContain("民宿｜TWD 900");
    expect(text).toContain("付款者：<@222>");
    expect(text).toContain("• <@333>：TWD 300");
  });

  it("respects currency scale", () => {
    expect(
      settlementAnnouncement({
        actorUserId: "111",
        ledgerName: "US",
        payerUserId: "222",
        receiverUserId: "333",
        amountMinor: 1250,
        occurredOn: "2026-08-24",
        currency: { currencyCode: "USD", currencyScale: 2 },
      }),
    ).toContain("USD 12.50");
  });

  it("distinguishes an edit from a deletion", () => {
    const base = {
      actorUserId: "111",
      ledgerName: "旅遊",
      description: "民宿",
      totalAmountMinor: 900,
      occurredOn: "2026-08-24",
      currency: { currencyCode: "TWD", currencyScale: 0 },
    } as const;
    expect(changeAnnouncement({ ...base, action: "update" })).toContain("修改了");
    expect(changeAnnouncement({ ...base, action: "delete" })).toContain("刪除了");
  });
});

describe("ledger public flag", () => {
  it("defaults to private and can be toggled by the owner only", async () => {
    sequence += 1;
    const guildId = `6610${sequence}`;
    const owner = `6620${sequence}`;
    const member = `6630${sequence}`;
    const ledgers = new LedgerService(env.DB);
    const ledger = await ledgers.create({
      interactionId: `pubflag-${sequence}`,
      guildId,
      actorUserId: owner,
      name: `Flag ${sequence}`,
      currencyCode: "TWD",
      currencyScale: 0,
    });
    await ledgers.addMember({
      interactionId: `pubflag-m-${sequence}`,
      ledgerId: ledger.id,
      guildId,
      actorUserId: owner,
      memberUserId: member,
    });
    expect(ledger.isPublic).toBe(false);

    const opened = await ledgers.setPublic({
      ledgerId: ledger.id,
      guildId,
      actorUserId: owner,
      isPublic: true,
    });
    expect(opened.isPublic).toBe(true);
    // Persisted, not just returned.
    await expect(
      ledgers.requireMember(ledger.id, guildId, member),
    ).resolves.toMatchObject({ isPublic: true });

    // A plain member cannot change it.
    await expect(
      ledgers.setPublic({
        ledgerId: ledger.id,
        guildId,
        actorUserId: member,
        isPublic: false,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("creates a public ledger through /ledger create", async () => {
    sequence += 1;
    const guildId = `6640${sequence}`;
    const owner = `6650${sequence}`;
    const response = await routeInteraction(
      {
        id: `pubcreate-${sequence}`,
        type: 2,
        guild_id: guildId,
        member: { user: { id: owner } },
        data: {
          name: "ledger",
          options: [
            {
              name: "create",
              type: 1,
              options: [
                { name: "name", type: 3, value: `公開 ${sequence}` },
                { name: "currency", type: 3, value: "TWD:0" },
                { name: "public", type: 5, value: true },
              ],
            },
          ],
        },
      } as never,
      env,
    );
    const body = (await response.json()) as { data?: { content?: string } };
    expect(body.data?.content).toContain("記帳動態會公開到頻道");

    const [created] = await new LedgerService(env.DB).listForMember(
      guildId,
      owner,
    );
    expect(created?.isPublic).toBe(true);
  });
});

describe("per-command public flag", () => {
  it("carries /expense add public through the wizard session", async () => {
    sequence += 1;
    const guildId = `6660${sequence}`;
    const owner = `6670${sequence}`;
    const ledgers = new LedgerService(env.DB);
    const ledger = await ledgers.create({
      interactionId: `flag-exp-${sequence}`,
      guildId,
      actorUserId: owner,
      name: `Flag ${sequence}`,
      currencyCode: "TWD",
      currencyScale: 0,
    });
    expect(ledger.isPublic).toBe(false);

    const start = await routeInteraction(
      {
        id: `flag-start-${sequence}`,
        type: 2,
        guild_id: guildId,
        member: { user: { id: owner } },
        data: {
          name: "expense",
          options: [
            {
              name: "add",
              type: 1,
              options: [
                { name: "ledger", type: 3, value: ledger.id },
                { name: "amount", type: 3, value: "100" },
                { name: "payer", type: 3, value: owner },
                { name: "split", type: 3, value: "equal" },
                { name: "public", type: 5, value: true },
              ],
            },
          ],
        },
      } as never,
      env,
    );
    const body = (await start.json()) as {
      data?: { components?: Array<{ components?: Array<{ custom_id?: string }> }> };
    };
    const sessionId = body.data?.components?.[0]?.components?.[0]?.custom_id
      ?.split(":")[1];
    expect(sessionId).toBeDefined();

    const row = await env.DB.prepare(
      `SELECT state_json FROM interaction_sessions WHERE id = ?`,
    )
      .bind(sessionId)
      .first<{ state_json: string }>();
    expect(JSON.parse(row?.state_json ?? "{}")).toMatchObject({
      announcePublicly: true,
    });
  });
});

describe("member added announcement", () => {
  it("names everyone added and points them at the next step", () => {
    const text = memberAddedAnnouncement({
      actorUserId: "111",
      ledgerName: "旅遊",
      memberUserIds: ["222", "333"],
    });
    expect(text).toContain("<@111> 把 <@222>、<@333> 加入了帳本「旅遊」");
    expect(text).toContain("/balances");
  });
});
