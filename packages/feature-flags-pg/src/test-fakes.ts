import { vi } from "vitest";
import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { KillSwitchSchema, type KillSwitch } from "@crossengin/feature-flags";

import { KILL_SWITCH_COLUMN_NAMES, killSwitchRowValues } from "./records.js";

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
export const T1 = "2026-09-30T10:05:00.000Z";
export const T2 = "2026-09-30T11:00:00.000Z";

export const TENANT = "11111111-1111-4111-8111-111111111111";
export const ARMER = "22222222-2222-4222-8222-222222222222";
export const TRIGGERER = "33333333-3333-4333-8333-333333333333";
export const RELEASER = "44444444-4444-4444-8444-444444444444";

export const FLAG_ID = "ff_checkout1";
export const KILL_SWITCH_ID = "fks_slo00001";
export const INCIDENT_ID = "INC-2026-0007";

/**
 * A triggered, platform-wide kill switch of the kind the SLO loop writes: an automated metric
 * breach needs neither four eyes nor an incident link, so a fixture that sets `relatedIncidentId`
 * anyway exercises the column the restart path reads without leaning on a required field.
 */
export function killSwitch(over: Record<string, unknown> = {}): KillSwitch {
  return KillSwitchSchema.parse({
    id: KILL_SWITCH_ID,
    tenantId: null,
    flagId: FLAG_ID,
    status: "triggered_active",
    triggerKind: "automated_metric_breach",
    justification: "availability burn rate breached 14.4x over one hour",
    armedAt: T0,
    armedByUserId: ARMER,
    triggeredAt: T1,
    triggeredByUserId: TRIGGERER,
    coTriggeredByUserId: null,
    coTriggeredAt: null,
    expiresAt: null,
    releasedAt: null,
    releasedByUserId: null,
    releasedReason: null,
    expiredAt: null,
    relatedIncidentId: INCIDENT_ID,
    overriddenValueJson: "false",
    ...over,
  });
}

/** The same switch after a clean recovery closed it out. */
export function releasedKillSwitch(over: Record<string, unknown> = {}): KillSwitch {
  return killSwitch({
    status: "released",
    releasedAt: T2,
    releasedByUserId: RELEASER,
    releasedReason: "error budget recovered; burn rate back under 1x",
    ...over,
  });
}

/** The row a stored kill switch comes back as, built through the same projection the store writes. */
export function killSwitchRow(record: KillSwitch): Record<string, unknown> {
  const values = killSwitchRowValues(record);
  const row: Record<string, unknown> = {};
  KILL_SWITCH_COLUMN_NAMES.forEach((col, i) => {
    row[col] = values[i];
  });
  return row;
}
