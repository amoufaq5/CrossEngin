import { describe, expect, it } from "vitest";

import { JOB_RUN_STATUSES } from "./audit.js";
import {
  CANCELLABLE_JOB_RUN_STATUSES,
  CANCEL_REASON_MAX_LENGTH,
  CancelJobRunRequestSchema,
  JOB_CANCELLATION_CHECKPOINTS,
  JOB_CANCELLATION_GUARANTEES,
  JOB_CANCELLATION_PLAN_KINDS,
  JOB_HANDLER_OUTCOMES,
  JobCancellationRecordSchema,
  JobRunCancellationStateSchema,
  TERMINAL_JOB_RUN_STATUSES,
  isCancellableJobRunStatus,
  isTerminalJobRunStatus,
  jobCancellationDisposition,
  planJobCancellation,
  type JobRunCancellationState,
} from "./cancellation.js";

const RUN = "00000000-0000-4000-8000-0000000009a1";
const TENANT = "00000000-0000-4000-8000-000000000001";
const NOW = "2026-05-17T12:00:00.000Z";

function state(partial: Partial<JobRunCancellationState> = {}): JobRunCancellationState {
  return {
    status: "pending",
    claimedBy: null,
    claimExpiresAt: null,
    cancelRequestedAt: null,
    ...partial,
  };
}

describe("cancellation constants", () => {
  it("partitions every job run status into terminal or cancellable", () => {
    const union = [...TERMINAL_JOB_RUN_STATUSES, ...CANCELLABLE_JOB_RUN_STATUSES];
    expect([...union].sort()).toEqual([...JOB_RUN_STATUSES].sort());
    expect(new Set(union).size).toBe(union.length);
  });

  it("treats cancelled as terminal, not cancellable — cancelling twice cannot reopen a run", () => {
    expect(isTerminalJobRunStatus("cancelled")).toBe(true);
    expect(isCancellableJobRunStatus("cancelled")).toBe(false);
  });

  it("classifies each status exactly once", () => {
    for (const status of JOB_RUN_STATUSES) {
      expect(isTerminalJobRunStatus(status)).toBe(!isCancellableJobRunStatus(status));
    }
  });

  it("documents a guarantee for every checkpoint and nothing else", () => {
    expect(Object.keys(JOB_CANCELLATION_GUARANTEES).sort()).toEqual(
      [...JOB_CANCELLATION_CHECKPOINTS].sort(),
    );
    for (const text of Object.values(JOB_CANCELLATION_GUARANTEES)) expect(text.length).toBeGreaterThan(20);
  });

  it("enumerates four plan kinds and three handler outcomes", () => {
    expect(JOB_CANCELLATION_PLAN_KINDS).toHaveLength(4);
    expect(JOB_HANDLER_OUTCOMES).toEqual(["completed", "failed", "threw"]);
  });
});

describe("CancelJobRunRequestSchema", () => {
  it("accepts a request with an actor and an optional reason", () => {
    const parsed = CancelJobRunRequestSchema.parse({
      runId: RUN,
      tenantId: TENANT,
      requestedBy: "user:7",
      reason: "wrong period",
      requestedAt: NOW,
    });
    expect(parsed.requestedBy).toBe("user:7");
  });

  it("requires an actor, rejects a blank one and caps the reason", () => {
    expect(
      CancelJobRunRequestSchema.safeParse({ runId: RUN, tenantId: TENANT, requestedAt: NOW }).success,
    ).toBe(false);
    expect(
      CancelJobRunRequestSchema.safeParse({
        runId: RUN,
        tenantId: TENANT,
        requestedBy: "",
        requestedAt: NOW,
      }).success,
    ).toBe(false);
    expect(
      CancelJobRunRequestSchema.safeParse({
        runId: RUN,
        tenantId: TENANT,
        requestedBy: "ops",
        reason: "x".repeat(CANCEL_REASON_MAX_LENGTH + 1),
        requestedAt: NOW,
      }).success,
    ).toBe(false);
  });

  it("rejects a non-ISO requestedAt", () => {
    expect(
      CancelJobRunRequestSchema.safeParse({
        runId: RUN,
        tenantId: TENANT,
        requestedBy: "ops",
        requestedAt: "yesterday",
      }).success,
    ).toBe(false);
  });
});

describe("JobRunCancellationStateSchema", () => {
  it("accepts a nullable lease and a nullable request", () => {
    expect(JobRunCancellationStateSchema.parse(state()).claimedBy).toBeNull();
    expect(
      JobRunCancellationStateSchema.parse(
        state({ claimedBy: "worker-A", claimExpiresAt: NOW, cancelRequestedAt: NOW }),
      ).claimExpiresAt,
    ).toBe(NOW);
  });

  it("rejects an unknown status and a blank worker id", () => {
    expect(JobRunCancellationStateSchema.safeParse(state({ status: "paused" as never })).success).toBe(false);
    expect(JobRunCancellationStateSchema.safeParse(state({ claimedBy: "" })).success).toBe(false);
  });
});

