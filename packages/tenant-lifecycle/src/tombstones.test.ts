import { describe, expect, it } from "vitest";
import { CONSERVATIVE_DELETION_CAPABILITIES } from "./tombstone-assembly.js";
import {
  ANCHOR_KINDS,
  DECLARATION_BEARING_PROOF_VERSIONS,
  PROOF_VERSION_COVERAGE,
  RECORD_STORAGE_BEARING_PROOF_VERSIONS,
  RECORD_STORAGE_MODELS,
  RETENTION_BEARING_PROOF_VERSIONS,
  TOMBSTONE_KINDS,
  TOMBSTONE_PROOF_VERSIONS,
  TombstoneCapabilityDeclarationSchema,
  TombstoneRecordSchema,
  TombstoneRecordStorageDeclarationSchema,
  asCapabilityDeclaration,
  asDeletionCapabilities,
  isCryptographicallyAnchored,
  proofVersionCoversDeclaration,
  proofVersionCoversRecordStorage,
  proofVersionCoversRetentionClaim,
  readDeclaredAbsences,
  readRecordStorage,
  readRetentionClaim,
  tombstoneAge,
  tombstoneChainFor,
  tombstonesByKind,
  type RecordStorageModel,
  type TombstoneCapabilityDeclaration,
  type TombstoneProofVersion,
  type TombstoneRecord,
  type TombstoneRecordStorageDeclaration,
} from "./tombstones.js";

const SHA = "a".repeat(64);

const DECLARATION: TombstoneCapabilityDeclaration = {
  tenant_schema: "erases",
  shared_tables: "erases",
  object_storage: "absent",
  backups: "absent",
  search_indexes: "retains",
  caches: "absent",
};

const RECORD_STORAGE: TombstoneRecordStorageDeclaration = {
  model: "typed_tables",
  schema: "public",
  relationCount: 54,
};

const coversNothing = (version: TombstoneProofVersion): boolean =>
  Object.values(PROOF_VERSION_COVERAGE[version]).every((covered) => !covered);

/**
 * The accepting shape for one storage model, branched on the single rule the schema enforces, so a
 * fourth model is exercised by the loop below rather than silently untested.
 */
