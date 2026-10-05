import { describe, expect, it } from "vitest";

import {
  TombstoneRecordSchema,
  type DeletionScope,
  type TombstoneCapabilityDeclaration,
  type TombstoneRecord,
} from "./tombstones.js";
import {
  canonicalContentManifest,
  canonicalContentManifestV2,
  canonicalProofPayload,
  computeContentManifestSha256,
  computeContentManifestSha256For,
  computeContentManifestSha256V2,
  computeProofSha256,
  contentManifestSubjectOf,
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
  // `.default(null)` on the schema, so present-and-null on the record this helper is handed.
  invalidationOfPriorTombstoneId: null,
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
};

function fixtureDeclaration(
  overrides: Partial<TombstoneCapabilityDeclaration> = {},
): TombstoneCapabilityDeclaration {
  return {
    tenant_schema: "erases",
    shared_tables: "erases",
    object_storage: "absent",
    backups: "absent",
    search_indexes: "absent",
    caches: "absent",
    ...overrides,
  };
}

/**
 * The bytes and the digest `fixtureScope()` produced before ADR-0329 existed, transcribed from a run
 * of the pre-change algorithm.
 *
 * This is the test that protects every tombstone already in every deployment. Their
 * `contentManifestSha256` was computed over exactly these bytes under exactly this tag, and
 * `verifyStoredEvidence` reports a digest that no longer matches as `scope_tampered` (ADR-0323) — the
 * one tamper class the forensic chain cannot raise. An edit to the v1 path would therefore forge that
 * alarm across the whole table at once, so the v1 path is pinned rather than trusted.
 */
const V1_FIXTURE_MANIFEST =
  '{"backupGenerations":["2026-05-15"],"cacheKeys":[],"fileCount":25,' +
  '"objectStorageBuckets":["files"],"rowCount":1000,"schemas":["tenant_a"],' +
  '"searchIndexes":[],"storageBytes":50000000,"tables":["orders","users"]}';
const V1_FIXTURE_SHA = "7e7f89744d424b6768c6f07174c7b6e0cd1e0248ebc5290332e21796ee294383";

describe("v1 content manifest is frozen", () => {
  it("renders the exact bytes stored tombstones were hashed over", () => {
    expect(canonicalContentManifest(fixtureScope())).toBe(V1_FIXTURE_MANIFEST);
  });

  it("produces the exact digest stored tombstones carry", () => {
    expect(computeContentManifestSha256(fixtureScope())).toBe(V1_FIXTURE_SHA);
  });
});

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

describe("canonicalContentManifestV2", () => {
  it("carries the declaration into the bytes", () => {
    const bytes = canonicalContentManifestV2(fixtureScope(), fixtureDeclaration());
    expect(bytes).toContain('"capabilityDeclaration":{');
    expect(bytes).toContain('"object_storage":"absent"');
  });

  it("extends the v1 body rather than replacing it", () => {
    const bytes = canonicalContentManifestV2(fixtureScope(), fixtureDeclaration());
    expect(bytes).toContain('"tables":["orders","users"]');
  });

  it("changes when any one disposition changes", () => {
    const a = canonicalContentManifestV2(fixtureScope(), fixtureDeclaration());
    const b = canonicalContentManifestV2(
      fixtureScope(),
      fixtureDeclaration({ caches: "erases" }),
    );
    expect(a).not.toBe(b);
  });

  it("is unaffected by the declaration's key order", () => {
    // `JSONB` does not preserve key order, so a digest over a round-tripped row has to match the
    // digest over the row that was written.
    const forward = fixtureDeclaration();
    const reversed: TombstoneCapabilityDeclaration = {
      caches: forward.caches,
      search_indexes: forward.search_indexes,
      backups: forward.backups,
      object_storage: forward.object_storage,
      shared_tables: forward.shared_tables,
      tenant_schema: forward.tenant_schema,
    };
    expect(canonicalContentManifestV2(fixtureScope(), reversed)).toBe(
      canonicalContentManifestV2(fixtureScope(), forward),
    );
  });
});

describe("computeContentManifestSha256V2", () => {
  it("does not collide with the v1 digest for the same scope", () => {
    // The whole reason v2 is a new tag: a v1 digest must never be mistakable for a v2 one.
    expect(computeContentManifestSha256V2(fixtureScope(), fixtureDeclaration())).not.toBe(
      computeContentManifestSha256(fixtureScope()),
    );
  });

  it("differs for differing declarations", () => {
    const a = computeContentManifestSha256V2(fixtureScope(), fixtureDeclaration());
    const b = computeContentManifestSha256V2(
      fixtureScope(),
      fixtureDeclaration({ backups: "retains" }),
    );
    expect(a).not.toBe(b);
  });
});

describe("contentManifestSubjectOf", () => {
  it("treats an absent proofVersion as v1", () => {
    expect(contentManifestSubjectOf({ scope: fixtureScope() })?.proofVersion).toBe("v1");
  });

  it("accepts v2 with a declaration", () => {
    const subject = contentManifestSubjectOf({
      proofVersion: "v2",
      scope: fixtureScope(),
      capabilityDeclaration: fixtureDeclaration(),
    });
    expect(subject?.proofVersion).toBe("v2");
  });

  it("refuses v2 with no declaration", () => {
    expect(
      contentManifestSubjectOf({ proofVersion: "v2", scope: fixtureScope() }),
    ).toBeNull();
  });

  it("refuses v1 with a declaration attached", () => {
    expect(
      contentManifestSubjectOf({
        proofVersion: "v1",
        scope: fixtureScope(),
        capabilityDeclaration: fixtureDeclaration(),
      }),
    ).toBeNull();
  });
});

