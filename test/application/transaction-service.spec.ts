import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { LedgerService } from "../../src/application/ledger-service";
import type { ServiceDependencies } from "../../src/application/shared";
import { TransactionService } from "../../src/application/transaction-service";

let sequence = 0;

function dependencies(): ServiceDependencies {
  return {
    generateId: () => `transaction-id-${++sequence}`,
    now: () => new Date("2026-08-18T00:00:00.000Z"),
  };
}

async function createLedgerWithMembers() {
  const deps = dependencies();
  const ledgers = new LedgerService(env.DB, deps);
  const guildId = `900${sequence}`;
  const ownerUserId = "90001";
  const ledger = await ledgers.create({
    interactionId: `ledger-${sequence}`,
    guildId,
    actorUserId: ownerUserId,
    name: `帳本-${sequence}`,
    currencyCode: "TWD",
    currencyScale: 0,
  });
  for (const memberUserId of ["90002", "90003", "90004"]) {
    await ledgers.addMember({
      interactionId: `add-${memberUserId}-${sequence}`,
      ledgerId: ledger.id,
      guildId,
      actorUserId: ownerUserId,
      memberUserId,
    });
  }
  return {
    deps,
    ledger,
    guildId,
    ownerUserId,
    transactions: new TransactionService(env.DB, deps),
  };
}

