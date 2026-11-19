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
