import type { JobDeclaration } from "@crossengin/jobs";
import type { PgConnection } from "@crossengin/kernel-pg";
import type { InvokedJobRun, JobInvocationRequest, JobInvoker } from "@crossengin/operate-runtime";
import { enqueueUserInvokedJob } from "@crossengin/workflow-runtime-pg";

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

export interface PostgresJobInvokerOptions {
  readonly schema?: string;
  readonly now?: () => Date;
}

/**
 * A `JobInvoker` that enqueues a caller's `userInvoked` jobs into `job_runs` via
 * `enqueueUserInvokedJob`, so `POST /v1/meta/jobs/invoke` runs on-demand jobs through the same durable
 * queue the worker fleet drains. Idempotent by the producer's deterministic `run_id` +
 * `ON CONFLICT DO NOTHING` (keyed on the invocation's `idempotencyKey`). The connection is
 * platform-scoped; the caller-principal tenant (bound by the handler) rides on each row.
 */
export class PostgresJobInvoker implements JobInvoker {
  constructor(
    private readonly conn: PgConnection,
    private readonly jobs: readonly JobDeclaration[],
    private readonly options: PostgresJobInvokerOptions = {},
  ) {}

  async invoke(request: JobInvocationRequest): Promise<readonly InvokedJobRun[]> {
    const now = (this.options.now ?? (() => new Date()))().toISOString();
    const schemaOpt = this.options.schema !== undefined ? { schema: this.options.schema } : {};
    const enqueued = await enqueueUserInvokedJob(this.conn, {
      invocation: {
        tenantId: request.tenantId,
        action: request.action,
        data: request.data,
        ...(request.idempotencyKey !== undefined ? { idempotencyKey: request.idempotencyKey } : {}),
      },
      jobs: this.jobs,
      now,
      ...schemaOpt,
    });
    return enqueued.map((e) => ({ jobId: e.jobId, runId: e.runId, inserted: e.inserted }));
  }
}
