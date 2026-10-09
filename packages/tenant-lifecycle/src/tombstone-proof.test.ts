import { sha256 } from "@crossengin/crypto";
import { describe, expect, it } from "vitest";

import {
  PROOF_VERSION_COVERAGE,
  TOMBSTONE_PROOF_VERSIONS,
  TombstoneRecordSchema,
  type DeletionScope,
  type TombstoneCapabilityDeclaration,
  type TombstoneProofVersion,
  type TombstoneRecord,
  type TombstoneRecordStorageDeclaration,
} from "./tombstones.js";
import {
  canonicalContentManifest,
  canonicalContentManifestFor,
  canonicalContentManifestV2,
  canonicalContentManifestV3,
  canonicalContentManifestV4,
  canonicalProofPayload,
  computeContentManifestSha256,
  computeContentManifestSha256For,
  computeContentManifestSha256V2,
  computeContentManifestSha256V3,
  computeContentManifestSha256V4,
  computeProofSha256,
  contentManifestSubjectOf,
  populateTombstoneHashes,
  verifyTombstoneHashes,
  type ContentManifestSource,
  type TombstoneRetentionClaim,
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

/**
 * The v2 bytes, pinned the way the v1 bytes already were.
 *
 * ADR-0329 shipped v2 without a digest fixture, so the only guard on its bytes was that nothing had
 * touched them. ADR-0331 adds a third tag beside them, which is exactly the change that could move
 * them by accident — the digests below were computed from the pre-ADR-0331 `dist/` and transcribed.
 * A change here does not break a test; it reports `scope_tampered` on every v2 record on file, and
 * that finding escalates to a paging `sev1` (ADR-0324).
 */
const V2_FIXTURE_MANIFEST =
  '{"backupGenerations":["2026-05-15"],"cacheKeys":[],"capabilityDeclaration":' +
  '{"backups":"absent","caches":"absent","object_storage":"absent","search_indexes":"absent",' +
  '"shared_tables":"erases","tenant_schema":"erases"},"fileCount":25,' +
  '"objectStorageBuckets":["files"],"rowCount":1000,"schemas":["tenant_a"],' +
  '"searchIndexes":[],"storageBytes":50000000,"tables":["orders","users"]}';
const V2_FIXTURE_SHA = "979750b9bc4d6ee8b1fc7853adc5b3252bd9dab5e478e63f10e7fa56c2be2f07";

describe("v2 content manifest is frozen", () => {
  it("renders the exact bytes stored v2 tombstones were hashed over", () => {
    expect(canonicalContentManifestV2(fixtureScope(), fixtureDeclaration())).toBe(
      V2_FIXTURE_MANIFEST,
    );
  });

  it("produces the exact digest stored v2 tombstones carry", () => {
    expect(computeContentManifestSha256V2(fixtureScope(), fixtureDeclaration())).toBe(
      V2_FIXTURE_SHA,
    );
  });

  it("still produces the v1 digest for the same scope with no declaration", () => {
    expect(computeContentManifestSha256(fixtureScope())).toBe(V1_FIXTURE_SHA);
  });
});

const POPULATED_CLAIM: TombstoneRetentionClaim = {
  obligations: ["tax_records_7y"],
  retainedReason: "retained under legal obligation — backups: tax_records_7y",
  retainedDataReference: "backup-vault://2026",
};
const EMPTY_CLAIM: TombstoneRetentionClaim = { obligations: [] };

describe("canonicalContentManifestV3", () => {
  it("carries the retention claim into the bytes", () => {
    const bytes = canonicalContentManifestV3(
      fixtureScope(),
      fixtureDeclaration(),
      POPULATED_CLAIM,
    );
    expect(bytes).toContain('"retentionClaim":{');
    expect(bytes).toContain('"obligations":["tax_records_7y"]');
    expect(bytes).toContain('"retainedDataReference":"backup-vault://2026"');
  });

  it("extends the v2 body rather than replacing it", () => {
    const bytes = canonicalContentManifestV3(
      fixtureScope(),
      fixtureDeclaration(),
      POPULATED_CLAIM,
    );
    expect(bytes).toContain('"capabilityDeclaration":{');
    expect(bytes).toContain('"tables":["orders","users"]');
  });

  it("renders an empty claim with explicit nulls, never with missing keys", () => {
    // `canonicalStringify` drops `undefined`, so an omitted key would make the empty claim and a
    // claim with its prose stripped render identically — the one pair a signed claim must separate.
    const bytes = canonicalContentManifestV3(fixtureScope(), fixtureDeclaration(), EMPTY_CLAIM);
    expect(bytes).toContain(
      '"retentionClaim":{"obligations":[],"retainedDataReference":null,"retainedReason":null}',
    );
  });

  it("carries no figure of any kind on the retained side", () => {
    // ADR-0317's subject is a number in a proof meaning something other than what a reader assumes,
    // and the figures in these bytes mean "destroyed". There is no field here that could hold a
    // retained row count, and the rendered claim must not acquire one.
    const bytes = canonicalContentManifestV3(
      fixtureScope(),
      fixtureDeclaration(),
      POPULATED_CLAIM,
    );
    const claim = /"retentionClaim":\{[^}]*\}/.exec(bytes)?.[0] ?? "";
    expect(claim).not.toBe("");
    expect(claim).not.toMatch(/:\s*\d/);
  });

  it("changes when the obligations change", () => {
    expect(
      canonicalContentManifestV3(fixtureScope(), fixtureDeclaration(), POPULATED_CLAIM),
    ).not.toBe(
      canonicalContentManifestV3(fixtureScope(), fixtureDeclaration(), {
        ...POPULATED_CLAIM,
        obligations: ["medical_records_10y"],
      }),
    );
  });

  it("changes when the retained reason prose changes", () => {
    expect(
      canonicalContentManifestV3(fixtureScope(), fixtureDeclaration(), POPULATED_CLAIM),
    ).not.toBe(
      canonicalContentManifestV3(fixtureScope(), fixtureDeclaration(), {
        ...POPULATED_CLAIM,
        retainedReason: "retained under legal obligation — backups: medical_records_10y",
      }),
    );
  });

  it("changes when the retained data reference changes", () => {
    expect(
      canonicalContentManifestV3(fixtureScope(), fixtureDeclaration(), POPULATED_CLAIM),
    ).not.toBe(
      canonicalContentManifestV3(fixtureScope(), fixtureDeclaration(), {
        ...POPULATED_CLAIM,
        retainedDataReference: "backup-vault://somewhere-else",
      }),
    );
  });

  it("sorts and deduplicates the obligations, so a JSONB round trip cannot move a digest", () => {
    expect(
      canonicalContentManifestV3(fixtureScope(), fixtureDeclaration(), {
        ...POPULATED_CLAIM,
        obligations: ["tax_records_7y", "audit_logs_3y", "tax_records_7y"],
      }),
    ).toBe(
      canonicalContentManifestV3(fixtureScope(), fixtureDeclaration(), {
        ...POPULATED_CLAIM,
        obligations: ["audit_logs_3y", "tax_records_7y"],
      }),
    );
  });
});

