import { describe, expect, it } from "vitest";
import {
  containsLikelyPhi,
  FixtureDeclarationSchema,
  FixtureRegistrySchema,
  fixturesByKind,
  fixturesByVertical,
  fixturesForPack,
  PHI_HEURISTIC_REGEX,
} from "./fixtures.js";

describe("FixtureDeclarationSchema", () => {
  it("parses a PHI-free pharmacy manifest fixture", () => {
    expect(() =>
      FixtureDeclarationSchema.parse({
        id: "operate-pharma-base",
        kind: "tenant_manifest",
        vertical: "pharmacy",
        description: "Minimal pharmacy manifest with one entity",
        path: "packages/testing/manifests/pharmacy/base.yaml",
        phiFree: true,
      }),
    ).not.toThrow();
  });

  it("rejects fixtures that are not PHI-free", () => {
    expect(() =>
      FixtureDeclarationSchema.parse({
        id: "bad",
        kind: "synthetic_records",
        vertical: "hospital",
        description: "x",
        path: "x",
        phiFree: false,
      }),
    ).toThrow(/PHI-free/);
  });

  it("compliance-pack fixtures require appliesToPackId", () => {
    expect(() =>
      FixtureDeclarationSchema.parse({
        id: "x",
        kind: "compliance_pack_compliant",
        vertical: "pharmacy",
        description: "x",
        path: "x",
        phiFree: true,
      }),
    ).toThrow(/requires appliesToPackId/);
  });
});

describe("FixtureRegistrySchema + helpers", () => {
  const registry = FixtureRegistrySchema.parse([
    {
      id: "base",
      kind: "tenant_manifest",
      vertical: "pharmacy",
      description: "Pharmacy base manifest",
      path: "x",
      phiFree: true,
    },
    {
      id: "compliant-21cfr",
      kind: "compliance_pack_compliant",
      vertical: "pharmacy",
      description: "Compliant 21 CFR Part 11 manifest",
      path: "x",
      phiFree: true,
      appliesToPackId: "21-cfr-part-11",
    },
    {
      id: "violation-21cfr",
      kind: "compliance_pack_violation",
      vertical: "pharmacy",
      description: "Manifest missing required signatures",
      path: "x",
      phiFree: true,
      appliesToPackId: "21-cfr-part-11",
    },
  ]);

  it("rejects duplicate fixture ids", () => {
    expect(() =>
      FixtureRegistrySchema.parse([
        {
          id: "dup",
          kind: "tenant_manifest",
          vertical: "generic",
          description: "x",
          path: "x",
          phiFree: true,
        },
        {
          id: "dup",
          kind: "tenant_manifest",
          vertical: "generic",
          description: "y",
          path: "y",
          phiFree: true,
        },
      ]),
    ).toThrow(/duplicate fixture id/);
  });

  it("fixturesByKind filters", () => {
    expect(fixturesByKind(registry, "tenant_manifest")).toHaveLength(1);
  });

  it("fixturesByVertical filters", () => {
    expect(fixturesByVertical(registry, "pharmacy")).toHaveLength(3);
    expect(fixturesByVertical(registry, "ngo")).toHaveLength(0);
  });

  it("fixturesForPack filters by appliesToPackId", () => {
    expect(fixturesForPack(registry, "21-cfr-part-11")).toHaveLength(2);
  });
});

describe("containsLikelyPhi", () => {
  it("flags SSN-shaped strings", () => {
    expect(containsLikelyPhi("Patient SSN: 123-45-6789")).toBe(true);
  });

  it("flags name + DOB strings", () => {
    expect(containsLikelyPhi("John A. Smith DOB: 1980-01-01")).toBe(true);
  });

  it("does not flag generic text", () => {
    expect(containsLikelyPhi("Lorem ipsum dolor sit amet")).toBe(false);
  });

  it("PHI_HEURISTIC_REGEX is exported for downstream scanners", () => {
    expect(PHI_HEURISTIC_REGEX).toBeInstanceOf(RegExp);
  });
});
