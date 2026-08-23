import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import type { Handler, HandlerInput, HandlerOutput } from "@crossengin/api-gateway-runtime";
import { describe, expect, it } from "vitest";

import {
  buildDesignReviewRoutes,
  type DesignReviewContext,
  type DesignReviewCountsLike,
  type DesignReviewDecisionInput,
  type DesignReviewListPageLike,
  type DesignReviewListQueryLike,
  type DesignReviewRecordLike,
  type DesignReviewStoreLike,
  type ManifestProjector,
  type ManifestViewLike,
  type ReviewStatusLike,
  type RiskReportLike,
} from "./design-review-routes.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const OTHER_TENANT = "00000000-0000-4000-8000-000000000002";
const REVIEWER = "00000000-0000-4000-8000-0000000000aa";

const MANIFEST: Record<string, unknown> = {
  meta: { slug: "acme/crm" },
  entities: [{ name: "Lead" }, { name: "Deal" }],
};

class FakeReviewStore implements DesignReviewStoreLike {
  readonly records = new Map<string, DesignReviewRecordLike>();
  readonly listCalls: DesignReviewListQueryLike[] = [];
  readonly approveCalls: Array<{ id: string; input: DesignReviewDecisionInput }> = [];
  readonly rejectCalls: Array<{ id: string; input: DesignReviewDecisionInput }> = [];
  private seq = 0;

  seed(overrides: Partial<DesignReviewRecordLike> = {}): DesignReviewRecordLike {
    this.seq += 1;
    const at = new Date(Date.UTC(2026, 5, 1) + this.seq * 1000).toISOString();
    const record: DesignReviewRecordLike = {
      id: `aim_${String(this.seq).padStart(4, "0")}`,
      tenantId: TENANT,
      name: "Plumber CRM",
      description: "A CRM for plumbers",
      manifest: MANIFEST,
      manifestHash: "sha256:abc123",
      status: "draft",
      reviewStatus: "pending",
      reviewedBy: null,
      reviewedAt: null,
      reviewNotes: null,
      providerLabel: "anthropic/claude-sonnet-4-6",
      createdAt: at,
      updatedAt: at,
      ...overrides,
    };
    this.records.set(record.id, record);
    return record;
  }

  async list(query: DesignReviewListQueryLike = {}): Promise<DesignReviewListPageLike> {
    this.listCalls.push(query);
    let visible = [...this.records.values()];
    if (query.reviewStatus !== undefined) {
      visible = visible.filter((r) => r.reviewStatus === query.reviewStatus);
    }
    if (query.tenantId !== undefined) visible = visible.filter((r) => r.tenantId === query.tenantId);
    visible.sort((a, b) => a.id.localeCompare(b.id));
    const limit = query.limit ?? 50;
    const offset = query.cursor === undefined ? 0 : Number.parseInt(query.cursor, 10);
    const page = visible.slice(offset, offset + limit);
    const nextCursor = offset + limit < visible.length ? String(offset + limit) : null;
    return { data: page, nextCursor };
  }

  async getById(id: string): Promise<DesignReviewRecordLike | null> {
    return this.records.get(id) ?? null;
  }

  async counts(): Promise<DesignReviewCountsLike> {
    const tally: DesignReviewCountsLike = {
      pending: 0,
      approved: 0,
      rejected: 0,
      notRequired: 0,
      total: 0,
    };
    const mutable = { ...tally };
    for (const r of this.records.values()) {
      if (r.reviewStatus === "not_required") mutable.notRequired += 1;
      else mutable[r.reviewStatus] += 1;
      mutable.total += 1;
    }
    return mutable;
  }

  private decide(
    id: string,
    reviewStatus: ReviewStatusLike,
    input: DesignReviewDecisionInput,
  ): DesignReviewRecordLike | null {
    const record = this.records.get(id);
    if (record === undefined) return null;
    const next: DesignReviewRecordLike = {
      ...record,
      reviewStatus,
      reviewedBy: input.reviewedBy,
      reviewedAt: "2026-06-02T00:00:00.000Z",
      reviewNotes: input.notes ?? null,
      updatedAt: "2026-06-02T00:00:00.000Z",
    };
    this.records.set(id, next);
    return next;
  }

  async approve(id: string, input: DesignReviewDecisionInput): Promise<DesignReviewRecordLike | null> {
    this.approveCalls.push({ id, input });
    return this.decide(id, "approved", input);
  }

