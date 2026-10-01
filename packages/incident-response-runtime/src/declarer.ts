import { formatIncidentId, type IncidentRecord } from "@crossengin/incident-response";

import { SystemClock, type Clock } from "./clock.js";
import { IncidentExecutor, type DeclareIncidentInput } from "./executor.js";

/** A declaration with everything but the id, because choosing the id is the declarer's job. */
export type IncidentDeclarationRequest = Omit<DeclareIncidentInput, "id">;

/**
 * What became of an auto-declared incident once its triggering signal recovered. `failed` is for a
 * caller that could not reach the store: the row stays open, where a human will find it, rather
 * than the recovery being reported as a clean close.
 */
export const INCIDENT_CLOSE_OUTS = [
  "unpersisted",
  "cancelled",
  "human_owned",
  "failed",
] as const;
export type IncidentCloseOut = (typeof INCIDENT_CLOSE_OUTS)[number];

export interface IncidentCloseOutInput {
  readonly reason: string;
  readonly actorUserId: string;
  readonly at?: string;
}

/**
 * Who chooses an auto-declared incident's id and decides whether the record outlives the process.
 *
 * An automated declarer — an SLO burn loop, a latency budget, an integrity proof — cannot mint its
 * own id once the records are stored, because a counter in this process restarts at `0001` while
 * the rows do not. So the id comes from here, and the caller uses the id on the record it gets
 * back rather than one it chose itself: that is the only arrangement in which the id in the log
 * line and the id on the stored row are the same incident.
 *
 * `declare` is async even for the in-memory implementation. The seam has one shape, so swapping a
 * store-backed declarer in cannot change the control flow of the loop that uses it.
 */
export interface IncidentDeclarer {
  declare(request: IncidentDeclarationRequest): Promise<IncidentRecord>;
  /**
   * Closes out an incident whose signal recovered, returning what became of it. An incident nobody
   * took is cancelled; one a human has triaged is left alone (`human_owned`), because `triaged`
   * requires the on-call roles to be assigned and no automated recovery can claim a response that
   * never happened.
   */
  closeOut(incidentId: string, input: IncidentCloseOutInput): Promise<IncidentCloseOut>;
}

export interface CountingIncidentDeclarerOptions {
  readonly clock?: Clock;
  readonly executor?: IncidentExecutor;
}

/**
 * The declarer for a loop with nothing behind it: ids from a per-year counter in this process, and
 * no record to close out.
 *
 * The counter is safe here for exactly one reason — nothing stores what it names. A restart
 * re-issues `INC-YYYY-0001`, which collides with a stored row and matters the moment a record is
 * persisted; that is what `PostgresIncidentDeclarer` exists for. This one keeps an offline engine
 * runnable and its tests deterministic.
 */
export class CountingIncidentDeclarer implements IncidentDeclarer {
  private readonly clock: Clock;
  private readonly executor: IncidentExecutor;
  private readonly sequenceByYear = new Map<number, number>();

  constructor(opts: CountingIncidentDeclarerOptions = {}) {
    this.clock = opts.clock ?? new SystemClock();
    this.executor = opts.executor ?? new IncidentExecutor({ clock: this.clock });
  }

  async declare(request: IncidentDeclarationRequest): Promise<IncidentRecord> {
    const at = request.declaredAt ?? this.clock.nowIso();
    const year = new Date(at).getUTCFullYear();
    const next = (this.sequenceByYear.get(year) ?? 0) + 1;
    this.sequenceByYear.set(year, next);
    return this.executor.declare({
      ...request,
      id: formatIncidentId(year, next),
      declaredAt: at,
    });
  }

  async closeOut(): Promise<IncidentCloseOut> {
    return "unpersisted";
  }
}
