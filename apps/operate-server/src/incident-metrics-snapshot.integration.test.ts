import { randomUUID } from "node:crypto";

import {
  PostgresIncidentMetricsStore,
  PostgresIncidentReplayer,
  PostgresIncidentSink,
  computeIncidentMetrics,
} from "@crossengin/incident-response-pg";
import { createNodePgConnection, parsePgEnvConfig, type PgConnection } from "@crossengin/kernel-pg";
import { FixedClock } from "@crossengin/observability-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OperateSloMonitor, buildServingSloEngine } from "./slo-incidents.js";

/**
 * Real-Postgres integration test (gated on `CROSSENGIN_PG_TEST=1`, P2.40) for the
 * incident KPI snapshot trend: declare a serving-availability incident, compute
 * `computeIncidentMetrics` over a window via the shared replayer, persist a
 * snapshot via `PostgresIncidentMetricsStore.recordSnapshot`, and read it back via
 * `listSnapshots` — proving the on-demand metrics now have a durable historical
 * trend behind them.
 */
const RUN = process.env["CROSSENGIN_PG_TEST"] === "1";
const suite = RUN ? describe : describe.skip;

const BASE = new Date("2026-06-05T12:00:00.000Z");

suite("operate-server incident metric snapshots (real Postgres)", () => {
  let conn: PgConnection;

  beforeAll(() => {
    conn = createNodePgConnection(parsePgEnvConfig());
  });

  afterAll(async () => {
    if (conn !== undefined) await conn.close();
  });

  it("declares an incident, snapshots its metrics, and reads the snapshot back", async () => {
    const actor = randomUUID();
    await conn.query(`INSERT INTO meta.users (id, email) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`, [actor, `ims-${actor}@crossengin.test`]);

    const clock = new FixedClock(BASE);
    const surface = `operate-server-ims-${Math.random().toString(36).slice(2, 8)}`;
    const engine = buildServingSloEngine({ clock, surface, systemActorUserId: actor });
    const sink = new PostgresIncidentSink(conn);
    const monitor = new OperateSloMonitor({ engine, sink, clock, surface, declaredBy: actor });

    for (let i = 0; i < 25; i += 1) {
      monitor.recordRequest(503, 5);
      clock.advance(1_000);
    }
    const decisions = await monitor.sweep(clock.now());
    expect(decisions.some((d) => d.signal === "availability" && d.decision.kind === "breach_opened")).toBe(true);

    // compute metrics over a wide window via the shared replayer read side
    const replayer = new PostgresIncidentReplayer(conn);
    const from = new Date("2026-06-01T00:00:00.000Z");
    const to = new Date("2026-06-30T00:00:00.000Z");
    const summaries = await replayer.listForPeriod({ from, to, limit: 1000 });
    const metrics = computeIncidentMetrics(summaries);
    expect(metrics.total).toBeGreaterThanOrEqual(1);

    // persist a snapshot
    const store = new PostgresIncidentMetricsStore(conn);
    const written = await store.recordSnapshot({ from, to }, metrics);
    expect(written.snapshotId).toMatch(/^ims_/);
    expect(written.total).toBe(metrics.total);

    // read it back newest-first. listSnapshots filters on computed_at (the trend
    // axis), which the store stamps with the real now() on insert — so the read
    // window must span the present, not the (fixed, historical) metrics window.
    const nowMs = Date.now();
    const read = await store.listSnapshots({
      from: new Date(nowMs - 60 * 60 * 1000),
      to: new Date(nowMs + 60 * 60 * 1000),
      limit: 50,
    });
    const got = read.find((s) => s.snapshotId === written.snapshotId);
    expect(got).toBeDefined();
    expect(got?.total).toBe(metrics.total);
    expect(got?.open).toBe(metrics.open);
    expect(got?.resolved).toBe(metrics.resolved);
    expect(got?.bySeverity).toEqual(metrics.bySeverity);
    expect(got?.windowFrom).toBe(from.toISOString());
    expect(got?.computedAt).toBeTruthy();
  });
});
