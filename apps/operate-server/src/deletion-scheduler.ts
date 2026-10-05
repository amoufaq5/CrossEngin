import type { IntervalHandle, IntervalScheduler } from "./jwks.js";

const DEFAULT_SCHEDULER: IntervalScheduler = {
  setInterval(handler, ms) {
    const h = setInterval(handler, ms);
    (h as { unref?: () => void }).unref?.(); // don't keep the process alive
    return h;
  },
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

/**
 * The actors an unattended deletion runs as. Exported because `cli.ts` checks four-eyes against the
 * *resolved* pair — `--deletion-runner-executed-by system:retention-policy` alone would otherwise pass
 * the flag check and then throw at the runner's construction, i.e. at boot.
 */
export const DEFAULT_DELETION_EXECUTED_BY = "system:deletion-runner";
export const DEFAULT_DELETION_APPROVED_BY = "system:retention-policy";

/** Consecutive non-advancing sweep attempts that make a stall a condition rather than a blip. */
export const DEFAULT_SWEEP_STALL_ATTEMPTS = 3;

/** Structural mirror of `DeletionRunner`'s one method, so this file imports no `tenant-lifecycle-pg`. */
export interface DeletionRunnerLike {
  runDue(limit?: number): Promise<
    readonly {
      readonly requestId: string;
      readonly tenantId: string;
      readonly outcome: string;
      readonly tombstoneId: string | null;
      readonly detail: string | null;
    }[]
  >;
}

/** One page of the tombstone sweep (ADR-0327). Structural, so this file imports no store type. */
export interface TombstoneSweepPage {
  readonly examined: number;
  readonly findings: readonly {
    readonly tombstoneId: string;
    readonly tenantId: string;
    readonly reference: string;
    readonly relatedDeletionRequestId: string | null;
    readonly detail: string;
  }[];
  readonly nextAfterTombstoneId: string | null;
}

/**
 * What the tombstone sweep has covered (ADR-0328).
 *
 * The sweep is the only thing that verifies a tombstone the synchronous deletion route wrote, and
 * `verifyStoredEvidence` is the only detector for a tampered scope (ADR-0323) — so "every stored
 * Article 17 proof has been verified since <time>" is a claim someone will be asked to make, and a
 * lap is the unit it can be made in. ADR-0327 left the lap unmeasured; this is the measurement.
 */
export interface TombstoneSweepProgress {
  readonly lapsCompleted: number;
  /** Rows examined in the lap currently in progress. */
  readonly examinedThisLap: number;
  /** Rows examined in the last lap that finished, or null before the first one does. */
  readonly examinedLastLap: number | null;
  /** When the last lap finished, ISO-8601, or null. */
  readonly lastLapCompletedAt: string | null;
  /** The cursor the next page will resume from; null means "at the start of a lap". */
  readonly cursor: string | null;
  readonly findingsThisLap: number;
  /** Findings in the last lap that finished, kept because the per-lap figure is the reportable one. */
  readonly findingsLastLap: number | null;
  /**
   * Pages that **moved** the sweep's position — a new cursor, or the end of the table.
   *
   * This is the stall signal, and it is deliberately not a count of pages *taken*: a store that
   * answers the same page forever, a `limit` that resolves to 0, a cursor pinned on a row that
   * always throws — all three take pages without ever covering a row that was not covered before,
   * and a counter that incremented for them would read exactly like a healthy sweep.
   *
   * `stall` below is that reading, drawn here so a caller does not have to: if this has not changed
   * across several audit ticks the sweep is covering no new ground, and `pagesSwept` says which kind
   * — equal to this means pages are not coming back at all, ahead of it means pages come back but the
   * position does not move. A caller is **not** entitled to conclude that the rows are verifying:
   * this measures motion across the table, not the verdicts, which are what `findingsThisLap` is for.
   */
  readonly pagesAdvanced: number;
  /** Pages taken, advancing or not. Present only to tell the two stall shapes apart; see above. */
  readonly pagesSwept: number;
  /** When a page last moved the sweep's position, ISO-8601, or null. */
  readonly lastAdvanceAt: string | null;
  /**
   * The conclusion, not the numbers (ADR-0329). Null means the sweep is covering ground, or has not
   * yet been attempted often enough for an absence of motion to mean anything.
   *
   * Computed here rather than by a caller so there is one definition of "stalled": the callback below
   * delivers this same value, and a surface asked "is it stalled right now?" between ticks reads it
   * here without waiting for the next one.
   */
  readonly stall: TombstoneSweepStall | null;
}

/**
 * The two ways a sweep stops covering the table, which `pagesAdvanced` / `pagesSwept` were built to
 * separate (ADR-0328) and nothing read until ADR-0329.
 *
 * They are named rather than collapsed because the remedies share nothing. `no_pages` is a store or a
 * connection: look at `onError`, which has the exception. `pinned_cursor` is the table: pages are
 * arriving, so something about the row after `cursor` makes every page answer the same thing.
 */
export const SWEEP_STALL_KINDS = [
  /** The sweep was attempted and no page came back — the store is unreachable or every page throws. */
  "no_pages",
  /** Pages come back and the sweep's position does not move past `cursor`. */
  "pinned_cursor",
] as const;
export type SweepStallKind = (typeof SWEEP_STALL_KINDS)[number];

/**
 * A sweep that is not covering new ground, stated as a conclusion.
 *
 * Why this is worth a type of its own: the sweep is the only thing that verifies a tombstone the
 * synchronous deletion route wrote, and `verifyStoredEvidence` is the only detector there is for a
 * tampered scope (ADR-0323). So a stalled sweep means **no stored Article 17 proof is being
 * verified** — and until this existed the log stayed quiet about it, because a sweep that examines
 * nothing produces no findings and a sweep that throws produces an `onError` indistinguishable from
 * a transient blip.
 */
export interface TombstoneSweepStall {
  readonly kind: SweepStallKind;
  /**
   * Audit ticks on which the sweep was attempted since the last one that advanced.
   *
   * Counted in *attempts*, not in ticks or milliseconds: the sweep only runs on an audit tick, so a
   * figure in either of those would have to be read against `auditEveryTicks` to mean anything, and
   * an attempt is the unit in which a page either moves or does not.
   */
  readonly attemptsWithoutAdvance: number;
  /** Of those attempts, how many returned a page. Zero is exactly what makes it `no_pages`. */
  readonly pagesWithoutAdvance: number;
  readonly lastAdvanceAt: string | null;
  readonly cursor: string | null;
  readonly detail: string;
}

/**
 * One `auditCompleted` finding (ADR-0323): a *completed* request whose proof no longer stands up.
 *
 * Written out structurally here rather than imported, like `DeletionRunnerLike` above, so this file
 * depends on no `tenant-lifecycle-pg` type. Named `AuditFinding` and not `EvidenceAuditLike` because
 * `deletion-request-routes.ts` already owns that name for the same five fields, and two modules
 * re-exported through `index.ts` cannot both export one name. These are the fields
 * `DeletionEvidenceEscalator.onAuditFinding` reads, so a finding travels from here to the escalator
 * untouched.
 */
export interface AuditFinding {
  readonly requestId: string;
  readonly tenantId: string;
  readonly tombstoneId: string;
  readonly present: boolean;
  readonly detail: string;
}

/**
 * Structural mirror of `DeletionReconciler.reconcileStranded` (ADR-0322). Optional: a deployment with
 * no forensic chain has no tombstone store, so there is no evidence to reconcile from.
 */
export interface StrandedReconcilerLike {
  reconcileStranded(limit?: number): Promise<
    readonly {
      readonly requestId: string;
      readonly tenantId: string;
      readonly verdict: string;
      readonly applied: boolean;
      readonly tombstoneId: string | null;
      readonly tombstoneIds: readonly string[];
      readonly detail: string | null;
    }[]
  >;
  /**
   * The reverse direction (ADR-0323). **Optional on the mirror**, not merely optional to configure:
   * a reconciler that predates it, or a deployment that does not want the pass, leaves the audit
   * section a no-op rather than failing to typecheck or throwing at the first tick.
   */
  auditCompleted?(limit?: number): Promise<readonly AuditFinding[]>;
  /**
   * Every tombstone, whether or not a request names one (ADR-0327). Findings only.
   *
   * Optional for the same reason `auditCompleted` is: the scheduler is wired against a structural
   * mirror, so a store that does not offer it simply does not get swept.
   */
  auditTombstones?(input?: {
    readonly limit?: number;
    readonly afterTombstoneId?: string | null;
  }): Promise<TombstoneSweepPage>;
}

export interface DeletionSchedulerOptions {
  readonly runner: DeletionRunnerLike;
  /**
   * Repairs requests a previous run stranded, in the same tick. One interval and one log line for
   * one queue: a stranded request is the residue of the work this scheduler does, so a separate
   * cadence for it would be two knobs describing one thing.
   */
  readonly reconciler?: StrandedReconcilerLike;
  readonly intervalMs: number;
  /** Requests per tick. Each one is a whole tenant's data, so the default is deliberately small. */
  readonly batchSize?: number;
  readonly scheduler?: IntervalScheduler;
  readonly onError?: (err: unknown) => void;
  readonly onRun?: (results: readonly { readonly requestId: string; readonly outcome: string }[]) => void;
  readonly onReconciled?: (
    results: readonly { readonly requestId: string; readonly verdict: string }[],
  ) => void;
  /**
   * Given **every** result the pass produced, not just the applied ones, and awaited (ADR-0324).
   *
   * Escalation needs the verdicts that were *not* applied — `evidence_unverified` is the whole point
   * — so it cannot share `onReconciled`, whose rule is the opposite: log only what was written. It is
   * idempotent per episode by construction, which is what makes handing it the same finding on every
   * tick harmless.
   */
  readonly onEscalate?: (
    results: readonly {
      readonly requestId: string;
      readonly tenantId: string;
      readonly verdict: string;
      readonly tombstoneId: string | null;
      readonly tombstoneIds: readonly string[];
      readonly detail: string | null;
      /**
       * The verification's defects, carried so the escalator can grade the severity per defect
       * rather than declaring every finding `sev1` (ADR-0326). Optional: a reconciler that does not
       * report them yields the configured default.
       */
      readonly evidence?: { readonly defects: readonly string[] } | null;
    }[],
  ) => void | Promise<void>;
  /**
   * How often the reverse-direction audit runs, as a multiple of ticks. Default 0 = never.
   *
   * **A multiple of the tick rather than every tick, because the two passes do not cost the same.**
   * The forward pass is one indexed query plus a lookup per stranded row, and a stranded request is
   * time-critical — ADR-0321's `completed_unrecorded` leaves a deleted tenant reading `in_progress`.
   * `auditCompleted` re-reads and re-hashes *every* completed request's tombstone (ADR-0323: O(completed
   * requests), capped at 500 by the store), and what it looks for is a tamper on a record that is not
   * going anywhere. At the three-second cadence the live verification used, every tick would re-verify
   * the same rows ~1200 times an hour to find something that is not urgent in minutes.
   *
   * A negative, zero, fractional or non-finite value is **off**, not clamped to 1: a scheduler is
   * configured from a CLI flag, and reading a malformed number as "run the expensive pass every tick"
   * is the wrong direction to fail in.
   */
  readonly auditEveryTicks?: number;
  /**
   * Given the audit's findings, awaited, and **only** when there are some (ADR-0324's escalator is
   * what this feeds). `auditCompleted` already returns findings only — a clean audit is an empty
   * array — so this follows `onReconciled`'s rule rather than `onEscalate`'s: a clean audit is not
   * news. The *recorded* claim that an audit ran clean belongs to the route, which writes an audit row
   * either way (ADR-0313); this callback is for what was found.
   */
  readonly onAuditFindings?: (findings: readonly AuditFinding[]) => void | Promise<void>;
  /**
   * The tombstone sweep's findings (ADR-0327), reported separately because they are a different
   * fact: an `AuditFinding` names a completed *request* whose proof no longer stands up, while these
   * name a *proof* — and the ones that matter most name no request at all, which is exactly why the
   * two could not share a shape.
   */
  readonly onTombstoneFindings?: (
    page: TombstoneSweepPage,
    progress: TombstoneSweepProgress,
  ) => void | Promise<void>;
  /**
   * The sweep has stopped covering the table (ADR-0329). Awaited, like `onEscalate`.
   *
   * **Its own callback rather than a field on `onTombstoneFindings`, because the half of the failure
   * that matters most never reaches that callback at all**: a `no_pages` stall is a sweep that throws,
   * and a throw means there is no page to report. The thing most likely to notice is the tick that is
   * failing, so the news has to leave by a path that does not depend on a page having arrived.
   *
   * Handed to on **every** stalled audit tick, with `attemptsWithoutAdvance` growing. A stall is a
   * standing condition, not an event: announced once it would read as resolved by the next morning.
   * Deduping belongs to the sink, which already does it for the sweep's findings, and the growing
   * figure is what lets it show the condition hardening rather than repeat one sentence.
   */
  readonly onSweepStall?: (stall: TombstoneSweepStall) => void | Promise<void>;
  /** Forwarded as-is, so the reconciler's own default governs when it is absent. */
  readonly auditLimit?: number;
  /**
   * How many consecutive sweep attempts may fail to advance before a stall is concluded. Default 3.
   *
   * **Not 1, although a healthy sweep advances on every single page.** It does — a cursor that moved
   * advances, and the end of the table advances too, so one non-advancing page is already anomalous.
   * But the sweep is *designed* to retry a failed page from the same place (ADR-0328), so a single
   * dropped connection is the system working. Three consecutive attempts is the difference between a
   * blip and a condition, and an alarm that fires on the blip is one an operator mutes.
   *
   * A non-positive, fractional or non-finite value reads as the **default**, not as off — the
   * opposite of `auditEveryTicks` above, and deliberately. There, off is the status quo and the
   * surprise is an expensive pass running every tick; here, off is precisely the silence ADR-0328
   * named, so a malformed flag must not buy it. A deployment that does not want the alarm leaves
   * `onSweepStall` unwired.
   */
  readonly stallAfterAttempts?: number;
  /**
   * Injected, because `lastLapCompletedAt` is a figure a regulator is shown and a test must not wait
   * on the wall clock. Same shape as every other clock option in this app (`() => Date`).
   */
  readonly clock?: () => Date;
}

/**
 * Runs verified GDPR deletion requests out of band, on an interval.
 *
 * Three things it does differently from every sibling scheduler in this app, all deliberate.
 *
 * **It does not sweep on `start()`.** `JobScheduler`, `PruneScheduler` and `DeliveryScheduler` all run
 * once immediately, because a missed prune or a late notification costs nothing. This one waits a full
 * interval: a boot is the moment a misconfiguration is most likely — wrong flags, wrong actor, a
 * manifest that did not load — and the work here irreversibly destroys a tenant's data. An operator who
 * restarts the server to fix something gets an interval's grace, and no deletion is lost by waiting,
 * because the deadline is weeks away.
 *
 * **Two replicas running it is safe, and there is no lock here.** `PostgresDeletionRequestStore.transition`
 * re-asserts `status = 'verified'` inside the `UPDATE`, so of two schedulers claiming the same request
 * exactly one wins and the loser is told `not_claimed`. The row is the lock (ADR-0321).
 *
 * **Not every pass runs on every tick.** The due run and the stranded repair do; the reverse-direction
 * audit of already-completed requests (ADR-0323) runs on a multiple of the tick and is off by default,
 * because it re-hashes every completed request's tombstone to look for a tamper that is not urgent in
 * minutes. One interval with three cadences, rather than a second timer for a queue of the same work.
 */
export class DeletionScheduler {
  private handle: IntervalHandle | null = null;
  /**
   * Ticks elapsed, for the audit's cadence.
   *
   * **On the instance, and deliberately not touched by `start()` or `stop()`.** If it were reset where
   * the interval is installed, a server that restarts its schedulers — a config reload, a crash loop,
   * a `stop(); start()` pair around a manifest swap — would re-enter the audit's countdown from zero
   * every time. Because the test below increments first and then asks for a multiple, a reset is the
   * *safe* direction — it delays the pass rather than repeating it — whereas the opposite test
   * ("the counter is 0, so audit") would have made a restart loop run the expensive pass on every
   * single tick, which is the failure this comment exists to rule out. A fresh process does start at
   * zero, and that is the same grace `start()` already gives the run pass.
   */
  private ticks = 0;
  /**
   * Where the tombstone sweep stopped. Null means "start at the beginning", which is both the
   * initial state and what the end of the table resets it to — so the sweep laps rather than
   * stopping, and a tombstone tampered with after the sweep passed it is found on the next lap.
   */
  private sweepCursor: string | null = null;
  /**
   * Lap accounting (ADR-0328). On the instance and untouched by `start()`/`stop()`, for the reason
   * `ticks` is: a scheduler restarted around a config reload has not swept the table again, and a
   * counter that reset there would make a lap boundary a statement about the process rather than
   * about the table.
   */
  private lapsCompleted = 0;
  private examinedThisLap = 0;
  private examinedLastLap: number | null = null;
  private findingsThisLap = 0;
  private findingsLastLap: number | null = null;
  private lastLapCompletedAt: string | null = null;
  private pagesSwept = 0;
  private pagesAdvanced = 0;
  private lastAdvanceAt: string | null = null;
  /**
   * Stall accounting (ADR-0329), both reset by an advance.
   *
   * `attemptsWithoutAdvance` is incremented **before** the page is awaited, so a sweep that throws
   * every time still counts — that is the `no_pages` case, and a counter that only moved on success
   * would be silent for exactly the failure it exists to report. `pagesWithoutAdvance` moves only on
   * a page that came back, which is the whole of the distinction between the two kinds.
   *
   * Neither is incremented when the sweep is not wired or the audit cadence is off. A deployment
   * whose reconciler offers no `auditTombstones` has no sweep to stall, and reporting one would cry
   * wolf on every such deployment — the muted-alarm failure. That it has no sweep at all is a
   * configuration fact, visible at boot, and not this detector's to raise.
   */
  private attemptsWithoutAdvance = 0;
  private pagesWithoutAdvance = 0;

  constructor(private readonly opts: DeletionSchedulerOptions) {}

  /** A snapshot, so a caller cannot hold a view that mutates under it on the next tick. */
  sweepProgress(): TombstoneSweepProgress {
    return {
      lapsCompleted: this.lapsCompleted,
      examinedThisLap: this.examinedThisLap,
      examinedLastLap: this.examinedLastLap,
      lastLapCompletedAt: this.lastLapCompletedAt,
      cursor: this.sweepCursor,
      findingsThisLap: this.findingsThisLap,
      findingsLastLap: this.findingsLastLap,
      pagesAdvanced: this.pagesAdvanced,
      pagesSwept: this.pagesSwept,
      lastAdvanceAt: this.lastAdvanceAt,
      stall: this.stall(),
    };
  }

  /**
   * The conclusion, or null.
   *
   * **An idle sweep is not a stalled one, and the two look identical to a cursor check.** An empty
   * tombstone table answers one short page per tick and so laps every tick, with a null cursor before
   * and after; a table that fits in one page does the same. Both are working sweeps covering the whole
   * table every time. `pagesAdvanced` is the counter that tells them apart from a pinned one, because
   * the end of the table counts as motion (ADR-0328) — which is why this reads it rather than
   * comparing cursors, and why `attemptsWithoutAdvance` stays 0 for both of those deployments
   * forever.
   */
  private stall(): TombstoneSweepStall | null {
    if (this.attemptsWithoutAdvance < this.stallAfterAttempts()) return null;
    const attempts = this.attemptsWithoutAdvance.toString();
    const detail =
      this.pagesWithoutAdvance === 0
        ? `${attempts} sweep attempts returned no page, so no stored Article 17 proof is being verified; the last exception is on onError`
        : `${this.pagesWithoutAdvance.toString()} pages came back over ${attempts} attempts without moving past ${this.sweepCursor ?? "the start of the table"}, so the rows beyond it are never verified`;
    return {
      kind: this.pagesWithoutAdvance === 0 ? "no_pages" : "pinned_cursor",
      attemptsWithoutAdvance: this.attemptsWithoutAdvance,
      pagesWithoutAdvance: this.pagesWithoutAdvance,
      lastAdvanceAt: this.lastAdvanceAt,
      cursor: this.sweepCursor,
      detail,
    };
  }

  start(): void {
    if (this.handle !== null) return;
    this.handle = this.scheduler().setInterval(() => void this.runOnce(), this.opts.intervalMs);
  }

  stop(): void {
    if (this.handle === null) return;
    this.scheduler().clearInterval(this.handle);
    this.handle = null;
  }

  async runOnce(): Promise<void> {
    try {
      const results = await this.opts.runner.runDue(this.opts.batchSize ?? 5);
      if (results.length > 0) this.opts.onRun?.(results);
    } catch (err) {
      // A failed tick must not throw out of the timer. The next one re-reads what is due, and a
      // request this tick claimed but did not finish stays `in_progress` until it is reconciled.
      this.opts.onError?.(err);
    }
    // Separately, and after: a reconciliation pass must still happen on a tick whose `runDue` threw,
    // because the most likely reason a request is stranded is that a run failed.
    try {
      const assessed = (await this.opts.reconciler?.reconcileStranded(this.opts.batchSize ?? 5)) ?? [];
      // Only what was actually written. A `too_recent` or an operator-owned verdict is a standing
      // fact about a row, so reporting it from here would repeat it every single tick for as long as
      // the row exists — that is what `GET /v1/platform/deletion-requests/stranded` is for.
      const repaired = assessed.filter((r) => r.applied);
      if (repaired.length > 0) this.opts.onReconciled?.(repaired);
      // Separately again, and awaited: a finding that warrants an incident must not be lost because
      // the logging callback threw, and escalation is given every result rather than the written ones.
      if (assessed.length > 0) await this.opts.onEscalate?.(assessed);
    } catch (err) {
      this.opts.onError?.(err);
    }
    // Counted before the audit is considered, and counted on every tick whatever the cadence is, so
    // the number means "ticks elapsed" and not "ticks since the last audit".
    this.ticks += 1;
    // A third separate `try`, for the same reason the first two are separate — a throw in one pass must
    // not skip the others — and this is the pass most likely to throw: `auditCompleted` re-parses stored
    // rows, and a row bad enough to fail parsing is itself the finding this pass exists to surface.
    try {
      await this.auditOnce();
    } catch (err) {
      this.opts.onError?.(err);
    }
  }

  /**
   * The reverse-direction audit (ADR-0323), on its own cadence.
   *
   * The first audit lands on the `auditEveryTicks`-th tick, never on the first: incrementing *before*
   * the modulo is what makes that true, where a counter tested at zero would audit at boot. The run
   * pass declines to sweep at boot because the work is irreversible (ADR-0321); this pass only reads,
   * so the reason is weaker — but a boot is still when a misconfiguration is most likely, and an audit
   * that fires on every restart is noise an operator learns to ignore. Consistency wins.
   */
  private async auditOnce(): Promise<void> {
    const every = this.auditEveryTicks();
    if (every === 0 || this.ticks % every !== 0) return;
    // Its own `try`, so a throwing `auditCompleted` does not take the sweep down with it — and that
    // is not hypothetical: ADR-0323's whole point is that the audit re-parses stored rows and an
    // unparseable row *is* the finding, so the direction most likely to throw was the one sharing a
    // `try` with the sweep. The cursor would never advance either, so the sweep would never run at
    // all while `onError` fired every tick: an audit that looks like it is running. ADR-0322's own
    // precedent is a separate `try` per pass, for the same reason.
    try {
      const findings = (await this.opts.reconciler?.auditCompleted?.(this.opts.auditLimit)) ?? [];
      if (findings.length > 0) await this.opts.onAuditFindings?.(findings);
    } catch (err) {
      this.opts.onError?.(err);
    }
    // The sweep's own `try`, so the stall check below runs on a tick whose page threw — which is not
    // a refinement but the whole of the `no_pages` case (ADR-0329). Before this, a sweep that threw
    // every time left `auditOnce` through `runOnce`'s catch and the one surface that could have said
    // "no proof is being verified" was never reached, on exactly the ticks it was true.
    try {
      await this.sweepOnce();
    } catch (err) {
      this.opts.onError?.(err);
    }
    try {
      const stall = this.stall();
      if (stall !== null) await this.opts.onSweepStall?.(stall);
    } catch (err) {
      this.opts.onError?.(err);
    }
  }

  /**
   * One page of the tombstone sweep per audit tick, resumed from where the last page stopped.
   *
   * Deliberately **one page**, not the whole table: the table only grows and is never pruned, so a
   * full sweep per tick would make the scheduler's cost rise forever and eventually make the tick
   * longer than its interval. A page per tick walks the table at a steady rate and starts over when
   * it reaches the end, which is the right shape for a standing audit — a tampered row is found
   * within one lap rather than immediately, and nothing else finds it at all.
   *
   * Reported even when clean, unlike `auditCompleted` above, because the *examined* count is the
   * claim: "we verified 412 proofs this lap" is what an auditor can use, and ADR-0323's rule is that
   * it cannot be inferred from the absence of a log line. The lap is also what makes that claim
   * bounded in time, which is why the page is accounted for in `sweepProgress()` (ADR-0328) rather
   * than only handed to a callback that may not be wired.
   */
  private async sweepOnce(): Promise<void> {
    const sweep = this.opts.reconciler?.auditTombstones;
    const reconciler = this.opts.reconciler;
    if (sweep === undefined || reconciler === undefined) return;
    const resumedFrom = this.sweepCursor;
    // Before the await, and the only counter that is: an attempt that throws is still an attempt, and
    // a `no_pages` stall is made of nothing else.
    this.attemptsWithoutAdvance += 1;
    const page = await sweep.call(reconciler, {
      ...(this.opts.auditLimit !== undefined ? { limit: this.opts.auditLimit } : {}),
      ...(this.sweepCursor !== null ? { afterTombstoneId: this.sweepCursor } : {}),
    });
    // Everything below happens *after* the await, which is the whole of rule 3 (ADR-0328): a page
    // that threw examined nothing, so it must leave the cursor and every counter exactly as they
    // were and be retried from the same place. The cursor already behaved this way; the counters now
    // behave the same way for the same reason, because a sweep whose figures move on a page that
    // never arrived is the "looks like it is running" failure this accounting exists to expose.
    const at = this.nowIso();
    this.pagesSwept += 1;
    this.pagesWithoutAdvance += 1;
    this.examinedThisLap += page.examined;
    this.findingsThisLap += page.findings.length;
    // Null means the page did not fill, i.e. the end of the table — so the next lap starts over.
    // Lap accounting keys on this same signal and derives nothing of its own: two sources of truth
    // for "the lap ended" is how they come to disagree.
    const lapCompleted = page.nextAfterTombstoneId === null;
    this.sweepCursor = page.nextAfterTombstoneId;
    // The end of the table counts as motion even though the cursor lands back on null, because a lap
    // finishing is the one thing that most certainly is not a stall.
    if (lapCompleted || page.nextAfterTombstoneId !== resumedFrom) {
      this.pagesAdvanced += 1;
      this.lastAdvanceAt = at;
      // Both, and here rather than in two places: motion is what clears a stall, and a counter left
      // standing would keep the conclusion up over a sweep that has recovered.
      this.attemptsWithoutAdvance = 0;
      this.pagesWithoutAdvance = 0;
    }
    if (lapCompleted) {
      this.lapsCompleted += 1;
      // Taken before the reset, in this order: the running figure *is* the finished lap's total, and
      // resetting first would destroy the only number the caller actually wants.
      this.examinedLastLap = this.examinedThisLap;
      this.findingsLastLap = this.findingsThisLap;
      this.examinedThisLap = 0;
      this.findingsThisLap = 0;
      this.lastLapCompletedAt = at;
    }
    // Given the progress as well as the page, so a sink can log "lap 3 complete, 412 proofs
    // verified" — the claim — rather than only this page's slice of it. Accounted first, so the
    // snapshot the callback sees already includes this page and its lap boundary.
    await this.opts.onTombstoneFindings?.(page, this.sweepProgress());
  }

  private nowIso(): string {
    return (this.opts.clock ?? ((): Date => new Date()))().toISOString();
  }

  private stallAfterAttempts(): number {
    const after = this.opts.stallAfterAttempts ?? DEFAULT_SWEEP_STALL_ATTEMPTS;
    return Number.isInteger(after) && after > 0 ? after : DEFAULT_SWEEP_STALL_ATTEMPTS;
  }

  private auditEveryTicks(): number {
    const every = this.opts.auditEveryTicks ?? 0;
    return Number.isInteger(every) && every > 0 ? every : 0;
  }

  private scheduler(): IntervalScheduler {
    return this.opts.scheduler ?? DEFAULT_SCHEDULER;
  }
}
