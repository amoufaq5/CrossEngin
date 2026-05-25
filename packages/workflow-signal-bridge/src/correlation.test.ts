import { describe, expect, it } from "vitest";

import {
  FieldPathExtractor,
  FirstFieldExtractor,
  FixedExtractor,
  fieldPathExtractor,
  firstFieldExtractor,
  fixedExtractor,
} from "./correlation.js";

describe("FieldPathExtractor", () => {
  it("returns the value at a top-level path", () => {
    const e = new FieldPathExtractor("orderId");
    expect(e.extract({ orderId: "po-1" })).toBe("po-1");
  });

  it("returns the value at a nested path", () => {
    const e = new FieldPathExtractor("order.id");
    expect(e.extract({ order: { id: "po-99" } })).toBe("po-99");
  });

  it("returns null when an intermediate segment is missing", () => {
    const e = new FieldPathExtractor("order.id");
    expect(e.extract({})).toBeNull();
    expect(e.extract({ order: null })).toBeNull();
    expect(e.extract({ order: "scalar" })).toBeNull();
  });

  it("coerces numeric values to string", () => {
    const e = new FieldPathExtractor("orderId");
    expect(e.extract({ orderId: 42 })).toBe("42");
  });

  it("returns null for non-string non-number leaf values", () => {
    const e = new FieldPathExtractor("ids");
    expect(e.extract({ ids: ["a", "b"] })).toBeNull();
    expect(e.extract({ ids: true })).toBeNull();
  });

  it("rejects an empty path", () => {
    expect(() => new FieldPathExtractor("")).toThrow(/non-empty path/);
  });

  it("fieldPathExtractor() is the function form", () => {
    expect(fieldPathExtractor("x").extract({ x: "y" })).toBe("y");
  });
});

describe("FixedExtractor", () => {
  it("always returns the same value", () => {
    const e = new FixedExtractor("po-fixed");
    expect(e.extract()).toBe("po-fixed");
  });

  it("rejects an empty value", () => {
    expect(() => new FixedExtractor("")).toThrow(/non-empty value/);
  });

  it("fixedExtractor() is the function form", () => {
    expect(fixedExtractor("x").extract({})).toBe("x");
  });
});

describe("FirstFieldExtractor", () => {
  it("returns the first present field", () => {
    const e = new FirstFieldExtractor(["primary", "fallback"]);
    expect(e.extract({ primary: "a", fallback: "b" })).toBe("a");
  });

  it("falls through to the next when first is missing", () => {
    const e = new FirstFieldExtractor(["primary", "fallback"]);
    expect(e.extract({ fallback: "b" })).toBe("b");
  });

  it("returns null when no field matches", () => {
    const e = new FirstFieldExtractor(["a", "b"]);
    expect(e.extract({ c: "x" })).toBeNull();
  });

  it("rejects empty fieldNames", () => {
    expect(() => new FirstFieldExtractor([])).toThrow(/at least one/);
  });

  it("skips empty string values", () => {
    const e = new FirstFieldExtractor(["primary", "fallback"]);
    expect(e.extract({ primary: "", fallback: "b" })).toBe("b");
  });

  it("firstFieldExtractor() is the function form", () => {
    expect(firstFieldExtractor("a", "b").extract({ b: "yes" })).toBe("yes");
  });
});
