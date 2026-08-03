import type { JobDeclaration } from "@crossengin/jobs";
import type { PgConnection } from "@crossengin/kernel-pg";
import type { InvokedJobRun, JobInvocationRequest, JobInvoker } from "@crossengin/operate-runtime";
import { enqueueUserInvokedJob } from "@crossengin/workflow-runtime-pg";

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
