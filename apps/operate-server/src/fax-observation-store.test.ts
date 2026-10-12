import type { PgConnection } from "@crossengin/kernel-pg";
import { describe, expect, it } from "vitest";

import {
  PostgresFaxObservationStore,
  expectedOutcomeFor,
  type FaxObservationRow,
} from "./fax-observation-store.js";
import type { VoiceReachabilityObservation } from "@crossengin/notification-providers";

const TENANT = "00000000-0000-4000-8000-000000000001";
const NUMBER = "+15551230001";
const AT = new Date("2026-03-01T12:00:00.000Z");

const FAX: VoiceReachabilityObservation = {
  signal: "fax_detected",
  channel: "voice_call",
  address: NUMBER,
  callSid: "CA0001",
};

type Row = Record<string, unknown>;

interface Captured {
  readonly sql: string;
  readonly params: readonly unknown[];
}

interface Fake {
  readonly conn: PgConnection;
  readonly captured: Captured[];
  readonly tenantContext: () => string | null;
  readonly writes: () => Captured[];
}

/**
 * Records every statement and answers what the test hands it.
 *
 * The rules this store exists to enforce live *in* the SQL — the three `CASE` arms, `GREATEST`, the
 * `COALESCE` stamp — so a change that moved any of them into process would pass a behavioural test
 * and fail these.
 */
function fakeDb(responses: readonly Row[][]): Fake {
  const captured: Captured[] = [];
  let tenant: string | null = null;
  let next = 0;

  const run = async (
    sql: string,
    params: readonly unknown[] | undefined,
  ): Promise<{ rows: Row[]; rowCount: number }> => {
    const p = params ?? [];
    captured.push({ sql, params: p });
    if (sql.includes("set_config")) {
      tenant = String(p[0]);
      return { rows: [], rowCount: 0 };
    }
    const rows = responses[next] ?? [];
    next += 1;
    return { rows: [...rows], rowCount: rows.length };
  };

  const conn = {
    query: run,
    transaction: async <T>(fn: (tx: PgConnection) => Promise<T>): Promise<T> =>
      fn(conn as unknown as PgConnection),
    withAdvisoryLock: async <T>(_k: bigint, fn: () => Promise<T>): Promise<T> => fn(),
    close: async (): Promise<undefined> => undefined,
  };

  return {
    conn: conn as unknown as PgConnection,
    captured,
    tenantContext: () => tenant,
    writes: () => captured.filter((c) => !c.sql.includes("set_config")),
  };
}

function observeRow(over: Partial<Row> = {}): Row {
  return {
    consecutive_count: 2,
    suppressed_at: null,
    disposition: "advanced",
    ...over,
  };
}

describe("PostgresFaxObservationStore — construction", () => {
  it("refuses a schema identifier that is not one", () => {
    const { conn } = fakeDb([]);
    expect(() => new PostgresFaxObservationStore(conn, { schema: 'x"; DROP' })).toThrow(
      /invalid schema identifier/,
    );
  });

  it("defaults to meta", async () => {
    const db = fakeDb([[observeRow()]]);
    await new PostgresFaxObservationStore(db.conn).observe(TENANT, FAX, AT, 168);
    expect(db.writes()[0]?.sql).toContain('"meta"."notification_fax_observations"');
  });
});

