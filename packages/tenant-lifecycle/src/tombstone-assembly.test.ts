import { describe, expect, it } from "vitest";

import {
  ASSEMBLY_REFUSAL_REASONS,
  ATTESTATION_OUTCOMES,
  CONSERVATIVE_DELETION_CAPABILITIES,
  DELETION_SUBSYSTEMS,
  DeletionAttestationSchema,
  DeletionCapabilitiesSchema,
  EMPTY_DELETION_SCOPE,
  RETENTION_BEARING_OUTCOMES,
  SCOPE_BEARING_OUTCOMES,
  SUBSYSTEM_DISPOSITIONS,
  SUBSYSTEM_SCOPE_FIELDS,
  absentSubsystemsFor,
  assembleTombstone,
  attestationRetainedObligations,
  composeDeletionScope,
  requiredSubsystemsFor,
  retainedObligations,
  tombstoneMatchesAttestations,
  type AssemblyRefusalReason,
  type DeletionAttestation,
  type DeletionCapabilities,
  type DeletionSubsystem,
  type TombstoneAssemblyInput,
} from "./tombstone-assembly.js";
import {
  canonicalContentManifest,
  canonicalContentManifestV3,
  canonicalContentManifestV4,
  computeContentManifestSha256,
  computeContentManifestSha256V2,
  computeContentManifestSha256V3,
  computeContentManifestSha256V4,
  computeProofSha256,
  verifyTombstoneHashes,
} from "./tombstone-proof.js";
import {
  asCapabilityDeclaration,
  readDeclaredAbsences,
  readRecordStorage,
  readRetentionClaim,
  type TombstoneAnchor,
  type TombstoneRecordStorageDeclaration,
} from "./tombstones.js";

const TENANT = "3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8";
const ALICE = "alice@example.test";
const BOB = "bob@example.test";
const AT = "2026-10-03T12:00:00.000Z";

const ANCHOR: TombstoneAnchor = {
  kind: "internal_audit_log",
  reference: "audit:seq:4821",
  anchoredAt: AT,
};

function attest(over: Partial<DeletionAttestation> = {}): DeletionAttestation {
  return {
    subsystem: "tenant_schema",
    outcome: "erased",
    scope: { schemas: ["t_abc"], tables: ["t_abc.invoice"], rowCount: 26, storageBytes: 65536 },
    attestedBy: "operate-server/tenant-erasure",
    attestedAt: AT,
    ...over,
  } as DeletionAttestation;
}

function inputOf(over: Partial<TombstoneAssemblyInput> = {}): TombstoneAssemblyInput {
  return {
    id: "tomb_abcdefgh1234",
    kind: "tenant_deletion",
    tenantId: TENANT,
    deletedAt: AT,
    executedBy: ALICE,
    approvedBy: BOB,
    anchors: [ANCHOR],
    requiredSubsystems: ["tenant_schema"],
    attestations: [attest()],
    ...over,
  };
}

/** The reasons ADR-0351 added, named once so the reachability test cannot drift from the enum. */
const RECORD_STORAGE_REFUSALS: readonly AssemblyRefusalReason[] = [
  "record_storage_undeclared",
  "record_storage_outside_proof",
  "record_storage_invalid",
];

/** The reasons an input was refused for, or `[]` if it assembled. */
function refusalsOf(input: TombstoneAssemblyInput): readonly AssemblyRefusalReason[] {
  const out = assembleTombstone(input);
  return out.ok ? [] : out.refusals.map((r) => r.reason);
}

describe("the vocabulary", () => {
  it("gives every subsystem an exclusive set of scope fields", () => {
    for (const s of DELETION_SUBSYSTEMS) {
      expect(SUBSYSTEM_SCOPE_FIELDS[s].length, s).toBeGreaterThan(0);
    }
    // `schemas` has exactly one owner, so a scope's schema list has one provenance.
    const owners = DELETION_SUBSYSTEMS.filter((s) => SUBSYSTEM_SCOPE_FIELDS[s].includes("schemas"));
    expect(owners).toEqual(["tenant_schema"]);
  });

  it("declares four outcomes, three dispositions and fifteen refusal reasons", () => {
    expect([...ATTESTATION_OUTCOMES]).toEqual([
      "erased",
      "nothing_to_erase",
      "retained",
      "erased_and_retained",
    ]);
    expect([...SUBSYSTEM_DISPOSITIONS]).toEqual(["erases", "retains", "absent"]);
    expect(ASSEMBLY_REFUSAL_REASONS).toHaveLength(15);
  });

  it("names every refusal reason once", () => {
    // A duplicated member makes the length assertion above pass while one reason is unreachable by
    // name, which is the shape of a copy-paste when a version adds three at a time.
    expect(new Set(ASSEMBLY_REFUSAL_REASONS).size).toBe(ASSEMBLY_REFUSAL_REASONS.length);
  });

  it("declares the three record-storage refusals ADR-0351 added", () => {
    for (const reason of RECORD_STORAGE_REFUSALS) {
      expect(ASSEMBLY_REFUSAL_REASONS, reason).toContain(reason);
    }
  });

  it("partitions the outcomes by what they may carry, covering every one", () => {
    // The two rules the fourth outcome has to respect: figures describe only what was destroyed,
    // and a retention names itself. Every outcome falls under at least one or neither, never by
    // accident — a fifth outcome added to neither list would fail here rather than silently be
    // refused a scope it needs.
    expect([...SCOPE_BEARING_OUTCOMES]).toEqual(["erased", "erased_and_retained"]);
    expect([...RETENTION_BEARING_OUTCOMES]).toEqual(["retained", "erased_and_retained"]);
    const covered = new Set([...SCOPE_BEARING_OUTCOMES, ...RETENTION_BEARING_OUTCOMES]);
    expect([...ATTESTATION_OUTCOMES].filter((o) => !covered.has(o))).toEqual(["nothing_to_erase"]);
  });

  it("exports an empty scope rather than making a caller invent one", () => {
    expect(EMPTY_DELETION_SCOPE.rowCount).toBe(0);
    expect(EMPTY_DELETION_SCOPE.schemas).toEqual([]);
  });
});

function caps(over: Partial<DeletionCapabilities> = {}): DeletionCapabilities {
  return { ...CONSERVATIVE_DELETION_CAPABILITIES, ...over };
}

/**
 * The record-storage declaration every capabilities-path input carries (ADR-0351).
 *
 * One constant rather than a literal per input, so a test that *omits* it is visibly deliberate —
 * which matters here more than usual, because the omission is itself a refusal (`record_storage_
 * undeclared`) and a forgotten one would read as a test of something else.
 */
const RECORD_STORAGE: TombstoneRecordStorageDeclaration = {
  model: "typed_tables",
  schema: "public",
  relationCount: 54,
};

/**
 * An input whose scope comes from a declaration rather than a per-call list.
 *
 * It carries a `shared_tables` attestation by default, because that subsystem can no longer be
 * declared `absent` (ADR-0329) and so is always in scope. `nothing_to_erase` so it composes nothing
 * into the scope: every scope assertion in this file is about `tenant_schema`, and a deployment
 * whose platform tables held nothing for this tenant is a real case rather than a convenience.
 *
 * `recordStorage` goes in before the override spread, so `{recordStorage: undefined}` reaches the
 * assembler as a *present key with no value* and takes the refusal path rather than the default.
 */
function declaredInputOf(
  capabilities: DeletionCapabilities,
  over: Partial<TombstoneAssemblyInput> = {},
): TombstoneAssemblyInput {
  return {
    ...inputOf({
      attestations: [
        attest(),
        attest({ subsystem: "shared_tables", outcome: "nothing_to_erase", scope: undefined }),
      ],
      recordStorage: RECORD_STORAGE,
      ...over,
    }),
    requiredSubsystems: undefined,
    capabilities,
  };
}

/**
 * What a deployment looks like today: the two subsystems the pipeline actually performs, and the
 * other four not built yet.
 *
 * `shared_tables` is `erases` and not `absent` — ADR-0329 made it the second performed subsystem,
 * and the contract refuses `absent` for the reason it refuses it for `tenant_schema`: every
 * deployment has a `meta` schema whose tenant-scoped tables the pipeline erases unconditionally,
 * so a declaration calling it absent is a configuration error rather than a deployment shape.
 */
const PERFORMED_ONLY: DeletionCapabilities = caps({
  object_storage: "absent",
  backups: "absent",
  search_indexes: "absent",
  caches: "absent",
});

