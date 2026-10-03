import type { PathSegment, ResolvedPrincipal, RouteDefinition } from "@crossengin/api-gateway";
import type { Handler, HandlerOutput, PrincipalRoles } from "@crossengin/api-gateway-runtime";
import type { ExtraGatewayRoute } from "@crossengin/operate-runtime";
import { z } from "zod";

/**
 * `/v1/platform/deletion-requests` — the handle a caller holds while a deletion runs.
 *
 * ADR-0320 put the atomic pipeline behind `POST /v1/platform/tenants/{id}/delete` and named what that
 * cost: the deletion holds `ACCESS EXCLUSIVE` on a tenant's tables plus a full `count(*)` *inside an
 * HTTP request*, so a large tenant can outlast a proxy timeout — and the client then never learns the
 * receipt it is obliged to keep. A longer timeout does not fix that. Holding a **handle** instead of an
 * open connection does.
 *
 * So these four routes own the request, and a scheduler owns the work:
 *
 *   `POST /v1/platform/deletion-requests`             submit   → `submitted`
 *   `POST /v1/platform/deletion-requests/{id}/verify` verify   → `verified`  (the runner's queue)
 *   `POST /v1/platform/deletion-requests/{id}/reject` reject   → `rejected`
 *   `GET  /v1/platform/deletion-requests/{id}`        poll     → the handle, and the tombstone id
 *                                                                once there is one
 *
 * Three properties the route owns because nothing below it can.
 *
 * **The request id is generated here, and the POST requires an idempotency key.** The store is
 * idempotent on `request_id`, so a caller-chosen id would be the natural handle — but a caller who
 * picked an id another tenant's request already held would be *handed that request back*, which turns
 * an id collision into a cross-tenant disclosure. Generated here it cannot collide, and the gateway's
 * idempotency layer is what makes the retry return the same handle. The same reasoning ADR-0320 used
 * to refuse a caller-supplied tombstone id.
 *
 * **Submitting and verifying are different grants, and the verifier may not be the submitter.**
 * Verification is the platform attesting that the subject's identity was checked; the person who typed
 * the request in cannot also be the one who attests the check passed. Note this is *not* the pipeline's
 * four-eyes — that one is between the executor and the approver of the deletion itself, and the runner
 * supplies both.
 *
 * **The deadline is computed here, not accepted from the body.** GDPR Article 12(3) gives one month,
 * extendable to three; the contract caps it and would refuse a longer one, so a body field would only
 * ever let a caller ask for a shorter deadline than the platform committed to — or trip a contract
 * refusal on a typo. `--deletion-request-deadline-days` sets it per deployment instead.
 */

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Mirrors the column's CHECK and the store's guard, so a generated id cannot fail downstream. */
const REQUEST_ID_RE = /^dreq_[A-Za-z0-9_-]{8,40}$/;

export const DEFAULT_DEADLINE_DAYS = 30;

/** Structural mirror of a `GdprDeletionRequest`, so the route layer imports no contracts package. */
export interface DeletionRequestLike {
  readonly id: string;
  readonly tenantId: string;
  readonly subjectIdentifier: string;
  readonly legalBasis: string;
  readonly status: string;
  readonly submittedAt: string;
  readonly submittedBy: string;
  readonly deadlineAt: string;
  readonly verificationMethod: string | null;
  readonly verifiedAt: string | null;
  readonly verifiedBy: string | null;
  readonly inProgressAt: string | null;
  readonly completedAt: string | null;
  readonly completionSha256: string | null;
  readonly rejectedAt: string | null;
  readonly tombstoneId: string | null;
}

/** The slice of `PostgresDeletionRequestStore` these routes drive. */
export interface DeletionRequestStoreLike {
  submit(input: {
    readonly requestId: string;
    readonly tenantId: string;
    readonly subjectIdentifier: string;
    readonly legalBasis: string;
    readonly submittedBy: string;
    readonly submittedAt: string;
    readonly deadlineAt: string;
    readonly retentionObligations?: readonly string[];
    readonly notes?: string;
  }): Promise<DeletionRequestLike>;
  read(requestId: string): Promise<DeletionRequestLike | null>;
  transition(
    requestId: string,
    to: string,
    fields: {
      readonly at: string;
      readonly verifiedBy?: string;
      readonly verificationMethod?: string;
      readonly rejectedReason?: string;
    },
  ): Promise<DeletionRequestLike | null>;
}

export const DELETION_REQUEST_SUBMITTED_OPERATION = "platform.deletion_request_submitted";
export const DELETION_REQUEST_VERIFIED_OPERATION = "platform.deletion_request_verified";
export const DELETION_REQUEST_REJECTED_OPERATION = "platform.deletion_request_rejected";
export const DELETION_REQUEST_READ_OPERATION = "platform.deletion_request_read";

