import { describe, expect, it } from "vitest";

import { TombstoneRecordSchema, type DeletionScope, type TombstoneRecord } from "./tombstones.js";
import {
  canonicalContentManifest,
  canonicalProofPayload,
  computeContentManifestSha256,
  computeProofSha256,
  populateTombstoneHashes,
  verifyTombstoneHashes,
} from "./tombstone-proof.js";

function fixtureScope(overrides: Partial<DeletionScope> = {}): DeletionScope {
  return {
    schemas: ["tenant_a"],
    tables: ["users", "orders"],
    objectStorageBuckets: ["files"],
    backupGenerations: ["2026-05-15"],
    searchIndexes: [],
    cacheKeys: [],
    rowCount: 1_000,
    storageBytes: 50_000_000,
    fileCount: 25,
    ...overrides,
  };
}

const FIXTURE_BASE = {
  id: "tomb_abcdef123456",
  kind: "tenant_deletion" as const,
  tenantId: "00000000-0000-4000-8000-000000000001",
  deletedAt: "2026-05-16T12:00:00.000Z",
  executedBy: "user:alice",
  approvedBy: "user:bob",
  anchors: [
    {
      kind: "internal_audit_log" as const,
      reference: "audit:1",
      anchoredAt: "2026-05-16T12:00:01.000Z",
    },
  ],
  invalidationOfPriorTombstoneId: null,
};

describe("canonicalContentManifest", () => {
  it("sorts arrays so reordering does not change output", () => {
    const a = canonicalContentManifest(fixtureScope({ tables: ["a", "b", "c"] }));
    const b = canonicalContentManifest(fixtureScope({ tables: ["c", "a", "b"] }));
    expect(a).toBe(b);
  });

  it("is sensitive to scope value changes", () => {
    const a = canonicalContentManifest(fixtureScope({ rowCount: 100 }));
    const b = canonicalContentManifest(fixtureScope({ rowCount: 200 }));
    expect(a).not.toBe(b);
  });
});

describe("computeContentManifestSha256", () => {
  it("returns 64-char hex", () => {
    expect(computeContentManifestSha256(fixtureScope())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs for differing scopes", () => {
    const a = computeContentManifestSha256(fixtureScope({ tables: ["a"] }));
    const b = computeContentManifestSha256(fixtureScope({ tables: ["b"] }));
    expect(a).not.toBe(b);
  });

  it("is stable across reorderings", () => {
    const a = computeContentManifestSha256(fixtureScope({ tables: ["a", "b"] }));
    const b = computeContentManifestSha256(fixtureScope({ tables: ["b", "a"] }));
    expect(a).toBe(b);
  });
});

describe("canonicalProofPayload + computeProofSha256", () => {
  it("includes the contentManifestSha256 input", () => {
    const a = computeProofSha256({
      ...FIXTURE_BASE,
      contentManifestSha256: "a".repeat(64),
    });
    const b = computeProofSha256({
      ...FIXTURE_BASE,
      contentManifestSha256: "b".repeat(64),
    });
    expect(a).not.toBe(b);
  });

  it("is stable for identical input", () => {
    const a = computeProofSha256({
      ...FIXTURE_BASE,
      contentManifestSha256: "a".repeat(64),
    });
    const b = computeProofSha256({
      ...FIXTURE_BASE,
      contentManifestSha256: "a".repeat(64),
    });
    expect(a).toBe(b);
  });

  it("changes when executedBy changes", () => {
    const base = { ...FIXTURE_BASE, contentManifestSha256: "a".repeat(64) };
    const a = computeProofSha256(base);
    const b = computeProofSha256({ ...base, executedBy: "user:carol" });
    expect(a).not.toBe(b);
  });

  it("renders canonical JSON for the payload", () => {
    const canonical = canonicalProofPayload({
      ...FIXTURE_BASE,
      contentManifestSha256: "a".repeat(64),
    });
    expect(canonical).toContain('"approvedBy":"user:bob"');
    expect(canonical).toContain('"deletedAt":"2026-05-16T12:00:00.000Z"');
  });
});

describe("populateTombstoneHashes", () => {
  it("produces a tombstone record that passes zod validation", () => {
    const populated = populateTombstoneHashes({
      ...FIXTURE_BASE,
      scope: fixtureScope(),
    });
    const parsed: TombstoneRecord = TombstoneRecordSchema.parse(populated);
    expect(parsed.contentManifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.proofSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces hashes that round-trip through verifyTombstoneHashes", () => {
    const populated = populateTombstoneHashes({
      ...FIXTURE_BASE,
      scope: fixtureScope(),
    });
    const parsed = TombstoneRecordSchema.parse(populated);
    const check = verifyTombstoneHashes(parsed);
    expect(check.contentManifestOk).toBe(true);
    expect(check.proofOk).toBe(true);
  });
});

describe("verifyTombstoneHashes", () => {
  it("detects a tampered contentManifestSha256", () => {
    const populated = populateTombstoneHashes({
      ...FIXTURE_BASE,
      scope: fixtureScope(),
    });
    const parsed = TombstoneRecordSchema.parse(populated);
    const tampered: TombstoneRecord = {
      ...parsed,
      contentManifestSha256: "0".repeat(64),
    };
    const check = verifyTombstoneHashes(tampered);
    expect(check.contentManifestOk).toBe(false);
    expect(check.proofOk).toBe(false);
  });

  it("detects a tampered proofSha256", () => {
    const populated = populateTombstoneHashes({
      ...FIXTURE_BASE,
      scope: fixtureScope(),
    });
    const parsed = TombstoneRecordSchema.parse(populated);
    const tampered: TombstoneRecord = {
      ...parsed,
      proofSha256: "0".repeat(64),
    };
    const check = verifyTombstoneHashes(tampered);
    expect(check.contentManifestOk).toBe(true);
    expect(check.proofOk).toBe(false);
  });

  it("detects a tampered scope (recomputed content manifest no longer matches)", () => {
    const populated = populateTombstoneHashes({
      ...FIXTURE_BASE,
      scope: fixtureScope(),
    });
    const parsed = TombstoneRecordSchema.parse(populated);
    const tampered: TombstoneRecord = {
      ...parsed,
      scope: { ...parsed.scope, rowCount: parsed.scope.rowCount + 1 },
    };
    const check = verifyTombstoneHashes(tampered);
    expect(check.contentManifestOk).toBe(false);
  });
});
