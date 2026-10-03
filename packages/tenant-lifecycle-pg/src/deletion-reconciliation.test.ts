import type { GdprDeletionRequest } from "@crossengin/tenant-lifecycle";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_STRANDED_AFTER_MS,
  DeletionReconciler,
  RECONCILIATION_VERDICTS,
  isConclusive,
  needsOperator,
  type ReconciliationResult,
  type ReconcilerOptions,
} from "./deletion-reconciliation.js";
import type { PostgresDeletionRequestStore } from "./deletion-request-store.js";
import type { PostgresTombstoneStore, StoredTombstone } from "./tombstone-store.js";

const TENANT = "3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8";
const REQ = "dreq_abcdefgh1234";
const TOMB = "tomb_aaaabbbbccccdddd";
const PROOF = "b".repeat(64);
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

function tombstoneOf(id = TOMB): StoredTombstone {
  return {
    record: { id, tenantId: TENANT, proofSha256: PROOF },
    attestations: [],
    chainEntryHash: "c".repeat(64),
    chainSequenceNumber: 7,
  } as unknown as StoredTombstone;
}

interface Harness {
  readonly reconciler: DeletionReconciler;
  readonly transitions: Array<{ id: string; to: string; fields: Record<string, unknown> }>;
  readonly retired: string[];
  readonly strandedCalls: Array<{ olderThan: string; limit: number | undefined }>;
  readonly reported: ReconciliationResult[];
}

function harness(
  behaviour: {
    readonly evidence?: readonly StoredTombstone[];
    readonly stranded?: readonly GdprDeletionRequest[];
    readonly retires?: boolean;
    readonly retireThrows?: boolean;
  } = {},
  over: Partial<ReconcilerOptions> = {},
): Harness {
  const transitions: Array<{ id: string; to: string; fields: Record<string, unknown> }> = [];
  const retired: string[] = [];
  const strandedCalls: Array<{ olderThan: string; limit: number | undefined }> = [];
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
  } as unknown as PostgresDeletionRequestStore;
  const tombstones = {
    findForRequest: async (): Promise<readonly StoredTombstone[]> => behaviour.evidence ?? [],
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
  return { reconciler, transitions, retired, strandedCalls, reported };
}

describe("the verdicts", () => {
  it("name every outcome once, and split conclusive from operator-owned", () => {
    expect(RECONCILIATION_VERDICTS).toEqual([
      "completed_by_evidence",
      "never_committed",
      "ambiguous_evidence",
      "too_recent",
      "not_stranded",
    ]);
    // Only a present tombstone stands on its own: an absence is an inference, however old.
    expect(RECONCILIATION_VERDICTS.filter((v) => isConclusive(v))).toEqual([
      "completed_by_evidence",
    ]);
    expect(RECONCILIATION_VERDICTS.filter((v) => needsOperator(v))).toEqual([
      "never_committed",
      "ambiguous_evidence",
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
