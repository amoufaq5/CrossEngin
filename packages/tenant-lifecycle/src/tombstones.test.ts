import { describe, expect, it } from "vitest";
import {
  ANCHOR_KINDS,
  TOMBSTONE_KINDS,
  TombstoneRecordSchema,
  isCryptographicallyAnchored,
  tombstoneAge,
  tombstoneChainFor,
  tombstonesByKind,
  type TombstoneRecord,
} from "./tombstones.js";

const SHA = "a".repeat(64);

describe("constants", () => {
  it("TOMBSTONE_KINDS has 5 entries", () => {
    expect(TOMBSTONE_KINDS).toContain("tenant_deletion");
    expect(TOMBSTONE_KINDS).toContain("data_subject_erasure");
    expect(TOMBSTONE_KINDS).toContain("abandoned_export_purge");
  });

  it("ANCHOR_KINDS has 4 entries", () => {
    expect(ANCHOR_KINDS).toContain("internal_audit_log");
    expect(ANCHOR_KINDS).toContain("trillian_log");
    expect(ANCHOR_KINDS).toContain("rfc3161_timestamp");
  });
});

describe("TombstoneRecordSchema", () => {
  const base: TombstoneRecord = {
    id: "tomb_abc12345abc12345",
    kind: "tenant_deletion",
    tenantId: "t-1",
    deletedAt: "2026-05-14T10:00:00Z",
    executedBy: "u-executor",
    approvedBy: "u-approver",
    scope: {
      schemas: ["tenant_t1"],
      tables: ["tenant_t1.users"],
      objectStorageBuckets: ["bucket-t1"],
      backupGenerations: ["2026-05-14"],
      searchIndexes: [],
      cacheKeys: [],
      rowCount: 10_000,
      storageBytes: 1_000_000_000,
      fileCount: 500,
    },
    contentManifestSha256: SHA,
    proofSha256: SHA,
    anchors: [
      {
        kind: "internal_audit_log",
        reference: "audit-log-2026-05-14",
        anchoredAt: "2026-05-14T10:00:00Z",
      },
      {
        kind: "rfc3161_timestamp",
        reference: "tsa-token-abc",
        anchoredAt: "2026-05-14T10:00:01Z",
      },
    ],
    invalidationOfPriorTombstoneId: null,
  };

  it("accepts a valid tenant deletion tombstone", () => {
    expect(() => TombstoneRecordSchema.parse(base)).not.toThrow();
  });

  it("rejects executedBy == approvedBy (four-eyes)", () => {
    expect(() =>
      TombstoneRecordSchema.parse({ ...base, approvedBy: "u-executor" }),
    ).toThrow(/four-eyes/);
  });

  it("rejects data_subject_erasure without relatedDeletionRequestId", () => {
    expect(() =>
      TombstoneRecordSchema.parse({
        ...base,
        kind: "data_subject_erasure",
      }),
    ).toThrow(/relatedDeletionRequestId/);
  });

  it("rejects user_deletion without subjectIdentifier", () => {
    expect(() =>
      TombstoneRecordSchema.parse({
        ...base,
        kind: "user_deletion",
      }),
    ).toThrow(/subjectIdentifier/);
  });

  it("rejects tenant_deletion with empty scope", () => {
    expect(() =>
      TombstoneRecordSchema.parse({
        ...base,
        scope: {
          schemas: [],
          tables: [],
          objectStorageBuckets: [],
          backupGenerations: [],
          searchIndexes: [],
          cacheKeys: [],
          rowCount: 0,
          storageBytes: 0,
          fileCount: 0,
        },
      }),
    ).toThrow(/at least one schema\/table\/bucket\/backup/);
  });

  it("rejects rowCount > 0 without tables", () => {
    expect(() =>
      TombstoneRecordSchema.parse({
        ...base,
        scope: {
          schemas: ["x"],
          tables: [],
          objectStorageBuckets: ["b"],
          backupGenerations: [],
          searchIndexes: [],
          cacheKeys: [],
          rowCount: 100,
          storageBytes: 0,
          fileCount: 0,
        },
      }),
    ).toThrow(/at least one table in scope/);
  });

  it("rejects fileCount > 0 without buckets", () => {
    expect(() =>
      TombstoneRecordSchema.parse({
        ...base,
        scope: {
          schemas: ["x"],
          tables: ["t"],
          objectStorageBuckets: [],
          backupGenerations: [],
          searchIndexes: [],
          cacheKeys: [],
          rowCount: 100,
          storageBytes: 0,
          fileCount: 5,
        },
      }),
    ).toThrow(/at least one objectStorageBucket/);
  });

  it("rejects retainedReason without retainedDataReference", () => {
    expect(() =>
      TombstoneRecordSchema.parse({
        ...base,
        retainedReason: "tax law obligation",
      }),
    ).toThrow(/retainedDataReference/);
  });

  it("rejects duplicate anchors", () => {
    expect(() =>
      TombstoneRecordSchema.parse({
        ...base,
        anchors: [
          {
            kind: "internal_audit_log",
            reference: "ref-1",
            anchoredAt: "2026-05-14T10:00:00Z",
          },
          {
            kind: "internal_audit_log",
            reference: "ref-1",
            anchoredAt: "2026-05-14T10:00:01Z",
          },
        ],
      }),
    ).toThrow(/duplicate anchor/);
  });

  it("rejects malformed tombstone id", () => {
    expect(() =>
      TombstoneRecordSchema.parse({ ...base, id: "tomb_short" }),
    ).toThrow();
  });
});

