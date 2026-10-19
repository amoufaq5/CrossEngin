import { describe, expect, it } from "vitest";
import {
  DEFAULT_DR_TIERS,
  DRILL_OUTCOMES,
  DrillRecordSchema,
  type DrillOutcome,
  type DrillRecord,
} from "@crossengin/dr";
import { DrillExecutor, type RecordDrillResultInput } from "@crossengin/dr-runtime";
import { DRILL_MUTABLE_COLUMNS, PostgresDrDrillStore } from "./drill-store.js";
import {
  DrDrillExecutionRecordSchema,
  drillExecutionRecordFrom,
  SET_PLATFORM_RECORD_WRITE_SQL,
  SET_TENANT_CONTEXT_SQL,
  type DrDrillExecutionRecord,
} from "./records.js";
import {
  collectUnreadable,
  EXPECT_ALL_READABLE,
  mockConnection,
  type Captured,
} from "./test-fakes.js";

/**
 * The statement under test, found by what it *is* rather than by where it sits.
 *
 * `scopedWrite` issues a session setting before the write, so every positional `capture[0]` in a
 * write test would otherwise have had to shift by one — and would shift again the next time a
 * statement joins the transaction. Asserting on the session setting itself is a separate test.
 */
function written(capture: readonly Captured[]): Captured {
  const found = capture.find((c) => !c.sql.includes("set_config"));
  if (found === undefined) throw new Error("no statement other than the session setting was issued");
  return found;
}

/**
 * A value `DrillOutcomeSchema` refuses, distinctive enough that a test can assert it is *absent*
 * from a finding's detail. Not a near-miss of a real outcome, so the assertion cannot pass by
 * accidentally matching a legitimate word in the message.
 */
const FORBIDDEN_OUTCOME = "zzz-not-an-outcome";

const NOW = "2026-06-02T12:00:00.000Z";
const LATER = "2026-06-02T12:30:00.000Z";
const DUE = "2026-09-02T12:00:00.000Z";
const TENANT = "00000000-0000-4000-8000-000000000001";

function drill(overrides: Partial<DrillRecord> = {}): DrillRecord {
  return DrillRecordSchema.parse({
    id: "drl_00000001",
    kind: "restore_test",
    tier: "tier_1_business_critical",
    scheduledFor: NOW,
    executedAt: LATER,
    executedBy: "operator-1",
    scopeRegions: ["eu-central"],
    scopeApps: ["billing"],
    outcome: "passed",
    measuredRpoSeconds: 20,
    measuredRtoSeconds: 200,
    nextDrillDueAt: DUE,
    ...overrides,
  });
}

function record() {
  return drillExecutionRecordFrom(drill(), {
    tenantId: TENANT,
    recordedAt: LATER,
    verdict: { rpoBreached: false, rtoBreached: false, passing: true },
  });
}

describe("PostgresDrDrillStore.record", () => {
  it("issues an INSERT ... ON CONFLICT DO UPDATE with bound params", async () => {
    const capture: Captured[] = [];
    const store = new PostgresDrDrillStore(mockConnection(capture));
    await store.record(record());
    expect(written(capture).sql).toContain("INSERT INTO meta.dr_drill_executions");
    expect(written(capture).sql).toContain("ON CONFLICT (execution_id) DO UPDATE");
    expect(written(capture).sql).not.toContain("DO NOTHING");
    expect(written(capture).sql).toContain("$11::jsonb");
    expect(written(capture).params?.[0]).toBe("drl_00000001");
    expect(written(capture).params?.[1]).toBe(TENANT);
    expect(written(capture).params?.[2]).toBe("restore_test");
    expect(written(capture).params?.[4]).toBe("passed");
    expect(written(capture).params?.[5]).toBe(true);
  });

  it("serializes the full record as a json string", async () => {
    const capture: Captured[] = [];
    const store = new PostgresDrDrillStore(mockConnection(capture));
    await store.record(record());
    const raw = written(capture).params?.[10];
    expect(typeof raw).toBe("string");
    expect(JSON.parse(raw as string).id).toBe("drl_00000001");
  });

  it("validates the record before insert", async () => {
    const store = new PostgresDrDrillStore(mockConnection());
    const bad = { ...record(), executionId: "nope" };
    await expect(store.record(bad)).rejects.toThrow();
  });

  it("throws rather than reporting success when the write moved nothing", async () => {
    const conn = mockConnection(undefined, {
      rows: [{ state: "passed", recorded_at: LATER }],
      rowCount: 0,
    });
    await expect(new PostgresDrDrillStore(conn).record(record())).rejects.toMatchObject({
      name: "DrExecutionWriteRefusedError",
    });
  });

  it("asks the outcome column, not the status one, when diagnosing a refusal", async () => {
    const capture: Captured[] = [];
    const conn = mockConnection(capture, {
      rows: [{ state: "passed", recorded_at: LATER }],
      rowCount: 0,
    });
    await expect(new PostgresDrDrillStore(conn).record(record())).rejects.toThrow();
    expect(capture.some((c) => c.sql.includes("SELECT outcome AS state"))).toBe(true);
  });
});

