import type { PgConnection } from "@crossengin/kernel-pg";
import type { WorkflowEngine } from "@crossengin/workflow-runtime";
import {
  WorkflowTimerWorker,
  type ClaimedTimer,
  type TimerClaimer,
  type TimerProcessor,
} from "@crossengin/workflow-worker";

import { claimDueTimers, releaseTimerClaim } from "./timer-claim.js";

/** The engine surface a timer processor needs — the log-driven, targeted fire from ADR-0177. */
export type TimerFiringEngine = Pick<WorkflowEngine, "fireDueTimersForInstance">;

/** Adapts the Postgres `claimDueTimers` / `releaseTimerClaim` SQL to the worker's `TimerClaimer`. */
export function buildTimerClaimer(conn: PgConnection, opts: { readonly schema?: string } = {}): TimerClaimer {
  const schemaOpt = opts.schema !== undefined ? { schema: opts.schema } : {};
  return {
    claim: (o) => claimDueTimers(conn, { ...o, ...schemaOpt }),
    release: (o) => releaseTimerClaim(conn, { ...o, ...schemaOpt }),
  };
}

/**
 * A `TimerProcessor` that fires a claimed timer by advancing its instance from the durable event
 * log (`engine.fireDueTimersForInstance`). The worker connection is platform-scoped (RLS-bypassing,
 * per ADR-0175), so one engine serves every tenant and the correct `tenant_id` rides on each
 * appended event from the projected instance state. Firing is idempotent — an already-fired timer
 * is a no-op — which is exactly what the worker's at-least-once retry semantics require.
 */
export function buildTimerProcessor(
  engine: TimerFiringEngine,
  opts: { readonly now?: () => Date } = {},
): TimerProcessor {
  const now = opts.now ?? (() => new Date());
  return {
    process: async (timer: ClaimedTimer) => {
      await engine.fireDueTimersForInstance(timer.instanceId, now().getTime());
    },
  };
}

export interface BuildWorkflowTimerWorkerInput {
  readonly conn: PgConnection;
  readonly engine: TimerFiringEngine;
  readonly workerId: string;
  readonly schema?: string;
  readonly batchLimit?: number;
  readonly leaseMs?: number;
  readonly idlePollMs?: number;
  readonly activePollMs?: number;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onError?: (err: unknown) => void;
  readonly onBatch?: (result: { claimed: number }) => void;
}

/**
 * Wires the three P2 primitives into a runnable distributed timer worker: the Postgres claim
 * (`FOR UPDATE SKIP LOCKED`) behind a `TimerClaimer`, a log-driven fire behind a `TimerProcessor`,
 * and the poll loop. Many of these run against one queue; each claims a disjoint batch and fires
 * its instances. `now` drives both the claim's due-check and the fire's clock so they agree.
 */
export function buildWorkflowTimerWorker(input: BuildWorkflowTimerWorkerInput): WorkflowTimerWorker {
  const claimer = buildTimerClaimer(input.conn, input.schema !== undefined ? { schema: input.schema } : {});
  const processor = buildTimerProcessor(input.engine, input.now !== undefined ? { now: input.now } : {});
  return new WorkflowTimerWorker({
    workerId: input.workerId,
    claimer,
    processor,
    ...(input.batchLimit !== undefined ? { batchLimit: input.batchLimit } : {}),
    ...(input.leaseMs !== undefined ? { leaseMs: input.leaseMs } : {}),
    ...(input.idlePollMs !== undefined ? { idlePollMs: input.idlePollMs } : {}),
    ...(input.activePollMs !== undefined ? { activePollMs: input.activePollMs } : {}),
    ...(input.now !== undefined ? { now: input.now } : {}),
    ...(input.sleep !== undefined ? { sleep: input.sleep } : {}),
    ...(input.onError !== undefined ? { onError: input.onError } : {}),
    ...(input.onBatch !== undefined ? { onBatch: input.onBatch } : {}),
  });
}