describe("TransactionService", () => {
  beforeEach(() => {
    sequence += 10;
  });

  it("stores an expense, audit and simplified balances atomically", async () => {
    const { transactions, ledger, guildId, ownerUserId } =
      await createLedgerWithMembers();
    const expense = await transactions.createExpense({
      interactionId: `expense-${sequence}`,
      ledgerId: ledger.id,
      guildId,
      actorUserId: ownerUserId,
      payerUserId: ownerUserId,
      totalAmountMinor: 900,
      shares: [
        { userId: ownerUserId, amountMinor: 300 },
        { userId: "90002", amountMinor: 300 },
        { userId: "90003", amountMinor: 300 },
      ],
      description: "晚餐",
      occurredOn: "2026-08-17",
    });

    await expect(
      transactions.list({
        ledgerId: ledger.id,
        guildId,
        actorUserId: "90002",
      }),
    ).resolves.toEqual([expense]);
    await expect(
      transactions.getSuggestions({
        ledgerId: ledger.id,
        guildId,
        actorUserId: "90002",
      }),
    ).resolves.toEqual([
      {
        debtorUserId: "90002",
        creditorUserId: ownerUserId,
        amountMinor: 300,
      },
      {
        debtorUserId: "90003",
        creditorUserId: ownerUserId,
        amountMinor: 300,
      },
    ]);

    const audit = await env.DB.prepare(
      `SELECT action FROM transaction_audits WHERE transaction_id = ?`,
    )
      .bind(expense.id)
      .first<{ action: string }>();
    expect(audit?.action).toBe("create");
  });

  it("rejects non-members and duplicate interaction writes", async () => {
    const { transactions, ledger, guildId, ownerUserId } =
      await createLedgerWithMembers();
    const input = {
      interactionId: `expense-dedupe-${sequence}`,
      ledgerId: ledger.id,
      guildId,
      actorUserId: ownerUserId,
      payerUserId: ownerUserId,
      totalAmountMinor: 100,
      shares: [{ userId: "90002", amountMinor: 100 }],
      occurredOn: "2026-08-18",
    };

    await transactions.createExpense(input);
    await expect(transactions.createExpense(input)).rejects.toMatchObject({
      code: "DUPLICATE_INTERACTION",
    });
    await expect(
      transactions.createExpense({
        ...input,
        interactionId: `bad-member-${sequence}`,
        shares: [{ userId: "99999", amountMinor: 100 }],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects a write when the ledger balance revision changes concurrently", async () => {
    const { ledger, guildId, ownerUserId, deps } =
      await createLedgerWithMembers();
    let intercepted = false;
    const conflictingDb = {
      prepare: env.DB.prepare.bind(env.DB),
      exec: env.DB.exec.bind(env.DB),
      dump: env.DB.dump.bind(env.DB),
      withSession: env.DB.withSession.bind(env.DB),
      batch: async (statements: D1PreparedStatement[]) => {
        if (!intercepted) {
          intercepted = true;
          await env.DB
            .prepare(
              `UPDATE ledgers
                  SET balance_revision = balance_revision + 1
                WHERE id = ?`,
            )
            .bind(ledger.id)
            .run();
        }
        return env.DB.batch(statements);
      },
    } as D1Database;
    const service = new TransactionService(conflictingDb, deps);

    await expect(
      service.createExpense({
        interactionId: `concurrent-${sequence}`,
        ledgerId: ledger.id,
        guildId,
        actorUserId: ownerUserId,
        payerUserId: ownerUserId,
        totalAmountMinor: 100,
        shares: [{ userId: "90002", amountMinor: 100 }],
        occurredOn: "2026-08-18",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const count = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM transactions WHERE ledger_id = ?`,
    )
      .bind(ledger.id)
      .first<{ count: number }>();
    expect(count?.count).toBe(0);
  });

  it("collapses a chain and supports partial settlement", async () => {
    const { transactions, ledger, guildId, ownerUserId } =
      await createLedgerWithMembers();
    await transactions.createExpense({
      interactionId: `chain-1-${sequence}`,
      ledgerId: ledger.id,
      guildId,
      actorUserId: ownerUserId,
      payerUserId: "90002",
      totalAmountMinor: 100,
      shares: [{ userId: ownerUserId, amountMinor: 100 }],
      occurredOn: "2026-08-10",
    });
    await transactions.createExpense({
      interactionId: `chain-2-${sequence}`,
      ledgerId: ledger.id,
      guildId,
      actorUserId: "90002",
      payerUserId: "90003",
      totalAmountMinor: 100,
      shares: [{ userId: "90002", amountMinor: 100 }],
      occurredOn: "2026-08-11",
    });

    await expect(
      transactions.getSuggestions({
        ledgerId: ledger.id,
        guildId,
        actorUserId: ownerUserId,
      }),
    ).resolves.toEqual([
      {
        debtorUserId: ownerUserId,
        creditorUserId: "90003",
        amountMinor: 100,
      },
    ]);

    const settlement = await transactions.createSettlement({
      interactionId: `settle-${sequence}`,
      ledgerId: ledger.id,
      guildId,
      actorUserId: ownerUserId,
      payerUserId: ownerUserId,
      receiverUserId: "90003",
      amountMinor: 40,
      occurredOn: "2026-08-18",
    });
    await expect(
      transactions.getSuggestions({
        ledgerId: ledger.id,
        guildId,
        actorUserId: ownerUserId,
      }),
    ).resolves.toEqual([
      {
        debtorUserId: ownerUserId,
        creditorUserId: "90003",
        amountMinor: 60,
      },
    ]);

    const updatedSettlement = await transactions.updateSettlement({
      interactionId: `settle-update-${sequence}`,
      transactionId: settlement.id,
      expectedRevision: 1,
      ledgerId: ledger.id,
      guildId,
      actorUserId: "90002",
      payerUserId: ownerUserId,
      receiverUserId: "90003",
      amountMinor: 50,
      description: "改為還 50",
      occurredOn: "2026-08-18",
    });
    expect(updatedSettlement).toMatchObject({
      revision: 2,
      totalAmountMinor: 50,
    });
    await expect(
      transactions.getSuggestions({
        ledgerId: ledger.id,
        guildId,
        actorUserId: ownerUserId,
      }),
    ).resolves.toEqual([
      {
        debtorUserId: ownerUserId,
        creditorUserId: "90003",
        amountMinor: 50,
      },
    ]);
    await expect(
      transactions.createSettlement({
        interactionId: `overpay-${sequence}`,
        ledgerId: ledger.id,
        guildId,
        actorUserId: ownerUserId,
        payerUserId: ownerUserId,
        receiverUserId: "90003",
        amountMinor: 51,
        occurredOn: "2026-08-18",
      }),
    ).rejects.toMatchObject({ code: "SETTLEMENT_EXCEEDS_BALANCE" });
  });

  it("filters history by date, type and participating member", async () => {
    const { transactions, ledger, guildId, ownerUserId } =
      await createLedgerWithMembers();
    await transactions.createExpense({
      interactionId: `filter-old-${sequence}`,
      ledgerId: ledger.id,
      guildId,
      actorUserId: ownerUserId,
      payerUserId: ownerUserId,
      totalAmountMinor: 100,
      shares: [{ userId: "90002", amountMinor: 100 }],
      occurredOn: "2026-07-01",
    });
    const recent = await transactions.createExpense({
      interactionId: `filter-new-${sequence}`,
      ledgerId: ledger.id,
      guildId,
      actorUserId: ownerUserId,
      payerUserId: ownerUserId,
      totalAmountMinor: 200,
      shares: [{ userId: "90003", amountMinor: 200 }],
      occurredOn: "2026-08-01",
    });

    await expect(
      transactions.list({
        ledgerId: ledger.id,
        guildId,
        actorUserId: ownerUserId,
        startDate: "2026-08-01",
        endDate: "2026-08-31",
        type: "expense",
        memberUserId: "90003",
      }),
    ).resolves.toEqual([recent]);
  });

  it("uses revision guards for updates and soft deletion", async () => {
    const { transactions, ledger, guildId, ownerUserId } =
      await createLedgerWithMembers();
    const expense = await transactions.createExpense({
      interactionId: `editable-${sequence}`,
      ledgerId: ledger.id,
      guildId,
      actorUserId: ownerUserId,
      payerUserId: ownerUserId,
      totalAmountMinor: 100,
      shares: [{ userId: "90002", amountMinor: 100 }],
      occurredOn: "2026-08-01",
    });
    const updated = await transactions.updateExpense({
      interactionId: `update-${sequence}`,
      transactionId: expense.id,
      expectedRevision: 1,
      ledgerId: ledger.id,
      guildId,
      actorUserId: "90002",
      payerUserId: ownerUserId,
      totalAmountMinor: 150,
      shares: [{ userId: "90002", amountMinor: 150 }],
      description: "updated",
      occurredOn: "2026-08-02",
    });
    expect(updated).toMatchObject({ revision: 2, totalAmountMinor: 150 });

    await expect(
      transactions.updateExpense({
        interactionId: `stale-${sequence}`,
        transactionId: expense.id,
        expectedRevision: 1,
        ledgerId: ledger.id,
        guildId,
        actorUserId: ownerUserId,
        payerUserId: ownerUserId,
        totalAmountMinor: 200,
        shares: [{ userId: "90002", amountMinor: 200 }],
        occurredOn: "2026-08-03",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await transactions.delete({
      interactionId: `delete-${sequence}`,
      transactionId: expense.id,
      expectedRevision: 2,
      ledgerId: ledger.id,
      guildId,
      actorUserId: "90003",
    });
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

    const audits = await env.DB.prepare(
      `SELECT action FROM transaction_audits
        WHERE transaction_id = ? ORDER BY rowid`,
    )
      .bind(expense.id)
      .all<{ action: string }>();
    expect(audits.results.map(({ action }) => action)).toEqual([
      "create",
      "update",
      "delete",
    ]);
  });
});