/**
 * The `SET` list, re-derived from the contract.
 *
 * `packages/dr` declares no `DRILL_TRANSITIONS`, so the thing to walk is `DRILL_OUTCOMES`: apply
 * `recordDrillResult` once per outcome to a freshly planned drill and diff the execution records
 * either side. The union is what an amendment may move; everything else is the drill's *booking*,
 * which `recordDrillResult` is not given the power to change.
 */
describe("DRILL_MUTABLE_COLUMNS is derived from the outcomes the executor can record", () => {
  const SPEC = DEFAULT_DR_TIERS["tier_1_business_critical"];
  const ex = new DrillExecutor();

  /** What each outcome needs to satisfy `DrillRecordSchema`, as a total map over the enum. */
  const INPUT: Readonly<Record<DrillOutcome, RecordDrillResultInput>> = {
    not_executed: { outcome: "not_executed", executedBy: "operator-1", executedAt: LATER },
    // Breaching both targets deliberately, so `rpo_breached`/`rto_breached` really differ across the
    // diff; a compliant measurement would leave them false on both sides and the derivation would
    // then miss two columns that do move.
    passed: {
      outcome: "passed",
      executedBy: "operator-1",
      executedAt: LATER,
      measuredRpoSeconds: 90,
      measuredRtoSeconds: 1200,
      reportUrl: "https://example.invalid/report",
    },
    passed_with_findings: {
      outcome: "passed_with_findings",
      executedBy: "operator-1",
      executedAt: LATER,
      measuredRpoSeconds: 90,
      measuredRtoSeconds: 1200,
      findings: [{ id: "lag", severity: "minor", description: "replica lag", resolvedAt: null }],
    },
    failed: {
      outcome: "failed",
      executedBy: "operator-1",
      executedAt: LATER,
      findings: [{ id: "down", severity: "critical", description: "promote failed", resolvedAt: null }],
    },
    aborted: { outcome: "aborted", executedBy: "operator-1", executedAt: LATER },
  };

  function rowFor(r: DrillRecord, recordedAt: string): DrDrillExecutionRecord {
    const v = ex.drillTierVerdict(r, SPEC);
    return drillExecutionRecordFrom(r, {
      tenantId: TENANT,
      recordedAt,
      verdict: { rpoBreached: v.rpoBreached, rtoBreached: v.rtoBreached, passing: v.passing },
    });
  }

  function snake(key: string): string {
    return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  }

  function contractMutableKeys(): ReadonlySet<string> {
    const planned = drill({
      kind: "failover_test",
      outcome: "not_executed",
      executedAt: null,
      executedBy: null,
      measuredRpoSeconds: null,
      measuredRtoSeconds: null,
      findings: [],
    });
    const mutable = new Set<string>();
    for (const outcome of DRILL_OUTCOMES) {
      const after = ex.recordDrillResult(planned, INPUT[outcome]);
      const before = rowFor(planned, NOW);
      const next = rowFor(after, LATER);
      for (const k of Object.keys(before) as (keyof DrDrillExecutionRecord)[]) {
        if (JSON.stringify(before[k]) !== JSON.stringify(next[k])) mutable.add(String(k));
      }
    }
    return mutable;
  }

  it("names exactly the columns an amendment moves", () => {
    expect([...DRILL_MUTABLE_COLUMNS].sort()).toEqual(
      [...contractMutableKeys()].map(snake).sort(),
    );
  });

  it("names none of the drill's booking, which recordDrillResult cannot change", () => {
    const mutable = new Set([...contractMutableKeys()].map(snake));
    const immutable = Object.keys(DrDrillExecutionRecordSchema.shape)
      .map(snake)
      .filter((c) => !mutable.has(c));
    // `scheduled_for` matters most here: `isOverdue` and `drillCadenceMet` are read off the booking,
    // so a replayed write that could move it would change whether the deployment is in cadence.
    expect(immutable.sort()).toEqual(
      ["execution_id", "tenant_id", "kind", "tier", "scheduled_for"].sort(),
    );
    for (const c of immutable) expect([...DRILL_MUTABLE_COLUMNS]).not.toContain(c);
  });

  it("puts exactly those columns in the issued SET list and no others", async () => {
    const capture: Captured[] = [];
    await new PostgresDrDrillStore(mockConnection(capture)).record(record());
    const sql = written(capture).sql;
    const setClause = sql.slice(sql.indexOf("SET "), sql.indexOf("WHERE "));
    const assigned = [...setClause.matchAll(/(\w+) = EXCLUDED\.\1/g)].map((m) => m[1] as string);
    expect(assigned.sort()).toEqual([...DRILL_MUTABLE_COLUMNS].sort());
  });
});

