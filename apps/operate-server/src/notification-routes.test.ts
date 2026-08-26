import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import type { Handler, HandlerInput, HandlerOutput } from "@crossengin/api-gateway-runtime";
import { describe, expect, it } from "vitest";

import {
  buildNotificationRoutes,
  type NotificationRoutesContext,
  type ProposalNoticeContentLike,
  type ProposalNoticeResolver,
  type TenantNotificationLike,
  type TenantNotificationListQueryLike,
  type TenantNotificationSourceLike,
  digestFragment,
  recipientFilterFor,
  requestedScope,
  type TenantScopeAuditEvent,
} from "./notification-routes.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const OTHER_TENANT = "00000000-0000-4000-8000-000000000002";
const TENANT_USER = "00000000-0000-4000-8000-0000000000bb";
const PROPOSAL = "aim_0001";

class FakeNotificationSource implements TenantNotificationSourceLike {
  readonly rows: TenantNotificationLike[] = [];
  readonly calls: Array<{ tenantId: string; query: TenantNotificationListQueryLike | undefined }> = [];
  private seq = 0;

  seed(overrides: Partial<TenantNotificationLike> = {}): TenantNotificationLike {
    this.seq += 1;
    const row: TenantNotificationLike = {
      dispatchId: `nd_${String(this.seq).padStart(4, "0")}`,
      templateId: "design_review_decision",
      channel: "email",
      category: "transactional",
      priority: "normal",
      correlationId: PROPOSAL,
      status: "queued",
      queuedAt: `2026-06-0${String(this.seq)}T00:00:00.000Z`,
      requestingSystem: "operate-server",
      ...overrides,
    };
    this.rows.push(row);
    return row;
  }

  async listForTenant(
    tenantId: string,
    query?: TenantNotificationListQueryLike,
  ): Promise<{ data: readonly TenantNotificationLike[]; nextCursor: string | null }> {
    this.calls.push({ tenantId, query });
    let visible = this.rows.filter((r) => r.channel !== "__none__");
    if (query?.channel !== undefined) visible = visible.filter((r) => r.channel === query.channel);
    if (query?.templateId !== undefined) {
      visible = visible.filter((r) => r.templateId === query.templateId);
    }
    const limit = query?.limit ?? 50;
    const offset = query?.cursor === undefined ? 0 : Number.parseInt(query.cursor, 10);
    const page = visible.slice(offset, offset + limit);
    const nextCursor = offset + limit < visible.length ? String(offset + limit) : null;
    return { data: page, nextCursor };
  }
}

const PROPOSAL_CONTENT: ProposalNoticeContentLike = {
  name: "Plumber CRM",
  reviewStatus: "approved",
  reviewNotes: "schema looks safe",
  reviewedAt: "2026-06-02T00:00:00.000Z",
};

interface ResolverStub {
  readonly resolve: ProposalNoticeResolver;
  readonly calls: Array<{ tenantId: string; proposalId: string }>;
}

function recordingResolver(
  result: ProposalNoticeContentLike | null | "throw" = PROPOSAL_CONTENT,
): ResolverStub {
  const calls: Array<{ tenantId: string; proposalId: string }> = [];
  return {
    calls,
    resolve: async (tenantId: string, proposalId: string): Promise<ProposalNoticeContentLike | null> => {
      calls.push({ tenantId, proposalId });
      if (result === "throw") throw new Error("proposal store unreachable");
      return result;
    },
  };
}

interface Harness {
  readonly ctx: NotificationRoutesContext & { source: FakeNotificationSource };
  readonly source: FakeNotificationSource;
}

function makeCtx(): Harness {
  const source = new FakeNotificationSource();
  const ctx = {
    source,
    principalRoles: (p: ResolvedPrincipal | null) => ({ primaryRole: p?.grantedScopes[0] ?? "anon" }),
    allowedRoles: new Set(["tenant_admin"]),
  };
  return { ctx, source };
}

