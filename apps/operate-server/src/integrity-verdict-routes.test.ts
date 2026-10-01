import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import type { Handler, HandlerInput, HandlerOutput } from "@crossengin/api-gateway-runtime";
import { describe, expect, it } from "vitest";

import {
  buildIntegrityVerdictRoutes,
  resolveIntegrityVerdictGrant,
  resolveRequestedScope,
  resolveWindow,
  toVerdictView,
  type IntegrityVerdictCountsLike,
  type IntegrityVerdictListPageLike,
  type IntegrityVerdictListQueryLike,
  type IntegrityVerdictReadScopeLike,
  type IntegrityVerdictRecordLike,
  type IntegrityVerdictRoutesContext,
  type IntegrityVerdictSourceLike,
} from "./integrity-verdict-routes.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const OTHER_TENANT = "00000000-0000-4000-8000-000000000002";
const OPERATOR = "00000000-0000-4000-8000-0000000000aa";

const NOW = new Date("2026-10-01T00:00:00.000Z");

const PLATFORM_ROLE = "platform_auditor";
const TENANT_ROLE = "erp_admin";

/** A source that applies the scope the route asked for, so a leak shows up as visible data. */
class FakeVerdictSource implements IntegrityVerdictSourceLike {
  readonly records: IntegrityVerdictRecordLike[] = [];
  readonly listCalls: IntegrityVerdictListQueryLike[] = [];
  readonly latestCalls: IntegrityVerdictReadScopeLike[] = [];
  /** When set, every read throws it — a hand-edited row the store refused. */
  throwOnRead: Error | null = null;
  private seq = 0;

  seed(overrides: Partial<IntegrityVerdictRecordLike> = {}): IntegrityVerdictRecordLike {
    this.seq += 1;
    const at = new Date(Date.UTC(2026, 8, 1) + this.seq * 3_600_000).toISOString();
    const record: IntegrityVerdictRecordLike = {
      id: `00000000-0000-4000-8000-00000000000${this.seq.toString()}`,
      verdictId: `aiv_${String(this.seq).padStart(8, "0")}`,
      scope: TENANT,
      verdict: "verified",
      verifiedAt: at,
      anchorsChecked: 4,
      anchorsVerified: 4,
      anchorsTampered: 0,
      anchorsUnanchored: 0,
      chainOk: true,
      truncated: false,
      report: { kind: "audit_integrity_proof", verdict: "verified" },
      chainEntryHash: "f".repeat(64),
      chainSequenceNumber: 12,
      payloadSha256: "a".repeat(64),
      createdAt: at,
      ...overrides,
    };
    this.records.push(record);
    return record;
  }

  private inScope(scope: IntegrityVerdictReadScopeLike): IntegrityVerdictRecordLike[] {
    if (scope.kind === "all") return [...this.records];
    if (scope.kind === "platform") return this.records.filter((r) => r.scope === null);
    return this.records.filter((r) => r.scope === scope.tenantId);
  }

  async list(query: IntegrityVerdictListQueryLike): Promise<IntegrityVerdictListPageLike> {
    this.listCalls.push(query);
    if (this.throwOnRead !== null) throw this.throwOnRead;
    let visible = this.inScope(query.scope);
    if (query.verdict !== undefined) visible = visible.filter((r) => r.verdict === query.verdict);
    if (query.from !== undefined) visible = visible.filter((r) => r.verifiedAt >= (query.from ?? ""));
    if (query.to !== undefined) visible = visible.filter((r) => r.verifiedAt < (query.to ?? ""));
    return { data: visible, nextCursor: null };
  }

  async counts(
    query: Omit<IntegrityVerdictListQueryLike, "limit" | "cursor">,
  ): Promise<IntegrityVerdictCountsLike> {
    if (this.throwOnRead !== null) throw this.throwOnRead;
    const tally = { verified: 0, unproven: 0, compromised: 0, total: 0 };
    for (const r of this.inScope(query.scope)) {
      tally[r.verdict] += 1;
      tally.total += 1;
    }
    return tally;
  }

