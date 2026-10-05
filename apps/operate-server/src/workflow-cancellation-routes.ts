import type { PathSegment, ResolvedPrincipal, RouteDefinition } from "@crossengin/api-gateway";
import type { Handler, HandlerOutput, PrincipalRoles } from "@crossengin/api-gateway-runtime";
import type { ExtraGatewayRoute } from "@crossengin/operate-runtime";

/**
 * `POST /v1/meta/workflows/instances/{instanceId}/cancel` — the HTTP half of instance cancellation.
 *
 * ADR-0329 built `cancelInstance` and left it reachable only by embedding code, which made it a
 * capability of the deployment and not of the tenant whose half-written sales order it is. This is
 * ADR-0315's route for the other kind of work, and it deliberately reads the same: the tenant comes
 * from the credential, the actor is the authenticated principal, and every outcome is reported
 * distinctly rather than flattened into ok/not-ok.
 *
 * Three things are specific to an *instance* and are where this differs from the job route:
 *
 * - **`disposition` is required with no default.** ADR-0329's rule, and the only rule here worth
 *   breaking a request over: a `z.default()` is applied to silence, and silence must not decide
 *   whether a half-written order is reversed. A body that omits it is a 400 — never a defaulted
 *   `compensate` (which would run reversing handlers nobody asked for) and never a defaulted
 *   `abandon` (which would leave real side effects standing and report success).
 * - **The engine takes no tenant.** `cancelInstance` resolves the tenant from the instance's own
 *   projection, so nothing below this route confines a cancellation to the caller's tenant. The
 *   route reads the instance first and refuses one belonging to somebody else *as unknown*, because
 *   a 403 would confirm the id exists.
 * - **A throw after the fence is not "nothing happened".** `cancelInstance` appends
 *   `instance_cancellation_requested` before it does any of the slower work, so a failure partway
 *   through leaves the instance fenced and unsealed. That is reported 500 and named, not 503 — the
 *   same reasoning as ADR-0316's `erasure_unrecorded`, where a 503 would read as a no-op.
 */

/** Mirrors `InstanceCancellationOutcome` structurally, so this module imports no runtime package. */
export const INSTANCE_CANCEL_OUTCOMES = [
  "cancelled",
  "already_requested",
  "refused_terminal",
  "refused_not_cancellable",
  "unknown_instance",
] as const;
export type InstanceCancelOutcome = (typeof INSTANCE_CANCEL_OUTCOMES)[number];

/** Mirrors `InstanceCancellationDisposition`. */
export const INSTANCE_CANCEL_DISPOSITIONS = ["compensate", "abandon"] as const;
export type InstanceCancelDisposition = (typeof INSTANCE_CANCEL_DISPOSITIONS)[number];

/** Mirrors `InstanceCancellationCompensationOutcome`. */
export const INSTANCE_CANCEL_COMPENSATION_OUTCOMES = [
  "executed",
  "skipped_by_request",
  "deferred_to_human",
  "unavailable",
] as const;
export type InstanceCancelCompensationOutcome =
  (typeof INSTANCE_CANCEL_COMPENSATION_OUTCOMES)[number];

/** The slice of `ProjectedInstance` this route reads, which is only what tenant scoping needs. */
export interface InstanceSnapshotLike {
  readonly instanceId: string;
  readonly tenantId: string;
  readonly status: string;
}

/** Structurally `CancelInstanceResult`. */
export interface InstanceCancelResultLike {
  readonly outcome: InstanceCancelOutcome;
  readonly cancelledTimerIds: readonly string[];
  readonly beforeHandlerActivityIds: readonly string[];
  readonly cooperativeAbortActivityIds: readonly string[];
  readonly signalDeliveredActivityIds: readonly string[];
  readonly compensationOutcome: InstanceCancelCompensationOutcome;
  readonly compensatedActivityIds: readonly string[];
  readonly unreversedActivityIds: readonly string[];
}

/** Structurally `InstanceCancellationRequestInput`. */
export interface InstanceCancelRequestLike {
  readonly instanceId: string;
  readonly disposition: InstanceCancelDisposition;
  readonly reason: string;
  readonly requestedByUserId?: string | null;
  readonly requestedBySystem?: string | null;
}

/**
 * The two calls this route needs, which `WorkflowEngine` satisfies structurally. `getInstanceState`
 * is not an optimisation: it is the only thing that confines the cancellation to a tenant.
 */
export interface WorkflowInstanceCancellerLike {
  getInstanceState(instanceId: string): Promise<InstanceSnapshotLike | null>;
  cancelInstance(request: InstanceCancelRequestLike): Promise<InstanceCancelResultLike>;
}

