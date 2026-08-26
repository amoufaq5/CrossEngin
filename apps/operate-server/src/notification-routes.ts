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
  readonly recipientAddressSha256?: readonly string[];
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

/** The rendered copy of a digest, resolved from the pool it stands for. */
export interface DigestNoticeContentLike {
  readonly title: string;
  readonly body: string;
  readonly severity: string;
  readonly itemCount: number;
}

export type DigestNoticeResolver = (
  tenantId: string,
  digestId: string,
) => Promise<DigestNoticeContentLike | null>;

export interface NotificationRoutesContext {
  readonly source: TenantNotificationSourceLike;
  readonly principalRoles: (principal: ResolvedPrincipal | null) => PrincipalRoles;
  /** Roles permitted to read the tenant's notifications. Fail-closed: empty ⇒ nobody. */
  readonly allowedRoles: ReadonlySet<string>;
  /** Resolves the human-readable content for a notification's correlated proposal. */
  readonly resolveProposal?: ProposalNoticeResolver;
  /** Renders the copy for a digest notification from the pool it correlates to. */
  readonly resolveDigest?: DigestNoticeResolver;
  /** Template id that marks a notification as an assembled digest. */
  readonly digestTemplateId?: string;
  /**
   * Turns the calling principal into the address hashes the delivery ledger recorded for them.
   * Wiring this switches the inbox from tenant-wide to per-recipient.
   */
  readonly resolveIdentity?: NotificationIdentityResolver;
  /** Roles permitted to ask for the whole tenant's notifications via `?scope=tenant`. */
  readonly tenantScopeRoles?: ReadonlySet<string>;
  /**
   * Records an attempt to read beyond one's own inbox. When wired, a *granted* escalation is
   * recorded before any data is returned and a failure to record refuses the read.
   */
  readonly auditTenantScope?: TenantScopeAuditor;
  readonly clock?: () => Date;
}

export interface NotificationIdentityLike {
  readonly addressHashes: readonly string[];
}

export type NotificationIdentityResolver = (
  tenantId: string,
  principalId: string,
) => Promise<NotificationIdentityLike | null>;

export const NOTIFICATION_SCOPES = ["self", "tenant"] as const;
export type NotificationScope = (typeof NOTIFICATION_SCOPES)[number];

export interface TenantScopeAuditEvent {
  readonly tenantId: string;
  readonly principalId: string | null;
  readonly roles: readonly string[];
  /** Whether the caller's role actually carried the escalation. */
  readonly granted: boolean;
  /** The query the caller ran, so the record says what was read, not just that something was. */
  readonly filters: Readonly<Record<string, string | number | boolean>>;
  readonly at: string;
}

export type TenantScopeAuditor = (event: TenantScopeAuditEvent) => Promise<void>;

export const TENANT_SCOPE_GRANTED_OPERATION = "notifications.read_tenant_scope";
export const TENANT_SCOPE_DENIED_OPERATION = "notifications.tenant_scope_denied";

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

/**
 * Only a digest notification carries digest copy, and only the template id says so — the
 * correlationId of an ordinary notice points at a proposal, not a pool, and resolving one as the
 * other would render nonsense. Absent, null and populated are all normal.
 */
export async function digestFragment(
  resolveDigest: DigestNoticeResolver | undefined,
  digestTemplateId: string | undefined,
  templateId: string,
  tenantId: string,
  correlationId: string | null,
): Promise<{ digest?: DigestNoticeContentLike | null }> {
  if (resolveDigest === undefined || digestTemplateId === undefined) return {};
  if (templateId !== digestTemplateId) return {};
  if (correlationId === null) return { digest: null };
  try {
    return { digest: await resolveDigest(tenantId, correlationId) };
  } catch {
    return { digest: null };
  }
}

export function tenantScopeEvent(
  ctx: NotificationRoutesContext,
  principal: ResolvedPrincipal | null,
  tenantId: string,
  granted: boolean,
  query: TenantNotificationListQueryLike,
): TenantScopeAuditEvent {
  const { primaryRole, secondaryRoles } = ctx.principalRoles(principal);
  const filters: Record<string, string | number | boolean> = {};
  if (query.channel !== undefined) filters["channel"] = query.channel;
  if (query.templateId !== undefined) filters["templateId"] = query.templateId;
  if (query.limit !== undefined && Number.isFinite(query.limit)) filters["limit"] = query.limit;
  filters["paged"] = query.cursor !== undefined && query.cursor.length > 0;
  return {
    tenantId,
    principalId: principal?.principalId ?? null,
    roles: [primaryRole, ...(secondaryRoles ?? [])],
    granted,
    filters,
    at: (ctx.clock ?? ((): Date => new Date()))().toISOString(),
  };
}

