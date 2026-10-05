import {
  CONSERVATIVE_DELETION_CAPABILITIES,
  type GdprDeletionRequest,
} from "@crossengin/tenant-lifecycle";
import { describe, expect, it } from "vitest";

import {
  DeletionRunner,
  RUN_OUTCOMES,
  needsReconciliation,
  type DeletionRunResult,
  type DeletionRunnerOptions,
} from "./deletion-runner.js";
import { DeletionPipelineAborted, type DeleteTenantOutcome } from "./deletion-pipeline.js";
import type { PostgresDeletionRequestStore } from "./deletion-request-store.js";

const TENANT = "3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8";
const REQ = "dreq_abcdefgh1234";
const TOMB = "tomb_aaaabbbbccccdddd";
const AT = "2026-10-03T14:00:00.000Z";

function requestOf(over: Partial<GdprDeletionRequest> = {}): GdprDeletionRequest {
  return {
    id: REQ,
    tenantId: TENANT,
    subjectIdentifier: "subject@example.test",
    legalBasis: "article_17_right_to_erasure",
    status: "verified",
    submittedAt: "2026-10-01T00:00:00.000Z",
    submittedBy: "subject@example.test",
    deadlineAt: "2026-10-28T00:00:00.000Z",
    verificationMethod: "email_link",
    verifiedAt: "2026-10-02T00:00:00.000Z",
    verifiedBy: "support-1",
    inProgressAt: null,
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

/**
 * The runner reads exactly two fields off a committed pipeline result — the tombstone's id and its
 * proof digest — so the fixture supplies those and borrows the rest of the shape from the type.
 */
type OkOutcome = Extract<DeleteTenantOutcome, { ok: true }>;

const OK: DeleteTenantOutcome = {
  ok: true,
  stored: {
    record: { id: TOMB, proofSha256: "b".repeat(64) },
    attestations: [],
    chainEntryHash: "c".repeat(64),
    chainSequenceNumber: 9,
  } as unknown as OkOutcome["stored"],
  erased: {
    schema: "t_abc",
    tables: ["t_abc.invoice"],
    rowCount: 26,
    storageBytes: 65536,
    alreadyAbsent: false,
  },
  erasedSharedTables: {
    schema: "meta",
    tables: ["meta.operate_entity_records"],
    rowCount: 7,
    storageBytes: 700,
    examinedTables: ["meta.operate_entity_records"],
    retainedTables: ["meta.audit_log"],
  },
};

interface Harness {
  readonly runner: DeletionRunner;
  readonly transitions: Array<{ to: string; fields: Record<string, unknown> }>;
  readonly runs: Array<Record<string, unknown>>;
  readonly reported: DeletionRunResult[];
}

function harness(
  behaviour: {
    readonly claims?: boolean;
    readonly outcome?: DeleteTenantOutcome;
    readonly runThrows?: unknown;
    readonly completeThrows?: boolean;
    readonly due?: readonly GdprDeletionRequest[];
  } = {},
  over: Partial<DeletionRunnerOptions> = {},
): Harness {
  const transitions: Array<{ to: string; fields: Record<string, unknown> }> = [];
  const runs: Array<Record<string, unknown>> = [];
  const reported: DeletionRunResult[] = [];
  const store = {
    transition: async (
      _id: string,
      to: string,
      fields: Record<string, unknown>,
    ): Promise<GdprDeletionRequest | null> => {
      transitions.push({ to, fields });
      if (to === "in_progress" && behaviour.claims === false) return null;
      if (to === "completed" && behaviour.completeThrows === true) {
        throw new Error("completed write failed");
      }
      return requestOf({ status: to as GdprDeletionRequest["status"] });
    },
    dueForExecution: async (): Promise<readonly GdprDeletionRequest[]> =>
      behaviour.due ?? [requestOf()],
  } as unknown as PostgresDeletionRequestStore;

  const runner = new DeletionRunner({
    store,
    run: async (input): Promise<DeleteTenantOutcome> => {
      runs.push({ ...input });
      if (behaviour.runThrows !== undefined) throw behaviour.runThrows;
      return behaviour.outcome ?? OK;
    },
    executedBy: "system:deletion-runner",
    approvedBy: "system:retention-policy",
    // Required since ADR-0328, where it replaced a `requiredSubsystems ?? []` that made every
    // scheduled deletion silent about five of the six subsystems.
    capabilities: CONSERVATIVE_DELETION_CAPABILITIES,
    newTombstoneId: () => TOMB,
    clock: () => new Date(AT),
    onRun: (r) => reported.push(r),
    ...over,
  });
  return { runner, transitions, runs, reported };
}

describe("construction", () => {
  it("refuses an executor who is also the approver, at wiring time", () => {
    // A scheduler configured to approve its own work would fail every run identically; failing here
    // says so once.
    expect(
      () =>
        new DeletionRunner({
          store: {} as PostgresDeletionRequestStore,
          run: async () => OK,
          capabilities: CONSERVATIVE_DELETION_CAPABILITIES,
          executedBy: "same",
          approvedBy: "same",
          newTombstoneId: () => TOMB,
        }),
    ).toThrow(/four-eyes/);
  });
});

describe("runOne", () => {
  it("claims, runs, and completes with the tombstone and its digest", async () => {
    const h = harness();
    const result = await h.runner.runOne(requestOf());
    expect(result).toEqual({
      requestId: REQ,
      tenantId: TENANT,
      outcome: "completed",
      tombstoneId: TOMB,
      detail: null,
    });
    expect(h.transitions.map((t) => t.to)).toEqual(["in_progress", "completed"]);
    const completed = h.transitions[1]?.fields;
    expect(completed?.["tombstoneId"]).toBe(TOMB);
    // One finds the tombstone, the other commits to it, and the contract wants both.
    expect(completed?.["completionSha256"]).toBe("b".repeat(64));
  });

  it("claims BEFORE running the pipeline, so the row is the lock", async () => {
    const order: string[] = [];
    const h = harness({}, {});
    // Rebuilt with ordering observation.
    const runner = new DeletionRunner({
      store: {
        transition: async (_i: string, to: string) => {
          order.push(`transition:${to}`);
          return requestOf({ status: to as GdprDeletionRequest["status"] });
        },
        dueForExecution: async () => [],
      } as unknown as PostgresDeletionRequestStore,
      run: async () => {
        order.push("pipeline");
        return OK;
      },
      capabilities: CONSERVATIVE_DELETION_CAPABILITIES,
      executedBy: "a",
      approvedBy: "b",
      newTombstoneId: () => TOMB,
    });
    await runner.runOne(requestOf());
    expect(order).toEqual(["transition:in_progress", "pipeline", "transition:completed"]);
    expect(h.runs).toEqual([]);
  });

  it("skips a request another worker claimed, without running anything", async () => {
    const h = harness({ claims: false });
    const result = await h.runner.runOne(requestOf());
    expect(result.outcome).toBe("not_claimed");
    expect(result.detail).toBeNull();
    expect(h.runs).toEqual([]);
    expect(h.transitions.map((t) => t.to)).toEqual(["in_progress"]);
  });

  it("passes the request id as the tombstone's relatedDeletionRequestId", async () => {
    const h = harness();
    await h.runner.runOne(requestOf());
    expect(h.runs[0]?.["relatedDeletionRequestId"]).toBe(REQ);
  });

  it("runs as the scheduler's actor, not as the data subject", async () => {
    const h = harness();
    await h.runner.runOne(requestOf({ submittedBy: "subject@example.test" }));
    // A data subject asking for erasure is not the party executing it, and four-eyes is between the
    // executor and the approver.
    expect(h.runs[0]?.["executedBy"]).toBe("system:deletion-runner");
    expect(h.runs[0]?.["approvedBy"]).toBe("system:retention-policy");
  });

  it("rejects the request when the pipeline refuses, recording the reason", async () => {
    const h = harness({
      outcome: {
        ok: false,
        refusals: [{ stage: "erase", reason: "external_dependents", detail: "view public.x" }],
      },
    });
    const result = await h.runner.runOne(requestOf());
    expect(result.outcome).toBe("rejected");
    expect(result.detail).toBe("erase/external_dependents");
    expect(h.transitions.map((t) => t.to)).toEqual(["in_progress", "rejected"]);
    expect(h.transitions[1]?.fields["rejectedReason"]).toContain("external_dependents");
  });

  it("rejects a request the pipeline rolled back, because the rollback is provable", async () => {
    const h = harness({
      runThrows: new DeletionPipelineAborted([
        { stage: "assemble", reason: "scope_empty", detail: "nothing was erased" },
      ]),
    });
    const result = await h.runner.runOne(requestOf());
    // `DeletionPipelineAborted` is raised inside the pipeline's transaction, so receiving it proves
    // the tenant is untouched — and the refusal would recur identically. Terminal, so `rejected`:
    // leaving it `in_progress` would strand a caller polling a handle that never moves. Found live.
    expect(result.outcome).toBe("rejected");
    expect(result.detail).toBe("assemble/scope_empty");
    expect(h.transitions.map((t) => t.to)).toEqual(["in_progress", "rejected"]);
    expect(String(h.transitions[1]?.fields["rejectedReason"])).toContain("rolled back");
  });

  it("leaves an unknown failure in_progress rather than returning it to verified", async () => {
    const h = harness({ runThrows: new Error("connection terminated at commit") });
    const result = await h.runner.runOne(requestOf());
    // Not the pipeline's own refusal, so whether it committed is unknown. The contract offers no way
    // back to `verified`, and re-running on an assumption is how a tenant gets deleted twice.
    expect(result.outcome).toBe("aborted");
    expect(result.detail).toBe("connection terminated at commit");
    expect(h.transitions.map((t) => t.to)).toEqual(["in_progress"]);
    expect(needsReconciliation(result.outcome)).toBe(true);
  });

  it("reports completed_unrecorded when the deletion committed and the status write did not", async () => {
    const h = harness({ completeThrows: true });
    const result = await h.runner.runOne(requestOf());
    // The deletion happened; the request still reads in_progress. The tombstone is the truth.
    expect(result.outcome).toBe("completed_unrecorded");
    expect(result.tombstoneId).toBe(TOMB);
    expect(needsReconciliation(result.outcome)).toBe(true);
  });

  it("reports every run through onRun", async () => {
    const h = harness();
    await h.runner.runOne(requestOf());
    expect(h.reported).toHaveLength(1);
    expect(h.reported[0]?.outcome).toBe("completed");
  });

  it("forwards the deployment's declared capabilities verbatim", async () => {
    const h = harness(
      {},
      {
        capabilities: {
          tenant_schema: "erases",
          shared_tables: "erases",
          object_storage: "absent",
          backups: "erases",
          search_indexes: "absent",
          caches: "erases",
        },
      },
    );
    await h.runner.runOne(requestOf());
    // Forwarded verbatim, including the absences: a declared `absent` is what tells a reader of the
    // proof "this deployment has no object storage" rather than "nobody asked" (ADR-0328).
    expect(h.runs[0]?.["capabilities"]).toEqual({
      tenant_schema: "erases",
      shared_tables: "erases",
      object_storage: "absent",
      backups: "erases",
      search_indexes: "absent",
      caches: "erases",
    });
  });
});

describe("runDue", () => {
  it("runs each due request serially", async () => {
    const h = harness({
      due: [requestOf({ id: "dreq_one12345678" }), requestOf({ id: "dreq_two12345678" })],
    });
    const results = await h.runner.runDue();
    expect(results.map((r) => r.requestId)).toEqual(["dreq_one12345678", "dreq_two12345678"]);
    // Serial: each deletion takes ACCESS EXCLUSIVE on a whole tenant's tables and counts every row.
    expect(h.runs).toHaveLength(2);
  });

  it("returns an empty list when nothing is due", async () => {
    const h = harness({ due: [] });
    expect(await h.runner.runDue()).toEqual([]);
    expect(h.runs).toEqual([]);
  });

  it("keeps going past a request that was not claimed", async () => {
    const h = harness({ claims: false, due: [requestOf(), requestOf({ id: "dreq_two12345678" })] });
    const results = await h.runner.runDue();
    expect(results.map((r) => r.outcome)).toEqual(["not_claimed", "not_claimed"]);
  });
});

describe("needsReconciliation", () => {
  it("flags only the two outcomes a human must look at", () => {
    expect(RUN_OUTCOMES.filter((o) => needsReconciliation(o))).toEqual([
      "completed_unrecorded",
      "aborted",
    ]);
  });
});
