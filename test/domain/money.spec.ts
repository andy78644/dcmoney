import { describe, expect, it } from "vitest";

import { DomainError } from "../../src/domain/errors";
import {
  formatMinorAmount,
  parseAmountToMinor,
  parsePositiveAmountToMinor,
} from "../../src/domain/money";

describe("money", () => {
  it("parses currencies with zero and two decimal places", () => {
    expect(parsePositiveAmountToMinor("100", 0)).toBe(100);
    expect(parsePositiveAmountToMinor("10.25", 2)).toBe(1_025);
    expect(parsePositiveAmountToMinor("10.2", 2)).toBe(1_020);
  });

  it("formats positive, negative and zero values", () => {
    expect(formatMinorAmount(1_025, 2)).toBe("10.25");
    expect(formatMinorAmount(-1_025, 2)).toBe("-10.25");
    expect(formatMinorAmount(0, 0)).toBe("0");
  });

  it.each(["1.001", "-1", "+1", "1e3", "01", "", "abc"])(
    "rejects invalid amount %s",
    (input) => {
      expect(() => parseAmountToMinor(input, 2)).toThrow(DomainError);
    },
  );

  it("rejects zero when a positive amount is required", () => {
    expect(() => parsePositiveAmountToMinor("0", 0)).toThrowError(
      expect.objectContaining({ code: "AMOUNT_NOT_POSITIVE" }),
    );
  });

  it("rejects values larger than a safe integer", () => {
    expect(() => parseAmountToMinor("90071992547410.00", 2)).toThrowError(
      expect.objectContaining({ code: "UNSAFE_AMOUNT" }),
    );
  });
});
