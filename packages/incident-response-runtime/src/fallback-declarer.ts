import type { IncidentRecord } from "@crossengin/incident-response";

import type { Clock } from "./clock.js";
import {
  CountingIncidentDeclarer,
  type IncidentCloseOut,
  type IncidentCloseOutInput,
  type IncidentDeclarationRequest,
  type IncidentDeclarer,
} from "./declarer.js";

/**
 * Which of the two wrapped declarers produced a record — and therefore whether the record outlived
 * the process that declared it.
 *
 * `unknown` is for an id this wrapper did not issue: one adopted from `findOpen`, one declared
 * before a restart, or one already closed out. It is not a third kind of declarer, it is the honest
 * answer to a question this wrapper cannot answer.
 */
export const INCIDENT_DECLARER_ORIGINS = ["primary", "fallback", "unknown"] as const;
export type IncidentDeclarerOrigin = (typeof INCIDENT_DECLARER_ORIGINS)[number];

export interface FallbackIncidentDeclarerOptions {
  /** The declarer that is meant to serve, and whose records outlive the process. */
  readonly primary: IncidentDeclarer;
  /** Defaults to a `CountingIncidentDeclarer`: a record this process can name and nothing stores. */
  readonly fallback?: IncidentDeclarer;
  /** Clock for the default fallback. Ignored when `fallback` is supplied. */
  readonly clock?: Clock;
  /**
   * Reports the primary's error before the fallback is used. Without it a store outage is invisible
   * — the page goes out either way, and the only thing that says the record is not durable is this
   * callback and `servedBy`.
   */
  readonly onPrimaryFailure?: (error: unknown) => void;
}

/**
 * Declares through a primary declarer, and through a fallback when the primary cannot be reached.
 *
 * Declaring an auto-declared incident requires the store, and a store being unreachable is itself
 * the kind of outage an SLO breach or a tamper finding describes. Without this, a refused
 * declaration means no record, and no record means no id, and no id means no page: the alert is
 * delayed until the store comes back, which is exactly when nobody is watching the logs.
 *
 * **What the trade costs.** A fallback id comes from a per-process counter, so it can name a row
 * that already exists — `INC-YYYY-0001` is already taken on any database that has ever stored an
 * incident, and `idx_incidents_auto_declared_open` makes the open episode it describes impossible to
 * persist a second time anyway (ADR-0294). So the id on the page may name nothing durable, or worse,
 * something else. That is the deal: a timelier page for a possibly-colliding id, which ADR-0293
 * refused to make the default and left to the deployment. The record is deliberately **not** retried
 * into the store later — there is no queue, no backlog and no second attempt, because a retry would
 * have to choose between a colliding id and a second id for one episode. `servedBy` is how a caller
 * finds out which it got.
 */
export class FallbackIncidentDeclarer implements IncidentDeclarer {
  private readonly primary: IncidentDeclarer;
  private readonly fallback: IncidentDeclarer;
  private readonly onPrimaryFailure: ((error: unknown) => void) | undefined;
  /**
   * Which declarer issued each id this wrapper is still holding open.
   *
   * An id-keyed lookup rather than a `lastServedBy` property or a callback, for two reasons. A
   * property is read after the fact, and the SLO loop declares several surfaces in one pass, so
   * whichever declared last would overwrite the answer the earlier caller still needs. A callback
   * fires out of band and would have to be correlated back to a declaration the caller already
   * holds. The id is that correlation, the caller has it in hand the moment `declare` returns, and
   * the answer stays true until the episode is closed out — which is when `closeOut` needs it again.
   *
   * Entries live from declaration to close-out, so this holds roughly the open auto-declared
   * episodes — one per signal. An episode whose close-out never runs leaks one entry, bounded by the
   * declaration rate, which is once per episode by design.
   */
  private readonly origins = new Map<string, IncidentDeclarerOrigin>();

  constructor(opts: FallbackIncidentDeclarerOptions) {
    this.primary = opts.primary;
    this.fallback =
      opts.fallback ??
      new CountingIncidentDeclarer(opts.clock !== undefined ? { clock: opts.clock } : {});
    this.onPrimaryFailure = opts.onPrimaryFailure;
  }

  /**
   * The primary's record, or the fallback's when the primary throws.
   *
   * The fallback's call sits outside the `catch` on purpose: an error from it is this method's own
   * failure, not a primary failure to report, and must not be swallowed into a third attempt.
   */
  async declare(request: IncidentDeclarationRequest): Promise<IncidentRecord> {
    try {
      const record = await this.primary.declare(request);
      this.origins.set(record.id, "primary");
      return record;
    } catch (err) {
      this.onPrimaryFailure?.(err);
    }
    const record = await this.fallback.declare(request);
    this.origins.set(record.id, "fallback");
    return record;
  }

  /** Which declarer issued this id, or `unknown` for one this wrapper did not issue. */
  servedBy(incidentId: string): IncidentDeclarerOrigin {
    return this.origins.get(incidentId) ?? "unknown";
  }

  /**
   * The primary's answer, and nothing else.
   *
   * The fallback is not asked and a failure is not swallowed. `CountingIncidentDeclarer.findOpen`
   * answers null, and that answer is only correct because nothing it declared survived — reusing it
   * here would turn "the store could not be asked" into "the store says nothing is open", which is a
   * claim about durable rows that nothing checked. The callers already read a thrown lookup as
   * nothing open (and the partial unique index refuses the duplicate that risks), and they report
   * the error while doing so; catching it here would lose that report and leave an unreachable store
   * looking healthy.
   */
  async findOpen(autoDeclaredFor: string): Promise<IncidentRecord | null> {
    return await this.primary.findOpen(autoDeclaredFor);
  }

  /**
   * Closes out through whichever declarer issued the id.
   *
   * A fallback-minted id names no stored row, so the primary is **not** asked to close it: it would
   * either refuse, or — because the id came from a counter and may collide — cancel somebody else's
   * incident. It goes to the fallback instead, which answers `unpersisted`, so "there was nothing to
   * close" is reported rather than dressed up as a clean close.
   *
   * A primary-issued id goes to the primary and a failure propagates, for the same reason as
   * `findOpen`: the row is still open, the caller maps a throw to `failed` and reports it, and
   * answering `unpersisted` from the fallback would claim the row does not exist. The entry is kept
   * on a throw, so a later attempt still routes the same way.
   */
  async closeOut(incidentId: string, input: IncidentCloseOutInput): Promise<IncidentCloseOut> {
    const declarer = this.origins.get(incidentId) === "fallback" ? this.fallback : this.primary;
    const closeOut = await declarer.closeOut(incidentId, input);
    this.origins.delete(incidentId);
    return closeOut;
  }
}
