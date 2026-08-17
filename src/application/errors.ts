export type ApplicationErrorCode =
  | "CONFLICT"
  | "DUPLICATE_INTERACTION"
  | "FORBIDDEN"
  | "INVALID_DATE"
  | "INVALID_INPUT"
  | "LEDGER_NAME_TAKEN"
  | "MEMBER_ALREADY_EXISTS"
  | "MEMBER_NOT_FOUND"
  | "NOT_FOUND"
  | "OWNER_CANNOT_BE_REMOVED"
  | "SETTLEMENT_EXCEEDS_BALANCE";

export class ApplicationError extends Error {
  readonly code: ApplicationErrorCode;

  constructor(code: ApplicationErrorCode, message: string) {
    super(message);
    this.name = "ApplicationError";
    this.code = code;
  }
}

export function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("UNIQUE constraint failed") ||
      error.message.includes("SQLITE_CONSTRAINT"))
  );
}
