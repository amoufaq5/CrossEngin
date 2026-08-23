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
import type {
  ManifestProjector,
  ManifestViewLike,
  ReviewStatusLike,
} from "./design-review-routes.js";
import {
  DESIGN_JOB_MAX_ATTEMPTS,
  type DesignJobCreateInput,
  type DesignJobProgressInput,
  type DesignJobRecordLike,
  type DesignJobStoreLike,
} from "./design-runner.js";

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

class FakeJobStore implements DesignJobStoreLike {
  readonly records = new Map<string, DesignJobRecordLike>();
  readonly createCalls: Array<{ tenantId: string; input: DesignJobCreateInput }> = [];
  private seq = 0;

  async create(tenantId: string, input: DesignJobCreateInput): Promise<DesignJobRecordLike> {
    this.createCalls.push({ tenantId, input });
    this.seq += 1;
    const at = new Date(Date.UTC(2026, 5, 1) + this.seq * 1000).toISOString();
    const record: DesignJobRecordLike = {
      id: `adj_${String(this.seq).padStart(4, "0")}`,
      tenantId,
      status: "queued",
      phase: "queued",
      attempt: 0,
      maxAttempts: input.maxAttempts,
      name: input.name,
      description: input.description,
      outputChars: 0,
      issues: [],
      proposalId: null,
      providerLabel: null,
      error: null,
      createdAt: at,
      updatedAt: at,
    };
    this.records.set(record.id, record);
    return record;
  }

  async getById(tenantId: string, id: string): Promise<DesignJobRecordLike | null> {
    const record = this.records.get(id);
    if (record === undefined || record.tenantId !== tenantId) return null;
    return record;
  }

  private async patch(
    tenantId: string,
    id: string,
    patch: Partial<DesignJobRecordLike>,
  ): Promise<DesignJobRecordLike | null> {
    const record = await this.getById(tenantId, id);
    if (record === null) return null;
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const next: DesignJobRecordLike = { ...record, ...defined, updatedAt: new Date().toISOString() };
    this.records.set(id, next);
    return next;
  }

  async updateProgress(
    tenantId: string,
    id: string,
    input: DesignJobProgressInput,
  ): Promise<DesignJobRecordLike | null> {
    return this.patch(tenantId, id, {
      status: input.status,
      phase: input.phase,
      attempt: input.attempt,
      outputChars: input.outputChars,
      issues: input.issues,
    });
  }

  async succeed(
    tenantId: string,
    id: string,
    input: { proposalId: string; providerLabel: string | null },
  ): Promise<DesignJobRecordLike | null> {
    return this.patch(tenantId, id, {
      status: "succeeded",
      phase: "done",
      proposalId: input.proposalId,
      providerLabel: input.providerLabel,
    });
  }

