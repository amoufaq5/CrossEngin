import { hostname } from "node:os";
import { readFile } from "node:fs/promises";

import { createNodePgConnection, parsePgEnvConfig, type PgConnection } from "@crossengin/kernel-pg";
import { formatIncidentId } from "@crossengin/observability-runtime";
import { WorkflowDefinitionSchema, type WorkflowDefinition } from "@crossengin/workflow-engine";
import { WorkflowReplayer, buildPersistentEngine } from "@crossengin/workflow-runtime-pg";
import {
  HeartbeatReporter,
  PostgresWorkerHeartbeatStore,
  WorkerHeartbeat,
} from "@crossengin/workflow-worker";

import type { WorkerCliOptions } from "./cli.js";
import { buildWorkerSet, type WorkerSet } from "./runner.js";
import { StaleWorkerMonitor } from "./stale-worker-monitor.js";
import { PostgresIncidentSink } from "./incident-sink.js";
import { PostgresIncidentReplayer } from "./incident-replayer.js";
import { LoggingPageDeliverer, WebhookPageDeliverer, deliverPages, type PageDeliverer } from "./page-sink.js";
import { runIncidents, runIncidentWrite, type IncidentsCliOptions } from "./incidents-cli.js";

/**
 * Parses a `--definitions` JSON file (an array of `WorkflowDefinition`s) into the
 * `id → definition` map `buildPersistentEngine` expects. An empty / absent path
 * yields an empty map (the worker still drains timers/retries for instances whose
 * definitions live elsewhere — but inline activity handlers need them, so a real
 * deployment passes the definitions it runs).
 */
export function parseDefinitionsJson(text: string): ReadonlyMap<string, WorkflowDefinition> {
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed)) throw new Error("--definitions must be a JSON array of WorkflowDefinitions");
  const map = new Map<string, WorkflowDefinition>();
  for (const raw of parsed) {
    const def = WorkflowDefinitionSchema.parse(raw);
    map.set(def.id, def);
  }
  return map;
}

async function loadDefinitions(path: string | null): Promise<ReadonlyMap<string, WorkflowDefinition>> {
  if (path === null) return new Map<string, WorkflowDefinition>();
  return parseDefinitionsJson(await readFile(path, "utf8"));
}

/**
 * Runs a one-shot `incidents` query against `meta.incidents`: opens a Postgres
 * connection from the `PG*` env vars, builds a `PostgresIncidentReplayer`,
 * dispatches the parsed command (open / period / verify) through `runIncidents`,
 * closes the connection, and returns the exit code (`verify` returns 1 on drift).
 */
export async function executeIncidents(
  options: IncidentsCliOptions,
  out: (line: string) => void = (line) => void process.stdout.write(`${line}\n`),
): Promise<number> {
  const conn: PgConnection = createNodePgConnection(parsePgEnvConfig());
  const schemaOpt = options.schema !== null ? { schema: options.schema } : {};
  try {
    if (options.command === "ack" || options.command === "mitigate") {
      const sink = new PostgresIncidentSink(conn, schemaOpt);
      const { exitCode } = await runIncidentWrite(options, sink, out);
      return exitCode;
    }
    const replayer = new PostgresIncidentReplayer(conn, schemaOpt);
    const { exitCode } = await runIncidents(options, replayer, out);
    return exitCode;
  } finally {
    await conn.close();
  }
}

export interface RunningWorker {
  readonly labels: readonly string[];
  readonly workerId: string;
  close(): Promise<void>;
}

/**
 * Boots the worker from parsed CLI options: opens a Postgres connection from the
 * standard `PG*` env vars, loads the workflow definitions, wires the persistent
 * engine (every fire/retry projects through the event log), builds the selected
 * worker set, and starts polling. Returns a handle that stops the workers and
 * closes the connection. The connecting role should see all tenants' workflow
 * rows (BYPASSRLS / table owner), since one worker drains every tenant.
 */