export function requestedScope(raw: string | undefined): NotificationScope {
  return raw === "tenant" ? "tenant" : "self";
}

export function canReadTenantScope(
  ctx: NotificationRoutesContext,
  principal: ResolvedPrincipal | null,
): boolean {
  const allowed = ctx.tenantScopeRoles;
  if (allowed === undefined || allowed.size === 0) return false;
  const { primaryRole, secondaryRoles } = ctx.principalRoles(principal);
  return [primaryRole, ...(secondaryRoles ?? [])].some((r) => allowed.has(r));
}

/**
 * The recipient filter for this request, or null to list the whole tenant.
 *
 * An identity that cannot be resolved yields an EMPTY hash list, not a null one: the caller is
 * nobody the ledger has delivered to, so they see nothing. Returning null there would hand them
 * every notification in the tenant — the exact leak this filter exists to close.
 */
export async function recipientFilterFor(
  ctx: NotificationRoutesContext,
  principal: ResolvedPrincipal | null,
  tenantId: string,
  scope: NotificationScope,
): Promise<readonly string[] | null> {
  if (ctx.resolveIdentity === undefined) return null;
  if (scope === "tenant" && canReadTenantScope(ctx, principal)) return null;
  const principalId = principal?.principalId ?? null;
  if (principalId === null) return [];
  try {
    const identity = await ctx.resolveIdentity(tenantId, principalId);
    return identity?.addressHashes ?? [];
  } catch {
    return [];
  }
}

function buildListHandler(ctx: NotificationRoutesContext): Handler {
  return async (input) => {
    const denial = guard(ctx, input.principal);
    if (denial !== null) return denial;
    const tenant = tenantOf(input.principal);
    if (tenant === null) return json(400, { error: "tenant_required" });
    const scope = requestedScope(
      firstQueryValue(
        (input.request as { query?: Record<string, string | string[]> } | undefined)?.query?.[
          "scope"
        ],
      ),
    );
    const query = readListQuery(input);
    let effectiveScope: NotificationScope = "self";
    if (scope === "tenant") {
      const granted = canReadTenantScope(ctx, input.principal);
      const event = tenantScopeEvent(ctx, input.principal, tenant, granted, query);
      if (granted) {
        // Recorded BEFORE the data is returned, and a failed record refuses the read: unaudited
        // privileged access is not access we grant. An after-the-fact write could be lost
        // precisely when the read was one someone later needs to account for.
        if (ctx.auditTenantScope !== undefined) {
          try {
            await ctx.auditTenantScope(event);
          } catch {
            return json(503, {
              error: "audit_unavailable",
              detail: "tenant-scope reads cannot be granted while they cannot be recorded",
            });
          }
        }
        effectiveScope = "tenant";
      } else if (ctx.auditTenantScope !== undefined) {
        // A refused escalation is worth recording but is not itself privileged access, so a
        // failure here must not deny the caller the self-scoped list they are entitled to.
        try {
          await ctx.auditTenantScope(event);
        } catch {
          /* best effort */
        }
      }
    }
    const hashes = await recipientFilterFor(ctx, input.principal, tenant, effectiveScope);
    const page = await ctx.source.listForTenant(tenant, {
      ...query,
      ...(hashes !== null ? { recipientAddressSha256: hashes } : {}),
    });
    const data = await Promise.all(
      page.data.map(async (notification) => ({
        ...notification,
        ...(await proposalFragment(ctx.resolveProposal, tenant, notification.correlationId)),
        ...(await digestFragment(
          ctx.resolveDigest,
          ctx.digestTemplateId,
          notification.templateId,
          tenant,
          notification.correlationId,
        )),
      })),
    );
    return json(200, { data, page: { nextCursor: page.nextCursor }, scope: hashes === null ? "tenant" : "self" });
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
