export type DomainErrorCode =
  | "AMOUNT_NOT_POSITIVE"
  | "DUPLICATE_MEMBER"
  | "EMPTY_PARTICIPANTS"
  | "INVALID_AMOUNT"
  | "INVALID_BALANCE_TOTAL"
  | "INVALID_CURRENCY_SCALE"
  | "INVALID_POSTING_TOTAL"
  | "INVALID_SETTLEMENT_PARTIES"
  | "SHARE_TOTAL_MISMATCH"
  | "UNSAFE_AMOUNT";

export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}