export interface DeletionRequestEvent {
  readonly tenantId: string;
  readonly requestId: string;
  readonly principalId: string;
  readonly operation: string;
  readonly status: string;
  readonly tombstoneId: string | null;
  readonly detail: string | null;
  readonly at: string;
}

export type DeletionRequestRecorder = (event: DeletionRequestEvent) => Promise<void>;

export interface DeletionRequestRoutesContext {
  readonly store: DeletionRequestStoreLike;
  readonly principalRoles: (principal: ResolvedPrincipal | null) => PrincipalRoles;
  /** Roles permitted to submit a request. Fail-closed: empty ⇒ nobody. */
  readonly submitRoles: ReadonlySet<string>;
  /** Roles permitted to verify or reject one. Fail-closed, and separate from submitting. */
  readonly verifyRoles: ReadonlySet<string>;
  /** Roles permitted to poll a handle. Defaults to the union of the two above. */
  readonly readRoles?: ReadonlySet<string>;
  readonly deadlineDays?: number;
  readonly recordAction: DeletionRequestRecorder;
  readonly newRequestId?: () => string;
  readonly clock?: () => Date;
  readonly onRecordError?: (err: unknown, operation: string) => void;
}

export const SubmitDeletionRequestBodySchema = z
  .object({
    tenantId: z.string().regex(UUID_RE),
    subjectIdentifier: z.string().min(1).max(500),
    legalBasis: z.string().min(1).max(100).default("article_17_right_to_erasure"),
    /**
     * Who asked. Free text because it is often the data subject's own address rather than a platform
     * user, and the verifier is checked against it.
     */
    submittedBy: z.string().min(1).max(200),
    retentionObligations: z.array(z.string().min(1)).default(["none"]),
    notes: z.string().min(1).max(2000).optional(),
  })
  .strict();

export const VerifyDeletionRequestBodySchema = z
  .object({ verificationMethod: z.string().min(1).max(100) })
  .strict();

export const RejectDeletionRequestBodySchema = z
  .object({ reason: z.string().min(1).max(500) })
  .strict();

function json(status: number, body: unknown): HandlerOutput {
  return { kind: "json", status, body };
}

function rolesOf(
  ctx: DeletionRequestRoutesContext,
  principal: ResolvedPrincipal | null,
): readonly string[] {
  const { primaryRole, secondaryRoles } = ctx.principalRoles(principal);
  return [primaryRole, ...(secondaryRoles ?? [])];
}

function allowed(
  ctx: DeletionRequestRoutesContext,
  principal: ResolvedPrincipal | null,
  grant: ReadonlySet<string>,
): boolean {
  if (grant.size === 0) return false;
  return rolesOf(ctx, principal).some((r) => grant.has(r));
}

function readGrant(ctx: DeletionRequestRoutesContext): ReadonlySet<string> {
  return ctx.readRoles ?? new Set([...ctx.submitRoles, ...ctx.verifyRoles]);
}

/** A `dreq_…` id the column's CHECK accepts, from a UUID's hex. */
export function newRequestId(uuid: string): string {
  const id = `dreq_${uuid.replace(/-/g, "").slice(0, 32)}`;
  if (!REQUEST_ID_RE.test(id)) {
    throw new Error(`generated deletion request id is invalid: ${JSON.stringify(id)}`);
  }
  return id;
}

/**
 * The handle. Everything a caller needs to know whether the deletion has happened and, once it has,
 * to find the receipt — which is the whole reason the flow became asynchronous (ADR-0320, ADR-0321).
 */
export function requestHandle(request: DeletionRequestLike): Record<string, unknown> {
  return {
    requestId: request.id,
    tenantId: request.tenantId,
    status: request.status,
    legalBasis: request.legalBasis,
    submittedAt: request.submittedAt,
    submittedBy: request.submittedBy,
    deadlineAt: request.deadlineAt,
    verificationMethod: request.verificationMethod,
    verifiedAt: request.verifiedAt,
    verifiedBy: request.verifiedBy,
    inProgressAt: request.inProgressAt,
    completedAt: request.completedAt,
    rejectedAt: request.rejectedAt,
    // The join ADR-0321 added: `completionSha256` commits to the proof and cannot find it.
    tombstoneId: request.tombstoneId,
    completionSha256: request.completionSha256,
    terminal: request.status === "completed" || request.status === "rejected",
  };
}

async function record(
  ctx: DeletionRequestRoutesContext,
  event: DeletionRequestEvent,
): Promise<void> {
  try {
    await ctx.recordAction(event);
  } catch (err) {
    // Unlike the erasure's recorder, nothing has been destroyed at this point — a submitted or
    // verified request is a piece of bookkeeping, and refusing it because the audit line failed would
    // block the flow without protecting anything.
    ctx.onRecordError?.(err, event.operation);
  }
}