describe("computeContentManifestSha256V3", () => {
  it("collides with neither the v1 nor the v2 digest for the same scope", () => {
    const v3 = computeContentManifestSha256V3(
      fixtureScope(),
      fixtureDeclaration(),
      EMPTY_CLAIM,
    );
    expect(v3).not.toBe(computeContentManifestSha256(fixtureScope()));
    expect(v3).not.toBe(computeContentManifestSha256V2(fixtureScope(), fixtureDeclaration()));
  });

  it("separates 'nothing was retained' from a populated claim", () => {
    expect(
      computeContentManifestSha256V3(fixtureScope(), fixtureDeclaration(), EMPTY_CLAIM),
    ).not.toBe(
      computeContentManifestSha256V3(fixtureScope(), fixtureDeclaration(), POPULATED_CLAIM),
    );
  });
});

describe("contentManifestSubjectOf refuses every version/payload mixture", () => {
  it("accepts v3 with a declaration and obligations", () => {
    const subject = contentManifestSubjectOf({
      proofVersion: "v3",
      scope: fixtureScope(),
      capabilityDeclaration: fixtureDeclaration(),
      retainedObligations: [],
    });
    expect(subject?.proofVersion).toBe("v3");
  });

  it("refuses v3 with no obligations", () => {
    expect(
      contentManifestSubjectOf({
        proofVersion: "v3",
        scope: fixtureScope(),
        capabilityDeclaration: fixtureDeclaration(),
      }),
    ).toBeNull();
  });

  it("refuses v3 with no declaration", () => {
    expect(
      contentManifestSubjectOf({
        proofVersion: "v3",
        scope: fixtureScope(),
        retainedObligations: [],
      }),
    ).toBeNull();
  });

  it("refuses v2 with obligations attached", () => {
    expect(
      contentManifestSubjectOf({
        proofVersion: "v2",
        scope: fixtureScope(),
        capabilityDeclaration: fixtureDeclaration(),
        retainedObligations: ["tax_records_7y"],
      }),
    ).toBeNull();
  });

  it("refuses v1 with obligations attached", () => {
    expect(
      contentManifestSubjectOf({
        proofVersion: "v1",
        scope: fixtureScope(),
        retainedObligations: [],
      }),
    ).toBeNull();
  });

  it("accepts v1 and v2 carrying unsigned retention prose", () => {
    // The field that is deliberately **not** paired with the version. Every stored v1 and v2 record
    // with a retention has this prose on its face and outside its bytes; refusing it would be a
    // retroactive tightening on honest records, which is the migration ADR-0329 ruled out.
    expect(
      contentManifestSubjectOf({
        scope: fixtureScope(),
        retainedReason: POPULATED_CLAIM.retainedReason,
        retainedDataReference: POPULATED_CLAIM.retainedDataReference,
      })?.proofVersion,
    ).toBe("v1");
    expect(
      contentManifestSubjectOf({
        proofVersion: "v2",
        scope: fixtureScope(),
        capabilityDeclaration: fixtureDeclaration(),
        retainedReason: POPULATED_CLAIM.retainedReason,
        retainedDataReference: POPULATED_CLAIM.retainedDataReference,
      })?.proofVersion,
    ).toBe("v2");
  });

  it("builds the v3 subject's claim from the record's three retention fields", () => {
    const subject = contentManifestSubjectOf({
      proofVersion: "v3",
      scope: fixtureScope(),
      capabilityDeclaration: fixtureDeclaration(),
      retainedObligations: ["tax_records_7y"],
      retainedReason: POPULATED_CLAIM.retainedReason,
      retainedDataReference: POPULATED_CLAIM.retainedDataReference,
    });
    expect(subject?.proofVersion).toBe("v3");
    if (subject?.proofVersion !== "v3") return;
    expect(subject.retentionClaim).toEqual(POPULATED_CLAIM);
  });
});

