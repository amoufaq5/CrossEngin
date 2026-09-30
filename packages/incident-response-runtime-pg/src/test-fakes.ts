import { vi } from "vitest";
import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import {
  IncidentRecordSchema,
  type IncidentRecord,
  type Severity,
} from "@crossengin/incident-response";

import { INCIDENT_COLUMN_NAMES, incidentRowValues } from "./records.js";

export interface Captured {
  sql: string;
  params: readonly unknown[] | undefined;
}

export type QueryResponder = (
  sql: string,
  params: readonly unknown[] | undefined,
) => PgQueryResult;

export const EMPTY: PgQueryResult = { rows: [], rowCount: 0 };

/**
 * A `PgConnection` that records every statement and answers from `respond`. Assertions are on the
 * recorded SQL and bound parameters — never a live database, which the live verification covers.
 */
export function mockConnection(
  capture?: Captured[],
  respond: QueryResponder = () => ({ rows: [], rowCount: 1 }),
): PgConnection {
  const conn: PgConnection = {
    query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
      if (capture !== undefined) capture.push({ sql, params });
      return respond(sql, params);
    }) as PgConnection["query"],
    transaction: vi.fn(async <T>(fn: (tx: PgConnection) => Promise<T>) => fn(conn)) as
      PgConnection["transaction"],
    withAdvisoryLock: vi.fn(async <T>(_key: bigint, fn: () => Promise<T>) => fn()) as
      PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
  return conn;
}

/** Answers a specific SQL fragment with given rows, everything else with one affected row. */
export function respondTo(
  matchers: ReadonlyArray<readonly [string, PgQueryResult]>,
): QueryResponder {
  return (sql) => {
    for (const [fragment, result] of matchers) {
      if (sql.includes(fragment)) return result;
    }
    return { rows: [], rowCount: 1 };
  };
}

export const T0 = "2026-09-30T10:00:00.000Z";

export function declaredIncident(
  over: Record<string, unknown> = {},
  severity: Severity = "sev3",
): IncidentRecord {
  return IncidentRecordSchema.parse({
    id: "INC-2026-0007",
    title: "Checkout latency",
    severity,
    category: "availability",
    status: "declared",
    declaredAt: T0,
    declaredBy: "operate-server",
    timeline: [
      { occurredAt: T0, actorUserId: "operate-server", kind: "declared", message: "burn 14.4x" },
    ],
    ...over,
  });
}

/** The row a stored incident comes back as, built through the same projection the store writes. */
export function incidentRow(
  record: IncidentRecord,
  revision = 1,
  updatedAt = T0,
): Record<string, unknown> {
  const values = incidentRowValues(record, revision, updatedAt);
  const row: Record<string, unknown> = {};
  INCIDENT_COLUMN_NAMES.forEach((col, i) => {
    row[col] = values[i];
  });
  return row;
}
