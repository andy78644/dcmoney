import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { LedgerService } from "../../src/application/ledger-service";
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

const ledgerSub = (name: string, options: unknown[]) => ({
  name: "ledger",
  options: [{ name, type: 1, options }],
});

async function fixture() {
  sequence += 1;
  const guildId = `3310${sequence}`;
  const owner = `3320${sequence}`;
  const friend = `3330${sequence}`;
  const ledgers = new LedgerService(env.DB);
  const ledger = await ledgers.create({
    interactionId: `ar-${sequence}`,
    guildId,
    actorUserId: owner,
    name: `Trip ${sequence}`,
    currencyCode: "TWD",
    currencyScale: 0,
  });
  await ledgers.addMember({
    interactionId: `ar-m-${sequence}`,
    ledgerId: ledger.id,
    guildId,
    actorUserId: owner,
    memberUserId: friend,
  });
  return { guildId, owner, friend, ledger, ledgers };
}

describe("ledger archiving", () => {
  it("hides an archived ledger from listings and pickers, then restores it", async () => {
    const { guildId, owner, ledger, ledgers } = await fixture();

    const archived = await json(
      await act(`ar-do-${++sequence}`, 2, guildId, owner,
        ledgerSub("archive", [
          { name: "ledger", type: 3, value: ledger.id },
          { name: "enabled", type: 5, value: true },
        ])),
    );
    expect(archived.data?.content).toContain("已封存");

    // Gone from the normal list...
    const list = await json(
      await act(`ar-list-${++sequence}`, 2, guildId, owner, ledgerSub("list", [])),
    );
    expect(list.data?.content).toContain("還沒有可使用的帳本");

    // ...and from the ordinary picker.
    const picker = await json(
      await act(`ar-ac-${++sequence}`, 4, guildId, owner, {
        name: "balances",
        options: [{ name: "ledger", type: 3, value: "", focused: true }],
      }),
    );
    expect(picker.data?.choices).toEqual([]);

    // But findable when explicitly asked for.
    const archivedList = await json(
      await act(`ar-list2-${++sequence}`, 2, guildId, owner,
        ledgerSub("list", [{ name: "archived", type: 5, value: true }])),
    );
    expect(archivedList.data?.content).toContain(ledger.name);

    // And the archive picker still offers it, flagged, so it can be restored.
    const archivePicker = await json(
      await act(`ar-ac2-${++sequence}`, 4, guildId, owner, {
        name: "ledger",
        options: [
          {
            name: "archive",
            type: 1,
            options: [{ name: "ledger", type: 3, value: "", focused: true }],
          },
        ],
      }),
    );
    expect(archivePicker.data?.choices?.[0]?.name).toContain("已封存");

    const restored = await json(
      await act(`ar-undo-${++sequence}`, 2, guildId, owner,
        ledgerSub("archive", [
          { name: "ledger", type: 3, value: ledger.id },
          { name: "enabled", type: 5, value: false },
        ])),
    );
    expect(restored.data?.content).toContain("已復原");
    await expect(
      ledgers.listForMember(guildId, owner),
    ).resolves.toHaveLength(1);
  });

  it("keeps every record while archived", async () => {
    const { guildId, owner, ledger, ledgers } = await fixture();
    await ledgers.setArchived({
      ledgerId: ledger.id,
      guildId,
      actorUserId: owner,
      archived: true,
    });
    // Members survive; the ledger is hidden, not deleted.
    await expect(ledgers.listMembers(ledger.id)).resolves.toHaveLength(2);
  });

  it("refuses a member who is not the owner", async () => {
    const { guildId, friend, ledger, ledgers } = await fixture();
    await expect(
      ledgers.setArchived({
        ledgerId: ledger.id,
        guildId,
        actorUserId: friend,
        archived: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