describe("a v3 record verifies and a tampered retention claim does not", () => {
  const stored = TombstoneRecordSchema.parse(
    populateTombstoneHashes({
      ...FIXTURE_BASE,
      scope: fixtureScope(),
      proofVersion: "v3" as const,
      capabilityDeclaration: fixtureDeclaration(),
      retainedObligations: ["tax_records_7y"],
      retainedReason: POPULATED_CLAIM.retainedReason,
      retainedDataReference: POPULATED_CLAIM.retainedDataReference,
    }),
  );

  it("round-trips", () => {
    expect(stored.proofVersion).toBe("v3");
    expect(verifyTombstoneHashes(stored)).toEqual({ contentManifestOk: true, proofOk: true });
  });

  it("hashes under the v3 tag", () => {
    expect(stored.contentManifestSha256).toBe(
      computeContentManifestSha256For({
        proofVersion: "v3",
        scope: fixtureScope(),
        capabilityDeclaration: fixtureDeclaration(),
        retentionClaim: POPULATED_CLAIM,
      }),
    );
  });

  it("fails verification when the retained reason prose is rewritten", () => {
    // **This is the deliverable.** Before ADR-0331 this edit was invisible: the retention claim was
    // on the record and in neither digest, so rewriting why a tenant's data survived left
    // `contentManifestSha256`, `proofSha256` and the chain entry byte-identical. ADR-0323 established
    // that `contentManifestOk` is the only detector for an edit the chain cannot see; now it sees it.
    const check = verifyTombstoneHashes({
      ...stored,
      retainedReason: "retained under legal obligation — backups: medical_records_10y",
    });
    expect(check.contentManifestOk).toBe(false);
    // The proof commits to the *stored* manifest digest, which the editor did not touch, so
    // `proofOk` stays true and `contentManifestOk` is the only thing that can say otherwise.
    expect(check.proofOk).toBe(true);
  });

  it("fails verification when the retained data reference is moved", () => {
    expect(
      verifyTombstoneHashes({ ...stored, retainedDataReference: "backup-vault://elsewhere" })
        .contentManifestOk,
    ).toBe(false);
  });

  it("fails verification when an obligation is swapped", () => {
    expect(
      verifyTombstoneHashes({ ...stored, retainedObligations: ["medical_records_10y"] })
        .contentManifestOk,
    ).toBe(false);
  });

  it("fails verification when the retention claim is emptied outright", () => {
    // The tamper that matters most: a stored proof edited to say nothing was kept, over data that
    // is still there. Under v2 the record would have been left byte-identical.
    expect(
      verifyTombstoneHashes({
        ...stored,
        retainedObligations: [],
        retainedReason: undefined,
        retainedDataReference: undefined,
      }).contentManifestOk,
    ).toBe(false);
  });

  it("fails when relabelled to v2 with the obligations stripped", () => {
    // The self-covering downgrade, in its third form. An inference from "does it carry obligations?"
    // would have read this as an older record and checked it against bytes that never covered it.
    expect(
      verifyTombstoneHashes({
        ...stored,
        proofVersion: "v2",
        retainedObligations: undefined,
      }).contentManifestOk,
    ).toBe(false);
  });

  it("fails when relabelled to v2 with the obligations left attached", () => {
    expect(
      verifyTombstoneHashes({ ...stored, proofVersion: "v2" }).contentManifestOk,
    ).toBe(false);
  });

  it("fails when relabelled to v1", () => {
    expect(
      verifyTombstoneHashes({
        ...stored,
        proofVersion: "v1",
        capabilityDeclaration: undefined,
        retainedObligations: undefined,
      }).contentManifestOk,
    ).toBe(false);
  });

  it("throws rather than hash a v3 record with no obligations", () => {
    expect(() =>
      populateTombstoneHashes({
        ...FIXTURE_BASE,
        scope: fixtureScope(),
        proofVersion: "v3" as const,
        capabilityDeclaration: fixtureDeclaration(),
      }),
    ).toThrow(/disagrees with what it carries/);
  });

  it("leaves a forged-and-rehashed claim to the forensic chain", () => {
    // The division of labour, unchanged from the declaration's. An editor who rewrites the claim and
    // recomputes both digests passes here, and moves `proofSha256` — which the chain entry commits
    // to (ADR-0318), so it is caught there.
    const forged = TombstoneRecordSchema.parse(
      populateTombstoneHashes({
        ...stored,
        retainedObligations: ["medical_records_10y"],
        retainedReason: "retained under legal obligation — backups: medical_records_10y",
      }),
    );
    expect(verifyTombstoneHashes(forged)).toEqual({ contentManifestOk: true, proofOk: true });
    expect(forged.proofSha256).not.toBe(stored.proofSha256);
  });
});

