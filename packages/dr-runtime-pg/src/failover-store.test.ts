import { describe, expect, it } from "vitest";
import {
  DEFAULT_DR_TIERS,
  FAILOVER_STATUSES,
  FAILOVER_TRANSITIONS,
  FailoverRecordSchema,
  type FailoverRecord,
  type FailoverStatus,
} from "@crossengin/dr";
import { FailoverExecutor } from "@crossengin/dr-runtime";
import {
  FAILOVER_MUTABLE_COLUMNS,
  PostgresDrFailoverStore,
} from "./failover-store.js";
import {
  DrFailoverExecutionRecordSchema,
  SET_PLATFORM_RECORD_WRITE_SQL,
  SET_TENANT_CONTEXT_SQL,
  failoverExecutionRecordFrom,
  scopedWrite,
  type DrFailoverExecutionRecord,
} from "./records.js";
import { mockConnection, type Captured } from "./test-fakes.js";

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

const NOW = "2026-06-02T12:00:00.000Z";
const LATER = "2026-06-02T12:30:00.000Z";
const TENANT = "00000000-0000-4000-8000-000000000001";

function failover(overrides: Partial<FailoverRecord> = {}): FailoverRecord {
  return FailoverRecordSchema.parse({
    id: "fov_00000001",
    tier: "tier_1_business_critical",
    trigger: "planned_drill",
    triggeredBy: "operator-1",
    triggeredAt: NOW,
    fromRegion: "eu-central",
    toRegion: "us-east",
    affectedApps: ["billing"],
    status: "succeeded",
    startedAt: NOW,
    completedAt: LATER,
    durationSeconds: 1800,
    actualRpoSeconds: 30,
    actualRtoSeconds: 300,
    ...overrides,
  });
}

function record() {
  return failoverExecutionRecordFrom(failover(), {
    tenantId: TENANT,
    recordedAt: LATER,
    verdict: { rpoBreached: false, rtoBreached: false },
  });
}

describe("PostgresDrFailoverStore.record", () => {
  it("issues an INSERT ... ON CONFLICT DO UPDATE with bound params", async () => {
    const capture: Captured[] = [];
    const store = new PostgresDrFailoverStore(mockConnection(capture));
    await store.record(record());
    expect(written(capture).sql).toContain("INSERT INTO meta.dr_failover_executions");
    expect(written(capture).sql).toContain("ON CONFLICT (execution_id) DO UPDATE");
    expect(written(capture).sql).not.toContain("DO NOTHING");
    expect(written(capture).sql).toContain("$15::jsonb");
    expect(written(capture).params?.[0]).toBe("fov_00000001");
    expect(written(capture).params?.[1]).toBe(TENANT);
    expect(written(capture).params?.[4]).toBe("succeeded");
    expect(written(capture).params?.[9]).toBe(30);
    expect(written(capture).params?.[11]).toBe(false);
  });

  it("serializes the full record as a json string", async () => {
    const capture: Captured[] = [];
    const store = new PostgresDrFailoverStore(mockConnection(capture));
    await store.record(record());
    const raw = written(capture).params?.[14];
    expect(typeof raw).toBe("string");
    expect(JSON.parse(raw as string).id).toBe("fov_00000001");
  });

  it("validates the record before insert", async () => {
    const store = new PostgresDrFailoverStore(mockConnection());
    const bad = { ...record(), executionId: "bad-id" };
    await expect(store.record(bad)).rejects.toThrow();
  });

  it("throws rather than reporting success when the write moved nothing", async () => {
    // A refused `DO UPDATE` is `INSERT 0 0`, which is byte-identical to the `DO NOTHING` this
    // replaces. Without the throw the fix would reproduce the defect it exists to close.
    const conn = mockConnection(undefined, {
      rows: [{ state: "reverted", recorded_at: LATER }],
      rowCount: 0,
    });
    await expect(new PostgresDrFailoverStore(conn).record(record())).rejects.toMatchObject({
      name: "DrExecutionWriteRefusedError",
    });
  });
});

/**
 * The `SET` list, re-derived from the contract rather than restated.
 *
 * Walk `FAILOVER_TRANSITIONS` from the status `planFailover` produces, apply the executor method for
 * each edge, and diff the *execution records* either side of it. The union of the fields any legal
 * transition changes is, by construction, exactly what an upsert may move — and anything outside it
 * is history a late or replayed write must not be able to rewrite.
 */
