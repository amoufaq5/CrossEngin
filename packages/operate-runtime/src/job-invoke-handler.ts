import type { Handler, HandlerOutput } from "@crossengin/api-gateway-runtime";

/** One job run enqueued by an invocation (deterministic id; `inserted:false` = a duplicate no-op). */
export interface InvokedJobRun {
  readonly jobId: string;
  readonly runId: string;
  readonly inserted: boolean;
}

export interface JobInvocationRequest {
  readonly tenantId: string;
  readonly action: string;
  readonly data: Record<string, unknown>;
  readonly idempotencyKey?: string;
}

/**
 * Enqueues the `userInvoked` jobs that listen for an action. Injected so `operate-runtime` stays
 * pg-free; the operate-server binding calls `enqueueUserInvokedJob`. Returns one entry per matched
 * job (empty ⇒ no job listens for the action).
 */
export interface JobInvoker {
  invoke(request: JobInvocationRequest): Promise<readonly InvokedJobRun[]>;
}

function json(status: number, body: unknown): HandlerOutput {
  return { kind: "json", status, body };
}

/**
 * `POST /v1/meta/jobs/invoke` — the on-demand producer surface: an authenticated caller runs a
 * `userInvoked` job for their own tenant by naming its `action` (+ optional `data` / `idempotencyKey`
 * for at-least-once dedup). Returns `202` with the enqueued runs (each a durable `job_runs` row the
 * worker fleet drains), `404 no_job_for_action` when no job listens for the action, `400` for a
 * missing action, `401` when the principal has no tenant. Own-tenant only — the caller's principal
 * tenant is authoritative, never a body field.
 */
export function buildJobInvokeHandler(invoker: JobInvoker): Handler {
  return async ({ principal, parsedBody }) => {
    const tenantId = principal?.tenantId ?? null;
    if (tenantId === null) return json(401, { error: "tenant_required" });

    const body = parsedBody ?? {};
    const action = typeof body["action"] === "string" ? body["action"].trim() : "";
    if (action.length === 0) return json(400, { error: "invalid_request", detail: "action is required" });

    const rawData = body["data"];
    const data =
      typeof rawData === "object" && rawData !== null && !Array.isArray(rawData)
        ? (rawData as Record<string, unknown>)
        : {};
    const idempotencyKey =
      typeof body["idempotencyKey"] === "string" && body["idempotencyKey"].length > 0
        ? (body["idempotencyKey"] as string)
        : undefined;

    const runs = await invoker.invoke({
      tenantId,
      action,
      data,
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    });
    if (runs.length === 0) {
      return json(404, { error: "no_job_for_action", detail: `no userInvoked job listens for action '${action}'` });
    }
    return json(202, { action, runs });
  };
}