describe("DeletionCapabilitiesSchema", () => {
  it("accepts a total declaration", () => {
    expect(DeletionCapabilitiesSchema.safeParse(PERFORMED_ONLY).success).toBe(true);
    expect(DeletionCapabilitiesSchema.safeParse(CONSERVATIVE_DELETION_CAPABILITIES).success).toBe(true);
  });

  it("refuses a declaration missing a subsystem", () => {
    const partial: Record<string, string> = { ...CONSERVATIVE_DELETION_CAPABILITIES };
    delete partial["caches"];
    expect(DeletionCapabilitiesSchema.safeParse(partial).success).toBe(false);
  });

  it("demands every member of DELETION_SUBSYSTEMS, so a seventh cannot default to absent", () => {
    // The point of the whole declaration: adding a subsystem to the enum must fail here rather than
    // quietly falling out of every scope.
    for (const subsystem of DELETION_SUBSYSTEMS) {
      const partial: Record<string, string> = { ...CONSERVATIVE_DELETION_CAPABILITIES };
      delete partial[subsystem];
      expect(DeletionCapabilitiesSchema.safeParse(partial).success, subsystem).toBe(false);
    }
  });

  it("refuses an empty declaration rather than filling one in", () => {
    // No `z.default()` anywhere: a default applied to silence is this module's defect in a new shape.
    expect(DeletionCapabilitiesSchema.safeParse({}).success).toBe(false);
  });

  it("rejects an unknown subsystem and an unknown disposition", () => {
    expect(DeletionCapabilitiesSchema.safeParse({ ...PERFORMED_ONLY, blobs: "absent" }).success).toBe(false);
    expect(DeletionCapabilitiesSchema.safeParse({ ...PERFORMED_ONLY, caches: "maybe" }).success).toBe(false);
  });

  it("refuses tenant_schema: absent, naming why", () => {
    const r = DeletionCapabilitiesSchema.safeParse(caps({ tenant_schema: "absent" }));
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues[0]?.message).toContain("every deployment has one");
  });

  it("accepts tenant_schema as erases or retains", () => {
    for (const disposition of ["erases", "retains"] as const) {
      expect(
        DeletionCapabilitiesSchema.safeParse(caps({ tenant_schema: disposition })).success,
        disposition,
      ).toBe(true);
    }
  });
});

describe("requiredSubsystemsFor", () => {
  it("keeps erases and retains in scope and drops only absent", () => {
    // `retains` stays in scope deliberately: a retention obligation is a claim the proof carries, not
    // a reason to go quiet about the subsystem.
    const required = requiredSubsystemsFor(
      caps({ backups: "retains", object_storage: "absent", caches: "absent" }),
    );
    expect(required).toContain("backups");
    expect(required).not.toContain("object_storage");
    expect(required).not.toContain("caches");
  });

  it("reports every subsystem for the conservative declaration", () => {
    expect(requiredSubsystemsFor(CONSERVATIVE_DELETION_CAPABILITIES)).toEqual([...DELETION_SUBSYSTEMS]);
  });

  it("returns DELETION_SUBSYSTEMS order, so the derived list is stable", () => {
    const required = requiredSubsystemsFor(caps({ object_storage: "absent" }));
    expect(required).toEqual(DELETION_SUBSYSTEMS.filter((s) => s !== "object_storage"));
  });

  it("narrows to the two performed subsystems for a deployment that has nothing else", () => {
    // Not `tenant_schema` alone any more: ADR-0329 made `shared_tables` the second subsystem the
    // pipeline performs, and the contract refuses declaring it absent.
    expect(requiredSubsystemsFor(PERFORMED_ONLY)).toEqual(["tenant_schema", "shared_tables"]);
  });

  it("is the exact complement of absentSubsystemsFor", () => {
    const declaration = caps({ backups: "absent", caches: "retains" });
    expect([...requiredSubsystemsFor(declaration), ...absentSubsystemsFor(declaration)].sort()).toEqual(
      [...DELETION_SUBSYSTEMS].sort(),
    );
    expect(absentSubsystemsFor(declaration)).toEqual(["backups"]);
  });
});

describe("CONSERVATIVE_DELETION_CAPABILITIES", () => {
  it("declares nothing absent", () => {
    // The two ways of being wrong are not symmetric: a wrong `erases` refuses the next deletion and
    // names the subsystem, a wrong `absent` signs a proof that is silent about live data.
    expect(absentSubsystemsFor(CONSERVATIVE_DELETION_CAPABILITIES)).toEqual([]);
    for (const subsystem of DELETION_SUBSYSTEMS) {
      expect(CONSERVATIVE_DELETION_CAPABILITIES[subsystem], subsystem).toBe("erases");
    }
  });

  it("refuses today's two-subsystem deletion, naming the four nobody asked", () => {
    const out = assembleTombstone(declaredInputOf(CONSERVATIVE_DELETION_CAPABILITIES));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    const unattested = out.refusals.filter((r) => r.reason === "subsystem_unattested");
    // Four, not five: `shared_tables` attests now (ADR-0329). The conservative declaration is
    // still refused, because the other four erasures do not exist — which is the point of it being
    // a starting point rather than a default.
    expect(unattested).toHaveLength(4);
  });
});

describe("DeletionAttestationSchema", () => {
  it("accepts a well-formed erased report", () => {
    expect(DeletionAttestationSchema.safeParse(attest()).success).toBe(true);
  });

  it("requires an erased report to say what it destroyed", () => {
    const r = DeletionAttestationSchema.safeParse(attest({ scope: undefined }));
    expect(r.success).toBe(false);
  });

  it("forbids a non-erased report from carrying figures", () => {
    // Otherwise a `nothing_to_erase` could smuggle numbers into the proof.
    for (const outcome of ["nothing_to_erase", "retained"] as const) {
      const r = DeletionAttestationSchema.safeParse(attest({ outcome, scope: { rowCount: 5 } }));
      expect(r.success, outcome).toBe(false);
    }
  });

  it("requires a retained report to name a real obligation and a reference", () => {
    const base = { ...attest({ outcome: "retained" }), scope: undefined };
    expect(DeletionAttestationSchema.safeParse(base).success).toBe(false);
    expect(
      DeletionAttestationSchema.safeParse({ ...base, retentionObligation: "none", retainedDataReference: "x" })
        .success,
      "'none' is not an obligation",
    ).toBe(false);
    expect(
      DeletionAttestationSchema.safeParse({ ...base, retentionObligation: "tax_records_7y" }).success,
      "obligation without a reference",
    ).toBe(false);
    expect(
      DeletionAttestationSchema.safeParse({
        ...base,
        retentionObligation: "tax_records_7y",
        retainedDataReference: "meta.invoices (7y)",
      }).success,
    ).toBe(true);
  });

  it("forbids retention fields on a non-retained report", () => {
    const r = DeletionAttestationSchema.safeParse(
      attest({ retentionObligation: "tax_records_7y", retainedDataReference: "x" }),
    );
    expect(r.success).toBe(false);
  });

  it("refuses a subsystem reporting a field it does not own", () => {
    const r = DeletionAttestationSchema.safeParse(
      attest({ subsystem: "object_storage", scope: { schemas: ["t_abc"] } }),
    );
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]?.message).toContain("object_storage does not own 'schemas'");
    }
  });

  it("rejects unknown keys", () => {
    expect(DeletionAttestationSchema.safeParse({ ...attest(), extra: 1 }).success).toBe(false);
  });
});

describe("composeDeletionScope", () => {
  it("sums counts and merges lists across subsystems", () => {
    const scope = composeDeletionScope([
      attest(),
      attest({
        subsystem: "object_storage",
        scope: { objectStorageBuckets: ["files-eu"], fileCount: 9, storageBytes: 1024 },
      }),
    ]);
    expect(scope.schemas).toEqual(["t_abc"]);
    expect(scope.objectStorageBuckets).toEqual(["files-eu"]);
    expect(scope.rowCount).toBe(26);
    expect(scope.fileCount).toBe(9);
    expect(scope.storageBytes).toBe(66560);
  });

  it("deduplicates and sorts lists", () => {
    const scope = composeDeletionScope([
      attest({ scope: { tables: ["t.b", "t.a"], rowCount: 1 } }),
      attest({ subsystem: "shared_tables", scope: { tables: ["t.a", "t.c"], rowCount: 1 } }),
    ]);
    expect(scope.tables).toEqual(["t.a", "t.b", "t.c"]);
    expect(scope.rowCount).toBe(2);
  });

  it("contributes nothing for nothing_to_erase and retained", () => {
    const scope = composeDeletionScope([
      attest({ subsystem: "caches", outcome: "nothing_to_erase", scope: undefined }),
      attest({
        subsystem: "backups",
        outcome: "retained",
        scope: undefined,
        retentionObligation: "tax_records_7y",
        retainedDataReference: "vault://b/2026",
      }),
    ]);
    expect(scope).toEqual(EMPTY_DELETION_SCOPE);
  });
});

