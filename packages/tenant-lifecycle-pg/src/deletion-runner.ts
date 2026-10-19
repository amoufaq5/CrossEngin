import type {
  DeletionCapabilities,
  DeletionRequestStatus,
  GdprDeletionRequest,
} from "@crossengin/tenant-lifecycle";

import { DeletionPipelineAborted, type DeleteTenantOutcome } from "./deletion-pipeline.js";
import {
  DeletionRequestCommittedUnreadable,
  type PostgresDeletionRequestStore,
  type UnreadableRowReporter,
} from "./deletion-request-store.js";

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

/**
 * There are deliberately **five** outcomes and not six, and the member a sixth would have been is
 * the one this vocabulary already covers: a pipeline that committed, a status write that committed,
 * and a read-back the contract cannot represent. That is a `completed` run, because `completed` is
 * *true* of it — the deletion happened and the request is in the status it names.
 *
 * Measured, because the obvious argument for keeping it out is wrong here: `RUN_OUTCOMES` is **not**
 * a CHECK and is persisted nowhere, it has zero readers outside this module and its own test, and
 * `apps/operate-server`'s `DeletionRunnerLike` mirrors the field as a bare `string` — so a sixth
 * member would cost no migration and be a compile error in no file. The reason to refuse it is
 * therefore not what it costs but what it would *say*: a new outcome asserts a different thing
 * happened, and what happened is a completion. `needsReconciliation` would have to answer for it,
 * and the honest answer is `false` — nothing about the deletion is uncertain or mismatched — so the
 * member would change no behaviour while reading to an operator as a new failure mode.
 *
 * The condition is still reported twice over: `detail` is non-null on that `completed`, which it
 * never is on an ordinary one, and the row keeps being named by every `completedWithTombstone` sweep
 * from then on.
 *
 * That argument was made about the one call site that discriminated the condition and reads as a
 * decision about the vocabulary; it is not. `transition` raises the same error for every `to`, so the
 * question is "which outcome is true of each committed status", and
 * `OUTCOME_OF_COMMITTED_STATUS` answers it for all six — still with no sixth member, and now for a
 * stated reason rather than because three call sites had not been asked.
 */
/**
 * What a committed-but-unreadable status write means for the run, keyed on the status the `UPDATE`
 * committed.
 *
 * `transition` raises `DeletionRequestCommittedUnreadable` for **every** `to`, so the store-side fix
 * is at the class level and the runner's was not: only the `completed` call site discriminated it,
 * and `runOne` makes four. At the two `rejected` sites the row committed and the throw propagated out
 * of `runDue` into the scheduler's catch, so the request was terminal, `onRun` never saw it, **and
 * the rest of the due page was dropped** — the same "one bad row takes the page" shape this
 * increment fixes for the list read, reproduced in the run loop. At the claim site the row committed
 * `in_progress` and the deletion never ran, with the reconciler later finding it stranded: recovery
 * by accident.
 *
 * A total map rather than four `if`s, because the thing that went wrong was one site out of four
 * answering a question all four face, and the error carries `committedStatus` so the mapping has an
 * input. A sixth status must answer here instead of inheriting whichever branch a chain ended on.
 *
 * The three statuses this runner never writes — `submitted`, `verified`, `deferred` — answer
 * `aborted`, which is the honest value for a status it cannot explain having committed rather than a
 * hole left where a total map exists to prevent one (`ABAC_DENIAL_EFFECT`'s `entity_create` shape).
 *
 * `in_progress` is the claim site and the one reachable entry that is a judgement. It is `aborted`
 * and not `not_claimed`: the claim **succeeded**, so saying another worker took it is false and
 * would drop the request from every report. `aborted`'s consequences are all true of it — the row
 * reads `in_progress`, `needsReconciliation` answers `true`, and `reconcileStranded` is the sweep
 * that walks exactly that status, where the verdict will be `never_committed` and *conclusive* here
 * rather than the inference it usually is. The run deliberately stops rather than proceeding on the
 * successful claim: the row this binary just wrote is one it cannot read, and running a destructive
 * pipeline through a record the contract refuses is ADR-0327's rule — a sweep that found a bad
 * record has even less standing to act than one that found none — at the surface where acting
 * destroys a tenant's data.
 */