function buildSubmitHandler(ctx: DeletionRequestRoutesContext): Handler {
  return async (input) => {
    const principal = input.principal;
    if (principal === null) return json(401, { error: "authentication_required" });
    if (!allowed(ctx, principal, ctx.submitRoles)) {
      return json(403, {
        error: "forbidden",
        detail: "submitting a deletion request is not granted to this role",
      });
    }
    const parsed = SubmitDeletionRequestBodySchema.safeParse(input.parsedBody ?? {});
    if (!parsed.success) {
      return json(400, {
        error: "invalid_request",
        detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      });
    }
    const now = (ctx.clock ?? ((): Date => new Date()))();
    const at = now.toISOString();
    const days = ctx.deadlineDays ?? DEFAULT_DEADLINE_DAYS;
    const deadlineAt = new Date(now.getTime() + days * 86_400_000).toISOString();
    const requestId = (ctx.newRequestId ?? (() => newRequestId(crypto.randomUUID())))();

    let request: DeletionRequestLike;
    try {
      request = await ctx.store.submit({
        requestId,
        tenantId: parsed.data.tenantId,
        subjectIdentifier: parsed.data.subjectIdentifier,
        legalBasis: parsed.data.legalBasis,
        submittedBy: parsed.data.submittedBy,
        submittedAt: at,
        deadlineAt,
        retentionObligations: parsed.data.retentionObligations,
        ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
      });
    } catch (err) {
      // The contract refuses an unknown legal basis or retention obligation, and Article 12(3) caps
      // the deadline. A 400 rather than a 500: the body is what is wrong.
      return json(400, { error: "invalid_request", detail: messageOf(err) });
    }

    await record(ctx, {
      tenantId: request.tenantId,
      requestId: request.id,
      principalId: principal.principalId,
      operation: DELETION_REQUEST_SUBMITTED_OPERATION,
      status: request.status,
      tombstoneId: null,
      detail: request.subjectIdentifier,
      at,
    });
    return json(201, requestHandle(request));
  };
}

function buildVerifyHandler(ctx: DeletionRequestRoutesContext): Handler {
  return async (input) => {
    const principal = input.principal;
    if (principal === null) return json(401, { error: "authentication_required" });
    if (!allowed(ctx, principal, ctx.verifyRoles)) {
      return json(403, {
        error: "forbidden",
        detail: "verifying a deletion request is not granted to this role",
      });
    }
    const requestId = input.params["id"] ?? "";
    if (!REQUEST_ID_RE.test(requestId)) {
      return json(400, { error: "invalid_request", detail: "request id must be a dreq_… id" });
    }
    const parsed = VerifyDeletionRequestBodySchema.safeParse(input.parsedBody ?? {});
    if (!parsed.success) {
      return json(400, {
        error: "invalid_request",
        detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      });
    }
    const existing = await ctx.store.read(requestId).catch(() => undefined);
    if (existing === undefined) {
      return json(503, {
        error: "request_unreadable",
        detail: "a stored deletion request could not be read; do not treat this as an absence",
      });
    }
    if (existing === null) return json(404, { error: "not_found" });
    if (existing.submittedBy === principal.principalId) {
      // Verification is the platform attesting that the subject's identity was checked. The person who
      // typed the request in cannot also be the one who attests the check passed.
      return json(403, {
        error: "four_eyes_required",
        detail: "the verifier must not be the submitter of the request",
      });
    }

    const at = (ctx.clock ?? ((): Date => new Date()))().toISOString();
    let moved: DeletionRequestLike | null;
    try {
      moved = await ctx.store.transition(requestId, "verified", {
        at,
        verifiedBy: principal.principalId,
        verificationMethod: parsed.data.verificationMethod,
      });
    } catch (err) {
      // `illegal_transition` — a request already verified, completed or rejected. A 409, because
      // nothing is broken and the current state is the answer.
      return json(409, { error: "illegal_transition", detail: messageOf(err) });
    }
    if (moved === null) {
      // The in-predicate re-assertion did not match: somebody moved it between the read and the write.
      return json(409, {
        error: "concurrent_modification",
        detail: "the request changed status while this verification was in flight",
      });
    }

    await record(ctx, {
      tenantId: moved.tenantId,
      requestId: moved.id,
      principalId: principal.principalId,
      operation: DELETION_REQUEST_VERIFIED_OPERATION,
      status: moved.status,
      tombstoneId: null,
      detail: parsed.data.verificationMethod,
      at,
    });
    // Verified is the queue: nothing here runs the deletion, and a 202 says so.
    return json(202, requestHandle(moved));
  };
}