/** `InstanceCancellationRequestSchema` caps the reason at 500; refused here so the engine never parses a bad one. */
export const MAX_INSTANCE_CANCEL_REASON_LENGTH = 500;

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** `InstanceCancellationRequestSchema`'s own pattern. Anything else never existed. */
const INSTANCE_ID_RE = /^wfi_[a-z0-9]{8,40}$/;

export interface WorkflowCancellationRoutesContext {
  readonly canceller: WorkflowInstanceCancellerLike;
  readonly principalRoles: (principal: ResolvedPrincipal | null) => PrincipalRoles;
  /**
   * Roles permitted to cancel an instance. Fail-closed: an empty set refuses everyone, because a
   * `compensate` cancellation runs real reversing handlers over real postings, and an unconfigured
   * grant must not read as an open one.
   */
  readonly allowedRoles: ReadonlySet<string>;
  /** Observes each decided request, for a log line. Never handed the reason text. */
  readonly onDecided?: (result: InstanceCancelResultLike, tenantId: string, instanceId: string) => void;
}

function json(status: number, body: unknown): HandlerOutput {
  return { kind: "json", status, body };
}

function rolesOf(
  ctx: WorkflowCancellationRoutesContext,
  principal: ResolvedPrincipal | null,
): readonly string[] {
  const { primaryRole, secondaryRoles } = ctx.principalRoles(principal);
  return [primaryRole, ...(secondaryRoles ?? [])];
}

/**
 * The HTTP status each outcome reports.
 *
 * **`already_requested` is 200, and the job route's `already_terminal` is 409, for the same reason
 * read from opposite ends.** A POST answers 409 when the request conflicts with the resource's
 * state — which is true of a job that already *succeeded*, because there the work happened and
 * cancelling it changed nothing, so a 200 would claim an effect that never occurred. Here the
 * effect exists: this instance is cancelled, or fenced and being cancelled. `planInstanceCancellation`
 * tests this case *before* the refusals precisely so an idempotent repeat is not reported as a
 * failure, and the route must not undo that by grading it as one. The caller's postcondition holds;
 * only its authorship does not, and authorship is not an error. What the body must not do is claim
 * the *second* call's plan — see `effectsFor`.
 *
 * Both refusals are 409 rather than 422: the request is well-formed and the conflict is entirely in
 * the instance's status, which is what 409 is for. They are distinct outcomes in the body because
 * they call for different actions — `refused_terminal` means the instance is closed and there is
 * nothing to do, while `refused_not_cancellable` on `failed` means *compensate it instead* and on
 * `compensating` means *wait*.
 */
export function statusForInstanceCancelOutcome(outcome: InstanceCancelOutcome): number {
  switch (outcome) {
    case "cancelled":
      return 200;
    case "already_requested":
      return 200;
    case "refused_terminal":
      return 409;
    case "refused_not_cancellable":
      return 409;
    case "unknown_instance":
      return 404;
  }
}

/** What a refusal tells the caller to do about it. Never the engine's own message. */
export function detailForInstanceCancelOutcome(outcome: InstanceCancelOutcome): string | null {
  switch (outcome) {
    case "cancelled":
      return null;
    case "already_requested":
      return "this instance was already asked to cancel; the disposition that applies is the earlier request's, on the instance's log";
    case "refused_terminal":
      return "the instance is closed and cannot be cancelled";
    case "refused_not_cancellable":
      return "the instance's status does not admit a cancellation: a failed instance is compensated rather than cancelled, and a compensating one must finish unwinding first";
    case "unknown_instance":
      return "no such instance for this tenant";
  }
}

export interface InstanceCancelBody {
  readonly disposition: InstanceCancelDisposition;
  readonly reason: string;
}

export type ReadInstanceCancelBody =
  | { readonly ok: true; readonly body: InstanceCancelBody }
  | { readonly ok: false; readonly detail: string };

/**
 * Reads the two required fields. `disposition` has **no default and no inference**: not from the
 * instance's state, not from the definition's compensation strategy, not from an absent field.
 */