describe("assembleTombstone", () => {
  it("builds a record whose own hashes verify", () => {
    const out = assembleTombstone(inputOf());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(verifyTombstoneHashes(out.record)).toEqual({ contentManifestOk: true, proofOk: true });
    expect(out.record.scope.rowCount).toBe(26);
    expect(out.record.scope.schemas).toEqual(["t_abc"]);
  });

  it("refuses when a required subsystem did not attest, saying why", () => {
    const out = assembleTombstone(
      inputOf({ requiredSubsystems: ["tenant_schema", "object_storage", "backups"] }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    const unattested = out.refusals.filter((r) => r.reason === "subsystem_unattested");
    expect(unattested).toHaveLength(2);
    expect(unattested[0]?.detail).toContain("silence is not 'nothing to delete'");
    expect(out.refusals.map((r) => r.detail).join(" ")).toContain("backups");
    expect(out.refusals.map((r) => r.detail).join(" ")).toContain("object_storage");
  });

  it("accepts a required subsystem that attested it found nothing", () => {
    // The distinction the module exists for: 'I looked and there was nothing' is an answer; silence
    // is not.
    const out = assembleTombstone(
      inputOf({
        requiredSubsystems: ["tenant_schema", "caches"],
        attestations: [attest(), attest({ subsystem: "caches", outcome: "nothing_to_erase", scope: undefined })],
      }),
    );
    expect(out.ok).toBe(true);
  });

  it("refuses two attestations from one subsystem", () => {
    const out = assembleTombstone(inputOf({ attestations: [attest(), attest()] }));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusals.map((r) => r.reason)).toContain("duplicate_attestation");
  });

  it("refuses a malformed attestation without folding it into the scope", () => {
    const out = assembleTombstone(
      inputOf({ attestations: [attest(), attest({ subsystem: "caches", scope: { rowCount: 999 } })] }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusals.map((r) => r.reason)).toContain("invalid_attestation");
    expect(out.refusals.find((r) => r.reason === "invalid_attestation")?.detail).toContain("attestation 1");
  });

  it("refuses four-eyes and a missing anchor", () => {
    const out = assembleTombstone(inputOf({ approvedBy: ALICE, anchors: [] }));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusals.map((r) => r.reason).sort()).toEqual(["four_eyes_violated", "no_anchors"]);
  });

  it("refuses when everything reported nothing and nothing is retained", () => {
    const out = assembleTombstone(
      inputOf({
        requiredSubsystems: ["tenant_schema"],
        attestations: [attest({ outcome: "nothing_to_erase", scope: undefined })],
      }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusals.map((r) => r.reason)).toContain("scope_empty");
  });

  it("accepts an otherwise-empty deletion when something is lawfully retained", () => {
    const out = assembleTombstone(
      inputOf({
        kind: "data_subject_erasure",
        relatedDeletionRequestId: "del_123",
        requiredSubsystems: ["tenant_schema", "backups"],
        attestations: [
          attest(),
          attest({ subsystem: "shared_tables", outcome: "nothing_to_erase", scope: undefined }),
          attest({
            subsystem: "backups",
            outcome: "retained",
            scope: undefined,
            retentionObligation: "tax_records_7y",
            retainedDataReference: "vault://backups/2026",
          }),
        ],
      }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // Derived from the attestation, not remembered by the caller.
    expect(out.record.retainedReason).toContain("tax_records_7y");
    expect(out.record.retainedDataReference).toBe("vault://backups/2026");
  });

  it("reports every refusal it finds, not the first", () => {
    const out = assembleTombstone(
      inputOf({
        approvedBy: ALICE,
        anchors: [],
        requiredSubsystems: ["tenant_schema", "caches"],
        attestations: [],
      }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(new Set(out.refusals.map((r) => r.reason))).toEqual(
      new Set(["subsystem_unattested", "four_eyes_violated", "no_anchors", "scope_empty"]),
    );
  });

  it("computes no hash for a record it is about to refuse", () => {
    // Everything that can refuse does so before `populateTombstoneHashes`, so a digest that exists
    // is a digest of something assembled correctly.
    const out = assembleTombstone(inputOf({ approvedBy: ALICE }));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(JSON.stringify(out)).not.toContain("contentManifestSha256");
  });

  it("surfaces a contract violation as record_invalid", () => {
    const out = assembleTombstone(inputOf({ id: "not-a-tombstone-id" }));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusals.map((r) => r.reason)).toEqual(["record_invalid"]);
  });

  it("requires a deletion request for a data_subject_erasure, via the contract", () => {
    const out = assembleTombstone(inputOf({ kind: "data_subject_erasure" }));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusals[0]?.detail).toContain("relatedDeletionRequestId");
  });

  it("carries the scope alongside the record, for a caller that reports it", () => {
    const out = assembleTombstone(inputOf());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.scope).toEqual(out.record.scope);
  });
});

describe("assembleTombstone, with scope derived from a declaration", () => {
  it("assembles from a declaration and carries it on the result", () => {
    const out = assembleTombstone(declaredInputOf(PERFORMED_ONLY));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(verifyTombstoneHashes(out.record)).toEqual({ contentManifestOk: true, proofOk: true });
    expect(out.declaration).toEqual(PERFORMED_ONLY);
    // What a reader of the result can now tell apart: five subsystems this deployment does not have,
    // rather than five nobody asked about.
    expect(absentSubsystemsFor(out.declaration ?? PERFORMED_ONLY)).toHaveLength(4);
    expect(tombstoneMatchesAttestations(out.record, [attest()])).toBe(true);
  });

  it("puts the declaration, the retention claim and the record storage in the bytes as a v4 proof", () => {
    // ADR-0329 put the declaration in the bytes, because under v1 the digest could not tell "this
    // deployment has no object storage" from "nobody asked about object storage" — ADR-0317's defect
    // one level up. ADR-0331 adds the retention claim for the same reason one place further on, and
    // ADR-0351 the record storage: under v3 a deployment with no typed relations and one whose boot
    // manifest declared none composed byte-identical bytes.
    const out = assembleTombstone(declaredInputOf(PERFORMED_ONLY));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.record.proofVersion).toBe("v4");
    expect(out.record.capabilityDeclaration).toEqual(asCapabilityDeclaration(PERFORMED_ONLY));
    expect(out.record.retainedObligations).toEqual([]);
    expect(out.record.recordStorage).toEqual(RECORD_STORAGE);
    // And the digest is the v4 one — not the v3 one over the same scope, declaration and claim, not
    // the v2 one, not the v1 one over the scope alone. Four tags, four different answers for the
    // same destroyed rows.
    expect(out.record.contentManifestSha256).toBe(
      computeContentManifestSha256V4(
        out.record.scope,
        asCapabilityDeclaration(PERFORMED_ONLY),
        { obligations: [] },
        RECORD_STORAGE,
      ),
    );
    expect(out.record.contentManifestSha256).not.toBe(
      computeContentManifestSha256V3(
        out.record.scope,
        asCapabilityDeclaration(PERFORMED_ONLY),
        { obligations: [] },
      ),
    );
    expect(out.record.contentManifestSha256).not.toBe(
      computeContentManifestSha256V2(out.record.scope, asCapabilityDeclaration(PERFORMED_ONLY)),
    );
    expect(out.record.contentManifestSha256).not.toBe(
      computeContentManifestSha256(out.record.scope),
    );
  });

  it("makes the record storage readable from the proof itself", () => {
    const out = assembleTombstone(declaredInputOf(PERFORMED_ONLY));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(readRecordStorage(out.record)).toEqual({
      declarationState: "covered_by_proof",
      recordStorage: RECORD_STORAGE,
    });
  });

  it("carries the declaration through unchanged, neither normalised nor re-derived", () => {
    // The assembler composes a scope and derives the retention prose; this is a declaration, and the
    // only honest thing to do with one is sign what it was handed. A `document_rows` deployment's
    // zero count must not be filled in from the scope's table list either.
    const declared: TombstoneRecordStorageDeclaration = {
      model: "document_rows",
      schema: null,
      relationCount: 0,
    };
    const out = assembleTombstone(declaredInputOf(PERFORMED_ONLY, { recordStorage: declared }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.record.recordStorage).toEqual(declared);
    // Equal and not the same object: what the record carries came back through the schema, which is
    // why an incoherent declaration is a refusal rather than a signed contradiction. The typed input
    // cannot express the cross-field rule, so a rule checked only at the boundary is one `as` away
    // from being no rule — `capabilities`' own argument, one field across.
    expect(out.record.recordStorage).not.toBe(declared);
  });

  it("signs a typed_tables declaration counting zero relations, which is the claim v4 exists for", () => {
    // The third case ADR-0350's gap made unsayable: a column store serving a manifest that declares
    // no entity. It is legitimate where every tenant activates its own manifest and the signature of
    // the wrong pack having loaded otherwise, and neither reading is available from a v3 proof.
    const none: TombstoneRecordStorageDeclaration = {
      model: "typed_tables",
      schema: "public",
      relationCount: 0,
    };
    const out = assembleTombstone(declaredInputOf(PERFORMED_ONLY, { recordStorage: none }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.record.recordStorage).toEqual(none);
    expect(verifyTombstoneHashes(out.record)).toEqual({ contentManifestOk: true, proofOk: true });
  });

  it("signs the count, so changing only relationCount moves the digest", () => {
    // The whole reason the field is in the bytes rather than beside them. Same tenant, same
    // destroyed rows, same declaration: one claim says the deployment held 54 typed relations and
    // the other 55, and the proofs have to differ or the claim is decoration.
    const first = assembleTombstone(declaredInputOf(PERFORMED_ONLY));
    const again = assembleTombstone(declaredInputOf(PERFORMED_ONLY));
    const moved = assembleTombstone(
      declaredInputOf(PERFORMED_ONLY, {
        recordStorage: { ...RECORD_STORAGE, relationCount: 55 },
      }),
    );
    expect(first.ok && again.ok && moved.ok).toBe(true);
    if (!first.ok || !again.ok || !moved.ok) return;
    expect(again.record.contentManifestSha256).toBe(first.record.contentManifestSha256);
    expect(again.record.proofSha256).toBe(first.record.proofSha256);
    expect(moved.record.scope).toEqual(first.record.scope);
    expect(moved.record.contentManifestSha256).not.toBe(first.record.contentManifestSha256);
  });

  it("signs the empty retention claim rather than omitting the version", () => {
    // The v3-versus-v2-default argument, as a test. A deployment that kept nothing still emits v3,
    // so "nothing was lawfully retained" is a signed assertion. Had v3 been emitted only when there
    // was a retention to carry, that sentence would have been expressed by the *absence* of the tag —
    // which no reader can tell from a record written before the tag existed.
    const out = assembleTombstone(declaredInputOf(PERFORMED_ONLY));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(readRetentionClaim(out.record)).toEqual({
      claimState: "covered_by_proof",
      obligations: [],
      retainedReason: null,
      retainedDataReference: null,
    });
  });

  it("makes a declared absence readable from the proof itself", () => {
    const out = assembleTombstone(declaredInputOf(PERFORMED_ONLY));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const reading = readDeclaredAbsences(out.record);
    expect(reading.declarationState).toBe("covered_by_proof");
    if (reading.declarationState !== "covered_by_proof") return;
    expect([...reading.absentSubsystems].sort()).toEqual([
      "backups",
      "caches",
      "object_storage",
      "search_indexes",
    ]);
  });

  it("distinguishes a subsystem a deployment lacks from one that was empty", () => {
    // This is the pair ADR-0329 exists for, and the only pair that isolates the declaration from
    // the scope. "We have no cache layer" and "we have a cache layer and it held nothing" compose
    // **byte-identical** scopes — `nothing_to_erase` may carry no figures at all (ADR-0317) — so
    // under v1 the two produced the same proof, and a deployment could answer the harder claim with
    // the cheaper one. Only the declaration separates them, so only a declaration in the signed
    // bytes makes the distinction provable.
    const lacks = assembleTombstone(declaredInputOf(PERFORMED_ONLY));
    const empty = assembleTombstone(
      declaredInputOf(caps({ ...PERFORMED_ONLY, caches: "erases" }), {
        attestations: [
          attest(),
          attest({ subsystem: "shared_tables", outcome: "nothing_to_erase", scope: undefined }),
          attest({ subsystem: "caches", outcome: "nothing_to_erase", scope: undefined }),
        ],
      }),
    );
    expect(lacks.ok).toBe(true);
    expect(empty.ok).toBe(true);
    if (!lacks.ok || !empty.ok) return;
    expect(empty.record.scope).toEqual(lacks.record.scope);
    expect(empty.record.contentManifestSha256).not.toBe(lacks.record.contentManifestSha256);
    // And under v1 they would have been the same proof, which is the defect stated as a test.
    expect(computeContentManifestSha256(empty.record.scope)).toBe(
      computeContentManifestSha256(lacks.record.scope),
    );
  });

  it("leaves the legacy requiredSubsystems path on v1, with nothing declared", () => {
    // v1's bytes are what every stored digest commits to. A caller naming its subsystems per call
    // has declared nothing about the deployment, so there is no declaration to sign and claiming
    // v2 would assert one. Carrying no record storage is the same fact one field across: this path
    // is untouched by ADR-0351, and omitting the declaration here is the correct input rather than
    // an incomplete one.
    const out = assembleTombstone(inputOf());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.record.proofVersion).toBe("v1");
    expect(out.record.capabilityDeclaration).toBeUndefined();
    expect(out.record.recordStorage).toBeUndefined();
    expect(out.declaration).toBeUndefined();
    expect(out.record.contentManifestSha256).toBe(
      computeContentManifestSha256(out.record.scope),
    );
    expect(readDeclaredAbsences(out.record)).toEqual({
      declarationState: "unknown_not_in_proof",
      reason: "v1_proof",
    });
  });

  it("refuses a retains subsystem that did not attest", () => {
    // The rule `retains` exists for: a lawful retention is a claim the proof must carry, so the
    // subsystem is still obliged to speak.
    const out = assembleTombstone(
      declaredInputOf(caps({ ...PERFORMED_ONLY, backups: "retains" })),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    const unattested = out.refusals.filter((r) => r.reason === "subsystem_unattested");
    expect(unattested).toHaveLength(1);
    expect(unattested[0]?.detail).toContain("backups");
  });

  it("accepts a retains subsystem that attested its obligation", () => {
    const out = assembleTombstone(
      declaredInputOf(caps({ ...PERFORMED_ONLY, backups: "retains" }), {
        attestations: [
          attest(),
          attest({ subsystem: "shared_tables", outcome: "nothing_to_erase", scope: undefined }),
          attest({
            subsystem: "backups",
            outcome: "retained",
            scope: undefined,
            retentionObligation: "tax_records_7y",
            retainedDataReference: "vault://backups/2026",
          }),
        ],
      }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.record.retainedReason).toContain("tax_records_7y");
  });

  it("does not require an absent subsystem to attest", () => {
    const out = assembleTombstone(declaredInputOf(PERFORMED_ONLY));
    expect(out.ok).toBe(true);
  });

  it("refuses an absent subsystem that attested anyway", () => {
    // The declaration and the evidence disagree about what exists, and folding the report in would
    // put figures in a proof that says the subsystem is not there.
    const out = assembleTombstone(
      declaredInputOf(PERFORMED_ONLY, {
        attestations: [attest(), attest({ subsystem: "caches", outcome: "nothing_to_erase", scope: undefined })],
      }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    const conflict = out.refusals.filter((r) => r.reason === "absent_subsystem_attested");
    expect(conflict).toHaveLength(1);
    expect(conflict[0]?.detail).toContain("caches");
  });

  it("refuses when neither a declaration nor a list says who must speak", () => {
    const out = assembleTombstone(inputOf({ requiredSubsystems: undefined }));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusals.map((r) => r.reason)).toContain("scope_undeclared");
  });

  it("refuses when both are declared", () => {
    // `recordStorage` is supplied, so the only fault this input has is the one being asserted: the
    // capabilities branch is taken, which is also why a record storage here is not
    // `record_storage_outside_proof`.
    const out = assembleTombstone(
      inputOf({
        capabilities: PERFORMED_ONLY,
        recordStorage: RECORD_STORAGE,
        requiredSubsystems: ["tenant_schema"],
      }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusals.map((r) => r.reason)).toContain("scope_declaration_ambiguous");
  });

  it("refuses a declaration that does not parse, before deriving anything from it", () => {
    // Re-parsed at the point of use, because a totality rule enforced only at the config boundary is
    // one `as` away from being no rule.
    const out = assembleTombstone(
      declaredInputOf({ tenant_schema: "erases", caches: "absent" } as unknown as DeletionCapabilities),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusals.map((r) => r.reason)).toContain("capabilities_invalid");
  });

  it("refuses a declaration that puts tenant_schema out of scope", () => {
    const out = assembleTombstone(
      declaredInputOf({ ...PERFORMED_ONLY, tenant_schema: "absent" } as DeletionCapabilities),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusals.find((r) => r.reason === "capabilities_invalid")?.detail).toContain(
      "tenant_schema",
    );
  });

  it("refuses the capabilities path with no record-storage declaration", () => {
    // Refused rather than defaulted, because every candidate default is a *claim*. `document_rows`
    // asserts there were no typed relations at all, which is precisely the assertion ADR-0350's gap
    // made unavailable; and emitting v3 instead would make the proof version a function of the
    // caller's completeness, so a forgetful caller's proof would be indistinguishable from one
    // written before v4 existed. Neither mistake is visible to whoever later reads the proof.
    const out = assembleTombstone(declaredInputOf(PERFORMED_ONLY, { recordStorage: undefined }));
    expect(out.ok).toBe(false);
    expect("record" in out).toBe(false);
    if (out.ok) return;
    expect(out.refusals.map((r) => r.reason)).toContain("record_storage_undeclared");
    expect(
      out.refusals.find((r) => r.reason === "record_storage_undeclared")?.detail,
    ).toContain("typed relations");
  });

  it("refuses a record-storage declaration on the legacy requiredSubsystems path", () => {
    // The mirror of the refusal above, and of `scope_declaration_ambiguous`. A caller handing one in
    // believes it is signed; v1 bytes cover no declaration, so the record would assert something its
    // own digest does not — the state `TombstoneRecordSchema`'s paired refinements abolish rather
    // than accept.
    const out = assembleTombstone(inputOf({ recordStorage: RECORD_STORAGE }));
    expect(out.ok).toBe(false);
    expect("record" in out).toBe(false);
    if (out.ok) return;
    expect(out.refusals.map((r) => r.reason)).toEqual(["record_storage_outside_proof"]);
    expect(out.refusals[0]?.detail).toContain("crossengin.tombstone.content.v1");
  });

  it("refuses an incoherent record-storage declaration, naming the field", () => {
    const incoherent: readonly TombstoneRecordStorageDeclaration[] = [
      // A model with no typed relations cannot name the schema they are in.
      { model: "document_rows", schema: "public", relationCount: 0 },
      // And `typed_tables` has to say where they are: `--schema` feeds two stores with two different
      // defaults, which is the one misconfiguration this declaration could have caught.
      { model: "typed_tables", schema: null, relationCount: 54 },
    ];
    for (const recordStorage of incoherent) {
      const out = assembleTombstone(declaredInputOf(PERFORMED_ONLY, { recordStorage }));
      expect(out.ok, recordStorage.model).toBe(false);
      expect("record" in out).toBe(false);
      if (out.ok) return;
      expect(out.refusals.map((r) => r.reason), recordStorage.model).toContain(
        "record_storage_invalid",
      );
      // The zod path, so an operator is sent to the field rather than to the declaration.
      expect(
        out.refusals.find((r) => r.reason === "record_storage_invalid")?.detail,
        recordStorage.model,
      ).toContain("schema:");
    }
  });

  it("refuses a non-zero count on a model with no typed relations", () => {
    const out = assembleTombstone(
      declaredInputOf(PERFORMED_ONLY, {
        recordStorage: { model: "no_durable_store", schema: null, relationCount: 3 },
      }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(
      out.refusals.find((r) => r.reason === "record_storage_invalid")?.detail,
    ).toContain("relationCount:");
  });

  it("names nothing about record storage when neither scope declaration was given", () => {
    // `record_storage_outside_proof` is reachable only once the legacy path has actually been
    // chosen. With neither declaration the refusal that fits is `scope_undeclared`, and reporting
    // both would name a remedy — "declare capabilities instead" — the caller has already been told.
    const out = assembleTombstone(
      inputOf({ requiredSubsystems: undefined, recordStorage: RECORD_STORAGE }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusals.map((r) => r.reason)).toEqual(["scope_undeclared"]);
  });

  it("accumulates record_storage_undeclared with the other capabilities-path refusals", () => {
    // It is pushed with the rest and the function returns only once everything has been checked, so
    // an operator fixing a forgotten declaration is not then handed the four-eyes violation on the
    // next run. The missing declaration is reported *first*, which is the order the checks run in.
    const out = assembleTombstone(
      declaredInputOf(caps({ ...PERFORMED_ONLY, backups: "erases" }), {
        recordStorage: undefined,
        approvedBy: ALICE,
        anchors: [],
      }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(new Set(out.refusals.map((r) => r.reason))).toEqual(
      new Set([
        "record_storage_undeclared",
        "subsystem_unattested",
        "four_eyes_violated",
        "no_anchors",
      ]),
    );
    expect(out.refusals[0]?.reason).toBe("record_storage_undeclared");
  });

  it("reports an unparseable declaration and a missing record storage together", () => {
    // Two sequential checks rather than a chain: a declaration that does not parse must not hide the
    // second thing the capabilities path needs, or fixing the first reveals the second.
    const out = assembleTombstone(
      declaredInputOf({ tenant_schema: "erases", caches: "absent" } as unknown as DeletionCapabilities, {
        recordStorage: undefined,
      }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusals.map((r) => r.reason)).toEqual([
      "capabilities_invalid",
      "record_storage_undeclared",
    ]);
  });

  it("reaches all three record-storage refusals from this file", () => {
    // The enum assertions in "the vocabulary" say the reasons exist; this says each is produced by
    // an input, which is the half a declared-but-unreachable reason would pass.
    const reached = new Set<AssemblyRefusalReason>([
      ...refusalsOf(declaredInputOf(PERFORMED_ONLY, { recordStorage: undefined })),
      ...refusalsOf(inputOf({ recordStorage: RECORD_STORAGE })),
      ...refusalsOf(
        declaredInputOf(PERFORMED_ONLY, {
          recordStorage: { model: "typed_tables", schema: null, relationCount: 1 },
        }),
      ),
    ]);
    expect(RECORD_STORAGE_REFUSALS.filter((r) => !reached.has(r))).toEqual([]);
  });

  it("computes no hash for a record storage it is about to refuse", () => {
    for (const over of [
      { recordStorage: undefined },
      { recordStorage: { model: "typed_tables" as const, schema: null, relationCount: 1 } },
    ]) {
      const out = assembleTombstone(declaredInputOf(PERFORMED_ONLY, over));
      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(JSON.stringify(out)).not.toContain("contentManifestSha256");
    }
  });

  it("leaves a per-call list working exactly as before, with no declaration on the result", () => {
    const out = assembleTombstone(inputOf());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // Undefined means "named per call", which is a different fact from "nothing declared absent".
    expect(out.declaration).toBeUndefined();
  });

  it("computes no hash for a declaration it is about to refuse", () => {
    const out = assembleTombstone(declaredInputOf(CONSERVATIVE_DELETION_CAPABILITIES));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(JSON.stringify(out)).not.toContain("contentManifestSha256");
  });
});

describe("retainedObligations", () => {
  it("deduplicates and sorts the obligations holding data back", () => {
    const obligations = retainedObligations([
      attest(),
      attest({
        subsystem: "backups",
        outcome: "retained",
        scope: undefined,
        retentionObligation: "tax_records_7y",
        retainedDataReference: "a",
      }),
      attest({
        subsystem: "shared_tables",
        outcome: "retained",
        scope: undefined,
        retentionObligation: "audit_logs_3y",
        retainedDataReference: "b",
      }),
    ]);
    expect(obligations).toEqual(["audit_logs_3y", "tax_records_7y"]);
  });

  it("is empty when nothing is retained", () => {
    expect(retainedObligations([attest()])).toEqual([]);
  });
});

describe("tombstoneMatchesAttestations", () => {
  it("accepts the attestations the record was built from", () => {
    const out = assembleTombstone(inputOf());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(tombstoneMatchesAttestations(out.record, [attest()])).toBe(true);
  });

  it("rejects attestations that compose to a different scope", () => {
    const out = assembleTombstone(inputOf());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // The question an auditor asks and `verifyTombstoneHashes` cannot answer: the record is
    // internally consistent either way, but its evidence no longer composes to its claim.
    expect(verifyTombstoneHashes(out.record)).toEqual({ contentManifestOk: true, proofOk: true });
    expect(
      tombstoneMatchesAttestations(out.record, [attest({ scope: { schemas: ["t_abc"], rowCount: 1 } })]),
    ).toBe(false);
  });

  it("rejects an empty evidence set for a non-empty record", () => {
    const out = assembleTombstone(inputOf());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(tombstoneMatchesAttestations(out.record, [])).toBe(false);
  });

  it("accepts a retention-signing record's own evidence, retention and all", () => {
    const attestations = [
      attest(),
      attest({
        subsystem: "shared_tables",
        outcome: "erased_and_retained",
        scope: { tables: ["meta.invoices"], rowCount: 4 },
        retainedObligations: ["tax_records_7y"],
        retainedDataReference: "meta.invoices",
      }),
    ];
    const out = assembleTombstone(declaredInputOf(PERFORMED_ONLY, { attestations }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // The capabilities path emits v4 since ADR-0351; what this check turns on is the retention
    // claim being inside the bytes, which `proofVersionCoversRetentionClaim` answers for v3 and v4
    // alike — so the comparison reads the coverage rather than the tag.
    expect(out.record.proofVersion).toBe("v4");
    expect(tombstoneMatchesAttestations(out.record, attestations)).toBe(true);
  });

  it("sees a retained attestation deleted out of the evidence on a retention-signing record", () => {
    // The hole the scope comparison structurally cannot see (ADR-0331). A retention-bearing
    // attestation contributes *nothing* to a `DeletionScope` — the figures describe only what was
    // destroyed — so removing one from the stored evidence left the recomposed scope identical, the
    // record's digests untouched, and both detectors satisfied. The record's signed obligations are
    // the first thing that disagrees.
    const attestations = [
      attest(),
      attest({
        subsystem: "shared_tables",
        outcome: "retained",
        scope: undefined,
        retentionObligation: "tax_records_7y",
        retainedDataReference: "meta.invoices",
      }),
    ];
    const out = assembleTombstone(
      declaredInputOf(caps({ ...PERFORMED_ONLY, shared_tables: "retains" }), { attestations }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const withoutRetention = attestations.filter((a) => a.subsystem !== "shared_tables");
    // The scope is unchanged by the deletion, which is exactly why the old check could not see it.
    expect(composeDeletionScope(withoutRetention)).toEqual(out.record.scope);
    expect(verifyTombstoneHashes(out.record)).toEqual({ contentManifestOk: true, proofOk: true });
    expect(tombstoneMatchesAttestations(out.record, withoutRetention)).toBe(false);
  });

  it("sees an obligation swapped in the evidence on a retention-signing record", () => {
    const attestations = [
      attest(),
      attest({
        subsystem: "shared_tables",
        outcome: "erased_and_retained",
        scope: { tables: ["meta.invoices"], rowCount: 4 },
        retainedObligations: ["tax_records_7y"],
        retainedDataReference: "meta.invoices",
      }),
    ];
    const out = assembleTombstone(declaredInputOf(PERFORMED_ONLY, { attestations }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const rewritten = attestations.map((a) =>
      a.subsystem === "shared_tables"
        ? ({ ...a, retainedObligations: ["medical_records_10y"] } as DeletionAttestation)
        : a,
    );
    expect(tombstoneMatchesAttestations(out.record, rewritten)).toBe(false);
  });

  it("is insensitive to attestation order on a retention-signing record", () => {
    // The obligations are compared as a sorted set and the prose deliberately is not, so a reordered
    // evidence array — which `JSONB` can hand back — must not read as a finding. A false positive
    // here pages somebody at `sev1` (ADR-0324).
    const attestations = [
      attest(),
      attest({
        subsystem: "shared_tables",
        outcome: "erased_and_retained",
        scope: { tables: ["meta.invoices"], rowCount: 4 },
        retainedObligations: ["tax_records_7y"],
        retainedDataReference: "meta.invoices",
      }),
    ];
    const out = assembleTombstone(declaredInputOf(PERFORMED_ONLY, { attestations }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(tombstoneMatchesAttestations(out.record, [...attestations].reverse())).toBe(true);
  });

  it("leaves a v1 record's unsigned retention prose uncompared", () => {
    // v1 and v2 records carry the prose outside their bytes, and this check must not tighten on them
    // retroactively: there is no structured field to compare, and comparing the rendered sentence
    // would make a finding depend on a wording choice.
    const attestations = [
      attest(),
      attest({
        subsystem: "backups",
        outcome: "retained",
        scope: undefined,
        retentionObligation: "tax_records_7y",
        retainedDataReference: "backup-vault://2026",
      }),
    ];
    const out = assembleTombstone(
      inputOf({ requiredSubsystems: ["tenant_schema", "backups"], attestations }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.record.proofVersion).toBe("v1");
    expect(out.record.retainedReason).toBeDefined();
    expect(
      tombstoneMatchesAttestations(out.record, [attest()]),
    ).toBe(true);
  });
});

describe("the erasure handoff", () => {
  it("accepts what ADR-0316's erasureDeletionScope produces, verbatim", () => {
    // The shape `apps/operate-server`'s erase route returns as `scope`.
    const fromErasure = {
      schemas: ["t_3f2a1b4c5d6e4f708192a3b4c5d6e7f8"],
      tables: [
        "t_3f2a1b4c5d6e4f708192a3b4c5d6e7f8.account",
        "t_3f2a1b4c5d6e4f708192a3b4c5d6e7f8.invoice",
      ],
      rowCount: 26,
      storageBytes: 65536,
    };
    const subsystem: DeletionSubsystem = "tenant_schema";
    const out = assembleTombstone(
      inputOf({
        attestations: [
          {
            subsystem,
            outcome: "erased",
            scope: fromErasure,
            attestedBy: "operate-server/tenant-erasure",
            attestedAt: AT,
          },
        ],
      }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.record.scope.tables).toEqual(fromErasure.tables);
    expect(out.record.scope.rowCount).toBe(26);
    expect(out.record.scope.fileCount).toBe(0);
  });
});

/**
 * `erased_and_retained`: one subsystem, one attestation, two claims.
 *
 * The outcome exists because `shared_tables` destroys most of what it holds and lawfully keeps a
 * statutory remainder, and until it existed the only way to say so was to define the remainder as
 * "not the tenant's data at all" — true of a chain entry, false of a sales invoice.
 */
describe("erased_and_retained", () => {
  function both(over: Partial<DeletionAttestation> = {}): DeletionAttestation {
    return {
      subsystem: "shared_tables",
      outcome: "erased_and_retained",
      scope: { tables: ["meta.operate_entity_records"], rowCount: 94, storageBytes: 4096 },
      retainedObligations: ["tax_records_7y"],
      retainedDataReference: "meta.invoices, meta.tenant_credits",
      attestedBy: "tenant-lifecycle-pg/deletion",
      attestedAt: AT,
      ...over,
    } as DeletionAttestation;
  }

  it("accepts a report that destroyed some rows and kept others", () => {
    expect(DeletionAttestationSchema.safeParse(both()).success).toBe(true);
  });

  it("requires a scope, because it destroyed something", () => {
    const r = DeletionAttestationSchema.safeParse({ ...both(), scope: undefined });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]?.message).toContain("must report what it destroyed");
    }
  });

  it("refuses a silent retained side: no obligation at all", () => {
    // ADR-0317's rule on the new half — silence is not "none".
    const r = DeletionAttestationSchema.safeParse({ ...both(), retainedObligations: undefined });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.join(".") === "retainedObligations")).toBe(true);
    }
  });

  it("refuses an empty obligation list, which is the silence with a field around it", () => {
    expect(
      DeletionAttestationSchema.safeParse({ ...both(), retainedObligations: [] }).success,
    ).toBe(false);
  });

  it("refuses 'none' as an obligation, on either side of the list", () => {
    expect(
      DeletionAttestationSchema.safeParse({ ...both(), retainedObligations: ["none"] }).success,
    ).toBe(false);
    expect(
      DeletionAttestationSchema.safeParse({
        ...both(),
        retainedObligations: ["tax_records_7y", "none"],
      }).success,
    ).toBe(false);
  });

  it("requires the retained side to say where the data is", () => {
    const r = DeletionAttestationSchema.safeParse({ ...both(), retainedDataReference: undefined });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.join(".") === "retainedDataReference")).toBe(true);
    }
  });

  it("accepts more than one obligation, which is why the field is a list", () => {
    const r = DeletionAttestationSchema.safeParse({
      ...both(),
      retainedObligations: ["tax_records_7y", "medical_records_10y"],
    });
    expect(r.success).toBe(true);
  });

  it("sends it to retainedObligations rather than the singular field", () => {
    const r = DeletionAttestationSchema.safeParse({
      ...both(),
      retainedObligations: undefined,
      retentionObligation: "tax_records_7y",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.map((i) => i.message).join(" ")).toContain("retainedObligations");
    }
  });

  it("keeps retainedObligations off the other three outcomes", () => {
    for (const outcome of ["erased", "nothing_to_erase", "retained"] as const) {
      const base =
        outcome === "erased"
          ? attest()
          : outcome === "nothing_to_erase"
            ? { ...attest({ outcome }), scope: undefined }
            : {
                ...attest({ outcome }),
                scope: undefined,
                retentionObligation: "tax_records_7y",
                retainedDataReference: "x",
              };
      const r = DeletionAttestationSchema.safeParse({
        ...base,
        retainedObligations: ["tax_records_7y"],
      });
      expect(r.success, outcome).toBe(false);
    }
  });

  it("still owns only its own scope fields", () => {
    // The new outcome gets no new reach: `shared_tables` reporting a *schema* is the programming
    // error `SUBSYSTEM_SCOPE_FIELDS` exists to catch, outcome notwithstanding.
    const r = DeletionAttestationSchema.safeParse({
      ...both(),
      scope: { schemas: ["meta"], rowCount: 1 },
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]?.message).toContain("shared_tables does not own 'schemas'");
    }
  });

  it("folds only its destroyed figures into the scope", () => {
    const scope = composeDeletionScope([both()]);
    expect(scope.tables).toEqual(["meta.operate_entity_records"]);
    expect(scope.rowCount).toBe(94);
    expect(scope.storageBytes).toBe(4096);
    // Nothing from the retained side reached the scope: the reference is prose, not a list of
    // tables that were destroyed, and there is no field for a retained count to arrive in.
    expect(scope.schemas).toEqual([]);
  });

  it("composes identically to the same erasure reported as plain 'erased'", () => {
    // The guarantee that makes this outcome adoptable: a deployment that switches a subsystem from
    // `erased` to `erased_and_retained` for the same destroyed rows gets the same bytes.
    const plain = attest({
      subsystem: "shared_tables",
      outcome: "erased",
      scope: { tables: ["meta.operate_entity_records"], rowCount: 94, storageBytes: 4096 },
    });
    expect(composeDeletionScope([both()])).toEqual(composeDeletionScope([plain]));
  });

  it("derives the record's retention prose and reference from it", () => {
    const out = assembleTombstone(
      inputOf({ requiredSubsystems: ["shared_tables"], attestations: [both()] }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.record.retainedReason).toBe(
      "retained under legal obligation — shared_tables: tax_records_7y",
    );
    expect(out.record.retainedDataReference).toBe("meta.invoices, meta.tenant_credits");
    expect(verifyTombstoneHashes(out.record)).toEqual({ contentManifestOk: true, proofOk: true });
  });

  it("names every obligation in the prose when there is more than one", () => {
    const out = assembleTombstone(
      inputOf({
        requiredSubsystems: ["shared_tables"],
        attestations: [both({ retainedObligations: ["tax_records_7y", "audit_logs_3y"] })],
      }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.record.retainedReason).toBe(
      "retained under legal obligation — shared_tables: audit_logs_3y, tax_records_7y",
    );
  });

  it("does not let a caller remember the retention instead of deriving it", () => {
    // `retainedReason` / `retainedDataReference` are not accepted on the assembly input at all —
    // the only way either reaches a record is from an attestation that caused it.
    const out = assembleTombstone(
      inputOf({ requiredSubsystems: ["shared_tables"], attestations: [both()] }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const forged = { ...out.record, retainedReason: "nothing was retained" };
    expect(tombstoneMatchesAttestations(forged, [both()])).toBe(true);
    // Which is the honest reading and the limitation: the scope still matches, because the
    // retention is outside the signed bytes. Stated rather than implied.
    expect(verifyTombstoneHashes(forged).contentManifestOk).toBe(true);
  });

  it("counts as a retention for scope_empty, so an all-retained deletion is recordable", () => {
    const out = assembleTombstone(
      inputOf({
        requiredSubsystems: ["shared_tables"],
        attestations: [both({ scope: { tables: ["meta.users"], rowCount: 1, storageBytes: 1 } })],
      }),
    );
    expect(out.ok).toBe(true);
  });

  it("reports the obligations through both readers", () => {
    expect(attestationRetainedObligations(both())).toEqual(["tax_records_7y"]);
    expect(attestationRetainedObligations(attest())).toEqual([]);
    expect(
      retainedObligations([
        attest(),
        both({ retainedObligations: ["tax_records_7y", "tax_records_7y"] }),
        attest({
          subsystem: "backups",
          outcome: "retained",
          scope: undefined,
          retentionObligation: "audit_logs_3y",
          retainedDataReference: "vault://b",
        }),
      ]),
    ).toEqual(["audit_logs_3y", "tax_records_7y"]);
  });

  it("is still one attestation per subsystem", () => {
    // Splitting the claim across two reports is the duplicate the assembler refuses, which is the
    // reason the composite outcome exists rather than per-table attestations.
    const out = assembleTombstone(
      inputOf({
        requiredSubsystems: ["shared_tables"],
        attestations: [
          attest({
            subsystem: "shared_tables",
            scope: { tables: ["meta.users"], rowCount: 1, storageBytes: 1 },
          }),
          both(),
        ],
      }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusals.map((r) => r.reason)).toContain("duplicate_attestation");
  });
});

/**
 * The content manifest's bytes, pinned to digests computed **before** the fourth outcome existed.
 *
 * This is the constraint that outranks the feature. Every stored tombstone's
 * `contentManifestSha256` was computed over these bytes, and `verifyStoredEvidence` reports a digest
 * that stops matching as `scope_tampered` (ADR-0323) — the one defect the forensic chain cannot
 * refute. A change here does not break a test; it pages a `sev1` per honest record on file.
 */
describe("the content manifest's bytes do not move", () => {
  const FIXTURE_BASE = {
    id: "tomb_fixture0001ABCD",
    kind: "tenant_deletion" as const,
    tenantId: "11111111-1111-4111-8111-111111111111",
    deletedAt: "2026-10-05T00:00:00.000Z",
    executedBy: "op-exec",
    approvedBy: "op-approve",
    anchors: [
      {
        kind: "internal_audit_log" as const,
        reference: "chain-entry-1",
        anchoredAt: "2026-10-05T00:00:00.000Z",
      },
    ],
  };
  const FIXTURE_ATTESTATIONS: readonly DeletionAttestation[] = [
    {
      subsystem: "tenant_schema",
      outcome: "erased",
      scope: {
        schemas: ["tenant_abc"],
        tables: ["tenant_abc.invoice"],
        rowCount: 26,
        storageBytes: 65536,
      },
      attestedBy: "fixture",
      attestedAt: "2026-10-05T00:00:00.000Z",
    },
    {
      subsystem: "shared_tables",
      outcome: "erased",
      scope: {
        tables: ["meta.operate_entity_records", "meta.users"],
        rowCount: 94,
        storageBytes: 4096,
      },
      attestedBy: "fixture",
      attestedAt: "2026-10-05T00:00:00.000Z",
    },
    {
      subsystem: "object_storage",
      outcome: "nothing_to_erase",
      attestedBy: "fixture",
      attestedAt: "2026-10-05T00:00:00.000Z",
    },
    {
      subsystem: "backups",
      outcome: "retained",
      retentionObligation: "tax_records_7y",
      retainedDataReference: "backup-vault://2026",
      attestedBy: "fixture",
      attestedAt: "2026-10-05T00:00:00.000Z",
    },
  ];
  const FIXTURE_REQUIRED: readonly DeletionSubsystem[] = [
    "tenant_schema",
    "shared_tables",
    "object_storage",
    "backups",
  ];
  const FIXTURE_CAPABILITIES: DeletionCapabilities = {
    tenant_schema: "erases",
    shared_tables: "erases",
    object_storage: "erases",
    backups: "retains",
    search_indexes: "absent",
    caches: "absent",
  };
  /** Its own constant, like `FIXTURE_CAPABILITIES`: the v4 pins below are bytes over exactly this. */
  const FIXTURE_RECORD_STORAGE: TombstoneRecordStorageDeclaration = {
    model: "typed_tables",
    schema: "public",
    relationCount: 54,
  };

  it("pins the v1 digests for the legacy three-outcome input", () => {
    const out = assembleTombstone({
      ...FIXTURE_BASE,
      requiredSubsystems: FIXTURE_REQUIRED,
      attestations: FIXTURE_ATTESTATIONS,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.record.proofVersion).toBe("v1");
    expect(out.record.contentManifestSha256).toBe(
      "1f0c450df8c8a69213cc86504ce5da1cd8f5cc89dab68a4b94abcea907e2a36f",
    );
    expect(out.record.proofSha256).toBe(
      "cffebd50c3e87b001aad383d28b2a5406e7fc6800e46574646d095d8ec8a2f18",
    );
  });

  it("pins the v2 digests for the same input under a declaration", () => {
    // Pinned over the assembler's own composed scope but computed directly, because the assembler
    // emits v3 now (ADR-0331). The digests below are the ones a pre-ADR-0331 `dist/` produced for
    // exactly this input, transcribed from a run of it — so every v2 record on file still verifies.
    const scope = composeDeletionScope(FIXTURE_ATTESTATIONS);
    const v2 = computeContentManifestSha256V2(
      scope,
      asCapabilityDeclaration(FIXTURE_CAPABILITIES),
    );
    expect(v2).toBe("132f4a6e2e5bfadd124507f7edbeaf14bd4e5bbf830f14c0ff9079af07a07858");
    expect(
      computeProofSha256({
        id: FIXTURE_BASE.id,
        kind: FIXTURE_BASE.kind,
        tenantId: FIXTURE_BASE.tenantId,
        deletedAt: FIXTURE_BASE.deletedAt,
        executedBy: FIXTURE_BASE.executedBy,
        approvedBy: FIXTURE_BASE.approvedBy,
        contentManifestSha256: v2,
      }),
    ).toBe("7723c2c6fa72889c518559386607c94fc074ec98ff4154100c9de530b93cc5eb");
  });

  it("pins the v3 digests for the same input, which the capabilities path no longer emits", () => {
    // The v2 test's shape one version on, and for the same reason: the assembler emits v4 now
    // (ADR-0351), so these are computed directly over the record it does emit — same scope, same
    // declaration, same retention claim — and the constants are unchanged, so every v3 record on
    // file still verifies. A v3 digest that moved would page a `sev1` per honest record (ADR-0323).
    const out = assembleTombstone({
      ...FIXTURE_BASE,
      capabilities: FIXTURE_CAPABILITIES,
      recordStorage: FIXTURE_RECORD_STORAGE,
      attestations: FIXTURE_ATTESTATIONS,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const declaration = out.record.capabilityDeclaration;
    expect(declaration).toBeDefined();
    if (declaration === undefined) return;
    const v3 = computeContentManifestSha256V3(out.record.scope, declaration, {
      obligations: out.record.retainedObligations ?? [],
      ...(out.record.retainedReason !== undefined
        ? { retainedReason: out.record.retainedReason }
        : {}),
      ...(out.record.retainedDataReference !== undefined
        ? { retainedDataReference: out.record.retainedDataReference }
        : {}),
    });
    expect(v3).toBe("5703c8e68e44a108e82507951c33abb5553a339bb077e358ba945a04f5e0fe34");
    expect(
      computeProofSha256({
        id: FIXTURE_BASE.id,
        kind: FIXTURE_BASE.kind,
        tenantId: FIXTURE_BASE.tenantId,
        deletedAt: FIXTURE_BASE.deletedAt,
        executedBy: FIXTURE_BASE.executedBy,
        approvedBy: FIXTURE_BASE.approvedBy,
        contentManifestSha256: v3,
      }),
    ).toBe("2b60f9bba61b40f0113d2b055119f3fb032ff88cb94f6f1a7589025f70662092");
  });

  it("pins the v4 digests the capabilities path now emits", () => {
    const out = assembleTombstone({
      ...FIXTURE_BASE,
      capabilities: FIXTURE_CAPABILITIES,
      recordStorage: FIXTURE_RECORD_STORAGE,
      attestations: FIXTURE_ATTESTATIONS,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.record.proofVersion).toBe("v4");
    expect(out.record.contentManifestSha256).toBe(
      "e80516ef5148bf2b0157226d79ee6c1c38ed9bc386a47e13948b185e8d1e45a9",
    );
    expect(out.record.proofSha256).toBe(
      "f91133a9ce4b6a41a018e2ec19ef8071d7f65774e3cc3cc093b9de82a36c9371",
    );
  });

  it("pins the canonical v3 body, retention claim and all", () => {
    const out = assembleTombstone({
      ...FIXTURE_BASE,
      capabilities: FIXTURE_CAPABILITIES,
      recordStorage: FIXTURE_RECORD_STORAGE,
      attestations: FIXTURE_ATTESTATIONS,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const declaration = out.record.capabilityDeclaration;
    expect(declaration).toBeDefined();
    if (declaration === undefined) return;
    expect(
      canonicalContentManifestV3(out.record.scope, declaration, {
        obligations: out.record.retainedObligations ?? [],
        ...(out.record.retainedReason !== undefined
          ? { retainedReason: out.record.retainedReason }
          : {}),
        ...(out.record.retainedDataReference !== undefined
          ? { retainedDataReference: out.record.retainedDataReference }
          : {}),
      }),
    ).toBe(
      '{"backupGenerations":[],"cacheKeys":[],"capabilityDeclaration":{"backups":"retains",' +
        '"caches":"absent","object_storage":"erases","search_indexes":"absent",' +
        '"shared_tables":"erases","tenant_schema":"erases"},"fileCount":0,' +
        '"objectStorageBuckets":[],"retentionClaim":{"obligations":["tax_records_7y"],' +
        '"retainedDataReference":"backup-vault://2026","retainedReason":"retained under legal' +
        ' obligation — backups: tax_records_7y"},"rowCount":120,"schemas":["tenant_abc"],' +
        '"searchIndexes":[],"storageBytes":69632,' +
        '"tables":["meta.operate_entity_records","meta.users","tenant_abc.invoice"]}',
    );
  });

  it("pins the canonical v4 body, record storage and all", () => {
    const out = assembleTombstone({
      ...FIXTURE_BASE,
      capabilities: FIXTURE_CAPABILITIES,
      recordStorage: FIXTURE_RECORD_STORAGE,
      attestations: FIXTURE_ATTESTATIONS,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const declaration = out.record.capabilityDeclaration;
    const recordStorage = out.record.recordStorage;
    expect(declaration).toBeDefined();
    expect(recordStorage).toBeDefined();
    if (declaration === undefined || recordStorage === undefined) return;
    expect(
      canonicalContentManifestV4(
        out.record.scope,
        declaration,
        {
          obligations: out.record.retainedObligations ?? [],
          ...(out.record.retainedReason !== undefined
            ? { retainedReason: out.record.retainedReason }
            : {}),
          ...(out.record.retainedDataReference !== undefined
            ? { retainedDataReference: out.record.retainedDataReference }
            : {}),
        },
        recordStorage,
      ),
    ).toBe(
      '{"backupGenerations":[],"cacheKeys":[],"capabilityDeclaration":{"backups":"retains",' +
        '"caches":"absent","object_storage":"erases","search_indexes":"absent",' +
        '"shared_tables":"erases","tenant_schema":"erases"},"fileCount":0,' +
        '"objectStorageBuckets":[],"recordStorage":{"model":"typed_tables","relationCount":54,' +
        '"schema":"public"},"retentionClaim":{"obligations":["tax_records_7y"],' +
        '"retainedDataReference":"backup-vault://2026","retainedReason":"retained under legal' +
        ' obligation — backups: tax_records_7y"},"rowCount":120,"schemas":["tenant_abc"],' +
        '"searchIndexes":[],"storageBytes":69632,' +
        '"tables":["meta.operate_entity_records","meta.users","tenant_abc.invoice"]}',
    );
    // `schema` is `string | null` on the type rather than an optional key, so the explicit null the
    // retention claim had to construct is here by construction — and a stripped schema therefore
    // cannot render identically to a model that never had one.
    expect(
      canonicalContentManifestV4(out.record.scope, declaration, { obligations: [] }, {
        model: "document_rows",
        schema: null,
        relationCount: 0,
      }),
    ).toContain('"recordStorage":{"model":"document_rows","relationCount":0,"schema":null}');
  });

  it("gives an empty retention claim its own digest, distinct from a populated one, at v3 and v4", () => {
    // Two deployments, identical destroyed rows, one with a statutory retention and one without. The
    // whole reason the claim is in the bytes: before ADR-0331 these two proofs were byte-identical.
    const noRetention = FIXTURE_ATTESTATIONS.map((a) =>
      a.subsystem === "backups"
        ? ({
            subsystem: "backups",
            outcome: "nothing_to_erase",
            attestedBy: "fixture",
            attestedAt: "2026-10-05T00:00:00.000Z",
          } as DeletionAttestation)
        : a,
    );
    const out = assembleTombstone({
      ...FIXTURE_BASE,
      capabilities: { ...FIXTURE_CAPABILITIES, backups: "erases" },
      recordStorage: FIXTURE_RECORD_STORAGE,
      attestations: noRetention,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const declaration = out.record.capabilityDeclaration;
    expect(declaration).toBeDefined();
    if (declaration === undefined) return;
    expect(out.record.retainedObligations).toEqual([]);
    // The v3 digests this input produced before ADR-0351, computed directly and unchanged.
    const v3 = computeContentManifestSha256V3(out.record.scope, declaration, { obligations: [] });
    expect(v3).toBe("b704258583e523390f2793f069fc6e50fb0b43c62aca86275ec4a0081d7826a9");
    expect(
      computeProofSha256({
        id: FIXTURE_BASE.id,
        kind: FIXTURE_BASE.kind,
        tenantId: FIXTURE_BASE.tenantId,
        deletedAt: FIXTURE_BASE.deletedAt,
        executedBy: FIXTURE_BASE.executedBy,
        approvedBy: FIXTURE_BASE.approvedBy,
        contentManifestSha256: v3,
      }),
    ).toBe("7a81ca4fa3bee74d036d43abf7323673ee975b56c9ce8a1fc0dee13b46bcd4b2");
    // And the v4 digests it produces now.
    expect(out.record.contentManifestSha256).toBe(
      "f3e48e6067b78031e6fe66a439c90316560ecae83c1448eb9d0e4b447d4f12dc",
    );
    expect(out.record.proofSha256).toBe(
      "4d9d775ab2eb12c01ea74fc7dbcc89b0c7e03526ff21c453a2062828e0b6949a",
    );
    // The scope is identical to the populated-claim fixture's, and neither digest is — at either
    // version, since the record storage is the same for both and separates nothing here.
    expect(out.record.scope).toEqual(composeDeletionScope(FIXTURE_ATTESTATIONS));
    expect(v3).not.toBe("5703c8e68e44a108e82507951c33abb5553a339bb077e358ba945a04f5e0fe34");
    expect(out.record.contentManifestSha256).not.toBe(
      "e80516ef5148bf2b0157226d79ee6c1c38ed9bc386a47e13948b185e8d1e45a9",
    );
  });

  it("gives a record storage with no typed relations its own v4 digest", () => {
    // The pair ADR-0351 exists for, as a test and under the pinning block's discipline: same tenant,
    // same destroyed rows, same declaration, same retention claim. One deployment holds the tenant's
    // records in 54 typed relations and the other in catalogued document tables, and before v4 the
    // two signed byte-identical bytes — which is what made the scope's silence about typed relations
    // unreadable either way.
    const common = {
      ...FIXTURE_BASE,
      capabilities: FIXTURE_CAPABILITIES,
      attestations: FIXTURE_ATTESTATIONS,
    };
    const typed = assembleTombstone({ ...common, recordStorage: FIXTURE_RECORD_STORAGE });
    const documents = assembleTombstone({
      ...common,
      recordStorage: { model: "document_rows", schema: null, relationCount: 0 },
    });
    expect(typed.ok && documents.ok).toBe(true);
    if (!typed.ok || !documents.ok) return;
    expect(documents.record.scope).toEqual(typed.record.scope);
    expect(documents.record.capabilityDeclaration).toEqual(typed.record.capabilityDeclaration);
    expect(documents.record.retainedObligations).toEqual(typed.record.retainedObligations);
    expect(documents.record.contentManifestSha256).not.toBe(typed.record.contentManifestSha256);
    // And under v3 they would have been the same proof, which is the defect stated as a test.
    const claim = {
      obligations: typed.record.retainedObligations ?? [],
      ...(typed.record.retainedReason !== undefined
        ? { retainedReason: typed.record.retainedReason }
        : {}),
      ...(typed.record.retainedDataReference !== undefined
        ? { retainedDataReference: typed.record.retainedDataReference }
        : {}),
    };
    const declaration = typed.record.capabilityDeclaration;
    if (declaration === undefined) return;
    expect(computeContentManifestSha256V3(documents.record.scope, declaration, claim)).toBe(
      computeContentManifestSha256V3(typed.record.scope, declaration, claim),
    );
  });

  it("pins the canonical v1 body itself, not only its digest", () => {
    const out = assembleTombstone({
      ...FIXTURE_BASE,
      requiredSubsystems: FIXTURE_REQUIRED,
      attestations: FIXTURE_ATTESTATIONS,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(canonicalContentManifest(out.record.scope)).toBe(
      '{"backupGenerations":[],"cacheKeys":[],"fileCount":0,"objectStorageBuckets":[],' +
        '"rowCount":120,"schemas":["tenant_abc"],"searchIndexes":[],"storageBytes":69632,' +
        '"tables":["meta.operate_entity_records","meta.users","tenant_abc.invoice"]}',
    );
    expect(computeContentManifestSha256(out.record.scope)).toBe(
      out.record.contentManifestSha256,
    );
  });

  it("keeps those digests when a subsystem restates the same erasure as a retention", () => {
    // The fourth outcome's whole compatibility claim: the retained side is not in the bytes, so
    // adopting it never invalidates a proof over the same destroyed rows.
    const restated = FIXTURE_ATTESTATIONS.map((a) =>
      a.subsystem === "shared_tables"
        ? ({
            ...a,
            outcome: "erased_and_retained",
            retainedObligations: ["tax_records_7y"],
            retainedDataReference: "meta.invoices, meta.tenant_credits",
          } as DeletionAttestation)
        : a,
    );
    const out = assembleTombstone({
      ...FIXTURE_BASE,
      requiredSubsystems: FIXTURE_REQUIRED,
      attestations: restated,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.record.contentManifestSha256).toBe(
      "1f0c450df8c8a69213cc86504ce5da1cd8f5cc89dab68a4b94abcea907e2a36f",
    );
    expect(out.record.proofSha256).toBe(
      "cffebd50c3e87b001aad383d28b2a5406e7fc6800e46574646d095d8ec8a2f18",
    );
    // And the retention *is* recorded. On the v1 path it is still outside the digest, which is the
    // honest reading for the one path ADR-0331 deliberately left on v1: `requiredSubsystems` cannot
    // say "we have no object storage", so its bytes carry neither a declaration nor a claim.
    expect(out.record.retainedReason).toContain("shared_tables: tax_records_7y");
    expect(out.record.retainedObligations).toBeUndefined();
  });

  it("keeps the legacy retention prose byte-for-byte", () => {
    const out = assembleTombstone({
      ...FIXTURE_BASE,
      requiredSubsystems: FIXTURE_REQUIRED,
      attestations: FIXTURE_ATTESTATIONS,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.record.retainedReason).toBe(
      "retained under legal obligation — backups: tax_records_7y",
    );
    expect(out.record.retainedDataReference).toBe("backup-vault://2026");
  });
});