describe("observe", () => {
  it("sets the tenant context and binds the tenant explicitly", async () => {
    const db = fakeDb([[observeRow()]]);
    await new PostgresFaxObservationStore(db.conn).observe(TENANT, FAX, AT, 168);
    expect(db.tenantContext()).toBe(TENANT);
    const write = db.writes()[0];
    expect(write?.params[0]).toBe(TENANT);
    // Defense in depth, and not decorative: the table's owner bypasses its policies, so the
    // explicit predicate is the only part that holds for owner and non-owner alike.
    expect(write?.sql).toContain("tenant_id = $1::uuid");
  });

  it("is one statement, so no concurrent callback can interleave a read and a write", async () => {
    const db = fakeDb([[observeRow()]]);
    await new PostgresFaxObservationStore(db.conn).observe(TENANT, FAX, AT, 168);
    expect(db.writes()).toHaveLength(1);
  });

  it("decides the three branches in SQL, in the order the pure rule states", async () => {
    const db = fakeDb([[observeRow()]]);
    await new PostgresFaxObservationStore(db.conn).observe(TENANT, FAX, AT, 168);
    const sql = db.writes()[0]?.sql ?? "";
    // A retry is checked before staleness, so a late retry is still a retry and not a run of one.
    const retry = sql.indexOf("last_call_sid = $4");
    const stale = sql.indexOf("make_interval");
    expect(retry).toBeGreaterThan(-1);
    expect(stale).toBeGreaterThan(retry);
    expect(sql).toContain("consecutive_count + 1");
    expect(sql).toContain("GREATEST");
    expect(sql).toContain("ON CONFLICT (tenant_id, recipient_address) DO UPDATE");
  });

  it("binds the window as a parameter rather than concatenating an interval literal", async () => {
    const db = fakeDb([[observeRow()]]);
    await new PostgresFaxObservationStore(db.conn).observe(TENANT, FAX, AT, 48);
    const write = db.writes()[0];
    expect(write?.sql).toContain("make_interval(hours => $5::int)");
    expect(write?.params[4]).toBe(48);
  });

  it("records the branch it took as a column, because RETURNING sees the new row", async () => {
    const db = fakeDb([[observeRow({ disposition: "duplicate", consecutive_count: 2 })]]);
    const result = await new PostgresFaxObservationStore(db.conn).observe(TENANT, FAX, AT, 168);
    expect(db.writes()[0]?.sql).toContain("last_disposition = CASE");
    expect(db.writes()[0]?.sql).toContain("last_disposition AS disposition");
    expect(result.disposition).toBe("duplicate");
    expect(result.consecutiveCount).toBe(2);
  });

  it("inserts a fresh run as 'started'", async () => {
    const db = fakeDb([[observeRow({ disposition: "started", consecutive_count: 1 })]]);
    await new PostgresFaxObservationStore(db.conn).observe(TENANT, FAX, AT, 168);
    expect(db.writes()[0]?.sql).toContain("'started'");
  });

  it("reads a count that came back as a string", async () => {
    // `applyFaxObservation` is fed this number; a string that silently became NaN would compare
    // false against every threshold and the mechanism would be off (ADR-0331's wire-type sweep).
    const db = fakeDb([[observeRow({ consecutive_count: "3" })]]);
    const result = await new PostgresFaxObservationStore(db.conn).observe(TENANT, FAX, AT, 168);
    expect(result.consecutiveCount).toBe(3);
  });

  it("reads a suppressed_at that came back as a Date", async () => {
    const db = fakeDb([[observeRow({ suppressed_at: new Date("2026-02-01T00:00:00.000Z") })]]);
    const result = await new PostgresFaxObservationStore(db.conn).observe(TENANT, FAX, AT, 168);
    expect(result.suppressedAt).toBe("2026-02-01T00:00:00.000Z");
  });

  it("throws rather than reporting a count when the write returns no row", async () => {
    // Under RLS as a non-owner role a confined `DO UPDATE` returns nothing. A caller handed a
    // fabricated run could cross a threshold on it.
    const db = fakeDb([[]]);
    await expect(
      new PostgresFaxObservationStore(db.conn).observe(TENANT, FAX, AT, 168),
    ).rejects.toThrow(/cannot see it/);
  });

  it("throws on an unknown disposition rather than guessing", async () => {
    const db = fakeDb([[observeRow({ disposition: "nudged" })]]);
    await expect(
      new PostgresFaxObservationStore(db.conn).observe(TENANT, FAX, AT, 168),
    ).rejects.toThrow(/unknown disposition/);
  });

  it("refuses a voice_answered observation: that is the other method", async () => {
    const db = fakeDb([[observeRow()]]);
    await expect(
      new PostgresFaxObservationStore(db.conn).observe(
        TENANT,
        { ...FAX, signal: "voice_answered" },
        AT,
        168,
      ),
    ).rejects.toThrow(/expects fax_detected/);
    expect(db.writes()).toHaveLength(0);
  });

  it("refuses a tenant that is not a UUID and a window that is not positive", async () => {
    const db = fakeDb([[observeRow()]]);
    const store = new PostgresFaxObservationStore(db.conn);
    await expect(store.observe("not-a-uuid", FAX, AT, 168)).rejects.toThrow(/must be a UUID/);
    await expect(store.observe(TENANT, FAX, AT, 0)).rejects.toThrow(/must be positive/);
    await expect(store.observe(TENANT, FAX, AT, Number.NaN)).rejects.toThrow(/must be positive/);
    expect(db.writes()).toHaveLength(0);
  });
});