describe("FAILOVER_MUTABLE_COLUMNS is derived from the state machine", () => {
  const NEXT: Readonly<
    Record<FailoverStatus, ((ex: FailoverExecutor, r: FailoverRecord) => FailoverRecord) | null>
  > = {
    // `queued` is `planFailover`'s output and no edge leads to it, so there is nothing to apply.
    queued: null,
    in_progress: (ex, r) => ex.startFailover(r, { startedAt: LATER }),
    // Breaching both targets on purpose: a compliant completion leaves `rpo_breached` false on both
    // sides of the diff, and the derivation would then fail to name a column that really does move.
    succeeded: (ex, r) =>
      ex.completeFailover(r, {
        actualRpoSeconds: 90,
        actualRtoSeconds: 1200,
        completedAt: LATER,
      }),
    failed: (ex, r) => ex.failFailover(r, { completedAt: LATER }),
    aborted: (ex, r) => ex.abortFailover(r, { notes: "stood down" }),
    reverted: (ex, r) =>
      ex.revertFailover(r, { revertedToFailoverId: "fov_00000002", revertedAt: LATER }),
  };

  const SPEC = DEFAULT_DR_TIERS["tier_1_business_critical"];
  const ex = new FailoverExecutor();

  function rowFor(r: FailoverRecord, recordedAt: string): DrFailoverExecutionRecord {
    const verdict = ex.failoverTierVerdict(r, SPEC);
    return failoverExecutionRecordFrom(r, {
      tenantId: TENANT,
      recordedAt,
      verdict: { rpoBreached: verdict.rpoBreached, rtoBreached: verdict.rtoBreached },
    });
  }

  function changedKeys(
    before: DrFailoverExecutionRecord,
    after: DrFailoverExecutionRecord,
  ): readonly string[] {
    return (Object.keys(before) as (keyof DrFailoverExecutionRecord)[])
      .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
      .map((k) => String(k));
  }

  function snake(key: string): string {
    return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  }

  /** Every field any legal transition changes, over every reachable edge. */
  function contractMutableKeys(): ReadonlySet<string> {
    const planned = failover({ status: "queued", startedAt: null, completedAt: null, durationSeconds: null, actualRpoSeconds: null, actualRtoSeconds: null });
    const reached = new Map<FailoverStatus, FailoverRecord>([["queued", planned]]);
    const mutable = new Set<string>();
    const queue: FailoverStatus[] = ["queued"];
    let walked = 0;
    while (queue.length > 0) {
      const from = queue.shift() as FailoverStatus;
      const record = reached.get(from) as FailoverRecord;
      for (const to of FAILOVER_TRANSITIONS[from]) {
        const apply = NEXT[to];
        if (apply === null) throw new Error(`no executor method for the edge ${from} -> ${to}`);
        const after = apply(ex, record);
        walked += 1;
        for (const k of changedKeys(rowFor(record, NOW), rowFor(after, LATER))) mutable.add(k);
        if (!reached.has(to)) {
          reached.set(to, after);
          queue.push(to);
        }
      }
    }
    // Every edge in the map was walked, so the union cannot be short by an unreached transition.
    const edges = FAILOVER_STATUSES.reduce((n, s) => n + FAILOVER_TRANSITIONS[s].length, 0);
    expect(walked).toBe(edges);
    return mutable;
  }

  it("names exactly the columns a legal transition moves", () => {
    const derived = [...contractMutableKeys()].map(snake).sort();
    expect([...FAILOVER_MUTABLE_COLUMNS].sort()).toEqual(derived);
  });

  it("names no column the state machine cannot move", () => {
    const mutable = new Set([...contractMutableKeys()].map(snake));
    const immutable = Object.keys(DrFailoverExecutionRecordSchema.shape)
      .map(snake)
      .filter((c) => !mutable.has(c));
    // The declaration, the scope and the conflict key — plus `incident_ticket_id`, which is
    // immutable because no edge in the map writes it: `planFailover` is its only producer and the
    // triggers that require it cannot change either.
    expect(immutable.sort()).toEqual([
      "execution_id",
      "from_region",
      "incident_ticket_id",
      "tenant_id",
      "tier",
      "to_region",
      "triggered_at",
      "trigger",
    ].sort());
    for (const c of immutable) {
      expect([...FAILOVER_MUTABLE_COLUMNS]).not.toContain(c);
    }
  });

  it("puts exactly those columns in the issued SET list and no others", async () => {
    const capture: Captured[] = [];
    await new PostgresDrFailoverStore(mockConnection(capture)).record(record());
    const sql = written(capture).sql;
    const setClause = sql.slice(sql.indexOf("SET "), sql.indexOf("WHERE "));
    const assigned = [...setClause.matchAll(/(\w+) = EXCLUDED\.\1/g)].map((m) => m[1] as string);
    expect(assigned.sort()).toEqual([...FAILOVER_MUTABLE_COLUMNS].sort());
  });
});

