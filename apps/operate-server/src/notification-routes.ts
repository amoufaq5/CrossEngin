import type { PathSegment, ResolvedPrincipal, RouteDefinition } from "@crossengin/api-gateway";
import type { Handler, HandlerOutput, PrincipalRoles } from "@crossengin/api-gateway-runtime";
import type { ExtraGatewayRoute } from "@crossengin/operate-runtime";

/**
 * Structural mirror of a persisted dispatch row. Declared here rather than imported so the
 * route layer stays decoupled from the dispatch store — the source itself is injected.
 * The row carries no rendered copy: only a hash of the template variables is persisted.
 */
export interface TenantNotificationLike {
  readonly dispatchId: string;
  readonly templateId: string;
  readonly channel: string;
  readonly category: string;
  readonly priority: string;
  readonly correlationId: string | null;
  readonly status: string;
  readonly queuedAt: string;
  readonly requestingSystem: string;
}

export interface TenantNotificationListQueryLike {
  readonly channel?: string;
  readonly templateId?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface TenantNotificationSourceLike {
  listForTenant(
    tenantId: string,
    query?: TenantNotificationListQueryLike,
  ): Promise<{ data: readonly TenantNotificationLike[]; nextCursor: string | null }>;
}

/** The human-readable half of a notification, joined from the correlated proposal at read time. */
export interface ProposalNoticeContentLike {
  readonly name: string;
  readonly reviewStatus: string;
  readonly reviewNotes: string | null;
  readonly reviewedAt: string | null;
}

export type ProposalNoticeResolver = (
  tenantId: string,
  proposalId: string,
) => Promise<ProposalNoticeContentLike | null>;

export interface NotificationRoutesContext {
  readonly source: TenantNotificationSourceLike;
  readonly principalRoles: (principal: ResolvedPrincipal | null) => PrincipalRoles;
  /** Roles permitted to read the tenant's notifications. Fail-closed: empty ⇒ nobody. */
  readonly allowedRoles: ReadonlySet<string>;
  /** Resolves the human-readable content for a notification's correlated proposal. */
  readonly resolveProposal?: ProposalNoticeResolver;
}

function json(status: number, body: unknown): HandlerOutput {
  return { kind: "json", status, body };
}

function hasRole(ctx: NotificationRoutesContext, principal: ResolvedPrincipal | null): boolean {
  const { primaryRole, secondaryRoles } = ctx.principalRoles(principal);
  return [primaryRole, ...(secondaryRoles ?? [])].some((r) => ctx.allowedRoles.has(r));
}

/** 401 when unauthenticated, 403 when the caller lacks an allowed role, else null (allowed). */
function guard(
  ctx: NotificationRoutesContext,
  principal: ResolvedPrincipal | null,
): HandlerOutput | null {
  if (principal === null) return json(401, { error: "authentication_required" });
  if (!hasRole(ctx, principal)) {
    return json(403, { error: "forbidden", detail: "insufficient role" });
  }
  return null;
}

function tenantOf(principal: ResolvedPrincipal | null): string | null {
  return principal?.tenantId ?? null;
}

function firstQueryValue(value: string | readonly string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : (value as string);
}

function readListQuery(input: Parameters<Handler>[0]): TenantNotificationListQueryLike {
  const query =
    (input.request as { query?: Record<string, string | string[]> } | undefined)?.query ?? {};
  const channelRaw = firstQueryValue(query["channel"]);
  const channel = channelRaw === undefined || channelRaw.length === 0 ? undefined : channelRaw;
  const templateIdRaw = firstQueryValue(query["templateId"]);
  const templateId =
    templateIdRaw === undefined || templateIdRaw.length === 0 ? undefined : templateIdRaw;
  const limitRaw = firstQueryValue(query["limit"]);
  const limit = limitRaw === undefined ? undefined : Number.parseInt(limitRaw, 10);
  const cursor = firstQueryValue(query["cursor"]);
  return { channel, templateId, limit, cursor };
}

/**
 * Spreads to nothing when no resolver is wired, so the key is absent rather than undefined.
 * The dispatch row stores only a hash of its variables (PII minimisation), so the readable
 * copy is joined from the proposal here; a failed join must not fail the page, so one
 * unresolvable item degrades to `proposal: null` instead of 500ing the whole list.
 */
export async function proposalFragment(
  resolveProposal: ProposalNoticeResolver | undefined,
  tenantId: string,
  correlationId: string | null,
): Promise<{ proposal?: ProposalNoticeContentLike | null }> {
  if (resolveProposal === undefined) return {};
  if (correlationId === null) return { proposal: null };
  try {
    return { proposal: await resolveProposal(tenantId, correlationId) };
  } catch {
    return { proposal: null };
  }
}

function buildListHandler(ctx: NotificationRoutesContext): Handler {
  return async (input) => {
    const denial = guard(ctx, input.principal);
    if (denial !== null) return denial;
    const tenant = tenantOf(input.principal);
    if (tenant === null) return json(400, { error: "tenant_required" });
    const page = await ctx.source.listForTenant(tenant, readListQuery(input));
    const data = await Promise.all(
      page.data.map(async (notification) => ({
        ...notification,
        ...(await proposalFragment(ctx.resolveProposal, tenant, notification.correlationId)),
      })),
    );
    return json(200, { data, page: { nextCursor: page.nextCursor } });
  };
}

/** The tenant-facing notification inbox route to inject via the gateway's `extraRoutes` hook. */
export function buildNotificationRoutes(
  ctx: NotificationRoutesContext,
): readonly ExtraGatewayRoute[] {
  return [
    {
      route: route("notifications.list", "GET", ["v1", "meta", "notifications"]),
      handler: buildListHandler(ctx),
    },
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
