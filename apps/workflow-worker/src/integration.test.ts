import {
  createNodePgConnection,
  parsePgEnvConfig,
  type PgConnection,
} from "@crossengin/kernel-pg";
import type { WorkflowDefinition } from "@crossengin/workflow-engine";
import {
  FixedClock,
  WorkflowEngine,
  createDefaultRegistry,
} from "@crossengin/workflow-runtime";
import { WorkflowReplayer, buildPersistentEngine } from "@crossengin/workflow-runtime-pg";
import {
  ActivityExecutorWorker,
  ActivityTimeoutSweeperWorker,
  ClaimingTimerWorker,
  DriftSweepWorker,
  HeartbeatReporter,
  PostgresActivityExecuteClaimStore,
  PostgresActivityRetryClaimStore,
  PostgresActivityTimeoutClaimStore,
  PostgresInstanceTimeoutClaimStore,
  PostgresLeaseReaper,
  PostgresTimerClaimStore,
  PostgresWorkerHeartbeatStore,
  RetryExecutorWorker,
  TimeoutSweeperWorker,
  WorkerHeartbeat,
  summarizeWorkerHealth,
  type HeartbeatSnapshot,
} from "@crossengin/workflow-worker";
import { formatIncidentId } from "@crossengin/observability-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PostgresIncidentReplayer,
  PostgresIncidentSink,
  computeIncidentMetrics,
} from "@crossengin/incident-response-pg";

import { StaleWorkerMonitor, type StaleWorkerEnforcement } from "./stale-worker-monitor.js";

/**
 * Real-Postgres integration test for the distributed-worker claim loops. Gated
 * on `CROSSENGIN_PG_TEST=1` (skipped offline / in normal CI). It proves the
 * three claim stores' actual SQL — `FOR UPDATE SKIP LOCKED` disjoint claiming,
 * the lease lifecycle, and the engine's per-unit primitives advancing real
 * projection rows — which the unit tests (mocked connections) can't show.
 *
 * To run: bring up Postgres + apply the meta-schema, then
 *   CROSSENGIN_PG_TEST=1 PGHOST=localhost PGUSER=… PGPASSWORD=… PGDATABASE=… \
 *   PGSSLMODE=disable pnpm --filter @crossengin/workflow-worker-app test
 * The connecting role must own / bypass RLS on the workflow tables (the worker
 * spans all tenants).
 */
const RUN = process.env["CROSSENGIN_PG_TEST"] === "1";
const suite = RUN ? describe : describe.skip;

const T0 = new Date("2026-06-04T12:00:00.000Z");
const USER = "00000000-0000-4000-8000-0000000000aa";

function timerDef(id: string): WorkflowDefinition {
  return {
    id,
    tenantId: null,
    definitionKey: "it.timer",
    version: "1.0.0",
    label: "Timer def",
    description: "",
    status: "published",
    states: [
      { name: "draft", kind: "initial", label: "Draft", onEntryActions: [], onExitActions: [], slaSeconds: null },
      {
        name: "working",
        kind: "intermediate",
        label: "Working",
        onEntryActions: [{ kind: "schedule_timer", parameters: { timerName: "deadline", relativeSeconds: 1 } }],
        onExitActions: [],
        slaSeconds: null,
      },
      { name: "done", kind: "terminal_success", label: "Done", onEntryActions: [], onExitActions: [], slaSeconds: null },
    ],
    transitions: [
      { name: "start", fromState: "draft", toState: "working", trigger: { kind: "automatic" }, guards: [], preTransitionActions: [], postTransitionActions: [] },
      { name: "fire", fromState: "working", toState: "done", trigger: { kind: "timer_fired", timerName: "deadline" }, guards: [], preTransitionActions: [], postTransitionActions: [] },
    ],
    variables: [],
    timers: [],
    signals: [],
    initialState: "draft",
    compensationStrategy: "no_compensation",
    timeoutSeconds: 86_400,
    createdAt: T0.toISOString(),
    createdBy: USER,
    publishedAt: T0.toISOString(),
    publishedBy: null,
    deprecatedAt: null,
    supersededByDefinitionId: null,
    sourceManifestSha256: null,
  };
}

function activityDef(id: string): WorkflowDefinition {
  const base = timerDef(id);
  return {
    ...base,
    definitionKey: "it.activity",
    states: [
      { name: "draft", kind: "initial", label: "Draft", onEntryActions: [], onExitActions: [], slaSeconds: null },
      {
        name: "working",
        kind: "intermediate",
        label: "Working",
        onEntryActions: [{ kind: "schedule_activity", parameters: { activityKey: "work", kind: "transformation", input: { n: 7 } } }],
        onExitActions: [],
        slaSeconds: null,
      },
      { name: "done", kind: "terminal_success", label: "Done", onEntryActions: [], onExitActions: [], slaSeconds: null },
    ],
    transitions: [
      { name: "start", fromState: "draft", toState: "working", trigger: { kind: "automatic" }, guards: [], preTransitionActions: [], postTransitionActions: [] },
      { name: "complete", fromState: "working", toState: "done", trigger: { kind: "activity_completed", activityKey: "work" }, guards: [], preTransitionActions: [], postTransitionActions: [] },
    ],
  };
}