describe("markSuppressed", () => {
  it("never moves an existing stamp", async () => {
    const db = fakeDb([[]]);
    await new PostgresFaxObservationStore(db.conn).markSuppressed(TENANT, NUMBER, AT);
    // `COALESCE` and not an assignment: the field answers "when did this address first cross", and
    // a run that keeps growing re-plans the identical suppression on every later verdict.
    expect(db.writes()[0]?.sql).toContain("COALESCE(suppressed_at, $3::timestamptz)");
  });
});

describe("clearRun", () => {
  it("deletes the run and reports whether one existed", async () => {
    const db = fakeDb([[{ x: 1 }]]);
    const cleared = await new PostgresFaxObservationStore(db.conn).clearRun(TENANT, NUMBER);
    expect(cleared).toBe(true);
    // A delete and not a zero: an absent row and a run of zero mean the same thing.
    expect(db.writes()[0]?.sql).toContain("DELETE FROM");
  });

  it("reports false when no run existed", async () => {
    const db = fakeDb([[]]);
    expect(await new PostgresFaxObservationStore(db.conn).clearRun(TENANT, NUMBER)).toBe(false);
  });
});

describe("load", () => {
  it("normalises every column type node-postgres may hand back", async () => {
    const db = fakeDb([
      [
        {
          tenant_id: TENANT,
          recipient_address: NUMBER,
          consecutive_count: "4",
          first_observed_at: new Date("2026-02-20T00:00:00.000Z"),
          last_observed_at: "2026-02-28T00:00:00.000Z",
          last_call_sid: "CA0009",
          last_disposition: "advanced",
          suppressed_at: null,
        },
      ],
    ]);
    const row = await new PostgresFaxObservationStore(db.conn).load(TENANT, NUMBER);
    expect(row).toEqual({
      tenantId: TENANT,
      recipientAddress: NUMBER,
      consecutiveCount: 4,
      firstObservedAt: "2026-02-20T00:00:00.000Z",
      lastObservedAt: "2026-02-28T00:00:00.000Z",
      lastCallSid: "CA0009",
      lastDisposition: "advanced",
      suppressedAt: null,
    } satisfies FaxObservationRow);
  });

  it("answers null for an address with no run", async () => {
    const db = fakeDb([[]]);
    expect(await new PostgresFaxObservationStore(db.conn).load(TENANT, NUMBER)).toBeNull();
  });
});

describe("expectedOutcomeFor — the bridge the live test compares against", () => {
  const row = (over: Partial<FaxObservationRow> = {}): FaxObservationRow => ({
    tenantId: TENANT,
    recipientAddress: NUMBER,
    consecutiveCount: 2,
    firstObservedAt: "2026-03-01T06:00:00.000Z",
    lastObservedAt: "2026-03-01T06:00:00.000Z",
    lastCallSid: "CA_OLD",
    lastDisposition: "advanced",
    suppressedAt: null,
    ...over,
  });

  it("restates the pure rule over a loaded row", () => {
    expect(expectedOutcomeFor(null, AT, "CA_NEW", 168)).toEqual({
      consecutiveCount: 1,
      disposition: "started",
    });
    expect(expectedOutcomeFor(row(), AT, "CA_NEW", 168)).toEqual({
      consecutiveCount: 3,
      disposition: "advanced",
    });
    expect(expectedOutcomeFor(row(), AT, "CA_OLD", 168)).toEqual({
      consecutiveCount: 2,
      disposition: "duplicate",
    });
    expect(
      expectedOutcomeFor(row({ lastObservedAt: "2026-01-01T00:00:00.000Z" }), AT, "CA_NEW", 168),
    ).toEqual({ consecutiveCount: 1, disposition: "restarted" });
  });
});
