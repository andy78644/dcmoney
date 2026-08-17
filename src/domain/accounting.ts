import { DomainError } from "./errors";
import { assertMinorAmount, assertPositiveMinorAmount } from "./money";

export interface Share {
  userId: string;
  amountMinor: number;
}

export interface Posting {
  userId: string;
  amountMinor: number;
}

export interface Balance {
  userId: string;
  amountMinor: number;
}

export interface SettlementSuggestion {
  debtorUserId: string;
  creditorUserId: string;
  amountMinor: number;
}

function assertUniqueMembers(userIds: readonly string[]): void {
  if (new Set(userIds).size !== userIds.length) {
    throw new DomainError(
      "DUPLICATE_MEMBER",
      "Each member can appear only once.",
    );
  }
}

function safeSum(values: readonly number[]): number {
  const total = values.reduce((sum, value) => sum + BigInt(value), 0n);
  const numericTotal = Number(total);
  assertMinorAmount(numericTotal);
  return numericTotal;
}

export function splitEqually(
  totalAmountMinor: number,
  participantUserIds: readonly string[],
): Share[] {
  assertPositiveMinorAmount(totalAmountMinor);

  if (participantUserIds.length === 0) {
    throw new DomainError(
      "EMPTY_PARTICIPANTS",
      "At least one participant is required.",
    );
  }

  assertUniqueMembers(participantUserIds);

  if (totalAmountMinor < participantUserIds.length) {
    throw new DomainError(
      "AMOUNT_NOT_POSITIVE",
      "The total is too small to give every participant a positive share.",
    );
  }

  const base = Math.floor(totalAmountMinor / participantUserIds.length);
  const remainder = totalAmountMinor % participantUserIds.length;

  return participantUserIds.map((userId, index) => ({
    userId,
    amountMinor: base + (index < remainder ? 1 : 0),
  }));
}

export function validateCustomShares(
  totalAmountMinor: number,
  shares: readonly Share[],
): Share[] {
  assertPositiveMinorAmount(totalAmountMinor);

  if (shares.length === 0) {
    throw new DomainError(
      "EMPTY_PARTICIPANTS",
      "At least one participant is required.",
    );
  }

  assertUniqueMembers(shares.map(({ userId }) => userId));
  for (const share of shares) {
    assertPositiveMinorAmount(share.amountMinor);
  }

  if (safeSum(shares.map(({ amountMinor }) => amountMinor)) !== totalAmountMinor) {
    throw new DomainError(
      "SHARE_TOTAL_MISMATCH",
      "The shares must add up exactly to the transaction total.",
    );
  }

  return shares.map((share) => ({ ...share }));
}

function consolidatePostings(postings: readonly Posting[]): Posting[] {
  const amounts = new Map<string, bigint>();

  for (const posting of postings) {
    assertMinorAmount(posting.amountMinor);
    amounts.set(
      posting.userId,
      (amounts.get(posting.userId) ?? 0n) + BigInt(posting.amountMinor),
    );
  }

  return [...amounts.entries()]
    .map(([userId, amount]) => {
      const amountMinor = Number(amount);
      assertMinorAmount(amountMinor);
      return { userId, amountMinor };
    })
    .filter(({ amountMinor }) => amountMinor !== 0)
    .sort((a, b) => a.userId.localeCompare(b.userId));
}

export function assertBalancedPostings(postings: readonly Posting[]): void {
  if (safeSum(postings.map(({ amountMinor }) => amountMinor)) !== 0) {
    throw new DomainError(
      "INVALID_POSTING_TOTAL",
      "Transaction postings must add up to zero.",
    );
  }
}

export function buildExpensePostings(
  payerUserId: string,
  totalAmountMinor: number,
  shares: readonly Share[],
): Posting[] {
  const validatedShares = validateCustomShares(totalAmountMinor, shares);
  const postings = consolidatePostings([
    { userId: payerUserId, amountMinor: totalAmountMinor },
    ...validatedShares.map(({ userId, amountMinor }) => ({
      userId,
      amountMinor: -amountMinor,
    })),
  ]);
  assertBalancedPostings(postings);
  return postings;
}

export function buildSettlementPostings(
  payerUserId: string,
  receiverUserId: string,
  amountMinor: number,
): Posting[] {
  assertPositiveMinorAmount(amountMinor);
  if (payerUserId === receiverUserId) {
    throw new DomainError(
      "INVALID_SETTLEMENT_PARTIES",
      "Settlement payer and receiver must be different members.",
    );
  }

  const postings = consolidatePostings([
    { userId: payerUserId, amountMinor },
    { userId: receiverUserId, amountMinor: -amountMinor },
  ]);
  assertBalancedPostings(postings);
  return postings;
}

export function computeBalances(postings: readonly Posting[]): Balance[] {
  const consolidated = consolidatePostings(postings);
  assertBalancedPostings(consolidated);
  return consolidated;
}

export function simplifyDebts(
  balances: readonly Balance[],
): SettlementSuggestion[] {
  const consolidated = consolidatePostings(balances);
  assertBalancedPostings(consolidated);

  const creditors = consolidated
    .filter(({ amountMinor }) => amountMinor > 0)
    .map((balance) => ({ ...balance }));
  const debtors = consolidated
    .filter(({ amountMinor }) => amountMinor < 0)
    .map(({ userId, amountMinor }) => ({
      userId,
      amountMinor: -amountMinor,
    }));

  const byAmountThenUser = (a: Balance, b: Balance): number =>
    b.amountMinor - a.amountMinor || a.userId.localeCompare(b.userId);
  creditors.sort(byAmountThenUser);
  debtors.sort(byAmountThenUser);

  const suggestions: SettlementSuggestion[] = [];
  let creditorIndex = 0;
  let debtorIndex = 0;

  while (creditorIndex < creditors.length && debtorIndex < debtors.length) {
    const creditor = creditors[creditorIndex];
    const debtor = debtors[debtorIndex];

    if (creditor === undefined || debtor === undefined) {
      break;
    }

    const amountMinor = Math.min(
      creditor.amountMinor,
      debtor.amountMinor,
    );
    suggestions.push({
      debtorUserId: debtor.userId,
      creditorUserId: creditor.userId,
      amountMinor,
    });

    creditor.amountMinor -= amountMinor;
    debtor.amountMinor -= amountMinor;

    if (creditor.amountMinor === 0) {
      creditorIndex += 1;
    }
    if (debtor.amountMinor === 0) {
      debtorIndex += 1;
    }
  }

  if (
    creditors.some(({ amountMinor }) => amountMinor !== 0) ||
    debtors.some(({ amountMinor }) => amountMinor !== 0)
  ) {
    throw new DomainError(
      "INVALID_BALANCE_TOTAL",
      "Balances must add up to zero before they can be simplified.",
    );
  }

  return suggestions;
}