describe("PostgresDrDrillStore.listRecent", () => {
  const dbRow = {
    execution_id: "drl_00000001",
    tenant_id: TENANT,
    kind: "restore_test",
    tier: "tier_1_business_critical",
    outcome: "passed",
    passing: true,
    rpo_breached: false,
    rto_breached: false,
    scheduled_for: new Date(NOW),
    executed_at: new Date(LATER),
    record: drill(),
    recorded_at: new Date(LATER),
  };

  it("orders DESC with a LIMIT bind and maps rows", async () => {
    const capture: Captured[] = [];
    const store = new PostgresDrDrillStore(
      mockConnection(capture, { rows: [dbRow], rowCount: 1 }),
    );
    const rows = await store.listRecent(null, EXPECT_ALL_READABLE, 10);
    expect(capture[0]?.sql).toContain("ORDER BY recorded_at DESC");
    expect(capture[0]?.params?.[0]).toBe(10);
    expect(rows[0]?.executionId).toBe("drl_00000001");
    expect(rows[0]?.passing).toBe(true);
    expect(rows[0]?.scheduledFor).toBe(NOW);
    expect(rows[0]?.executedAt).toBe(LATER);
  });

  it("maps a null executed_at back to null", async () => {
    const store = new PostgresDrDrillStore(
      mockConnection(undefined, {
        rows: [
          {
            ...dbRow,
            outcome: "not_executed",
            passing: null,
            executed_at: null,
            record: drill({
              outcome: "not_executed",
              executedAt: null,
              executedBy: null,
              measuredRpoSeconds: null,
              measuredRtoSeconds: null,
            }),
          },
        ],
        rowCount: 1,
      }),
    );
    const rows = await store.listRecent(null, EXPECT_ALL_READABLE);
    expect(rows[0]?.executedAt).toBeNull();
    expect(rows[0]?.passing).toBeNull();
  });

  it("rejects a non-positive limit", async () => {
    const store = new PostgresDrDrillStore(mockConnection());
    await expect(store.listRecent(null, EXPECT_ALL_READABLE, -1)).rejects.toThrow();
  });

  /**
   * The row that is the subject of ADR-0373: readable columns, a readable business key, and an
   * embedded record the contract refuses — the state ADR-0289 names, a row edited into a shape the
   * contract forbids and the CHECK permits. `record.outcome` is a `z.enum`, so the issue zod raises
   * is `invalid_enum_value`, which is the one issue kind that carries the stored value on it — and
   * the detail renders as `record.<withheld>`, since `renderIssuePath` keeps the column and drops
   * what is under it.
   */
  function unreadableDbRow() {
    return {
      ...dbRow,
      execution_id: "drl_00000002",
      record: { ...drill(), outcome: FORBIDDEN_OUTCOME },
    };
  }

  it("returns the readable rows and reports the one it could not represent", async () => {
    const seen = collectUnreadable();
    const store = new PostgresDrDrillStore(
      mockConnection(undefined, {
        rows: [dbRow, unreadableDbRow(), { ...dbRow, execution_id: "drl_00000003" }],
        rowCount: 3,
      }),
    );
    const rows = await store.listRecent(null, seen.report, 10);
    // The defect: one refused row used to throw out of `.map`, so the other two were lost with it
    // — and the throw reached `DrReadinessScheduler`, which records no snapshot at all.
    expect(rows.map((r) => r.executionId)).toEqual(["drl_00000001", "drl_00000003"]);
    expect(seen.rows).toHaveLength(1);
    expect(seen.rows[0]?.identity).toBe("drl_00000002");
  });

  it("names a field path and an issue code, and no value off the row", async () => {
    const seen = collectUnreadable();
    const store = new PostgresDrDrillStore(
      mockConnection(undefined, { rows: [unreadableDbRow()], rowCount: 1 }),
    );
    await store.listRecent(null, seen.report, 10);
    const detail = seen.rows[0]?.detail ?? "";
    // `record.<withheld>` and not `record.outcome`: `renderIssuePath` prints the first component —
    // which is the column, and so the thing a remedy needs — and collapses every deeper string one.
    // The precision lost here is a real cost paid elsewhere: `outcome` is a declared key of a
    // `z.object` and safe to print, but a `z.record` component IS the stored key, and the two are
    // byte-identical in `issue.path` with nothing on the issue or the error to separate them.
    expect(detail).toContain("record.<withheld>");
    expect(detail).toContain("invalid_enum_value");
    // The store must not route around `unreadableDetail`, which exists because a `ZodError`'s own
    // `message` embeds `received` — so an `err.message` detail would carry a stored value into a
    // log line, an HTTP body or an incident note (ADR-0310's rule). Asserted on the value rather
    // than on the absence of a substring of the message, so it holds however zod words it.
    expect(detail).not.toContain(FORBIDDEN_OUTCOME);
  });
});

