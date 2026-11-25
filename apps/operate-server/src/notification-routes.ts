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
  /**
   * Roles permitted to list **their own** notices. Fail-closed: empty ⇒ nobody.
   *
   * This used to be one `allowedRoles` gating the whole list — and the deployment passed the AI
   * design grant into it, so whether a person could read their own inbox depended on whether they
   * could design manifests (ADR-0476). The self list is a principal reading its own rows, which is
   * the read-state routes' question (the viewer is the credential, ADR-0364/0376), so it is granted
   * by the same set: the badge and the list it counts cannot disagree about who may see the page.
   *
   * It grants nothing beyond the caller's own rows, and that is only true while `resolveIdentity`
   * is wired: without a resolver the list cannot be narrowed to a recipient and every answer is the
   * tenant's, so a caller holding only this grant is **refused** there rather than handed the tenant
   * list (`self_scope_unavailable`).
   */
  readonly selfRoles: ReadonlySet<string>;
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
  /**
   * Roles permitted to read the whole tenant's notifications — via `?scope=tenant`, or by any list
   * at all when no `resolveIdentity` is wired (then nothing narrows the answer to one recipient).
   * Its own grant, deliberately not the self one: reading other people's notices is an escalation.
   */
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

function holdsAny(
  ctx: NotificationRoutesContext,
  principal: ResolvedPrincipal | null,
  allowed: ReadonlySet<string> | undefined,
): boolean {
  if (allowed === undefined || allowed.size === 0) return false;
  const { primaryRole, secondaryRoles } = ctx.principalRoles(principal);
  return [primaryRole, ...(secondaryRoles ?? [])].some((r) => allowed.has(r));
}

/**
 * 401 when unauthenticated, 403 when the caller holds neither grant, else null (allowed).
 *
 * Either grant admits: the tenant-scope grant strictly widens the self one, so a caller holding
 * only it may still list (and the scope decision below decides what).
 */
function guard(
  ctx: NotificationRoutesContext,
  principal: ResolvedPrincipal | null,
): HandlerOutput | null {
  if (principal === null) return json(401, { error: "authentication_required" });
  if (!holdsAny(ctx, principal, ctx.selfRoles) && !holdsAny(ctx, principal, ctx.tenantScopeRoles)) {
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
  return holdsAny(ctx, principal, ctx.tenantScopeRoles);
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
    // With no resolver every list is the tenant's, so the self grant has nothing it can serve.
    // Refused by name rather than widened: handing a self-only caller the tenant list is the leak
    // the recipient filter exists to close, and answering an empty list would read as "no notices".
    if (ctx.resolveIdentity === undefined && !canReadTenantScope(ctx, input.principal)) {
      return json(403, {
        error: "self_scope_unavailable",
        detail: "no recipient identity is wired, so the only list is the tenant's, which needs the tenant-scope grant",
      });
    }
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
    let page: { readonly data: readonly TenantNotificationLike[]; readonly nextCursor: string | null };
    try {
      page = await ctx.source.listForTenant(tenant, {
        ...query,
        ...(hashes !== null ? { recipientAddressSha256: hashes } : {}),
      });
    } catch {
      // `rowToRecord` parses every row, and the declared consequence is the sharp one: a refused
      // notification row **empties the inbox** rather than hiding one notice. Named rather than
      // dropped, because an empty inbox is the answer a recipient cannot tell from having no
      // notices.
      //
      // 500 and not 503, deliberately: the condition is permanent and a 503 is retryable — this app
      // already made the inverse mistake once, with `gatewayTimeout`'s 504 on a permanent fault
      // (ADR-0359). The one of these routes with a non-privileged caller, so no detail.
      //
      // Scoped to the store call: `proposalFragment` and `digestFragment` below issue their own
      // store reads inside the `Promise.all`, and those are a different condition — each catches
      // its own throw and answers `null`, on the standing decision that a notice missing its
      // joined copy beats no inbox. So a wider `try` here would convert their *recovered*
      // failure into this refusal, taking the whole page away over copy the inbox can do without.
      return json(500, { error: "inbox_page_unreadable" });
    }
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

/** Which grant governs the self-scoped list, as the deployment wired it. */
export const NOTIFICATION_LIST_GRANT_SOURCES = ["read_state", "ai_design"] as const;
export type NotificationListGrantSource = (typeof NOTIFICATION_LIST_GRANT_SOURCES)[number];

export interface NotificationListGrant {
  readonly roles: readonly string[];
  readonly source: NotificationListGrantSource;
}

/**
 * The roles that may list their own notices (ADR-0476).
 *
 * The read-state roles when the deployment grants read state — the page's other half, so one set
 * governs the list and the badge counting it. Only when no read-state role is granted does the
 * list fall back to the AI design grant, which is what governed it before; that is not a policy but
 * the absence of one, and the boot line says which governs so an operator can see it.
 */
export function notificationListGrant(
  readStateRoles: readonly string[],
  aiDesignRoles: readonly string[],
): NotificationListGrant {
  return readStateRoles.length > 0
    ? { roles: [...readStateRoles], source: "read_state" }
    : { roles: [...aiDesignRoles], source: "ai_design" };
}

export function formatNotificationListGrant(
  grant: NotificationListGrant,
  tenantScopeRoles: readonly string[],
): { readonly level: "info" | "warn"; readonly line: string } {
  const roles = grant.roles.length === 0 ? "(none: every request is refused)" : grant.roles.join(", ");
  const tenant =
    tenantScopeRoles.length === 0 ? "nobody" : tenantScopeRoles.join(", ");
  if (grant.source === "read_state") {
    return {
      level: "info",
      line:
        `[notifications] own-inbox list granted to the read-state roles: ${roles}` +
        ` (tenant-wide list: ${tenant})`,
    };
  }
  return {
    level: "warn",
    line:
      `[notifications] own-inbox list granted to the --ai-design-role roles: ${roles}, because no` +
      ` --read-state-role is granted; pass --read-state-role so the inbox and its badge share one grant` +
      ` (tenant-wide list: ${tenant})`,
  };
}