const OUTCOME_OF_COMMITTED_STATUS: Readonly<Record<DeletionRequestStatus, RunOutcome>> =
  Object.freeze({
    submitted: "aborted",
    verified: "aborted",
    in_progress: "aborted",
    completed: "completed",
    rejected: "rejected",
    deferred: "aborted",
  });

export const RUN_OUTCOMES = [
  /**
   * Claimed, pipeline committed, request marked `completed` with its tombstone.
   *
   * `detail` is `null` for an ordinary completion and carries the parse failure when the status
   * write committed and its read-back could not be represented — see the note above this list.
   */
  "completed",
  /**
   * Claimed and the pipeline refused; request marked `rejected` with the reason. Covers both an erase
   * refusal (nothing was dropped) and a `DeletionPipelineAborted` (the drop ran inside the transaction
   * and rolled back with it) — in both the tenant is provably untouched and a retry would refuse
   * identically, which is what makes `rejected` the honest terminal state.
   *
   * `detail` also carries the parse failure when the `rejected` write committed and its read-back
   * could not be represented, like the `completed` arm above. Reported **once**, and that is the one
   * asymmetry with `completed`: a `completed` row keeps being named by every `completedWithTombstone`
   * sweep from then on, while no sweep here walks `rejected`, so this line is the whole record of it.
   * Still `rejected`, because the alternatives are both false — the request *is* terminal and the
   * tenant is provably untouched, so `aborted` would send a human to reconcile a deletion that was
   * correctly refused, and `reconcileStranded` only walks `in_progress` so it would not find it
   * anyway.
   */
  "rejected",
  /** Another worker claimed it first. Not an error. */
  "not_claimed",
  /**
   * The pipeline committed and the `completed` write did not. The deletion happened; the request
   * still reads `in_progress`.
   *
   * Narrower than it used to be, and the narrowing is the fix: a committed status write whose
   * read-back the contract cannot represent also threw out of that `transition`, and landed here —
   * claiming the write did not happen about a transaction that had committed. `transition` raises
   * `DeletionRequestCommittedUnreadable` for that case now and this member means what it says.
   */
  "completed_unrecorded",
  /**
   * The pipeline threw something that is **not** its own refusal — a connection lost at commit time,
   * say. Whether the deletion committed is unknown, so the request is left `in_progress` for a human.
   *
   * It is also where the **claim** lands when that write committed and its row could not be read
   * back: the deletion was never started, so nothing about it is unknown, but every consequence this
   * member carries is true of it — the row reads `in_progress`, `needsReconciliation` answers `true`,
   * and `reconcileStranded` walks exactly that status. `not_claimed` would be the false reading,
   * since the claim succeeded; see `OUTCOME_OF_COMMITTED_STATUS` for why that case stops rather than
   * proceeding on it.
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
  /**
   * What to do with a due row the contract cannot represent.
   *
   * **Required**, on ADR-0371's rule for `onRefused`: such a row leaves nothing in the database
   * saying so, and it is the one condition here that is *permanent* without a human. The request
   * stays `verified`, so every later `dueForExecution` reads it and drops it again, while its
   * Article 12(3) deadline runs — a deletion that will never happen and never be reported. An
   * optional reporter defaulting to "drop it silently" is that defect restated as a default
   * (ADR-0364's addendum).
   *
   * Deliberately not folded into `onRun`: a `DeletionRunResult` needs a `requestId` and an outcome,
   * and a row the contract refused supplies neither — inventing them is the claim-with-no-evidence
   * this whole surface is about.
   */
  readonly onUnreadableRequest: UnreadableRowReporter;
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

  /**
   * One status write, with the committed-but-unreadable case lifted out of the happy path.
   *
   * Every `transition` here goes through this, which is the point: the condition is a property of
   * the *store method* and not of one target, so a call site is the wrong place to remember it and
   * three of four forgot.
   */
  private async move(
    requestId: string,
    to: DeletionRequestStatus,
    fields: { readonly at: string; readonly tombstoneId?: string; readonly completionSha256?: string; readonly rejectedReason?: string },
  ): Promise<
    | { readonly kind: "moved"; readonly request: GdprDeletionRequest | null }
    | { readonly kind: "unreadable"; readonly err: DeletionRequestCommittedUnreadable }
  > {
    try {
      return { kind: "moved", request: await this.opts.store.transition(requestId, to, fields) };
    } catch (err) {
      if (err instanceof DeletionRequestCommittedUnreadable) return { kind: "unreadable", err };
      throw err;
    }
  }

  /**
   * A committed status write whose row cannot be read back, reported as the outcome true of the
   * status that committed.
   *
   * `consequence` is the site's own clause and nothing else: the status, the parse failure and the
   * outcome all come from the error and the map, so a fifth call site cannot invent a different
   * reading of the same condition.
   */
  private reportCommittedUnreadable(
    base: { readonly requestId: string; readonly tenantId: string },
    err: DeletionRequestCommittedUnreadable,
    tombstoneId: string | null,
    consequence: string,
  ): DeletionRunResult {
    return this.report({
      ...base,
      outcome: OUTCOME_OF_COMMITTED_STATUS[err.committedStatus],
      tombstoneId,
      detail:
        `recorded '${err.committedStatus}'; the request row cannot be read back: ` +
        `${err.parseMessage}; ${consequence}`,
    });
  }

  async runOne(request: GdprDeletionRequest): Promise<DeletionRunResult> {
    const base = { requestId: request.id, tenantId: request.tenantId };
    const claim = await this.move(request.id, "in_progress", { at: this.now() });
    if (claim.kind === "unreadable") {
      // The claim committed, so this request is nobody else's — and the row it wrote is one this
      // binary cannot read, so the pipeline is not started through it. `aborted` leaves it
      // `in_progress` for `reconcileStranded`, where the verdict is conclusive.
      return this.reportCommittedUnreadable(base, claim.err, null, "the deletion was not started");
    }
    const claimed = claim.request;
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
        const moved = await this.move(request.id, "rejected", {
          at: this.now(),
          rejectedReason: `rolled back: ${detail}`.slice(0, 500),
        });
        if (moved.kind === "unreadable") {
          return this.reportCommittedUnreadable(
            base,
            moved.err,
            null,
            `the pipeline rolled back (${detail})`,
          );
        }
        return this.report({ ...base, outcome: "rejected", tombstoneId: null, detail });
      }
      // Anything else: whether the deletion committed is unknown, and re-running on the assumption
      // that it failed is how a tenant gets deleted twice. Left `in_progress` on purpose — the
      // contract offers no way back to `verified`, which is the contract agreeing.
      return this.report({ ...base, outcome: "aborted", tombstoneId: null, detail });
    }

    if (!outcome.ok) {
      const detail = outcome.refusals.map((r) => `${r.stage}/${r.reason}`).join("; ");
      const moved = await this.move(request.id, "rejected", {
        at: this.now(),
        rejectedReason: detail.slice(0, 500),
      });
      if (moved.kind === "unreadable") {
        return this.reportCommittedUnreadable(base, moved.err, null, `the pipeline refused (${detail})`);
      }
      return this.report({ ...base, outcome: "rejected", tombstoneId: null, detail });
    }

    const stored = outcome.stored;
    try {
      const moved = await this.move(request.id, "completed", {
        at: this.now(),
        tombstoneId: stored.record.id,
        // The proof's digest beside its id: one finds the tombstone, the other commits to it, and
        // the contract wants both on a completed request.
        completionSha256: stored.record.proofSha256,
      });
      // Both facts are true of this path — the pipeline committed — and what differs is whether the
      // *status write* did. `DeletionRequestCommittedUnreadable` is the store saying it did and that
      // the row it returned cannot be represented, which is a `completed` run: reporting
      // `completed_unrecorded` for it claims the write did not happen, and sends a human to re-drive
      // an Article 17 erasure that has already destroyed the data.
      if (moved.kind === "unreadable") {
        return this.reportCommittedUnreadable(
          base,
          moved.err,
          stored.record.id,
          "the deletion committed and its tombstone is anchored",
        );
      }
    } catch (err) {
      // Anything reaching here really is a write that did not land — a connection lost, a refused
      // statement — so the request still reads `in_progress` and the tombstone is the truth. The
      // committed-unreadable case no longer arrives as a throw at all: `move` lifts it out, which is
      // what made the condition the same shape at all four call sites instead of one.
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
    // A row the contract cannot represent is reported and the rest of the page still runs. It is not
    // turned into a result: `runOne` is handed a parsed `GdprDeletionRequest`, so there is no
    // request here to claim, and a run of something unreadable is not a run.
    const due = await this.opts.store.dueForExecution(this.opts.onUnreadableRequest, limit);
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
