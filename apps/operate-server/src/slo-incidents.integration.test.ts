import { randomUUID } from "node:crypto";

import { PostgresIncidentReplayer, PostgresIncidentSink } from "@crossengin/incident-response-pg";
import { createNodePgConnection, parsePgEnvConfig, type PgConnection } from "@crossengin/kernel-pg";
import { FixedClock } from "@crossengin/observability-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OperateSloMonitor, buildServingLatencyEngine, buildServingSloEngine } from "./slo-incidents.js";

/**
 * Real-Postgres integration test (gated on `CROSSENGIN_PG_TEST=1`) proving
 * operate-server is the second consumer of `@crossengin/incident-response-pg`: a
 * serving-availability burn-rate breach declares an incident, persists it to
 * `meta.incidents` via the shared `PostgresIncidentSink`, and is read back +
 * verified clean via the shared `PostgresIncidentReplayer` — the same package the
 * workflow worker uses.
 */
const RUN = process.env["CROSSENGIN_PG_TEST"] === "1";
const suite = RUN ? describe : describe.skip;

const BASE = new Date("2026-06-05T12:00:00.000Z");

suite("operate-server SLO incidents (real Postgres)", () => {
  let conn: PgConnection;

  beforeAll(() => {
    conn = createNodePgConnection(parsePgEnvConfig());
  });

  afterAll(async () => {
    if (conn !== undefined) await conn.close();
  });

  it("declares + persists a serving-availability incident on a 5xx burst, read back via the replayer", async () => {
    const actor = randomUUID();
    await conn.query(`INSERT INTO meta.users (id, email) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`, [actor, `slo-${actor}@crossengin.test`]);

    const clock = new FixedClock(BASE);
    const surface = `operate-server-${Math.random().toString(36).slice(2, 8)}`;
    const engine = buildServingSloEngine({ clock, surface, systemActorUserId: actor });
    const sink = new PostgresIncidentSink(conn);
    const monitor = new OperateSloMonitor({ engine, sink, clock, surface, declaredBy: actor });

    for (let i = 0; i < 25; i += 1) {
      monitor.recordRequest(503, 5);
      clock.advance(1_000);
    }
    const decisions = await monitor.sweep(clock.now());
    const opened = decisions.find((d) => d.signal === "availability" && d.decision.kind === "breach_opened");
    expect(opened).toBeDefined();
    const incidentId =
      opened?.decision.kind === "breach_opened" ? opened.decision.plan.incident.id : "";
    expect(incidentId).toMatch(/^INC-\d{4}-\d{4,8}$/);

    // read it back through the shared replayer
    const replayer = new PostgresIncidentReplayer(conn);
    const summary = await replayer.getByIncidentId(incidentId);
    expect(summary?.status).toBe("declared");
    expect(summary?.category).toBe("availability");
    expect(summary?.timeline[0]?.kind).toBe("declared");
    // a freshly declared incident has a clean timeline
    expect(await replayer.verifyByIncidentId(incidentId)).toEqual([]);

    // it shows up in the open set
    const open = await replayer.listOpen();
    expect(open.some((s) => s.incidentId === incidentId)).toBe(true);
  });

  it("persists every decision as an enforcement action + breach snapshots via the persistent engine wrapper (P2.33)", async () => {
    const actor = randomUUID();
    await conn.query(`INSERT INTO meta.users (id, email) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`, [actor, `slo-pe-${actor}@crossengin.test`]);

    const clock = new FixedClock(BASE);
    const surface = `operate-server-pe-${Math.random().toString(36).slice(2, 8)}`;

    // count baseline rows for this surface (none yet)
    const before = await conn.query<{ actions: string; evals: string }>(
      `SELECT
         (SELECT count(*) FROM meta.slo_enforcement_actions WHERE surface = $1) AS actions,
         (SELECT count(*) FROM meta.slo_evaluations WHERE surface = $1) AS evals`,
      [surface],
    );
    const baselineActions = Number(before.rows[0]?.actions ?? "0");
    const baselineEvals = Number(before.rows[0]?.evals ?? "0");

    const engine = buildServingSloEngine({ clock, surface, systemActorUserId: actor, conn });
    const sink = new PostgresIncidentSink(conn);
    const monitor = new OperateSloMonitor({ engine, sink, clock, surface, declaredBy: actor });

    for (let i = 0; i < 25; i += 1) {
      monitor.recordRequest(503, 5);
      clock.advance(1_000);
    }
    const decisions = await monitor.sweep(clock.now());
    expect(decisions.some((d) => d.signal === "availability" && d.decision.kind === "breach_opened")).toBe(true);

    const after = await conn.query<{ actions: string; evals: string }>(
      `SELECT
         (SELECT count(*) FROM meta.slo_enforcement_actions WHERE surface = $1) AS actions,
         (SELECT count(*) FROM meta.slo_evaluations WHERE surface = $1) AS evals`,
      [surface],
    );
    const newActions = Number(after.rows[0]?.actions ?? "0") - baselineActions;
    const newEvals = Number(after.rows[0]?.evals ?? "0") - baselineEvals;
    expect(newActions).toBeGreaterThanOrEqual(1);
    expect(newEvals).toBeGreaterThanOrEqual(1);
  });

  it("declares + persists a serving-latency incident on a 2000ms burst against a 300ms budget", async () => {
    const actor = randomUUID();
    await conn.query(`INSERT INTO meta.users (id, email) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`, [actor, `lat-${actor}@crossengin.test`]);

    const clock = new FixedClock(BASE);
    const surface = `operate-server-${Math.random().toString(36).slice(2, 8)}`;
    const availabilityEngine = buildServingSloEngine({ clock, surface, systemActorUserId: actor });
    const latencyEngine = buildServingLatencyEngine({
      clock,
      surface,
      systemActorUserId: actor,
      p95Budget: "300ms",
    });
    const sink = new PostgresIncidentSink(conn);
    const monitor = new OperateSloMonitor({
      engine: availabilityEngine,
      latencyEngine,
      sink,
      clock,
      surface,
      declaredBy: actor,
    });

    for (let i = 0; i < 25; i += 1) {
      monitor.recordRequest(200, 2_000);
      clock.advance(1_000);
    }
    const decisions = await monitor.sweep(clock.now());
    const latencyOpened = decisions.find((d) => d.signal === "latency" && d.decision.kind === "breach_opened");
    expect(latencyOpened).toBeDefined();
    // The latency engine mints a `performance` incident — the contract being
    // tested. Sink persistence is identical between availability and latency
    // (both call `sink.record(plan.incident)`), so the persistence path is
    // already covered by the availability gated test above; asserting it again
    // here would be flaky because each engine instance restarts `incidentSeq=0`,
    // so cross-test `INC-YYYY-0001` collisions get silently dropped by the sink's
    // `ON CONFLICT (incident_id) DO NOTHING`.
    const incident =
      latencyOpened?.decision.kind === "breach_opened" ? latencyOpened.decision.plan.incident : null;
    expect(incident?.category).toBe("performance");
    expect(incident?.id).toMatch(/^INC-\d{4}-\d{4,8}$/);
  });
});
