import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";

import {
  buildDrReadinessLifecycle,
  loadDrReadinessConfig,
  parseDrReadinessConfig,
  type DrReadinessConfig,
  type UnreadableDrExecution,
} from "./dr-readiness.js";

/**
 * These cases are about the lifecycle, not about unreadable rows, so the reporter **throws**: an
 * answer for a case the test did not mean is how an assertion passes vacuously, and this suite's
 * whole subject is a dropped row going unnoticed.
 */
const EXPECT_ALL_READABLE = (row: UnreadableDrExecution): never => {
  throw new Error(`a ${row.axis} row was unexpectedly unreadable: ${row.detail}`);
};

function fakeConn(captured: string[], drillRows: readonly unknown[] = []): PgConnection {
  const conn: PgConnection = {
    query: (async (sql: string) => {
      captured.push(sql);
      // Only the drill read is answered with rows. Keyed on the table rather than on call order,
      // because `assessOnce` issues its two reads through `Promise.all` and the order they reach
      // the connection is not the order they were written.
      const rows = sql.includes("dr_drill_executions") ? drillRows : [];
      return { rows, rowCount: rows.length } as PgQueryResult;
    }) as PgConnection["query"],
    transaction: (async <T,>(fn: (tx: PgConnection) => Promise<T>) => fn(conn)) as PgConnection["transaction"],
    withAdvisoryLock: (async <T,>(_k: bigint, fn: () => Promise<T>) => fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => {}) as PgConnection["close"],
  };
  return conn;
}

const HOUR = 3_600_000;
function isoFromNow(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

/**
 * A stored drill row whose projected columns are readable and whose embedded record is not.
 *
 * `record.outcome` is a `z.enum`, so this is the realistic shape of ADR-0289's row — one a CHECK
 * permits and the contract refuses — and the one issue kind that carries the stored value on it.
 */
function drillDbRow(executionId: string, outcome: string): Record<string, unknown> {
  return {
    execution_id: executionId,
    tenant_id: null,
    kind: "restore_test",
    tier: "tier_1_business_critical",
    outcome: "not_executed",
    passing: null,
    rpo_breached: null,
    rto_breached: null,
    scheduled_for: isoFromNow(-HOUR),
    executed_at: null,
    record: {
      id: executionId,
      kind: "restore_test",
      tier: "tier_1_business_critical",
      scheduledFor: isoFromNow(-HOUR),
      executedAt: null,
      executedBy: null,
      scopeRegions: ["eu-central"],
      scopeApps: ["billing"],
      outcome,
      measuredRpoSeconds: null,
      measuredRtoSeconds: null,
      findings: [],
      nextDrillDueAt: isoFromNow(90 * 24 * HOUR),
    },
    recorded_at: isoFromNow(-HOUR),
  };
}

/**
 * A config whose three hand-typed axes all carry a record, so `unevidencedAxes` is empty and the
 * only thing that could make a verdict non-ready is what this file is about.
 *
 * Every date is relative to the real clock: `assessDrReadiness` reads `now` off the runtime's own
 * `SystemClock` and there is no config field that could inject one, so a fixed date would make
 * `overdueDrills` / `staleRunbooks` / `expiredBackups` start firing as the suite ages.
 */
function fullyEvidencedConfig(): DrReadinessConfig {
  return parseDrReadinessConfig({
    input: {
      runbooks: [
        {
          id: "RB-0001",
          kind: "restore_from_backup",
          appliesToTiers: ["tier_1_business_critical"],
          title: "Restore from backup",
          version: "1.0.0",
          owner: "sre",
          storageUri: "https://runbooks.example.test/rb-0001",
          estimatedExecutionMinutes: 30,
          lastReviewedAt: isoFromNow(-24 * HOUR),
          lastTestedAt: isoFromNow(-24 * HOUR),
          lastTestedBy: "sre",
          status: "approved",
        },
      ],
      backups: [
        {
          id: "bak_1",
          policyId: "pol_1",
          kind: "full",
          startedAt: isoFromNow(-2 * HOUR),
          completedAt: isoFromNow(-HOUR),
          status: "verified",
          sizeBytes: 1024,
          sha256: "a".repeat(64),
          storageRegion: "eu-central",
          verifiedAt: isoFromNow(-HOUR),
          verifiedBy: "sre",
          expiresAt: isoFromNow(90 * 24 * HOUR),
        },
      ],
      replication: [
        {
          tier: "tier_1_business_critical",
          record: {
            source: "eu-central",
            target: "us-east",
            measuredAt: isoFromNow(-HOUR),
            lagBytes: 0,
            lagSeconds: 0,
            status: "healthy",
          },
        },
      ],
    },
  });
}

describe("parseDrReadinessConfig", () => {
  it("applies defaults for an empty input", () => {
    const config = parseDrReadinessConfig({ input: {} });
    expect(config.tenantId).toBeNull();
    expect(config.intervalMs).toBe(3_600_000);
    expect(config.input.runbooks).toEqual([]);
    expect(config.input.backups).toEqual([]);
    expect(config.input.replication).toEqual([]);
  });

  it("accepts a tenant id + interval", () => {
    const config = parseDrReadinessConfig({
      tenantId: "11111111-1111-1111-1111-111111111111",
      intervalMs: 60_000,
      input: {},
    });
    expect(config.tenantId).toBe("11111111-1111-1111-1111-111111111111");
    expect(config.intervalMs).toBe(60_000);
  });

  it("rejects an unknown top-level key", () => {
    expect(() => parseDrReadinessConfig({ input: {}, bogus: 1 })).toThrow();
  });

  it("rejects a non-uuid tenant id", () => {
    expect(() => parseDrReadinessConfig({ tenantId: "not-a-uuid", input: {} })).toThrow();
  });
});

describe("loadDrReadinessConfig", () => {
  it("reads + validates a file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dr-cfg-"));
    const path = join(dir, "dr.json");
    await writeFile(path, JSON.stringify({ input: {} }), "utf8");
    const config = await loadDrReadinessConfig(path);
    expect(config.intervalMs).toBe(3_600_000);
  });

  it("throws a clear error for a missing file", async () => {
    await expect(loadDrReadinessConfig("/no/such/dr-config.json")).rejects.toThrow(
      /--dr-readiness-config/,
    );
  });
});

