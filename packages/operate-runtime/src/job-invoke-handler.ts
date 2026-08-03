import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import type { Handler, HandlerOutput, PrincipalRoles } from "@crossengin/api-gateway-runtime";

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

export interface JobInvokeGateOptions {
  /**
   * If set, only principals with one of these roles may invoke a job (`403` otherwise). Fail-closed:
   * an empty set, or a set with no `principalRoles` bridge to resolve the caller's roles, denies
   * everyone. Omit entirely to leave the endpoint open to any authenticated tenant principal.
   */
  readonly allowedRoles?: ReadonlySet<string>;
  /** Bridges a principal to its role names — required for `allowedRoles` to authorize anyone. */
  readonly principalRoles?: (principal: ResolvedPrincipal | null) => PrincipalRoles;
}

/** Whether the caller may invoke, given the gate. No gate (`allowedRoles` unset) ⇒ always true. */
function isRoleAllowed(principal: ResolvedPrincipal | null, gate: JobInvokeGateOptions): boolean {
  if (gate.allowedRoles === undefined) return true;
  if (gate.principalRoles === undefined) return false; // gated but no bridge → fail-closed
  const { primaryRole, secondaryRoles } = gate.principalRoles(principal);
  return [primaryRole, ...(secondaryRoles ?? [])].some((r) => gate.allowedRoles!.has(r));
}

/**
 * `POST /v1/meta/jobs/invoke` — the on-demand producer surface: an authenticated caller runs a
 * `userInvoked` job for their own tenant by naming its `action` (+ optional `data` / `idempotencyKey`
 * for at-least-once dedup). Returns `202` with the enqueued runs (each a durable `job_runs` row the
 * worker fleet drains), `404 no_job_for_action` when no job listens for the action, `400` for a
 * missing action, `403` when the caller's role is not permitted (if role-gated), `401` when the
 * principal has no tenant. Own-tenant only — the caller's principal tenant is authoritative, never a
 * body field. When `gate.allowedRoles` is set, only those roles may invoke (fail-closed).
 */
export function buildJobInvokeHandler(invoker: JobInvoker, gate: JobInvokeGateOptions = {}): Handler {
  return async ({ principal, parsedBody }) => {
    const tenantId = principal?.tenantId ?? null;
    if (tenantId === null) return json(401, { error: "tenant_required" });
    if (!isRoleAllowed(principal, gate)) {
      return json(403, { error: "forbidden", detail: "role not permitted to invoke jobs" });
    }

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