function asyncActivityDef(id: string): WorkflowDefinition {
  const base = timerDef(id);
  return {
    ...base,
    definitionKey: "it.async",
    states: [
      { name: "draft", kind: "initial", label: "Draft", onEntryActions: [], onExitActions: [], slaSeconds: null },
      {
        name: "working",
        kind: "intermediate",
        label: "Working",
        onEntryActions: [{ kind: "schedule_activity", parameters: { activityKey: "work", kind: "transformation", input: { n: 7 }, executionMode: "async" } }],
        onExitActions: [],
        slaSeconds: null,
      },
      { name: "done", kind: "terminal_success", label: "Done", onEntryActions: [], onExitActions: [], slaSeconds: null },
    ],
    transitions: [
      { name: "start", fromState: "draft", toState: "working", trigger: { kind: "automatic" }, guards: [], preTransitionActions: [], postTransitionActions: [] },
      { name: "complete", fromState: "working", toState: "done", trigger: { kind: "activity_completed", activityKey: "work" }, guards: [], preTransitionActions: [], postTransitionActions: [] },
    ],
  };
}

function timeoutDef(id: string): WorkflowDefinition {
  const base = timerDef(id);
  return {
    ...base,
    definitionKey: "it.timeout",
    states: [
      { name: "draft", kind: "initial", label: "Draft", onEntryActions: [], onExitActions: [], slaSeconds: null },
      { name: "waiting", kind: "waiting", label: "Waiting", onEntryActions: [], onExitActions: [], slaSeconds: null },
      { name: "done", kind: "terminal_success", label: "Done", onEntryActions: [], onExitActions: [], slaSeconds: null },
    ],
    transitions: [
      { name: "start", fromState: "draft", toState: "waiting", trigger: { kind: "automatic" }, guards: [], preTransitionActions: [], postTransitionActions: [] },
      { name: "go", fromState: "waiting", toState: "done", trigger: { kind: "signal_received", signalName: "go" }, guards: [], preTransitionActions: [], postTransitionActions: [] },
    ],
    timeoutSeconds: 60,
  };
}

const defId = (): string => `wfd_it${Math.random().toString(36).slice(2, 12)}`;