/**
 * `crossengin.tombstone.proof.v1` is unchanged by v2 and by v3, pinned rather than reasoned about.
 *
 * The argument the three content tags rest on is that the proof payload commits to
 * `contentManifestSha256` and to nothing else version-specific, so a new content tag moves the
 * content digest and the proof function stays where it is. That argument is cheap to state and the
 * thing it protects is expensive: `proofSha256` is what the forensic chain entry commits to
 * (ADR-0318), so a change here would not fail one test, it would detach **every** stored tombstone
 * from its anchor at once.
 *
 * The three digests below were produced by running the pre-ADR-0331 proof module — the one at the
 * ADR-0329 commit, which has no v3 in it — over each of the three content digests, including the v3
 * one it cannot itself compute. So the pin is not "this is what the code does today"; it is the older
 * implementation's own output, and that implementation never saw a v3 record.
 */
const PROOF_OVER_V1_CONTENT = "06b7e7d55b225e2e9c08b0f02bdfc6c72ece366fd2561b11fcb331046bb269be";
const PROOF_OVER_V2_CONTENT = "1a8af4bb16173be652ca5f07fce00d9c8d279cde52aedce6b9a80397bf35e4d8";
const PROOF_OVER_V3_CONTENT = "6c562ee3112fa244b637f630204ef35cec150e441368faaa0a38dc58d4d3d96c";

/** The v3 digest for the pinned fixture, so v3's bytes are frozen the way v1's and v2's are. */
const V3_FIXTURE_SHA = "25b1bdcfd340ebfb7a073cb2a5d252de51c576beb4c7098b9ceee6f21dcd7fbc";

// Named for what it pins rather than for a count: these are the three tags that predate v4, each
// asserted against the digest the *pre-change* module produced. The v4 half of the same property
// has its own block below, because v4 has no older module to be checked against.
describe("the proof domain tag is shared by the three versions preceding v4", () => {
  it("produces the pre-change digest over a v1 content manifest", () => {
    expect(computeProofSha256({ ...FIXTURE_BASE, contentManifestSha256: V1_FIXTURE_SHA })).toBe(
      PROOF_OVER_V1_CONTENT,
    );
  });

  it("produces the pre-change digest over a v2 content manifest", () => {
    expect(computeProofSha256({ ...FIXTURE_BASE, contentManifestSha256: V2_FIXTURE_SHA })).toBe(
      PROOF_OVER_V2_CONTENT,
    );
  });

  it("produces the pre-change digest over a v3 content manifest", () => {
    // The one case the pre-change module could not reach on its own, and the reason this block
    // exists: handed a v3 content digest, the older proof function answered identically.
    expect(
      computeContentManifestSha256V3(fixtureScope(), fixtureDeclaration(), POPULATED_CLAIM),
    ).toBe(V3_FIXTURE_SHA);
    expect(computeProofSha256({ ...FIXTURE_BASE, contentManifestSha256: V3_FIXTURE_SHA })).toBe(
      PROOF_OVER_V3_CONTENT,
    );
  });

  it("gives the three versions three different content digests for one scope", () => {
    // What makes one proof tag safe for three content tags: the version is already distinguished
    // upstream, so the proof payload never has to carry it.
    expect(new Set([V1_FIXTURE_SHA, V2_FIXTURE_SHA, V3_FIXTURE_SHA]).size).toBe(3);
  });
});

function fixtureRecordStorage(
  overrides: Partial<TombstoneRecordStorageDeclaration> = {},
): TombstoneRecordStorageDeclaration {
  return { model: "typed_tables", schema: "public", relationCount: 54, ...overrides };
}

/** The model that names no typed relations, and so the one whose `schema` is a real `null`. */
const DOCUMENT_ROWS_STORAGE = fixtureRecordStorage({
  model: "document_rows",
  schema: null,
  relationCount: 0,
});

/**
 * The v4 bytes and digest, **derived** rather than transcribed from this implementation.
 *
 * The three pins above could be taken from an older module's own output; v4 has no older module, so
 * echoing whatever the new code prints would pin nothing. These were computed outside this package
 * instead — canonical JSON assembled by hand and hashed through `node:crypto` — and the same
 * derivation reproduces `V1_FIXTURE_SHA`, `V3_FIXTURE_SHA` and all three `PROOF_OVER_*` digests
 * exactly. So this is an independent answer the implementation has to match.
 */
