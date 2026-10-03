import type { GdprDeletionRequest } from "@crossengin/tenant-lifecycle";

import type { PostgresDeletionRequestStore } from "./deletion-request-store.js";
import type { PostgresTombstoneStore, StoredTombstone } from "./tombstone-store.js";

/**
 * Resolving a deletion request that a run left `in_progress`, from evidence rather than from a guess.
 *
 * ADR-0321 built the handle and named what it did not finish: a run that threw something other than
 * the pipeline's own refusal leaves the request `in_progress` forever, because *that process* cannot
 * know whether the deletion committed and re-running on an assumption is how a tenant gets deleted
 * twice. `dueForExecution` only looks at `verified`, so such a request is then never seen again by
 * anything, and an operator resolves it by hand in SQL.
 *
 * **The evidence settles it, and this is the whole decision.** The pipeline writes the tombstone in
 * the *same transaction* as the `DROP SCHEMA` (ADR-0319), and ADR-0321 put the request's id on the
 * tombstone as `relatedDeletionRequestId`. Therefore:
 *
 *   **a tombstone naming the request exists ⟺ that request's deletion committed.**
 *
 * So nothing here infers from the tenant's schema being absent, or from a log line, or from how long
 * ago the run was: it asks the tombstone table one question. A process that died between the commit
 * and the status write left the answer behind in the database.
 *
 * **Presence and absence are not symmetric, and that asymmetry is the second decision.** A tombstone
 * is conclusive the moment it exists, at any age — recording a deletion that demonstrably happened
 * destroys nothing. An *absence* is only an inference, because "not committed" and "not committed
 * yet" look identical: a pipeline still running right now has written no tombstone either. So
 * `never_committed` is gated behind a staleness window, is never applied automatically, and is
 * reported as a distinct verdict so a caller can see it is reasoning from silence.
 *
 * The same shape as ADR-0315's two answers to "what if we cannot tell?" — each correct for its
 * position, and deliberately not reconciled into one rule.
 */

export const RECONCILIATION_VERDICTS = [
  /** Exactly one tombstone names the request: the deletion committed. Conclusive at any age. */
  "completed_by_evidence",
  /**
   * No tombstone names it and it has been stranded longer than the window, so the transaction did
   * not commit and the tenant is untouched. An inference from absence, not evidence.
   */
  "never_committed",
  /**
   * More than one tombstone names it. The premise above is broken, so nothing is chosen — two
   * deletions of one tenant is a finding, not a row to pick from.
   */
  "ambiguous_evidence",
  /** Stranded for less than the window and no tombstone: a run may still be in flight. */
  "too_recent",
  /** Not `in_progress` at all, so there is nothing to reconcile. */
  "not_stranded",
] as const;
export type ReconciliationVerdict = (typeof RECONCILIATION_VERDICTS)[number];

/** Verdicts whose evidence stands on its own, so applying them needs no operator judgement. */
export function isConclusive(verdict: ReconciliationVerdict): boolean {
  return verdict === "completed_by_evidence";
}

/** Verdicts a human has to look at. */
export function needsOperator(verdict: ReconciliationVerdict): boolean {
  return verdict === "never_committed" || verdict === "ambiguous_evidence";
}

/**
 * How long a request must have been `in_progress` before an absence of evidence is taken to mean
 * anything. Deliberately far longer than any pipeline run: the cost of waiting is a row that stays
 * visible on a list, and the cost of being wrong is a request marked `rejected` while its deletion
 * was still committing.
 */
export const DEFAULT_STRANDED_AFTER_MS = 3_600_000;

export interface ReconciliationResult {
  readonly requestId: string;
  readonly tenantId: string;
  readonly verdict: ReconciliationVerdict;
  /** The tombstone the evidence points at, when there is exactly one. */
  readonly tombstoneId: string | null;
  /** Every tombstone naming the request, so an ambiguous verdict can be investigated. */
  readonly tombstoneIds: readonly string[];
  /** Whether the verdict was written to the request. */
  readonly applied: boolean;
  /** Whether the tenant row was retired as part of applying it. `null` when not attempted. */
  readonly tenantRetired: boolean | null;
  readonly strandedForMs: number;
  readonly detail: string | null;
}

export interface ReconcilerOptions {
  readonly requests: PostgresDeletionRequestStore;
  readonly tombstones: PostgresTombstoneStore;
  /**
   * Retires the tenant row. Optional: a run that died after the commit may also have died before
   * retiring the row, and reconciliation is the only thing that will ever notice.
   */
  readonly retire?: (tenantId: string) => Promise<boolean>;
  readonly strandedAfterMs?: number;
  readonly clock?: () => Date;
  readonly onReconciled?: (result: ReconciliationResult) => void;
}

/**
 * Reads the evidence for stranded requests and, where it is conclusive, records it.
 *
 * `applyNeverCommitted` is the one thing a caller may authorise that the evidence does not: marking a
 * request `rejected` because no tombstone names it. It is off by default and belongs to an operator
 * looking at the row, never to a scheduler.
 */
export class DeletionReconciler {
  private readonly opts: ReconcilerOptions;

  constructor(opts: ReconcilerOptions) {
    this.opts = opts;
  }

  private now(): Date {
    return (this.opts.clock ?? ((): Date => new Date()))();
  }

  private window(): number {
    return this.opts.strandedAfterMs ?? DEFAULT_STRANDED_AFTER_MS;
  }