suite("workflow-worker integration (real Postgres)", () => {
  let conn: PgConnection;
  let tenantId: string;

  async function seedDefinition(def: WorkflowDefinition): Promise<void> {
    await conn.query(
      `INSERT INTO meta.workflow_definitions (
         definition_id, definition_key, version, label, description, status,
         states, transitions, initial_state, compensation_strategy,
         timeout_seconds, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12)
       ON CONFLICT (definition_id) DO NOTHING`,
      [
        def.id, def.definitionKey, def.version, def.label, def.description, def.status,
        JSON.stringify(def.states), JSON.stringify(def.transitions), def.initialState,
        def.compensationStrategy, def.timeoutSeconds, USER,
      ],
    );
  }

  function makeEngine(def: WorkflowDefinition, clock: FixedClock, flaky = false): WorkflowEngine {
    const registry = createDefaultRegistry();
    if (flaky) {
      registry.registerForActivity(def.id, "work", async (inv) =>
        inv.attemptNumber === 1
          ? { status: "failed", errorCode: "FLAKY", errorMessage: "first attempt", retryable: true }
          : { status: "succeeded", output: { ok: true } },
      );
    }
    return buildPersistentEngine({ conn, definitions: new Map([[def.id, def]]), activityRegistry: registry, clock }).engine;
  }

  beforeAll(async () => {
    conn = createNodePgConnection(parsePgEnvConfig());
    const suffix = Math.random().toString(36).slice(2, 10);
    const t = await conn.query<{ id: string }>(
      `INSERT INTO meta.tenants (slug, name, schema_name) VALUES ($1,$1,$2) RETURNING id`,
      [`it-${suffix}`, `tenant_it_${suffix}`],
    );
    tenantId = t.rows[0]!.id;
    await conn.query(`INSERT INTO meta.users (id, email) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`, [USER, "it@crossengin.test"]);
  });

  afterAll(async () => {
    if (conn !== undefined) await conn.close();
  });

  it("ClaimingTimerWorker fires due timers and SKIP LOCKED keeps two workers disjoint", async () => {
    const def = timerDef(defId());
    await seedDefinition(def);
    const engine = makeEngine(def, new FixedClock(new Date(T0)));

    const N = 6;
    for (let i = 0; i < N; i += 1) {
      await engine.startInstance({ definitionId: def.id, tenantId });
    }

    const store = new PostgresTimerClaimStore(conn);
    const clock = { now: () => new Date(T0.getTime() + 10_000) }; // past fire_at (T0+1s)
    const wA = new ClaimingTimerWorker({ claimStore: store, engine, workerId: "wA", clock, batchSize: 3 });
    const wB = new ClaimingTimerWorker({ claimStore: store, engine, workerId: "wB", clock, batchSize: 3 });

    // two workers race the same backlog: SKIP LOCKED must partition it, no double-fire
    const [rA, rB] = await Promise.all([wA.runOnce(), wB.runOnce()]);
    expect(rA.fired + rB.fired).toBe(N);

    const done = await conn.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM meta.workflow_instances
        WHERE definition_key = 'it.timer' AND status = 'completed' AND tenant_id = $1`,
      [tenantId],
    );
    expect(Number(done.rows[0]!.c)).toBe(N);
  });

  it("RetryExecutorWorker re-runs a failed activity once its backoff has elapsed", async () => {
    const def = activityDef(defId());
    await seedDefinition(def);
    const engine = makeEngine(def, new FixedClock(new Date(T0)), true);
    const start = await engine.startInstance({ definitionId: def.id, tenantId });

    const failed = await conn.query<{ status: string; next_retry_at: string | null }>(
      `SELECT status, next_retry_at FROM meta.workflow_activities WHERE instance_id =
         (SELECT id FROM meta.workflow_instances WHERE instance_id = $1)`,
      [start.instanceId],
    );
    expect(failed.rows[0]!.status).toBe("failed");
    expect(failed.rows[0]!.next_retry_at).not.toBeNull();

    const store = new PostgresActivityRetryClaimStore(conn);
    const worker = new RetryExecutorWorker({ claimStore: store, engine, workerId: "wr", clock: { now: () => new Date(T0.getTime() + 60_000) } });
    const res = await worker.runOnce();
    expect(res).toMatchObject({ retried: 1, succeeded: 1 });

    const after = await conn.query<{ status: string }>(`SELECT status FROM meta.workflow_instances WHERE instance_id = $1`, [start.instanceId]);
    expect(after.rows[0]!.status).toBe("completed");
  });

  it("TimeoutSweeperWorker fails an instance past its deadline with INSTANCE_TIMEOUT", async () => {
    const def = timeoutDef(defId());
    await seedDefinition(def);
    const engine = makeEngine(def, new FixedClock(new Date(T0)));
    const start = await engine.startInstance({ definitionId: def.id, tenantId });

    const parked = await conn.query<{ status: string }>(`SELECT status FROM meta.workflow_instances WHERE instance_id = $1`, [start.instanceId]);
    expect(parked.rows[0]!.status).toBe("waiting_for_signal");

    const store = new PostgresInstanceTimeoutClaimStore(conn);
    const worker = new TimeoutSweeperWorker({ claimStore: store, engine, workerId: "wt", clock: { now: () => new Date(T0.getTime() + 120_000) } });
    const res = await worker.runOnce();
    expect(res.timedOut).toBeGreaterThanOrEqual(1);

    const after = await conn.query<{ status: string; failure_code: string | null }>(
      `SELECT status, failure_code FROM meta.workflow_instances WHERE instance_id = $1`,
      [start.instanceId],
    );
    expect(after.rows[0]!.status).toBe("failed");
    expect(after.rows[0]!.failure_code).toBe("INSTANCE_TIMEOUT");
  });

  it("ActivityExecutorWorker runs an async-scheduled activity the engine left pending", async () => {
    const def = asyncActivityDef(defId());
    await seedDefinition(def);
    const engine = makeEngine(def, new FixedClock(new Date(T0)));
    const start = await engine.startInstance({ definitionId: def.id, tenantId });

    // async: the activity is scheduled but NOT run inline — instance parks
    const pending = await conn.query<{ status: string; execution_mode: string }>(
      `SELECT status, execution_mode FROM meta.workflow_activities WHERE instance_id =
         (SELECT id FROM meta.workflow_instances WHERE instance_id = $1)`,
      [start.instanceId],
    );
    expect(pending.rows[0]).toMatchObject({ status: "scheduled", execution_mode: "async" });

    const store = new PostgresActivityExecuteClaimStore(conn);
    const worker = new ActivityExecutorWorker({ claimStore: store, engine, workerId: "we", clock: { now: () => new Date(T0.getTime() + 1_000) } });
    const res = await worker.runOnce();
    expect(res).toMatchObject({ executed: 1, succeeded: 1 });

    const after = await conn.query<{ status: string }>(`SELECT status FROM meta.workflow_instances WHERE instance_id = $1`, [start.instanceId]);
    expect(after.rows[0]!.status).toBe("completed");
  });

  it("ActivityTimeoutSweeperWorker times out an async activity no executor ran in time", async () => {
    const def = asyncActivityDef(defId());
    await seedDefinition(def);
    const engine = makeEngine(def, new FixedClock(new Date(T0)));
    const start = await engine.startInstance({ definitionId: def.id, tenantId });

    // scheduled async (default 300s timeout), never executed; timeout_at = T0 + 300s
    const before = await conn.query<{ status: string; timeout_at: string }>(
      `SELECT status, timeout_at FROM meta.workflow_activities WHERE instance_id =
         (SELECT id FROM meta.workflow_instances WHERE instance_id = $1)`,
      [start.instanceId],
    );
    expect(before.rows[0]!.status).toBe("scheduled");

    const store = new PostgresActivityTimeoutClaimStore(conn);
    const worker = new ActivityTimeoutSweeperWorker({ claimStore: store, engine, workerId: "wat", clock: { now: () => new Date(T0.getTime() + 400_000) } });
    const res = await worker.runOnce();
    expect(res.timedOut).toBeGreaterThanOrEqual(1);

    const after = await conn.query<{ status: string; next_retry_at: string | null }>(
      `SELECT status, next_retry_at FROM meta.workflow_activities WHERE instance_id =
         (SELECT id FROM meta.workflow_instances WHERE instance_id = $1)`,
      [start.instanceId],
    );
    expect(after.rows[0]!.status).toBe("timed_out");
    expect(after.rows[0]!.next_retry_at).not.toBeNull();
  });

  it("DriftSweepWorker re-projects an instance whose projection drifted", async () => {
    const def = timerDef(defId());
    await seedDefinition(def);
    const engine = makeEngine(def, new FixedClock(new Date(T0)));
    const start = await engine.startInstance({ definitionId: def.id, tenantId });
    expect((await engine.getInstanceState(start.instanceId))?.status).toBe("waiting_for_timer");

    // corrupt the projected status (as a crashed projection would leave it)
    await conn.query(`UPDATE meta.workflow_instances SET status = 'created' WHERE instance_id = $1`, [start.instanceId]);

    const resyncer = new WorkflowReplayer({ conn, definitions: new Map([[def.id, def]]) });
    const worker = new DriftSweepWorker({ resyncer, maxInstances: 500 });
    const res = await worker.runOnce();
    expect(res.resynced).toBeGreaterThanOrEqual(1);

    // the canonical event log re-projects the correct status
    const fixed = await conn.query<{ status: string }>(`SELECT status FROM meta.workflow_instances WHERE instance_id = $1`, [start.instanceId]);
    expect(fixed.rows[0]!.status).toBe("waiting_for_timer");
  });

  it("PostgresLeaseReaper clears expired leases across timers/activities/instances", async () => {
    const def = asyncActivityDef(defId());
    await seedDefinition(def);
    const engine = makeEngine(def, new FixedClock(new Date(T0)));
    const start = await engine.startInstance({ definitionId: def.id, tenantId });

    // stamp an expired lease on the instance + its scheduled activity (as a dead worker would leave)
    const past = new Date(T0.getTime() - 10_000).toISOString();
    await conn.query(`UPDATE meta.workflow_instances SET claimed_by = 'dead', lease_expires_at = $2 WHERE instance_id = $1`, [start.instanceId, past]);
    await conn.query(
      `UPDATE meta.workflow_activities SET claimed_by = 'dead', lease_expires_at = $1
        WHERE instance_id = (SELECT id FROM meta.workflow_instances WHERE instance_id = $2)`,
      [past, start.instanceId],
    );

    const reaper = new PostgresLeaseReaper(conn);
    const result = await reaper.reapExpired(new Date(T0));
    expect(result.instances).toBeGreaterThanOrEqual(1);
    expect(result.activities).toBeGreaterThanOrEqual(1);

    const inst = await conn.query<{ claimed_by: string | null }>(`SELECT claimed_by FROM meta.workflow_instances WHERE instance_id = $1`, [start.instanceId]);
    expect(inst.rows[0]!.claimed_by).toBeNull();
  });

  it("HeartbeatReporter persists a worker heartbeat row upserted on worker_id", async () => {
    const workerId = `wh-${Math.random().toString(36).slice(2, 10)}`;
    const heartbeat = new WorkerHeartbeat({ workerId, mode: "all", hostname: "it-host" });
    const store = new PostgresWorkerHeartbeatStore(conn);
    const reporter = new HeartbeatReporter({ heartbeat, store });
    reporter.onRun({ claimed: 4, processed: 3 });
    reporter.onRun({ claimed: 1, processed: 1 });
    reporter.onError(new Error("transient"));
    await reporter.flush();

    const row = await conn.query<{ status: string; poll_count: string; claimed_total: string; processed_total: string; error_count: string; hostname: string }>(
      `SELECT status, poll_count, claimed_total, processed_total, error_count, hostname
         FROM meta.worker_heartbeats WHERE worker_id = $1`,
      [workerId],
    );
    expect(row.rows[0]).toMatchObject({ status: "starting", hostname: "it-host" });
    expect(Number(row.rows[0]!.poll_count)).toBe(2);
    expect(Number(row.rows[0]!.claimed_total)).toBe(5);
    expect(Number(row.rows[0]!.processed_total)).toBe(4);
    expect(Number(row.rows[0]!.error_count)).toBe(1);

    // a second flush upserts the same row (no duplicate)
    await reporter.stop();
    const count = await conn.query<{ c: string }>(`SELECT count(*)::text AS c FROM meta.worker_heartbeats WHERE worker_id = $1`, [workerId]);
    expect(Number(count.rows[0]!.c)).toBe(1);
  });

  it("listStale + summarizeWorkerHealth flag a running worker that stopped beating", async () => {
    const store = new PostgresWorkerHeartbeatStore(conn);
    const now = new Date("2026-06-04T12:00:00.000Z");
    const fresh = `wh-fresh-${Math.random().toString(36).slice(2, 8)}`;
    const dead = `wh-dead-${Math.random().toString(36).slice(2, 8)}`;
    const base = (workerId: string, lastHeartbeatAt: string): HeartbeatSnapshot => ({
      workerId, mode: "all", status: "running", hostname: "h", startedAt: "2026-06-04T11:00:00.000Z",
      lastHeartbeatAt, lastRunAt: lastHeartbeatAt, pollCount: 1, claimedTotal: 0, processedTotal: 0, errorCount: 0, lastError: null,
    });
    await store.upsert(base(fresh, new Date(now.getTime() - 5_000).toISOString()));
    await store.upsert(base(dead, new Date(now.getTime() - 300_000).toISOString()));

    const stale = await store.listStale({ now, staleAfterMs: 60_000 });
    expect(stale.some((a) => a.workerId === dead)).toBe(true);
    expect(stale.some((a) => a.workerId === fresh)).toBe(false);

    const report = summarizeWorkerHealth(await store.listAll(), { now, staleAfterMs: 60_000 });
    expect(report.alerts.some((a) => a.workerId === dead)).toBe(true);
    expect(report.stale).toBeGreaterThanOrEqual(1);
  });

  it("StaleWorkerMonitor (as run() wires it) declares an incident for a stale worker", async () => {
    const store = new PostgresWorkerHeartbeatStore(conn);
    const dead = `wh-mon-${Math.random().toString(36).slice(2, 8)}`;
    await store.upsert({
      workerId: dead, mode: "all", status: "running", hostname: "h", startedAt: "2026-06-04T11:00:00.000Z",
      lastHeartbeatAt: "2026-06-04T11:55:00.000Z", lastRunAt: null, pollCount: 1, claimedTotal: 0, processedTotal: 0, errorCount: 0, lastError: null,
    });

    const incidents: StaleWorkerEnforcement[] = [];
    let seq = 0;
    const monitor = new StaleWorkerMonitor({
      source: store,
      declaredBy: "00000000-0000-4000-8000-000000000000",
      staleAfterMs: 60_000,
      clock: { now: () => new Date("2026-06-04T12:00:00.000Z") },
      nextIncidentId: () => formatIncidentId(2026, (seq += 1)),
      onIncident: (plan) => { incidents.push(plan); },
    });
    const report = await monitor.checkOnce();
    expect(report.stale).toBeGreaterThanOrEqual(1);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]?.incident.id).toMatch(/^INC-2026-\d{4}$/);
    expect(incidents[0]?.incident.status).toBe("declared");
  });

  it("PostgresIncidentSink persists the monitor's stale-worker incident to meta.incidents", async () => {
    // declared_by FK → seed a system user
    const declaredBy = "00000000-0000-4000-8000-0000000000aa";
    await conn.query(`INSERT INTO meta.users (id, email) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`, [declaredBy, "monitor@crossengin.test"]);

    const store = new PostgresWorkerHeartbeatStore(conn);
    const dead = `wh-inc-${Math.random().toString(36).slice(2, 8)}`;
    await store.upsert({
      workerId: dead, mode: "all", status: "running", hostname: "h", startedAt: "2026-06-04T11:00:00.000Z",
      lastHeartbeatAt: "2026-06-04T11:55:00.000Z", lastRunAt: null, pollCount: 1, claimedTotal: 0, processedTotal: 0, errorCount: 0, lastError: null,
    });

    const sink = new PostgresIncidentSink(conn);
    const incidentId = `INC-2026-${Math.floor(1000 + Math.random() * 8999).toString()}`;
    const monitor = new StaleWorkerMonitor({
      source: store,
      declaredBy,
      staleAfterMs: 60_000,
      clock: { now: () => new Date("2026-06-04T12:00:00.000Z") },
      nextIncidentId: () => incidentId,
      onIncident: async (plan) => { await sink.record(plan.incident); },
    });
    await monitor.checkOnce();

    const row = await conn.query<{ severity: string; status: string; declared_by: string }>(
      `SELECT severity, status, declared_by::text FROM meta.incidents WHERE incident_id = $1`,
      [incidentId],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]).toMatchObject({ status: "declared", declared_by: declaredBy });
    expect(["sev2", "sev3"]).toContain(row.rows[0]!.severity);
  });

  it("resolves a persisted stale-worker incident when the worker recovers", async () => {
    const declaredBy = "00000000-0000-4000-8000-0000000000aa";
    await conn.query(`INSERT INTO meta.users (id, email) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`, [declaredBy, "monitor@crossengin.test"]);

    const store = new PostgresWorkerHeartbeatStore(conn);
    const worker = `wh-life-${Math.random().toString(36).slice(2, 8)}`;
    const beat = (lastHeartbeatAt: string) =>
      store.upsert({ workerId: worker, mode: "all", status: "running", hostname: "h", startedAt: "2026-06-04T11:00:00.000Z", lastHeartbeatAt, lastRunAt: null, pollCount: 1, claimedTotal: 0, processedTotal: 0, errorCount: 0, lastError: null });
    await beat("2026-06-04T11:55:00.000Z"); // stale (5 min old at the check time)

    const sink = new PostgresIncidentSink(conn);
    const incidentId = `INC-2026-${Math.floor(1000 + Math.random() * 8999).toString()}`;
    const monitor = new StaleWorkerMonitor({
      source: store,
      declaredBy,
      staleAfterMs: 60_000,
      clock: { now: () => new Date("2026-06-04T12:00:00.000Z") },
      nextIncidentId: () => incidentId,
      onIncident: async (plan) => { await sink.record(plan.incident); },
      onResolve: async (id) => { await sink.resolve(id, declaredBy); },
    });

    // this run only owns its `worker`, but other rows may be stale → assert on our incident id
    await monitor.checkOnce(); // declares + persists (if our worker is the trigger; ensure it is by checking the row)
    // make our worker fresh, then ensure no other stale rows would keep it open:
    await conn.query(`UPDATE meta.worker_heartbeats SET status = 'stopped' WHERE worker_id <> $1 AND status = 'running' AND last_heartbeat_at < $2`, [worker, "2026-06-04T11:59:00.000Z"]);
    await beat("2026-06-04T11:59:30.000Z"); // recovered (30s old)
    await monitor.checkOnce(); // resolves

    const row = await conn.query<{ status: string; resolved_at: string | null; timeline: unknown }>(
      `SELECT status, resolved_at, timeline FROM meta.incidents WHERE incident_id = $1`, [incidentId],
    );
    // the incident was declared then resolved
    expect(row.rows[0]?.status).toBe("resolved");
    expect(row.rows[0]?.resolved_at).not.toBeNull();
    // the timeline grew with a `resolved` entry alongside the `declared` one
    const timeline = row.rows[0]?.timeline as ReadonlyArray<{ kind: string }>;
    expect(timeline.map((e) => e.kind)).toContain("resolved");
  });

  it("escalates a persisted incident's severity when more workers go stale", async () => {
    const declaredBy = "00000000-0000-4000-8000-0000000000aa";
    await conn.query(`INSERT INTO meta.users (id, email) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`, [declaredBy, "monitor@crossengin.test"]);
    // isolate: only this test's workers are running (others → stopped)
    await conn.query("UPDATE meta.worker_heartbeats SET status = 'stopped' WHERE status = 'running'");

    const store = new PostgresWorkerHeartbeatStore(conn);
    const stale = "2026-06-04T11:55:00.000Z";
    const beat = (id: string) =>
      store.upsert({ workerId: id, mode: "all", status: "running", hostname: "h", startedAt: "2026-06-04T11:00:00.000Z", lastHeartbeatAt: stale, lastRunAt: null, pollCount: 1, claimedTotal: 0, processedTotal: 0, errorCount: 0, lastError: null });
    const pfx = `wh-esc-${Math.random().toString(36).slice(2, 8)}`;
    await beat(`${pfx}-1`); // 1 stale → sev3

    const sink = new PostgresIncidentSink(conn);
    const incidentId = `INC-2026-${Math.floor(1000 + Math.random() * 8999).toString()}`;
    const monitor = new StaleWorkerMonitor({
      source: store, declaredBy, staleAfterMs: 60_000,
      clock: { now: () => new Date("2026-06-04T12:00:00.000Z") },
      nextIncidentId: () => incidentId,
      onIncident: async (plan) => { await sink.record(plan.incident); },
      onEscalate: async ({ incidentId: id, severity }) => { await sink.escalate(id, severity, declaredBy); },
    });
    await monitor.checkOnce(); // declares sev3
    const declared = await conn.query<{ severity: string }>(`SELECT severity FROM meta.incidents WHERE incident_id = $1`, [incidentId]);
    expect(declared.rows[0]?.severity).toBe("sev3");

    await beat(`${pfx}-2`);
    await beat(`${pfx}-3`); // now 3 stale → sev2
    await monitor.checkOnce(); // escalate
    const escalated = await conn.query<{ severity: string; timeline: unknown }>(`SELECT severity, timeline FROM meta.incidents WHERE incident_id = $1`, [incidentId]);
    expect(escalated.rows[0]?.severity).toBe("sev2");
    // the escalation appended a `severity_changed` timeline entry
    const timeline = escalated.rows[0]?.timeline as ReadonlyArray<{ kind: string; metadata?: { severity?: string } }>;
    const changed = timeline.find((e) => e.kind === "severity_changed");
    expect(changed?.metadata?.severity).toBe("sev2");
  });

  it("the incident replayer reads open incidents, a window, and verifies a clean timeline", async () => {
    const declaredBy = "00000000-0000-4000-8000-0000000000aa";
    await conn.query(`INSERT INTO meta.users (id, email) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`, [declaredBy, "monitor@crossengin.test"]);
    await conn.query("UPDATE meta.worker_heartbeats SET status = 'stopped' WHERE status = 'running'");

    const store = new PostgresWorkerHeartbeatStore(conn);
    const worker = `wh-rep-${Math.random().toString(36).slice(2, 8)}`;
    const beat = (lastHeartbeatAt: string) =>
      store.upsert({ workerId: worker, mode: "all", status: "running", hostname: "h", startedAt: "2026-06-04T11:00:00.000Z", lastHeartbeatAt, lastRunAt: null, pollCount: 1, claimedTotal: 0, processedTotal: 0, errorCount: 0, lastError: null });
    await beat("2026-06-04T11:55:00.000Z"); // stale

    const sink = new PostgresIncidentSink(conn);
    const openId = `INC-2026-${Math.floor(1000 + Math.random() * 8999).toString()}`;
    const monitor = new StaleWorkerMonitor({
      source: store, declaredBy, staleAfterMs: 60_000,
      clock: { now: () => new Date("2026-06-04T12:00:00.000Z") },
      nextIncidentId: () => openId,
      onIncident: async (plan) => { await sink.record(plan.incident); },
      onResolve: async (id) => { await sink.resolve(id, declaredBy); },
    });
    await monitor.checkOnce(); // declares the open incident

    const replayer = new PostgresIncidentReplayer(conn);

    // listOpen surfaces the just-declared (non-terminal) incident with its timeline
    const open = await replayer.listOpen();
    const mine = open.find((s) => s.incidentId === openId);
    expect(mine).toBeDefined();
    expect(mine?.status).toBe("declared");
    expect(mine?.timeline.map((e) => e.kind)).toEqual(["declared"]);

    // verify the declared incident is clean
    expect(await replayer.verifyByIncidentId(openId)).toEqual([]);

    // resolve it, then confirm it leaves the open set and verifies clean (declared → resolved)
    await conn.query(`UPDATE meta.worker_heartbeats SET status = 'stopped' WHERE worker_id <> $1 AND status = 'running' AND last_heartbeat_at < $2`, [worker, "2026-06-04T11:59:00.000Z"]);
    await beat("2026-06-04T11:59:30.000Z"); // recovered
    await monitor.checkOnce(); // resolves

    const afterResolve = await replayer.listOpen();
    expect(afterResolve.find((s) => s.incidentId === openId)).toBeUndefined();

    const resolved = await replayer.getByIncidentId(openId);
    expect(resolved?.status).toBe("resolved");
    expect(resolved?.resolvedAt).not.toBeNull();
    expect(resolved?.timeline.map((e) => e.kind)).toEqual(["declared", "resolved"]);
    expect(await replayer.verifyByIncidentId(openId)).toEqual([]);

    // listForPeriod returns the incident in a window spanning its declaration
    const window = await replayer.listForPeriod({ from: "2026-06-04T00:00:00.000Z", to: "2026-06-05T00:00:00.000Z" });
    expect(window.some((s) => s.incidentId === openId)).toBe(true);
  });

  it("records ack + mitigate milestones and the replayer + metrics compute MTTA/MTTM/MTTR", async () => {
    const declaredBy = "00000000-0000-4000-8000-0000000000aa";
    await conn.query(`INSERT INTO meta.users (id, email) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`, [declaredBy, "monitor@crossengin.test"]);

    const sink = new PostgresIncidentSink(conn);
    const id = `INC-2026-${Math.floor(1000 + Math.random() * 8999).toString()}`;
    // declare via a hand-built record so the test owns the whole lifecycle
    await sink.record({
      id, title: "1 workflow worker(s) stale", severity: "sev3", category: "availability", status: "declared",
      affectedTenantIds: [], affectedRegions: [], publiclyVisible: false,
      declaredAt: "2026-06-04T12:00:00.000Z", declaredBy,
      roleAssignments: [],
      timeline: [{ occurredAt: "2026-06-04T12:00:00.000Z", actorUserId: declaredBy, kind: "declared", message: "stale", metadata: {} }],
      securityIncident: false, breachDataClasses: [],
    } as unknown as Parameters<typeof sink.record>[0]);

    await sink.acknowledge(id, declaredBy);
    await sink.mitigate(id, declaredBy);
    await sink.resolve(id, declaredBy);

    const replayer = new PostgresIncidentReplayer(conn);
    const summary = await replayer.getByIncidentId(id);
    expect(summary?.status).toBe("resolved");
    // the timeline carries declared → triaged → mitigated → resolved
    expect(summary?.timeline.map((e) => e.kind)).toEqual(["declared", "status_changed", "status_changed", "resolved"]);
    const statuses = (summary?.timeline ?? []).filter((e) => e.kind === "status_changed").map((e) => e.metadata["status"]);
    expect(statuses).toEqual(["triaged", "mitigated"]);

    // acked_at / mitigated_at / resolved_at were all stamped
    const stamps = await conn.query<{ acked_at: string | null; mitigated_at: string | null; resolved_at: string | null }>(
      `SELECT acked_at, mitigated_at, resolved_at FROM meta.incidents WHERE incident_id = $1`, [id],
    );
    expect(stamps.rows[0]?.acked_at).not.toBeNull();
    expect(stamps.rows[0]?.mitigated_at).not.toBeNull();
    expect(stamps.rows[0]?.resolved_at).not.toBeNull();

    // metrics over just this incident compute all three milestones (declared at a
    // fixed past time, milestones stamped at now() → positive durations)
    const metrics = computeIncidentMetrics(summary === null ? [] : [summary]);
    expect(metrics.mtta?.count).toBe(1);
    expect(metrics.mttm?.count).toBe(1);
    expect(metrics.mttr?.count).toBe(1);
    expect(await replayer.verifyByIncidentId(id)).toEqual([]); // still a clean timeline
  });

  it("recordCommsSent appends a comms_sent entry to a live incident and verify stays clean", async () => {
    const declaredBy = "00000000-0000-4000-8000-0000000000aa";
    await conn.query(`INSERT INTO meta.users (id, email) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`, [declaredBy, "monitor@crossengin.test"]);

    const sink = new PostgresIncidentSink(conn);
    const id = `INC-2026-${Math.floor(1000 + Math.random() * 8999).toString()}`;
    await sink.record({
      id, title: "1 workflow worker(s) stale", severity: "sev3", category: "availability", status: "declared",
      affectedTenantIds: [], affectedRegions: [], publiclyVisible: false,
      declaredAt: "2026-06-04T12:00:00.000Z", declaredBy,
      roleAssignments: [],
      timeline: [{ occurredAt: "2026-06-04T12:00:00.000Z", actorUserId: declaredBy, kind: "declared", message: "stale", metadata: {} }],
      securityIncident: false, breachDataClasses: [],
    } as unknown as Parameters<typeof sink.record>[0]);

    await sink.recordCommsSent(id, declaredBy, { reason: "declared", pageCount: 2 });

    const replayer = new PostgresIncidentReplayer(conn);
    const summary = await replayer.getByIncidentId(id);
    expect(summary?.timeline.map((e) => e.kind)).toEqual(["declared", "comms_sent"]);
    const comms = (summary?.timeline ?? []).find((e) => e.kind === "comms_sent");
    expect(comms?.metadata).toMatchObject({ reason: "declared", pageCount: 2 });
    // a comms_sent entry on an open incident is not timeline drift
    expect(await replayer.verifyByIncidentId(id)).toEqual([]);
  });

  it("a claimed timer's lease blocks a second claimer until it expires", async () => {
    const def = timerDef(defId());
    await seedDefinition(def);
    const engine = makeEngine(def, new FixedClock(new Date(T0)));
    await engine.startInstance({ definitionId: def.id, tenantId });

    const store = new PostgresTimerClaimStore(conn);
    const now = new Date(T0.getTime() + 10_000);
    const first = await store.claimDueTimers({ workerId: "w1", now, limit: 10, leaseMs: 60_000 });
    expect(first.length).toBeGreaterThanOrEqual(1);

    // a second claimer at the same instant sees the lease and skips the leased rows
    const second = await store.claimDueTimers({ workerId: "w2", now, limit: 10, leaseMs: 60_000 });
    const overlap = second.filter((s) => first.some((f) => f.timerId === s.timerId));
    expect(overlap).toHaveLength(0);

    // after the lease expires, the rows are reclaimable
    const later = new Date(now.getTime() + 61_000);
    const reclaimed = await store.claimDueTimers({ workerId: "w3", now: later, limit: 10, leaseMs: 60_000 });
    expect(reclaimed.some((r) => first.some((f) => f.timerId === r.timerId))).toBe(true);
  });
});