  async fail(
    tenantId: string,
    id: string,
    input: { error: string; issues?: readonly string[]; providerLabel?: string | null },
  ): Promise<DesignJobRecordLike | null> {
    return this.patch(tenantId, id, {
      status: "failed",
      phase: "error",
      error: input.error,
      issues: input.issues ?? [],
      providerLabel: input.providerLabel ?? null,
    });
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

const ALL_OPS = [
  "ai.design",
  "ai.design.jobs.create",
  "ai.design.jobs.get",
  "ai.manifests.list",
  "ai.manifests.get",
  "ai.manifests.activate",
  "ai.manifests.archive",
] as const;

interface StartedJob {
  readonly tenantId: string;
  readonly jobId: string;
  readonly input: { description: string; name: string };
}

interface JobCtx {
  readonly ctx: AiDesignContext & { store: FakeStore; jobs: FakeJobStore };
  readonly jobs: FakeJobStore;
  readonly started: StartedJob[];
}

function makeJobCtx(overrides: CtxOverrides = {}): JobCtx {
  const jobs = new FakeJobStore();
  const started: StartedJob[] = [];
  const ctx = {
    ...makeCtx(overrides),
    jobs,
    startJob: (tenantId: string, jobId: string, input: { description: string; name: string }): void => {
      started.push({ tenantId, jobId, input });
    },
  };
  return { ctx, jobs, started };
}

function pathOf(route: { pathSegments: readonly unknown[] }): string {
  return (route.pathSegments as ReadonlyArray<{ kind: string; value?: string; name?: string }>)
    .map((s) => (s.kind === "literal" ? String(s.value) : `:${String(s.name)}`))
    .join("/");
}

describe("ai-design-routes — route table", () => {
  it("builds exactly the seven AI Architect routes with exact ids, methods, and paths", () => {
    const routes = buildAiDesignRoutes(makeCtx());
    expect(routes).toHaveLength(7);
    const table = routes.map((r) => [r.route.operationId, r.route.method, pathOf(r.route)]);
    expect(table).toEqual([
      ["ai.design", "POST", "v1/ai/design"],
      ["ai.design.jobs.create", "POST", "v1/ai/design/jobs"],
      ["ai.design.jobs.get", "GET", "v1/ai/design/jobs/:id"],
      ["ai.manifests.list", "GET", "v1/ai/manifests"],
      ["ai.manifests.get", "GET", "v1/ai/manifests/:id"],
      ["ai.manifests.activate", "POST", "v1/ai/manifests/:id/activate"],
      ["ai.manifests.archive", "POST", "v1/ai/manifests/:id/archive"],
    ]);
  });

  it("keeps the route table stable when async mode is not wired", () => {
    expect(buildAiDesignRoutes(makeCtx())).toHaveLength(7);
    expect(buildAiDesignRoutes(makeJobCtx().ctx)).toHaveLength(7);
  });
});

describe("ai-design-routes — auth gating", () => {
  it("401s an unauthenticated caller on every route", async () => {
    const ctx = makeCtx();
    for (const op of ALL_OPS) {
      const out = (await findHandler(ctx, op)(input(null, { params: { id: "aim_0001" } }))) as JsonOut;
      expect(out.status).toBe(401);
      expect(out.body["error"]).toBe("authentication_required");
    }
  });

  it("403s a caller without an allowed role on every route", async () => {
    const ctx = makeCtx();
    for (const op of ALL_OPS) {
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

  it("400s a tenantless principal on list, get, activate, archive, and the job routes", async () => {
    const ctx = makeCtx();
    for (const op of [
      "ai.manifests.list",
      "ai.manifests.get",
      "ai.manifests.activate",
      "ai.manifests.archive",
      "ai.design.jobs.create",
      "ai.design.jobs.get",
    ]) {
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

describe("ai-design-routes — activation review gate", () => {
  interface GateHarness {
    readonly ctx: AiDesignContext & { store: FakeStore };
    readonly calls: Array<{ tenantId: string; id: string }>;
  }

  function withGate(status: ReviewStatusLike | null, activated: string[] = []): GateHarness {
    const calls: Array<{ tenantId: string; id: string }> = [];
    const ctx = {
      ...makeCtx({ onActivated: (t: string) => activated.push(t) }),
      reviewGate: {
        reviewStatusFor: async (tenantId: string, id: string): Promise<ReviewStatusLike | null> => {
          calls.push({ tenantId, id });
          return status;
        },
      },
    };
    return { ctx, calls };
  }

  async function activate(ctx: AiDesignContext, id: string): Promise<JsonOut> {
    return (await findHandler(ctx, "ai.manifests.activate")(
      input("tenant_admin", { params: { id } }),
    )) as JsonOut;
  }

  it("activates without consulting any gate when none is configured", async () => {
    const ctx = makeCtx();
    const id = await draftId(ctx);
    const out = await activate(ctx, id);
    expect(out.status).toBe(200);
    expect((out.body["proposal"] as AiManifestRecordLike).status).toBe("active");
  });

  it("200s when the gate reports approved, passing the tenant + proposal id", async () => {
    const { ctx, calls } = withGate("approved");
    const id = await draftId(ctx);
    const out = await activate(ctx, id);
    expect(out.status).toBe(200);
    expect((out.body["proposal"] as AiManifestRecordLike).status).toBe("active");
    expect(calls).toEqual([{ tenantId: TENANT, id }]);
  });

  it("403s review_required for every non-approved status and echoes it back", async () => {
    for (const status of ["pending", "rejected", "not_required"] as const) {
      const activated: string[] = [];
      const { ctx } = withGate(status, activated);
      const id = await draftId(ctx);
      const out = await activate(ctx, id);
      expect(out.status).toBe(403);
      expect(out.body).toEqual({
        error: "review_required",
        detail: "this proposal must be approved by a platform reviewer before activation",
        reviewStatus: status,
      });
      expect(ctx.store.records.get(id)?.status).toBe("draft");
      expect(activated).toEqual([]);
    }
  });

  it("403s when the gate resolves nothing — a vanished review is not an approval", async () => {
    const { ctx } = withGate(null);
    const id = await draftId(ctx);
    const out = await activate(ctx, id);
    expect(out.status).toBe(403);
    expect(out.body["error"]).toBe("review_required");
    expect(out.body["reviewStatus"]).toBeNull();
  });

  it("does not consult the gate for a missing proposal — the 404 check runs first", async () => {
    const { ctx, calls } = withGate("approved");
    const out = await activate(ctx, "aim_9999");
    expect(out.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("does not consult the gate for an already-active proposal — the 409 check runs first", async () => {
    const { ctx, calls } = withGate("approved");
    const id = await draftId(ctx);
    expect((await activate(ctx, id)).status).toBe(200);
    expect(calls).toHaveLength(1);
    const again = await activate(ctx, id);
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ error: "illegal_transition", detail: "active -> active" });
    expect(calls).toHaveLength(1);
  });

  it("does not consult the gate before the auth guard", async () => {
    const { ctx, calls } = withGate("approved");
    const id = await draftId(ctx);
    const unauth = (await findHandler(ctx, "ai.manifests.activate")(
      input(null, { params: { id } }),
    )) as JsonOut;
    expect(unauth.status).toBe(401);
    const forbidden = (await findHandler(ctx, "ai.manifests.activate")(
      input("cashier", { params: { id } }),
    )) as JsonOut;
    expect(forbidden.status).toBe(403);
    expect(forbidden.body["error"]).toBe("forbidden");
    expect(calls).toHaveLength(0);
  });

  it("leaves archive ungated — only activation goes through platform review", async () => {
    const { ctx, calls } = withGate("pending");
    const id = await draftId(ctx);
    const out = (await findHandler(ctx, "ai.manifests.archive")(
      input("tenant_admin", { params: { id } }),
    )) as JsonOut;
    expect(out.status).toBe(200);
    expect(calls).toHaveLength(0);
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

describe("ai-design routes — spend ceiling", () => {
  function withBudget(allowed: boolean): {
    ctx: AiDesignContext & { store: FakeStore };
    recorded: { tenantId: string; costUsd: number }[];
    designCalls: () => number;
  } {
    const recorded: { tenantId: string; costUsd: number }[] = [];
    let calls = 0;
    const base = makeCtx({
      designer: async (i) => {
        calls += 1;
        return okDesigner()(i);
      },
    });
    const ctx = {
      ...base,
      budget: {
        check: async () => ({ allowed, spentUsd: allowed ? 1 : 30, limitUsd: 25 }),
        record: async (tenantId: string, costUsd: number) => {
          recorded.push({ tenantId, costUsd });
          return costUsd;
        },
      },
    };
    return { ctx, recorded, designCalls: () => calls };
  }

  it("denies with 402 and never calls the designer when the budget is exhausted", async () => {
    const { ctx, recorded, designCalls } = withBudget(false);
    const out = await design(ctx, { description: "a coffee shop" });
    expect(out.status).toBe(402);
    expect(out.body["error"]).toBe("ai_budget_exceeded");
    expect(out.body["limitUsd"]).toBe(25);
    expect(designCalls()).toBe(0);
    expect(recorded).toHaveLength(0);
  });

  it("allows under budget and records the actual usage cost", async () => {
    const { ctx, recorded, designCalls } = withBudget(true);
    const out = await design(ctx, { description: "a coffee shop" });
    expect(out.status).toBe(201);
    expect(designCalls()).toBe(1);
    expect(recorded).toEqual([{ tenantId: TENANT, costUsd: 0.0123 }]);
  });

  it("charges a failed design too — the tokens were still spent", async () => {
    const recorded: { tenantId: string; costUsd: number }[] = [];
    const base = makeCtx({
      designer: async () => ({
        ok: false, manifest: null, manifestHash: null, issues: ["nope"], attempts: 3,
        providerLabel: "openai/gpt-4o", usage: { inputTokens: 5, outputTokens: 5, cost: 0.02 },
      }),
    });
    const ctx = {
      ...base,
      budget: {
        check: async () => ({ allowed: true, spentUsd: 0, limitUsd: 25 }),
        record: async (tenantId: string, costUsd: number) => {
          recorded.push({ tenantId, costUsd });
          return costUsd;
        },
      },
    };
    const out = await design(ctx, { description: "a coffee shop" });
    expect(out.status).toBe(422);
    expect(recorded).toEqual([{ tenantId: TENANT, costUsd: 0.02 }]);
  });

  it("is a no-op when no budget is configured", async () => {
    const out = await design(makeCtx(), { description: "a coffee shop" });
    expect(out.status).toBe(201);
  });
});

async function createJob(ctx: AiDesignContext, body: Record<string, unknown>): Promise<JsonOut> {
  return (await findHandler(ctx, "ai.design.jobs.create")(input("tenant_admin", { body }))) as JsonOut;
}

async function getJob(ctx: AiDesignContext, id: string): Promise<JsonOut> {
  return (await findHandler(ctx, "ai.design.jobs.get")(input("tenant_admin", { params: { id } }))) as JsonOut;
}

describe("ai-design-routes — async job create", () => {
  it("202s, persists a queued job, and hands it to the runner", async () => {
    const { ctx, jobs, started } = makeJobCtx();
    const out = await createJob(ctx, { description: "A CRM for plumbers", name: "Plumber CRM" });
    expect(out.status).toBe(202);
    const job = out.body["job"] as DesignJobRecordLike;
    expect(job.status).toBe("queued");
    expect(job.phase).toBe("queued");
    expect(job.tenantId).toBe(TENANT);
    expect(jobs.createCalls).toEqual([
      {
        tenantId: TENANT,
        input: {
          name: "Plumber CRM",
          description: "A CRM for plumbers",
          maxAttempts: DESIGN_JOB_MAX_ATTEMPTS,
        },
      },
    ]);
    expect(started).toEqual([
      { tenantId: TENANT, jobId: job.id, input: { description: "A CRM for plumbers", name: "Plumber CRM" } },
    ]);
  });

  it("defaults the job name and passes the same default to the runner", async () => {
    const { ctx, started } = makeJobCtx();
    const out = await createJob(ctx, { description: "A CRM" });
    expect((out.body["job"] as DesignJobRecordLike).name).toBe(DEFAULT_PROPOSAL_NAME);
    expect(started[0]?.input.name).toBe(DEFAULT_PROPOSAL_NAME);
  });

  it("does not call the synchronous designer — the runner owns that", async () => {
    let calls = 0;
    const { ctx } = makeJobCtx({
      designer: async (i) => {
        calls += 1;
        return okDesigner()(i);
      },
    });
    await createJob(ctx, { description: "A CRM" });
    expect(calls).toBe(0);
  });

  it("400s an invalid body without creating a job", async () => {
    const { ctx, jobs, started } = makeJobCtx();
    const missing = await createJob(ctx, {});
    const oversized = await createJob(ctx, { description: "x".repeat(4001) });
    expect(missing.status).toBe(400);
    expect(missing.body["error"]).toBe("invalid_request");
    expect(oversized.status).toBe(400);
    expect(jobs.createCalls).toHaveLength(0);
    expect(started).toHaveLength(0);
  });

  it("503s ai_unavailable when no designer is configured", async () => {
    const { ctx, jobs, started } = makeJobCtx({ designer: null });
    const out = await createJob(ctx, { description: "A CRM" });
    expect(out.status).toBe(503);
    expect(out.body).toEqual({ error: "ai_unavailable", detail: "no AI provider configured" });
    expect(jobs.createCalls).toHaveLength(0);
    expect(started).toHaveLength(0);
  });

  it("503s async_unavailable when the job store or the runner hook is missing", async () => {
    const bare = makeCtx();
    const jobsOnly = { ...makeCtx(), jobs: new FakeJobStore() };
    const startOnly = { ...makeCtx(), startJob: (): void => undefined };
    for (const ctx of [bare, jobsOnly, startOnly]) {
      const out = await createJob(ctx, { description: "A CRM" });
      expect(out.status).toBe(503);
      expect(out.body["error"]).toBe("async_unavailable");
    }
  });

  it("402s an exhausted budget and never enqueues the job", async () => {
    const { ctx: base, jobs, started } = makeJobCtx();
    const ctx = {
      ...base,
      budget: {
        check: async () => ({ allowed: false, spentUsd: 30, limitUsd: 25 }),
        record: async (_t: string, c: number) => c,
      },
    };
    const out = await createJob(ctx, { description: "A CRM" });
    expect(out.status).toBe(402);
    expect(out.body["error"]).toBe("ai_budget_exceeded");
    expect(out.body["limitUsd"]).toBe(25);
    expect(jobs.createCalls).toHaveLength(0);
    expect(started).toHaveLength(0);
  });

  it("202s when the budget allows", async () => {
    const { ctx: base, started } = makeJobCtx();
    const ctx = {
      ...base,
      budget: {
        check: async () => ({ allowed: true, spentUsd: 1, limitUsd: 25 }),
        record: async (_t: string, c: number) => c,
      },
    };
    const out = await createJob(ctx, { description: "A CRM" });
    expect(out.status).toBe(202);
    expect(started).toHaveLength(1);
  });
});

describe("ai-design-routes — async job get", () => {
  it("200s a running job with its live progress", async () => {
    const { ctx, jobs } = makeJobCtx();
    const created = await createJob(ctx, { description: "A CRM" });
    const id = (created.body["job"] as DesignJobRecordLike).id;
    await jobs.updateProgress(TENANT, id, {
      status: "running",
      phase: "validating",
      attempt: 2,
      outputChars: 4096,
      issues: ["entity Lead has no fields"],
    });
    const out = await getJob(ctx, id);
    expect(out.status).toBe(200);
    const job = out.body["job"] as DesignJobRecordLike;
    expect(job.status).toBe("running");
    expect(job.phase).toBe("validating");
    expect(job.attempt).toBe(2);
    expect(job.outputChars).toBe(4096);
    expect(job.issues).toEqual(["entity Lead has no fields"]);
    expect(out.body["proposal"]).toBeUndefined();
  });

  it("404s an unknown job", async () => {
    const { ctx } = makeJobCtx();
    const out = await getJob(ctx, "adj_9999");
    expect(out.status).toBe(404);
    expect(out.body["error"]).toBe("job_not_found");
  });

  it("404s another tenant's job", async () => {
    const { ctx, jobs } = makeJobCtx();
    const other = await jobs.create(OTHER_TENANT, {
      name: "Other", description: "x", maxAttempts: DESIGN_JOB_MAX_ATTEMPTS,
    });
    const out = await getJob(ctx, other.id);
    expect(out.status).toBe(404);
  });

  it("includes the proposal and its summary once the job succeeds", async () => {
    const { ctx, jobs } = makeJobCtx();
    const proposalId = await draftId(ctx);
    const created = await createJob(ctx, { description: "A CRM" });
    const id = (created.body["job"] as DesignJobRecordLike).id;
    await jobs.succeed(TENANT, id, { proposalId, providerLabel: "anthropic/claude-sonnet-4-6" });
    const out = await getJob(ctx, id);
    expect(out.status).toBe(200);
    expect((out.body["job"] as DesignJobRecordLike).status).toBe("succeeded");
    expect((out.body["proposal"] as AiManifestRecordLike).id).toBe(proposalId);
    expect(out.body["summary"]).toEqual({ keys: ["entities", "meta"] });
  });

  it("200s a succeeded job whose proposal was since deleted", async () => {
    const { ctx, jobs } = makeJobCtx();
    const proposalId = await draftId(ctx);
    const created = await createJob(ctx, { description: "A CRM" });
    const id = (created.body["job"] as DesignJobRecordLike).id;
    await jobs.succeed(TENANT, id, { proposalId, providerLabel: null });
    ctx.store.records.delete(proposalId);
    const out = await getJob(ctx, id);
    expect(out.status).toBe(200);
    expect(out.body["proposal"]).toBeNull();
    expect(out.body["summary"]).toBeNull();
  });

  it("200s a failed job with its error and issues, and no proposal lookup", async () => {
    const { ctx, jobs } = makeJobCtx();
    const created = await createJob(ctx, { description: "A CRM" });
    const id = (created.body["job"] as DesignJobRecordLike).id;
    await jobs.fail(TENANT, id, { error: "design failed after 3 attempts", issues: ["invalid slug"] });
    const out = await getJob(ctx, id);
    expect(out.status).toBe(200);
    const job = out.body["job"] as DesignJobRecordLike;
    expect(job.status).toBe("failed");
    expect(job.phase).toBe("error");
    expect(job.error).toBe("design failed after 3 attempts");
    expect(out.body).not.toHaveProperty("proposal");
  });

  it("503s async_unavailable when no job store is wired", async () => {
    const out = await getJob(makeCtx(), "adj_0001");
    expect(out.status).toBe(503);
    expect(out.body["error"]).toBe("async_unavailable");
  });
});

const STUB_VIEW: ManifestViewLike = {
  meta: { name: "Acme CRM", slug: "acme/crm", version: "1.0.0", description: null },
  entities: [],
  relations: [],
  roles: [],
  counts: { entities: 1, fields: 0, roles: 0, relations: 0, sensitiveFields: 0, lifecycles: 0 },
};

interface ProjectorStub {
  readonly project: ManifestProjector;
  readonly calls: Record<string, unknown>[];
}

function recordingProjector(): ProjectorStub {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    project: (manifest: Record<string, unknown>): ManifestViewLike => {
      calls.push(manifest);
      return STUB_VIEW;
    },
  };
}

describe("ai-design-routes — schema projection", () => {
  it("includes the projected schema on proposal get, built from the proposal's manifest", async () => {
    const projector = recordingProjector();
    const ctx = { ...makeCtx(), projectSchema: projector.project };
    const id = await draftId(ctx);
    const out = (await findHandler(ctx, "ai.manifests.get")(
      input("tenant_admin", { params: { id } }),
    )) as JsonOut;
    expect(out.status).toBe(200);
    expect(projector.calls).toEqual([OK_MANIFEST]);
    expect(out.body["schema"]).toBe(STUB_VIEW);
    expect(out.body["summary"]).toEqual({ keys: ["entities", "meta"] });
    expect(Object.keys(out.body).sort()).toEqual(["proposal", "schema", "summary"]);
  });

  it("omits the schema key on proposal get when no projector is configured", async () => {
    const ctx = makeCtx();
    const id = await draftId(ctx);
    const out = (await findHandler(ctx, "ai.manifests.get")(
      input("tenant_admin", { params: { id } }),
    )) as JsonOut;
    expect(out.status).toBe(200);
    expect("schema" in out.body).toBe(false);
    expect(Object.keys(out.body).sort()).toEqual(["proposal", "summary"]);
  });

  it("does not project for a missing proposal or behind a guard denial", async () => {
    const projector = recordingProjector();
    const ctx = { ...makeCtx(), projectSchema: projector.project };
    const id = await draftId(ctx);
    const missing = (await findHandler(ctx, "ai.manifests.get")(
      input("tenant_admin", { params: { id: "aim_9999" } }),
    )) as JsonOut;
    expect(missing.status).toBe(404);
    const unauth = (await findHandler(ctx, "ai.manifests.get")(
      input(null, { params: { id } }),
    )) as JsonOut;
    expect(unauth.status).toBe(401);
    const forbidden = (await findHandler(ctx, "ai.manifests.get")(
      input("cashier", { params: { id } }),
    )) as JsonOut;
    expect(forbidden.status).toBe(403);
    expect(projector.calls).toHaveLength(0);
  });

  it("includes the schema on a succeeded job get alongside job + proposal + summary", async () => {
    const projector = recordingProjector();
    const { ctx: base, jobs } = makeJobCtx();
    const ctx = { ...base, projectSchema: projector.project };
    const proposalId = await draftId(ctx);
    const created = await createJob(ctx, { description: "A CRM" });
    const jobId = (created.body["job"] as DesignJobRecordLike).id;
    await jobs.succeed(TENANT, jobId, { proposalId, providerLabel: null });
    const out = await getJob(ctx, jobId);
    expect(out.status).toBe(200);
    expect((out.body["proposal"] as AiManifestRecordLike).id).toBe(proposalId);
    expect(out.body["summary"]).toEqual({ keys: ["entities", "meta"] });
    expect(out.body["schema"]).toBe(STUB_VIEW);
    expect(projector.calls).toEqual([OK_MANIFEST]);
  });

  it("omits the schema on a succeeded job whose proposal is gone", async () => {
    const projector = recordingProjector();
    const { ctx: base, jobs } = makeJobCtx();
    const ctx = { ...base, projectSchema: projector.project };
    const proposalId = await draftId(ctx);
    const created = await createJob(ctx, { description: "A CRM" });
    const jobId = (created.body["job"] as DesignJobRecordLike).id;
    await jobs.succeed(TENANT, jobId, { proposalId, providerLabel: null });
    ctx.store.records.delete(proposalId);
    const out = await getJob(ctx, jobId);
    expect(out.status).toBe(200);
    expect(out.body["proposal"]).toBeNull();
    expect(out.body["summary"]).toBeNull();
    expect("schema" in out.body).toBe(false);
    expect(projector.calls).toHaveLength(0);
  });

  it("omits the schema on a job that has not succeeded", async () => {
    const projector = recordingProjector();
    const { ctx: base, jobs } = makeJobCtx();
    const ctx = { ...base, projectSchema: projector.project };
    const created = await createJob(ctx, { description: "A CRM" });
    const jobId = (created.body["job"] as DesignJobRecordLike).id;
    await jobs.fail(TENANT, jobId, { error: "design failed after 3 attempts" });
    const out = await getJob(ctx, jobId);
    expect(out.status).toBe(200);
    expect(Object.keys(out.body)).toEqual(["job"]);
    expect(projector.calls).toHaveLength(0);
  });

  it("leaves the synchronous design 201 response unchanged — no schema", async () => {
    const projector = recordingProjector();
    const ctx = { ...makeCtx(), projectSchema: projector.project };
    const out = await design(ctx, { description: "A CRM" });
    expect(out.status).toBe(201);
    expect(Object.keys(out.body).sort()).toEqual(["proposal", "summary"]);
    expect(projector.calls).toHaveLength(0);
  });

  it("leaves list, activate, and archive free of a schema", async () => {
    const projector = recordingProjector();
    const ctx = { ...makeCtx(), projectSchema: projector.project };
    const id = await draftId(ctx);
    const list = (await findHandler(ctx, "ai.manifests.list")(input("tenant_admin"))) as JsonOut;
    expect(Object.keys(list.body).sort()).toEqual(["data", "page"]);
    const activated = (await findHandler(ctx, "ai.manifests.activate")(
      input("tenant_admin", { params: { id } }),
    )) as JsonOut;
    expect(Object.keys(activated.body)).toEqual(["proposal"]);
    const archived = (await findHandler(ctx, "ai.manifests.archive")(
      input("tenant_admin", { params: { id } }),
    )) as JsonOut;
    expect(Object.keys(archived.body)).toEqual(["proposal"]);
    expect(projector.calls).toHaveLength(0);
  });
});
