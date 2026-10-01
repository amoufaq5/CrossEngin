import type { PathSegment, ResolvedPrincipal, RouteDefinition } from "@crossengin/api-gateway";
import type { Handler, HandlerOutput, PrincipalRoles } from "@crossengin/api-gateway-runtime";
import type { ExtraGatewayRoute } from "@crossengin/operate-runtime";

/**
 * Read-only HTTP over the audit-integrity verdict projection (the ADR-0287 follow-up).
 *
 * ADR-0287 left verdicts unreadable: they live as forensic-chain commitments, and the chain keeps
 * no payload, so "show me last month's verifications" could not be answered. These handlers answer
 * it from `meta.audit_integrity_verdicts`.
 *
 * Every response carries `chainEntryHash`, because **a row without a matching chain entry proves
 * nothing** — the row is a readable index, the chain entry is the proof. A reader who wants more
 * than a listing takes that hash to the chain; a row reporting `anchored: false` is telling them
 * there is nothing to take.
 */

export const INTEGRITY_VERDICT_VALUES = ["verified", "unproven", "compromised"] as const;
export type IntegrityVerdictValue = (typeof INTEGRITY_VERDICT_VALUES)[number];

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const DEFAULT_WINDOW_DAYS = 31;
const DEFAULT_MAX_RANGE_DAYS = 366;
const MS_PER_DAY = 86_400_000;

/**
 * Structural mirror of the store's record. Declared here rather than imported so the route layer
 * stays decoupled from the Postgres store — the source itself is injected, as in every other route
 * module here.
 */
export interface IntegrityVerdictRecordLike {
  readonly id: string;
  readonly verdictId: string;
  /** Null for the platform chain, which has no tenant. */
  readonly scope: string | null;
  readonly verdict: IntegrityVerdictValue;
  readonly verifiedAt: string;
  readonly anchorsChecked: number;
  readonly anchorsVerified: number;
  readonly anchorsTampered: number;
  readonly anchorsUnanchored: number;
  readonly chainOk: boolean | null;
  readonly truncated: boolean;
  readonly report: Record<string, unknown>;
  readonly chainEntryHash: string | null;
  readonly chainSequenceNumber: number | null;
  readonly payloadSha256: string | null;
  readonly createdAt: string;
}

export type IntegrityVerdictReadScopeLike =
  | { readonly kind: "tenant"; readonly tenantId: string }
  | { readonly kind: "platform" }
  | { readonly kind: "all" };

