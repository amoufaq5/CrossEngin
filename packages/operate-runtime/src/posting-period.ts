import { drainList } from "./list-drain.js";
import type { EntityRecord, EntityStore } from "./store.js";

/**
 * Where a posting's fiscal period comes from, and which of its states refuse a posting.
 *
 * The lock used to be checked only on a journal entry that *named* a `fiscal_period_id`, and only by
 * the handler's guard — so every entry an effect wrote (each dated the server's "today" and naming
 * no period) went into a closed period unchecked, and a reversal copied its original's possibly
 * closed period onto an entry dated today. The period is a fact about the posting **date**, so it is
 * resolved from the date here, once, for the guard and for every effect.
 */
export interface PostingPeriodConfig {
  readonly periodEntity?: string;
  readonly statusField?: string;
  readonly startField?: string;
  readonly endField?: string;
  /** A period flagged as an adjustment period (period 13) overlaps an ordinary one and is not a posting default. */
  readonly adjustmentField?: string;
  readonly lockedStates?: readonly string[];
  /** Largest number of periods covering one date this reads before refusing; a calendar is small. */
  readonly ceiling?: number;
}

const PERIOD_DEFAULTS = {
  periodEntity: "FiscalPeriod",
  statusField: "status",
  startField: "start_date",
  endField: "end_date",
  adjustmentField: "is_adjustment",
  lockedStates: ["closed", "locked"] as readonly string[],
  ceiling: 1000,
} as const;

/** The periods covering one date, as a posting sees them. */
export type PostingPeriod =
  | { readonly kind: "open"; readonly periodId: string | null }
  | { readonly kind: "locked"; readonly status: string };

/**
 * The period a posting dated `date` belongs to.
 *
 * Candidates are the periods whose `[start, end]` covers the date, ordinary periods first: an
 * adjustment period shares its dates with the last ordinary one, and a default posting belongs to
 * the ordinary one, so adjustment periods are considered only when no ordinary period covers the
 * date. A posting is refused when **any** candidate is locked — a calendar with two ordinary periods
 * covering one day is ambiguous, and the refusing reading is the one that cannot post into a closed
 * book. The period is stamped only when exactly one candidate exists; a date no period covers posts
 * with none, which is what a tenant that keeps no fiscal calendar gets.
 *
 * **The decision is made from the locked row, not from the list read** (ADR-0480). A period's close
 * is a transition, and a transition holds its row `exclusive` (`getLocked`, ADR-0433) until it
 * commits; the list read above takes no lock, so under READ COMMITTED a posting that read `open`
 * could commit into a period whose close committed a moment later — the posting landing in a book
 * the close had already summed. So every covering row is re-read under a `share` lock, which
 * conflicts with the close's `exclusive`: a posting that locks first holds the close off until it
 * commits (the close then sees the posting), and one that locks second waits for the close and reads
 * its `closed` status, which refuses. The rows are locked in id order so two postings over the same
 * periods take their locks in one order. A row gone by the locked read, or whose dates no longer
 * cover the day, is no longer a candidate.
 *
 * The guarantee is a property of the **transaction** the caller runs in: on a store with no
 * transaction (`getLocked` outside one) the lock ends with the call and nothing is guaranteed —
 * which is `getLocked`'s own documented contract, inherited rather than restated.
 */
