import { describe, expect, it } from "vitest";
import {
  PROVENANCE_OPERATION_KINDS,
  PROVENANCE_OUTCOMES,
  ProvenanceRecordSchema,
  REGULATED_OPERATIONS,
  aggregateProvenance,
  isProvenanceImmutable,
  requiresRegulatoryAudit,
  type ProvenanceRecord,
} from "./provenance.js";

const baseRecord: ProvenanceRecord = {
  id: "prv_tx000001",
  tenantId: "11111111-1111-1111-1111-111111111111",
  operationKind: "transform",
  edgeKind: "derived_from",
  occurredAt: "2026-05-16T10:00:00.000Z",
  actorPrincipalId: "22222222-2222-2222-2222-222222222222",
  actorSystemId: null,
  actorPackage: "@crossengin/reporting",
  inputNodeIds: ["lng_userstable"],
  outputNodeIds: ["lng_usersview"],
  operationParametersSha256: "a".repeat(64),
  operationCodeSha256: "b".repeat(64),
  relatedWorkflowInstanceId: null,
  relatedActivityId: null,
  relatedJobRunId: "job-2026-05-16-001",
  outcome: "succeeded",
  durationMs: 500,
  rowsRead: 10_000,
  rowsWritten: 10_000,
  errorCode: null,
  errorMessage: null,
  rolledBackAt: null,
  rolledBackReason: null,
  causedByProvenanceId: null,
};

describe("constants", () => {
  it("has 15 operation kinds", () => {
    expect(PROVENANCE_OPERATION_KINDS).toHaveLength(15);
  });
  it("has 4 outcomes", () => {
    expect(PROVENANCE_OUTCOMES).toHaveLength(4);
  });
  it("REGULATED_OPERATIONS includes redact/anonymize/export/ai_inference/tombstone", () => {
    expect(REGULATED_OPERATIONS.size).toBe(5);
    expect(REGULATED_OPERATIONS.has("anonymize")).toBe(true);
    expect(REGULATED_OPERATIONS.has("ai_inference")).toBe(true);
    expect(REGULATED_OPERATIONS.has("tombstone")).toBe(true);
  });
});

describe("ProvenanceRecordSchema", () => {
  it("accepts a succeeded transform record", () => {
    expect(() => ProvenanceRecordSchema.parse(baseRecord)).not.toThrow();
  });

  it("rejects ingest operation with input nodes", () => {
    expect(() =>
      ProvenanceRecordSchema.parse({
        ...baseRecord,
        operationKind: "ingest",
      }),
    ).toThrow(/ingest operation cannot have inputNodeIds/);
  });

  it("rejects non-ingest operation without input nodes", () => {
    expect(() =>
      ProvenanceRecordSchema.parse({
        ...baseRecord,
        operationKind: "transform",
        inputNodeIds: [],
      }),
    ).toThrow(/requires at least one inputNodeId/);
  });

  it("rejects failed without errorCode/errorMessage", () => {
    expect(() => ProvenanceRecordSchema.parse({ ...baseRecord, outcome: "failed" })).toThrow(
      /failed outcome requires/,
    );
  });

  it("rejects rolled_back without rolledBackAt/reason", () => {
    expect(() =>
      ProvenanceRecordSchema.parse({
        ...baseRecord,
        outcome: "rolled_back",
      }),
    ).toThrow(/rolled_back outcome requires/);
  });

  it("rejects regulated operation without operationParametersSha256", () => {
    expect(() =>
      ProvenanceRecordSchema.parse({
        ...baseRecord,
        operationKind: "anonymize",
        operationParametersSha256: null,
      }),
    ).toThrow(/regulated operations require operationParametersSha256/);
  });

  it("rejects neither user nor system actor", () => {
    expect(() =>
      ProvenanceRecordSchema.parse({
        ...baseRecord,
        actorPrincipalId: null,
      }),
    ).toThrow(/either actorPrincipalId or actorSystemId/);
  });

  it("rejects node that is both input and output", () => {
    expect(() =>
      ProvenanceRecordSchema.parse({
        ...baseRecord,
        outputNodeIds: ["lng_userstable", "lng_usersview"],
      }),
    ).toThrow(/cannot be both input and output/);
  });

  it("accepts ingest operation with no inputs (entry point)", () => {
    expect(() =>
      ProvenanceRecordSchema.parse({
        ...baseRecord,
        operationKind: "ingest",
        inputNodeIds: [],
      }),
    ).not.toThrow();
  });
});

describe("isProvenanceImmutable", () => {
  it("returns true for succeeded", () => {
    expect(isProvenanceImmutable(baseRecord)).toBe(true);
  });
  it("returns false for rolled_back", () => {
    expect(
      isProvenanceImmutable({
        ...baseRecord,
        outcome: "rolled_back",
        rolledBackAt: "2026-05-16T11:00:00.000Z",
        rolledBackReason: "data quality issue",
      }),
    ).toBe(false);
  });
});

describe("requiresRegulatoryAudit", () => {
  it("flags anonymize", () => {
    expect(requiresRegulatoryAudit({ ...baseRecord, operationKind: "anonymize" })).toBe(true);
  });
  it("does not flag query", () => {
    expect(requiresRegulatoryAudit({ ...baseRecord, operationKind: "query" })).toBe(false);
  });
});

describe("aggregateProvenance", () => {
  it("returns zeros for empty input", () => {
    const s = aggregateProvenance([]);
    expect(s.totalRecords).toBe(0);
    expect(s.totalRowsRead).toBe(0);
  });

  it("aggregates counts by outcome + operation", () => {
    const records: ProvenanceRecord[] = [
      baseRecord,
      {
        ...baseRecord,
        id: "prv_anon0001",
        operationKind: "anonymize",
      },
      {
        ...baseRecord,
        id: "prv_fail0001",
        outcome: "failed",
        errorCode: "OOM",
        errorMessage: "out of memory",
      },
    ];
    const s = aggregateProvenance(records);
    expect(s.totalRecords).toBe(3);
    expect(s.succeededCount).toBe(2);
    expect(s.failedCount).toBe(1);
    expect(s.operationCounts.transform).toBe(2);
    expect(s.operationCounts.anonymize).toBe(1);
    expect(s.regulatedOperationCount).toBe(1);
    expect(s.totalRowsRead).toBe(30_000);
  });
});