const V4_FIXTURE_MANIFEST =
  '{"backupGenerations":["2026-05-15"],"cacheKeys":[],"capabilityDeclaration":' +
  '{"backups":"absent","caches":"absent","object_storage":"absent","search_indexes":"absent",' +
  '"shared_tables":"erases","tenant_schema":"erases"},"fileCount":25,' +
  '"objectStorageBuckets":["files"],' +
  '"recordStorage":{"model":"typed_tables","relationCount":54,"schema":"public"},' +
  '"retentionClaim":{"obligations":["tax_records_7y"],' +
  '"retainedDataReference":"backup-vault://2026",' +
  '"retainedReason":"retained under legal obligation — backups: tax_records_7y"},' +
  '"rowCount":1000,"schemas":["tenant_a"],"searchIndexes":[],"storageBytes":50000000,' +
  '"tables":["orders","users"]}';
const V4_FIXTURE_SHA = "c3439b2a01b3a296015d7e0e30e77610d9b82012325dc1b17928a7c132c85bc1";
const PROOF_OVER_V4_CONTENT = "98315dfcb7d6f92413d0093b897788c3ae3a58e943201642a317b31e829377d7";

function v3Body(): string {
  return canonicalContentManifestV3(fixtureScope(), fixtureDeclaration(), POPULATED_CLAIM);
}

function v4Body(
  recordStorage: TombstoneRecordStorageDeclaration = fixtureRecordStorage(),
  claim: TombstoneRetentionClaim = POPULATED_CLAIM,
): string {
  return canonicalContentManifestV4(fixtureScope(), fixtureDeclaration(), claim, recordStorage);
}

function v4Digest(
  recordStorage: TombstoneRecordStorageDeclaration = fixtureRecordStorage(),
  claim: TombstoneRetentionClaim = POPULATED_CLAIM,
): string {
  return computeContentManifestSha256V4(
    fixtureScope(),
    fixtureDeclaration(),
    claim,
    recordStorage,
  );
}

describe("v4 content manifest is frozen", () => {
  it("renders the derived bytes", () => {
    expect(v4Body()).toBe(V4_FIXTURE_MANIFEST);
  });

  it("produces the derived digest", () => {
    expect(v4Digest()).toBe(V4_FIXTURE_SHA);
  });

  it("leaves the three older fixtures exactly where they were", () => {
    expect(canonicalContentManifest(fixtureScope())).toBe(V1_FIXTURE_MANIFEST);
    expect(computeContentManifestSha256(fixtureScope())).toBe(V1_FIXTURE_SHA);
    expect(canonicalContentManifestV2(fixtureScope(), fixtureDeclaration())).toBe(
      V2_FIXTURE_MANIFEST,
    );
    expect(computeContentManifestSha256V2(fixtureScope(), fixtureDeclaration())).toBe(
      V2_FIXTURE_SHA,
    );
    expect(
      computeContentManifestSha256V3(fixtureScope(), fixtureDeclaration(), POPULATED_CLAIM),
    ).toBe(V3_FIXTURE_SHA);
  });
});

describe("canonicalContentManifestV4", () => {
  it("is the v3 body plus exactly one top-level key", () => {
    const v3 = JSON.parse(v3Body()) as Record<string, unknown>;
    const v4 = JSON.parse(v4Body()) as Record<string, unknown>;
    const { recordStorage, ...sharedWithV3 } = v4;
    expect(recordStorage).toEqual(fixtureRecordStorage());
    // Every other key, and every other key's *value*, is what v3 already said — compared as parsed
    // objects rather than read off the pinned string, so a key renamed or a value quietly rewritten
    // fails here and not only in the fixture.
    expect(sharedWithV3).toEqual(v3);
  });

  it("sorts the declaration's three keys, whatever order it was built in", () => {
    const forward = fixtureRecordStorage();
    const reversed: TombstoneRecordStorageDeclaration = {
      relationCount: forward.relationCount,
      schema: forward.schema,
      model: forward.model,
    };
    expect(v4Body(reversed)).toBe(V4_FIXTURE_MANIFEST);
    expect(v4Digest(reversed)).toBe(V4_FIXTURE_SHA);
  });

  it("renders a null schema as an explicit null, never as a missing key", () => {
    expect(v4Body(DOCUMENT_ROWS_STORAGE)).toContain(
      '"recordStorage":{"model":"document_rows","relationCount":0,"schema":null}',
    );
  });

  it("separates a null schema from one that was stripped", () => {
    // `canonicalStringify` drops `undefined`, so an omitted key would render a model that never had
    // a schema and one whose schema was *removed* identically — the asymmetry ADR-0331 established,
    // and the only reason this declaration is signable at all.
    const stripped = {
      model: DOCUMENT_ROWS_STORAGE.model,
      relationCount: DOCUMENT_ROWS_STORAGE.relationCount,
    } as unknown as TombstoneRecordStorageDeclaration;
    expect(v4Body(stripped)).not.toBe(v4Body(DOCUMENT_ROWS_STORAGE));
    expect(v4Digest(stripped)).not.toBe(v4Digest(DOCUMENT_ROWS_STORAGE));
  });

  it("changes when the relation count changes", () => {
    // The field that earns the version: `typed_tables` with a count of zero is a column store
    // serving a manifest that declares no entity, which v1/v2/v3 bytes cannot tell from a
    // deployment holding no typed relations at all.
    expect(v4Body(fixtureRecordStorage({ relationCount: 0 }))).not.toBe(v4Body());
    expect(v4Digest(fixtureRecordStorage({ relationCount: 0 }))).not.toBe(v4Digest());
  });

  it("changes when the model changes", () => {
    expect(v4Digest(DOCUMENT_ROWS_STORAGE)).not.toBe(v4Digest());
  });

  it("changes when the schema changes", () => {
    expect(v4Digest(fixtureRecordStorage({ schema: "meta" }))).not.toBe(v4Digest());
  });

  it("still separates the retention claim it inherited from v3", () => {
    expect(v4Digest(fixtureRecordStorage(), EMPTY_CLAIM)).not.toBe(v4Digest());
  });
});