export function readInstanceCancelBody(
  body: Record<string, unknown> | null,
): ReadInstanceCancelBody {
  if (body === null) {
    return { ok: false, detail: "a body with disposition and reason is required" };
  }
  const rawDisposition = body["disposition"];
  if (rawDisposition === undefined || rawDisposition === null) {
    return {
      ok: false,
      detail: `disposition is required and has no default: one of ${INSTANCE_CANCEL_DISPOSITIONS.join(", ")}`,
    };
  }
  if (
    typeof rawDisposition !== "string" ||
    !(INSTANCE_CANCEL_DISPOSITIONS as readonly string[]).includes(rawDisposition)
  ) {
    return {
      ok: false,
      detail: `disposition must be one of ${INSTANCE_CANCEL_DISPOSITIONS.join(", ")}`,
    };
  }
  const rawReason = body["reason"];
  if (typeof rawReason !== "string") {
    return { ok: false, detail: "reason is required and must be a string" };
  }
  const reason = rawReason.trim();
  if (reason.length === 0) {
    // Not merely a validation nicety: `WorkflowInstanceSchema` requires `cancelledReason` of a
    // cancelled instance, so a cancellation with no reason could only produce a record its own
    // schema rejects.
    return { ok: false, detail: "reason must not be empty" };
  }
  if (reason.length > MAX_INSTANCE_CANCEL_REASON_LENGTH) {
    return {
      ok: false,
      detail: `reason must be at most ${MAX_INSTANCE_CANCEL_REASON_LENGTH.toString()} characters`,
    };
  }
  return { ok: true, body: { disposition: rawDisposition as InstanceCancelDisposition, reason } };
}

/** How the authenticated principal is recorded as the requester. */
export interface InstanceCancelActor {
  readonly requestedByUserId: string | null;
  readonly requestedBySystem: string | null;
}

/**
 * Who this cancellation is attributed to.
 *
 * A non-`user` principal is recorded as a *system* actor even though its `principalId` is a uuid,
 * and that is load-bearing rather than tidy: the projection sets `cancelledByUserId` from
 * `actorPrincipalId`, and `meta.workflow_instances.cancelled_by_user_id` is a foreign key to
 * `meta.users` — so handing a service account's id to `requestedByUserId` makes the very next
 * `upsertProjection` violate that key, and recording it as a user would be a lie either way.
 */
export function actorForInstanceCancel(principal: ResolvedPrincipal): InstanceCancelActor {
  if (principal.principalKind === "user") {
    return { requestedByUserId: principal.principalId, requestedBySystem: null };
  }
  return {
    requestedByUserId: null,
    requestedBySystem: `${principal.principalKind}:${principal.principalId}`,
  };
}

export interface InstanceCancelEffects {
  readonly compensationOutcome: InstanceCancelCompensationOutcome | null;
  readonly compensatedActivityIds: readonly string[] | null;
  readonly unreversedActivityIds: readonly string[] | null;
  readonly cancelledTimerIds: readonly string[] | null;
  readonly beforeHandlerActivityIds: readonly string[] | null;
  readonly cooperativeAbortActivityIds: readonly string[] | null;
  readonly signalDeliveredActivityIds: readonly string[] | null;
}

const UNKNOWN_EFFECTS: InstanceCancelEffects = {
  compensationOutcome: null,
  compensatedActivityIds: null,
  unreversedActivityIds: null,
  cancelledTimerIds: null,
  beforeHandlerActivityIds: null,
  cooperativeAbortActivityIds: null,
  signalDeliveredActivityIds: null,
};

/**
 * What this request actually did, reported only when it did something.
 *
 * `planInstanceCancellation` returns `EMPTY_PLAN` for every outcome but `cancelled`, whose
 * `compensationOutcome` is the filler `skipped_by_request`. Passing that through would tell a caller
 * whose repeat landed `already_requested` that the rollback *was skipped by request* — an affirmative
 * falsehood about an instance the first request may well have compensated in full. So the fields are
 * explicitly `null`, which is ADR-0317's rule met properly: not silence, and not a number that is
 * wrong.
 */
export function effectsFor(result: InstanceCancelResultLike): InstanceCancelEffects {
  if (result.outcome !== "cancelled") return UNKNOWN_EFFECTS;
  return {
    compensationOutcome: result.compensationOutcome,
    compensatedActivityIds: result.compensatedActivityIds,
    unreversedActivityIds: result.unreversedActivityIds,
    cancelledTimerIds: result.cancelledTimerIds,
    beforeHandlerActivityIds: result.beforeHandlerActivityIds,
    cooperativeAbortActivityIds: result.cooperativeAbortActivityIds,
    signalDeliveredActivityIds: result.signalDeliveredActivityIds,
  };
}