  async latest(scope: IntegrityVerdictReadScopeLike): Promise<IntegrityVerdictRecordLike | null> {
    this.latestCalls.push(scope);
    if (this.throwOnRead !== null) throw this.throwOnRead;
    const visible = this.inScope(scope);
    return visible[visible.length - 1] ?? null;
  }

  async getByVerdictId(
    verdictId: string,
    scope: IntegrityVerdictReadScopeLike,
  ): Promise<IntegrityVerdictRecordLike | null> {
    if (this.throwOnRead !== null) throw this.throwOnRead;
    return this.inScope(scope).find((r) => r.verdictId === verdictId) ?? null;
  }
}

interface Harness {
  readonly ctx: IntegrityVerdictRoutesContext & { source: FakeVerdictSource };
  readonly source: FakeVerdictSource;
}

function makeCtx(overrides: Partial<IntegrityVerdictRoutesContext> = {}): Harness {
  const source = new FakeVerdictSource();
  const ctx = {
    source,
    principalRoles: (p: ResolvedPrincipal | null) => ({ primaryRole: p?.grantedScopes[0] ?? "anon" }),
    platformRoles: new Set([PLATFORM_ROLE]),
    tenantRoles: new Set([TENANT_ROLE]),
    clock: () => NOW,
    ...overrides,
  } as IntegrityVerdictRoutesContext & { source: FakeVerdictSource };
  return { ctx, source };
}

function principal(role: string | null, tenantId: string | null = TENANT): ResolvedPrincipal | null {
  if (role === null) return null;
  return {
    principalId: OPERATOR,
    tenantId,
    principalKind: "user",
    authScheme: "api_key_header",
    grantedScopes: [role],
    mfaProofAgeSeconds: null,
    resolvedAt: "2026-09-01T00:00:00.000Z",
  } as ResolvedPrincipal;
}

function input(
  p: ResolvedPrincipal | null,
  opts: { query?: Record<string, string>; params?: Record<string, string> } = {},
): HandlerInput {
  return {
    request: { query: opts.query ?? {} } as never,
    route: {} as never,
    principal: p,
    params: opts.params ?? {},
    parsedBody: null,
  };
}

function findHandler(ctx: IntegrityVerdictRoutesContext, op: string): Handler {
  const found = buildIntegrityVerdictRoutes(ctx).find((r) => r.route.operationId === op);
  if (found === undefined) throw new Error(`no route ${op}`);
  return found.handler;
}

type JsonOut = HandlerOutput & { status: number; body: Record<string, unknown> };

async function call(
  ctx: IntegrityVerdictRoutesContext,
  op: string,
  p: ResolvedPrincipal | null = principal(PLATFORM_ROLE),
  opts: Parameters<typeof input>[1] = {},
): Promise<JsonOut> {
  return (await findHandler(ctx, op)(input(p, opts))) as JsonOut;
}

function pathOf(route: { pathSegments: readonly unknown[] }): string {
  return (route.pathSegments as ReadonlyArray<{ kind: string; value?: string; name?: string }>)
    .map((s) => (s.kind === "literal" ? String(s.value) : `:${String(s.name)}`))
    .join("/");
}

const ALL_OPS = [
  "auditIntegrity.verdicts.list",
  "auditIntegrity.verdicts.stats",
  "auditIntegrity.verdicts.latest",
  "auditIntegrity.verdicts.get",
] as const;

describe("integrity-verdict-routes — route table", () => {
  it("builds exactly the four read-only routes with exact ids, methods and paths", () => {
    const routes = buildIntegrityVerdictRoutes(makeCtx().ctx);
    expect(routes.map((r) => [r.route.operationId, r.route.method, pathOf(r.route)])).toEqual([
      ["auditIntegrity.verdicts.list", "GET", "v1/audit-integrity/verdicts"],
      ["auditIntegrity.verdicts.stats", "GET", "v1/audit-integrity/verdicts/stats"],
      ["auditIntegrity.verdicts.latest", "GET", "v1/audit-integrity/verdicts/latest"],
      ["auditIntegrity.verdicts.get", "GET", "v1/audit-integrity/verdicts/:verdictId"],
    ]);
  });

  it("exposes no write method at all — a verdict comes from a proof pass, never from HTTP", () => {
    const methods = new Set(buildIntegrityVerdictRoutes(makeCtx().ctx).map((r) => r.route.method));
    expect([...methods]).toEqual(["GET"]);
  });

  it("orders the literal stats and latest paths before the :verdictId path", () => {
    const paths = buildIntegrityVerdictRoutes(makeCtx().ctx).map((r) => pathOf(r.route));
    expect(paths.indexOf("v1/audit-integrity/verdicts/stats")).toBeLessThan(
      paths.indexOf("v1/audit-integrity/verdicts/:verdictId"),
    );
    expect(paths.indexOf("v1/audit-integrity/verdicts/latest")).toBeLessThan(
      paths.indexOf("v1/audit-integrity/verdicts/:verdictId"),
    );
  });
});