export interface IntegrityVerdictListQueryLike {
  readonly scope: IntegrityVerdictReadScopeLike;
  readonly verdict?: IntegrityVerdictValue;
  readonly from?: string;
  readonly to?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface IntegrityVerdictListPageLike {
  readonly data: readonly IntegrityVerdictRecordLike[];
  readonly nextCursor: string | null;
}

export interface IntegrityVerdictCountsLike {
  readonly verified: number;
  readonly unproven: number;
  readonly compromised: number;
  readonly total: number;
}

export interface IntegrityVerdictSourceLike {
  list(query: IntegrityVerdictListQueryLike): Promise<IntegrityVerdictListPageLike>;
  counts(
    query: Omit<IntegrityVerdictListQueryLike, "limit" | "cursor">,
  ): Promise<IntegrityVerdictCountsLike>;
  latest(scope: IntegrityVerdictReadScopeLike): Promise<IntegrityVerdictRecordLike | null>;
  getByVerdictId(
    verdictId: string,
    scope: IntegrityVerdictReadScopeLike,
  ): Promise<IntegrityVerdictRecordLike | null>;
}

export interface IntegrityVerdictRoutesContext {
  readonly source: IntegrityVerdictSourceLike;
  readonly principalRoles: (principal: ResolvedPrincipal | null) => PrincipalRoles;
  /**
   * Roles granted the cross-tenant view, which includes the platform chain's own verdicts.
   * Fail-closed: empty ⇒ nobody, so a deployment that forgets to configure it exposes nothing.
   */
  readonly platformRoles: ReadonlySet<string>;
  /** Roles granted their OWN tenant's verdicts. Fail-closed: empty ⇒ nobody. */
  readonly tenantRoles: ReadonlySet<string>;
  /** Caps the time window a single query may span. Defaults to 366 days. */
  readonly maxRangeDays?: number;
  readonly clock?: () => Date;
}

/**
 * What a caller is allowed to see — resolved from their identity, never from the request.
 *
 * `platform` is the cross-tenant grant and the only way to reach a `tenant_id IS NULL` verdict;
 * `tenant` is confined to the one tenant the principal resolved to. There is no third case: an
 * unauthenticated, unauthorised or tenant-less caller resolves to `null` and is refused.
 */
export type IntegrityVerdictGrant =
  | { readonly kind: "platform" }
  | { readonly kind: "tenant"; readonly tenantId: string };

function json(status: number, body: unknown): HandlerOutput {
  return { kind: "json", status, body };
}

function rolesOf(
  ctx: IntegrityVerdictRoutesContext,
  principal: ResolvedPrincipal | null,
): readonly string[] {
  const { primaryRole, secondaryRoles } = ctx.principalRoles(principal);
  return [primaryRole, ...(secondaryRoles ?? [])];
}

function hasAnyRole(roles: readonly string[], allowed: ReadonlySet<string>): boolean {
  if (allowed.size === 0) return false;
  return roles.some((r) => allowed.has(r));
}

/**
 * Resolves the caller's grant, or null when they have none.
 *
 * Fail closed in three distinct ways, each of which has been a real leak somewhere: no principal
 * is refused rather than treated as a system reader; a caller carrying only the tenant role but
 * **no resolvable tenant id** is refused rather than handed an unfiltered query; and an unknown
 * role falls through to refusal rather than to the narrower scope.
 */
export function resolveIntegrityVerdictGrant(
  ctx: IntegrityVerdictRoutesContext,
  principal: ResolvedPrincipal | null,
): IntegrityVerdictGrant | null {
  if (principal === null) return null;
  const roles = rolesOf(ctx, principal);
  if (hasAnyRole(roles, ctx.platformRoles)) return { kind: "platform" };
  if (!hasAnyRole(roles, ctx.tenantRoles)) return null;
  const tenantId = principal.tenantId ?? "";
  if (!UUID_RE.test(tenantId)) return null;
  return { kind: "tenant", tenantId };
}

function firstQueryValue(value: string | readonly string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : (value as string);
}

function queryOf(input: Parameters<Handler>[0]): Record<string, string | string[]> {
  return (input.request as { query?: Record<string, string | string[]> } | undefined)?.query ?? {};
}

function presentValue(raw: string | undefined): string | undefined {
  return raw === undefined || raw.length === 0 ? undefined : raw;
}

/**
 * The scope a request asks for, narrowed to what the grant permits.
 *
 * A platform grant may ask for `all` (the default), `platform`, or any single tenant. A tenant
 * grant may only ever read its own tenant: naming another tenant, or asking for the platform
 * chain, is a 403 rather than a silently-narrowed query — a caller should learn that they were
 * refused, not read their own rows and believe they saw everything.
 */
export function resolveRequestedScope(
  grant: IntegrityVerdictGrant,
  requestedScope: string | undefined,
  requestedTenantId: string | undefined,
): IntegrityVerdictReadScopeLike | { readonly error: string; readonly detail: string } {
  if (requestedTenantId !== undefined && !UUID_RE.test(requestedTenantId)) {
    return { error: "invalid_request", detail: "tenantId must be a uuid" };
  }
  if (grant.kind === "tenant") {
    if (requestedScope === "platform" || requestedScope === "all") {
      return { error: "forbidden", detail: `scope ${requestedScope} requires a platform grant` };
    }
    if (requestedTenantId !== undefined && requestedTenantId !== grant.tenantId) {
      return { error: "forbidden", detail: "cannot read another tenant's verdicts" };
    }
    return { kind: "tenant", tenantId: grant.tenantId };
  }
  if (requestedTenantId !== undefined) return { kind: "tenant", tenantId: requestedTenantId };
  if (requestedScope === "platform") return { kind: "platform" };
  if (requestedScope === undefined || requestedScope === "all") return { kind: "all" };
  return { error: "invalid_request", detail: `unknown scope ${requestedScope}` };
}

export interface IntegrityVerdictWindow {
  readonly from: string;
  readonly to: string;
}

/**
 * The time window to read, defaulting to the last 31 days — the question ADR-0287 actually asked.
 *
 * A window is always bounded, and the bound is validated rather than clamped: an unparseable or
 * inverted range is a client bug, and silently substituting a different range would answer a
 * question nobody asked while looking like a successful verification report.
 */
export function resolveWindow(
  rawFrom: string | undefined,
  rawTo: string | undefined,
  now: Date,
  maxRangeDays: number,
): IntegrityVerdictWindow | { readonly error: string; readonly detail: string } {
  const toMs = rawTo === undefined ? now.getTime() : Date.parse(rawTo);
  if (!Number.isFinite(toMs)) return { error: "invalid_request", detail: `unparseable to: ${String(rawTo)}` };
  const fromMs = rawFrom === undefined ? toMs - DEFAULT_WINDOW_DAYS * MS_PER_DAY : Date.parse(rawFrom);
  if (!Number.isFinite(fromMs)) {
    return { error: "invalid_request", detail: `unparseable from: ${String(rawFrom)}` };
  }
  if (fromMs >= toMs) return { error: "invalid_request", detail: "from must be before to" };
  if (toMs - fromMs > maxRangeDays * MS_PER_DAY) {
    return {
      error: "invalid_request",
      detail: `range exceeds ${maxRangeDays.toString()} days`,
    };
  }
  return { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() };
}

function isRefusal(
  value: unknown,
): value is { readonly error: string; readonly detail: string } {
  return typeof value === "object" && value !== null && "error" in value;
}

function statusFor(error: string): number {
  return error === "forbidden" ? 403 : 400;
}

/**
 * One verdict as the route reports it.
 *
 * `anchored` is spelled out rather than left for the reader to infer from a null hash, because the
 * difference between "committed to the chain" and "a row somebody wrote" is the whole basis for
 * believing any of this. `report` ships whole: it is the content the chain entry attests to, and
 * `payloadSha256` is the digest it committed to — together they let a reader confirm the row's
 * content *is* the committed content, where the hash alone only shows it names an entry. The
 * sequence ships too so the reader can seek to that entry rather than scan the chain for it.
 */
export function toVerdictView(record: IntegrityVerdictRecordLike): Record<string, unknown> {
  return {
    verdictId: record.verdictId,
    scope: record.scope,
    verdict: record.verdict,
    verifiedAt: record.verifiedAt,
    anchorsChecked: record.anchorsChecked,
    anchorsVerified: record.anchorsVerified,
    anchorsTampered: record.anchorsTampered,
    anchorsUnanchored: record.anchorsUnanchored,
    chainOk: record.chainOk,
    truncated: record.truncated,
    chainEntryHash: record.chainEntryHash,
    chainSequenceNumber: record.chainSequenceNumber,
    payloadSha256: record.payloadSha256,
    anchored: record.chainEntryHash !== null,
    report: record.report,
    createdAt: record.createdAt,
  };
}

interface ReadRequest {
  readonly scope: IntegrityVerdictReadScopeLike;
  readonly window: IntegrityVerdictWindow;
  readonly verdict?: IntegrityVerdictValue;
  readonly limit?: number;
  readonly cursor?: string;
}

/**
 * Everything a read needs, or the refusal that stops it. Authorisation first, then scope, then the
 * window: a caller who may not read at all must never see a validation message about their filters.
 */
function readRequest(
  ctx: IntegrityVerdictRoutesContext,
  input: Parameters<Handler>[0],
): ReadRequest | HandlerOutput {
  if (input.principal === null) return json(401, { error: "authentication_required" });
  const grant = resolveIntegrityVerdictGrant(ctx, input.principal);
  if (grant === null) return json(403, { error: "forbidden", detail: "insufficient role" });

  const query = queryOf(input);
  const scope = resolveRequestedScope(
    grant,
    presentValue(firstQueryValue(query["scope"])),
    presentValue(firstQueryValue(query["tenantId"])),
  );
  if (isRefusal(scope)) return json(statusFor(scope.error), scope);

  const now = (ctx.clock ?? ((): Date => new Date()))();
  const window = resolveWindow(
    presentValue(firstQueryValue(query["from"])),
    presentValue(firstQueryValue(query["to"])),
    now,
    ctx.maxRangeDays ?? DEFAULT_MAX_RANGE_DAYS,
  );
  if (isRefusal(window)) return json(statusFor(window.error), window);

  const verdictRaw = presentValue(firstQueryValue(query["verdict"]));
  if (verdictRaw !== undefined && !(INTEGRITY_VERDICT_VALUES as readonly string[]).includes(verdictRaw)) {
    return json(400, { error: "invalid_request", detail: `unknown verdict ${verdictRaw}` });
  }
  const limitRaw = presentValue(firstQueryValue(query["limit"]));
  const limit = limitRaw === undefined ? undefined : Number.parseInt(limitRaw, 10);
  if (limit !== undefined && !Number.isFinite(limit)) {
    return json(400, { error: "invalid_request", detail: `unparseable limit: ${limitRaw ?? ""}` });
  }
  return {
    scope,
    window,
    ...(verdictRaw === undefined ? {} : { verdict: verdictRaw as IntegrityVerdictValue }),
    ...(limit === undefined ? {} : { limit }),
    ...(presentValue(firstQueryValue(query["cursor"])) === undefined
      ? {}
      : { cursor: firstQueryValue(query["cursor"]) as string }),
  };
}

function isHandlerOutput(value: ReadRequest | HandlerOutput): value is HandlerOutput {
  return "kind" in value;
}

/**
 * A stored row that no longer parses is refused, and it refuses the **whole** page rather than
 * being dropped from it. Omitting it is precisely how a verdict would be made to disappear, so a
 * reader must be told the projection is unreadable instead of being handed a shorter list that
 * looks complete.
 */
type StoreRead<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly out: HandlerOutput };

