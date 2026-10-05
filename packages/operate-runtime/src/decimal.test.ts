import { describe, expect, it } from "vitest";

import {
  DECIMAL_REFUSALS,
  MAX_EXACT_DOUBLE_DIGITS,
  compareDecimal,
  compareDecimalText,
  decimalPrecisionExceeded,
  decimalScaleExceeded,
  decimalSpecFitsDouble,
  decimalToNumber,
  isPlainDecimalLiteral,
  parseDecimal,
  renderDecimal,
  toDecimalWire,
} from "./decimal.js";

describe("constants", () => {
  it("names DBL_DIG as the double round-trip limit", () => {
    expect(MAX_EXACT_DOUBLE_DIGITS).toBe(15);
  });

  it("lists both refusals", () => {
    expect([...DECIMAL_REFUSALS]).toEqual(["not_a_decimal", "precision_overflow"]);
  });

  it("admits a 15-digit declaration and refuses a 16-digit one", () => {
    expect(decimalSpecFitsDouble({ precision: 15, scale: 2 })).toBe(true);
    expect(decimalSpecFitsDouble({ precision: 16, scale: 2 })).toBe(false);
    expect(decimalSpecFitsDouble({ precision: 20, scale: 10 })).toBe(false);
  });
});

describe("parseDecimal", () => {
  it("parses a plain numeral exactly", () => {
    expect(parseDecimal("10.25")).toEqual({ negative: false, units: 1025n, scale: 2 });
  });

  it("parses a negative", () => {
    expect(parseDecimal("-0.001")).toEqual({ negative: true, units: 1n, scale: 3 });
  });

  it("normalises negative zero", () => {
    expect(parseDecimal("-0.00")).toEqual({ negative: false, units: 0n, scale: 2 });
  });

  it("keeps digits a double could not hold", () => {
    const parsed = parseDecimal("12345678901234567890.1234567890");
    expect(parsed).not.toBeNull();
    expect(renderDecimal(parsed!)).toBe("12345678901234567890.1234567890");
  });

  it("multiplies out a positive exponent to a non-negative scale", () => {
    expect(parseDecimal("1.5e3")).toEqual({ negative: false, units: 1500n, scale: 0 });
  });

  it("widens the scale for a negative exponent", () => {
    expect(parseDecimal("15e-4")).toEqual({ negative: false, units: 15n, scale: 4 });
  });

  it("accepts a bigint", () => {
    expect(parseDecimal(-7n)).toEqual({ negative: true, units: 7n, scale: 0 });
  });

  it("accepts a JS number as JS spells it", () => {
    expect(renderDecimal(parseDecimal(0.1)!)).toBe("0.1");
    expect(renderDecimal(parseDecimal(1e21)!)).toBe("1000000000000000000000");
  });

  it("rejects non-numerals, blanks and non-finite numbers", () => {
    for (const bad of ["", "   ", "abc", "1.2.3", "1,2", "0x10", "+", "-", Number.NaN, Infinity, null, undefined, {}, true]) {
      expect(parseDecimal(bad)).toBeNull();
    }
  });

  it("tolerates surrounding whitespace on a string", () => {
    expect(parseDecimal("  4.50 ")).toEqual({ negative: false, units: 450n, scale: 2 });
  });
});