/**
 * The tags are module-private, so this is where they are written down.
 *
 * Domain separation is the entire mechanism: the relabelling tamper below is caught because a
 * recomputed older digest is a digest under a *different* tag. Two versions sharing a tag would
 * make that attack undetectable while every other test in this file still passed.
 */
const CONTENT_DOMAIN_TAGS = {
  v1: "crossengin.tombstone.content.v1\n",
  v2: "crossengin.tombstone.content.v2\n",
  v3: "crossengin.tombstone.content.v3\n",
  v4: "crossengin.tombstone.content.v4\n",
} satisfies Record<TombstoneProofVersion, string>;

describe("the four content domain tags", () => {
  it("are four distinct strings", () => {
    expect(new Set(Object.values(CONTENT_DOMAIN_TAGS)).size).toBe(4);
  });

  it("are each what their version's digest is actually computed under", () => {
    expect(computeContentManifestSha256(fixtureScope())).toBe(
      sha256(CONTENT_DOMAIN_TAGS.v1 + canonicalContentManifest(fixtureScope())),
    );
    expect(computeContentManifestSha256V2(fixtureScope(), fixtureDeclaration())).toBe(
      sha256(
        CONTENT_DOMAIN_TAGS.v2 + canonicalContentManifestV2(fixtureScope(), fixtureDeclaration()),
      ),
    );
    expect(
      computeContentManifestSha256V3(fixtureScope(), fixtureDeclaration(), POPULATED_CLAIM),
    ).toBe(sha256(CONTENT_DOMAIN_TAGS.v3 + v3Body()));
    expect(v4Digest()).toBe(sha256(CONTENT_DOMAIN_TAGS.v4 + v4Body()));
  });

  it("give one scope four different content digests", () => {
    expect(
      new Set([
        computeContentManifestSha256(fixtureScope()),
        computeContentManifestSha256V2(fixtureScope(), fixtureDeclaration()),
        computeContentManifestSha256V3(fixtureScope(), fixtureDeclaration(), POPULATED_CLAIM),
        v4Digest(),
      ]).size,
    ).toBe(4);
  });

  it("cover every declared version and no more", () => {
    // `satisfies` above already makes a fifth version a compile error, and this is the same check at
    // test time: running vitest is not running the type checker, and a tag nobody pinned is the
    // regression this file exists to stop.
    expect(Object.keys(CONTENT_DOMAIN_TAGS).sort()).toEqual([...TOMBSTONE_PROOF_VERSIONS].sort());
  });
});

interface CarriedPayload {
  readonly declaration: boolean;
  readonly retentionClaim: boolean;
  readonly recordStorage: boolean;
}

const CARRIED_COMBINATIONS: readonly CarriedPayload[] = [0, 1, 2, 3, 4, 5, 6, 7].map((bits) => ({
  declaration: (bits & 1) !== 0,
  retentionClaim: (bits & 2) !== 0,
  recordStorage: (bits & 4) !== 0,
}));

function sourceCarrying(
  version: TombstoneProofVersion,
  carried: CarriedPayload,
): ContentManifestSource {
  return {
    proofVersion: version,
    scope: fixtureScope(),
    ...(carried.declaration ? { capabilityDeclaration: fixtureDeclaration() } : {}),
    ...(carried.retentionClaim ? { retainedObligations: [] } : {}),
    ...(carried.recordStorage ? { recordStorage: fixtureRecordStorage() } : {}),
  };
}

describe("contentManifestSubjectOf pairs every version with exactly what its tag covers", () => {
  // Enumerated from the enum and `PROOF_VERSION_COVERAGE` rather than restated, so a fifth version
  // added to `TOMBSTONE_PROOF_VERSIONS` with no branch in `contentManifestSubjectOf` fails here: it
  // would otherwise fall off the end of the if-chain and answer with a `v1` subject, which is the
  // silent regression that map exists to prevent.
  for (const version of TOMBSTONE_PROOF_VERSIONS) {
    const covers = PROOF_VERSION_COVERAGE[version];
    for (const carried of CARRIED_COMBINATIONS) {
      const matches =
        covers.declaration === carried.declaration &&
        covers.retentionClaim === carried.retentionClaim &&
        covers.recordStorage === carried.recordStorage;
      const label = [
        carried.declaration ? "declaration" : "no declaration",
        carried.retentionClaim ? "obligations" : "no obligations",
        carried.recordStorage ? "recordStorage" : "no recordStorage",
      ].join(" + ");
      it(`${matches ? "accepts" : "refuses"} ${version} carrying ${label}`, () => {
        const subject = contentManifestSubjectOf(sourceCarrying(version, carried));
        if (matches) {
          expect(subject?.proofVersion).toBe(version);
        } else {
          // Never a best-effort hash: a digest under the wrong tag would read as a tamper and one
          // computed by ignoring an attached field would read as clean.
          expect(subject).toBeNull();
        }
      });
    }
  }
});

