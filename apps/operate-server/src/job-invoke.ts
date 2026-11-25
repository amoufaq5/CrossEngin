import { planUserInvokedJobRuns, type JobDeclaration } from "@crossengin/jobs";
import type { PgConnection } from "@crossengin/kernel-pg";
import type { JobInvocationOutcome, JobInvocationRequest, JobInvoker } from "@crossengin/operate-runtime";
import { deterministicRunId, enqueueUserInvokedJob } from "@crossengin/workflow-runtime-pg";

/**
 * Parses repeatable `action:role` specs into a per-action role map (`{action → {role, …}}`). An
 * action may repeat to accumulate roles. A spec without a non-empty action and role throws.
 */
export function buildActionRoleMap(specs: readonly string[]): ReadonlyMap<string, ReadonlySet<string>> {
  const map = new Map<string, Set<string>>();
  for (const spec of specs) {
    const idx = spec.indexOf(":");
    if (idx <= 0 || idx === spec.length - 1) {
      throw new Error(`invalid job-invoke action role spec: ${JSON.stringify(spec)} (expected action:role)`);
    }
    const action = spec.slice(0, idx);
    const role = spec.slice(idx + 1);
    const set = map.get(action) ?? new Set<string>();
    set.add(role);
    map.set(action, set);
  }
  return map;
}

/**
 * Merges per-action role maps, with `override` winning per action — a deployment's operator overrides
 * (CLI) replace a manifest-declared action's roles entirely, while un-overridden manifest actions
 * carry through. Returns a fresh map.
 */
export function mergeActionRoleMaps(
  base: ReadonlyMap<string, ReadonlySet<string>>,
  override: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlyMap<string, ReadonlySet<string>> {
  const merged = new Map<string, ReadonlySet<string>>(base);
  for (const [action, roles] of override) merged.set(action, roles);
  return merged;
}

export interface PostgresJobInvokerOptions {
  readonly schema?: string;
  readonly now?: () => Date;
  /**
   * The job ids this process's handler registry serves — `buildJobHandlerRegistry().servedJobIds`.
   * Required (ADR-0469): an invocation whose every matching job is unserved is refused **409
   * `job_not_served` before anything is enqueued**, because a run nothing can execute sits `pending`
   * for ever and the 202 that queued it read as acceptance. `[]` is the claim that this process
   * serves nothing, which refuses every matching action — the honest answer on a deployment whose
   * provider list is empty.
   *
   * A thunk, read on each invocation, because the serving binary builds this invoker before the
   * handler registry it is read from; requests arrive only once the listener opens, after both.
   */
  readonly servedJobIds: () => readonly string[];
  /**
   * The enqueue statement threw. Required: the route answers `503 job_queue_unavailable` with a fixed
   * body, so this is the only place the cause, the run ids that were being written and the remedy
   * reach an operator. Never thrown out of.
   */
  readonly onError: (failure: JobInvocationFailure) => void;
}

export interface JobInvocationFailure {
  readonly action: string;
  readonly tenantId: string;
  /** The deterministic run ids the failed statement was writing, so a retry can be matched to them. */
  readonly runIds: readonly string[];
  readonly error: unknown;
  readonly remedy: string;
}

/** The remedy a failed enqueue names. The statement sets its own tenant context (ADR-0389). */
export const JOB_INVOKE_ENQUEUE_REMEDY =
  "check that meta.job_runs exists and that the serving role holds INSERT on it; the statement " +
  "runs under the caller's tenant context, so a tenant-isolation policy refusing it means the role " +
  "or the policy is not the one this release ships. A retry with the same Idempotency-Key writes " +
  "the same run ids, so it cannot double-enqueue.";

/**
 * A `JobInvoker` that enqueues a caller's `userInvoked` jobs into `job_runs` via
 * `enqueueUserInvokedJob`, so `POST /v1/meta/jobs/invoke` runs on-demand jobs through the same durable
 * queue the worker fleet drains. Idempotent by the producer's deterministic `run_id` +
 * `ON CONFLICT DO NOTHING` (keyed on the invocation's `idempotencyKey`). The caller-principal tenant
 * (bound by the handler) rides on each row.
 *
 * Only **served** jobs are enqueued (ADR-0469). The three outcomes besides success are decided here
 * rather than by the route, because only this class knows the plan: no matching job is
 * `no_listener` (404), matching jobs none of which is served is `not_served` (409, before any
 * statement), and a throwing enqueue is `queue_unavailable` (503) reported through `onError` with the
 * run ids it was writing.
 */
export class PostgresJobInvoker implements JobInvoker {
  constructor(
    private readonly conn: PgConnection,
    private readonly jobs: readonly JobDeclaration[],
    private readonly options: PostgresJobInvokerOptions,
  ) {}

  async invoke(request: JobInvocationRequest): Promise<JobInvocationOutcome> {
    const invocation = {
      tenantId: request.tenantId,
      action: request.action,
      data: request.data,
      ...(request.idempotencyKey !== undefined ? { idempotencyKey: request.idempotencyKey } : {}),
    };
    const served = new Set(this.options.servedJobIds());
    const matching = planUserInvokedJobRuns(invocation, this.jobs);
    if (matching.length === 0) return { kind: "no_listener" };
    const servedPlan = matching.filter((p) => served.has(p.jobId));
    const unservedJobIds = matching.filter((p) => !served.has(p.jobId)).map((p) => p.jobId);
    if (servedPlan.length === 0) return { kind: "not_served", jobIds: unservedJobIds };

    const servedJobs = this.jobs.filter((j) => served.has(j.id));
    const now = (this.options.now ?? (() => new Date()))().toISOString();
    const schemaOpt = this.options.schema !== undefined ? { schema: this.options.schema } : {};
    try {
      const enqueued = await enqueueUserInvokedJob(this.conn, {
        invocation,
        jobs: servedJobs,
        now,
        ...schemaOpt,
      });
      return {
        kind: "enqueued",
        runs: enqueued.map((e) => ({ jobId: e.jobId, runId: e.runId, inserted: e.inserted })),
        unservedJobIds,
      };
    } catch (error) {
      this.options.onError({
        action: request.action,
        tenantId: request.tenantId,
        runIds: servedPlan.map((p) => deterministicRunId(p.runKey)),
        error,
        remedy: JOB_INVOKE_ENQUEUE_REMEDY,
      });
      return { kind: "queue_unavailable" };
    }
  }
}
