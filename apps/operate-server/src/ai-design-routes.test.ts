import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import type { Handler, HandlerInput, HandlerOutput } from "@crossengin/api-gateway-runtime";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_PROPOSAL_NAME,
  buildAiDesignRoutes,
  type AiDesignContext,
  type AiManifestCreateInput,
  type AiManifestListQuery,
  type AiManifestRecordLike,
  type AiManifestStatus,
  type AiManifestStore,
  type DesignResultLike,
  type ManifestDesignerLike,
} from "./ai-design-routes.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const OTHER_TENANT = "00000000-0000-4000-8000-000000000002";
const USER = "00000000-0000-4000-8000-0000000000aa";

class FakeStore implements AiManifestStore {
  readonly records = new Map<string, AiManifestRecordLike>();
  readonly createCalls: Array<{ tenantId: string; input: AiManifestCreateInput }> = [];
  private seq = 0;

  async create(tenantId: string, input: AiManifestCreateInput): Promise<AiManifestRecordLike> {
    this.createCalls.push({ tenantId, input });
    this.seq += 1;
    const at = new Date(Date.UTC(2026, 5, 1) + this.seq * 1000).toISOString();
    const record: AiManifestRecordLike = {
      id: `aim_${String(this.seq).padStart(4, "0")}`,
      tenantId,
      name: input.name,
      description: input.description,
      manifest: input.manifest,
      manifestHash: input.manifestHash,
      status: "draft",
      source: input.source,
      providerLabel: input.providerLabel ?? null,
      createdAt: at,
      updatedAt: at,
      activatedAt: null,
    };
    this.records.set(record.id, record);
    return record;
  }

  async list(
    tenantId: string,
    query: AiManifestListQuery = {},
  ): Promise<{ data: readonly AiManifestRecordLike[]; nextCursor: string | null }> {
    let visible = [...this.records.values()].filter((r) => r.tenantId === tenantId);
    if (query.status !== undefined) visible = visible.filter((r) => r.status === query.status);
    visible.sort((a, b) => a.id.localeCompare(b.id));
    const limit = query.limit ?? 50;
    const offset = query.cursor === undefined ? 0 : Number.parseInt(query.cursor, 10);
    const page = visible.slice(offset, offset + limit);
    const nextCursor = offset + limit < visible.length ? String(offset + limit) : null;
    return { data: page, nextCursor };
  }

  async getById(tenantId: string, id: string): Promise<AiManifestRecordLike | null> {
    const record = this.records.get(id);
    if (record === undefined || record.tenantId !== tenantId) return null;
    return record;
  }

  async setStatus(
    tenantId: string,
    id: string,
    status: AiManifestStatus,
  ): Promise<AiManifestRecordLike | null> {
    const record = await this.getById(tenantId, id);
    if (record === null) return null;
    const next: AiManifestRecordLike = { ...record, status, updatedAt: new Date().toISOString() };
    this.records.set(id, next);
    return next;
  }

  async activate(tenantId: string, id: string): Promise<AiManifestRecordLike | null> {
    const record = await this.getById(tenantId, id);
    if (record === null) return null;
    const now = new Date().toISOString();
    const next: AiManifestRecordLike = { ...record, status: "active", activatedAt: now, updatedAt: now };
    this.records.set(id, next);
    return next;
  }
}

const OK_MANIFEST: Record<string, unknown> = { meta: { slug: "acme/crm" }, entities: [{ name: "Lead" }] };

function okDesigner(): ManifestDesignerLike {
  return async () => ({
    ok: true,
    manifest: OK_MANIFEST,
    manifestHash: "sha256:abc123",
    issues: [],
    attempts: 1,
    providerLabel: "anthropic/claude-sonnet-4-6",
    usage: { inputTokens: 100, outputTokens: 400, cost: 0.0123 },
  });
}

function failDesigner(issues: readonly string[], attempts: number): ManifestDesignerLike {
  return async (): Promise<DesignResultLike> => ({
    ok: false,
    manifest: null,
    manifestHash: null,
    issues,
    attempts,
    providerLabel: "anthropic/claude-sonnet-4-6",
    usage: null,
  });
}

interface CtxOverrides {
  readonly store?: FakeStore;
  readonly designer?: ManifestDesignerLike | null;
  readonly onActivated?: (tenantId: string) => void;
}

function makeCtx(overrides: CtxOverrides = {}): AiDesignContext & { store: FakeStore } {
  const store = overrides.store ?? new FakeStore();
  return {
    store,
    designer: overrides.designer === undefined ? okDesigner() : overrides.designer,
    principalRoles: (p: ResolvedPrincipal | null) => ({ primaryRole: p?.grantedScopes[0] ?? "anon" }),
    allowedRoles: new Set(["tenant_admin"]),
    onActivated: overrides.onActivated,
    summarize: (manifest: Record<string, unknown>) => ({ keys: Object.keys(manifest).sort() }),
  };
}

