import { DomainError } from "./errors";

const MAX_CURRENCY_SCALE = 3;

export function assertCurrencyScale(scale: number): void {
  if (!Number.isInteger(scale) || scale < 0 || scale > MAX_CURRENCY_SCALE) {
    throw new DomainError(
      "INVALID_CURRENCY_SCALE",
      `Currency scale must be an integer from 0 to ${MAX_CURRENCY_SCALE}.`,
    );
  }
}

export function assertMinorAmount(amountMinor: number): void {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new DomainError(
      "UNSAFE_AMOUNT",
      "Amount must be a safe integer in the currency's minor unit.",
    );
  }
}

export function assertPositiveMinorAmount(amountMinor: number): void {
  assertMinorAmount(amountMinor);
  if (amountMinor <= 0) {
    throw new DomainError("AMOUNT_NOT_POSITIVE", "Amount must be positive.");
  }
}

export function parseAmountToMinor(input: string, scale: number): number {
  assertCurrencyScale(scale);

  const normalized = input.trim();
  const pattern =
    scale === 0
      ? /^(?:0|[1-9]\d*)$/
      : new RegExp(`^(?:0|[1-9]\\d*)(?:\\.(\\d{1,${scale}}))?$`);
  const match = pattern.exec(normalized);

  if (match === null) {
    throw new DomainError(
      "INVALID_AMOUNT",
      `Amount must be a non-negative decimal with at most ${scale} decimal places.`,
    );
  }

  const [whole = "0", fraction = ""] = normalized.split(".");
  const paddedFraction = fraction.padEnd(scale, "0");
  const factor = 10n ** BigInt(scale);
  const minor = BigInt(whole) * factor + BigInt(paddedFraction || "0");

  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new DomainError(
      "UNSAFE_AMOUNT",
      "Amount is too large to store safely.",
    );
  }

  return Number(minor);
}

export function parsePositiveAmountToMinor(
  input: string,
  scale: number,
): number {
  const amountMinor = parseAmountToMinor(input, scale);
  assertPositiveMinorAmount(amountMinor);
  return amountMinor;
}

export function formatMinorAmount(amountMinor: number, scale: number): string {
  assertMinorAmount(amountMinor);
  assertCurrencyScale(scale);

  const sign = amountMinor < 0 ? "-" : "";
  const absolute = BigInt(Math.abs(amountMinor));

  if (scale === 0) {
    return `${sign}${absolute}`;
  }

  const factor = 10n ** BigInt(scale);
  const whole = absolute / factor;
  const fraction = (absolute % factor).toString().padStart(scale, "0");
  return `${sign}${whole}.${fraction}`;
}