describe("planJobCancellation", () => {
  it("cancels immediately when the run is pending and unclaimed", () => {
    expect(planJobCancellation(state(), NOW)).toEqual({ kind: "cancel_now" });
  });

  it("records a request when a live lease is held, naming the holder", () => {
    const plan = planJobCancellation(
      state({ claimedBy: "worker-A", claimExpiresAt: "2026-05-17T12:00:30.000Z" }),
      NOW,
    );
    expect(plan).toEqual({ kind: "request_cancel", leaseHeldBy: "worker-A" });
  });

  it("treats a lapsed lease as dead — the zombie worker's finalize is fenced by the status guard", () => {
    expect(
      planJobCancellation(state({ claimedBy: "worker-A", claimExpiresAt: "2026-05-17T11:59:59.000Z" }), NOW),
    ).toEqual({ kind: "cancel_now" });
    // Exactly-at-expiry counts as lapsed.
    expect(planJobCancellation(state({ claimedBy: "worker-A", claimExpiresAt: NOW }), NOW)).toEqual({
      kind: "cancel_now",
    });
  });

  it("is idempotent: a second request reports already_requested with the first timestamp", () => {
    const first = "2026-05-17T11:58:00.000Z";
    expect(planJobCancellation(state({ cancelRequestedAt: first }), NOW)).toEqual({
      kind: "already_requested",
      requestedAt: first,
    });
  });

  it("reports already_terminal for every terminal status, including cancelled", () => {
    for (const status of TERMINAL_JOB_RUN_STATUSES) {
      expect(planJobCancellation(state({ status }), NOW)).toEqual({ kind: "already_terminal", status });
    }
  });

  it("prefers the terminal outcome over a recorded request — a run that finished after being asked to stop reports what it did", () => {
    expect(
      planJobCancellation(state({ status: "completed", cancelRequestedAt: "2026-05-17T11:58:00.000Z" }), NOW),
    ).toEqual({ kind: "already_terminal", status: "completed" });
  });

  it("requests cancellation for a running row under a live lease", () => {
    expect(
      planJobCancellation(
        state({ status: "running", claimedBy: "worker-B", claimExpiresAt: "2026-05-17T12:00:10.000Z" }),
        NOW,
      ),
    ).toEqual({ kind: "request_cancel", leaseHeldBy: "worker-B" });
  });
});

describe("jobCancellationDisposition", () => {
  it("leaves an uncancelled run to the normal mapping whatever the handler did", () => {
    for (const handlerOutcome of JOB_HANDLER_OUTCOMES) {
      expect(jobCancellationDisposition({ handlerOutcome, cancelRequested: false })).toBe("uncancelled");
    }
  });

  it("honours a handler that finished first — cancellation never retracts completed work", () => {
    expect(jobCancellationDisposition({ handlerOutcome: "completed", cancelRequested: true })).toBe(
      "completed",
    );
  });

  it("cancels a handler that threw or returned failed under cancellation, so it is neither retried nor blamed", () => {
    expect(jobCancellationDisposition({ handlerOutcome: "threw", cancelRequested: true })).toBe("cancelled");
    expect(jobCancellationDisposition({ handlerOutcome: "failed", cancelRequested: true })).toBe("cancelled");
  });
});

describe("JobCancellationRecordSchema", () => {
  const base = {
    runId: RUN,
    tenantId: TENANT,
    requestedAt: "2026-05-17T11:58:00.000Z",
    requestedBy: "user:7",
    reason: null,
  };

  it("accepts an unhonoured request and an honoured one", () => {
    expect(
      JobCancellationRecordSchema.parse({ ...base, honouredAt: null, honouredAtCheckpoint: null })
        .honouredAt,
    ).toBeNull();
    expect(
      JobCancellationRecordSchema.parse({
        ...base,
        honouredAt: NOW,
        honouredAtCheckpoint: "cooperative_abort",
      }).honouredAtCheckpoint,
    ).toBe("cooperative_abort");
  });

  it("rejects a half-recorded honouring in both directions", () => {
    expect(
      JobCancellationRecordSchema.safeParse({ ...base, honouredAt: NOW, honouredAtCheckpoint: null })
        .success,
    ).toBe(false);
    expect(
      JobCancellationRecordSchema.safeParse({
        ...base,
        honouredAt: null,
        honouredAtCheckpoint: "before_claim",
      }).success,
    ).toBe(false);
  });

  it("rejects an honouring that precedes the request", () => {
    expect(
      JobCancellationRecordSchema.safeParse({
        ...base,
        honouredAt: "2026-05-17T11:57:00.000Z",
        honouredAtCheckpoint: "before_claim",
      }).success,
    ).toBe(false);
  });

  it("accepts an honouring in the same instant as the request", () => {
    expect(
      JobCancellationRecordSchema.safeParse({
        ...base,
        honouredAt: base.requestedAt,
        honouredAtCheckpoint: "before_claim",
      }).success,
    ).toBe(true);
  });

  it("rejects an unknown checkpoint", () => {
    expect(
      JobCancellationRecordSchema.safeParse({
        ...base,
        honouredAt: NOW,
        honouredAtCheckpoint: "mid_flight",
      }).success,
    ).toBe(false);
  });
});
