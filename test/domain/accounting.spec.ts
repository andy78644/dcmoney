import { describe, expect, it } from "vitest";

import {
  buildExpensePostings,
  buildSettlementPostings,
  computeBalances,
  simplifyDebts,
  splitEqually,
  validateCustomShares,
} from "../../src/domain/accounting";

describe("expense splitting", () => {
  it("splits equally and assigns the remainder in selection order", () => {
    expect(splitEqually(100, ["a", "b", "c"])).toEqual([
      { userId: "a", amountMinor: 34 },
      { userId: "b", amountMinor: 33 },
      { userId: "c", amountMinor: 33 },
    ]);
  });

  it("rejects duplicate participants and zero-sized shares", () => {
    expect(() => splitEqually(100, ["a", "a"])).toThrowError(
      expect.objectContaining({ code: "DUPLICATE_MEMBER" }),
    );
    expect(() => splitEqually(2, ["a", "b", "c"])).toThrowError(
      expect.objectContaining({ code: "AMOUNT_NOT_POSITIVE" }),
    );
  });

  it("validates custom shares exactly", () => {
    expect(
      validateCustomShares(100, [
        { userId: "a", amountMinor: 70 },
        { userId: "b", amountMinor: 30 },
      ]),
    ).toEqual([
      { userId: "a", amountMinor: 70 },
      { userId: "b", amountMinor: 30 },
    ]);

    expect(() =>
      validateCustomShares(100, [
        { userId: "a", amountMinor: 50 },
        { userId: "b", amountMinor: 40 },
      ]),
    ).toThrowError(expect.objectContaining({ code: "SHARE_TOTAL_MISMATCH" }));
  });
});

describe("postings", () => {
  it("builds a balanced expense when the payer is also a participant", () => {
    expect(
      buildExpensePostings("andy", 900, [
        { userId: "andy", amountMinor: 300 },
        { userId: "a", amountMinor: 300 },
        { userId: "b", amountMinor: 300 },
      ]),
    ).toEqual([
      { userId: "a", amountMinor: -300 },
      { userId: "andy", amountMinor: 600 },
      { userId: "b", amountMinor: -300 },
    ]);
  });

  it("builds settlement postings in the correct direction", () => {
    expect(buildSettlementPostings("a", "andy", 100)).toEqual([
      { userId: "a", amountMinor: 100 },
      { userId: "andy", amountMinor: -100 },
    ]);
  });

  it("rejects a payment to oneself", () => {
    expect(() => buildSettlementPostings("a", "a", 100)).toThrowError(
      expect.objectContaining({ code: "INVALID_SETTLEMENT_PARTIES" }),
    );
  });
});

describe("debt simplification", () => {
  it("collapses a debt chain", () => {
    const balances = computeBalances([
      { userId: "a", amountMinor: -100 },
      { userId: "b", amountMinor: 100 },
      { userId: "b", amountMinor: -100 },
      { userId: "c", amountMinor: 100 },
    ]);

    expect(simplifyDebts(balances)).toEqual([
      { debtorUserId: "a", creditorUserId: "c", amountMinor: 100 },
    ]);
  });

  it("removes a balanced cycle", () => {
    const balances = computeBalances([
      { userId: "a", amountMinor: -100 },
      { userId: "b", amountMinor: 100 },
      { userId: "b", amountMinor: -100 },
      { userId: "c", amountMinor: 100 },
      { userId: "c", amountMinor: -100 },
      { userId: "a", amountMinor: 100 },
    ]);

    expect(simplifyDebts(balances)).toEqual([]);
  });

  it("uses stable amount and user ordering", () => {
    expect(
      simplifyDebts([
        { userId: "debtor-b", amountMinor: -50 },
        { userId: "creditor-b", amountMinor: 50 },
        { userId: "creditor-a", amountMinor: 50 },
        { userId: "debtor-a", amountMinor: -50 },
      ]),
    ).toEqual([
      {
        debtorUserId: "debtor-a",
        creditorUserId: "creditor-a",
        amountMinor: 50,
      },
      {
        debtorUserId: "debtor-b",
        creditorUserId: "creditor-b",
        amountMinor: 50,
      },
    ]);
  });

  it("rejects balances that do not add up to zero", () => {
    expect(() =>
      simplifyDebts([
        { userId: "a", amountMinor: -100 },
        { userId: "b", amountMinor: 99 },
      ]),
    ).toThrowError(expect.objectContaining({ code: "INVALID_POSTING_TOTAL" }));
  });

  it("preserves each member's net position", () => {
    const balances = [
      { userId: "a", amountMinor: -70 },
      { userId: "b", amountMinor: -30 },
      { userId: "c", amountMinor: 60 },
      { userId: "d", amountMinor: 40 },
    ];
    const suggestions = simplifyDebts(balances);
    const reconstructed = computeBalances(
      suggestions.flatMap((suggestion) => [
        {
          userId: suggestion.debtorUserId,
          amountMinor: -suggestion.amountMinor,
        },
        {
          userId: suggestion.creditorUserId,
          amountMinor: suggestion.amountMinor,
        },
      ]),
    );

    expect(reconstructed).toEqual(
      [...balances].sort((a, b) => a.userId.localeCompare(b.userId)),
    );
  });
});