export async function run(options: WorkerCliOptions): Promise<RunningWorker> {
  const conn: PgConnection = createNodePgConnection(parsePgEnvConfig());
  const definitions = await loadDefinitions(options.definitionsPath);
  const { engine } = buildPersistentEngine({ conn, definitions });

  const logError = (err: unknown): void => {
    process.stderr.write(`[workflow-worker] poll error: ${err instanceof Error ? err.message : String(err)}\n`);
  };

  let reporter: HeartbeatReporter | null = null;
  if (options.heartbeatEnabled) {
    const heartbeat = new WorkerHeartbeat({ workerId: options.workerId, mode: options.mode, hostname: hostname() });
    const store = new PostgresWorkerHeartbeatStore(conn, options.schema !== null ? { schema: options.schema } : {});
    reporter = new HeartbeatReporter({ heartbeat, store, onError: logError });
  }

  const workers: WorkerSet = buildWorkerSet({
    conn,
    engine,
    mode: options.mode,
    workerId: options.workerId,
    schema: options.schema,
    tickIntervalMs: options.tickIntervalMs,
    claimIntervalMs: options.claimIntervalMs,
    retryIntervalMs: options.retryIntervalMs,
    timeoutIntervalMs: options.timeoutIntervalMs,
    executeIntervalMs: options.executeIntervalMs,
    reapIntervalMs: options.reapIntervalMs,
    resyncIntervalMs: options.resyncIntervalMs,
    resyncMax: options.resyncMax,
    resyncer: new WorkflowReplayer({ conn, definitions }),
    batchSize: options.batchSize,
    leaseMs: options.leaseMs,
    onError: (err) => {
      reporter?.onError(err);
      logError(err);
    },
    ...(reporter !== null ? { onRun: reporter.onRun } : {}),
  });
  let monitor: StaleWorkerMonitor | null = null;
  if (options.monitorEnabled) {
    let incidentSeq = 0;
    const incidentSink = options.persistIncidents
      ? new PostgresIncidentSink(conn, options.schema !== null ? { schema: options.schema } : {})
      : null;
    const pageDeliverer: PageDeliverer =
      options.pageWebhookUrl !== null
        ? new WebhookPageDeliverer({ url: options.pageWebhookUrl })
        : new LoggingPageDeliverer();
    monitor = new StaleWorkerMonitor({
      source: new PostgresWorkerHeartbeatStore(conn, options.schema !== null ? { schema: options.schema } : {}),
      declaredBy: options.monitorDeclaredBy,
      staleAfterMs: options.staleAfterMs,
      nextIncidentId: () => formatIncidentId(new Date().getUTCFullYear(), (incidentSeq += 1)),
      onIncident: async (plan) => {
        process.stdout.write(
          `[workflow-worker] STALE WORKERS — ${plan.incident.id} ${plan.severity}: ${plan.incident.title} (${plan.pages.length.toString()} page directive(s))\n`,
        );
        if (incidentSink !== null) await incidentSink.record(plan.incident);
        await deliverPages(pageDeliverer, plan.pages, { incidentId: plan.incident.id, severity: plan.severity, reason: "declared" });
        if (incidentSink !== null && plan.pages.length > 0) {
          await incidentSink.recordCommsSent(plan.incident.id, options.monitorDeclaredBy, { reason: "declared", pageCount: plan.pages.length });
        }
      },
      onResolve: async (incidentId) => {
        process.stdout.write(`[workflow-worker] STALE WORKERS RESOLVED — ${incidentId}\n`);
        if (incidentSink !== null) await incidentSink.resolve(incidentId, options.monitorDeclaredBy);
      },
      onEscalate: async ({ incidentId, severity, pages }) => {
        process.stdout.write(`[workflow-worker] STALE WORKERS ESCALATED — ${incidentId} → ${severity} (${pages.length.toString()} page directive(s))\n`);
        if (incidentSink !== null) await incidentSink.escalate(incidentId, severity, options.monitorDeclaredBy);
        await deliverPages(pageDeliverer, pages, { incidentId, severity, reason: "escalated" });
        if (incidentSink !== null && pages.length > 0) {
          await incidentSink.recordCommsSent(incidentId, options.monitorDeclaredBy, { reason: "escalated", pageCount: pages.length });
        }
      },
      onError: logError,
    });
  }

  workers.start();
  reporter?.start(options.heartbeatIntervalMs);
  monitor?.start(options.monitorIntervalMs);
  return {
    labels: workers.labels,
    workerId: options.workerId,
    close: async () => {
      workers.stop();
      monitor?.stop();
      if (reporter !== null) await reporter.stop();
      await conn.close();
    },
  };
}