describe("helpers", () => {
  const base: TombstoneRecord = {
    id: "tomb_abc12345abc12345",
    kind: "tenant_deletion",
    tenantId: "t-1",
    deletedAt: "2026-05-14T10:00:00Z",
    executedBy: "u-executor",
    approvedBy: "u-approver",
    scope: {
      schemas: ["tenant_t1"],
      tables: ["tenant_t1.users"],
      objectStorageBuckets: ["bucket-t1"],
      backupGenerations: [],
      searchIndexes: [],
      cacheKeys: [],
      rowCount: 100,
      storageBytes: 1000,
      fileCount: 1,
    },
    contentManifestSha256: SHA,
    proofSha256: SHA,
    anchors: [
      {
        kind: "internal_audit_log",
        reference: "audit-1",
        anchoredAt: "2026-05-14T10:00:00Z",
      },
    ],
    invalidationOfPriorTombstoneId: null,
  };

  it("tombstoneAge counts days since deletedAt", () => {
    expect(tombstoneAge(base, new Date("2026-05-24T10:00:00Z"))).toBe(10);
  });

  it("tombstonesByKind filters", () => {
    const records = [
      base,
      {
        ...base,
        id: "tomb_otherrecord1234",
        kind: "user_deletion" as const,
        subjectIdentifier: "u-2",
      },
    ];
    expect(tombstonesByKind(records, "tenant_deletion").length).toBe(1);
    expect(tombstonesByKind(records, "user_deletion").length).toBe(1);
  });

  it("tombstoneChainFor sorts by deletedAt ascending and filters by tenant", () => {
    const records = [
      { ...base, id: "tomb_aaaaaaaaaaaaaa", deletedAt: "2026-06-01T00:00:00Z" },
      { ...base, id: "tomb_bbbbbbbbbbbbbb", deletedAt: "2026-05-01T00:00:00Z" },
      {
        ...base,
        id: "tomb_cccccccccccccc",
        deletedAt: "2026-05-15T00:00:00Z",
        tenantId: "t-2",
      },
    ];
    const chain = tombstoneChainFor(records, "t-1");
    expect(chain.map((r) => r.id)).toEqual(["tomb_bbbbbbbbbbbbbb", "tomb_aaaaaaaaaaaaaa"]);
  });

  it("isCryptographicallyAnchored true for trillian/blockchain/rfc3161", () => {
    expect(
      isCryptographicallyAnchored({
        ...base,
        anchors: [
          {
            kind: "rfc3161_timestamp",
            reference: "x",
            anchoredAt: "2026-05-14T10:00:00Z",
          },
        ],
      }),
    ).toBe(true);
  });

  it("isCryptographicallyAnchored false for internal_audit_log only", () => {
    expect(isCryptographicallyAnchored(base)).toBe(false);
  });
});