describe("integrity-verdict-routes — authorisation", () => {
  it("401s an unauthenticated caller on every route", async () => {
    const { ctx } = makeCtx();
    for (const op of ALL_OPS) {
      const out = await call(ctx, op, null, { params: { verdictId: "aiv_00000001" } });
      expect(out.status).toBe(401);
      expect(out.body["error"]).toBe("authentication_required");
    }
  });

  it("403s an authenticated caller carrying no granted role", async () => {
    const { ctx, source } = makeCtx();
    source.seed();
    const out = await call(ctx, "auditIntegrity.verdicts.list", principal("viewer"));
    expect(out.status).toBe(403);
    expect(out.body["error"]).toBe("forbidden");
  });

  it("reads nothing from the store when the caller is refused", async () => {
    const { ctx, source } = makeCtx();
    source.seed();
    await call(ctx, "auditIntegrity.verdicts.list", principal("viewer"));
    await call(ctx, "auditIntegrity.verdicts.list", null);
    expect(source.listCalls).toEqual([]);
  });

  it("grants nobody when the role sets are empty, so an unconfigured deployment exposes nothing", () => {
    const { ctx } = makeCtx({ platformRoles: new Set(), tenantRoles: new Set() });
    expect(resolveIntegrityVerdictGrant(ctx, principal(PLATFORM_ROLE))).toBeNull();
    expect(resolveIntegrityVerdictGrant(ctx, principal(TENANT_ROLE))).toBeNull();
  });

  it("resolves the platform grant from the platform role and the tenant grant from the tenant role", () => {
    const { ctx } = makeCtx();
    expect(resolveIntegrityVerdictGrant(ctx, principal(PLATFORM_ROLE))).toEqual({ kind: "platform" });
    expect(resolveIntegrityVerdictGrant(ctx, principal(TENANT_ROLE))).toEqual({
      kind: "tenant",
      tenantId: TENANT,
    });
  });

  it("refuses a tenant-role caller whose tenant cannot be resolved, rather than running unfiltered", () => {
    const { ctx } = makeCtx();
    expect(resolveIntegrityVerdictGrant(ctx, principal(TENANT_ROLE, null))).toBeNull();
    expect(resolveIntegrityVerdictGrant(ctx, principal(TENANT_ROLE, "not-a-uuid"))).toBeNull();
  });

  it("honours a secondary role, so a grant need not be the primary one", () => {
    const { ctx } = makeCtx({
      principalRoles: () => ({ primaryRole: "viewer", secondaryRoles: [PLATFORM_ROLE] }),
    });
    expect(resolveIntegrityVerdictGrant(ctx, principal("viewer"))).toEqual({ kind: "platform" });
  });

  it("403s a tenant-scoped caller who asks for a refused verdict id by naming it", async () => {
    const { ctx, source } = makeCtx();
    const other = source.seed({ scope: OTHER_TENANT });
    const out = await call(ctx, "auditIntegrity.verdicts.get", principal(TENANT_ROLE), {
      params: { verdictId: other.verdictId },
      query: { tenantId: OTHER_TENANT },
    });
    expect(out.status).toBe(403);
  });
});

