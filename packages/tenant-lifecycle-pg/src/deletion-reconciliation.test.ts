import {
  assembleTombstone,
  type DeletionAttestation,
  type GdprDeletionRequest,
} from "@crossengin/tenant-lifecycle";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_STRANDED_AFTER_MS,
  DeletionReconciler,
  RECONCILIATION_VERDICTS,
  EVIDENCE_DEFECTS,
  isConclusive,
  needsOperator,
  verifyStoredEvidence,
  type ReconciliationResult,
  type ReconcilerOptions,
} from "./deletion-reconciliation.js";
import type { PostgresDeletionRequestStore } from "./deletion-request-store.js";
import type { PostgresTombstoneStore, StoredTombstone } from "./tombstone-store.js";

const TENANT = "3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8";
const REQ = "dreq_abcdefgh1234";
const TOMB = "tomb_aaaabbbbccccdddd";

const NOW = "2026-10-03T14:00:00.000Z";

function requestOf(over: Partial<GdprDeletionRequest> = {}): GdprDeletionRequest {
  return {
    id: REQ,
    tenantId: TENANT,
    subjectIdentifier: "subject@example.test",
    legalBasis: "article_17_right_to_erasure",
    status: "in_progress",
    submittedAt: "2026-10-01T00:00:00.000Z",
    submittedBy: "subject@example.test",
    deadlineAt: "2026-10-28T00:00:00.000Z",
    verificationMethod: "email_link",
    verifiedAt: "2026-10-02T00:00:00.000Z",
    verifiedBy: "support-1",
    // Two hours before NOW, so past the default window unless a test says otherwise.
    inProgressAt: "2026-10-03T12:00:00.000Z",
    completedAt: null,
    completionSha256: null,
    rejectedAt: null,
    deferredUntil: null,
    retentionObligations: ["none"],
    retainedDataCategories: [],
    tombstoneId: null,
    ...over,
  } as GdprDeletionRequest;
}

const CHAIN_HASH = "c".repeat(64);

const ATTESTATION: DeletionAttestation = {
  subsystem: "tenant_schema",
  outcome: "erased",
  scope: { schemas: ["t_abc"], tables: ["t_abc.invoice"], rowCount: 17, storageBytes: 8192 },
  attestedBy: "tenant-lifecycle-pg/deletion:alice",
  attestedAt: "2026-10-03T11:00:00.000Z",
};

/**
 * A **real** tombstone, assembled the way the pipeline assembles one and anchored the way the store
 * anchors one — not a stub. The verification under test is the real hash arithmetic, so a fixture
 * that merely looked like a record would have tested nothing.
 */
function tombstoneOf(id = TOMB): StoredTombstone {
  const assembled = assembleTombstone({
    id,
    kind: "data_subject_erasure",
    tenantId: TENANT,
    relatedDeletionRequestId: REQ,
    deletedAt: "2026-10-03T11:00:00.000Z",
    executedBy: "system:deletion-runner",
    approvedBy: "system:retention-policy",
    anchors: [
      {
        kind: "internal_audit_log",
        reference: "pending-chain-append",
        anchoredAt: "2026-10-03T11:00:00.000Z",
      },
    ],
    requiredSubsystems: ["tenant_schema"],
    attestations: [ATTESTATION],
  });
  if (!assembled.ok) throw new Error(`fixture does not assemble: ${JSON.stringify(assembled.refusals)}`);
  return {
    // The store replaces the caller's anchors with the chain entry it appended (ADR-0318). Anchors are
    // not part of the content manifest, which is why it can.
    record: {
      ...assembled.record,
      anchors: [
        {
          kind: "internal_audit_log",
          reference: CHAIN_HASH,
          anchoredAt: "2026-10-03T11:00:00.000Z",
        },
      ],
    },
    attestations: [ATTESTATION],
    chainEntryHash: CHAIN_HASH,
    chainSequenceNumber: 7,
  };
}

/** The honest fixture's real proof digest, so an assertion cannot drift from the arithmetic. */
const PROOF = tombstoneOf().record.proofSha256;

/** The same record with its scope edited in place — the tamper the chain cannot see. */
function tamperedTombstone(): StoredTombstone {
  const honest = tombstoneOf();
  return {
    ...honest,
    record: { ...honest.record, scope: { ...honest.record.scope, rowCount: 1 } },
  };
}