function principal(role: string | null, tenantId: string | null = TENANT): ResolvedPrincipal | null {
  if (role === null) return null;
  return {
    principalId: TENANT_USER, tenantId, principalKind: "user", authScheme: "api_key_header",
    grantedScopes: [role], mfaProofAgeSeconds: null, resolvedAt: "2026-06-01T00:00:00.000Z",
  } as ResolvedPrincipal;
}

function input(
  role: string | null,
  opts: { query?: Record<string, string>; tenantId?: string | null } = {},
): HandlerInput {
  return {
    request: { query: opts.query ?? {} } as never,
    route: {} as never,
    principal: principal(role, opts.tenantId === undefined ? TENANT : opts.tenantId),
    params: {},
    parsedBody: null,
  };
}

function findHandler(ctx: NotificationRoutesContext, op: string): Handler {
  const found = buildNotificationRoutes(ctx).find((r) => r.route.operationId === op);
  if (found === undefined) throw new Error(`no route ${op}`);
  return found.handler;
}

type JsonOut = HandlerOutput & { status: number; body: Record<string, unknown> };

async function call(
  ctx: NotificationRoutesContext,
  opts: Parameters<typeof input>[1] = {},
  role: string | null = "tenant_admin",
): Promise<JsonOut> {
  return (await findHandler(ctx, "notifications.list")(input(role, opts))) as JsonOut;
}

function pathOf(route: { pathSegments: readonly unknown[] }): string {
  return (route.pathSegments as ReadonlyArray<{ kind: string; value?: string; name?: string }>)
    .map((s) => (s.kind === "literal" ? String(s.value) : `:${String(s.name)}`))
    .join("/");
}

function itemsOf(out: JsonOut): ReadonlyArray<Record<string, unknown>> {
  return out.body["data"] as ReadonlyArray<Record<string, unknown>>;
}

describe("notification-routes — route table", () => {
  it("builds exactly one route with the exact id, method, and path", () => {
    const routes = buildNotificationRoutes(makeCtx().ctx);
    expect(routes).toHaveLength(1);
    expect(routes.map((r) => [r.route.operationId, r.route.method, pathOf(r.route)])).toEqual([
      ["notifications.list", "GET", "v1/meta/notifications"],
    ]);
  });

  it("gives the route a stable rt_ id, v1 api version, and no required scopes", () => {
    const route = buildNotificationRoutes(makeCtx().ctx)[0]?.route;
    expect(route?.id).toBe("rt_notifications_list");
    expect(route?.apiVersion).toBe("v1");
    expect(route?.requiredScopes).toEqual([]);
    expect(route?.idempotencyRequired).toBe(false);
  });
});

describe("notification-routes — auth gating", () => {
  it("401s an unauthenticated caller without touching the source", async () => {
    const { ctx, source } = makeCtx();
    source.seed();
    const out = await call(ctx, {}, null);
    expect(out.status).toBe(401);
    expect(out.body["error"]).toBe("authentication_required");
    expect(source.calls).toHaveLength(0);
  });

  it("403s a caller without an allowed role", async () => {
    const { ctx, source } = makeCtx();
    source.seed();
    const out = await call(ctx, {}, "anon_visitor");
    expect(out.status).toBe(403);
    expect(out.body["error"]).toBe("forbidden");
    expect(source.calls).toHaveLength(0);
  });

  it("is fail-closed when no role is configured", async () => {
    const { ctx } = makeCtx();
    const closed: NotificationRoutesContext = { ...ctx, allowedRoles: new Set<string>() };
    expect((await call(closed)).status).toBe(403);
  });

  it("admits a caller whose allowed role is a secondary role", async () => {
    const { ctx } = makeCtx();
    const withSecondary: NotificationRoutesContext = {
      ...ctx,
      principalRoles: () => ({ primaryRole: "viewer", secondaryRoles: ["tenant_admin"] }),
    };
    expect((await call(withSecondary)).status).toBe(200);
  });

  it("400s a principal with no tenant", async () => {
    const { ctx, source } = makeCtx();
    const out = await call(ctx, { tenantId: null });
    expect(out.status).toBe(400);
    expect(out.body).toEqual({ error: "tenant_required" });
    expect(source.calls).toHaveLength(0);
  });
});

