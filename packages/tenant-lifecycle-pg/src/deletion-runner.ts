import type { DeletionCapabilities, GdprDeletionRequest } from "@crossengin/tenant-lifecycle";

import { DeletionPipelineAborted, type DeleteTenantOutcome } from "./deletion-pipeline.js";
import type { PostgresDeletionRequestStore } from "./deletion-request-store.js";

/**
 * Running verified deletion requests out of band, so the pipeline's transaction is not inside an HTTP
 * request.
 *
 * ADR-0320 named the problem it created: the atomic pipeline holds `ACCESS EXCLUSIVE` on a tenant's
 * tables plus a full `count(*)`, and behind an HTTP request that can outlast a proxy timeout — after
 * which the client has no way to learn the receipt it is obliged to keep. A longer timeout does not
 * fix it; the caller holding a *handle* does.
 *
 * So the handle is the `GdprDeletionRequest`, and this is what works through them:
 *
 *   `verified` → `in_progress` → run the pipeline → `completed` (naming the tombstone) / `rejected`
 *
 * The ordering of those writes is the whole design, and it is the opposite of what reads naturally.
 *
 * **`in_progress` is claimed first, and the claim is what makes the run exclusive.** The store
 * re-asserts `status = 'verified'` inside the `UPDATE`, so of two schedulers reading the same request
 * only one transition succeeds; the loser gets `null` and skips. Nothing else serialises this — there
 * is no advisory lock here, because the row *is* the lock.
 *
 * **A crash between the claim and the pipeline leaves the request `in_progress` forever.** That is
 * deliberate and it is the safe direction. `in_progress` means "a deletion may be half-done", and the
 * pipeline is atomic so it is actually either done or not — but *this* process cannot know which, and
 * re-running on the assumption that it failed would attempt a second deletion. A human reconciles it
 * by reading whether a tombstone exists for that tenant. `DELETION_REQUEST_TRANSITIONS` offers
 * `in_progress → completed | rejected` and nothing back to `verified`, which is the contract agreeing.
 *
 * **A `DeletionPipelineAborted` is the exception to that, and the distinction is the point.** It is
 * raised by the pipeline *inside* `conn.transaction`, so receiving it proves the transaction rolled
 * back — the tenant is untouched, and the refusal that caused it (an unattested subsystem, an empty
 * scope) will refuse the same way on every retry. That is a terminal, knowable refusal, so the request
 * is marked `rejected` rather than left `in_progress`. Anything *else* thrown — a connection lost at
 * commit time — is genuinely unknown, and only that gets the open-ended `aborted`. Found live: a
 * tenant with no schema of its own refused `assemble/scope_empty` and left its request stuck
 * `in_progress`, which is precisely the state ADR-0320's caller could not learn anything from.
 *
 * **`completed` is written after the pipeline commits, so a failure to write it leaves a real
 * deletion recorded as `in_progress`.** Visible and reconcilable, and the tombstone is the truth
 * either way — the same trade ADR-0320 made for retiring the tenant row.
 */

export const RUN_OUTCOMES = [
  /** Claimed, pipeline committed, request marked `completed` with its tombstone. */
  "completed",
  /**
   * Claimed and the pipeline refused; request marked `rejected` with the reason. Covers both an erase
   * refusal (nothing was dropped) and a `DeletionPipelineAborted` (the drop ran inside the transaction
   * and rolled back with it) — in both the tenant is provably untouched and a retry would refuse
   * identically, which is what makes `rejected` the honest terminal state.
   */
  "rejected",
  /** Another worker claimed it first. Not an error. */
  "not_claimed",
  /**
   * The pipeline committed and the `completed` write did not. The deletion happened; the request
   * still reads `in_progress`.
   */
  "completed_unrecorded",
  /**
   * The pipeline threw something that is **not** its own refusal — a connection lost at commit time,
   * say. Whether the deletion committed is unknown, so the request is left `in_progress` for a human.
   */
  "aborted",
] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

export interface DeletionRunResult {
  readonly requestId: string;
  readonly tenantId: string;
  readonly outcome: RunOutcome;
  readonly tombstoneId: string | null;
  readonly detail: string | null;
}

export interface DeletionRunnerOptions {
  readonly store: PostgresDeletionRequestStore;
  /** Runs the atomic pipeline. Injected, so the runner needs no `operate-runtime-pg`. */
  readonly run: (input: {
    readonly tenantId: string;
    readonly tombstoneId: string;
    readonly executedBy: string;
    readonly approvedBy: string;
    readonly relatedDeletionRequestId: string;
    readonly capabilities: DeletionCapabilities;
  }) => Promise<DeleteTenantOutcome>;
  /**
   * The actor the scheduler runs as. It is **not** the request's `submittedBy`: a data subject asking
   * for erasure is not the party executing it, and four-eyes is between the executor and the
   * approver, not between either and the subject.
   */
  readonly executedBy: string;
  /** Who authorised unattended execution. Must differ from `executedBy` — four-eyes still applies. */
  readonly approvedBy: string;
  readonly newTombstoneId: () => string;
  /** Subsystems every deletion must cover beyond `tenant_schema`. Default none. */
  /**
   * What this deployment holds (ADR-0328). **Required**, where `requiredSubsystems` was optional
   * with `?? []` — which meant every scheduled deletion declared five of the six subsystems out of
   * scope by omission, and signed an anchored proof that was silent about them.
   */
  readonly capabilities: DeletionCapabilities;
  readonly clock?: () => Date;
  readonly onRun?: (result: DeletionRunResult) => void;
}