function principal(role: string | null, tenantId: string | null = TENANT): ResolvedPrincipal | null {
  if (role === null) return null;
  return {
    principalId: USER, tenantId, principalKind: "user", authScheme: "api_key_header",
    grantedScopes: [role], mfaProofAgeSeconds: null, resolvedAt: "2026-06-01T00:00:00.000Z",
  } as ResolvedPrincipal;
}

function input(
  role: string | null,
  opts: {
    body?: Record<string, unknown>;
    params?: Record<string, string>;
    query?: Record<string, string>;
    tenantId?: string | null;
  } = {},
): HandlerInput {
  return {
    request: { query: opts.query ?? {} } as never,
    route: {} as never,
    principal: principal(role, opts.tenantId === undefined ? TENANT : opts.tenantId),
    params: opts.params ?? {},
    parsedBody: opts.body ?? null,
  };
}

function findHandler(ctx: AiDesignContext, op: string): Handler {
  const found = buildAiDesignRoutes(ctx).find((r) => r.route.operationId === op);
  if (found === undefined) throw new Error(`no route ${op}`);
  return found.handler;
}

type JsonOut = HandlerOutput & { status: number; body: Record<string, unknown> };

async function design(ctx: AiDesignContext, body: Record<string, unknown>): Promise<JsonOut> {
  return (await findHandler(ctx, "ai.design")(input("tenant_admin", { body }))) as JsonOut;
}

async function draftId(ctx: AiDesignContext & { store: FakeStore }, description = "A CRM"): Promise<string> {
  const out = await design(ctx, { description });
  expect(out.status).toBe(201);
  return (out.body["proposal"] as { id: string }).id;
}

function pathOf(route: { pathSegments: readonly unknown[] }): string {
  return (route.pathSegments as ReadonlyArray<{ kind: string; value?: string; name?: string }>)
    .map((s) => (s.kind === "literal" ? String(s.value) : `:${String(s.name)}`))
    .join("/");
}

describe("ai-design-routes — route table", () => {
  it("builds exactly the five AI Architect routes with exact ids, methods, and paths", () => {
    const routes = buildAiDesignRoutes(makeCtx());
    expect(routes).toHaveLength(5);
    const table = routes.map((r) => [r.route.operationId, r.route.method, pathOf(r.route)]);
    expect(table).toEqual([
      ["ai.design", "POST", "v1/ai/design"],
      ["ai.manifests.list", "GET", "v1/ai/manifests"],
      ["ai.manifests.get", "GET", "v1/ai/manifests/:id"],
      ["ai.manifests.activate", "POST", "v1/ai/manifests/:id/activate"],
      ["ai.manifests.archive", "POST", "v1/ai/manifests/:id/archive"],
    ]);
  });
});

describe("ai-design-routes — auth gating", () => {
  it("401s an unauthenticated caller on every route", async () => {
    const ctx = makeCtx();
    for (const op of ["ai.design", "ai.manifests.list", "ai.manifests.get", "ai.manifests.activate", "ai.manifests.archive"]) {
      const out = (await findHandler(ctx, op)(input(null, { params: { id: "aim_0001" } }))) as JsonOut;
      expect(out.status).toBe(401);
      expect(out.body["error"]).toBe("authentication_required");
    }
  });

  it("403s a caller without an allowed role on every route", async () => {
    const ctx = makeCtx();
    for (const op of ["ai.design", "ai.manifests.list", "ai.manifests.get", "ai.manifests.activate", "ai.manifests.archive"]) {
      const out = (await findHandler(ctx, op)(input("cashier", { params: { id: "aim_0001" } }))) as JsonOut;
      expect(out.status).toBe(403);
      expect(out.body["error"]).toBe("forbidden");
    }
  });

  it("400s a tenantless principal on design", async () => {
    const ctx = makeCtx();
    const out = (await findHandler(ctx, "ai.design")(
      input("tenant_admin", { body: { description: "A CRM" }, tenantId: null }),
    )) as JsonOut;
    expect(out.status).toBe(400);
    expect(out.body["error"]).toBe("tenant_required");
  });

  it("400s a tenantless principal on list, get, activate, and archive", async () => {
    const ctx = makeCtx();
    for (const op of ["ai.manifests.list", "ai.manifests.get", "ai.manifests.activate", "ai.manifests.archive"]) {
      const out = (await findHandler(ctx, op)(
        input("tenant_admin", { params: { id: "aim_0001" }, tenantId: null }),
      )) as JsonOut;
      expect(out.status).toBe(400);
      expect(out.body["error"]).toBe("tenant_required");
    }
  });
});