interface Harness {
  readonly reconciler: DeletionReconciler;
  readonly transitions: Array<{ id: string; to: string; fields: Record<string, unknown> }>;
  readonly retired: string[];
  readonly strandedCalls: Array<{ olderThan: string; limit: number | undefined }>;
  readonly completedCalls: (number | undefined)[];
  readonly reported: ReconciliationResult[];
}

function harness(
  behaviour: {
    readonly evidence?: readonly StoredTombstone[];
    readonly stranded?: readonly GdprDeletionRequest[];
    readonly retires?: boolean;
    readonly retireThrows?: boolean;
    readonly completed?: readonly GdprDeletionRequest[];
    readonly storedMissing?: boolean;
  } = {},
  over: Partial<ReconcilerOptions> = {},
): Harness {
  const transitions: Array<{ id: string; to: string; fields: Record<string, unknown> }> = [];
  const retired: string[] = [];
  const strandedCalls: Array<{ olderThan: string; limit: number | undefined }> = [];
  const completedCalls: (number | undefined)[] = [];
  const reported: ReconciliationResult[] = [];
  const requests = {
    transition: async (
      id: string,
      to: string,
      fields: Record<string, unknown>,
    ): Promise<GdprDeletionRequest | null> => {
      transitions.push({ id, to, fields: { ...fields } });
      return requestOf({ status: to as GdprDeletionRequest["status"] });
    },
    stranded: async (
      olderThan: string,
      limit?: number,
    ): Promise<readonly GdprDeletionRequest[]> => {
      strandedCalls.push({ olderThan, limit });
      return behaviour.stranded ?? [requestOf()];
    },
    completedWithTombstone: async (limit?: number): Promise<readonly GdprDeletionRequest[]> => {
      completedCalls.push(limit);
      return behaviour.completed ?? [];
    },
  } as unknown as PostgresDeletionRequestStore;
  const tombstones = {
    findForRequest: async (): Promise<readonly StoredTombstone[]> => behaviour.evidence ?? [],
    read: async (id: string): Promise<StoredTombstone | null> => {
      if (behaviour.storedMissing === true) return null;
      return (behaviour.evidence ?? [tombstoneOf()]).find((t) => t.record.id === id) ?? null;
    },
  } as unknown as PostgresTombstoneStore;

  const reconciler = new DeletionReconciler({
    requests,
    tombstones,
    retire: async (tenantId): Promise<boolean> => {
      retired.push(tenantId);
      if (behaviour.retireThrows === true) throw new Error("tenant store unreachable");
      return behaviour.retires ?? true;
    },
    clock: () => new Date(NOW),
    onReconciled: (r) => reported.push(r),
    ...over,
  });
  return { reconciler, transitions, retired, strandedCalls, completedCalls, reported };
}

describe("the verdicts", () => {
  it("name every outcome once, and split conclusive from operator-owned", () => {
    expect(RECONCILIATION_VERDICTS).toEqual([
      "completed_by_evidence",
      "never_committed",
      "ambiguous_evidence",
      "too_recent",
      "evidence_unverified",
      "not_stranded",
    ]);
    // Only a present tombstone stands on its own: an absence is an inference, however old.
    expect(RECONCILIATION_VERDICTS.filter((v) => isConclusive(v))).toEqual([
      "completed_by_evidence",
    ]);
    expect(RECONCILIATION_VERDICTS.filter((v) => needsOperator(v))).toEqual([
      "never_committed",
      "ambiguous_evidence",
      "evidence_unverified",
    ]);
  });

  it("waits an hour by default before reading anything into an absence", () => {
    expect(DEFAULT_STRANDED_AFTER_MS).toBe(3_600_000);
  });
});

