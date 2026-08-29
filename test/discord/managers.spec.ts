import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { LedgerService } from "../../src/application/ledger-service";

let sequence = 0;

async function fixture() {
  sequence += 1;
  const guildId = `1110${sequence}`;
  const owner = `1120${sequence}`;
  const helper = `1130${sequence}`;
  const plain = `1140${sequence}`;
  const ledgers = new LedgerService(env.DB);
  const ledger = await ledgers.create({
    interactionId: `mg-l-${sequence}`,
    guildId,
    actorUserId: owner,
    name: `Managed ${sequence}`,
    currencyCode: "TWD",
    currencyScale: 0,
  });
  for (const id of [helper, plain]) {
    await ledgers.addMember({
      interactionId: `mg-m-${id}`,
      ledgerId: ledger.id,
      guildId,
      actorUserId: owner,
      memberUserId: id,
    });
  }
  return { guildId, owner, helper, plain, ledger, ledgers };
}

describe("ledger managers", () => {
  it("makes the creator a manager and everyone else not", async () => {
    const { owner, helper, ledger, ledgers } = await fixture();
    const members = await ledgers.listMembers(ledger.id);
    expect(members.find((m) => m.userId === owner)?.isManager).toBe(true);
    expect(members.find((m) => m.userId === helper)?.isManager).toBe(false);
  });

  it("lets a promoted member run admin actions", async () => {
    const { guildId, owner, helper, plain, ledger, ledgers } = await fixture();
    // Before promotion the helper cannot administer.
    await expect(
      ledgers.setPublic({
        ledgerId: ledger.id,
        guildId,
        actorUserId: helper,
        isPublic: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    await ledgers.setManager({
      ledgerId: ledger.id,
      guildId,
      actorUserId: owner,
      memberUserId: helper,
      isManager: true,
    });

    // Now they can, including adding members and promoting others.
    await expect(
      ledgers.setPublic({
        ledgerId: ledger.id,
        guildId,
        actorUserId: helper,
        isPublic: true,
      }),
    ).resolves.toMatchObject({ isPublic: true });
    await expect(
      ledgers.setManager({
        ledgerId: ledger.id,
        guildId,
        actorUserId: helper,
        memberUserId: plain,
        isManager: true,
      }),
    ).resolves.toBeDefined();
  });

  it("transfers the creator role and keeps the new owner a manager", async () => {
    const { guildId, owner, helper, ledger, ledgers } = await fixture();
    const moved = await ledgers.transferOwnership({
      ledgerId: ledger.id,
      guildId,
      actorUserId: owner,
      newOwnerUserId: helper,
    });
    expect(moved.ownerUserId).toBe(helper);
    const members = await ledgers.listMembers(ledger.id);
    expect(members.find((m) => m.userId === helper)?.isManager).toBe(true);
    // The previous creator keeps their manager flag, so nothing is stranded.
    expect(members.find((m) => m.userId === owner)?.isManager).toBe(true);
  });

  it("refuses to transfer to someone outside the ledger", async () => {
    const { guildId, owner, ledger, ledgers } = await fixture();
    await expect(
      ledgers.transferOwnership({
        ledgerId: ledger.id,
        guildId,
        actorUserId: owner,
        newOwnerUserId: "1199999",
      }),
    ).rejects.toMatchObject({ code: "MEMBER_NOT_FOUND" });
  });

  it("never leaves a ledger without a manager", async () => {
    const { guildId, owner, helper, ledger, ledgers } = await fixture();
    // The creator is always a manager and cannot be demoted.
    await expect(
      ledgers.setManager({
        ledgerId: ledger.id,
        guildId,
        actorUserId: owner,
        memberUserId: owner,
        isManager: false,
      }),
    ).rejects.toMatchObject({ code: "OWNER_CANNOT_BE_REMOVED" });

    // Hand over, then the new sole manager cannot demote themselves either.
    await ledgers.transferOwnership({
      ledgerId: ledger.id,
      guildId,
      actorUserId: owner,
      newOwnerUserId: helper,
    });
    await ledgers.setManager({
      ledgerId: ledger.id,
      guildId,
      actorUserId: helper,
      memberUserId: owner,
      isManager: false,
    });
    await expect(
      ledgers.setManager({
        ledgerId: ledger.id,
        guildId,
        actorUserId: helper,
        memberUserId: helper,
        isManager: false,
      }),
    ).rejects.toMatchObject({ code: "OWNER_CANNOT_BE_REMOVED" });
  });
});
