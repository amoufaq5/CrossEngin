import { describe, expect, it } from "vitest";
import {
  CLASSIFICATION_SENSITIVITY,
  DATA_CLASSIFICATIONS,
  LINEAGE_NODE_KINDS,
  LineageNodeSchema,
  NODE_LIFECYCLE_STATUSES,
  NODE_LIFECYCLE_TRANSITIONS,
  REGULATED_CLASSIFICATIONS,
  canTransitionNode,
  isHigherSensitivity,
  isRegulatedNode,
  isWithinRetention,
  maxSensitivityOf,
  type LineageNode,
} from "./nodes.js";

const baseNode: LineageNode = {
  id: "lng_userstable",
  tenantId: "11111111-1111-1111-1111-111111111111",
  kind: "source_table",
  label: "Users table",
  status: "active",
  classification: "pii_personal",
  rowCount: 10_000,
  columnCount: 20,
  sizeBytes: 1_000_000,
  contentSha256: "a".repeat(64),
  storageUri: "postgres://meta/users",
  externalRef: null,
  sourcePackage: "@crossengin/migration",
  createdAt: "2026-05-16T10:00:00.000Z",
  createdByUserId: "22222222-2222-2222-2222-222222222222",
  createdBySystem: null,
  frozenAt: null,
  frozenSha256: null,
  purgedAt: null,
  tombstonedAt: null,
  retentionUntil: "2032-05-16T10:00:00.000Z",
  minimumKAnonymity: null,
};

describe("constants", () => {
  it("has 14 node kinds", () => {
    expect(LINEAGE_NODE_KINDS).toHaveLength(14);
  });
  it("has 6 data classifications", () => {
    expect(DATA_CLASSIFICATIONS).toHaveLength(6);
  });
  it("has 5 lifecycle statuses", () => {
    expect(NODE_LIFECYCLE_STATUSES).toHaveLength(5);
  });
  it("REGULATED includes pii/phi/financial", () => {
    expect(REGULATED_CLASSIFICATIONS.has("pii_personal")).toBe(true);
    expect(REGULATED_CLASSIFICATIONS.has("phi_protected")).toBe(true);
    expect(REGULATED_CLASSIFICATIONS.has("regulated_financial")).toBe(true);
    expect(REGULATED_CLASSIFICATIONS.has("public")).toBe(false);
  });
  it("sensitivity ordering: phi > financial > pii > confidential > internal > public", () => {
    expect(CLASSIFICATION_SENSITIVITY.phi_protected).toBeGreaterThan(
      CLASSIFICATION_SENSITIVITY.regulated_financial,
    );
    expect(CLASSIFICATION_SENSITIVITY.regulated_financial).toBeGreaterThan(
      CLASSIFICATION_SENSITIVITY.pii_personal,
    );
    expect(CLASSIFICATION_SENSITIVITY.public).toBe(0);
  });
});

describe("canTransitionNode", () => {
  it("allows active → frozen", () => {
    expect(canTransitionNode("active", "frozen")).toBe(true);
  });
  it("blocks active → active (no self-transition)", () => {
    expect(canTransitionNode("active", "active")).toBe(false);
  });
  it("tombstoned is terminal", () => {
    expect(NODE_LIFECYCLE_TRANSITIONS.tombstoned).toEqual([]);
  });
});

describe("LineageNodeSchema", () => {
  it("accepts an active source_table", () => {
    expect(() => LineageNodeSchema.parse(baseNode)).not.toThrow();
  });

  it("rejects neither user nor system actor", () => {
    expect(() =>
      LineageNodeSchema.parse({
        ...baseNode,
        createdByUserId: null,
      }),
    ).toThrow(/either createdByUserId or createdBySystem/);
  });

  it("rejects frozen without frozenAt + frozenSha256", () => {
    expect(() =>
      LineageNodeSchema.parse({ ...baseNode, status: "frozen" }),
    ).toThrow(/frozen node requires frozenAt \+ frozenSha256/);
  });

  it("rejects purged without purgedAt", () => {
    expect(() =>
      LineageNodeSchema.parse({ ...baseNode, status: "purged" }),
    ).toThrow(/purgedAt/);
  });

  it("rejects aggregation_result without minimumKAnonymity", () => {
    expect(() =>
      LineageNodeSchema.parse({
        ...baseNode,
        kind: "aggregation_result",
      }),
    ).toThrow(/k-anonymity floor/);
  });

  it("rejects redacted_view classified as pii_personal (must downgrade)", () => {
    expect(() =>
      LineageNodeSchema.parse({ ...baseNode, kind: "redacted_view" }),
    ).toThrow(/redacted_view classification must downgrade/);
  });

  it("rejects tenant_export without tenantId", () => {
    expect(() =>
      LineageNodeSchema.parse({
        ...baseNode,
        kind: "tenant_export",
        tenantId: null,
      }),
    ).toThrow(/tenant_export requires tenantId/);
  });
});

describe("isRegulatedNode", () => {
  it("flags pii_personal as regulated", () => {
    expect(isRegulatedNode(baseNode)).toBe(true);
  });
  it("does not flag public", () => {
    expect(
      isRegulatedNode({ ...baseNode, classification: "public" }),
    ).toBe(false);
  });
});

describe("isHigherSensitivity", () => {
  it("phi > pii", () => {
    expect(isHigherSensitivity("phi_protected", "pii_personal")).toBe(true);
  });
  it("public !> internal", () => {
    expect(isHigherSensitivity("public", "internal")).toBe(false);
  });
});

describe("maxSensitivityOf", () => {
  it("returns public for empty list", () => {
    expect(maxSensitivityOf([])).toBe("public");
  });
  it("returns highest of inputs", () => {
    expect(
      maxSensitivityOf(["internal", "pii_personal", "confidential"]),
    ).toBe("pii_personal");
  });
});

describe("isWithinRetention", () => {
  it("returns true before retentionUntil", () => {
    expect(
      isWithinRetention(baseNode, new Date("2026-12-01T00:00:00Z")),
    ).toBe(true);
  });
  it("returns false past retentionUntil", () => {
    expect(
      isWithinRetention(baseNode, new Date("2033-01-01T00:00:00Z")),
    ).toBe(false);
  });
  it("returns true when retentionUntil is null (indefinite)", () => {
    expect(
      isWithinRetention(
        { ...baseNode, retentionUntil: null },
        new Date("2099-01-01T00:00:00Z"),
      ),
    ).toBe(true);
  });
});
