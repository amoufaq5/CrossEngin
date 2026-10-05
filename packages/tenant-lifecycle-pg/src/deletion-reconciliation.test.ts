import type { PgConnection } from "@crossengin/kernel-pg";
import {
  assembleTombstone,
  type DeletionAttestation,
  type GdprDeletionRequest,
} from "@crossengin/tenant-lifecycle";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_STRANDED_AFTER_MS,
  DEFAULT_TOMBSTONE_AUDIT_LIMIT,
  DeletionReconciler,
  RECONCILIATION_VERDICTS,
  EVIDENCE_DEFECTS,
  TOMBSTONE_REFERENCE_STATES,
  isConclusive,
  needsOperator,
  verifyStoredEvidence,
  type ReconciliationResult,
  type ReconcilerOptions,
} from "./deletion-reconciliation.js";
import { PostgresDeletionRequestStore, REQUEST_COLUMNS } from "./deletion-request-store.js";
import {
  PostgresTombstoneStore,
  TOMBSTONE_COLUMNS,
  TOMBSTONE_SCAN_MAX_LIMIT,
  type StoredTombstone,
  type TombstoneAnchorer,
} from "./tombstone-store.js";

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
    capabilities: { tenant_schema: "erases", shared_tables: "absent", object_storage: "absent", backups: "absent", search_indexes: "absent", caches: "absent" },
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

/**
 * A tombstone naming **no** deletion request — what the synchronous route of ADR-0320 writes, and
 * the whole class ADR-0327 exists for. `data_subject_erasure` cannot be one (the contract requires
 * the reference), so this is the `tenant_deletion` the erasure route produces.
 */
function unreferencedTombstone(id = "tomb_unref0001aaaa"): StoredTombstone {
  const assembled = assembleTombstone({
    id,
    kind: "tenant_deletion",
    tenantId: TENANT,
    deletedAt: "2026-10-03T11:00:00.000Z",
    executedBy: "operator:alice",
    approvedBy: "operator:bob",
    anchors: [
      {
        kind: "internal_audit_log",
        reference: "pending-chain-append",
        anchoredAt: "2026-10-03T11:00:00.000Z",
      },
    ],
    capabilities: { tenant_schema: "erases", shared_tables: "absent", object_storage: "absent", backups: "absent", search_indexes: "absent", caches: "absent" },
    attestations: [ATTESTATION],
  });
  if (!assembled.ok) {
    throw new Error(`fixture does not assemble: ${JSON.stringify(assembled.refusals)}`);
  }
  return {
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
    chainSequenceNumber: 9,
  };
}

function tamper(stored: StoredTombstone): StoredTombstone {
  return {
    ...stored,
    record: { ...stored.record, scope: { ...stored.record.scope, rowCount: 1 } },
  };
}