  async reject(id: string, input: DesignReviewDecisionInput): Promise<DesignReviewRecordLike | null> {
    this.rejectCalls.push({ id, input });
    return this.decide(id, "rejected", input);
  }
}

function riskOf(manifest: Record<string, unknown>): RiskReportLike {
  const entities = Array.isArray(manifest["entities"]) ? (manifest["entities"] as unknown[]).length : 0;
  return {
    level: entities > 5 ? "high" : "low",
    findings: [],
    counts: { entities, fields: 0, roles: 0, relations: 0, sensitiveFields: 0 },
  };
}

interface Harness {
  readonly ctx: DesignReviewContext & { store: FakeReviewStore };
  readonly store: FakeReviewStore;
  readonly riskCalls: Record<string, unknown>[];
}

function makeCtx(): Harness {
  const store = new FakeReviewStore();
  const riskCalls: Record<string, unknown>[] = [];
  const ctx = {
    store,
    principalRoles: (p: ResolvedPrincipal | null) => ({ primaryRole: p?.grantedScopes[0] ?? "anon" }),
    adminRoles: new Set(["platform_admin"]),
    assessRisk: (manifest: Record<string, unknown>): RiskReportLike => {
      riskCalls.push(manifest);
      return riskOf(manifest);
    },
  };
  return { ctx, store, riskCalls };
}

function principal(role: string | null): ResolvedPrincipal | null {
  if (role === null) return null;
  return {
    principalId: REVIEWER, tenantId: TENANT, principalKind: "user", authScheme: "api_key_header",
    grantedScopes: [role], mfaProofAgeSeconds: null, resolvedAt: "2026-06-01T00:00:00.000Z",
  } as ResolvedPrincipal;
}

function input(
  role: string | null,
  opts: {
    body?: Record<string, unknown>;
    params?: Record<string, string>;
    query?: Record<string, string>;
  } = {},
): HandlerInput {
  return {
    request: { query: opts.query ?? {} } as never,
    route: {} as never,
    principal: principal(role),
    params: opts.params ?? {},
    parsedBody: opts.body ?? null,
  };
}

function findHandler(ctx: DesignReviewContext, op: string): Handler {
  const found = buildDesignReviewRoutes(ctx).find((r) => r.route.operationId === op);
  if (found === undefined) throw new Error(`no route ${op}`);
  return found.handler;
}

type JsonOut = HandlerOutput & { status: number; body: Record<string, unknown> };

async function call(
  ctx: DesignReviewContext,
  op: string,
  opts: Parameters<typeof input>[1] = {},
  role: string | null = "platform_admin",
): Promise<JsonOut> {
  return (await findHandler(ctx, op)(input(role, opts))) as JsonOut;
}

const ALL_OPS = [
  "platform.designReviews.list",
  "platform.designReviews.stats",
  "platform.designReviews.get",
  "platform.designReviews.approve",
  "platform.designReviews.reject",
] as const;

function pathOf(route: { pathSegments: readonly unknown[] }): string {
  return (route.pathSegments as ReadonlyArray<{ kind: string; value?: string; name?: string }>)
    .map((s) => (s.kind === "literal" ? String(s.value) : `:${String(s.name)}`))
    .join("/");
}

describe("design-review-routes — route table", () => {
  it("builds exactly the five platform review routes with exact ids, methods, and paths", () => {
    const routes = buildDesignReviewRoutes(makeCtx().ctx);
    expect(routes).toHaveLength(5);
    expect(routes.map((r) => [r.route.operationId, r.route.method, pathOf(r.route)])).toEqual([
      ["platform.designReviews.list", "GET", "v1/platform/design-reviews"],
      ["platform.designReviews.stats", "GET", "v1/platform/design-reviews/stats"],
      ["platform.designReviews.get", "GET", "v1/platform/design-reviews/:id"],
      ["platform.designReviews.approve", "POST", "v1/platform/design-reviews/:id/approve"],
      ["platform.designReviews.reject", "POST", "v1/platform/design-reviews/:id/reject"],
    ]);
  });

  it("orders the literal stats path before the :id path so it is not swallowed", () => {
    const ops = buildDesignReviewRoutes(makeCtx().ctx).map((r) => r.route.operationId);
    expect(ops.indexOf("platform.designReviews.stats")).toBeLessThan(
      ops.indexOf("platform.designReviews.get"),
    );
  });
});