async function guardStoreRead<T>(fn: () => Promise<T>): Promise<StoreRead<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return {
      ok: false,
      out: json(500, {
        error: "stored_verdict_invalid",
        detail: err instanceof Error ? err.message : String(err),
      }),
    };
  }
}

function buildListHandler(ctx: IntegrityVerdictRoutesContext): Handler {
  return async (input) => {
    const req = readRequest(ctx, input);
    if (isHandlerOutput(req)) return req;
    const read = await guardStoreRead(() =>
      ctx.source.list({
        scope: req.scope,
        from: req.window.from,
        to: req.window.to,
        ...(req.verdict === undefined ? {} : { verdict: req.verdict }),
        ...(req.limit === undefined ? {} : { limit: req.limit }),
        ...(req.cursor === undefined ? {} : { cursor: req.cursor }),
      }),
    );
    if (!read.ok) return read.out;
    return json(200, {
      scope: req.scope,
      window: req.window,
      data: read.value.data.map((r) => toVerdictView(r)),
      page: { nextCursor: read.value.nextCursor },
    });
  };
}

function buildStatsHandler(ctx: IntegrityVerdictRoutesContext): Handler {
  return async (input) => {
    const req = readRequest(ctx, input);
    if (isHandlerOutput(req)) return req;
    const read = await guardStoreRead(() =>
      ctx.source.counts({
        scope: req.scope,
        from: req.window.from,
        to: req.window.to,
        ...(req.verdict === undefined ? {} : { verdict: req.verdict }),
      }),
    );
    if (!read.ok) return read.out;
    return json(200, { scope: req.scope, window: req.window, counts: read.value });
  };
}