describe("the v4 subject", () => {
  it("carries all four parts and names its own version", () => {
    const subject = contentManifestSubjectOf({
      proofVersion: "v4",
      scope: fixtureScope(),
      capabilityDeclaration: fixtureDeclaration(),
      retainedObligations: ["tax_records_7y"],
      retainedReason: POPULATED_CLAIM.retainedReason,
      retainedDataReference: POPULATED_CLAIM.retainedDataReference,
      recordStorage: fixtureRecordStorage(),
    });
    expect(subject?.proofVersion).toBe("v4");
    if (subject?.proofVersion !== "v4") return;
    expect(subject.scope).toEqual(fixtureScope());
    expect(subject.capabilityDeclaration).toEqual(fixtureDeclaration());
    expect(subject.retentionClaim).toEqual(POPULATED_CLAIM);
    expect(subject.recordStorage).toEqual(fixtureRecordStorage());
  });

  it("refuses v4 with no recordStorage", () => {
    expect(
      contentManifestSubjectOf({
        proofVersion: "v4",
        scope: fixtureScope(),
        capabilityDeclaration: fixtureDeclaration(),
        retainedObligations: ["tax_records_7y"],
      }),
    ).toBeNull();
  });

  it("refuses v3 with a recordStorage declaration attached", () => {
    expect(
      contentManifestSubjectOf({
        proofVersion: "v3",
        scope: fixtureScope(),
        capabilityDeclaration: fixtureDeclaration(),
        retainedObligations: ["tax_records_7y"],
        recordStorage: fixtureRecordStorage(),
      }),
    ).toBeNull();
  });

  it("is rendered and hashed by the version-dispatching pair", () => {
    const subject: ContentManifestSource = {
      proofVersion: "v4",
      scope: fixtureScope(),
      capabilityDeclaration: fixtureDeclaration(),
      retainedObligations: ["tax_records_7y"],
      retainedReason: POPULATED_CLAIM.retainedReason,
      retainedDataReference: POPULATED_CLAIM.retainedDataReference,
      recordStorage: fixtureRecordStorage(),
    };
    const resolved = contentManifestSubjectOf(subject);
    expect(resolved).not.toBeNull();
    if (resolved === null) return;
    expect(canonicalContentManifestFor(resolved)).toBe(v4Body());
    expect(computeContentManifestSha256For(resolved)).toBe(v4Digest());
    expect(computeContentManifestSha256For(resolved)).toBe(V4_FIXTURE_SHA);
  });
});