describe("design-review-routes — auth gating", () => {
  it("401s an unauthenticated caller on every route", async () => {
    const { ctx, store } = makeCtx();
    const seeded = store.seed();
    for (const op of ALL_OPS) {
      const out = await call(ctx, op, { params: { id: seeded.id } }, null);
      expect(out.status).toBe(401);
      expect(out.body["error"]).toBe("authentication_required");
    }
    expect(store.approveCalls).toHaveLength(0);
    expect(store.rejectCalls).toHaveLength(0);
  });

  it("403s a caller without a platform reviewer role on every route", async () => {
    const { ctx, store } = makeCtx();
    const seeded = store.seed();
    for (const op of ALL_OPS) {
      const out = await call(ctx, op, { params: { id: seeded.id } }, "tenant_admin");
      expect(out.status).toBe(403);
      expect(out.body["error"]).toBe("forbidden");
    }
    expect(store.approveCalls).toHaveLength(0);
    expect(store.rejectCalls).toHaveLength(0);
  });

  it("is fail-closed when no admin role is configured", async () => {
    const { ctx } = makeCtx();
    const closed: DesignReviewContext = { ...ctx, adminRoles: new Set<string>() };
    expect((await call(closed, "platform.designReviews.list")).status).toBe(403);
  });
});

describe("design-review-routes — list", () => {
  it("returns a risk summary per item and omits the manifest", async () => {
    const { ctx, store } = makeCtx();
    store.seed();
    store.seed({ manifest: { entities: [1, 2, 3, 4, 5, 6] } });
    const out = await call(ctx, "platform.designReviews.list");
    expect(out.status).toBe(200);
    const data = out.body["data"] as ReadonlyArray<Record<string, unknown>>;
    expect(data).toHaveLength(2);
    for (const item of data) {
      expect(item).not.toHaveProperty("manifest");
      expect(item["risk"]).toBeDefined();
    }
    expect((data[0]?.["risk"] as RiskReportLike).counts.entities).toBe(2);
    expect((data[0]?.["risk"] as RiskReportLike).level).toBe("low");
    expect((data[1]?.["risk"] as RiskReportLike).level).toBe("high");
  });

  it("keeps the review fields the queue UI needs on each stripped item", async () => {
    const { ctx, store } = makeCtx();
    const seeded = store.seed({ reviewStatus: "approved", reviewedBy: REVIEWER, reviewNotes: "ok" });
    const out = await call(ctx, "platform.designReviews.list");
    const item = (out.body["data"] as ReadonlyArray<Record<string, unknown>>)[0];
    expect(item?.["id"]).toBe(seeded.id);
    expect(item?.["tenantId"]).toBe(TENANT);
    expect(item?.["reviewStatus"]).toBe("approved");
    expect(item?.["reviewedBy"]).toBe(REVIEWER);
    expect(item?.["manifestHash"]).toBe("sha256:abc123");
  });

  it("passes reviewStatus, tenantId, limit, and cursor through to the store", async () => {
    const { ctx, store } = makeCtx();
    await call(ctx, "platform.designReviews.list", {
      query: { reviewStatus: "pending", tenantId: OTHER_TENANT, limit: "7", cursor: "3" },
    });
    expect(store.listCalls).toEqual([
      { reviewStatus: "pending", tenantId: OTHER_TENANT, limit: 7, cursor: "3" },
    ]);
  });

  it("filters by reviewStatus and by tenantId", async () => {
    const { ctx, store } = makeCtx();
    store.seed({ reviewStatus: "pending" });
    const approved = store.seed({ reviewStatus: "approved" });
    store.seed({ reviewStatus: "pending", tenantId: OTHER_TENANT });

    const byStatus = await call(ctx, "platform.designReviews.list", {
      query: { reviewStatus: "approved" },
    });
    expect((byStatus.body["data"] as { id: string }[]).map((r) => r.id)).toEqual([approved.id]);

    const byTenant = await call(ctx, "platform.designReviews.list", {
      query: { tenantId: OTHER_TENANT },
    });
    expect(byTenant.body["data"]).toHaveLength(1);
  });

  it("ignores an unknown reviewStatus rather than filtering on it", async () => {
    const { ctx, store } = makeCtx();
    store.seed();
    const out = await call(ctx, "platform.designReviews.list", { query: { reviewStatus: "bogus" } });
    expect(store.listCalls[0]?.reviewStatus).toBeUndefined();
    expect(out.body["data"]).toHaveLength(1);
  });

  it("paginates with limit + cursor", async () => {
    const { ctx, store } = makeCtx();
    for (let i = 0; i < 3; i += 1) store.seed();
    const first = await call(ctx, "platform.designReviews.list", { query: { limit: "2" } });
    expect(first.body["data"]).toHaveLength(2);
    const cursor = (first.body["page"] as { nextCursor: string | null }).nextCursor;
    expect(cursor).not.toBeNull();
    const second = await call(ctx, "platform.designReviews.list", {
      query: { limit: "2", cursor: cursor as string },
    });
    expect(second.body["data"]).toHaveLength(1);
    expect((second.body["page"] as { nextCursor: string | null }).nextCursor).toBeNull();
  });
});