function buildRejectHandler(ctx: DeletionRequestRoutesContext): Handler {
  return async (input) => {
    const principal = input.principal;
    if (principal === null) return json(401, { error: "authentication_required" });
    if (!allowed(ctx, principal, ctx.verifyRoles)) {
      return json(403, {
        error: "forbidden",
        detail: "rejecting a deletion request is not granted to this role",
      });
    }
    const requestId = input.params["id"] ?? "";
    if (!REQUEST_ID_RE.test(requestId)) {
      return json(400, { error: "invalid_request", detail: "request id must be a dreq_… id" });
    }
    const parsed = RejectDeletionRequestBodySchema.safeParse(input.parsedBody ?? {});
    if (!parsed.success) {
      return json(400, {
        error: "invalid_request",
        detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      });
    }
    const at = (ctx.clock ?? ((): Date => new Date()))().toISOString();
    let moved: DeletionRequestLike | null;
    try {
      moved = await ctx.store.transition(requestId, "rejected", {
        at,
        rejectedReason: parsed.data.reason,
      });
    } catch (err) {
      return json(409, { error: "illegal_transition", detail: messageOf(err) });
    }
    if (moved === null) {
      return json(409, {
        error: "concurrent_modification",
        detail: "the request changed status while this rejection was in flight",
      });
    }
    await record(ctx, {
      tenantId: moved.tenantId,
      requestId: moved.id,
      principalId: principal.principalId,
      operation: DELETION_REQUEST_REJECTED_OPERATION,
      status: moved.status,
      tombstoneId: null,
      detail: parsed.data.reason,
      at,
    });
    return json(200, requestHandle(moved));
  };
}

function buildReadHandler(ctx: DeletionRequestRoutesContext): Handler {
  return async (input) => {
    const principal = input.principal;
    if (principal === null) return json(401, { error: "authentication_required" });
    if (!allowed(ctx, principal, readGrant(ctx))) {
      return json(403, {
        error: "forbidden",
        detail: "reading a deletion request is not granted to this role",
      });
    }
    const requestId = input.params["id"] ?? "";
    if (!REQUEST_ID_RE.test(requestId)) {
      return json(400, { error: "invalid_request", detail: "request id must be a dreq_… id" });
    }
    let request: DeletionRequestLike | null;
    try {
      request = await ctx.store.read(requestId);
    } catch {
      // The store re-parses every row (ADR-0289), so a throw can mean a stored request no longer
      // satisfies its contract. Reporting that as a 404 would read as "no such request", which is the
      // opposite of true — and this is the route a caller polls to learn whether a deletion happened.
      return json(503, {
        error: "request_unreadable",
        detail: "a stored deletion request could not be read; do not treat this as an absence",
      });
    }
    if (request === null) return json(404, { error: "not_found" });
    const at = (ctx.clock ?? ((): Date => new Date()))().toISOString();
    await record(ctx, {
      tenantId: request.tenantId,
      requestId: request.id,
      principalId: principal.principalId,
      operation: DELETION_REQUEST_READ_OPERATION,
      status: request.status,
      tombstoneId: request.tombstoneId,
      detail: null,
      at,
    });
    return json(200, requestHandle(request));
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function route(
  operationId: string,
  method: RouteDefinition["method"],
  segments: ReadonlyArray<string | { param: string }>,
  idempotencyRequired: boolean,
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
    idempotencyRequired,
    requestSchemaSha256: null,
    responseSchemaSha256: null,
  };
}

export function buildDeletionRequestRoutes(
  ctx: DeletionRequestRoutesContext,
): readonly ExtraGatewayRoute[] {
  return [
    {
      /**
       * Requires an idempotency key, like the synchronous delete does and for the mirror of its
       * reason: the id is generated here, so a retry without a key would open a *second* request for
       * the same subject — and both would run.
       */
      route: route("platform.deletion_requests.submit", "POST", ["v1", "platform", "deletion-requests"], true),
      handler: buildSubmitHandler(ctx),
    },
    {
      route: route(
        "platform.deletion_requests.verify",
        "POST",
        ["v1", "platform", "deletion-requests", { param: "id" }, "verify"],
        false,
      ),
      handler: buildVerifyHandler(ctx),
    },
    {
      route: route(
        "platform.deletion_requests.reject",
        "POST",
        ["v1", "platform", "deletion-requests", { param: "id" }, "reject"],
        false,
      ),
      handler: buildRejectHandler(ctx),
    },
    {
      route: route(
        "platform.deletion_requests.read",
        "GET",
        ["v1", "platform", "deletion-requests", { param: "id" }],
        false,
      ),
      handler: buildReadHandler(ctx),
    },
  ];
}
