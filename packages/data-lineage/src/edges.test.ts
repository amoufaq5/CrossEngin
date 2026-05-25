import { describe, expect, it } from "vitest";
import {
  CLASSIFICATION_DOWNGRADING_EDGES,
  EDGE_KINDS,
  LineageEdgeSchema,
  isValidDowngrade,
  propagateClassification,
  type LineageEdge,
} from "./edges.js";

const baseEdge: LineageEdge = {
  id: "lne_userstx01",
  tenantId: "11111111-1111-1111-1111-111111111111",
  kind: "derived_from",
  sourceNodeId: "lng_userstable",
  targetNodeId: "lng_usersview",
  sourceClassification: "pii_personal",
  targetClassification: "pii_personal",
  columnsContributing: ["email", "name"],
  columnsConsumed: ["email", "name"],
  transformExpressionSha256: "a".repeat(64),
  rowCountConsumed: 10_000,
  rowCountProduced: 10_000,
  kAnonymityAchieved: null,
  redactionRules: [],
  provenanceRecordId: "prv_tx000001",
  createdAt: "2026-05-16T10:00:00.000Z",
  createdByUserId: "22222222-2222-2222-2222-222222222222",
  createdBySystem: null,
};

describe("constants", () => {
  it("has 10 edge kinds", () => {
    expect(EDGE_KINDS).toHaveLength(10);
  });
  it("CLASSIFICATION_DOWNGRADING_EDGES includes redacted/anonymized/aggregated", () => {
    expect(CLASSIFICATION_DOWNGRADING_EDGES.size).toBe(3);
    expect(CLASSIFICATION_DOWNGRADING_EDGES.has("redacted_from")).toBe(true);
    expect(CLASSIFICATION_DOWNGRADING_EDGES.has("anonymized_from")).toBe(true);
    expect(CLASSIFICATION_DOWNGRADING_EDGES.has("aggregated_from")).toBe(true);
  });
});

describe("LineageEdgeSchema", () => {
  it("accepts a derived_from edge", () => {
    expect(() => LineageEdgeSchema.parse(baseEdge)).not.toThrow();
  });

  it("rejects self-edge (source === target)", () => {
    expect(() =>
      LineageEdgeSchema.parse({
        ...baseEdge,
        targetNodeId: baseEdge.sourceNodeId,
      }),
    ).toThrow(/cannot connect node to itself/);
  });

  it("rejects classification downgrade via non-downgrading edge kind", () => {
    expect(() =>
      LineageEdgeSchema.parse({
        ...baseEdge,
        sourceClassification: "phi_protected",
        targetClassification: "internal",
      }),
    ).toThrow(/cannot downgrade classification/);
  });

  it("accepts classification downgrade via redacted_from", () => {
    expect(() =>
      LineageEdgeSchema.parse({
        ...baseEdge,
        kind: "redacted_from",
        sourceClassification: "pii_personal",
        targetClassification: "internal",
        redactionRules: ["mask:email", "mask:phone"],
      }),
    ).not.toThrow();
  });

  it("rejects redacted_from without redactionRules", () => {
    expect(() =>
      LineageEdgeSchema.parse({
        ...baseEdge,
        kind: "redacted_from",
        sourceClassification: "pii_personal",
        targetClassification: "internal",
      }),
    ).toThrow(/redactionRules/);
  });

  it("rejects anonymized_from without kAnonymityAchieved", () => {
    expect(() =>
      LineageEdgeSchema.parse({
        ...baseEdge,
        kind: "anonymized_from",
        sourceClassification: "pii_personal",
        targetClassification: "public",
      }),
    ).toThrow(/kAnonymityAchieved/);
  });

  it("rejects anonymized_from with k < 5", () => {
    expect(() =>
      LineageEdgeSchema.parse({
        ...baseEdge,
        kind: "anonymized_from",
        sourceClassification: "pii_personal",
        targetClassification: "public",
        kAnonymityAchieved: 3,
      }),
    ).toThrow(/kAnonymityAchieved >= 5/);
  });
});

describe("propagateClassification", () => {
  it("preserves classification on direct edge", () => {
    expect(
      propagateClassification({
        edgeKind: "derived_from",
        inputClassifications: ["pii_personal"],
        kAnonymityAchieved: null,
        allColumnsRedacted: false,
      }),
    ).toBe("pii_personal");
  });

  it("downgrades pii → internal via redacted_from", () => {
    expect(
      propagateClassification({
        edgeKind: "redacted_from",
        inputClassifications: ["pii_personal"],
        kAnonymityAchieved: null,
        allColumnsRedacted: true,
      }),
    ).toBe("internal");
  });

  it("downgrades pii → public via anonymized_from with k≥5", () => {
    expect(
      propagateClassification({
        edgeKind: "anonymized_from",
        inputClassifications: ["pii_personal"],
        kAnonymityAchieved: 5,
        allColumnsRedacted: false,
      }),
    ).toBe("public");
  });

  it("downgrades phi → internal via anonymized_from", () => {
    expect(
      propagateClassification({
        edgeKind: "anonymized_from",
        inputClassifications: ["phi_protected"],
        kAnonymityAchieved: 10,
        allColumnsRedacted: false,
      }),
    ).toBe("internal");
  });

  it("downgrades phi → internal via aggregated_from with k≥11", () => {
    expect(
      propagateClassification({
        edgeKind: "aggregated_from",
        inputClassifications: ["phi_protected"],
        kAnonymityAchieved: 15,
        allColumnsRedacted: false,
      }),
    ).toBe("internal");
  });

  it("propagates highest sensitivity from multiple inputs", () => {
    expect(
      propagateClassification({
        edgeKind: "joined_with",
        inputClassifications: ["public", "pii_personal", "internal"],
        kAnonymityAchieved: null,
        allColumnsRedacted: false,
      }),
    ).toBe("pii_personal");
  });
});

describe("isValidDowngrade", () => {
  it("allows no-downgrade (same level)", () => {
    expect(isValidDowngrade("internal", "internal", "derived_from", null)).toBe(true);
  });
  it("blocks downgrade on derived_from", () => {
    expect(isValidDowngrade("pii_personal", "internal", "derived_from", null)).toBe(false);
  });
  it("allows downgrade via anonymized_from with k≥5", () => {
    expect(isValidDowngrade("pii_personal", "public", "anonymized_from", 7)).toBe(true);
  });
  it("blocks anonymized_from with k<5", () => {
    expect(isValidDowngrade("pii_personal", "public", "anonymized_from", 4)).toBe(false);
  });
  it("aggregated_from requires k≥11", () => {
    expect(isValidDowngrade("phi_protected", "internal", "aggregated_from", 11)).toBe(true);
    expect(isValidDowngrade("phi_protected", "internal", "aggregated_from", 10)).toBe(false);
  });
});