describe("notification-routes — list", () => {
  it("returns the tenant's notifications with a page envelope", async () => {
    const { ctx, source } = makeCtx();
    const first = source.seed();
    source.seed();
    const out = await call(ctx);
    expect(out.status).toBe(200);
    expect(Object.keys(out.body).sort()).toEqual(["data", "page", "scope"]);
    expect(itemsOf(out)).toHaveLength(2);
    expect(itemsOf(out)[0]?.["dispatchId"]).toBe(first.dispatchId);
    expect(itemsOf(out)[0]?.["templateId"]).toBe("design_review_decision");
    expect(itemsOf(out)[0]?.["status"]).toBe("queued");
    expect(out.body["page"]).toEqual({ nextCursor: null });
  });

  it("returns an empty page when the tenant has no notifications", async () => {
    const { ctx } = makeCtx();
    const out = await call(ctx);
    expect(out.status).toBe(200);
    expect(itemsOf(out)).toEqual([]);
    expect(out.body["page"]).toEqual({ nextCursor: null });
  });

  it("passes channel, templateId, limit, and cursor through to the source", async () => {
    const { ctx, source } = makeCtx();
    await call(ctx, { query: { channel: "email", templateId: "tpl_x", limit: "7", cursor: "3" } });
    expect(source.calls).toEqual([
      {
        tenantId: TENANT,
        query: { channel: "email", templateId: "tpl_x", limit: 7, cursor: "3" },
      },
    ]);
  });

  it("filters by channel and paginates with limit + cursor", async () => {
    const { ctx, source } = makeCtx();
    source.seed({ channel: "email" });
    source.seed({ channel: "in_app" });
    source.seed({ channel: "email" });
    const byChannel = await call(ctx, { query: { channel: "email" } });
    expect(itemsOf(byChannel)).toHaveLength(2);

    const firstPage = await call(ctx, { query: { limit: "2" } });
    expect(itemsOf(firstPage)).toHaveLength(2);
    const cursor = (firstPage.body["page"] as { nextCursor: string | null }).nextCursor;
    expect(cursor).toBe("2");
    const secondPage = await call(ctx, { query: { limit: "2", cursor: cursor as string } });
    expect(itemsOf(secondPage)).toHaveLength(1);
    expect((secondPage.body["page"] as { nextCursor: string | null }).nextCursor).toBeNull();
  });

  it("asks for the authenticated principal's tenant, never another", async () => {
    const { ctx, source } = makeCtx();
    source.seed();
    await call(ctx, { tenantId: OTHER_TENANT });
    expect(source.calls.map((c) => c.tenantId)).toEqual([OTHER_TENANT]);
    expect(source.calls.map((c) => c.tenantId)).not.toContain(TENANT);
  });
});