describe("design-review-routes — stats", () => {
  it("returns the store's review counts", async () => {
    const { ctx, store } = makeCtx();
    store.seed({ reviewStatus: "pending" });
    store.seed({ reviewStatus: "pending" });
    store.seed({ reviewStatus: "approved" });
    store.seed({ reviewStatus: "rejected" });
    store.seed({ reviewStatus: "not_required" });
    const out = await call(ctx, "platform.designReviews.stats");
    expect(out.status).toBe(200);
    expect(out.body["counts"]).toEqual({
      pending: 2, approved: 1, rejected: 1, notRequired: 1, total: 5,
    });
  });
});

describe("design-review-routes — get", () => {
  it("200s the full review including the manifest, plus its risk report", async () => {
    const { ctx, store } = makeCtx();
    const seeded = store.seed();
    const out = await call(ctx, "platform.designReviews.get", { params: { id: seeded.id } });
    expect(out.status).toBe(200);
    const review = out.body["review"] as DesignReviewRecordLike;
    expect(review.id).toBe(seeded.id);
    expect(review.manifest).toEqual(MANIFEST);
    expect((out.body["risk"] as RiskReportLike).counts.entities).toBe(2);
  });

  it("404s a missing review", async () => {
    const { ctx } = makeCtx();
    const out = await call(ctx, "platform.designReviews.get", { params: { id: "aim_9999" } });
    expect(out.status).toBe(404);
    expect(out.body).toEqual({ error: "review_not_found", detail: "aim_9999" });
  });
});

describe("design-review-routes — approve", () => {
  it("200s a pending review and records the authenticated principal as the reviewer", async () => {
    const { ctx, store } = makeCtx();
    const seeded = store.seed({ reviewStatus: "pending" });
    const out = await call(ctx, "platform.designReviews.approve", { params: { id: seeded.id } });
    expect(out.status).toBe(200);
    const review = out.body["review"] as DesignReviewRecordLike;
    expect(review.reviewStatus).toBe("approved");
    expect(review.reviewedBy).toBe(REVIEWER);
    expect(store.approveCalls).toEqual([
      { id: seeded.id, input: { reviewedBy: REVIEWER, notes: null } },
    ]);
  });

  it("ignores a body-supplied reviewedBy — attribution comes from the principal only", async () => {
    const { ctx, store } = makeCtx();
    const seeded = store.seed();
    const out = await call(ctx, "platform.designReviews.approve", {
      params: { id: seeded.id },
      body: { reviewedBy: "00000000-0000-4000-8000-00000000dead", notes: "lgtm" },
    });
    expect(out.status).toBe(200);
    expect(store.approveCalls[0]?.input.reviewedBy).toBe(REVIEWER);
    expect((out.body["review"] as DesignReviewRecordLike).reviewedBy).toBe(REVIEWER);
  });

  it("passes notes through to the store", async () => {
    const { ctx, store } = makeCtx();
    const seeded = store.seed();
    const out = await call(ctx, "platform.designReviews.approve", {
      params: { id: seeded.id },
      body: { notes: "schema looks safe" },
    });
    expect(store.approveCalls[0]?.input.notes).toBe("schema looks safe");
    expect((out.body["review"] as DesignReviewRecordLike).reviewNotes).toBe("schema looks safe");
  });

  it("400s notes longer than 2000 characters without touching the store", async () => {
    const { ctx, store } = makeCtx();
    const seeded = store.seed();
    const out = await call(ctx, "platform.designReviews.approve", {
      params: { id: seeded.id },
      body: { notes: "x".repeat(2001) },
    });
    expect(out.status).toBe(400);
    expect(out.body["error"]).toBe("invalid_request");
    expect(store.approveCalls).toHaveLength(0);
  });

  it("accepts notes of exactly 2000 characters", async () => {
    const { ctx, store } = makeCtx();
    const seeded = store.seed();
    const out = await call(ctx, "platform.designReviews.approve", {
      params: { id: seeded.id },
      body: { notes: "x".repeat(2000) },
    });
    expect(out.status).toBe(200);
    expect(store.approveCalls).toHaveLength(1);
  });

  it("409s approving anything that is not pending", async () => {
    for (const from of ["approved", "rejected", "not_required"] as const) {
      const { ctx, store } = makeCtx();
      const seeded = store.seed({ reviewStatus: from });
      const out = await call(ctx, "platform.designReviews.approve", { params: { id: seeded.id } });
      expect(out.status).toBe(409);
      expect(out.body).toEqual({ error: "illegal_transition", detail: `${from} -> approved` });
      expect(store.approveCalls).toHaveLength(0);
    }
  });

  it("404s approving a missing review", async () => {
    const { ctx, store } = makeCtx();
    const out = await call(ctx, "platform.designReviews.approve", { params: { id: "aim_9999" } });
    expect(out.status).toBe(404);
    expect(out.body["error"]).toBe("review_not_found");
    expect(store.approveCalls).toHaveLength(0);
  });
});