describe("integrity-verdict-routes — scope", () => {
  it("defaults a platform grant to every tenant and a tenant grant to its own", () => {
    expect(resolveRequestedScope({ kind: "platform" }, undefined, undefined)).toEqual({ kind: "all" });
    expect(resolveRequestedScope({ kind: "tenant", tenantId: TENANT }, undefined, undefined)).toEqual({
      kind: "tenant",
      tenantId: TENANT,
    });
  });

  it("lets a platform grant name the platform chain or any single tenant", () => {
    expect(resolveRequestedScope({ kind: "platform" }, "platform", undefined)).toEqual({
      kind: "platform",
    });
    expect(resolveRequestedScope({ kind: "platform" }, undefined, OTHER_TENANT)).toEqual({
      kind: "tenant",
      tenantId: OTHER_TENANT,
    });
  });

  it("refuses a tenant grant asking for the platform chain or for every tenant", () => {
    expect(resolveRequestedScope({ kind: "tenant", tenantId: TENANT }, "platform", undefined)).toMatchObject(
      { error: "forbidden" },
    );
    expect(resolveRequestedScope({ kind: "tenant", tenantId: TENANT }, "all", undefined)).toMatchObject({
      error: "forbidden",
    });
  });

  it("refuses a tenant grant naming another tenant instead of narrowing it silently", () => {
    expect(
      resolveRequestedScope({ kind: "tenant", tenantId: TENANT }, undefined, OTHER_TENANT),
    ).toMatchObject({ error: "forbidden" });
  });

  it("allows a tenant grant to name its own tenant explicitly", () => {
    expect(resolveRequestedScope({ kind: "tenant", tenantId: TENANT }, undefined, TENANT)).toEqual({
      kind: "tenant",
      tenantId: TENANT,
    });
  });

  it("rejects a non-uuid tenantId and an unknown scope name", () => {
    expect(resolveRequestedScope({ kind: "platform" }, undefined, "acme")).toMatchObject({
      error: "invalid_request",
    });
    expect(resolveRequestedScope({ kind: "platform" }, "everything", undefined)).toMatchObject({
      error: "invalid_request",
    });
  });

  it("confines a tenant-scoped caller to their own rows end to end", async () => {
    const { ctx, source } = makeCtx();
    const mine = source.seed({ scope: TENANT });
    source.seed({ scope: OTHER_TENANT });
    source.seed({ scope: null });
    const out = await call(ctx, "auditIntegrity.verdicts.list", principal(TENANT_ROLE));
    expect(out.status).toBe(200);
    const data = out.body["data"] as { verdictId: string; scope: string | null }[];
    expect(data.map((r) => r.verdictId)).toEqual([mine.verdictId]);
    expect(source.listCalls[0]?.scope).toEqual({ kind: "tenant", tenantId: TENANT });
  });

  it("never reaches the platform path for a tenant-scoped caller", async () => {
    const { ctx, source } = makeCtx();
    source.seed({ scope: null });
    await call(ctx, "auditIntegrity.verdicts.latest", principal(TENANT_ROLE));
    expect(source.latestCalls).toEqual([{ kind: "tenant", tenantId: TENANT }]);
  });

  it("lets a platform caller see every scope including the platform chain", async () => {
    const { ctx, source } = makeCtx();
    source.seed({ scope: TENANT });
    source.seed({ scope: OTHER_TENANT });
    source.seed({ scope: null });
    const out = await call(ctx, "auditIntegrity.verdicts.list");
    const data = out.body["data"] as { scope: string | null }[];
    expect(data.map((r) => r.scope)).toEqual([TENANT, OTHER_TENANT, null]);
  });
});