describe("ai-design-routes — design", () => {
  it("503s when no designer is configured", async () => {
    const ctx = makeCtx({ designer: null });
    const out = await design(ctx, { description: "A CRM" });
    expect(out.status).toBe(503);
    expect(out.body).toEqual({ error: "ai_unavailable", detail: "no AI provider configured" });
  });

  it("400s a missing description", async () => {
    const out = await design(makeCtx(), {});
    expect(out.status).toBe(400);
    expect(out.body["error"]).toBe("invalid_request");
  });

  it("400s an oversized description", async () => {
    const out = await design(makeCtx(), { description: "x".repeat(4001) });
    expect(out.status).toBe(400);
    expect(out.body["error"]).toBe("invalid_request");
  });

  it("400s an oversized name", async () => {
    const out = await design(makeCtx(), { description: "A CRM", name: "n".repeat(201) });
    expect(out.status).toBe(400);
  });

  it("422s a failed design and passes issues + attempts through", async () => {
    const ctx = makeCtx({ designer: failDesigner(["entity Lead has no fields", "invalid slug"], 3) });
    const out = await design(ctx, { description: "A CRM" });
    expect(out.status).toBe(422);
    expect(out.body).toEqual({
      error: "design_failed",
      issues: ["entity Lead has no fields", "invalid slug"],
      attempts: 3,
    });
    expect(ctx.store.createCalls).toHaveLength(0);
  });

  it("201s a successful design, persists it tenant-scoped, and returns proposal + summary", async () => {
    const ctx = makeCtx();
    const out = await design(ctx, { description: "A CRM for plumbers", name: "Plumber CRM" });
    expect(out.status).toBe(201);
    expect(ctx.store.createCalls).toHaveLength(1);
    expect(ctx.store.createCalls[0]?.tenantId).toBe(TENANT);
    expect(ctx.store.createCalls[0]?.input).toEqual({
      name: "Plumber CRM",
      description: "A CRM for plumbers",
      manifest: OK_MANIFEST,
      manifestHash: "sha256:abc123",
      source: "ai",
      providerLabel: "anthropic/claude-sonnet-4-6",
    });
    const proposal = out.body["proposal"] as AiManifestRecordLike;
    expect(proposal.status).toBe("draft");
    expect(proposal.source).toBe("ai");
    expect(out.body["summary"]).toEqual({ keys: ["entities", "meta"] });
  });

  it("defaults the proposal name when none is given", async () => {
    const ctx = makeCtx();
    const out = await design(ctx, { description: "A CRM" });
    expect(out.status).toBe(201);
    expect((out.body["proposal"] as { name: string }).name).toBe(DEFAULT_PROPOSAL_NAME);
  });
});

describe("ai-design-routes — list", () => {
  it("lists only the caller tenant's proposals", async () => {
    const ctx = makeCtx();
    await draftId(ctx);
    await ctx.store.create(OTHER_TENANT, {
      name: "Other", description: "x", manifest: {}, manifestHash: "sha256:z", source: "manual",
    });
    const out = (await findHandler(ctx, "ai.manifests.list")(input("tenant_admin"))) as JsonOut;
    expect(out.status).toBe(200);
    const data = out.body["data"] as readonly AiManifestRecordLike[];
    expect(data).toHaveLength(1);
    expect(data[0]?.tenantId).toBe(TENANT);
  });

  it("filters by status", async () => {
    const ctx = makeCtx();
    const activateMe = await draftId(ctx);
    await draftId(ctx);
    await findHandler(ctx, "ai.manifests.activate")(input("tenant_admin", { params: { id: activateMe } }));
    const out = (await findHandler(ctx, "ai.manifests.list")(
      input("tenant_admin", { query: { status: "active" } }),
    )) as JsonOut;
    expect((out.body["data"] as readonly AiManifestRecordLike[]).map((r) => r.id)).toEqual([activateMe]);
  });

  it("ignores an unknown status value", async () => {
    const ctx = makeCtx();
    await draftId(ctx);
    const out = (await findHandler(ctx, "ai.manifests.list")(
      input("tenant_admin", { query: { status: "bogus" } }),
    )) as JsonOut;
    expect((out.body["data"] as unknown[])).toHaveLength(1);
  });

  it("paginates with limit + cursor", async () => {
    const ctx = makeCtx();
    for (let i = 0; i < 3; i += 1) await draftId(ctx);
    const first = (await findHandler(ctx, "ai.manifests.list")(
      input("tenant_admin", { query: { limit: "2" } }),
    )) as JsonOut;
    expect((first.body["data"] as unknown[])).toHaveLength(2);
    const cursor = (first.body["page"] as { nextCursor: string | null }).nextCursor;
    expect(cursor).not.toBeNull();
    const second = (await findHandler(ctx, "ai.manifests.list")(
      input("tenant_admin", { query: { limit: "2", cursor: cursor as string } }),
    )) as JsonOut;
    expect((second.body["data"] as unknown[])).toHaveLength(1);
    expect((second.body["page"] as { nextCursor: string | null }).nextCursor).toBeNull();
  });
});