describe("notification-routes — proposal join", () => {
  it("joins the readable proposal content onto each correlated item", async () => {
    const { ctx, source } = makeCtx();
    const resolver = recordingResolver();
    const withResolver: NotificationRoutesContext = { ...ctx, resolveProposal: resolver.resolve };
    source.seed();
    const out = await call(withResolver);
    expect(out.status).toBe(200);
    expect(itemsOf(out)[0]?.["proposal"]).toEqual(PROPOSAL_CONTENT);
  });

  it("resolves with the principal's tenant and the item's correlationId", async () => {
    const { ctx, source } = makeCtx();
    const resolver = recordingResolver();
    const withResolver: NotificationRoutesContext = { ...ctx, resolveProposal: resolver.resolve };
    source.seed({ correlationId: "aim_0007" });
    await call(withResolver);
    expect(resolver.calls).toEqual([{ tenantId: TENANT, proposalId: "aim_0007" }]);
  });

  it("resolves once per correlated item", async () => {
    const { ctx, source } = makeCtx();
    const resolver = recordingResolver();
    const withResolver: NotificationRoutesContext = { ...ctx, resolveProposal: resolver.resolve };
    source.seed({ correlationId: "aim_0001" });
    source.seed({ correlationId: "aim_0002" });
    const out = await call(withResolver);
    expect(itemsOf(out)).toHaveLength(2);
    expect(resolver.calls.map((c) => c.proposalId)).toEqual(["aim_0001", "aim_0002"]);
  });

  it("returns proposal: null for an item with no correlationId, without resolving", async () => {
    const { ctx, source } = makeCtx();
    const resolver = recordingResolver();
    const withResolver: NotificationRoutesContext = { ...ctx, resolveProposal: resolver.resolve };
    source.seed({ correlationId: null });
    const out = await call(withResolver);
    expect(itemsOf(out)[0]?.["proposal"]).toBeNull();
    expect(resolver.calls).toHaveLength(0);
  });

  it("returns proposal: null when the proposal cannot be resolved", async () => {
    const { ctx, source } = makeCtx();
    const resolver = recordingResolver(null);
    const withResolver: NotificationRoutesContext = { ...ctx, resolveProposal: resolver.resolve };
    source.seed();
    const out = await call(withResolver);
    expect(out.status).toBe(200);
    expect(itemsOf(out)[0]?.["proposal"]).toBeNull();
    expect(resolver.calls).toHaveLength(1);
  });

  it("still 200s with the other items intact when one resolution throws", async () => {
    const { ctx, source } = makeCtx();
    const calls: string[] = [];
    const flaky: ProposalNoticeResolver = async (_tenantId, proposalId) => {
      calls.push(proposalId);
      if (proposalId === "aim_bad") throw new Error("proposal store unreachable");
      return PROPOSAL_CONTENT;
    };
    const withResolver: NotificationRoutesContext = { ...ctx, resolveProposal: flaky };
    source.seed({ correlationId: "aim_bad" });
    source.seed({ correlationId: "aim_ok" });
    const out = await call(withResolver);
    expect(out.status).toBe(200);
    expect(itemsOf(out)).toHaveLength(2);
    expect(itemsOf(out)[0]?.["proposal"]).toBeNull();
    expect(itemsOf(out)[1]?.["proposal"]).toEqual(PROPOSAL_CONTENT);
    expect(calls).toEqual(["aim_bad", "aim_ok"]);
  });

  it("keeps the dispatch fields alongside the joined proposal", async () => {
    const { ctx, source } = makeCtx();
    const resolver = recordingResolver();
    const withResolver: NotificationRoutesContext = { ...ctx, resolveProposal: resolver.resolve };
    const seeded = source.seed();
    const item = itemsOf(await call(withResolver))[0];
    expect(item).toEqual({ ...seeded, proposal: PROPOSAL_CONTENT });
  });

  it("omits the proposal key entirely when no resolver is configured", async () => {
    const { ctx, source } = makeCtx();
    source.seed();
    source.seed({ correlationId: null });
    const out = await call(ctx);
    expect(out.status).toBe(200);
    for (const item of itemsOf(out)) {
      expect("proposal" in item).toBe(false);
    }
  });

  it("does not resolve behind a guard denial or a missing tenant", async () => {
    const { ctx, source } = makeCtx();
    const resolver = recordingResolver();
    const withResolver: NotificationRoutesContext = { ...ctx, resolveProposal: resolver.resolve };
    source.seed();
    expect((await call(withResolver, {}, null)).status).toBe(401);
    expect((await call(withResolver, {}, "anon_visitor")).status).toBe(403);
    expect((await call(withResolver, { tenantId: null })).status).toBe(400);
    expect(resolver.calls).toHaveLength(0);
  });
});