describe("a v4 record verifies and a tampered record-storage declaration does not", () => {
  const stored = TombstoneRecordSchema.parse(
    populateTombstoneHashes({
      ...FIXTURE_BASE,
      scope: fixtureScope(),
      proofVersion: "v4" as const,
      capabilityDeclaration: fixtureDeclaration(),
      retainedObligations: ["tax_records_7y"],
      retainedReason: POPULATED_CLAIM.retainedReason,
      retainedDataReference: POPULATED_CLAIM.retainedDataReference,
      recordStorage: fixtureRecordStorage(),
    }),
  );

  it("round-trips under the v4 tag", () => {
    expect(stored.proofVersion).toBe("v4");
    expect(stored.contentManifestSha256).toBe(V4_FIXTURE_SHA);
    expect(verifyTombstoneHashes(stored)).toEqual({ contentManifestOk: true, proofOk: true });
  });

  it("fails verification when the relation count is rewritten", () => {
    // **This is the deliverable.** Under v3 this edit was invisible: `relationCount` was on the
    // record and in neither digest, so a proof over 54 typed relations could be rewritten to claim
    // none and leave `contentManifestSha256`, `proofSha256` and the chain entry byte-identical.
    const check = verifyTombstoneHashes({
      ...stored,
      recordStorage: fixtureRecordStorage({ relationCount: 0 }),
    });
    expect(check.contentManifestOk).toBe(false);
    // The proof commits to the *stored* manifest digest, which the editor did not touch, so
    // `proofOk` stays true and `contentManifestOk` is the only thing that can say otherwise.
    expect(check.proofOk).toBe(true);
  });

  it("fails verification when the storage model is rewritten", () => {
    expect(
      verifyTombstoneHashes({ ...stored, recordStorage: DOCUMENT_ROWS_STORAGE })
        .contentManifestOk,
    ).toBe(false);
  });

  it("fails verification when the schema is moved", () => {
    expect(
      verifyTombstoneHashes({ ...stored, recordStorage: fixtureRecordStorage({ schema: "meta" }) })
        .contentManifestOk,
    ).toBe(false);
  });

  it("fails verification when the declaration is removed outright", () => {
    expect(verifyTombstoneHashes({ ...stored, recordStorage: undefined }).contentManifestOk).toBe(
      false,
    );
  });

  it("fails when relabelled to v3 with the declaration stripped", () => {
    // The relabel in its fourth form, and the one the four distinct tags defeat: the v3 subject is
    // perfectly well formed, so nothing here refuses it — the recomputed v3 digest simply cannot
    // equal a digest taken under the v4 tag.
    const downgraded: TombstoneRecord = { ...stored, proofVersion: "v3", recordStorage: undefined };
    expect(contentManifestSubjectOf(downgraded)?.proofVersion).toBe("v3");
    expect(verifyTombstoneHashes(downgraded).contentManifestOk).toBe(false);
  });

  it("fails when relabelled to v3 with the declaration left attached", () => {
    const downgraded: TombstoneRecord = { ...stored, proofVersion: "v3" };
    expect(contentManifestSubjectOf(downgraded)).toBeNull();
    expect(verifyTombstoneHashes(downgraded).contentManifestOk).toBe(false);
  });

  it("fails when relabelled to v1", () => {
    const downgraded: TombstoneRecord = {
      ...stored,
      proofVersion: "v1",
      capabilityDeclaration: undefined,
      retainedObligations: undefined,
      recordStorage: undefined,
    };
    expect(contentManifestSubjectOf(downgraded)?.proofVersion).toBe("v1");
    expect(verifyTombstoneHashes(downgraded).contentManifestOk).toBe(false);
  });

  it("gives a genuine v3 record relabelled to v4 no subject at all", () => {
    // The inverse direction. A v3 record carries no `recordStorage`, so a forged *upgrade* cannot
    // be checked against v4 bytes by accident — there is nothing to hash and nothing is hashed.
    const v3Record = TombstoneRecordSchema.parse(
      populateTombstoneHashes({
        ...FIXTURE_BASE,
        scope: fixtureScope(),
        proofVersion: "v3" as const,
        capabilityDeclaration: fixtureDeclaration(),
        retainedObligations: ["tax_records_7y"],
        retainedReason: POPULATED_CLAIM.retainedReason,
        retainedDataReference: POPULATED_CLAIM.retainedDataReference,
      }),
    );
    const upgraded: TombstoneRecord = { ...v3Record, proofVersion: "v4" };
    expect(contentManifestSubjectOf(upgraded)).toBeNull();
    expect(verifyTombstoneHashes(upgraded).contentManifestOk).toBe(false);
  });

  it("throws rather than hash a v4 record with no recordStorage", () => {
    const hash = (): unknown =>
      populateTombstoneHashes({
        ...FIXTURE_BASE,
        scope: fixtureScope(),
        proofVersion: "v4" as const,
        capabilityDeclaration: fixtureDeclaration(),
        retainedObligations: ["tax_records_7y"],
        retainedReason: POPULATED_CLAIM.retainedReason,
        retainedDataReference: POPULATED_CLAIM.retainedDataReference,
      });
    expect(hash).toThrow(/disagrees with what it carries/);
    expect(hash).toThrow(/recordStorage/);
  });

  it("leaves a forged-and-rehashed declaration to the forensic chain", () => {
    // The division of labour, unchanged from the declaration's and the claim's. An editor who
    // rewrites the record storage *and* recomputes both digests passes here, and moves
    // `proofSha256` — which the chain entry commits to (ADR-0318), so it is caught there.
    const forged = TombstoneRecordSchema.parse(
      populateTombstoneHashes({
        ...stored,
        recordStorage: fixtureRecordStorage({ relationCount: 0 }),
      }),
    );
    expect(verifyTombstoneHashes(forged)).toEqual({ contentManifestOk: true, proofOk: true });
    expect(forged.proofSha256).not.toBe(stored.proofSha256);
  });
});

describe("the proof domain tag is unchanged by v4", () => {
  it("produces the derived digest over a v4 content manifest", () => {
    // Derived by the same independent model that reproduced `PROOF_OVER_V1_CONTENT`,
    // `PROOF_OVER_V2_CONTENT` and `PROOF_OVER_V3_CONTENT` above, under
    // `crossengin.tombstone.proof.v1` — so a fourth content tag moved the content digest and left
    // the proof function where it is, which is the argument all four content tags rest on.
    expect(computeProofSha256({ ...FIXTURE_BASE, contentManifestSha256: V4_FIXTURE_SHA })).toBe(
      PROOF_OVER_V4_CONTENT,
    );
  });

  it("gives the four versions four different proof digests for one scope", () => {
    expect(
      new Set(
        [V1_FIXTURE_SHA, V2_FIXTURE_SHA, V3_FIXTURE_SHA, V4_FIXTURE_SHA].map((contentSha) =>
          computeProofSha256({ ...FIXTURE_BASE, contentManifestSha256: contentSha }),
        ),
      ).size,
    ).toBe(4);
  });
});