describe("PostgresDrFailoverStore.listRecent", () => {
  const dbRow = {
    execution_id: "fov_00000001",
    tenant_id: TENANT,
    tier: "tier_1_business_critical",
    trigger: "planned_drill",
    status: "succeeded",
    from_region: "eu-central",
    to_region: "us-east",
    triggered_at: new Date(NOW),
    completed_at: new Date(LATER),
    actual_rpo_seconds: 30,
    actual_rto_seconds: 300,
    rpo_breached: false,
    rto_breached: false,
    incident_ticket_id: null,
    record: failover(),
    recorded_at: new Date(LATER),
  };

  it("orders DESC with a LIMIT bind and maps rows", async () => {
    const capture: Captured[] = [];
    const store = new PostgresDrFailoverStore(
      mockConnection(capture, { rows: [dbRow], rowCount: 1 }),
    );
    const rows = await store.listRecent(null, 25);
    expect(capture[0]?.sql).toContain("ORDER BY recorded_at DESC");
    expect(capture[0]?.params?.[0]).toBe(25);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.executionId).toBe("fov_00000001");
    expect(rows[0]?.triggeredAt).toBe(NOW);
    expect(rows[0]?.completedAt).toBe(LATER);
    expect(rows[0]?.rpoBreached).toBe(false);
  });

  it("parses a json string record column", async () => {
    const store = new PostgresDrFailoverStore(
      mockConnection(undefined, {
        rows: [{ ...dbRow, record: JSON.stringify(failover()) }],
        rowCount: 1,
      }),
    );
    const rows = await store.listRecent(null);
    expect(rows[0]?.record.id).toBe("fov_00000001");
  });

  it("rejects a non-positive limit", async () => {
    const store = new PostgresDrFailoverStore(mockConnection());
    await expect(store.listRecent(null, 0)).rejects.toThrow();
  });
});

describe("PostgresDrFailoverStore.countSince", () => {
  it("parses the count", async () => {
    const store = new PostgresDrFailoverStore(
      mockConnection(undefined, { rows: [{ count: "7" }], rowCount: 1 }),
    );
    expect(await store.countSince(null, new Date(NOW))).toBe(7);
  });

  it("returns 0 when there are no rows", async () => {
    const store = new PostgresDrFailoverStore(
      mockConnection(undefined, { rows: [], rowCount: 0 }),
    );
    expect(await store.countSince(null, new Date(NOW))).toBe(0);
  });
});

describe("the platform write arm", () => {
  it("claims app.platform_record_write before a platform-scope write", async () => {
    // This store used to set nothing at all, which worked only because the deployment connects as
    // the table's owner and an owner bypasses its policies. As a non-owner the one `ALL`-scope
    // policy admitted a platform row unconditionally — the defect — so the write arm is now a
    // separate `INSERT`-scoped policy on this setting.
    const capture: Captured[] = [];
    const store = new PostgresDrFailoverStore(mockConnection(capture));
    await store.record(
      failoverExecutionRecordFrom(failover(), { tenantId: null, recordedAt: LATER }),
    );
    expect(capture[0]?.sql).toBe(SET_PLATFORM_RECORD_WRITE_SQL);
    expect(capture[0]?.sql).toContain("app.platform_record_write");
    expect(capture[1]?.sql).toContain("INSERT INTO meta.dr_failover_executions");
  });

  it("claims the tenant context instead for a tenant-scope write, never both", async () => {
    const capture: Captured[] = [];
    await new PostgresDrFailoverStore(mockConnection(capture)).record(record());
    const settings = capture.filter((c) => c.sql.includes("set_config"));
    expect(settings).toHaveLength(1);
    expect(settings[0]?.sql).toBe(SET_TENANT_CONTEXT_SQL);
    expect(settings[0]?.params).toEqual([TENANT]);
  });

  it("claims nothing at all on a read, which the split left unchanged", async () => {
    // The platform read policy is `SELECT`-scoped on `tenant_id IS NULL` and demands no grant, so a
    // read behaves exactly as it did before the split.
    const capture: Captured[] = [];
    await new PostgresDrFailoverStore(mockConnection(capture)).listRecent(null, 5);
    expect(capture.some((c) => c.sql.includes("set_config"))).toBe(false);
  });

  it("refuses a tenantId that is not a plausible RLS context, before issuing anything", async () => {
    // The record schema's `uuid()` catches this first on every path the store exposes, so this is
    // defence in depth rather than the only guard — but the id is interpolated into no SQL and
    // bound as a parameter, and a scope wrapper that trusted its argument would be the one place
    // that stopped being true.
    const capture: Captured[] = [];
    await expect(
      scopedWrite(mockConnection(capture), "'; DROP TABLE meta.tenants --", async () => undefined),
    ).rejects.toThrow(/invalid tenantId/);
    expect(capture).toEqual([]);
  });

  it("claims the elevation transaction-locally, never session-wide", () => {
    // `set_config(..., true)` — the third argument is `is_local`. A session-wide `SET` on a pooled
    // connection would hand the elevation to whoever is served next.
    expect(SET_PLATFORM_RECORD_WRITE_SQL).toContain(", true)");
    expect(SET_PLATFORM_RECORD_WRITE_SQL.startsWith("SET ")).toBe(false);
  });

  it("is not the config grant, and not the cross-tenant read grant", () => {
    // A DR drill scheduler that could also flip `gateway.strict_jwt_aud` is an authentication
    // bypass, which is why recording what the deployment did and changing what it does are two
    // grants rather than one.
    expect(SET_PLATFORM_RECORD_WRITE_SQL).not.toContain("app.platform_config_write");
    expect(SET_PLATFORM_RECORD_WRITE_SQL).not.toContain("app.platform_key_write");
    expect(SET_PLATFORM_RECORD_WRITE_SQL).not.toContain("app.platform_audit");
  });
});
