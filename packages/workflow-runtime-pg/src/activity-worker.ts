import type { PgConnection } from "@crossengin/kernel-pg";
import type { WorkflowEngine } from "@crossengin/workflow-runtime";
import {
  WorkflowActivityWorker,
  renewWhile,
  type ActivityClaimer,
  type ActivityProcessor,
  type ClaimRenewer,
  type ClaimedActivity,
} from "@crossengin/workflow-worker";

import { claimDueActivities, releaseActivityClaim, renewActivityClaim } from "./activity-claim.js";

/** The engine surface an activity processor needs — the log-driven, targeted execute. */
export type ActivityExecutingEngine = Pick<WorkflowEngine, "executeScheduledActivity">;

/** Adapts the Postgres `claimDueActivities` / `releaseActivityClaim` SQL to the worker's `ActivityClaimer`. */
export function buildActivityClaimer(conn: PgConnection, opts: { readonly schema?: string } = {}): ActivityClaimer {
  const schemaOpt = opts.schema !== undefined ? { schema: opts.schema } : {};
  return {
    claim: (o) => claimDueActivities(conn, { ...o, ...schemaOpt }),
    release: (o) => releaseActivityClaim(conn, { ...o, ...schemaOpt }),
  };
}

/**
 * Adapts the Postgres `renewActivityClaim` to the worker's `ClaimRenewer`, closing over the lease
 * duration + clock so `renew({timerId, workerId})` extends the lease to `now + leaseMs`. The
 * `ClaimRenewer.renew` shape is `{timerId, workerId}` (shared with the timer path); here `timerId`
 * carries the activity id, mapped through to `activityId`.
 */
export function buildActivityClaimRenewer(
  conn: PgConnection,
  opts: { readonly leaseMs: number; readonly now?: () => Date; readonly schema?: string },
): ClaimRenewer {
  const now = opts.now ?? (() => new Date());
  const schemaOpt = opts.schema !== undefined ? { schema: opts.schema } : {};
  return {
    renew: ({ timerId, workerId }) =>
      renewActivityClaim(conn, { activityId: timerId, workerId, now: now().toISOString(), leaseMs: opts.leaseMs, ...schemaOpt }),
  };
}

/** Lease-renewal config for a processor: heartbeat a claim while a slow execute runs. */
export interface ActivityRenewalConfig {
  readonly renewer: ClaimRenewer;
  readonly workerId: string;
  readonly intervalMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly onLeaseLost?: () => void;
}

/**
 * An `ActivityProcessor` that runs a claimed activity by executing it from the durable event log
 * (`engine.executeScheduledActivity`). The worker connection is platform-scoped (RLS-bypassing), so
 * one engine serves every tenant and the correct `tenant_id` rides on each appended event from the
 * projected instance state. Execution is idempotent — an already-run activity is a no-op — which is
 * exactly what the worker's at-least-once retry semantics require.
 */
export function buildActivityProcessor(
  engine: ActivityExecutingEngine,
  opts: { readonly renewal?: ActivityRenewalConfig } = {},
): ActivityProcessor {
  const renewal = opts.renewal;
  return {
    process: async (activity: ClaimedActivity) => {
      const execute = engine.executeScheduledActivity(activity.instanceId, activity.activityId);
      if (renewal === undefined) {
        await execute;
        return;
      }
      // Heartbeat the lease while the execute runs, so a slow handler isn't stolen.
      await renewWhile(execute, {
        renewer: renewal.renewer,
        timerId: activity.activityId,
        workerId: renewal.workerId,
        intervalMs: renewal.intervalMs,
        sleep: renewal.sleep,
        ...(renewal.onLeaseLost !== undefined ? { onLeaseLost: renewal.onLeaseLost } : {}),
      });
    },
  };
}

export interface BuildWorkflowActivityWorkerInput {
  readonly conn: PgConnection;
  readonly engine: ActivityExecutingEngine;
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
  /** Enable lease renewal during an execute, heartbeating every N ms (default: off). Needs `leaseMs`. */
  readonly renewIntervalMs?: number;
}

/**
 * Wires the three P2 primitives into a runnable distributed activity worker: the Postgres claim
 * (`FOR UPDATE SKIP LOCKED`) behind an `ActivityClaimer`, a log-driven execute behind an
 * `ActivityProcessor`, and the poll loop. Many of these run against one queue; each claims a disjoint
 * batch and executes its activities. `now` drives the claim's due-check.
 */
export function buildWorkflowActivityWorker(input: BuildWorkflowActivityWorkerInput): WorkflowActivityWorker {
  const claimer = buildActivityClaimer(input.conn, input.schema !== undefined ? { schema: input.schema } : {});
  // Optional lease renewal: heartbeat the claim while an execute runs so a slow handler isn't stolen.
  const renewal: ActivityRenewalConfig | undefined =
    input.renewIntervalMs !== undefined
      ? {
          renewer: buildActivityClaimRenewer(input.conn, {
            leaseMs: input.leaseMs ?? 30_000,
            ...(input.now !== undefined ? { now: input.now } : {}),
            ...(input.schema !== undefined ? { schema: input.schema } : {}),
          }),
          workerId: input.workerId,
          intervalMs: input.renewIntervalMs,
          sleep: input.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
        }
      : undefined;
  const processor = buildActivityProcessor(input.engine, {
    ...(renewal !== undefined ? { renewal } : {}),
  });
  return new WorkflowActivityWorker({
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
