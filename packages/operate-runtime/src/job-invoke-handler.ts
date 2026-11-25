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
 * What an invocation came to — four answers, because the four lead a caller to four different acts.
 *
 * `not_served` is the one this used to fold into a 202 (ADR-0469): a run enqueued for a declaration
 * no handler in this deployment serves is never claimed (`claimDueJobs`' `serves` filter), so a
 * `202 Accepted` for it is a falsely-true acceptance — the caller is told the work is queued when
 * nothing will ever do it. It is decided **before** anything is enqueued, so refusing it writes no
 * row. `queue_unavailable` is an enqueue that did not happen: a fact about the queue, not the
 * request, and retryable.
 */
export type JobInvocationOutcome =
  | {
      readonly kind: "enqueued";
      readonly runs: readonly InvokedJobRun[];
      /** Matched declarations no handler serves, which were therefore not enqueued. */
      readonly unservedJobIds: readonly string[];
    }
  | { readonly kind: "no_listener" }
  | { readonly kind: "not_served"; readonly jobIds: readonly string[] }
  | { readonly kind: "queue_unavailable" };

/**
 * Enqueues the `userInvoked` jobs that listen for an action. Injected so `operate-runtime` stays
 * pg-free; the operate-server binding calls `enqueueUserInvokedJob`.
 */
export interface JobInvoker {
  invoke(request: JobInvocationRequest): Promise<JobInvocationOutcome>;
}

/** How long a caller is told to wait before retrying an invocation the queue could not take. */
export const JOB_QUEUE_RETRY_AFTER_SECONDS = 30;

function json(status: number, body: unknown): HandlerOutput {
  return { kind: "json", status, body };
}

export interface JobInvokeGateOptions {
  /**
   * The default allow-list: if set, only principals with one of these roles may invoke an action that
   * has no per-action rule (`403` otherwise). Omit to leave un-listed actions open.
   */
  readonly allowedRoles?: ReadonlySet<string>;
  /**
   * Per-action allow-lists, keyed by action. When an action is present here, its role set **overrides**
   * `allowedRoles` for that action (so a specific action can require a different — stricter or
   * different — role than the default). Actions absent here fall back to `allowedRoles`.
   */
  readonly rolesByAction?: ReadonlyMap<string, ReadonlySet<string>>;
  /** Bridges a principal to its role names — required for any allow-list to authorize anyone. */
  readonly principalRoles?: (principal: ResolvedPrincipal | null) => PrincipalRoles;
}

/** The role set governing an action: its per-action override, else the default (or undefined ⇒ open). */
function effectiveAllowedRoles(action: string, gate: JobInvokeGateOptions): ReadonlySet<string> | undefined {
  return gate.rolesByAction?.get(action) ?? gate.allowedRoles;
}

/** Whether the caller holds one of `allowed`. Fail-closed: no `principalRoles` bridge ⇒ nobody. */
function callerHasRole(
  principal: ResolvedPrincipal | null,
  allowed: ReadonlySet<string>,
  bridge: JobInvokeGateOptions["principalRoles"],
): boolean {
  if (bridge === undefined) return false;
  const { primaryRole, secondaryRoles } = bridge(principal);
  return [primaryRole, ...(secondaryRoles ?? [])].some((r) => allowed.has(r));
}

/**
 * `POST /v1/meta/jobs/invoke` — the on-demand producer surface: an authenticated caller runs a
 * `userInvoked` job for their own tenant by naming its `action` (+ optional `data` / `idempotencyKey`
 * for at-least-once dedup). Returns `202` with the enqueued runs (each a durable `job_runs` row the
 * worker fleet drains), `404 no_job_for_action` when no job listens for the action, `409
 * job_not_served` when every listening job is one no handler serves, `503 job_queue_unavailable` when
 * the enqueue itself failed, `400` for a
 * missing action, `403` when the caller's role is not permitted (if role-gated), `401` when the
 * principal has no tenant. Own-tenant only — the caller's principal tenant is authoritative, never a
 * body field. When `gate.allowedRoles` is set, only those roles may invoke (fail-closed).
 */
export function buildJobInvokeHandler(invoker: JobInvoker, gate: JobInvokeGateOptions = {}): Handler {
  return async ({ principal, parsedBody }) => {
    const tenantId = principal?.tenantId ?? null;
    if (tenantId === null) return json(401, { error: "tenant_required" });

    const body = parsedBody ?? {};
    const action = typeof body["action"] === "string" ? body["action"].trim() : "";
    if (action.length === 0) return json(400, { error: "invalid_request", detail: "action is required" });

    const allowed = effectiveAllowedRoles(action, gate);
    if (allowed !== undefined && !callerHasRole(principal, allowed, gate.principalRoles)) {
      return json(403, { error: "forbidden", detail: "role not permitted to invoke this action" });
    }

    const rawData = body["data"];
    const data =
      typeof rawData === "object" && rawData !== null && !Array.isArray(rawData)
        ? (rawData as Record<string, unknown>)
        : {};
    const idempotencyKey =
      typeof body["idempotencyKey"] === "string" && body["idempotencyKey"].length > 0
        ? (body["idempotencyKey"] as string)
        : undefined;

    // No catch here. The queue's failure is the invoker's to classify — it catches around its own
    // store call and answers `queue_unavailable` having reported the cause, the run ids and the
    // remedy — so a throw reaching this point is a defect (in the planner, the served-set thunk, an
    // injected invoker) and belongs to the dispatch stage, which logs it under the request id. A
    // catch-all here would answer that defect as a retryable 503 claiming the queue was unavailable
    // and record nothing anywhere (ADR-0469's review).
    const outcome: JobInvocationOutcome = await invoker.invoke({
      tenantId,
      action,
      data,
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    });
    switch (outcome.kind) {
      case "no_listener":
        return json(404, { error: "no_job_for_action", detail: `no userInvoked job listens for action '${action}'` });
      case "not_served":
        return json(409, {
          error: "job_not_served",
          detail:
            `every userInvoked job listening for action '${action}' is declared and no handler in this ` +
            "deployment serves it, so nothing would ever run it; nothing was enqueued",
          jobIds: outcome.jobIds,
        });
      case "queue_unavailable":
        return {
          kind: "json",
          status: 503,
          headers: { "retry-after": JOB_QUEUE_RETRY_AFTER_SECONDS.toString() },
          body: {
            error: "job_queue_unavailable",
            detail: `the job queue could not accept action '${action}'; nothing was enqueued — retry later`,
          },
        };
      case "enqueued":
        return json(202, {
          action,
          runs: outcome.runs,
          ...(outcome.unservedJobIds.length > 0 ? { unservedJobIds: outcome.unservedJobIds } : {}),
        });
    }
  };
}
