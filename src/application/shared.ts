import { ApplicationError } from "./errors";

export interface ServiceDependencies {
  generateId: () => string;
  now: () => Date;
}

export const defaultServiceDependencies: ServiceDependencies = {
  generateId: () => crypto.randomUUID(),
  now: () => new Date(),
};

/** Categories are free text; blank collapses to null so filters stay simple. */
export function normalizeCategory(
  category: string | undefined,
): string | null {
  const trimmed = category?.trim() ?? "";
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > 30) {
    throw new ApplicationError(
      "INVALID_INPUT",
      "Category must be 30 characters or fewer.",
    );
  }
  return trimmed;
}

export function normalizeDescription(description: string | undefined): string {
  const normalized = description?.trim() ?? "";
  if (normalized.length > 200) {
    throw new ApplicationError(
      "INVALID_INPUT",
      "Description cannot exceed 200 characters.",
    );
  }
  return normalized;
}

export function assertCalendarDate(value: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    throw new ApplicationError(
      "INVALID_DATE",
      "Date must use the YYYY-MM-DD format.",
    );
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));

  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new ApplicationError("INVALID_DATE", "Date is not valid.");
  }
}

export function assertDiscordId(value: string, fieldName: string): void {
  if (!/^\d{2,30}$/.test(value)) {
    throw new ApplicationError(
      "INVALID_INPUT",
      `${fieldName} must be a Discord snowflake ID.`,
    );
  }
}