const canonicalRecordStorage = (
  model: RecordStorageModel,
): TombstoneRecordStorageDeclaration =>
  model === "typed_tables"
    ? { model, schema: "public", relationCount: 54 }
    : { model, schema: null, relationCount: 0 };

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

  it("TOMBSTONE_PROOF_VERSIONS is v1 then v2 then v3 then v4", () => {
    expect(TOMBSTONE_PROOF_VERSIONS).toEqual(["v1", "v2", "v3", "v4"]);
  });

  it("names which versions carry the declaration, the retention claim and the storage", () => {
    expect(DECLARATION_BEARING_PROOF_VERSIONS).toEqual(["v2", "v3", "v4"]);
    expect(RETENTION_BEARING_PROOF_VERSIONS).toEqual(["v3", "v4"]);
    expect(RECORD_STORAGE_BEARING_PROOF_VERSIONS).toEqual(["v4"]);
  });

  it("gives every proof version but v1 bytes that carry something", () => {
    // The fence the predecessor of this test claimed to be and was not: it asserted that the
    // predicates return a boolean, which is true of every input, so adding "v4" to the enum and
    // nothing else passed it while producing a tag that covered nothing. An exact set rather than a
    // count, so flipping v1 fails here too. Read off `Object.values`, so a fifth *layer* added to
    // the map is fenced without this assertion being touched.
    expect(TOMBSTONE_PROOF_VERSIONS.filter(coversNothing)).toEqual(["v1"]);
  });

  it("layers the three declarations, so no version's bytes have a hole in the middle", () => {
    for (const version of TOMBSTONE_PROOF_VERSIONS) {
      const coverage = PROOF_VERSION_COVERAGE[version];
      // Each tag's body is the previous body plus one key. A tag covering a later layer and not an
      // earlier one would sign bytes with a gap, and the readings would disagree about it: a proof
      // signing a retention claim would read as having no declaration in its bytes at all.
      if (coverage.retentionClaim) {
        expect(coverage.declaration, version).toBe(true);
      }
      if (coverage.recordStorage) {
        expect(coverage.retentionClaim, version).toBe(true);
      }
    }
  });

  it("answers for every proof version and for no version that does not exist", () => {
    // Both directions, because only one of them is compile-enforced: the `Record` annotation makes
    // a missing key a type error, while `Object.freeze` hands back a value rather than a fresh
    // literal, so excess-property checking never fires and a stale key typechecks.
    const declared = new Set<string>(TOMBSTONE_PROOF_VERSIONS);
    expect(TOMBSTONE_PROOF_VERSIONS.filter((v) => !(v in PROOF_VERSION_COVERAGE))).toEqual([]);
    expect(Object.keys(PROOF_VERSION_COVERAGE).filter((k) => !declared.has(k))).toEqual([]);
  });

  it("derives the three membership arrays from the map, so a reader cannot drift from it", () => {
    expect([...DECLARATION_BEARING_PROOF_VERSIONS]).toEqual(
      TOMBSTONE_PROOF_VERSIONS.filter((v) => PROOF_VERSION_COVERAGE[v].declaration),
    );
    expect([...RETENTION_BEARING_PROOF_VERSIONS]).toEqual(
      TOMBSTONE_PROOF_VERSIONS.filter((v) => PROOF_VERSION_COVERAGE[v].retentionClaim),
    );
    expect([...RECORD_STORAGE_BEARING_PROOF_VERSIONS]).toEqual(
      TOMBSTONE_PROOF_VERSIONS.filter((v) => PROOF_VERSION_COVERAGE[v].recordStorage),
    );
  });

  it("agrees with its own three predicates and three arrays for every version", () => {
    for (const version of TOMBSTONE_PROOF_VERSIONS) {
      const coverage = PROOF_VERSION_COVERAGE[version];
      expect(proofVersionCoversDeclaration(version), version).toBe(coverage.declaration);
      expect(proofVersionCoversRetentionClaim(version), version).toBe(coverage.retentionClaim);
      expect(proofVersionCoversRecordStorage(version), version).toBe(coverage.recordStorage);
      expect(DECLARATION_BEARING_PROOF_VERSIONS.includes(version), version).toBe(
        coverage.declaration,
      );
      expect(RETENTION_BEARING_PROOF_VERSIONS.includes(version), version).toBe(
        coverage.retentionClaim,
      );
      expect(RECORD_STORAGE_BEARING_PROOF_VERSIONS.includes(version), version).toBe(
        coverage.recordStorage,
      );
    }
  });

  it("is frozen, so a reader cannot be handed a map taught a coverage it does not have", () => {
    expect(Object.isFrozen(PROOF_VERSION_COVERAGE)).toBe(true);
    for (const list of [
      DECLARATION_BEARING_PROOF_VERSIONS,
      RETENTION_BEARING_PROOF_VERSIONS,
      RECORD_STORAGE_BEARING_PROOF_VERSIONS,
    ]) {
      expect(Object.isFrozen(list)).toBe(true);
    }
  });
});

describe("TombstoneCapabilityDeclarationSchema", () => {
  it("accepts a total declaration", () => {
    expect(() => TombstoneCapabilityDeclarationSchema.parse(DECLARATION)).not.toThrow();
  });

  it("rejects a declaration missing a subsystem", () => {
    const partial: Record<string, unknown> = { ...DECLARATION };
    delete partial["caches"];
    expect(() => TombstoneCapabilityDeclarationSchema.parse(partial)).toThrow();
  });

  it("rejects an unknown disposition", () => {
    expect(() =>
      TombstoneCapabilityDeclarationSchema.parse({ ...DECLARATION, backups: "maybe" }),
    ).toThrow();
  });

  it("rejects an unknown subsystem key (strict)", () => {
    expect(() =>
      TombstoneCapabilityDeclarationSchema.parse({ ...DECLARATION, blob_storage: "absent" }),
    ).toThrow();
  });

  it("round-trips the configuration type it is pinned to", () => {
    // The two casts-that-are-not-casts: a subsystem or a disposition added, removed or renamed in
    // `tombstone-assembly.ts` fails `typecheck` on these signatures rather than drifting into a proof.
    const declaration = asCapabilityDeclaration(CONSERVATIVE_DELETION_CAPABILITIES);
    expect(TombstoneCapabilityDeclarationSchema.parse(declaration)).toEqual(
      CONSERVATIVE_DELETION_CAPABILITIES,
    );
    expect(asDeletionCapabilities(declaration)).toEqual(CONSERVATIVE_DELETION_CAPABILITIES);
  });
});

