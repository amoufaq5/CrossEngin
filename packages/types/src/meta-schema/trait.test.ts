import { describe, expect, it } from "vitest";
import { BUILTIN_TRAITS, TraitSchema, isBuiltinTrait } from "./trait.js";

describe("BUILTIN_TRAITS", () => {
  it("includes all 6 built-in traits per ADR-0003", () => {
    expect(BUILTIN_TRAITS).toEqual([
      "auditable",
      "soft_deletable",
      "versioned",
      "tenant_owned",
      "gxp_signed",
      "part_11_compliant",
    ]);
  });
});

describe("isBuiltinTrait", () => {
  it.each([
    "auditable",
    "soft_deletable",
    "versioned",
    "tenant_owned",
    "gxp_signed",
    "part_11_compliant",
  ])("returns true for %s", (name) => {
    expect(isBuiltinTrait(name)).toBe(true);
  });

  it("returns false for unknown trait names", () => {
    expect(isBuiltinTrait("geocoded")).toBe(false);
    expect(isBuiltinTrait("auditable_v2")).toBe(false);
    expect(isBuiltinTrait("")).toBe(false);
  });

  it("narrows the type for builtin names", () => {
    const candidate: string = "auditable";
    if (isBuiltinTrait(candidate)) {
      const _check:
        | "auditable"
        | "soft_deletable"
        | "versioned"
        | "tenant_owned"
        | "gxp_signed"
        | "part_11_compliant" = candidate;
      expect(_check).toBe("auditable");
    }
  });
});

describe("TraitSchema", () => {
  it("parses a custom trait with fields", () => {
    const input = {
      name: "geocoded",
      fields: [
        { name: "latitude", type: { kind: "decimal", precision: 10, scale: 6 } },
        { name: "longitude", type: { kind: "decimal", precision: 10, scale: 6 } },
      ],
    };
    expect(TraitSchema.parse(input)).toEqual(input);
  });

  it("parses a trait with empty fields (behavior-only trait like tenant_owned)", () => {
    const input = { name: "tenant_owned", fields: [] };
    expect(TraitSchema.parse(input)).toEqual(input);
  });

  it("rejects trait with PascalCase name", () => {
    expect(() => TraitSchema.parse({ name: "Geocoded", fields: [] })).toThrow();
  });

  it("rejects trait with empty name", () => {
    expect(() => TraitSchema.parse({ name: "", fields: [] })).toThrow();
  });
});