describe("notification-routes — digestFragment", () => {
  const DIGEST_ID = `dgst_${"d".repeat(32)}`;
  const rendered = {
    title: "3 notifications",
    body: "<p>3 notifications</p>",
    severity: "info",
    itemCount: 3,
  };

  it("omits the key entirely when no resolver is wired", async () => {
    expect(await digestFragment(undefined, "notification.digest", "notification.digest", "t", DIGEST_ID)).toEqual({});
  });

  it("omits the key when no digest template id is configured", async () => {
    expect(
      await digestFragment(async () => rendered, undefined, "notification.digest", "t", DIGEST_ID),
    ).toEqual({});
  });

  it("omits the key for a notification that is not a digest", async () => {
    expect(
      await digestFragment(
        async () => rendered,
        "notification.digest",
        "design_review.approved",
        "t",
        DIGEST_ID,
      ),
    ).toEqual({});
  });

  it("resolves the rendered copy for a digest notification", async () => {
    expect(
      await digestFragment(async () => rendered, "notification.digest", "notification.digest", "t", DIGEST_ID),
    ).toEqual({ digest: rendered });
  });

  it("passes the tenant and the correlated digest id to the resolver", async () => {
    const seen: string[] = [];
    await digestFragment(
      async (tenantId, digestId) => {
        seen.push(tenantId, digestId);
        return rendered;
      },
      "notification.digest",
      "notification.digest",
      "tenant-1",
      DIGEST_ID,
    );
    expect(seen).toEqual(["tenant-1", DIGEST_ID]);
  });

  it("degrades to null for a digest notice with no correlation id", async () => {
    expect(
      await digestFragment(async () => rendered, "notification.digest", "notification.digest", "t", null),
    ).toEqual({ digest: null });
  });

  it("degrades to null rather than failing the list when the resolver throws", async () => {
    expect(
      await digestFragment(
        async () => {
          throw new Error("digest gone");
        },
        "notification.digest",
        "notification.digest",
        "t",
        DIGEST_ID,
      ),
    ).toEqual({ digest: null });
  });

  it("degrades to null when the pool no longer resolves", async () => {
    expect(
      await digestFragment(async () => null, "notification.digest", "notification.digest", "t", DIGEST_ID),
    ).toEqual({ digest: null });
  });
});