describe("assess", () => {
  it("reads a tombstone naming the request as proof the deletion committed", async () => {
    const h = harness({ evidence: [tombstoneOf()] });
    const result = await h.reconciler.assess(requestOf());
    expect(result.verdict).toBe("completed_by_evidence");
    expect(result.tombstoneId).toBe(TOMB);
    expect(result.applied).toBe(false);
    expect(h.transitions).toEqual([]);
  });

  it("is conclusive on evidence even for a request stranded seconds ago", async () => {
    const h = harness({ evidence: [tombstoneOf()] });
    const result = await h.reconciler.assess(
      requestOf({ inProgressAt: "2026-10-03T13:59:59.000Z" }),
    );
    // The tombstone and the DROP committed together, so its existence is not a hint about what
    // probably happened — waiting would add nothing.
    expect(result.verdict).toBe("completed_by_evidence");
    expect(result.strandedForMs).toBe(1000);
  });

  it("reads no tombstone past the window as never committed", async () => {
    const result = await harness().reconciler.assess(requestOf());
    expect(result.verdict).toBe("never_committed");
    expect(result.detail).toContain("did not commit");
  });

  it("will not read anything into an absence inside the window", async () => {
    const h = harness();
    const result = await h.reconciler.assess(
      requestOf({ inProgressAt: "2026-10-03T13:30:00.000Z" }),
    );
    // "not committed" and "not committed yet" look identical; a pipeline running right now has
    // written no tombstone either.
    expect(result.verdict).toBe("too_recent");
    expect(result.strandedForMs).toBe(1_800_000);
  });

  it("refuses to choose between two tombstones naming one request", async () => {
    const h = harness({ evidence: [tombstoneOf(), tombstoneOf("tomb_bbbbccccddddeeee")] });
    const result = await h.reconciler.assess(requestOf());
    // The premise is that one request has at most one tombstone. Two breaks it, and that is a
    // finding rather than a row to pick from.
    expect(result.verdict).toBe("ambiguous_evidence");
    expect(result.tombstoneId).toBeNull();
    expect(result.tombstoneIds).toHaveLength(2);
  });

  it("says nothing to do for a request that is not in_progress", async () => {
    const h = harness({ evidence: [tombstoneOf()] });
    const result = await h.reconciler.assess(requestOf({ status: "verified", inProgressAt: null }));
    expect(result.verdict).toBe("not_stranded");
    expect(result.strandedForMs).toBe(0);
  });

  it("does not query for evidence it has no use for", async () => {
    let asked = 0;
    const h = harness({}, {
      tombstones: {
        findForRequest: async (): Promise<readonly StoredTombstone[]> => {
          asked += 1;
          return [];
        },
      } as unknown as PostgresTombstoneStore,
    });
    await h.reconciler.assess(requestOf({ status: "completed", tombstoneId: TOMB }));
    expect(asked).toBe(0);
  });
});

describe("reconcileOne", () => {
  it("completes the request from the tombstone's own id and digest", async () => {
    const h = harness({ evidence: [tombstoneOf()] });
    const result = await h.reconciler.reconcileOne(requestOf());
    expect(result.applied).toBe(true);
    expect(h.transitions).toHaveLength(1);
    expect(h.transitions[0]?.to).toBe("completed");
    expect(h.transitions[0]?.fields["tombstoneId"]).toBe(TOMB);
    // Off the stored proof, never recomputed, or the join ADR-0321 added is a lie.
    expect(h.transitions[0]?.fields["completionSha256"]).toBe(PROOF);
  });

  it("retires a tenant row the dead run never got to", async () => {
    const h = harness({ evidence: [tombstoneOf()] });
    const result = await h.reconciler.reconcileOne(requestOf());
    expect(h.retired).toEqual([TENANT]);
    expect(result.tenantRetired).toBe(true);
  });

  it("still records the completion when retiring the row fails", async () => {
    const h = harness({ evidence: [tombstoneOf()], retireThrows: true });
    const result = await h.reconciler.reconcileOne(requestOf());
    // The request is recorded against a real tombstone; failing over the row's status would undo
    // the part that was worth doing.
    expect(result.applied).toBe(true);
    expect(result.tenantRetired).toBeNull();
  });

  it("reports tenantRetired as null when no retire was wired", async () => {
    const h = harness({ evidence: [tombstoneOf()] }, { retire: undefined });
    const result = await h.reconciler.reconcileOne(requestOf());
    // null, not false: "not attempted" and "attempted and matched nothing" are different answers.
    expect(result.tenantRetired).toBeNull();
    expect(result.applied).toBe(true);
  });

  it("writes nothing for never_committed unless an operator authorises it", async () => {
    const h = harness();
    const result = await h.reconciler.reconcileOne(requestOf());
    expect(result.verdict).toBe("never_committed");
    expect(result.applied).toBe(false);
    expect(h.transitions).toEqual([]);
  });

  it("rejects the request when an operator does authorise it", async () => {
    const h = harness();
    const result = await h.reconciler.reconcileOne(requestOf(), { applyNeverCommitted: true });
    expect(result.applied).toBe(true);
    expect(h.transitions[0]?.to).toBe("rejected");
    expect(String(h.transitions[0]?.fields["rejectedReason"])).toContain("reconciled:");
  });

  it("will not reject on an authorisation when the verdict is only too_recent", async () => {
    const h = harness();
    const result = await h.reconciler.reconcileOne(
      requestOf({ inProgressAt: "2026-10-03T13:59:00.000Z" }),
      { applyNeverCommitted: true },
    );
    // The operator authorised applying an inference, not skipping the window that makes it one.
    expect(result.verdict).toBe("too_recent");
    expect(h.transitions).toEqual([]);
  });

  it("never writes on ambiguous evidence, authorised or not", async () => {
    const h = harness({ evidence: [tombstoneOf(), tombstoneOf("tomb_bbbbccccddddeeee")] });
    const result = await h.reconciler.reconcileOne(requestOf(), { applyNeverCommitted: true });
    expect(result.verdict).toBe("ambiguous_evidence");
    expect(h.transitions).toEqual([]);
  });

  it("reports every reconciliation through onReconciled", async () => {
    const h = harness({ evidence: [tombstoneOf()] });
    await h.reconciler.reconcileOne(requestOf());
    expect(h.reported).toHaveLength(1);
    expect(h.reported[0]?.verdict).toBe("completed_by_evidence");
  });
});