describe("verification accepts both versions", () => {
  it("round-trips a v1 record", () => {
    const parsed = TombstoneRecordSchema.parse(
      populateTombstoneHashes({ ...FIXTURE_BASE, scope: fixtureScope() }),
    );
    expect(parsed.proofVersion).toBe("v1");
    expect(verifyTombstoneHashes(parsed)).toEqual({ contentManifestOk: true, proofOk: true });
  });

  it("round-trips a v2 record", () => {
    const parsed = TombstoneRecordSchema.parse(
      populateTombstoneHashes({
        ...FIXTURE_BASE,
        scope: fixtureScope(),
        proofVersion: "v2" as const,
        capabilityDeclaration: fixtureDeclaration(),
      }),
    );
    expect(parsed.proofVersion).toBe("v2");
    expect(verifyTombstoneHashes(parsed)).toEqual({ contentManifestOk: true, proofOk: true });
  });

  it("hashes a v2 record under the v2 digest", () => {
    const populated = populateTombstoneHashes({
      ...FIXTURE_BASE,
      scope: fixtureScope(),
      proofVersion: "v2" as const,
      capabilityDeclaration: fixtureDeclaration(),
    });
    expect(populated.contentManifestSha256).toBe(
      computeContentManifestSha256For({
        proofVersion: "v2",
        scope: fixtureScope(),
        capabilityDeclaration: fixtureDeclaration(),
      }),
    );
  });
});

describe("populateTombstoneHashes and the declaration", () => {
  it("keeps the v1 digest for a caller that names no version", () => {
    // What `assembleTombstone` does on the legacy `requiredSubsystems` path: its bytes must not move.
    const populated = populateTombstoneHashes({ ...FIXTURE_BASE, scope: fixtureScope() });
    expect(populated.contentManifestSha256).toBe(V1_FIXTURE_SHA);
  });

  it("throws rather than hash a v2 record with no declaration", () => {
    expect(() =>
      populateTombstoneHashes({
        ...FIXTURE_BASE,
        scope: fixtureScope(),
        proofVersion: "v2" as const,
      }),
    ).toThrow(/disagree/);
  });
});

describe("a tampered declaration is the whole point", () => {
  const stored = TombstoneRecordSchema.parse(
    populateTombstoneHashes({
      ...FIXTURE_BASE,
      scope: fixtureScope(),
      proofVersion: "v2" as const,
      capabilityDeclaration: fixtureDeclaration(),
    }),
  );

  it("fails verification when a disposition is rewritten", () => {
    // Before ADR-0329 this edit was invisible: the declaration lived beside the proof, so rewriting
    // "we have no object storage" into "we erase it" left every digest and the chain entry
    // byte-identical — ADR-0323's `scope_tampered` in a second place, with no detector at all.
    const tampered: TombstoneRecord = {
      ...stored,
      capabilityDeclaration: fixtureDeclaration({ object_storage: "erases" }),
    };
    const check = verifyTombstoneHashes(tampered);
    expect(check.contentManifestOk).toBe(false);
    // `proofSha256` commits to the *stored* manifest digest, which the editor did not touch, so the
    // proof still checks out and `contentManifestOk` is the only thing that can say otherwise.
    expect(check.proofOk).toBe(true);
  });

  it("fails verification when the declaration is removed outright", () => {
    const stripped = { ...stored, capabilityDeclaration: undefined };
    expect(verifyTombstoneHashes(stripped).contentManifestOk).toBe(false);
  });
});

describe("the version field cannot be forged to downgrade", () => {
  const stored = TombstoneRecordSchema.parse(
    populateTombstoneHashes({
      ...FIXTURE_BASE,
      scope: fixtureScope(),
      proofVersion: "v2" as const,
      capabilityDeclaration: fixtureDeclaration(),
    }),
  );

  it("fails when proofVersion is set back to v1 and the declaration stripped", () => {
    // The attack the explicit version field has to survive: relabel the row so it is checked against
    // bytes that never covered it. The v2 tag is not the v1 tag, so the recomputed v1 digest does not
    // match the stored one.
    const downgraded: TombstoneRecord = {
      ...stored,
      proofVersion: "v1",
      capabilityDeclaration: undefined,
    };
    expect(verifyTombstoneHashes(downgraded).contentManifestOk).toBe(false);
  });

  it("fails when proofVersion is set back to v1 and the declaration left attached", () => {
    const downgraded: TombstoneRecord = { ...stored, proofVersion: "v1" };
    expect(verifyTombstoneHashes(downgraded).contentManifestOk).toBe(false);
  });

  it("is defeated only by recomputing both digests, which the chain entry commits to", () => {
    // Stated rather than claimed otherwise: an editor who rewrites the declaration *and* recomputes
    // both digests produces an internally consistent record, and this module cannot tell. What moves
    // is `proofSha256`, which the forensic chain entry commits to (ADR-0318), so the detector is
    // `isAnchoredByChain` and not this function. Exactly the division of labour the scope already has.
    const forged = TombstoneRecordSchema.parse(
      populateTombstoneHashes({
        ...stored,
        capabilityDeclaration: fixtureDeclaration({ object_storage: "erases" }),
      }),
    );
    expect(verifyTombstoneHashes(forged)).toEqual({ contentManifestOk: true, proofOk: true });
    expect(forged.proofSha256).not.toBe(stored.proofSha256);
  });
});