describe("integrity-verdict-routes — window and filters", () => {
  it("defaults to the last 31 days ending now", () => {
    const window = resolveWindow(undefined, undefined, NOW, 366);
    expect(window).toEqual({ from: "2026-08-31T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" });
  });

  it("rejects an unparseable from or to", () => {
    expect(resolveWindow("last tuesday", undefined, NOW, 366)).toMatchObject({
      error: "invalid_request",
    });
    expect(resolveWindow(undefined, "soon", NOW, 366)).toMatchObject({ error: "invalid_request" });
  });

  it("rejects an inverted or empty range", () => {
    expect(
      resolveWindow("2026-10-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z", NOW, 366),
    ).toMatchObject({ error: "invalid_request" });
    expect(
      resolveWindow("2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z", NOW, 366),
    ).toMatchObject({ error: "invalid_request" });
  });

  it("rejects a range wider than the configured cap", () => {
    expect(resolveWindow("2020-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", NOW, 366)).toMatchObject(
      { error: "invalid_request" },
    );
    expect(resolveWindow("2026-09-01T00:00:00.000Z", "2026-09-20T00:00:00.000Z", NOW, 7)).toMatchObject({
      error: "invalid_request",
    });
  });

  it("400s a bad time range over HTTP and reads nothing", async () => {
    const { ctx, source } = makeCtx();
    source.seed();
    const out = await call(ctx, "auditIntegrity.verdicts.list", principal(PLATFORM_ROLE), {
      query: { from: "2026-10-01T00:00:00.000Z", to: "2026-09-01T00:00:00.000Z" },
    });
    expect(out.status).toBe(400);
    expect(out.body["detail"]).toBe("from must be before to");
    expect(source.listCalls).toEqual([]);
  });

  it("checks authorisation before the window, so a refused caller learns nothing about filters", async () => {
    const { ctx } = makeCtx();
    const out = await call(ctx, "auditIntegrity.verdicts.list", principal("viewer"), {
      query: { from: "nonsense" },
    });
    expect(out.status).toBe(403);
  });

  it("answers 'last month's verifications' with an explicit window pushed to the store", async () => {
    const { ctx, source } = makeCtx();
    source.seed();
    const out = await call(ctx, "auditIntegrity.verdicts.list", principal(PLATFORM_ROLE), {
      query: { from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" },
    });
    expect(out.status).toBe(200);
    expect(out.body["window"]).toEqual({
      from: "2026-09-01T00:00:00.000Z",
      to: "2026-10-01T00:00:00.000Z",
    });
    expect(source.listCalls[0]?.from).toBe("2026-09-01T00:00:00.000Z");
  });

  it("passes a known verdict filter through and 400s an unknown one", async () => {
    const { ctx, source } = makeCtx();
    source.seed({ verdict: "compromised" });
    source.seed({ verdict: "verified" });
    const ok = await call(ctx, "auditIntegrity.verdicts.list", principal(PLATFORM_ROLE), {
      query: { verdict: "compromised" },
    });
    expect((ok.body["data"] as unknown[]).length).toBe(1);
    const bad = await call(ctx, "auditIntegrity.verdicts.list", principal(PLATFORM_ROLE), {
      query: { verdict: "fine" },
    });
    expect(bad.status).toBe(400);
  });

  it("passes the limit and cursor through to the store", async () => {
    const { ctx, source } = makeCtx();
    source.seed();
    await call(ctx, "auditIntegrity.verdicts.list", principal(PLATFORM_ROLE), {
      query: { limit: "25", cursor: "djE6eA" },
    });
    expect(source.listCalls[0]?.limit).toBe(25);
    expect(source.listCalls[0]?.cursor).toBe("djE6eA");
  });

  it("400s an unparseable limit", async () => {
    const { ctx } = makeCtx();
    const out = await call(ctx, "auditIntegrity.verdicts.list", principal(PLATFORM_ROLE), {
      query: { limit: "lots" },
    });
    expect(out.status).toBe(400);
  });
});

describe("integrity-verdict-routes — responses", () => {
  it("reports the chain anchor on every verdict, since the row alone proves nothing", () => {
    const { source } = makeCtx();
    const anchored = toVerdictView(source.seed());
    const orphan = toVerdictView(
      source.seed({ chainEntryHash: null, chainSequenceNumber: null, payloadSha256: null }),
    );
    expect(anchored["chainEntryHash"]).toBe("f".repeat(64));
    expect(anchored["anchored"]).toBe(true);
    expect(orphan["chainEntryHash"]).toBeNull();
    expect(orphan["anchored"]).toBe(false);
  });

  it("reports the committed digest and its sequence, so a reader can check content and seek", () => {
    const { source } = makeCtx();
    const view = toVerdictView(source.seed());
    expect(view["payloadSha256"]).toBe("a".repeat(64));
    expect(view["chainSequenceNumber"]).toBe(12);
  });

  it("reports the unanchored count, which is what separates unproven from verified", () => {
    const { source } = makeCtx();
    const view = toVerdictView(source.seed({ verdict: "unproven", anchorsUnanchored: 3 }));
    expect(view["verdict"]).toBe("unproven");
    expect(view["anchorsUnanchored"]).toBe(3);
  });

  it("ships the stored report whole, since that is the content the chain attests to", () => {
    const { source } = makeCtx();
    const view = toVerdictView(source.seed());
    expect(view["report"]).toEqual({ kind: "audit_integrity_proof", verdict: "verified" });
  });

  it("returns the tally for a scope and window", async () => {
    const { ctx, source } = makeCtx();
    source.seed({ verdict: "verified" });
    source.seed({ verdict: "compromised" });
    const out = await call(ctx, "auditIntegrity.verdicts.stats");
    expect(out.status).toBe(200);
    expect(out.body["counts"]).toEqual({ verified: 1, unproven: 0, compromised: 1, total: 2 });
  });

  it("returns the newest verdict, or 404 when the scope has none", async () => {
    const { ctx, source } = makeCtx();
    const empty = await call(ctx, "auditIntegrity.verdicts.latest");
    expect(empty.status).toBe(404);
    const newest = source.seed({ verdict: "unproven" });
    const out = await call(ctx, "auditIntegrity.verdicts.latest");
    expect((out.body["verdict"] as Record<string, unknown>)["verdictId"]).toBe(newest.verdictId);
  });

  it("fetches one verdict by id and 404s an unknown one", async () => {
    const { ctx, source } = makeCtx();
    const record = source.seed();
    const found = await call(ctx, "auditIntegrity.verdicts.get", principal(PLATFORM_ROLE), {
      params: { verdictId: record.verdictId },
    });
    expect((found.body["verdict"] as Record<string, unknown>)["verdictId"]).toBe(record.verdictId);
    const missing = await call(ctx, "auditIntegrity.verdicts.get", principal(PLATFORM_ROLE), {
      params: { verdictId: "aiv_99999999" },
    });
    expect(missing.status).toBe(404);
  });

  it("404s rather than 403s when a tenant asks for an id outside their scope without naming a tenant", async () => {
    const { ctx, source } = makeCtx();
    const other = source.seed({ scope: OTHER_TENANT });
    const out = await call(ctx, "auditIntegrity.verdicts.get", principal(TENANT_ROLE), {
      params: { verdictId: other.verdictId },
    });
    expect(out.status).toBe(404);
  });
});

describe("integrity-verdict-routes — a hand-edited row", () => {
  it("refuses the whole page rather than serving it without the unreadable row", async () => {
    const { ctx, source } = makeCtx();
    source.seed();
    source.throwOnRead = new Error("stored integrity verdict aiv_00000001 disagrees with its report: verdict verified vs compromised");
    const out = await call(ctx, "auditIntegrity.verdicts.list");
    expect(out.status).toBe(500);
    expect(out.body["error"]).toBe("stored_verdict_invalid");
    expect(String(out.body["detail"])).toContain("disagrees with its report");
  });

  it("refuses a single fetch, the stats tally and the latest verdict the same way", async () => {
    const { ctx, source } = makeCtx();
    const record = source.seed();
    source.throwOnRead = new Error("report JSONB is not parseable");
    for (const op of ["auditIntegrity.verdicts.get", "auditIntegrity.verdicts.stats", "auditIntegrity.verdicts.latest"]) {
      const out = await call(ctx, op, principal(PLATFORM_ROLE), {
        params: { verdictId: record.verdictId },
      });
      expect(out.status).toBe(500);
      expect(out.body["error"]).toBe("stored_verdict_invalid");
    }
  });

  it("still refuses an unauthorised caller before it ever touches the corrupt row", async () => {
    const { ctx, source } = makeCtx();
    source.seed();
    source.throwOnRead = new Error("corrupt");
    const out = await call(ctx, "auditIntegrity.verdicts.list", principal("viewer"));
    expect(out.status).toBe(403);
  });
});