  /** The verdict alone, writing nothing. */
  async assess(request: GdprDeletionRequest): Promise<ReconciliationResult> {
    return this.assessWith(request, await this.evidenceFor(request));
  }

  private async evidenceFor(request: GdprDeletionRequest): Promise<readonly StoredTombstone[]> {
    return request.status === "in_progress"
      ? this.opts.tombstones.findForRequest(request.id)
      : [];
  }

  private assessWith(
    request: GdprDeletionRequest,
    found: readonly StoredTombstone[],
  ): ReconciliationResult {
    const base = {
      requestId: request.id,
      tenantId: request.tenantId,
      applied: false,
      tenantRetired: null,
    };
    const strandedForMs =
      request.inProgressAt === null
        ? 0
        : Math.max(0, this.now().getTime() - new Date(request.inProgressAt).getTime());

    if (request.status !== "in_progress") {
      return {
        ...base,
        verdict: "not_stranded",
        tombstoneId: null,
        tombstoneIds: [],
        strandedForMs,
        detail: `status is ${request.status}`,
      };
    }

    const ids = found.map((t) => t.record.id);

    if (found.length > 1) {
      return {
        ...base,
        verdict: "ambiguous_evidence",
        tombstoneId: null,
        tombstoneIds: ids,
        strandedForMs,
        detail: `${found.length.toString()} tombstones name this request`,
      };
    }
    const only = found[0];
    if (only !== undefined) {
      // Conclusive, and conclusive immediately: the tombstone and the drop committed together, so its
      // existence is not a hint about what probably happened.
      return {
        ...base,
        verdict: "completed_by_evidence",
        tombstoneId: only.record.id,
        tombstoneIds: ids,
        strandedForMs,
        detail: null,
      };
    }
    if (strandedForMs < this.window()) {
      return {
        ...base,
        verdict: "too_recent",
        tombstoneId: null,
        tombstoneIds: [],
        strandedForMs,
        detail: `stranded for ${strandedForMs.toString()}ms; the window is ${this.window().toString()}ms`,
      };
    }
    return {
      ...base,
      verdict: "never_committed",
      tombstoneId: null,
      tombstoneIds: [],
      strandedForMs,
      detail: "no tombstone names this request, so its transaction did not commit",
    };
  }

  /**
   * Assesses one request and writes the verdict where it may.
   *
   * `completed_by_evidence` is applied whatever the caller asked, because it is a record of something
   * that already happened and withholding it leaves a deleted tenant's request reading `in_progress`.
   */
  async reconcileOne(
    request: GdprDeletionRequest,
    opts: { readonly applyNeverCommitted?: boolean } = {},
  ): Promise<ReconciliationResult> {
    const found = await this.evidenceFor(request);
    const assessed = this.assessWith(request, found);
    const only = found[0];
    if (assessed.verdict === "completed_by_evidence" && only !== undefined) {
      return this.report(await this.applyCompleted(request, assessed, only));
    }
    if (assessed.verdict === "never_committed" && opts.applyNeverCommitted === true) {
      await this.opts.requests.transition(request.id, "rejected", {
        at: this.now().toISOString(),
        rejectedReason: `reconciled: ${assessed.detail ?? "no tombstone"}`.slice(0, 500),
      });
      return this.report({ ...assessed, applied: true });
    }
    return this.report(assessed);
  }

  private async applyCompleted(
    request: GdprDeletionRequest,
    assessed: ReconciliationResult,
    evidence: StoredTombstone,
  ): Promise<ReconciliationResult> {
    await this.opts.requests.transition(request.id, "completed", {
      at: this.now().toISOString(),
      // Both off the tombstone itself, never recomputed: the digest a completed request commits to
      // has to be the one the stored proof carries, or the join ADR-0321 added is a lie.
      tombstoneId: evidence.record.id,
      completionSha256: evidence.record.proofSha256,
    });
    // A run that died after the commit may also have died before retiring the row, and nothing else
    // will ever notice — the deletion is not in any queue any more.
    const retired = this.opts.retire === undefined ? null : await this.retireQuietly(request.tenantId);
    return { ...assessed, applied: true, tenantRetired: retired };
  }

  private async retireQuietly(tenantId: string): Promise<boolean | null> {
    try {
      return (await this.opts.retire?.(tenantId)) ?? null;
    } catch {
      // The request is already recorded `completed` against a real tombstone; failing the whole
      // reconciliation over the row's status would undo the part that was worth doing.
      return null;
    }
  }

  /**
   * Reconciles every `in_progress` request. Conclusive verdicts only.
   *
   * Deliberately **not** filtered to the staleness window: the window governs the *inference from
   * absence*, not the listing. A request whose pipeline committed and whose status write then failed
   * is conclusive immediately, and that is the case worth fixing promptly — ADR-0321's
   * `completed_unrecorded`. A request still being worked right now appears here too and comes back
   * `too_recent`, which writes nothing.
   */
  async reconcileStranded(limit = 25): Promise<readonly ReconciliationResult[]> {
    const stranded = await this.opts.requests.stranded(this.now().toISOString(), limit);
    const results: ReconciliationResult[] = [];
    for (const request of stranded) {
      results.push(await this.reconcileOne(request));
    }
    return results;
  }

  private report(result: ReconciliationResult): ReconciliationResult {
    this.opts.onReconciled?.(result);
    return result;
  }
}

/** Re-exported so a caller need not reach into the tombstone module for the one type it reads. */
export type { StoredTombstone };
