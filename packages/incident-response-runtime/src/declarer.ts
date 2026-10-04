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

/**
 * Whether this close-out means the alert at the paging provider should be closed too (ADR-0326).
 *
 * An escalator that paged on declaration has an open alert at PagerDuty keyed on the incident id,
 * and a recovery is the only thing that should close it. Two of the four close-outs mean the episode
 * is genuinely over and two do not, and the distinction is not "did we write a row":
 *
 * - `cancelled` — the record was closed. The alert should close with it.
 * - `unpersisted` — no record outlived the process, but the *page* did: it left over a real
 *   transport with a real `dedup_key`. The alert is no less open for the record being in-memory, so
 *   leaving it open would strand exactly the deployments with no incident store to look in.
 * - `human_owned` — the declarer refused to close it because somebody triaged it. The incident is
 *   open and owned; resolving its alert would tell the provider the opposite of what is true, and
 *   take the alert off the board of the person holding it.
 * - `failed` — the store could not be reached, so the row is still open and we do not know what
 *   state it is in. Fail closed: an alert left open is noise, an alert wrongly closed is silence.
 */
export function closeOutClosesAlert(closeOut: IncidentCloseOut): boolean {
  return closeOut === "cancelled" || closeOut === "unpersisted";
}

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
   * The open incident already declared for this signal, if any.
   *
   * A declarer holds its open episodes in memory, so a restart has forgotten them while the breach
   * is still present. Asking here before declaring is what turns "one episode, two incidents" into
   * adopting the one that already exists. A declarer with no store answers null: nothing it
   * declared outlived the process, so there is nothing to adopt.
   */
  findOpen(autoDeclaredFor: string): Promise<IncidentRecord | null>;
  /**
   * The incident with this id, if the declarer can still answer for it.
   *
   * A recovery holds an **id** and needs the **grade** the declaration was made at, because an
   * `AlertPolicy` maps a severity to a channel set — so the severity *is* the route. Resolving at a
   * guessed grade closes an alert at a provider that never had one while the rotation that really
   * was paged keeps a page nobody closed (ADR-0326). `findOpen` answers that for a signal, which is
   * what a declaration has; this answers it for an id, which is what a recovery has.
   *
   * Optional, and **absent means to a caller exactly what `null` means**: nothing to resolve. A
   * store-backed implementation may also throw, for a row it will not vouch for. All three are the
   * same instruction — leave the alert up for a human — and none of them licenses picking a grade:
   * an alert left open is noise, an alert wrongly closed is silence.
   *
   * Required would be the wrong shape, for the reason `PageChannelSender.resolve?` is optional
   * (ADR-0326): it would break every implementation and every test double at once for no gain,
   * since the only caller has to handle "cannot tell" either way.
   */
  findById?(incidentId: string): Promise<IncidentRecord | null>;
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
  /**
   * The records this process declared, so `findById` can answer for an id it minted.
   *
   * Never pruned, not even on close-out. Pruning would make the answer depend on whether a caller
   * asks before or after it closes the record out, and being answerable for an id it minted is the
   * only thing this declarer can offer a recovery. The growth is bounded by the declaration rate,
   * which is one per episode by design.
   */
  private readonly declaredById = new Map<string, IncidentRecord>();

  constructor(opts: CountingIncidentDeclarerOptions = {}) {
    this.clock = opts.clock ?? new SystemClock();
    this.executor = opts.executor ?? new IncidentExecutor({ clock: this.clock });
  }

  async declare(request: IncidentDeclarationRequest): Promise<IncidentRecord> {
    const at = request.declaredAt ?? this.clock.nowIso();
    const year = new Date(at).getUTCFullYear();
    const next = (this.sequenceByYear.get(year) ?? 0) + 1;
    this.sequenceByYear.set(year, next);
    const record = this.executor.declare({
      ...request,
      id: formatIncidentId(year, next),
      declaredAt: at,
    });
    this.declaredById.set(record.id, record);
    return record;
  }

  /**
   * The record this process declared under that id, or null.
   *
   * Honest within a process and null after a restart — and null is the *right* answer there rather
   * than a shortfall, because the id was never authoritative: a counter re-issues `INC-YYYY-0001`,
   * so an id this declarer no longer remembers is one it can conclude nothing about.
   *
   * `findOpen` deliberately does **not** answer from the same map. Its contract is that nothing it
   * declared survived, and callers depend on an adoption that never happens offline; answering from
   * memory there would have a pass adopt an incident that exists nowhere but this map.
   */
  async findById(incidentId: string): Promise<IncidentRecord | null> {
    return this.declaredById.get(incidentId) ?? null;
  }

  // Both take the interface's parameters and ignore them. Spelling them out is not ceremony: a
  // method declared with no parameters still satisfies one that has them, so the omission type-checked
  // while making every argument a caller passed unpassable — and a test that handed one over read as
  // though the value mattered.
  async findOpen(_autoDeclaredFor: string): Promise<IncidentRecord | null> {
    // Nothing stored what this declared, so a restart has genuinely lost it; claiming otherwise
    // would have the engine adopt an incident that does not exist.
    return null;
  }

  async closeOut(
    _incidentId: string,
    _input: IncidentCloseOutInput,
  ): Promise<IncidentCloseOut> {
    return "unpersisted";
  }
}
