export type ApplicationErrorCode =
  | "CONFLICT"
  | "DUPLICATE_INTERACTION"
  | "FORBIDDEN"
  | "INVALID_DATE"
  | "INVALID_INPUT"
  | "LEDGER_NAME_TAKEN"
  | "MEMBER_ALREADY_EXISTS"
  | "MEMBER_NOT_FOUND"
  | "MEMBER_NOT_IN_LEDGER"
  | "NOT_FOUND"
  | "OWNER_CANNOT_BE_REMOVED"
  | "SETTLEMENT_EXCEEDS_BALANCE"
  | "SETTLEMENT_NOT_A_DEBTOR";

export class ApplicationError extends Error {
  readonly code: ApplicationErrorCode;
  /** Discord user IDs the message should name, when the code carries them. */
  readonly userIds: readonly string[];
  /** Extra line appended to the user-facing reply, already localised. */
  readonly detail: string | undefined;

  constructor(
    code: ApplicationErrorCode,
    message: string,
    options: {
      userIds?: readonly string[];
      detail?: string;
    } = {},
  ) {
    super(message);
    this.name = "ApplicationError";
    this.code = code;
    this.userIds = options.userIds ?? [];
    this.detail = options.detail;
  }
}

export function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("UNIQUE constraint failed") ||
      error.message.includes("SQLITE_CONSTRAINT"))
  );
}