function buildLatestHandler(ctx: IntegrityVerdictRoutesContext): Handler {
  return async (input) => {
    const req = readRequest(ctx, input);
    if (isHandlerOutput(req)) return req;
    const read = await guardStoreRead(() => ctx.source.latest(req.scope));
    if (!read.ok) return read.out;
    if (read.value === null) {
      return json(404, { error: "verdict_not_found", detail: "no verdict in scope" });
    }
    return json(200, { scope: req.scope, verdict: toVerdictView(read.value) });
  };
}

function buildGetHandler(ctx: IntegrityVerdictRoutesContext): Handler {
  return async (input) => {
    const req = readRequest(ctx, input);
    if (isHandlerOutput(req)) return req;
    const verdictId = input.params["verdictId"] ?? "";
    // Scoped, not looked up by id alone: an id is guessable and a bare `WHERE verdict_id = $1`
    // would let a tenant read another tenant's verdict by naming it.
    const read = await guardStoreRead(() => ctx.source.getByVerdictId(verdictId, req.scope));
    if (!read.ok) return read.out;
    if (read.value === null) return json(404, { error: "verdict_not_found", detail: verdictId });
    return json(200, { verdict: toVerdictView(read.value) });
  };
}

/**
 * The audit-integrity verdict routes to inject via the gateway's `extraRoutes` hook. Read-only by
 * construction — there is no write path here, and a verdict is produced only by a proof pass.
 *
 * Not under `/v1/platform`: the same listing serves a tenant reading its own verdicts and a
 * platform operator reading every tenant's, and the grant — not the path — decides which.
 */
export function buildIntegrityVerdictRoutes(
  ctx: IntegrityVerdictRoutesContext,
): readonly ExtraGatewayRoute[] {
  const v = (
    op: string,
    method: RouteDefinition["method"],
    segs: ReadonlyArray<string | { param: string }>,
    handler: Handler,
  ): ExtraGatewayRoute => ({ route: route(op, method, segs), handler });
  return [
    v(
      "auditIntegrity.verdicts.list",
      "GET",
      ["v1", "audit-integrity", "verdicts"],
      buildListHandler(ctx),
    ),
    // The literal paths come before the parameterised one so they are not swallowed by `:verdictId`.
    v(
      "auditIntegrity.verdicts.stats",
      "GET",
      ["v1", "audit-integrity", "verdicts", "stats"],
      buildStatsHandler(ctx),
    ),
    v(
      "auditIntegrity.verdicts.latest",
      "GET",
      ["v1", "audit-integrity", "verdicts", "latest"],
      buildLatestHandler(ctx),
    ),
    v(
      "auditIntegrity.verdicts.get",
      "GET",
      ["v1", "audit-integrity", "verdicts", { param: "verdictId" }],
      buildGetHandler(ctx),
    ),
  ];
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
    idempotencyRequired: false,
    requestSchemaSha256: null,
    responseSchemaSha256: null,
  };
}