describe("reconcileStranded", () => {
  it("lists every in_progress request, not just those past the window", async () => {
    const h = harness({ evidence: [tombstoneOf()] });
    await h.reconciler.reconcileStranded();
    // The window governs the inference from absence, not the listing: a committed deletion whose
    // status write failed is conclusive immediately, and that is the case worth fixing promptly.
    expect(h.strandedCalls[0]?.olderThan).toBe(NOW);
  });

  it("applies the conclusive verdict and leaves the inference alone", async () => {
    const h = harness({
      stranded: [requestOf(), requestOf({ id: "dreq_two12345678" })],
    });
    const results = await h.reconciler.reconcileStranded();
    expect(results.map((r) => r.verdict)).toEqual(["never_committed", "never_committed"]);
    // A scheduler may not apply an inference from silence.
    expect(h.transitions).toEqual([]);
  });

  it("forwards the batch limit", async () => {
    const h = harness();
    await h.reconciler.reconcileStranded(3);
    expect(h.strandedCalls[0]?.limit).toBe(3);
  });

  it("returns an empty list when nothing is in progress", async () => {
    const h = harness({ stranded: [] });
    expect(await h.reconciler.reconcileStranded()).toEqual([]);
  });
});

describe("verifyStoredEvidence", () => {
  it("accepts a tombstone the pipeline really assembled and the store really anchored", () => {
    const check = verifyStoredEvidence(tombstoneOf());
    expect(check).toEqual({ ok: true, defects: [], matchesAttestations: true });
  });

  it("names every defect it can find", () => {
    expect(EVIDENCE_DEFECTS).toEqual([
      "scope_tampered",
      "proof_mismatch",
      "scope_disagrees_with_attestations",
      "unwitnessed",
    ]);
  });

  it("catches the scope tamper the chain cannot see", () => {
    const check = verifyStoredEvidence(tamperedTombstone());
    // The chain entry commits to the digests and the identity, never the scope (ADR-0318), and
    // `proofSha256` commits to `contentManifestSha256` rather than to the scope — so editing the
    // scope column leaves the proof and the chain intact. These two are the only detectors.
    expect(check.ok).toBe(false);
    expect(check.defects).toContain("scope_tampered");
    expect(check.defects).toContain("scope_disagrees_with_attestations");
    expect(check.matchesAttestations).toBe(false);
    // Proving the point: the proof itself still checks out.
    expect(check.defects).not.toContain("proof_mismatch");
  });

  it("refuses a tombstone nothing in the chain witnesses", () => {
    const honest = tombstoneOf();
    const unwitnessed = { ...honest, chainEntryHash: null, chainSequenceNumber: null };
    // A row anybody with write access could have inserted is not a proof.
    expect(verifyStoredEvidence(unwitnessed).defects).toEqual(["unwitnessed"]);
  });

  it("refuses a chain hash the record itself does not commit to", () => {
    const honest = tombstoneOf();
    const mismatched = { ...honest, chainEntryHash: "d".repeat(64) };
    // Stronger than "is the column set": the record's anchors must name that entry, so setting the
    // column without the record committing to it does not pass.
    expect(verifyStoredEvidence(mismatched).defects).toEqual(["unwitnessed"]);
  });

  it("reports no attestations as cannot-say, and does not fail over it", () => {
    const honest = tombstoneOf();
    const check = verifyStoredEvidence({ ...honest, attestations: [] });
    // null, not false: the hashes still establish the record is intact and commits to its own scope,
    // which is what completing a request needs (ADR-0318's habit).
    expect(check.matchesAttestations).toBeNull();
    expect(check.ok).toBe(true);
  });
});