describe("TombstoneRecordStorageDeclarationSchema", () => {
  it("accepts typed relations with a schema and a count", () => {
    expect(TombstoneRecordStorageDeclarationSchema.parse(RECORD_STORAGE)).toEqual(RECORD_STORAGE);
  });

  it("accepts typed relations with a count of zero", () => {
    // The third case the version exists to express, and not a placeholder: a column store serving a
    // manifest that declares no entity. Legitimate where every tenant activates its own manifest,
    // and the signature of the wrong pack having loaded otherwise — which is precisely what a
    // reader of a stored proof could not tell from a deployment holding no typed relations at all.
    const parsed = TombstoneRecordStorageDeclarationSchema.parse({
      model: "typed_tables",
      schema: "public",
      relationCount: 0,
    });
    expect(parsed.relationCount).toBe(0);
  });

  it("refuses typed relations that do not say which schema they are in", () => {
    const r = TombstoneRecordStorageDeclarationSchema.safeParse({
      model: "typed_tables",
      schema: null,
      relationCount: 54,
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues[0]?.path).toEqual(["schema"]);
    expect(r.error.issues[0]?.message).toContain("cannot be cross-checked");
  });

  it("accepts the two models that have no typed relations", () => {
    for (const model of ["document_rows", "no_durable_store"] as const) {
      const r = TombstoneRecordStorageDeclarationSchema.safeParse({
        model,
        schema: null,
        relationCount: 0,
      });
      expect(r.success, model).toBe(true);
    }
  });

  it("refuses a model with no typed relations naming a schema for them", () => {
    const r = TombstoneRecordStorageDeclarationSchema.safeParse({
      model: "document_rows",
      schema: "meta",
      relationCount: 0,
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues[0]?.path).toEqual(["schema"]);
    expect(r.error.issues[0]?.message).toContain("no typed per-entity relations");
  });

  it("refuses a model with no typed relations counting some", () => {
    const r = TombstoneRecordStorageDeclarationSchema.safeParse({
      model: "document_rows",
      schema: null,
      relationCount: 2,
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues[0]?.path).toEqual(["relationCount"]);
    expect(r.error.issues[0]?.message).toContain("the count must be 0 (got 2)");
  });

  it("reports both contradictions when both are present", () => {
    // Two issues and not one: the refinement does not return after the first, so an operator
    // reading the refusal is told everything the declaration disagrees with itself about rather
    // than being sent back for a second parse to find the rest.
    const r = TombstoneRecordStorageDeclarationSchema.safeParse({
      model: "no_durable_store",
      schema: "public",
      relationCount: 3,
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues.map((i) => i.path)).toEqual([["schema"], ["relationCount"]]);
  });

  it("rejects an unknown model", () => {
    expect(
      TombstoneRecordStorageDeclarationSchema.safeParse({
        model: "parquet_files",
        schema: null,
        relationCount: 0,
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown key (strict)", () => {
    expect(
      TombstoneRecordStorageDeclarationSchema.safeParse({
        ...RECORD_STORAGE,
        rowCount: 10,
      }).success,
    ).toBe(false);
  });

  it("rejects a negative or fractional relationCount", () => {
    for (const relationCount of [-1, 2.5]) {
      expect(
        TombstoneRecordStorageDeclarationSchema.safeParse({ ...RECORD_STORAGE, relationCount })
          .success,
        relationCount.toString(),
      ).toBe(false);
    }
  });

  it("answers for every model, so a fourth is exercised rather than silently untested", () => {
    for (const model of RECORD_STORAGE_MODELS) {
      const canonical = canonicalRecordStorage(model);
      expect(
        TombstoneRecordStorageDeclarationSchema.safeParse(canonical).success,
        model,
      ).toBe(true);
      // Whatever a fourth model's own rule turns out to be, this pair has to stay refused for it
      // until somebody decides otherwise here: a signed claim must not name typed relations and a
      // schema for them while declaring a model that has none.
      expect(
        TombstoneRecordStorageDeclarationSchema.safeParse({
          ...canonical,
          schema: "public",
          relationCount: 7,
        }).success,
        model,
      ).toBe(model === "typed_tables");
    }
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
    proofVersion: "v1",
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

  it("defaults proofVersion to v1 for a row written before ADR-0329", () => {
    const parsed = TombstoneRecordSchema.parse(base);
    expect(parsed.proofVersion).toBe("v1");
    expect(parsed.capabilityDeclaration).toBeUndefined();
  });

  it("accepts a v2 record carrying its declaration", () => {
    const parsed = TombstoneRecordSchema.parse({
      ...base,
      proofVersion: "v2",
      capabilityDeclaration: DECLARATION,
    });
    expect(parsed.capabilityDeclaration?.object_storage).toBe("absent");
  });

  it("rejects proofVersion v2 with no declaration", () => {
    expect(() =>
      TombstoneRecordSchema.parse({ ...base, proofVersion: "v2" }),
    ).toThrow(/commits to a capabilityDeclaration/);
  });

  it("rejects a declaration on a v1 record (it would be outside the signed bytes)", () => {
    expect(() =>
      TombstoneRecordSchema.parse({ ...base, capabilityDeclaration: DECLARATION }),
    ).toThrow(/outside the signed bytes/);
  });

  const v3 = {
    ...base,
    proofVersion: "v3" as const,
    capabilityDeclaration: DECLARATION,
    retainedObligations: [] as readonly string[],
  };

  it("accepts a v3 record whose retention claim is empty", () => {
    const parsed = TombstoneRecordSchema.parse(v3);
    expect(parsed.proofVersion).toBe("v3");
    expect(parsed.retainedObligations).toEqual([]);
    expect(parsed.retainedReason).toBeUndefined();
  });

  it("accepts a v3 record carrying obligations, a reason and a reference together", () => {
    const parsed = TombstoneRecordSchema.parse({
      ...v3,
      retainedObligations: ["tax_records_7y"],
      retainedReason: "retained under legal obligation — backups: tax_records_7y",
      retainedDataReference: "backup-vault://2026",
    });
    expect(parsed.retainedObligations).toEqual(["tax_records_7y"]);
  });

  it("rejects a v3 record carrying no obligations field at all", () => {
    const { retainedObligations: _dropped, ...withoutObligations } = v3;
    expect(() => TombstoneRecordSchema.parse(withoutObligations)).toThrow(
      /commits to a retention claim/,
    );
  });

  it("still requires the declaration on a v3 record", () => {
    const { capabilityDeclaration: _dropped, ...withoutDeclaration } = v3;
    expect(() => TombstoneRecordSchema.parse(withoutDeclaration)).toThrow(
      /commits to a capabilityDeclaration/,
    );
  });

  it("rejects obligations on a v2 record (outside the v2 signed bytes)", () => {
    expect(() =>
      TombstoneRecordSchema.parse({
        ...base,
        proofVersion: "v2",
        capabilityDeclaration: DECLARATION,
        retainedObligations: ["tax_records_7y"],
      }),
    ).toThrow(/outside the signed bytes/);
  });

  it("rejects obligations on a v1 record", () => {
    expect(() =>
      TombstoneRecordSchema.parse({ ...base, retainedObligations: ["tax_records_7y"] }),
    ).toThrow(/outside the signed bytes/);
  });

  it("rejects 'none' inside a signed retention claim", () => {
    expect(() =>
      TombstoneRecordSchema.parse({
        ...v3,
        retainedObligations: ["none"],
        retainedReason: "kept for no reason",
        retainedDataReference: "nowhere",
      }),
    ).toThrow(/'none' is not an obligation/);
  });

  it("rejects obligations with no retainedReason beside them", () => {
    expect(() =>
      TombstoneRecordSchema.parse({
        ...v3,
        retainedObligations: ["tax_records_7y"],
        retainedDataReference: "backup-vault://2026",
      }),
    ).toThrow(/names obligations and a retainedReason together/);
  });

  it("rejects a retainedReason with no obligations beside it on a v3 record", () => {
    expect(() =>
      TombstoneRecordSchema.parse({
        ...v3,
        retainedReason: "retained, somehow",
        retainedDataReference: "backup-vault://2026",
      }),
    ).toThrow(/names obligations and a retainedReason together/);
  });

  it("rejects an empty signed claim that nevertheless locates retained data", () => {
    expect(() =>
      TombstoneRecordSchema.parse({ ...v3, retainedDataReference: "backup-vault://2026" }),
    ).toThrow(/cannot locate retained data/);
  });

  it("still permits unsigned retention prose on a v1 record", () => {
    // The compatibility half: every stored v1 and v2 record carrying retention prose outside its
    // bytes must keep parsing. Tightening this would refuse honest records retroactively.
    const parsed = TombstoneRecordSchema.parse({
      ...base,
      retainedReason: "retained under legal obligation — backups: tax_records_7y",
      retainedDataReference: "backup-vault://2026",
    });
    expect(parsed.retainedObligations).toBeUndefined();
  });

  /**
   * An otherwise-valid record at one version: every declaration that version's bytes cover, and no
   * other. Read off the coverage map, so a fifth version arrives here needing a decision rather
   * than taking whichever shape the previous one happened to have.
   */
  const recordFor = (version: TombstoneProofVersion): TombstoneRecord => ({
    ...base,
    proofVersion: version,
    ...(proofVersionCoversDeclaration(version) ? { capabilityDeclaration: DECLARATION } : {}),
    ...(proofVersionCoversRetentionClaim(version) ? { retainedObligations: [] } : {}),
    ...(proofVersionCoversRecordStorage(version) ? { recordStorage: RECORD_STORAGE } : {}),
  });

  const v4 = recordFor("v4");

  it("accepts a v4 record carrying its record-storage declaration", () => {
    const parsed = TombstoneRecordSchema.parse(v4);
    expect(parsed.proofVersion).toBe("v4");
    expect(parsed.recordStorage).toEqual(RECORD_STORAGE);
  });

  it("accepts the canonical record at every proof version", () => {
    // Nothing else asserts that a version's coverage and its pairing refinements are jointly
    // satisfiable. A tag the two disagree about would have no valid record at all, and from a
    // caller's side that reads the same as the omission the coverage map prevents.
    for (const version of TOMBSTONE_PROOF_VERSIONS) {
      expect(TombstoneRecordSchema.safeParse(recordFor(version)).success, version).toBe(true);
    }
  });

  it("rejects a v4 record carrying no record-storage declaration", () => {
    const { recordStorage: _dropped, ...withoutStorage } = v4;
    const r = TombstoneRecordSchema.safeParse(withoutStorage);
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues[0]?.path).toEqual(["recordStorage"]);
    expect(r.error.issues[0]?.message).toContain(
      "the digest covers a claim the record does not carry",
    );
  });

  it("rejects a record-storage declaration on every version whose bytes omit it", () => {
    for (const version of TOMBSTONE_PROOF_VERSIONS.filter(
      (v) => !proofVersionCoversRecordStorage(v),
    )) {
      const r = TombstoneRecordSchema.safeParse({
        ...recordFor(version),
        recordStorage: RECORD_STORAGE,
      });
      expect(r.success, version).toBe(false);
      if (r.success) continue;
      expect(r.error.issues[0]?.path, version).toEqual(["proofVersion"]);
      expect(r.error.issues[0]?.message, version).toContain("declare proofVersion 'v4'");
    }
  });

  it("still requires the declaration and the obligations on a v4 record", () => {
    // The regression the coverage map prevents, from the other side: with "v4" in the enum and in
    // neither of the old membership lists, these two refusals did not merely stop firing — they
    // inverted, and a correct v4 record was refused for carrying a declaration and obligations
    // "outside the signed bytes".
    const { capabilityDeclaration: _noDeclaration, ...withoutDeclaration } = v4;
    expect(() => TombstoneRecordSchema.parse(withoutDeclaration)).toThrow(
      /commits to a capabilityDeclaration/,
    );
    const { retainedObligations: _noObligations, ...withoutObligations } = v4;
    expect(() => TombstoneRecordSchema.parse(withoutObligations)).toThrow(
      /commits to a retention claim/,
    );
  });

  it("refuses a contradictory record-storage declaration on the record itself", () => {
    // The declaration's own refinement has to survive being wrapped in `.optional()` here, or the
    // record would be the one place a contradiction could reach a signed claim.
    const r = TombstoneRecordSchema.safeParse({
      ...v4,
      recordStorage: { model: "document_rows", schema: "meta", relationCount: 0 },
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues[0]?.path).toEqual(["recordStorage", "schema"]);
  });
});

describe("readDeclaredAbsences", () => {
  const base: TombstoneRecord = {
    id: "tomb_abc12345abc12345",
    kind: "tenant_deletion",
    tenantId: "t-1",
    deletedAt: "2026-05-14T10:00:00Z",
    executedBy: "u-executor",
    approvedBy: "u-approver",
    proofVersion: "v1",
    scope: {
      schemas: ["tenant_t1"],
      tables: ["tenant_t1.users"],
      objectStorageBuckets: [],
      backupGenerations: [],
      searchIndexes: [],
      cacheKeys: [],
      rowCount: 100,
      storageBytes: 1000,
      fileCount: 0,
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

  it("answers 'unknown', never 'none', for a v1 record", () => {
    // The crux of ADR-0329. A v1 record's bytes say nothing about any declaration, so there is
    // deliberately no `absentSubsystems` on this reading at all — no empty array for a caller to read
    // as "this deployment holds all six". "We have no object storage" and "nobody asked" are the two
    // facts ADR-0317 is about, and a v1 proof carries neither.
    const reading = readDeclaredAbsences(base);
    expect(reading.declarationState).toBe("unknown_not_in_proof");
    expect(reading).not.toHaveProperty("absentSubsystems");
    if (reading.declarationState === "unknown_not_in_proof") {
      expect(reading.reason).toBe("v1_proof");
    }
  });

  it("lists the declared absences, sorted, for a v2 record", () => {
    const reading = readDeclaredAbsences({
      ...base,
      proofVersion: "v2",
      capabilityDeclaration: DECLARATION,
    });
    expect(reading.declarationState).toBe("covered_by_proof");
    if (reading.declarationState === "covered_by_proof") {
      expect(reading.absentSubsystems).toEqual(["backups", "caches", "object_storage"]);
      expect(reading.declaration).toEqual(DECLARATION);
    }
  });

  it("distinguishes a signed 'nothing is absent' from 'unknown'", () => {
    const reading = readDeclaredAbsences({
      ...base,
      proofVersion: "v2",
      capabilityDeclaration: CONSERVATIVE_DELETION_CAPABILITIES,
    });
    expect(reading.declarationState).toBe("covered_by_proof");
    if (reading.declarationState === "covered_by_proof") {
      expect(reading.absentSubsystems).toEqual([]);
    }
  });

  it("refuses to read a declaration off a record labelled v2 without one", () => {
    // Only reachable by constructing the record past the schema, but the reading must not invent
    // coverage from a field that is not there.
    const reading = readDeclaredAbsences({ ...base, proofVersion: "v2" });
    expect(reading.declarationState).toBe("unknown_not_in_proof");
    if (reading.declarationState === "unknown_not_in_proof") {
      expect(reading.reason).toBe("declaration_missing");
    }
  });

  it("reads the declaration off a v3 record too", () => {
    // The near-miss ADR-0331 had to avoid: this function tested `proofVersion !== "v2"` literally, so
    // a v3 proof — which carries the declaration inside its bytes — would have read as having none.
    const reading = readDeclaredAbsences({
      ...base,
      proofVersion: "v3",
      capabilityDeclaration: DECLARATION,
      retainedObligations: [],
    });
    expect(reading.declarationState).toBe("covered_by_proof");
    if (reading.declarationState === "covered_by_proof") {
      expect(reading.absentSubsystems).toEqual(["backups", "caches", "object_storage"]);
    }
  });

  it("reads the declaration off a v4 record too", () => {
    // ADR-0331's near-miss, repeated as a live regression one version later: with "v4" added to the
    // enum and to neither membership list, this answered `v1_proof` for a proof that signs the
    // declaration. The coverage map is what makes that a compile error instead.
    const reading = readDeclaredAbsences({
      ...base,
      proofVersion: "v4",
      capabilityDeclaration: DECLARATION,
      retainedObligations: [],
      recordStorage: RECORD_STORAGE,
    });
    expect(reading.declarationState).toBe("covered_by_proof");
    if (reading.declarationState === "covered_by_proof") {
      expect(reading.absentSubsystems).toEqual(["backups", "caches", "object_storage"]);
      expect(reading.declaration).toEqual(DECLARATION);
    }
  });
});

describe("readRetentionClaim", () => {
  const base: TombstoneRecord = {
    id: "tomb_abc12345abc12345",
    kind: "tenant_deletion",
    tenantId: "t-1",
    deletedAt: "2026-05-14T10:00:00Z",
    executedBy: "u-executor",
    approvedBy: "u-approver",
    proofVersion: "v1",
    scope: {
      schemas: ["tenant_t1"],
      tables: ["tenant_t1.users"],
      objectStorageBuckets: [],
      backupGenerations: [],
      searchIndexes: [],
      cacheKeys: [],
      rowCount: 100,
      storageBytes: 1000,
      fileCount: 0,
    },
    contentManifestSha256: SHA,
    proofSha256: SHA,
    anchors: [
      { kind: "internal_audit_log", reference: "audit-1", anchoredAt: "2026-05-14T10:00:00Z" },
    ],
    invalidationOfPriorTombstoneId: null,
  };

  it("answers 'unknown', never 'nothing retained', for a v1 record", () => {
    const reading = readRetentionClaim(base);
    expect(reading.claimState).toBe("unknown_not_in_proof");
    expect(reading).not.toHaveProperty("obligations");
    if (reading.claimState === "unknown_not_in_proof") {
      expect(reading.reason).toBe("pre_v3_proof");
    }
  });

  it("answers 'unknown' for a v2 record even when it carries retention prose", () => {
    // The distinction ADR-0331 buys. This record *says* data was kept; its bytes do not, so the
    // prose is a claim on the record's face and not part of the proof.
    const reading = readRetentionClaim({
      ...base,
      proofVersion: "v2",
      capabilityDeclaration: DECLARATION,
      retainedReason: "retained under legal obligation — backups: tax_records_7y",
      retainedDataReference: "backup-vault://2026",
    });
    expect(reading.claimState).toBe("unknown_not_in_proof");
    if (reading.claimState === "unknown_not_in_proof") {
      expect(reading.reason).toBe("pre_v3_proof");
    }
  });

  it("carries the signed claim for a v3 record", () => {
    const reading = readRetentionClaim({
      ...base,
      proofVersion: "v3",
      capabilityDeclaration: DECLARATION,
      retainedObligations: ["tax_records_7y", "audit_logs_3y"],
      retainedReason: "retained under legal obligation — backups: tax_records_7y",
      retainedDataReference: "backup-vault://2026",
    });
    expect(reading.claimState).toBe("covered_by_proof");
    if (reading.claimState === "covered_by_proof") {
      expect(reading.obligations).toEqual(["audit_logs_3y", "tax_records_7y"]);
      expect(reading.retainedDataReference).toBe("backup-vault://2026");
    }
  });

  it("distinguishes a signed 'nothing was retained' from 'unknown'", () => {
    const reading = readRetentionClaim({
      ...base,
      proofVersion: "v3",
      capabilityDeclaration: DECLARATION,
      retainedObligations: [],
    });
    expect(reading.claimState).toBe("covered_by_proof");
    if (reading.claimState === "covered_by_proof") {
      expect(reading.obligations).toEqual([]);
      expect(reading.retainedReason).toBeNull();
      expect(reading.retainedDataReference).toBeNull();
    }
  });

  it("refuses to read a claim off a record labelled v3 without one", () => {
    const reading = readRetentionClaim({
      ...base,
      proofVersion: "v3",
      capabilityDeclaration: DECLARATION,
    });
    expect(reading.claimState).toBe("unknown_not_in_proof");
    if (reading.claimState === "unknown_not_in_proof") {
      // Not `pre_v3_proof`: calling a v3 record an older one is the self-downgrading misreading the
      // explicit version field exists to prevent.
      expect(reading.reason).toBe("obligations_missing");
    }
  });

  it("carries the signed claim for a v4 record too", () => {
    // The other half of the regression the coverage map prevents: a v4 proof signs the retention
    // claim, and a v4 outside `RETENTION_BEARING_PROOF_VERSIONS` read `pre_v4_proof`'s predecessor
    // — a proof reporting that it cannot say what it in fact signed.
    const reading = readRetentionClaim({
      ...base,
      proofVersion: "v4",
      capabilityDeclaration: DECLARATION,
      retainedObligations: ["tax_records_7y"],
      retainedReason: "retained under legal obligation — backups: tax_records_7y",
      retainedDataReference: "backup-vault://2026",
      recordStorage: RECORD_STORAGE,
    });
    expect(reading.claimState).toBe("covered_by_proof");
    if (reading.claimState === "covered_by_proof") {
      expect(reading.obligations).toEqual(["tax_records_7y"]);
      expect(reading.retainedDataReference).toBe("backup-vault://2026");
    }
  });
});

describe("readRecordStorage", () => {
  const base: TombstoneRecord = {
    id: "tomb_abc12345abc12345",
    kind: "tenant_deletion",
    tenantId: "t-1",
    deletedAt: "2026-05-14T10:00:00Z",
    executedBy: "u-executor",
    approvedBy: "u-approver",
    proofVersion: "v1",
    scope: {
      schemas: ["tenant_t1"],
      tables: ["tenant_t1.users"],
      objectStorageBuckets: [],
      backupGenerations: [],
      searchIndexes: [],
      cacheKeys: [],
      rowCount: 100,
      storageBytes: 1000,
      fileCount: 0,
    },
    contentManifestSha256: SHA,
    proofSha256: SHA,
    anchors: [
      { kind: "internal_audit_log", reference: "audit-1", anchoredAt: "2026-05-14T10:00:00Z" },
    ],
    invalidationOfPriorTombstoneId: null,
  };

  const v4: TombstoneRecord = {
    ...base,
    proofVersion: "v4",
    capabilityDeclaration: DECLARATION,
    retainedObligations: [],
  };

  it("carries the signed declaration for a v4 record", () => {
    const reading = readRecordStorage({ ...v4, recordStorage: RECORD_STORAGE });
    expect(reading.declarationState).toBe("covered_by_proof");
    if (reading.declarationState === "covered_by_proof") {
      expect(reading.recordStorage).toEqual(RECORD_STORAGE);
    }
  });

  it("distinguishes a signed 'no typed relations' from 'unknown'", () => {
    // The whole point of the version: ADR-0350's two deployments compose byte-identical scopes, so
    // only a declaration separates "the records are catalogued document rows, and the scope's
    // silence about typed relations is correct" from "we had 54 and the proof cannot say".
    const reading = readRecordStorage({
      ...v4,
      recordStorage: { model: "document_rows", schema: null, relationCount: 0 },
    });
    expect(reading.declarationState).toBe("covered_by_proof");
    if (reading.declarationState === "covered_by_proof") {
      expect(reading.recordStorage.model).toBe("document_rows");
      expect(reading.recordStorage.relationCount).toBe(0);
    }
  });

  it("answers 'unknown' for every version whose bytes omit the declaration", () => {
    for (const version of TOMBSTONE_PROOF_VERSIONS.filter(
      (v) => !proofVersionCoversRecordStorage(v),
    )) {
      const reading = readRecordStorage({ ...base, proofVersion: version });
      expect(reading.declarationState, version).toBe("unknown_not_in_proof");
      if (reading.declarationState === "unknown_not_in_proof") {
        expect(reading.reason, version).toBe("pre_v4_proof");
      }
    }
  });

  it("refuses to read a declaration off a record labelled v4 without one", () => {
    // Only reachable past the schema. Its own reason rather than `pre_v4_proof`: calling a v4
    // record an older one is the self-downgrading misreading the explicit version field prevents.
    const reading = readRecordStorage(v4);
    expect(reading.declarationState).toBe("unknown_not_in_proof");
    if (reading.declarationState === "unknown_not_in_proof") {
      expect(reading.reason).toBe("record_storage_missing");
    }
  });

  it("never carries a default declaration on either unknown arm", () => {
    // Inventing `document_rows` here would assert that no typed relations existed — exactly the
    // claim ADR-0350's gap made unavailable, and the one a reader must not be handed for free.
    for (const reading of [readRecordStorage(base), readRecordStorage(v4)]) {
      expect(reading.declarationState).toBe("unknown_not_in_proof");
      expect(reading).not.toHaveProperty("recordStorage");
    }
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
    proofVersion: "v1",
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