describe("notification-routes — recipient scoping", () => {
  const HASH_A = "a".repeat(64);
  const HASH_B = "b".repeat(64);
  const PRINCIPAL = "44444444-4444-4444-8444-444444444444";

  function principalOf(id: string | null): ResolvedPrincipal | null {
    if (id === null) return null;
    return { principalId: id, tenantId: "t", grantedScopes: [] } as unknown as ResolvedPrincipal;
  }

  function ctxOf(over: Partial<NotificationRoutesContext> = {}): NotificationRoutesContext {
    return {
      source: { listForTenant: async () => ({ data: [], nextCursor: null }) },
      principalRoles: () => ({ primaryRole: "erp_admin", secondaryRoles: [] }),
      allowedRoles: new Set(["erp_admin"]),
      ...over,
    };
  }

  it("lists the whole tenant when no identity resolver is wired", async () => {
    const ctx = ctxOf();
    expect(await recipientFilterFor(ctx, principalOf(PRINCIPAL), "t", "self")).toBeNull();
  });

  it("filters to the caller's own address hashes", async () => {
    const ctx = ctxOf({ resolveIdentity: async () => ({ addressHashes: [HASH_A, HASH_B] }) });
    expect(await recipientFilterFor(ctx, principalOf(PRINCIPAL), "t", "self")).toEqual([HASH_A, HASH_B]);
  });

  it("shows nothing — not everything — for an unresolvable identity", async () => {
    const ctx = ctxOf({ resolveIdentity: async () => null });
    expect(await recipientFilterFor(ctx, principalOf(PRINCIPAL), "t", "self")).toEqual([]);
  });

  it("shows nothing when the resolver throws", async () => {
    const ctx = ctxOf({
      resolveIdentity: async () => {
        throw new Error("users unreadable");
      },
    });
    expect(await recipientFilterFor(ctx, principalOf(PRINCIPAL), "t", "self")).toEqual([]);
  });

  it("shows nothing for a principal with no id", async () => {
    const ctx = ctxOf({ resolveIdentity: async () => ({ addressHashes: [HASH_A] }) });
    expect(await recipientFilterFor(ctx, principalOf(null), "t", "self")).toEqual([]);
  });

  it("refuses tenant scope to a role that is not permitted", async () => {
    const ctx = ctxOf({
      resolveIdentity: async () => ({ addressHashes: [HASH_A] }),
      tenantScopeRoles: new Set(["platform_admin"]),
    });
    expect(await recipientFilterFor(ctx, principalOf(PRINCIPAL), "t", "tenant")).toEqual([HASH_A]);
  });

  it("grants tenant scope to a permitted role that asks for it", async () => {
    const ctx = ctxOf({
      resolveIdentity: async () => ({ addressHashes: [HASH_A] }),
      principalRoles: () => ({ primaryRole: "platform_admin", secondaryRoles: [] }),
      tenantScopeRoles: new Set(["platform_admin"]),
    });
    expect(await recipientFilterFor(ctx, principalOf(PRINCIPAL), "t", "tenant")).toBeNull();
  });

  it("keeps a permitted role scoped to self unless tenant scope is asked for", async () => {
    const ctx = ctxOf({
      resolveIdentity: async () => ({ addressHashes: [HASH_A] }),
      principalRoles: () => ({ primaryRole: "platform_admin", secondaryRoles: [] }),
      tenantScopeRoles: new Set(["platform_admin"]),
    });
    expect(await recipientFilterFor(ctx, principalOf(PRINCIPAL), "t", "self")).toEqual([HASH_A]);
  });

  it("grants tenant scope via a secondary role", async () => {
    const ctx = ctxOf({
      resolveIdentity: async () => ({ addressHashes: [HASH_A] }),
      principalRoles: () => ({ primaryRole: "erp_admin", secondaryRoles: ["platform_admin"] }),
      tenantScopeRoles: new Set(["platform_admin"]),
    });
    expect(await recipientFilterFor(ctx, principalOf(PRINCIPAL), "t", "tenant")).toBeNull();
  });

  it("refuses tenant scope when no role is configured for it", async () => {
    const ctx = ctxOf({ resolveIdentity: async () => ({ addressHashes: [HASH_A] }) });
    expect(await recipientFilterFor(ctx, principalOf(PRINCIPAL), "t", "tenant")).toEqual([HASH_A]);
  });

  it("passes the tenant and principal id to the resolver", async () => {
    const seen: string[] = [];
    const ctx = ctxOf({
      resolveIdentity: async (tenantId, principalId) => {
        seen.push(tenantId, principalId);
        return { addressHashes: [HASH_A] };
      },
    });
    await recipientFilterFor(ctx, principalOf(PRINCIPAL), "tenant-9", "self");
    expect(seen).toEqual(["tenant-9", PRINCIPAL]);
  });
});

describe("notification-routes — requestedScope", () => {
  it("defaults to self", () => {
    expect(requestedScope(undefined)).toBe("self");
    expect(requestedScope("")).toBe("self");
    expect(requestedScope("everything")).toBe("self");
  });

  it("reads tenant only from the exact literal", () => {
    expect(requestedScope("tenant")).toBe("tenant");
    expect(requestedScope("Tenant")).toBe("self");
  });
});