function detailOf(err: unknown): string {
  const refusals = (err as { refusals?: unknown } | null)?.refusals;
  if (Array.isArray(refusals)) {
    return refusals
      .map((r) => {
        const row = r as { stage?: unknown; reason?: unknown };
        return `${String(row.stage ?? "?")}/${String(row.reason ?? "?")}`;
      })
      .join("; ");
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Drives one verified request through to a terminal state.
 *
 * Refuses at construction if the executor is also the approver, rather than per request: a scheduler
 * configured to approve its own work would fail every run identically, and failing at wiring says so
 * once.
 */
export class DeletionRunner {
  private readonly opts: DeletionRunnerOptions;

  constructor(opts: DeletionRunnerOptions) {
    if (opts.executedBy === opts.approvedBy) {
      throw new Error(
        "a deletion runner's executedBy must differ from approvedBy (four-eyes principle)",
      );
    }
    this.opts = opts;
  }

  private now(): string {
    return (this.opts.clock ?? ((): Date => new Date()))().toISOString();
  }

  async runOne(request: GdprDeletionRequest): Promise<DeletionRunResult> {
    const base = { requestId: request.id, tenantId: request.tenantId };
    const claimed = await this.opts.store.transition(request.id, "in_progress", { at: this.now() });
    if (claimed === null) {
      // Another worker's `UPDATE … WHERE status = 'verified'` matched first. The row is the lock.
      return this.report({ ...base, outcome: "not_claimed", tombstoneId: null, detail: null });
    }

    const tombstoneId = this.opts.newTombstoneId();
    let outcome: DeleteTenantOutcome;
    try {
      outcome = await this.opts.run({
        tenantId: request.tenantId,
        tombstoneId,
        executedBy: this.opts.executedBy,
        approvedBy: this.opts.approvedBy,
        relatedDeletionRequestId: request.id,
        capabilities: this.opts.capabilities,
      });
    } catch (err) {
      const detail = detailOf(err);
      if (err instanceof DeletionPipelineAborted) {
        // Raised inside the pipeline's own transaction, so this *proves* the rollback: the tenant is
        // untouched and the refusal is deterministic. Terminal, therefore, and recorded as such —
        // leaving it `in_progress` would strand a caller polling a handle that will never move.
        await this.opts.store.transition(request.id, "rejected", {
          at: this.now(),
          rejectedReason: `rolled back: ${detail}`.slice(0, 500),
        });
        return this.report({ ...base, outcome: "rejected", tombstoneId: null, detail });
      }
      // Anything else: whether the deletion committed is unknown, and re-running on the assumption
      // that it failed is how a tenant gets deleted twice. Left `in_progress` on purpose — the
      // contract offers no way back to `verified`, which is the contract agreeing.
      return this.report({ ...base, outcome: "aborted", tombstoneId: null, detail });
    }

    if (!outcome.ok) {
      const detail = outcome.refusals.map((r) => `${r.stage}/${r.reason}`).join("; ");
      await this.opts.store.transition(request.id, "rejected", {
        at: this.now(),
        rejectedReason: detail.slice(0, 500),
      });
      return this.report({ ...base, outcome: "rejected", tombstoneId: null, detail });
    }

    const stored = outcome.stored;
    try {
      await this.opts.store.transition(request.id, "completed", {
        at: this.now(),
        tombstoneId: stored.record.id,
        // The proof's digest beside its id: one finds the tombstone, the other commits to it, and
        // the contract wants both on a completed request.
        completionSha256: stored.record.proofSha256,
      });
    } catch (err) {
      return this.report({
        ...base,
        outcome: "completed_unrecorded",
        tombstoneId: stored.record.id,
        detail: detailOf(err),
      });
    }
    return this.report({
      ...base,
      outcome: "completed",
      tombstoneId: stored.record.id,
      detail: null,
    });
  }

  /**
   * Runs the due requests, one at a time.
   *
   * Serial on purpose. Each deletion takes `ACCESS EXCLUSIVE` on a whole tenant's tables and reads
   * every row to count them; running several at once multiplies that against one connection pool for
   * no gain, since the work is bounded by the database either way.
   */
  async runDue(limit = 10): Promise<readonly DeletionRunResult[]> {
    const due = await this.opts.store.dueForExecution(limit);
    const results: DeletionRunResult[] = [];
    for (const request of due) {
      results.push(await this.runOne(request));
    }
    return results;
  }

  private report(result: DeletionRunResult): DeletionRunResult {
    this.opts.onRun?.(result);
    return result;
  }
}

/** Whether a run left work a human has to look at. */
export function needsReconciliation(outcome: RunOutcome): boolean {
  return outcome === "aborted" || outcome === "completed_unrecorded";
}