describe("buildDrReadinessLifecycle", () => {
  it("assessOnce reads recent executions, assesses, and persists a snapshot", async () => {
    const captured: string[] = [];
    const lifecycle = buildDrReadinessLifecycle(
      fakeConn(captured),
      parseDrReadinessConfig({ input: {} }),
      { onUnreadableExecution: EXPECT_ALL_READABLE },
    );
    const report = await lifecycle.assessOnce();
    // This assertion used to read `expect(report.ready).toBe(true)` under the comment "No
    // executions + no declared infra ⇒ ready, zero issues" — the defect pinned as a feature, in
    // the test of the one lifecycle that produces these snapshots. `{"input":{}}` is the config a
    // deployment writes when it has declared nothing, and every count is derived by *filtering* a
    // supplied list, so zero issues is what an unexamined estate produces rather than a healthy
    // one. `totalIssues` is still 0 and still correct: it counts issues found in evidence that
    // exists, and the unevidenced axes are the separate fact beside it.
    expect(report.ready).toBe(false);
    expect(report.counts.totalIssues).toBe(0);
    expect(report.unevidencedAxes).toEqual(["drills", "runbooks", "backups", "replication"]);
    // It read the two execution streams and wrote a readiness snapshot row.
    expect(captured.some((s) => s.includes("dr_failover_executions"))).toBe(true);
    expect(captured.some((s) => s.includes("dr_drill_executions"))).toBe(true);
    expect(captured.some((s) => s.includes("INSERT INTO") && s.includes("dr_readiness_snapshots"))).toBe(true);
  });

  it("exposes a scheduler that starts + stops over an injected timer", () => {
    let started = false;
    const lifecycle = buildDrReadinessLifecycle(fakeConn([]), parseDrReadinessConfig({ input: {} }), {
      onUnreadableExecution: EXPECT_ALL_READABLE,
      scheduler: {
        setInterval: () => {
          started = true;
          return 1;
        },
        clearInterval: () => {
          started = false;
        },
      },
    });
    lifecycle.scheduler.start();
    expect(started).toBe(true);
    lifecycle.scheduler.stop();
    expect(started).toBe(false);
  });
});

/**
 * The defect this closes, and the one cost of the way it is closed.
 *
 * `listRecent` used to `.map(rowToRecord)`, so one row the contract refuses threw out of the page,
 * through `assessOnce`, into `DrReadinessScheduler`'s `catch` — which only calls `onError`. So no
 * snapshot was recorded at all, every tick, and `drReadinessSource` certified against a stale
 * snapshot or none. ADR-0372's whole increment ran only on a pass that completed.
 */