interface Harness {
  readonly reconciler: DeletionReconciler;
  readonly transitions: Array<{ id: string; to: string; fields: Record<string, unknown> }>;
  readonly retired: string[];
  readonly strandedCalls: Array<{ olderThan: string; limit: number | undefined }>;
  readonly completedCalls: (number | undefined)[];
  readonly scanCalls: Array<{ limit: number; afterTombstoneId: string | null | undefined }>;
  readonly requestReads: string[];
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
    readonly scan?: readonly StoredTombstone[];
    /** Which request ids `requests.read` finds. Absent means every one asked for. */
    readonly knownRequestIds?: readonly string[];
  } = {},
  over: Partial<ReconcilerOptions> = {},
): Harness {
  const transitions: Array<{ id: string; to: string; fields: Record<string, unknown> }> = [];
  const retired: string[] = [];
  const strandedCalls: Array<{ olderThan: string; limit: number | undefined }> = [];
  const completedCalls: (number | undefined)[] = [];
  const scanCalls: Array<{ limit: number; afterTombstoneId: string | null | undefined }> = [];
  const requestReads: string[] = [];
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
    read: async (id: string): Promise<GdprDeletionRequest | null> => {
      requestReads.push(id);
      const known = behaviour.knownRequestIds;
      if (known !== undefined && !known.includes(id)) return null;
      return requestOf({ id });
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
    scanAll: async (input: {
      limit: number;
      afterTombstoneId?: string | null;
    }): Promise<readonly StoredTombstone[]> => {
      scanCalls.push({ limit: input.limit, afterTombstoneId: input.afterTombstoneId });
      const all = behaviour.scan ?? [];
      const after = input.afterTombstoneId ?? null;
      // A real keyset page, so a test about the cursor is a test about the cursor.
      const ordered = [...all].sort((a, b) => a.record.id.localeCompare(b.record.id));
      const from = after === null ? ordered : ordered.filter((t) => t.record.id > after);
      return from.slice(0, input.limit);
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
  return {
    reconciler,
    transitions,
    retired,
    strandedCalls,
    completedCalls,
    scanCalls,
    requestReads,
    reported,
  };
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

describe("auditTombstones", () => {
  it("names the three ways a tombstone is reached", () => {
    // Collapsing them would lose the one this direction was built for: `unreferenced` is a tombstone
    // no other audit can see, and `dangling` is a request row deleted out from under a proof.
    expect(TOMBSTONE_REFERENCE_STATES).toEqual(["unreferenced", "referenced", "dangling"]);
    expect(DEFAULT_TOMBSTONE_AUDIT_LIMIT).toBe(100);
  });

  it("reports no findings over a clean table, with a truthful examined count", async () => {
    const h = harness({ scan: [unreferencedTombstone(), tombstoneOf()] });
    const page = await h.reconciler.auditTombstones();
    // "We examined two and found nothing" is the claim an auditor needs, and it cannot be made from
    // the absence of a log line (ADR-0323).
    expect(page.findings).toEqual([]);
    expect(page.examined).toBe(2);
  });

  it("finds a tampered scope on a tombstone no request names", async () => {
    const h = harness({ scan: [tamper(unreferencedTombstone())] });
    const page = await h.reconciler.auditTombstones();
    expect(page.examined).toBe(1);
    expect(page.findings).toHaveLength(1);
    // Nothing else in the system looks at this row: both other directions start from a request, and
    // this one has none.
    expect(page.findings[0]?.reference).toBe("unreferenced");
    expect(page.findings[0]?.relatedDeletionRequestId).toBeNull();
    expect(page.findings[0]?.check.defects).toContain("scope_tampered");
    expect(page.findings[0]?.detail).toContain("does not verify");
  });

  it("proves the point: the tamper leaves the proof digest and the chain hash untouched", async () => {
    const tampered = tamper(unreferencedTombstone());
    const h = harness({ scan: [tampered] });
    const page = await h.reconciler.auditTombstones();
    expect(tampered.record.proofSha256).toBe(unreferencedTombstone().record.proofSha256);
    expect(tampered.chainEntryHash).toBe(CHAIN_HASH);
    expect(page.findings[0]?.check.defects).not.toContain("proof_mismatch");
  });

  it("finds a tombstone nothing in the chain witnesses", async () => {
    const honest = unreferencedTombstone();
    const h = harness({
      scan: [{ ...honest, chainEntryHash: null, chainSequenceNumber: null }],
    });
    const page = await h.reconciler.auditTombstones();
    expect(page.findings[0]?.check.defects).toEqual(["unwitnessed"]);
  });

  it("makes a dangling request reference its own finding, even on evidence that verifies", async () => {
    const h = harness({ scan: [tombstoneOf()], knownRequestIds: [] });
    const page = await h.reconciler.auditTombstones();
    expect(page.findings).toHaveLength(1);
    // Not "unreferenced": the proof names a request and the request is gone, which means a row was
    // deleted out from under it.
    expect(page.findings[0]?.reference).toBe("dangling");
    expect(page.findings[0]?.relatedDeletionRequestId).toBe(REQ);
    expect(page.findings[0]?.check.ok).toBe(true);
    expect(page.findings[0]?.detail).toContain("does not exist");
  });

  it("reports both defects when a dangling reference also fails verification", async () => {
    const h = harness({ scan: [tamperedTombstone()], knownRequestIds: [] });
    const finding = (await h.reconciler.auditTombstones()).findings[0];
    expect(finding?.reference).toBe("dangling");
    expect(finding?.detail).toContain("does not verify");
    expect(finding?.detail).toContain("does not exist");
  });

  it("says nothing about a referenced tombstone that verifies", async () => {
    const h = harness({ scan: [tombstoneOf()], knownRequestIds: [REQ] });
    const page = await h.reconciler.auditTombstones();
    expect(page.findings).toEqual([]);
    expect(page.examined).toBe(1);
  });

  it("still reports a referenced tombstone that does not verify", async () => {
    const h = harness({ scan: [tamperedTombstone()], knownRequestIds: [REQ] });
    const page = await h.reconciler.auditTombstones();
    // Not left to `auditCompleted`: that walks only `status = 'completed'` requests under its own
    // limit, so a tombstone whose request sits `in_progress` would fall through both directions.
    expect(page.findings).toHaveLength(1);
    expect(page.findings[0]?.reference).toBe("referenced");
  });

  it("spends at most one request lookup per row, and none on an unreferenced one", async () => {
    const h = harness({ scan: [unreferencedTombstone(), tombstoneOf()], knownRequestIds: [REQ] });
    await h.reconciler.auditTombstones();
    expect(h.requestReads).toEqual([REQ]);
  });

  it("hands back a cursor when the page is full, and the caller's next page skips it", async () => {
    const all = [
      unreferencedTombstone("tomb_aaaa0000aaaa"),
      unreferencedTombstone("tomb_bbbb0000bbbb"),
      unreferencedTombstone("tomb_cccc0000cccc"),
    ];
    const h = harness({ scan: all });
    const first = await h.reconciler.auditTombstones({ limit: 2 });
    expect(first.examined).toBe(2);
    expect(first.nextAfterTombstoneId).toBe("tomb_bbbb0000bbbb");
    const second = await h.reconciler.auditTombstones({
      limit: 2,
      afterTombstoneId: first.nextAfterTombstoneId,
    });
    // The second page re-reads nothing: a sweep that re-read or skipped a row would be an audit that
    // can miss the one tampered record.
    expect(second.examined).toBe(1);
    expect(second.nextAfterTombstoneId).toBeNull();
    expect(h.scanCalls).toEqual([
      { limit: 2, afterTombstoneId: null },
      { limit: 2, afterTombstoneId: "tomb_bbbb0000bbbb" },
    ]);
  });

  it("ends the sweep on a page shorter than the limit", async () => {
    const h = harness({ scan: [unreferencedTombstone()] });
    const page = await h.reconciler.auditTombstones({ limit: 10 });
    expect(page.examined).toBe(1);
    expect(page.nextAfterTombstoneId).toBeNull();
  });

  it("ends the sweep on an empty table without claiming anything was checked", async () => {
    const h = harness({ scan: [] });
    const page = await h.reconciler.auditTombstones();
    expect(page).toEqual({ examined: 0, findings: [], nextAfterTombstoneId: null });
  });

  it("clamps the page size to the store's cap, so a short page is not misread as the end", async () => {
    const h = harness({ scan: [] });
    await h.reconciler.auditTombstones({ limit: 100_000 });
    // Asking for more than the store will serve would yield a short page, and a short page is how
    // this reports the end of the table.
    expect(h.scanCalls[0]?.limit).toBe(TOMBSTONE_SCAN_MAX_LIMIT);
    await h.reconciler.auditTombstones({ limit: 0 });
    expect(h.scanCalls[1]?.limit).toBe(1);
  });

  it("asks for the default page size when the caller says nothing", async () => {
    const h = harness({ scan: [] });
    await h.reconciler.auditTombstones();
    expect(h.scanCalls).toEqual([
      { limit: DEFAULT_TOMBSTONE_AUDIT_LIMIT, afterTombstoneId: null },
    ]);
  });

  it("never transitions a request, whatever it finds", async () => {
    const h = harness({ scan: [tamperedTombstone()], knownRequestIds: [REQ] });
    await h.reconciler.auditTombstones();
    expect(h.transitions).toEqual([]);
    expect(h.retired).toEqual([]);
  });
});

/**
 * The no-writes invariant, pinned against the real stores over a fake connection rather than against
 * the fakes above — the fakes could not write even if the code asked them to, so only this says
 * anything. ADR-0323 established that `evidence_unverified` is a verdict nothing may apply, not a
 * scheduler and not an operator; a sweep that found a tampered scope has even less standing, because
 * it starts from no request and so has nothing whose status it could be right about.
 */
describe("auditTombstones writes nothing", () => {
  const ANCHORER: TombstoneAnchorer = {
    appendWithin: async () => {
      throw new Error("a read-only audit must never append to the chain");
    },
  };

  function tombstoneRow(stored: StoredTombstone): Record<string, unknown> {
    const r = stored.record;
    return {
      tombstone_id: r.id,
      kind: r.kind,
      tenant_id: r.tenantId,
      subject_identifier: r.subjectIdentifier ?? null,
      related_deletion_request_id: r.relatedDeletionRequestId ?? null,
      deleted_at: r.deletedAt,
      executed_by: r.executedBy,
      approved_by: r.approvedBy,
      scope: JSON.stringify(r.scope),
      content_manifest_sha256: r.contentManifestSha256,
      proof_sha256: r.proofSha256,
      anchors: JSON.stringify(r.anchors),
      retained_reason: r.retainedReason ?? null,
      retained_data_reference: r.retainedDataReference ?? null,
      invalidation_of_prior_tombstone_id: null,
      attestations: JSON.stringify(stored.attestations),
      chain_entry_hash: stored.chainEntryHash,
      chain_sequence_number: stored.chainSequenceNumber,
    };
  }

  function requestRow(request: GdprDeletionRequest): Record<string, unknown> {
    return {
      request_id: request.id,
      tenant_id: request.tenantId,
      subject_identifier: request.subjectIdentifier,
      legal_basis: request.legalBasis,
      status: request.status,
      submitted_at: request.submittedAt,
      submitted_by: request.submittedBy,
      deadline_at: request.deadlineAt,
      verification_method: request.verificationMethod,
      verified_at: request.verifiedAt,
      verified_by: request.verifiedBy,
      in_progress_at: request.inProgressAt,
      completed_at: request.completedAt,
      completion_sha256: request.completionSha256,
      rejected_at: request.rejectedAt,
      rejected_reason: null,
      deferred_until: request.deferredUntil,
      deferral_reason: null,
      retention_obligations: JSON.stringify(request.retentionObligations),
      retained_data_categories: JSON.stringify(request.retainedDataCategories),
      notes: null,
      tombstone_id: request.tombstoneId,
    };
  }

  function realHarness(
    scan: readonly StoredTombstone[],
    requestsFound: readonly GdprDeletionRequest[],
  ): { readonly reconciler: DeletionReconciler; readonly sql: () => string[] } {
    const sql: string[] = [];
    const conn = {
      query: async (statement: string) => {
        sql.push(statement);
        if (statement.includes(`FROM meta.tenant_tombstones`)) {
          return { rows: scan.map((s) => tombstoneRow(s)), rowCount: scan.length };
        }
        if (statement.includes(`FROM meta.gdpr_deletion_requests`)) {
          return { rows: requestsFound.map((r) => requestRow(r)), rowCount: requestsFound.length };
        }
        return { rows: [], rowCount: 0 };
      },
      transaction: async <T>(fn: (tx: PgConnection) => Promise<T>): Promise<T> => {
        sql.push("BEGIN");
        const out = await fn(conn as unknown as PgConnection);
        sql.push("COMMIT");
        return out;
      },
      withAdvisoryLock: async <T>(_k: bigint, fn: () => Promise<T>): Promise<T> => fn(),
      close: async (): Promise<undefined> => undefined,
    };
    const pg = conn as unknown as PgConnection;
    return {
      reconciler: new DeletionReconciler({
        requests: new PostgresDeletionRequestStore(pg),
        tombstones: new PostgresTombstoneStore(pg, ANCHORER),
        clock: () => new Date(NOW),
      }),
      sql: () => sql,
    };
  }

  const MUTATING = /^\s*(UPDATE|INSERT|DELETE|TRUNCATE|DROP|ALTER)\b/i;

  it("records no mutating statement over a clean table", async () => {
    const h = realHarness([unreferencedTombstone()], []);
    const page = await h.reconciler.auditTombstones();
    expect(page.findings).toEqual([]);
    expect(page.examined).toBe(1);
    expect(h.sql().filter((s) => MUTATING.test(s))).toEqual([]);
  });

  it("records no mutating statement when it finds a tampered scope", async () => {
    const h = realHarness([tamper(unreferencedTombstone())], []);
    const page = await h.reconciler.auditTombstones();
    expect(page.findings[0]?.check.defects).toContain("scope_tampered");
    expect(h.sql().filter((s) => MUTATING.test(s))).toEqual([]);
  });

  it("records no mutating statement when it finds a dangling reference", async () => {
    const h = realHarness([tombstoneOf()], []);
    const page = await h.reconciler.auditTombstones();
    expect(page.findings[0]?.reference).toBe("dangling");
    expect(h.sql().filter((s) => MUTATING.test(s))).toEqual([]);
  });

  it("reads the table under the platform grant and keyset-ordered", async () => {
    const h = realHarness([], []);
    await h.reconciler.auditTombstones({ limit: 10 });
    const statements = h.sql();
    expect(statements.some((s) => s.includes("set_config('app.platform_audit', 'on', true)"))).toBe(
      true,
    );
    const select = statements.find((s) => s.includes("FROM meta.tenant_tombstones"));
    expect(select).toContain("ORDER BY tombstone_id");
    for (const column of TOMBSTONE_COLUMNS) expect(select).toContain(column);
  });

  it("resolves a referenced tombstone through the real request store", async () => {
    const h = realHarness([tombstoneOf()], [requestOf()]);
    const page = await h.reconciler.auditTombstones();
    expect(page.findings).toEqual([]);
    const select = h.sql().find((s) => s.includes("FROM meta.gdpr_deletion_requests"));
    expect(select).toContain("WHERE request_id = $1");
    for (const column of REQUEST_COLUMNS) expect(select).toContain(column);
  });
});
