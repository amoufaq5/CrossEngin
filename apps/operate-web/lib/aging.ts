import type { BoundedReadDeclaration } from "@/lib/bounded-read";

export const AGING_BUCKETS = ["current", "1-30", "31-60", "61-90", "90+"] as const;

export type AgingBucket = (typeof AGING_BUCKETS)[number];

export interface AgingRow {
  readonly id: string;
  readonly number: string;
  readonly currency: string | null;
  readonly total: number;
  readonly applied: number;
  readonly open: number;
  readonly dueDate: string | null;
  readonly daysOverdue: number;
  readonly bucket: string;
}

export interface AgingCurrencyTotals {
  readonly totalsByBucket: Record<string, number>;
  readonly totalOpen: number;
}

export interface AgingReport {
  readonly asOf: string;
  /** The one currency every document is in, or null when they are in several (or none). */
  readonly currency: string | null;
  /** Summed across currencies — a figure only when `currency` is non-null. */
  readonly totalOpen: number;
  readonly totalsByBucket: Record<string, number>;
  /** The same totals per currency. Optional because a server older than this field does not send it. */
  readonly totalsByCurrency?: Record<string, AgingCurrencyTotals>;
  readonly documents: readonly AgingRow[];
}

export interface AgingResponse extends BoundedReadDeclaration {
  readonly asOf: string;
  readonly sections: {
    readonly ar?: AgingReport;
    readonly ap?: AgingReport;
  };
}

/** Roles that may read finance aging reports; mirrors the server-side gate. */
export const FINANCE_ROLES: readonly string[] = [
  "erp_admin",
  "controller",
  "erp_accountant",
  "ap_clerk",
];

/**
 * The two 400s `GET /v1/meta/aging` answers for an `asOf` it will not serve (ADR-0475), and what each
 * means to a reader of the page. A total map over the codes, so a third refusal the server adds has
 * to say what it means here rather than falling into the generic error banner — which is what both
 * of these did before ADR-0478.
 */
export const AGING_AS_OF_REFUSALS = ["as_of_not_served", "as_of_malformed"] as const;
export type AgingAsOfRefusal = (typeof AGING_AS_OF_REFUSALS)[number];

export const AGING_AS_OF_REFUSAL_MEANING: Readonly<Record<AgingAsOfRefusal, string>> = Object.freeze({
  as_of_not_served:
    "This report ages today's open documents against every payment to date, so it cannot say what " +
    "was open on a past date. Choose today or a later date (the server's date, in UTC).",
  as_of_malformed: "That is not a date the server can read. Choose a date in the picker, or Today.",
});

/** The meaning of an `asOf` refusal, or `null` when the error is anything else. */
export function agingAsOfRefusal(err: unknown): string | null {
  if (typeof err !== "object" || err === null || !("status" in err) || err.status !== 400) return null;
  const code = "code" in err && typeof err.code === "string" ? err.code : null;
  return code !== null && (AGING_AS_OF_REFUSALS as readonly string[]).includes(code)
    ? AGING_AS_OF_REFUSAL_MEANING[code as AgingAsOfRefusal]
    : null;
}

/**
 * The earliest date the picker offers. The server compares `asOf` against **its** UTC date, so the
 * best bound is the date it reported for a request without `asOf` (`AgingResponse.asOf`); before that
 * answer arrives, this browser's clock read in UTC — which can be a day off the server's at worst,
 * and a date it rejects still gets the refusal's own sentence rather than a generic error.
 */
export function earliestAgingAsOf(serverToday: string | null, now: Date = new Date()): string {
  return serverToday !== null && /^\d{4}-\d{2}-\d{2}$/.test(serverToday) ? serverToday : now.toISOString().slice(0, 10);
}