describe("ai-design-routes — get", () => {
  it("200s an existing proposal with its summary", async () => {
    const ctx = makeCtx();
    const id = await draftId(ctx);
    const out = (await findHandler(ctx, "ai.manifests.get")(input("tenant_admin", { params: { id } }))) as JsonOut;
    expect(out.status).toBe(200);
    expect((out.body["proposal"] as { id: string }).id).toBe(id);
    expect(out.body["summary"]).toEqual({ keys: ["entities", "meta"] });
  });

  it("404s a missing proposal", async () => {
    const out = (await findHandler(makeCtx(), "ai.manifests.get")(
      input("tenant_admin", { params: { id: "aim_9999" } }),
    )) as JsonOut;
    expect(out.status).toBe(404);
    expect(out.body["error"]).toBe("proposal_not_found");
  });

  it("404s another tenant's proposal", async () => {
    const ctx = makeCtx();
    const other = await ctx.store.create(OTHER_TENANT, {
      name: "Other", description: "x", manifest: {}, manifestHash: "sha256:z", source: "manual",
    });
    const out = (await findHandler(ctx, "ai.manifests.get")(
      input("tenant_admin", { params: { id: other.id } }),
    )) as JsonOut;
    expect(out.status).toBe(404);
  });
});

describe("ai-design-routes — activate", () => {
  it("activates a draft and fires onActivated with the tenant", async () => {
    const activated: string[] = [];
    const ctx = makeCtx({ onActivated: (t) => activated.push(t) });
    const id = await draftId(ctx);
    const out = (await findHandler(ctx, "ai.manifests.activate")(
      input("tenant_admin", { params: { id } }),
    )) as JsonOut;
    expect(out.status).toBe(200);
    const proposal = out.body["proposal"] as AiManifestRecordLike;
    expect(proposal.status).toBe("active");
    expect(proposal.activatedAt).not.toBeNull();
    expect(activated).toEqual([TENANT]);
  });

  it("409s an already-active proposal and does not re-fire onActivated", async () => {
    const activated: string[] = [];
    const ctx = makeCtx({ onActivated: (t) => activated.push(t) });
    const id = await draftId(ctx);
    await findHandler(ctx, "ai.manifests.activate")(input("tenant_admin", { params: { id } }));
    const again = (await findHandler(ctx, "ai.manifests.activate")(
      input("tenant_admin", { params: { id } }),
    )) as JsonOut;
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ error: "illegal_transition", detail: "active -> active" });
    expect(activated).toEqual([TENANT]);
  });

  it("404s activating a missing proposal", async () => {
    const out = (await findHandler(makeCtx(), "ai.manifests.activate")(
      input("tenant_admin", { params: { id: "aim_9999" } }),
    )) as JsonOut;
    expect(out.status).toBe(404);
  });

  it("404s activating another tenant's proposal", async () => {
    const ctx = makeCtx();
    const other = await ctx.store.create(OTHER_TENANT, {
      name: "Other", description: "x", manifest: {}, manifestHash: "sha256:z", source: "manual",
    });
    const out = (await findHandler(ctx, "ai.manifests.activate")(
      input("tenant_admin", { params: { id: other.id } }),
    )) as JsonOut;
    expect(out.status).toBe(404);
  });
});

describe("ai-design-routes — archive", () => {
  it("archives a draft proposal", async () => {
    const ctx = makeCtx();
    const id = await draftId(ctx);
    const out = (await findHandler(ctx, "ai.manifests.archive")(
      input("tenant_admin", { params: { id } }),
    )) as JsonOut;
    expect(out.status).toBe(200);
    expect((out.body["proposal"] as { status: string }).status).toBe("archived");
  });

  it("409s an already-archived proposal", async () => {
    const ctx = makeCtx();
    const id = await draftId(ctx);
    await findHandler(ctx, "ai.manifests.archive")(input("tenant_admin", { params: { id } }));
    const again = (await findHandler(ctx, "ai.manifests.archive")(
      input("tenant_admin", { params: { id } }),
    )) as JsonOut;
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ error: "illegal_transition", detail: "archived -> archived" });
  });

  it("404s archiving a missing proposal", async () => {
    const out = (await findHandler(makeCtx(), "ai.manifests.archive")(
      input("tenant_admin", { params: { id: "aim_9999" } }),
    )) as JsonOut;
    expect(out.status).toBe(404);
  });
});
