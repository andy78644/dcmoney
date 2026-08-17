import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { LedgerService } from "../../src/application/ledger-service";
import type { ServiceDependencies } from "../../src/application/shared";

let sequence = 0;

function dependencies(): ServiceDependencies {
  return {
    generateId: () => `ledger-id-${++sequence}`,
    now: () => new Date("2026-08-18T00:00:00.000Z"),
  };
}

describe("LedgerService", () => {
  beforeEach(() => {
    sequence += 1;
  });

  it("creates a ledger and automatically adds its owner", async () => {
    const service = new LedgerService(env.DB, dependencies());
    const guildId = `100${sequence}`;
    const ledger = await service.create({
      interactionId: `create-${sequence}`,
      guildId,
      actorUserId: "10001",
      name: " 日本旅遊 ",
      currencyCode: "jpy",
      currencyScale: 0,
    });

    expect(ledger).toMatchObject({
      guildId,
      name: "日本旅遊",
      currencyCode: "JPY",
      ownerUserId: "10001",
    });
    await expect(service.listForMember(guildId, "10001")).resolves.toEqual([
      ledger,
    ]);
    await expect(service.listMemberIds(ledger.id)).resolves.toEqual(["10001"]);
  });

  it("lets only the owner manage members", async () => {
    const service = new LedgerService(env.DB, dependencies());
    const guildId = `200${sequence}`;
    const ledger = await service.create({
      interactionId: `create-members-${sequence}`,
      guildId,
      actorUserId: "20001",
      name: "室友",
      currencyCode: "TWD",
      currencyScale: 0,
    });

    await service.addMember({
      interactionId: `add-${sequence}`,
      ledgerId: ledger.id,
      guildId,
      actorUserId: "20001",
      memberUserId: "20002",
    });
    await expect(service.listForMember(guildId, "20002")).resolves.toEqual([
      ledger,
    ]);

    await expect(
      service.addMember({
        interactionId: `forbidden-${sequence}`,
        ledgerId: ledger.id,
        guildId,
        actorUserId: "20002",
        memberUserId: "20003",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      service.removeMember({
        interactionId: `remove-owner-${sequence}`,
        ledgerId: ledger.id,
        guildId,
        actorUserId: "20001",
        memberUserId: "20001",
      }),
    ).rejects.toMatchObject({ code: "OWNER_CANNOT_BE_REMOVED" });

    await service.removeMember({
      interactionId: `remove-${sequence}`,
      ledgerId: ledger.id,
      guildId,
      actorUserId: "20001",
      memberUserId: "20002",
    });
    await expect(service.listForMember(guildId, "20002")).resolves.toEqual([]);
  });

  it("rejects duplicate names and duplicate interactions", async () => {
    const service = new LedgerService(env.DB, dependencies());
    const guildId = `300${sequence}`;
    const input = {
      interactionId: `dedupe-${sequence}`,
      guildId,
      actorUserId: "30001",
      name: "Trip",
      currencyCode: "USD",
      currencyScale: 2,
    };

    await service.create(input);
    await expect(service.create(input)).rejects.toMatchObject({
      code: "DUPLICATE_INTERACTION",
    });
    await expect(
      service.create({
        ...input,
        interactionId: `same-name-${sequence}`,
        name: "trip",
      }),
    ).rejects.toMatchObject({ code: "LEDGER_NAME_TAKEN" });
  });
});