describe("design-review-routes — reject", () => {
  it("200s rejecting a pending review with the principal as reviewer", async () => {
    const { ctx, store } = makeCtx();
    const seeded = store.seed({ reviewStatus: "pending" });
    const out = await call(ctx, "platform.designReviews.reject", {
      params: { id: seeded.id },
      body: { notes: "PHI without an auditable trait" },
    });
    expect(out.status).toBe(200);
    expect((out.body["review"] as DesignReviewRecordLike).reviewStatus).toBe("rejected");
    expect(store.rejectCalls).toEqual([
      { id: seeded.id, input: { reviewedBy: REVIEWER, notes: "PHI without an auditable trait" } },
    ]);
  });

  it("200s rejecting an already-approved review — an operator can revoke an approval", async () => {
    const { ctx, store } = makeCtx();
    const seeded = store.seed({ reviewStatus: "approved", reviewedBy: REVIEWER });
    const out = await call(ctx, "platform.designReviews.reject", { params: { id: seeded.id } });
    expect(out.status).toBe(200);
    expect((out.body["review"] as DesignReviewRecordLike).reviewStatus).toBe("rejected");
    expect(store.rejectCalls).toHaveLength(1);
  });

  it("409s rejecting an already-rejected or not_required review", async () => {
    for (const from of ["rejected", "not_required"] as const) {
      const { ctx, store } = makeCtx();
      const seeded = store.seed({ reviewStatus: from });
      const out = await call(ctx, "platform.designReviews.reject", { params: { id: seeded.id } });
      expect(out.status).toBe(409);
      expect(out.body).toEqual({ error: "illegal_transition", detail: `${from} -> rejected` });
      expect(store.rejectCalls).toHaveLength(0);
    }
  });

  it("400s oversized notes on reject too", async () => {
    const { ctx, store } = makeCtx();
    const seeded = store.seed();
    const out = await call(ctx, "platform.designReviews.reject", {
      params: { id: seeded.id },
      body: { notes: "x".repeat(2001) },
    });
    expect(out.status).toBe(400);
    expect(store.rejectCalls).toHaveLength(0);
  });

  it("404s rejecting a missing review", async () => {
    const { ctx } = makeCtx();
    const out = await call(ctx, "platform.designReviews.reject", { params: { id: "aim_9999" } });
    expect(out.status).toBe(404);
  });

  it("supports the pending → approved → rejected → (409) sequence end to end", async () => {
    const { ctx, store } = makeCtx();
    const seeded = store.seed({ reviewStatus: "pending" });
    expect((await call(ctx, "platform.designReviews.approve", { params: { id: seeded.id } })).status).toBe(200);
    expect((await call(ctx, "platform.designReviews.reject", { params: { id: seeded.id } })).status).toBe(200);
    const again = await call(ctx, "platform.designReviews.reject", { params: { id: seeded.id } });
    expect(again.status).toBe(409);
    expect(again.body["detail"]).toBe("rejected -> rejected");
  });
});