export async function resolvePostingPeriod(
  store: Pick<EntityStore, "listPage" | "getLocked">,
  tenantId: string,
  date: string,
  config: PostingPeriodConfig = {},
): Promise<PostingPeriod> {
  const c = { ...PERIOD_DEFAULTS, ...config };
  const day = date.slice(0, 10);
  const covering: EntityRecord[] = [];
  const outcome = await drainList(
    store,
    tenantId,
    c.periodEntity,
    {
      sort: [],
      filters: [
        { field: c.startField, op: "lte", value: day },
        { field: c.endField, op: "gte", value: day },
      ],
    },
    { ceiling: c.ceiling },
    (rows) => {
      for (const p of rows) if (coversDay(p, c.startField, c.endField, day)) covering.push(p);
    },
  );
  if (!outcome.complete) {
    throw new PostingRefused(422, "period_unresolvable", "more fiscal periods cover the posting date than could be read");
  }
  const lockedRows: EntityRecord[] = [];
  const ids = [...new Set(covering.map((p) => p["id"]).filter((id): id is string => typeof id === "string"))].sort();
  for (const id of ids) {
    const row = await store.getLocked(tenantId, c.periodEntity, id, "share");
    if (row !== null && coversDay(row, c.startField, c.endField, day)) lockedRows.push(row);
  }
  const ordinary = lockedRows.filter((p) => p[c.adjustmentField] !== true);
  const candidates = ordinary.length > 0 ? ordinary : lockedRows;
  for (const p of candidates) {
    const status = p[c.statusField];
    if (typeof status === "string" && c.lockedStates.includes(status)) return { kind: "locked", status };
  }
  return { kind: "open", periodId: candidates.length === 1 ? String(candidates[0]!["id"]) : null };
}

/** Whether a period row's `[start, end]` covers the calendar day `day` (`YYYY-MM-DD`). */
function coversDay(p: EntityRecord, startField: string, endField: string, day: string): boolean {
  const start = typeof p[startField] === "string" ? (p[startField] as string).slice(0, 10) : null;
  const end = typeof p[endField] === "string" ? (p[endField] as string).slice(0, 10) : null;
  return start !== null && end !== null && start <= day && day <= end;
}

/** Whether `period` is an adjustment period whose `[start, end]` covers `date`. */
export function isAdjustmentPeriodCovering(
  period: EntityRecord,
  date: string,
  config: PostingPeriodConfig = {},
): boolean {
  const c = { ...PERIOD_DEFAULTS, ...config };
  if (period[c.adjustmentField] !== true) return false;
  const day = date.slice(0, 10);
  const start = period[c.startField];
  const end = period[c.endField];
  return (
    typeof start === "string" && typeof end === "string" && start.slice(0, 10) <= day && day <= end.slice(0, 10)
  );
}

/**
 * A posting an effect refused, carried to the handler as a named 4xx.
 *
 * An effect runs after the write it rides on, inside its transaction, so the only way it can refuse
 * is to throw — and a bare throw is `writeTxn`'s fixed 500, which names nothing. This carries the
 * same `{status, error, detail}` a guard block does. The detail is built from literals,
 * server-chosen values (a period's state) and values from the caller's own document — a posting
 * date, a jurisdiction or tax-code label, an amount — which is what a guard block over that document
 * carries. It used to say "only literals and server-chosen values", which the tax refusals
 * (`tax-determination.ts`) are not (ADR-0432 Q6, ADR-0480); the rule that
 * holds is that a refusal must never interpolate a classified field, because the detail reaches the
 * caller verbatim.
 */
export class PostingRefused extends Error {
  readonly status: number;
  readonly error: string;
  readonly detail: string;

  constructor(status: number, error: string, detail: string) {
    super(`${error}: ${detail}`);
    this.name = "PostingRefused";
    this.status = status;
    this.error = error;
    this.detail = detail;
  }
}

export function isPostingRefused(err: unknown): err is PostingRefused {
  return err instanceof PostingRefused;
}

/** The refusal for a posting dated into a locked period, shared by the guard and the effects. */
export function periodLockedDetail(status: string, date: string): string {
  return `the posting date ${date.slice(0, 10)} falls in a fiscal period that is '${status}'`;
}

/**
 * The fiscal period to stamp on an entry an effect is about to post on `date`, or a refusal.
 *
 * `undefined` config means the manifest keeps no fiscal calendar, and nothing is resolved.
 */
export async function postingPeriodFor(
  store: Pick<EntityStore, "listPage" | "getLocked">,
  tenantId: string,
  date: string,
  config: PostingPeriodConfig | undefined,
): Promise<string | null> {
  if (config === undefined) return null;
  const period = await resolvePostingPeriod(store, tenantId, date, config);
  if (period.kind === "locked") throw new PostingRefused(422, "period_locked", periodLockedDetail(period.status, date));
  return period.periodId;
}
