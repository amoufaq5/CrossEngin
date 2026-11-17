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
 */
export async function resolvePostingPeriod(
  store: Pick<EntityStore, "listPage">,
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
      for (const p of rows) {
        const start = typeof p[c.startField] === "string" ? (p[c.startField] as string).slice(0, 10) : null;
        const end = typeof p[c.endField] === "string" ? (p[c.endField] as string).slice(0, 10) : null;
        if (start !== null && end !== null && start <= day && day <= end) covering.push(p);
      }
    },
  );
  if (!outcome.complete) {
    throw new PostingRefused(422, "period_unresolvable", "more fiscal periods cover the posting date than could be read");
  }
  const ordinary = covering.filter((p) => p[c.adjustmentField] !== true);
  const candidates = ordinary.length > 0 ? ordinary : covering;
  for (const p of candidates) {
    const status = p[c.statusField];
    if (typeof status === "string" && c.lockedStates.includes(status)) return { kind: "locked", status };
  }
  return { kind: "open", periodId: candidates.length === 1 ? String(candidates[0]!["id"]) : null };
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
 * same `{status, error, detail}` a guard block does, and the detail is built only from literals and
 * server-chosen values (a state name, a date the server picked), never a value read from a record
 * the caller may not see.
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
  store: Pick<EntityStore, "listPage">,
  tenantId: string,
  date: string,
  config: PostingPeriodConfig | undefined,
): Promise<string | null> {
  if (config === undefined) return null;
  const period = await resolvePostingPeriod(store, tenantId, date, config);
  if (period.kind === "locked") throw new PostingRefused(422, "period_locked", periodLockedDetail(period.status, date));
  return period.periodId;
}
