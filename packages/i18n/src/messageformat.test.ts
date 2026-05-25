import { describe, expect, it } from "vitest";
import {
  checkPlaceholderConsistency,
  IcuMessageSchema,
  parsePlaceholders,
  placeholderNames,
  validateIcuMessage,
} from "./messageformat.js";

describe("parsePlaceholders", () => {
  it("extracts simple placeholders", () => {
    const phs = parsePlaceholders("Hello {name}, welcome to {place}.");
    expect(phs.map((p) => p.name)).toEqual(["name", "place"]);
    expect(phs.every((p) => p.kind === "simple")).toBe(true);
  });

  it("extracts plural placeholders with cases", () => {
    const phs = parsePlaceholders(
      "{count, plural, =0 {No items} one {1 item} other {# items}}",
    );
    expect(phs).toHaveLength(1);
    if (phs[0] !== undefined) {
      expect(phs[0].kind).toBe("plural");
      expect([...(phs[0].cases ?? [])].sort()).toEqual(["=0", "one", "other"]);
    }
  });

  it("extracts number / date / time placeholders", () => {
    const phs = parsePlaceholders("Today {now, date, long} costs {price, number, ::currency/USD}");
    expect(phs[0]?.kind).toBe("date");
    expect(phs[1]?.kind).toBe("number");
  });

  it("dedupes repeated placeholders", () => {
    expect(placeholderNames("Hello {name}, {name}!")).toEqual(["name"]);
  });
});

describe("validateIcuMessage / IcuMessageSchema", () => {
  it("accepts a plain string", () => {
    expect(() => validateIcuMessage("Hello world")).not.toThrow();
  });

  it("accepts an ICU plural with required 'other'", () => {
    expect(() =>
      validateIcuMessage("{n, plural, one {1 thing} other {# things}}"),
    ).not.toThrow();
  });

  it("rejects unbalanced braces", () => {
    expect(() => validateIcuMessage("Hello {name")).toThrow(/unbalanced/);
    expect(() => validateIcuMessage("Hello }")).toThrow(/unbalanced/);
  });

  it("rejects plural without 'other'", () => {
    expect(() =>
      validateIcuMessage("{n, plural, one {1 thing}}"),
    ).toThrow(/missing the required 'other'/);
  });

  it("rejects an unknown format kind", () => {
    expect(() =>
      validateIcuMessage("{x, fancy, ...}"),
    ).toThrow(/unknown ICU format kind/);
  });

  it("IcuMessageSchema rejects through zod", () => {
    expect(() => IcuMessageSchema.parse("oops {")).toThrow();
  });
});

describe("checkPlaceholderConsistency", () => {
  it("reports missing placeholders", () => {
    const { missing, extra } = checkPlaceholderConsistency(
      "Hello {name}, the price is {price}",
      "Hello {name}",
    );
    expect(missing).toEqual(["price"]);
    expect(extra).toEqual([]);
  });

  it("reports extra placeholders", () => {
    const { missing, extra } = checkPlaceholderConsistency(
      "Hello {name}",
      "Hello {name}, region {region}",
    );
    expect(missing).toEqual([]);
    expect(extra).toEqual(["region"]);
  });

  it("returns empty arrays when placeholders match", () => {
    const { missing, extra } = checkPlaceholderConsistency(
      "Hello {name}",
      "مرحبا {name}",
    );
    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
  });
});