describe("toDecimalWire", () => {
  it("pads to the declared scale, as Postgres prints numeric(p,s)", () => {
    expect(toDecimalWire(10, { precision: 16, scale: 2 })).toEqual({ ok: true, wire: "10.00" });
    expect(toDecimalWire("1.5", { precision: 20, scale: 10 })).toEqual({ ok: true, wire: "1.5000000000" });
  });

  it("renders scale 0 with no point", () => {
    expect(toDecimalWire("42.4", { precision: 5, scale: 0 })).toEqual({ ok: true, wire: "42" });
  });

  it("rounds half away from zero, matching NUMERIC", () => {
    expect(toDecimalWire("0.005", { precision: 16, scale: 2 })).toEqual({ ok: true, wire: "0.01" });
    expect(toDecimalWire("-0.005", { precision: 16, scale: 2 })).toEqual({ ok: true, wire: "-0.01" });
    expect(toDecimalWire("0.004", { precision: 16, scale: 2 })).toEqual({ ok: true, wire: "0.00" });
  });

  it("renders a rounded-to-zero negative without a sign", () => {
    expect(toDecimalWire("-0.001", { precision: 16, scale: 2 })).toEqual({ ok: true, wire: "0.00" });
  });

  it("keeps every digit of a value no double holds", () => {
    expect(toDecimalWire("12345678901234567890.1234567890", { precision: 38, scale: 10 })).toEqual({
      ok: true,
      wire: "12345678901234567890.1234567890",
    });
  });

  it("keeps a value above 2^53 exactly", () => {
    expect(toDecimalWire("9007199254740993", { precision: 20, scale: 0 })).toEqual({
      ok: true,
      wire: "9007199254740993",
    });
  });

  it("refuses an integer part wider than the declaration", () => {
    expect(toDecimalWire("12345.00", { precision: 4, scale: 2 })).toEqual({
      ok: false,
      reason: "precision_overflow",
    });
  });

  it("refuses a value that is not a decimal", () => {
    expect(toDecimalWire("about ten", { precision: 16, scale: 2 })).toEqual({
      ok: false,
      reason: "not_a_decimal",
    });
  });

  it("is idempotent on its own output", () => {
    const spec = { precision: 16, scale: 3 };
    const once = toDecimalWire("9.5", spec);
    expect(once.ok).toBe(true);
    expect(toDecimalWire(once.ok ? once.wire : "", spec)).toEqual(once);
  });
});

describe("declaration checks", () => {
  it("flags more fraction digits than declared", () => {
    expect(decimalScaleExceeded("12345.6789", { precision: 16, scale: 2 })).toBe(true);
    expect(decimalScaleExceeded("12345.67", { precision: 16, scale: 2 })).toBe(false);
  });

  it("does not count trailing zeros as precision", () => {
    expect(decimalScaleExceeded("10.2500", { precision: 16, scale: 2 })).toBe(false);
  });

  it("flags an integer part wider than declared", () => {
    expect(decimalPrecisionExceeded("12345", { precision: 4, scale: 2 })).toBe(true);
    expect(decimalPrecisionExceeded("99.99", { precision: 4, scale: 2 })).toBe(false);
  });

  it("stays silent about a value that is not a decimal (a type error, reported elsewhere)", () => {
    expect(decimalScaleExceeded("abc", { precision: 16, scale: 2 })).toBe(false);
    expect(decimalPrecisionExceeded("abc", { precision: 16, scale: 2 })).toBe(false);
  });
});

describe("comparison", () => {
  it("orders by value, not by spelling", () => {
    expect(compareDecimalText("9.50", "10.25")).toBe(-1);
    expect(compareDecimalText("10.25", "9.50")).toBe(1);
    expect(compareDecimalText("10.250", "10.25")).toBe(0);
  });

  it("orders negatives below zero", () => {
    expect(compareDecimalText("-1.00", "0.00")).toBe(-1);
  });

  it("separates two values a double would collapse", () => {
    expect(compareDecimalText("9007199254740993", "9007199254740992")).toBe(1);
    expect(Number("9007199254740993") === Number("9007199254740992")).toBe(true);
  });

  it("declines a pair that is not two numerals", () => {
    expect(compareDecimalText("abc", "1")).toBeNull();
    expect(compareDecimalText("1", "1e3")).toBeNull();
  });

  it("compares parsed decimals across scales", () => {
    expect(compareDecimal(parseDecimal("1.5")!, parseDecimal("1.50")!)).toBe(0);
  });
});

describe("isPlainDecimalLiteral", () => {
  it("accepts a bare numeral and rejects anything else", () => {
    expect(isPlainDecimalLiteral("-10.250")).toBe(true);
    expect(isPlainDecimalLiteral("10")).toBe(true);
    expect(isPlainDecimalLiteral("+10")).toBe(false);
    expect(isPlainDecimalLiteral("1e3")).toBe(false);
    expect(isPlainDecimalLiteral("10.")).toBe(false);
    expect(isPlainDecimalLiteral("")).toBe(false);
    expect(isPlainDecimalLiteral("INV-0001")).toBe(false);
  });
});

describe("decimalToNumber", () => {
  it("converts, and is lossy above the round-trip limit — the documented exit", () => {
    expect(decimalToNumber("10.25")).toBe(10.25);
    expect(decimalToNumber("9007199254740993")).toBe(9007199254740992);
  });
});