describe("notification-routes — tenant-scope audit", () => {
  const AUDITED_ROLE = "auditor";

  function auditedCtx(over: Partial<NotificationRoutesContext> = {}): {
    ctx: NotificationRoutesContext;
    events: TenantScopeAuditEvent[];
  } {
    const events: TenantScopeAuditEvent[] = [];
    const ctx: NotificationRoutesContext = {
      source: { listForTenant: async () => ({ data: [], nextCursor: null }) },
      principalRoles: (p) => ({ primaryRole: p?.grantedScopes[0] ?? "anon", secondaryRoles: [] }),
      allowedRoles: new Set([AUDITED_ROLE, "tenant_admin"]),
      resolveIdentity: async () => ({ addressHashes: ["a".repeat(64)] }),
      tenantScopeRoles: new Set([AUDITED_ROLE]),
      auditTenantScope: async (e) => {
        events.push(e);
      },
      clock: () => new Date("2026-08-25T12:00:00.000Z"),
      ...over,
    };
    return { ctx, events };
  }

  it("records a granted escalation before serving it", async () => {
    const { ctx, events } = auditedCtx();
    const out = await call(ctx, { query: { scope: "tenant" } }, AUDITED_ROLE);
    expect(out.status).toBe(200);
    expect(out.body["scope"]).toBe("tenant");
    expect(events).toHaveLength(1);
    expect(events[0]?.granted).toBe(true);
  });

  it("refuses the read with 503 when the record cannot be written", async () => {
    const { ctx } = auditedCtx({
      auditTenantScope: async () => {
        throw new Error("audit table gone");
      },
    });
    const out = await call(ctx, { query: { scope: "tenant" } }, AUDITED_ROLE);
    expect(out.status).toBe(503);
    expect(out.body["error"]).toBe("audit_unavailable");
  });

  it("does not read the tenant's data when the record fails", async () => {
    let listed = 0;
    const { ctx } = auditedCtx({
      source: {
        listForTenant: async () => {
          listed += 1;
          return { data: [], nextCursor: null };
        },
      },
      auditTenantScope: async () => {
        throw new Error("nope");
      },
    });
    await call(ctx, { query: { scope: "tenant" } }, AUDITED_ROLE);
    expect(listed).toBe(0);
  });

  it("records a refused escalation as not granted", async () => {
    const { ctx, events } = auditedCtx();
    const out = await call(ctx, { query: { scope: "tenant" } }, "tenant_admin");
    expect(out.status).toBe(200);
    expect(out.body["scope"]).toBe("self");
    expect(events).toHaveLength(1);
    expect(events[0]?.granted).toBe(false);
  });

  it("still serves the self-scoped list when recording a refusal fails", async () => {
    const { ctx } = auditedCtx({
      auditTenantScope: async () => {
        throw new Error("audit table gone");
      },
    });
    const out = await call(ctx, { query: { scope: "tenant" } }, "tenant_admin");
    expect(out.status).toBe(200);
    expect(out.body["scope"]).toBe("self");
  });

  it("records nothing for an ordinary self-scoped read", async () => {
    const { ctx, events } = auditedCtx();
    await call(ctx, {}, AUDITED_ROLE);
    expect(events).toEqual([]);
  });

  it("serves tenant scope unaudited when no auditor is wired", async () => {
    const { ctx } = auditedCtx();
    const noAuditor: NotificationRoutesContext = { ...ctx };
    delete (noAuditor as { auditTenantScope?: unknown }).auditTenantScope;
    const out = await call(noAuditor, { query: { scope: "tenant" } }, AUDITED_ROLE);
    expect(out.body["scope"]).toBe("tenant");
  });

  it("captures what was read, not just that something was", async () => {
    const { ctx, events } = auditedCtx();
    await call(
      ctx,
      { query: { scope: "tenant", channel: "in_app", templateId: "design_review.approved", limit: "5", cursor: "c1" } },
      AUDITED_ROLE,
    );
    expect(events[0]?.filters).toEqual({
      channel: "in_app",
      templateId: "design_review.approved",
      limit: 5,
      paged: true,
    });
  });

  it("records the caller's principal, roles and time", async () => {
    const { ctx, events } = auditedCtx();
    await call(ctx, { query: { scope: "tenant" } }, AUDITED_ROLE);
    expect(events[0]?.tenantId).toBe(TENANT);
    expect(events[0]?.roles).toContain(AUDITED_ROLE);
    expect(events[0]?.at).toBe("2026-08-25T12:00:00.000Z");
    expect(events[0]?.principalId).toBeTruthy();
  });

  it("marks an unpaged read as not paged", async () => {
    const { ctx, events } = auditedCtx();
    await call(ctx, { query: { scope: "tenant" } }, AUDITED_ROLE);
    expect(events[0]?.filters["paged"]).toBe(false);
  });
});
