import { describe, expect, it } from "vitest";

import { multiplyDecimal, parseDecimal, withinOneUnitAtScale } from "./decimal.js";
import {
  convertBalanced,
  convertUnits,
  isRateOne,
  moneyUnits,
  positiveRate,
  RATE_ONE,
  rateWire,
  renderMoney,
  unitsOf,
  unitsToDecimal,
  unitsToNumber,
} from "./money.js";

describe("moneyUnits", () => {
  it("reads strings, numbers and bigints as exact hundredths", () => {
    expect(moneyUnits("12.30")).toBe(1230n);
    expect(moneyUnits(12.3)).toBe(1230n);
    expect(moneyUnits("-0.01")).toBe(-1n);
    expect(moneyUnits(5n)).toBe(500n);
  });

  it("rounds a third decimal half away from zero, as NUMERIC(_, 2) does", () => {
    expect(moneyUnits("0.005")).toBe(1n);
    expect(moneyUnits("-0.005")).toBe(-1n);
    expect(moneyUnits("0.0049")).toBe(0n);
  });

  it("answers null for what is not a decimal, and unitsOf makes that zero", () => {
    for (const v of [null, undefined, "", "abc", Number.NaN, {}]) {
      expect(moneyUnits(v)).toBeNull();
      expect(unitsOf(v)).toBe(0n);
    }
  });

  it("keeps the last cent of a NUMERIC(16, 2) amount a double sum loses", () => {
    expect(moneyUnits("99999999999999.99")).toBe(9999999999999999n);
    expect(renderMoney(9999999999999999n)).toBe("99999999999999.99");
  });
});

describe("unitsToNumber and renderMoney", () => {
  it("spell the units exactly", () => {
    expect(unitsToNumber(1230n)).toBe(12.3);
    expect(unitsToNumber(-1n)).toBe(-0.01);
    expect(renderMoney(-1230n)).toBe("-12.30");
    expect(renderMoney(0n)).toBe("0.00");
  });
});

describe("rates", () => {
  it("admits only a strictly positive rate", () => {
    expect(positiveRate("1.1")).not.toBeNull();
    for (const v of ["0", "-1.1", "", null, undefined, "x"]) expect(positiveRate(v)).toBeNull();
  });

  it("writes the identity as 1 and any other rate as its exact text", () => {
    expect(rateWire(RATE_ONE)).toBe(1);
    expect(rateWire(positiveRate("1.0000000000")!)).toBe(1);
    expect(isRateOne(positiveRate("1.0000000000")!)).toBe(true);
    expect(rateWire(positiveRate("1.1000000000")!)).toBe("1.1000000000");
  });

  it("converts at a rate, rounding the product half away from zero", () => {
    expect(convertUnits(10000n, positiveRate("1.1")!)).toBe(11000n);
    expect(convertUnits(3333n, positiveRate("1.5")!)).toBe(5000n); // 49.995 → 50.00
    expect(convertUnits(-3333n, positiveRate("1.5")!)).toBe(-5000n);
  });
});

describe("convertBalanced", () => {
  const sound = (lines: { d: bigint; c: bigint }[], rate: string): void => {
    const r = positiveRate(rate)!;
    const out = convertBalanced(lines, r);
    expect(out.reduce((a, l) => a + l.d, 0n)).toBe(out.reduce((a, l) => a + l.c, 0n));
    out.forEach((l, i) => {
      for (const side of ["d", "c"] as const) {
        const exact = multiplyDecimal(unitsToDecimal(lines[i]![side]), r);
        expect(withinOneUnitAtScale(unitsToDecimal(l[side]), exact, 2), `${String(i)}${side}`).toBe(true);
      }
    });
  };

  it("balances three lines whose roundings do not", () => {
    // 33.33 × 1.5 = 49.995 → 50.00 each, against 99.99 × 1.5 = 149.985 → 149.99.
    const lines = [
      { d: 9999n, c: 0n },
      { d: 0n, c: 3333n },
      { d: 0n, c: 3333n },
      { d: 0n, c: 3333n },
    ];
    const naive = lines.map((l) => ({ d: convertUnits(l.d, positiveRate("1.5")!), c: convertUnits(l.c, positiveRate("1.5")!) }));
    expect(naive.reduce((a, l) => a + l.d - l.c, 0n)).not.toBe(0n);
    sound(lines, "1.5");
  });

  it("balances negative amounts by moving each leg to its other rounding, never past it", () => {
    // −33.33 × 1.5 = −49.995 and −99.99 × 1.5 = −149.985: with truncation standing in for the floor,
    // the move lands the credit at −149.97, a cent and a half from its product.
    sound(
      [
        { d: -3333n, c: 0n },
        { d: -3333n, c: 0n },
        { d: -3333n, c: 0n },
        { d: 0n, c: -9999n },
      ],
      "1.5",
    );
  });

  it("rounds a half away from zero on either sign, convertUnits' rule (ADR-0475)", () => {
    // −0.01 × 0.5 = −0.005: half away from zero is −0.01. The rule this replaced rounded every half
    // up, so a negative half went to 0.00 while `convertUnits` answered −0.01 for the same product.
    const half = positiveRate("0.5")!;
    expect(convertUnits(-1n, half)).toBe(-1n);
    expect(convertUnits(1n, half)).toBe(1n);
    const out = convertBalanced([{ d: -1n, c: 0n }, { d: 0n, c: -1n }], half);
    expect(out).toEqual([{ d: -1n, c: 0n }, { d: 0n, c: -1n }]);
    expect(convertBalanced([{ d: 1n, c: 0n }, { d: 0n, c: 1n }], half)).toEqual([{ d: 1n, c: 0n }, { d: 0n, c: 1n }]);
    // Agreement on every half-cent product over a range, both signs: each balanced pair's legs are
    // exactly what `convertUnits` gives the same amount.
    for (let a = -25n; a <= 25n; a += 1n) {
      const [line] = convertBalanced([{ d: a, c: 0n }, { d: 0n, c: a }], half);
      expect(line!.d, String(a)).toBe(convertUnits(a, half));
    }
  });

  it("is the identity at rate 1", () => {
    const lines = [{ d: 123n, c: 0n }, { d: 0n, c: 123n }];
    expect(convertBalanced(lines, RATE_ONE)).toEqual(lines);
  });

  it("balances every split of a sum at awkward rates", () => {
    const rates = ["1.0833333333", "0.0000123457", "137.4560000000", "0.9999999999", "3"];
    for (const rate of rates) {
      for (let n = 2; n <= 9; n += 1) {
        const parts = Array.from({ length: n }, (_, i) => BigInt(1 + ((i * 7919) % 997)));
        const total = parts.reduce((a, b) => a + b, 0n);
        sound([{ d: total, c: 0n }, ...parts.map((p) => ({ d: 0n, c: p }))], rate);
      }
    }
  });

  it("states the exact rate the guard reads", () => {
    expect(parseDecimal(rateWire(positiveRate("1.1000000000")!))).toEqual(positiveRate("1.1000000000"));
  });
});
