import type { PathSegment, ResolvedPrincipal, RouteDefinition } from "@crossengin/api-gateway";
import type { Handler, HandlerOutput, PrincipalRoles } from "@crossengin/api-gateway-runtime";
import type { ExtraGatewayRoute } from "@crossengin/operate-runtime";

/**
 * `POST /v1/meta/jobs/runs/{runId}/cancel` — the HTTP half of job cancellation.
 *
 * ADR-0269 left cancellation client-side only: a caller could abandon a request, and nothing about
 * that abandonment reached the queue. The durable half now exists (`requestJobCancellation` stamps
 * `meta.job_runs.cancel_requested_at`, the claim query refuses a stamped run, and the holding worker
 * trips its handler's `AbortSignal`), but nothing over HTTP could ask for it. This asks.
 *
 * Three properties the route layer is responsible for, since the store below it is deliberately
 * ignorant of who called:
 *
 * - **The tenant comes from the credential, never the path.** A run id is opaque and guessable in
 *   the way a sequence is not, but it is not a capability: the cancel is scoped to the caller's own
 *   tenant, so a valid run id belonging to somebody else reads as `not_found`.
 * - **`requestedBy` is the authenticated principal.** The column exists so a cancellation can be
 *   accounted for, and a route that let the body name the requester would make it decorative. A
 *   caller with no resolvable principal id is refused rather than recorded as nobody.
 * - **The outcome is reported, not flattened.** `cancelled`, `cancellation_requested`,
 *   `already_requested` and `already_terminal` are four different facts about the run and a client
 *   that polls needs to tell them apart — in particular `already_terminal`, which means the work
 *   happened and cancelling changed nothing.
 */

/** Mirrors `JobCancellationOutcome` structurally, so this module does not import the pg package. */
export const JOB_CANCEL_OUTCOMES = [
  "cancelled",
  "cancellation_requested",
  "already_requested",
  "already_terminal",
  "not_found",
] as const;
export type JobCancelOutcome = (typeof JOB_CANCEL_OUTCOMES)[number];

export interface JobCancelResultLike {
  readonly runId: string;
  readonly outcome: JobCancelOutcome;
  readonly status: string | null;
  readonly requestedAt: string | null;
}

export interface JobCancelRequestLike {
  readonly runId: string;
  readonly tenantId: string;
  readonly requestedBy: string;
  readonly reason?: string;
}

/** Structural mirror of the one call this route needs. No listing, no un-cancel. */
export interface JobCancellerLike {
  requestCancellation(request: JobCancelRequestLike): Promise<JobCancelResultLike>;
}

/** The longest reason accepted. Long enough to say why, short enough not to be a payload. */
export const MAX_CANCEL_REASON_LENGTH = 500;

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Run ids are produced by the enqueue path as UUIDs; anything else never existed. */
const RUN_ID_RE = UUID_RE;

export interface JobCancelRoutesContext {
  readonly canceller: JobCancellerLike;
  readonly principalRoles: (principal: ResolvedPrincipal | null) => PrincipalRoles;
  /**
   * Roles permitted to cancel a run. Fail-closed: an empty set refuses everyone, because cancelling
   * somebody else's scheduled close-the-period job is a privileged act and an unconfigured grant
   * must not read as an open one.
   */
  readonly allowedRoles: ReadonlySet<string>;
  /** Observes each decided request, for a log line. Never handed the reason text. */
  readonly onDecided?: (result: JobCancelResultLike, tenantId: string) => void;
}

function json(status: number, body: unknown): HandlerOutput {
  return { kind: "json", status, body };
}

function rolesOf(ctx: JobCancelRoutesContext, principal: ResolvedPrincipal | null): readonly string[] {
  const { primaryRole, secondaryRoles } = ctx.principalRoles(principal);
  return [primaryRole, ...(secondaryRoles ?? [])];
}

/** The HTTP status each outcome reports. `not_found` is 404; the rest all happened. */
export function statusForCancelOutcome(outcome: JobCancelOutcome): number {
  switch (outcome) {
    case "cancelled":
      return 200;
    case "cancellation_requested":
      // Accepted, not done: a worker holds the lease and will write the terminal status.
      return 202;
    case "already_requested":
      return 200;
    case "already_terminal":
      // The run finished. Not an error — the client's information was merely stale — but it must not
      // read as "your cancellation took effect", so it is distinguished by a 409.
      return 409;
    case "not_found":
      return 404;
  }
}

export function readCancelReason(
  body: Record<string, unknown> | null,
): { readonly ok: true; readonly reason?: string } | { readonly ok: false; readonly detail: string } {
  const raw = body?.["reason"];
  if (raw === undefined || raw === null) return { ok: true };
  if (typeof raw !== "string") return { ok: false, detail: "reason must be a string" };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true };
  if (trimmed.length > MAX_CANCEL_REASON_LENGTH) {
    return {
      ok: false,
      detail: `reason must be at most ${MAX_CANCEL_REASON_LENGTH.toString()} characters`,
    };
  }
  return { ok: true, reason: trimmed };
}

function buildCancelHandler(ctx: JobCancelRoutesContext): Handler {
  return async (input) => {
    const principal = input.principal;
    if (principal === null) return json(401, { error: "authentication_required" });
    const roles = rolesOf(ctx, principal);
    if (ctx.allowedRoles.size === 0 || !roles.some((r) => ctx.allowedRoles.has(r))) {
      return json(403, { error: "forbidden", detail: "cancelling a job run is not granted to this role" });
    }
    const tenantId = principal.tenantId ?? "";
    if (!UUID_RE.test(tenantId)) {
      // A principal the gateway authenticated but whose tenant does not resolve would otherwise be
      // handed a cancellation with no scope at all.
      return json(403, { error: "forbidden", detail: "no tenant resolves for this principal" });
    }
    const requestedBy = principal.principalId;
    if (requestedBy.length === 0) {
      return json(403, { error: "forbidden", detail: "no principal id to record the cancellation against" });
    }
    const runId = input.params["runId"] ?? "";
    if (!RUN_ID_RE.test(runId)) {
      return json(400, { error: "invalid_request", detail: "runId must be a uuid" });
    }
    const reason = readCancelReason(input.parsedBody);
    if (!reason.ok) return json(400, { error: "invalid_request", detail: reason.detail });

    let result: JobCancelResultLike;
    try {
      result = await ctx.canceller.requestCancellation({
        runId,
        tenantId,
        requestedBy,
        ...(reason.reason !== undefined ? { reason: reason.reason } : {}),
      });
    } catch {
      // Deliberately no detail: the store's message can name the schema and the run's internals, and
      // this endpoint is reachable by every tenant.
      return json(503, { error: "cancellation_unavailable", detail: "the cancellation could not be recorded" });
    }
    ctx.onDecided?.(result, tenantId);
    return json(statusForCancelOutcome(result.outcome), {
      runId: result.runId,
      outcome: result.outcome,
      status: result.status,
      requestedAt: result.requestedAt,
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
    // Not required: the cancellation record itself is idempotent (`COALESCE` on
    // `cancel_requested_at`), so a retried POST restates nothing and needs no key to be safe.
    idempotencyRequired: false,
    requestSchemaSha256: null,
    responseSchemaSha256: null,
  };
}

export function buildJobCancelRoutes(ctx: JobCancelRoutesContext): readonly ExtraGatewayRoute[] {
  return [
    {
      route: route("jobs.runs.cancel", "POST", [
        "v1",
        "meta",
        "jobs",
        "runs",
        { param: "runId" },
        "cancel",
      ]),
      handler: buildCancelHandler(ctx),
    },
  ];
}
