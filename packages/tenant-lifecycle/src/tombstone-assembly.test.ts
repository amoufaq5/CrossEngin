import { describe, expect, it } from "vitest";

import {
  ASSEMBLY_REFUSAL_REASONS,
  ATTESTATION_OUTCOMES,
  CONSERVATIVE_DELETION_CAPABILITIES,
  DELETION_SUBSYSTEMS,
  DeletionAttestationSchema,
  DeletionCapabilitiesSchema,
  EMPTY_DELETION_SCOPE,
  SUBSYSTEM_DISPOSITIONS,
  SUBSYSTEM_SCOPE_FIELDS,
  absentSubsystemsFor,
  assembleTombstone,
  composeDeletionScope,
  requiredSubsystemsFor,
  retainedObligations,
  tombstoneMatchesAttestations,
  type DeletionAttestation,
  type DeletionCapabilities,
  type DeletionSubsystem,
  type TombstoneAssemblyInput,
} from "./tombstone-assembly.js";
import { verifyTombstoneHashes } from "./tombstone-proof.js";
import type { TombstoneAnchor } from "./tombstones.js";

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

describe("the vocabulary", () => {
  it("gives every subsystem an exclusive set of scope fields", () => {
    for (const s of DELETION_SUBSYSTEMS) {
      expect(SUBSYSTEM_SCOPE_FIELDS[s].length, s).toBeGreaterThan(0);
    }
    // `schemas` has exactly one owner, so a scope's schema list has one provenance.
    const owners = DELETION_SUBSYSTEMS.filter((s) => SUBSYSTEM_SCOPE_FIELDS[s].includes("schemas"));
    expect(owners).toEqual(["tenant_schema"]);
  });

  it("declares three outcomes, three dispositions and twelve refusal reasons", () => {
    expect([...ATTESTATION_OUTCOMES]).toEqual(["erased", "nothing_to_erase", "retained"]);
    expect([...SUBSYSTEM_DISPOSITIONS]).toEqual(["erases", "retains", "absent"]);
    expect(ASSEMBLY_REFUSAL_REASONS).toHaveLength(12);
  });

  it("exports an empty scope rather than making a caller invent one", () => {
    expect(EMPTY_DELETION_SCOPE.rowCount).toBe(0);
    expect(EMPTY_DELETION_SCOPE.schemas).toEqual([]);
  });
});

function caps(over: Partial<DeletionCapabilities> = {}): DeletionCapabilities {
  return { ...CONSERVATIVE_DELETION_CAPABILITIES, ...over };
}

/** An input whose scope comes from a declaration rather than a per-call list. */
function declaredInputOf(
  capabilities: DeletionCapabilities,
  over: Partial<TombstoneAssemblyInput> = {},
): TombstoneAssemblyInput {
  return { ...inputOf(over), requiredSubsystems: undefined, capabilities };
}

/** What a deployment looks like today: a tenant schema, and the other five not built yet. */
const ONLY_SCHEMA: DeletionCapabilities = caps({
  shared_tables: "absent",
  object_storage: "absent",
  backups: "absent",
  search_indexes: "absent",
  caches: "absent",
});

describe("DeletionCapabilitiesSchema", () => {
  it("accepts a total declaration", () => {
    expect(DeletionCapabilitiesSchema.safeParse(ONLY_SCHEMA).success).toBe(true);
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
    expect(DeletionCapabilitiesSchema.safeParse({ ...ONLY_SCHEMA, blobs: "absent" }).success).toBe(false);
    expect(DeletionCapabilitiesSchema.safeParse({ ...ONLY_SCHEMA, caches: "maybe" }).success).toBe(false);
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
    const required = requiredSubsystemsFor(caps({ shared_tables: "absent" }));
    expect(required).toEqual(DELETION_SUBSYSTEMS.filter((s) => s !== "shared_tables"));
  });

  it("narrows to tenant_schema alone for a deployment that has nothing else", () => {
    expect(requiredSubsystemsFor(ONLY_SCHEMA)).toEqual(["tenant_schema"]);
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

  it("refuses today's single-subsystem deletion, naming the five nobody asked", () => {
    const out = assembleTombstone(declaredInputOf(CONSERVATIVE_DELETION_CAPABILITIES));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    const unattested = out.refusals.filter((r) => r.reason === "subsystem_unattested");
    expect(unattested).toHaveLength(5);
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
    const out = assembleTombstone(declaredInputOf(ONLY_SCHEMA));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(verifyTombstoneHashes(out.record)).toEqual({ contentManifestOk: true, proofOk: true });
    expect(out.declaration).toEqual(ONLY_SCHEMA);
    // What a reader of the result can now tell apart: five subsystems this deployment does not have,
    // rather than five nobody asked about.
    expect(absentSubsystemsFor(out.declaration ?? ONLY_SCHEMA)).toHaveLength(5);
    expect(tombstoneMatchesAttestations(out.record, [attest()])).toBe(true);
  });

  it("refuses a retains subsystem that did not attest", () => {
    // The rule `retains` exists for: a lawful retention is a claim the proof must carry, so the
    // subsystem is still obliged to speak.
    const out = assembleTombstone(
      declaredInputOf(caps({ ...ONLY_SCHEMA, backups: "retains" })),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    const unattested = out.refusals.filter((r) => r.reason === "subsystem_unattested");
    expect(unattested).toHaveLength(1);
    expect(unattested[0]?.detail).toContain("backups");
  });

  it("accepts a retains subsystem that attested its obligation", () => {
    const out = assembleTombstone(
      declaredInputOf(caps({ ...ONLY_SCHEMA, backups: "retains" }), {
        attestations: [
          attest(),
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
    const out = assembleTombstone(declaredInputOf(ONLY_SCHEMA));
    expect(out.ok).toBe(true);
  });

  it("refuses an absent subsystem that attested anyway", () => {
    // The declaration and the evidence disagree about what exists, and folding the report in would
    // put figures in a proof that says the subsystem is not there.
    const out = assembleTombstone(
      declaredInputOf(ONLY_SCHEMA, {
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
    const out = assembleTombstone(
      inputOf({ capabilities: ONLY_SCHEMA, requiredSubsystems: ["tenant_schema"] }),
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
      declaredInputOf({ ...ONLY_SCHEMA, tenant_schema: "absent" } as DeletionCapabilities),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusals.find((r) => r.reason === "capabilities_invalid")?.detail).toContain(
      "tenant_schema",
    );
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