const STUB_VIEW: ManifestViewLike = {
  meta: { name: "Plumber CRM", slug: "acme/crm", version: "1.0.0", description: null },
  entities: [],
  relations: [],
  roles: [],
  counts: { entities: 2, fields: 0, roles: 0, relations: 0, sensitiveFields: 0, lifecycles: 0 },
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

describe("design-review-routes — schema projection", () => {
  it("includes the projected schema on get, built from the review's own manifest", async () => {
    const { ctx, store } = makeCtx();
    const projector = recordingProjector();
    const withSchema: DesignReviewContext = { ...ctx, projectSchema: projector.project };
    const seeded = store.seed();
    const out = await call(withSchema, "platform.designReviews.get", { params: { id: seeded.id } });
    expect(out.status).toBe(200);
    expect(projector.calls).toEqual([MANIFEST]);
    expect(out.body["schema"]).toBe(STUB_VIEW);
  });

  it("keeps review + manifest + risk intact alongside the schema", async () => {
    const { ctx, store } = makeCtx();
    const projector = recordingProjector();
    const withSchema: DesignReviewContext = { ...ctx, projectSchema: projector.project };
    const seeded = store.seed();
    const out = await call(withSchema, "platform.designReviews.get", { params: { id: seeded.id } });
    const review = out.body["review"] as DesignReviewRecordLike;
    expect(review.id).toBe(seeded.id);
    expect(review.manifest).toEqual(MANIFEST);
    expect((out.body["risk"] as RiskReportLike).counts.entities).toBe(2);
    expect(Object.keys(out.body).sort()).toEqual(["review", "risk", "schema"]);
  });

  it("omits the schema key entirely when no projector is configured", async () => {
    const { ctx, store } = makeCtx();
    const seeded = store.seed();
    const out = await call(ctx, "platform.designReviews.get", { params: { id: seeded.id } });
    expect(out.status).toBe(200);
    expect("schema" in out.body).toBe(false);
    expect(Object.keys(out.body).sort()).toEqual(["review", "risk"]);
  });

  it("leaves the list untouched — no manifest, no schema, projector never called", async () => {
    const { ctx, store } = makeCtx();
    const projector = recordingProjector();
    const withSchema: DesignReviewContext = { ...ctx, projectSchema: projector.project };
    store.seed();
    store.seed();
    const out = await call(withSchema, "platform.designReviews.list");
    expect(out.status).toBe(200);
    expect("schema" in out.body).toBe(false);
    for (const item of out.body["data"] as ReadonlyArray<Record<string, unknown>>) {
      expect("manifest" in item).toBe(false);
      expect("schema" in item).toBe(false);
      expect(item["risk"]).toBeDefined();
    }
    expect(projector.calls).toHaveLength(0);
  });

  it("does not project for a missing review — the 404 body is unchanged", async () => {
    const { ctx } = makeCtx();
    const projector = recordingProjector();
    const withSchema: DesignReviewContext = { ...ctx, projectSchema: projector.project };
    const out = await call(withSchema, "platform.designReviews.get", { params: { id: "aim_9999" } });
    expect(out.status).toBe(404);
    expect(out.body).toEqual({ error: "review_not_found", detail: "aim_9999" });
    expect(projector.calls).toHaveLength(0);
  });

  it("does not project behind a guard denial on get", async () => {
    const { ctx, store } = makeCtx();
    const projector = recordingProjector();
    const withSchema: DesignReviewContext = { ...ctx, projectSchema: projector.project };
    const seeded = store.seed();
    const unauth = await call(withSchema, "platform.designReviews.get", { params: { id: seeded.id } }, null);
    expect(unauth.status).toBe(401);
    const forbidden = await call(
      withSchema,
      "platform.designReviews.get",
      { params: { id: seeded.id } },
      "tenant_admin",
    );
    expect(forbidden.status).toBe(403);
    expect(projector.calls).toHaveLength(0);
  });

  it("leaves approve and reject responses free of a schema", async () => {
    const { ctx, store } = makeCtx();
    const projector = recordingProjector();
    const withSchema: DesignReviewContext = { ...ctx, projectSchema: projector.project };
    const seeded = store.seed({ reviewStatus: "pending" });
    const approved = await call(withSchema, "platform.designReviews.approve", { params: { id: seeded.id } });
    expect(approved.status).toBe(200);
    expect(Object.keys(approved.body)).toEqual(["review"]);
    const rejected = await call(withSchema, "platform.designReviews.reject", { params: { id: seeded.id } });
    expect(rejected.status).toBe(200);
    expect(Object.keys(rejected.body)).toEqual(["review"]);
    expect(projector.calls).toHaveLength(0);
  });

  it("projects once per get call", async () => {
    const { ctx, store } = makeCtx();
    const projector = recordingProjector();
    const withSchema: DesignReviewContext = { ...ctx, projectSchema: projector.project };
    const seeded = store.seed();
    await call(withSchema, "platform.designReviews.get", { params: { id: seeded.id } });
    await call(withSchema, "platform.designReviews.get", { params: { id: seeded.id } });
    expect(projector.calls).toHaveLength(2);
  });
});
