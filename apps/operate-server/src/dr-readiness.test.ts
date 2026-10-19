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

function fakeConn(
  captured: string[],
  drillRows: readonly unknown[] = [],
  // The bound parameters, for the one case that asserts what reached the **stored** row rather
  // than what `assessOnce` returned. Collected here and not by wrapping the returned connection,
  // because `transaction` hands its callback `conn` itself — so a wrapper's `query` is bypassed by
  // every write the stores make inside a transaction, which is every write that matters. Measured:
  // the wrapper captured nothing at all.
  capturedParams: unknown[][] = [],
): PgConnection {
  const conn: PgConnection = {
    query: (async (sql: string, params?: readonly unknown[]) => {
      captured.push(sql);
      if (params !== undefined) capturedParams.push([...params]);
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
    // The column to look at and the issue code, and no value off the row: a `ZodError`'s own
    // `message` embeds `received`, so an `err.message` detail would carry a stored value into this
    // log line (ADR-0310's rule). Pins that the lifecycle did not route around `unreadableDetail`.
    //
    // Asserted as the **property** and not as the literal `record.outcome` it used to read,
    // because that was pinning `kernel-pg`'s render from here: a path component is not always a
    // field name (a `z.record` key *is* the stored key), so `renderIssuePath` prints `path[0]` and
    // collapses the tail. What this test is about survives either render — a deeper position under
    // the right column, the issue code, and nothing off the row.
    expect(seen[0]?.detail).toContain("record.");
    expect(seen[0]?.detail).toContain("invalid_enum_value");
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
   * **The partial page, which was the cost of that decision and is now carried by the report.**
   *
   * Until ADR-0373's own open question 3 was closed, this test asserted `ready: true` with
   * `totalIssues: 0` and **said nothing about the certification control** — it was titled as a
   * named limitation and stopped at the verdict. That was the gap, and the reason the omission
   * mattered is what the title hid: `drReadinessSource` reads exactly this snapshot and
   * `evidenceFromDrReadiness` signed it `satisfied` with the summary *"DR readiness: READY
   * (0 issues)"*, so a SOC 2 evidence pack certified disaster-recovery readiness over a drill
   * history this binary could not fully read, with the refused row reaching a `console.error` and
   * nothing durable. A test that pins a verdict and not its consequence reads as a documented
   * trade-off while the consequence is a falsely-true control (ADR-0337's direction, which is the
   * dangerous one — a falsely-false control costs a certification, a falsely-true one *is* the
   * compliance failure).
   *
   * `unevidencedAxes` still does not name the axis, and that half of the decision is unchanged and
   * correct: with one readable drill beside the refused one, *no drills record was supplied* is
   * false and rendering it would put a falsehood into the pack. The report carries the fact in its
   * own second field instead.
   */
  it("is NOT ready over a page with a hole, and names the axis as partly unreadable", async () => {
    const seen: UnreadableDrExecution[] = [];
    const lifecycle = buildDrReadinessLifecycle(fakeConn([], page()), fullyEvidencedConfig(), {
      onUnreadableExecution: (row) => seen.push(row),
    });
    const report = await lifecycle.assessOnce();
    expect(report.unreadableEvidenceAxes).toEqual(["drills"]);
    expect(report.ready).toBe(false);
    // Still not named as unevidenced, and still not an eighth issue count: the one readable drill
    // *was* supplied and verified, and the seven counts are projected columns a reader sums.
    expect(report.unevidencedAxes).toEqual([]);
    expect(report.counts.totalIssues).toBe(0);
    expect(seen).toHaveLength(1);
  });

  it("carries that fact into the stored snapshot, not only into the returned report", async () => {
    // The snapshot is what `drReadinessSource` reads months later; a fact that reached only the
    // return value would be the increment's own class (a computed fact reaching nobody).
    const params: unknown[][] = [];
    const lifecycle = buildDrReadinessLifecycle(
      fakeConn([], page(), params),
      fullyEvidencedConfig(),
      { onUnreadableExecution: () => {} },
    );
    await lifecycle.assessOnce();
    const reportJson = params
      .flat()
      .find((v): v is string => typeof v === "string" && v.includes('"unreadableEvidenceAxes"'));
    expect(reportJson).toBeDefined();
    const report = JSON.parse(reportJson ?? "{}") as {
      unreadableEvidenceAxes: readonly string[];
      ready: boolean;
    };
    expect(report.unreadableEvidenceAxes).toEqual(["drills"]);
    expect(report.ready).toBe(false);
  });

  /**
   * The degenerate case needed no special handling and still does not — but it now says **more**.
   *
   * With every row on the axis unreadable the readable list is empty, so `assessDrReadiness` names
   * the axis in `unevidencedAxes` for the ordinary reason and the verdict is not ready. It is also
   * named as partly unreadable, and the pair is strictly more informative than either: *nobody
   * drilled* and *drills happened and their rows cannot be read* are different facts with opposite
   * remedies (ADR-0331 at the axis level). Asserted here so the fix did not disturb the one case
   * that was already right.
   */
  it("names the axis in both lists when every row on it is unreadable", async () => {
    const seen: UnreadableDrExecution[] = [];
    const lifecycle = buildDrReadinessLifecycle(
      fakeConn([], [drillDbRow(UNREADABLE, FORBIDDEN_OUTCOME)]),
      fullyEvidencedConfig(),
      { onUnreadableExecution: (row) => seen.push(row) },
    );
    const report = await lifecycle.assessOnce();
    expect(report.unevidencedAxes).toEqual(["drills"]);
    expect(report.unreadableEvidenceAxes).toEqual(["drills"]);
    expect(report.ready).toBe(false);
    expect(seen).toHaveLength(1);
  });

  it("claims an empty list, never null, when every row read", async () => {
    // `[]` here is the signed claim that the page read completely, which is what makes the control
    // satisfiable at all; `null` is reserved for a stored report written before the check and no
    // producer in this binary can emit it.
    //
    // One readable drill row is needed and is not ceremony: `fullyEvidencedConfig()` evidences the
    // three axes that come from the config JSON, and `drills` is the one the store feeds — so an
    // empty page is an *unevidenced* estate and `ready` would be false for the sibling's reason,
    // which is a different fact from the one under test. (Measured: that is how this test first
    // failed, and the test was wrong rather than the code.)
    const lifecycle = buildDrReadinessLifecycle(
      fakeConn([], [drillDbRow(READABLE, "not_executed")]),
      fullyEvidencedConfig(),
      { onUnreadableExecution: EXPECT_ALL_READABLE },
    );
    const report = await lifecycle.assessOnce();
    expect(report.unreadableEvidenceAxes).toEqual([]);
    expect(report.ready).toBe(true);
  });

  it("counts an axis once however many of its rows were refused", async () => {
    // The reporter fires per row and the axis set is accumulated in the same closure, so this is
    // the ordinary input rather than an edge case: three refused drills must not store
    // `["drills", "drills", "drills"]`.
    const seen: UnreadableDrExecution[] = [];
    const lifecycle = buildDrReadinessLifecycle(
      fakeConn([], [
        drillDbRow(READABLE, "not_executed"),
        drillDbRow("drl_00000003", FORBIDDEN_OUTCOME),
        drillDbRow("drl_00000004", FORBIDDEN_OUTCOME),
        drillDbRow("drl_00000005", FORBIDDEN_OUTCOME),
      ]),
      fullyEvidencedConfig(),
      { onUnreadableExecution: (row) => seen.push(row) },
    );
    const report = await lifecycle.assessOnce();
    expect(seen).toHaveLength(3);
    expect(report.unreadableEvidenceAxes).toEqual(["drills"]);
  });
});