describe("an execution row the contract refuses", () => {
  const READABLE = "drl_00000001";
  const UNREADABLE = "drl_00000002";
  const FORBIDDEN_OUTCOME = "zzz-not-an-outcome";

  function page(): readonly unknown[] {
    return [
      drillDbRow(READABLE, "not_executed"),
      drillDbRow(UNREADABLE, FORBIDDEN_OUTCOME),
    ];
  }

  it("still records a snapshot, and reports the row rather than throwing", async () => {
    const captured: string[] = [];
    const seen: UnreadableDrExecution[] = [];
    const lifecycle = buildDrReadinessLifecycle(
      fakeConn(captured, page()),
      parseDrReadinessConfig({ input: {} }),
      { onUnreadableExecution: (row) => seen.push(row) },
    );
    await expect(lifecycle.assessOnce()).resolves.toBeDefined();
    expect(
      captured.some((s) => s.includes("INSERT INTO") && s.includes("dr_readiness_snapshots")),
    ).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.axis).toBe("drills");
    expect(seen[0]?.identity).toBe(UNREADABLE);
    // The field path and the issue code, and no value off the row: a `ZodError`'s own `message`
    // embeds `received`, so an `err.message` detail would carry a stored value into this log line
    // (ADR-0310's rule). Pins that the lifecycle did not route around `unreadableDetail`.
    expect(seen[0]?.detail).toContain("record.outcome");
    expect(seen[0]?.detail).not.toContain(FORBIDDEN_OUTCOME);
  });

  it("scores the readable rows and does not call the axis unevidenced", async () => {
    const seen: UnreadableDrExecution[] = [];
    const lifecycle = buildDrReadinessLifecycle(
      fakeConn([], page()),
      parseDrReadinessConfig({ input: {} }),
      { onUnreadableExecution: (row) => seen.push(row) },
    );
    const report = await lifecycle.assessOnce();
    // **This is the decision, and it is the one assertion that would fail if the other candidate
    // had been taken.** `unevidencedAxes` means *this axis carried no record at all*:
    // `evidenceFromDrReadiness` renders it as `no drills record was supplied, so nothing on that
    // axis was verified`. One of the two rows was supplied and verified, so naming `drills` there
    // would put a false sentence into a SOC 2 evidence pack. The axis is not named; the operator is
    // told through the reporter instead. See `assessOnce`'s own comment for the measurement,
    // including why a *failover* row could not be reported this way even if it were honest.
    expect(report.unevidencedAxes).not.toContain("drills");
    expect(seen).toHaveLength(1);
  });

  /**
   * **The cost of that decision, pinned rather than left in prose.**
   *
   * With every axis evidenced, the hole is the only thing that could make the verdict non-ready —
   * and it does not, because `DrReadinessReport` has no vocabulary for *this axis's evidence was
   * partly unreadable*: that is neither `unevidenced` nor one of the seven issue counts. So the
   * stored snapshot reads `ready: true` over a page with a hole in it, which is honest-but-
   * incomplete where naming the axis would have been a plain falsehood (ADR-0336 ranks a wrong
   * answer below a refusal, and a refusal built on a false statement is still a wrong answer).
   *
   * Closing it is a contract change in `@crossengin/dr-runtime` — a field on the report for the
   * fact, carried into `meta.dr_readiness_snapshots` beside `unevidenced_axes` the way ADR-0372
   * carried that one — and this test is what will fail when it lands, which is the point of it.
   */
  it("still reads ready over a page with a hole, which is the limitation the report cannot express", async () => {
    const seen: UnreadableDrExecution[] = [];
    const lifecycle = buildDrReadinessLifecycle(
      fakeConn([], page()),
      fullyEvidencedConfig(),
      { onUnreadableExecution: (row) => seen.push(row) },
    );
    const report = await lifecycle.assessOnce();
    expect(report.unevidencedAxes).toEqual([]);
    expect(report.counts.totalIssues).toBe(0);
    expect(report.ready).toBe(true);
    expect(seen).toHaveLength(1);
  });

  /**
   * The degenerate case needs no special handling and is already right: with *every* row on the
   * axis unreadable the readable list is empty, so `assessDrReadiness` names the axis for the
   * ordinary reason and the verdict is not ready. Which is why only the partial page is a gap.
   */
  it("names the axis unevidenced when every row on it is unreadable", async () => {
    const seen: UnreadableDrExecution[] = [];
    const lifecycle = buildDrReadinessLifecycle(
      fakeConn([], [drillDbRow(UNREADABLE, FORBIDDEN_OUTCOME)]),
      fullyEvidencedConfig(),
      { onUnreadableExecution: (row) => seen.push(row) },
    );
    const report = await lifecycle.assessOnce();
    expect(report.unevidencedAxes).toEqual(["drills"]);
    expect(report.ready).toBe(false);
    expect(seen).toHaveLength(1);
  });
});