describe("the evidence gate on completing a request", () => {
  it("refuses to complete a request from a tampered tombstone", async () => {
    const h = harness({ evidence: [tamperedTombstone()] });
    const result = await h.reconciler.reconcileOne(requestOf());
    expect(result.verdict).toBe("evidence_unverified");
    expect(result.applied).toBe(false);
    // Nothing written: the request's completionSha256 is the platform's claim about a proof, and
    // copying a digest off a record that fails verification launders the defect into a second row.
    expect(h.transitions).toEqual([]);
    expect(h.retired).toEqual([]);
  });

  it("names the tombstone and its defects so an operator can act", async () => {
    const h = harness({ evidence: [tamperedTombstone()] });
    const result = await h.reconciler.reconcileOne(requestOf());
    expect(result.tombstoneId).toBe(TOMB);
    expect(result.evidence?.defects).toContain("scope_tampered");
    expect(result.detail).toContain("does not verify");
  });

  it("is not overridable by the operator's authorisation", async () => {
    const h = harness({ evidence: [tamperedTombstone()] });
    const result = await h.reconciler.reconcileOne(requestOf(), { applyNeverCommitted: true });
    // That flag authorises an inference from an absence; it says nothing about a record that lies.
    expect(result.verdict).toBe("evidence_unverified");
    expect(h.transitions).toEqual([]);
  });

  it("carries the passing check on a conclusive verdict too", async () => {
    const h = harness({ evidence: [tombstoneOf()] });
    const result = await h.reconciler.reconcileOne(requestOf());
    expect(result.verdict).toBe("completed_by_evidence");
    expect(result.evidence?.ok).toBe(true);
  });

  it("a scheduler pass never applies an unverified one", async () => {
    const h = harness({ evidence: [tamperedTombstone()] });
    const results = await h.reconciler.reconcileStranded();
    expect(results.map((r) => r.verdict)).toEqual(["evidence_unverified"]);
    expect(h.transitions).toEqual([]);
  });
});

describe("auditCompleted", () => {
  const COMPLETED = requestOf({
    status: "completed",
    completedAt: "2026-10-03T12:00:00.000Z",
    completionSha256: PROOF,
    tombstoneId: TOMB,
  });

  it("reports nothing when a completed request's proof still stands up", async () => {
    const h = harness({ completed: [COMPLETED], evidence: [tombstoneOf()] });
    // Findings only: a listing of every completed request grows without bound and says nothing.
    expect(await h.reconciler.auditCompleted()).toEqual([]);
  });

  it("finds a request whose tombstone is gone", async () => {
    const h = harness({ completed: [COMPLETED], storedMissing: true });
    const findings = await h.reconciler.auditCompleted();
    expect(findings).toHaveLength(1);
    expect(findings[0]?.present).toBe(false);
    expect(findings[0]?.check).toBeNull();
    expect(findings[0]?.detail).toContain("no longer exists");
  });

  it("finds a request whose tombstone no longer verifies", async () => {
    const h = harness({ completed: [COMPLETED], evidence: [tamperedTombstone()] });
    const findings = await h.reconciler.auditCompleted();
    expect(findings[0]?.present).toBe(true);
    expect(findings[0]?.check?.defects).toContain("scope_tampered");
  });

  it("finds a request whose own digest disagrees with the proof", async () => {
    const h = harness({
      completed: [requestOf({ ...COMPLETED, completionSha256: "f".repeat(64) })],
      evidence: [tombstoneOf()],
    });
    const findings = await h.reconciler.auditCompleted();
    // A third question the stranded path never asks: the request carries its own copy, so the two
    // can disagree even when both records are internally intact.
    expect(findings[0]?.digestMatches).toBe(false);
    expect(findings[0]?.detail).toContain("does not match");
  });

  it("forwards the limit", async () => {
    const h = harness({ completed: [] });
    await h.reconciler.auditCompleted(7);
    expect(h.completedCalls).toEqual([7]);
  });
});