function buildCancelHandler(ctx: WorkflowCancellationRoutesContext): Handler {
  return async (input) => {
    const principal = input.principal;
    if (principal === null) return json(401, { error: "authentication_required" });
    const roles = rolesOf(ctx, principal);
    if (ctx.allowedRoles.size === 0 || !roles.some((r) => ctx.allowedRoles.has(r))) {
      return json(403, {
        error: "forbidden",
        detail: "cancelling a workflow instance is not granted to this role",
      });
    }
    const tenantId = principal.tenantId ?? "";
    if (!UUID_RE.test(tenantId)) {
      return json(403, { error: "forbidden", detail: "no tenant resolves for this principal" });
    }
    const instanceId = input.params["instanceId"] ?? "";
    if (!INSTANCE_ID_RE.test(instanceId)) {
      return json(400, { error: "invalid_request", detail: "instanceId must match ^wfi_[a-z0-9]{8,40}$" });
    }
    const read = readInstanceCancelBody(input.parsedBody);
    if (!read.ok) return json(400, { error: "invalid_request", detail: read.detail });

    let snapshot: InstanceSnapshotLike | null;
    try {
      snapshot = await ctx.canceller.getInstanceState(instanceId);
    } catch {
      // Nothing was attempted, so "try again" is the honest answer. Distinguished from the throw
      // below, which cannot say that.
      return json(503, {
        error: "cancellation_unavailable",
        detail: "the instance could not be read",
      });
    }
    // The engine takes no tenant, so this is the whole of the isolation. Reported as unknown rather
    // than forbidden: a 403 would confirm the id names a real instance in some other tenant. The
    // check cannot go stale — an instance's tenant is written once, at `instance_started`.
    if (snapshot === null || snapshot.tenantId !== tenantId) {
      return json(404, {
        instanceId,
        outcome: "unknown_instance",
        statusBefore: null,
        detail: detailForInstanceCancelOutcome("unknown_instance"),
        ...UNKNOWN_EFFECTS,
      });
    }

    const actor = actorForInstanceCancel(principal);
    let result: InstanceCancelResultLike;
    try {
      result = await ctx.canceller.cancelInstance({
        instanceId,
        disposition: read.body.disposition,
        reason: read.body.reason,
        requestedByUserId: actor.requestedByUserId,
        requestedBySystem: actor.requestedBySystem,
      });
    } catch {
      // `cancelInstance` appends `instance_cancellation_requested` *first*, so a failure partway
      // through leaves the instance fenced — no timer will fire and no activity will start — and
      // unsealed. A 503 would read as "nothing happened" and invite a retry that assumes an
      // untouched instance; 500 names the uncertainty and points at the log, which is authoritative.
      return json(500, {
        error: "cancellation_incomplete",
        instanceId,
        detail:
          "the cancellation may be partially applied: the instance may be fenced against further work without having been finalized. Read its event log before retrying.",
      });
    }
    ctx.onDecided?.(result, tenantId, instanceId);
    return json(statusForInstanceCancelOutcome(result.outcome), {
      instanceId,
      outcome: result.outcome,
      // The status the instance held when this request reached it. Named `statusBefore` rather than
      // `status` because on a successful cancel the instance no longer holds it, and it is what
      // makes a 409 actionable.
      statusBefore: snapshot.status,
      detail: detailForInstanceCancelOutcome(result.outcome),
      ...effectsFor(result),
    });
  };
}

function route(
  operationId: string,
  method: RouteDefinition["method"],
  segments: ReadonlyArray<string | { param: string }>,
): RouteDefinition {
  const pathSegments: PathSegment[] = segments.map((s) =>
    typeof s === "string"
      ? { kind: "literal", value: s }
      : { kind: "parameter", name: s.param, pattern: null },
  );
  return {
    id: `rt_${operationId.replace(/[^a-z0-9]+/gi, "_")}`,
    operationId,
    method,
    pathSegments,
    apiVersion: "v1",
    isDeprecated: false,
    deprecatedSince: null,
    sunsetAt: null,
    successorOperationId: null,
    requiredScopes: [],
    rateLimitPolicyId: null,
    // Not required: a repeat lands `already_requested` off the instance's own log, so a retried POST
    // restates nothing and needs no key to be safe. ADR-0320's deletion route needs one because a
    // retry there mints a *new* tombstone id; nothing here is minted twice.
    idempotencyRequired: false,
    requestSchemaSha256: null,
    responseSchemaSha256: null,
  };
}

export function buildWorkflowCancellationRoutes(
  ctx: WorkflowCancellationRoutesContext,
): readonly ExtraGatewayRoute[] {
  return [
    {
      route: route("workflows.instances.cancel", "POST", [
        "v1",
        "meta",
        "workflows",
        "instances",
        { param: "instanceId" },
        "cancel",
      ]),
      handler: buildCancelHandler(ctx),
    },
  ];
}
