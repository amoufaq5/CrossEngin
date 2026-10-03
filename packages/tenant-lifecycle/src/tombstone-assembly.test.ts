import { describe, expect, it } from "vitest";

import {
  ASSEMBLY_REFUSAL_REASONS,
  ATTESTATION_OUTCOMES,
  DELETION_SUBSYSTEMS,
  DeletionAttestationSchema,
  EMPTY_DELETION_SCOPE,
  SUBSYSTEM_SCOPE_FIELDS,
  assembleTombstone,
  composeDeletionScope,
  retainedObligations,
  tombstoneMatchesAttestations,
  type DeletionAttestation,
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

  it("declares three outcomes and eight refusal reasons", () => {
    expect([...ATTESTATION_OUTCOMES]).toEqual(["erased", "nothing_to_erase", "retained"]);
    expect(ASSEMBLY_REFUSAL_REASONS).toHaveLength(8);
  });

  it("exports an empty scope rather than making a caller invent one", () => {
    expect(EMPTY_DELETION_SCOPE.rowCount).toBe(0);
    expect(EMPTY_DELETION_SCOPE.schemas).toEqual([]);
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