describe("PostgresDrDrillStore.countSince", () => {
  it("parses the count", async () => {
    const store = new PostgresDrDrillStore(
      mockConnection(undefined, { rows: [{ count: "3" }], rowCount: 1 }),
    );
    expect(await store.countSince(null, new Date(NOW))).toBe(3);
  });
});

describe("the platform write arm", () => {
  it("claims app.platform_record_write before a platform-scope write", async () => {
    const capture: Captured[] = [];
    const store = new PostgresDrDrillStore(mockConnection(capture));
    await store.record({ ...record(), tenantId: null });
    expect(capture[0]?.sql).toBe(SET_PLATFORM_RECORD_WRITE_SQL);
    expect(written(capture).sql).toContain("INSERT INTO meta.dr_drill_executions");
  });

  it("claims the tenant context instead for a tenant-scope write, never both", async () => {
    const capture: Captured[] = [];
    await new PostgresDrDrillStore(mockConnection(capture)).record(record());
    const settings = capture.filter((c) => c.sql.includes("set_config"));
    expect(settings).toHaveLength(1);
    expect(settings[0]?.sql).toBe(SET_TENANT_CONTEXT_SQL);
  });

  it("claims nothing at all on a read, which the split left unchanged", async () => {
    const capture: Captured[] = [];
    await new PostgresDrDrillStore(mockConnection(capture)).listRecent(
      null,
      EXPECT_ALL_READABLE,
      10,
    );
    expect(capture.some((c) => c.sql.includes("set_config"))).toBe(false);
  });
});
