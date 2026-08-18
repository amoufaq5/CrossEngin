import { randomUUID } from "node:crypto";

import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import type { Handler, HandlerInput, HandlerOutput } from "@crossengin/api-gateway-runtime";
import type { PgConnection } from "@crossengin/kernel-pg";
import { describe, expect, it } from "vitest";

import {
  PostgresTenantStore,
  buildPlatformAdminRoutes,
  type PlatformAdminContext,
} from "./platform-admin.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-0000000000aa";

/** A fake PgConnection modelling the platform-wide meta.tenants registry (no RLS). */
function fakePg(): PgConnection {
  const rows = new Map<string, Record<string, unknown>>();
  let seq = 0;
  const run = async (sql: string, params?: readonly unknown[]) => {
    const p = params ?? [];
    if (sql.includes("INSERT INTO")) {
      const [slug, name, tier, region, schemaName, searchLocale] = p as string[];
      for (const r of rows.values()) {
        if (r["slug"] === slug || r["schema_name"] === schemaName) {
          const err = new Error("duplicate key value violates unique constraint") as Error & { code?: string };
          err.code = "23505";
          throw err;
        }
      }
      seq += 1;
      const at = new Date(Date.UTC(2026, 0, 1) + seq * 1000);
      const row = {
        id: randomUUID(), slug, name, status: "active", tier, region,
        schema_name: schemaName, search_locale: searchLocale, created_at: at, updated_at: at,
      };
      rows.set(String(row.id), row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.includes("UPDATE")) {
      const row = rows.get(String(p[0]));
      if (row === undefined) return { rows: [], rowCount: 0 };
      row["status"] = String(p[1]);
      row["updated_at"] = new Date();
      return { rows: [row], rowCount: 1 };
    }
    if (sql.includes("GROUP BY status")) {
      const counts = new Map<string, number>();
      for (const r of rows.values()) {
        counts.set(String(r["status"]), (counts.get(String(r["status"])) ?? 0) + 1);
      }
      return { rows: [...counts].map(([status, count]) => ({ status, count })), rowCount: counts.size };
    }
    if (sql.includes("WHERE id = $1")) {
      const row = rows.get(String(p[0]));
      return { rows: row === undefined ? [] : [row], rowCount: row === undefined ? 0 : 1 };
    }
    if (sql.includes("WHERE slug = $1")) {
      const row = [...rows.values()].find((r) => r["slug"] === p[0]);
      return { rows: row === undefined ? [] : [row], rowCount: row === undefined ? 0 : 1 };
    }
    if (sql.includes("ORDER BY created_at")) {
      let visible = [...rows.values()];
      let idx = 0;
      if (sql.includes("WHERE status = $1")) {
        visible = visible.filter((r) => r["status"] === p[0]);
        idx = 1;
      }
      visible.sort((a, b) => {
        const av = (a["created_at"] as Date).getTime();
        const bv = (b["created_at"] as Date).getTime();
        return av !== bv ? bv - av : String(a["id"]).localeCompare(String(b["id"]));
      });
      const limit = Number(p[idx]);
      const offset = Number(p[idx + 1]);
      const page = visible.slice(offset, offset + limit);
      return { rows: page, rowCount: page.length };
    }
    return { rows: [], rowCount: 0 };
  };
  const conn: PgConnection = {
    query: run as PgConnection["query"],
    transaction: (async <T>(fn: (tx: PgConnection) => Promise<T>) => fn(conn)) as PgConnection["transaction"],
    withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) => fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  return conn;
}

function makeCtx(): PlatformAdminContext {
  return {
    store: new PostgresTenantStore(fakePg()),
    principalRoles: (p: ResolvedPrincipal | null) => ({ primaryRole: p?.grantedScopes[0] ?? "anon" }),
    adminRoles: new Set(["platform_admin"]),
  };
}

function principal(role: string | null): ResolvedPrincipal | null {
  if (role === null) return null;
  return {
    principalId: USER, tenantId: TENANT, principalKind: "user", authScheme: "api_key_header",
    grantedScopes: [role], mfaProofAgeSeconds: null, resolvedAt: "2026-06-01T00:00:00.000Z",
  } as ResolvedPrincipal;
}

function input(
  role: string | null,
  opts: { body?: Record<string, unknown>; params?: Record<string, string>; query?: Record<string, string> } = {},
): HandlerInput {
  return {
    request: { query: opts.query ?? {} } as never,
    route: {} as never,
    principal: principal(role),
    params: opts.params ?? {},
    parsedBody: opts.body ?? null,
  };
}

function findHandler(ctx: PlatformAdminContext, op: string): Handler {
  const found = buildPlatformAdminRoutes(ctx).find((r) => r.route.operationId === op);
  if (found === undefined) throw new Error(`no route ${op}`);
  return found.handler;
}

type JsonOut = HandlerOutput & { status: number; body: Record<string, unknown> };

async function create(ctx: PlatformAdminContext, body: Record<string, unknown>): Promise<JsonOut> {
  return (await findHandler(ctx, "platform.tenants.create")(input("platform_admin", { body }))) as JsonOut;
}

async function createdId(ctx: PlatformAdminContext, slug: string, name = "X"): Promise<string> {
  const out = await create(ctx, { slug, name });
  expect(out.status).toBe(201);
  return (out.body["tenant"] as { id: string }).id;
}

describe("platform-admin — create", () => {
  it("201s a valid tenant with a derived schema name", async () => {
    const out = await create(makeCtx(), { slug: "acme", name: "Acme Inc" });
    expect(out.status).toBe(201);
    const tenant = out.body["tenant"] as { slug: string; status: string; schemaName: string };
    expect(tenant.slug).toBe("acme");
    expect(tenant.status).toBe("active");
    expect(tenant.schemaName).toBe("t_acme");
  });

  it("400s an invalid slug", async () => {
    expect((await create(makeCtx(), { slug: "Acme", name: "x" })).status).toBe(400);
  });

  it("409s a duplicate slug", async () => {
    const ctx = makeCtx();
    await createdId(ctx, "acme");
    expect((await create(ctx, { slug: "acme", name: "Again" })).status).toBe(409);
  });

  it("409s a duplicate explicit schema name", async () => {
    const ctx = makeCtx();
    await create(ctx, { slug: "acme", name: "Acme", schemaName: "t_shared" });
    expect((await create(ctx, { slug: "acme-two", name: "Two", schemaName: "t_shared" })).status).toBe(409);
  });
});

describe("platform-admin — list", () => {
  it("lists tenants and filters by status", async () => {
    const ctx = makeCtx();
    const suspendMe = await createdId(ctx, "one");
    await createdId(ctx, "two");
    await findHandler(ctx, "platform.tenants.suspend")(input("platform_admin", { params: { id: suspendMe } }));

    const all = (await findHandler(ctx, "platform.tenants.list")(input("platform_admin"))) as JsonOut;
    expect((all.body["data"] as unknown[])).toHaveLength(2);

    const suspended = (await findHandler(ctx, "platform.tenants.list")(
      input("platform_admin", { query: { status: "suspended" } }),
    )) as JsonOut;
    expect((suspended.body["data"] as { slug: string }[]).map((t) => t.slug)).toEqual(["one"]);
  });

  it("paginates with an opaque cursor", async () => {
    const ctx = makeCtx();
    for (const slug of ["aa", "bb", "cc"]) await createdId(ctx, slug);
    const first = (await findHandler(ctx, "platform.tenants.list")(
      input("platform_admin", { query: { limit: "2" } }),
    )) as JsonOut;
    expect((first.body["data"] as unknown[])).toHaveLength(2);
    const cursor = (first.body["page"] as { nextCursor: string | null }).nextCursor;
    expect(cursor).not.toBeNull();
    const second = (await findHandler(ctx, "platform.tenants.list")(
      input("platform_admin", { query: { limit: "2", cursor: cursor as string } }),
    )) as JsonOut;
    expect((second.body["data"] as unknown[])).toHaveLength(1);
    expect((second.body["page"] as { nextCursor: string | null }).nextCursor).toBeNull();
  });
});

describe("platform-admin — get", () => {
  it("200s an existing tenant, 404s a missing one", async () => {
    const ctx = makeCtx();
    const id = await createdId(ctx, "acme");
    const ok = (await findHandler(ctx, "platform.tenants.get")(input("platform_admin", { params: { id } }))) as JsonOut;
    expect(ok.status).toBe(200);
    const miss = (await findHandler(ctx, "platform.tenants.get")(
      input("platform_admin", { params: { id: randomUUID() } }),
    )) as JsonOut;
    expect(miss.status).toBe(404);
  });
});

describe("platform-admin — transitions", () => {
  it("suspends then reactivates an active tenant", async () => {
    const ctx = makeCtx();
    const id = await createdId(ctx, "acme");
    const suspended = (await findHandler(ctx, "platform.tenants.suspend")(input("platform_admin", { params: { id } }))) as JsonOut;
    expect(suspended.status).toBe(200);
    expect((suspended.body["tenant"] as { status: string }).status).toBe("suspended");
    const reactivated = (await findHandler(ctx, "platform.tenants.reactivate")(input("platform_admin", { params: { id } }))) as JsonOut;
    expect((reactivated.body["tenant"] as { status: string }).status).toBe("active");
  });

  it("archives an active tenant", async () => {
    const ctx = makeCtx();
    const id = await createdId(ctx, "acme");
    const out = (await findHandler(ctx, "platform.tenants.archive")(input("platform_admin", { params: { id } }))) as JsonOut;
    expect((out.body["tenant"] as { status: string }).status).toBe("archived");
  });

  it("409s reactivating an already-active tenant", async () => {
    const ctx = makeCtx();
    const id = await createdId(ctx, "acme");
    expect((await findHandler(ctx, "platform.tenants.reactivate")(input("platform_admin", { params: { id } })) as JsonOut).status).toBe(409);
  });

  it("409s suspending an archived tenant", async () => {
    const ctx = makeCtx();
    const id = await createdId(ctx, "acme");
    await findHandler(ctx, "platform.tenants.archive")(input("platform_admin", { params: { id } }));
    expect((await findHandler(ctx, "platform.tenants.suspend")(input("platform_admin", { params: { id } })) as JsonOut).status).toBe(409);
  });

  it("404s a transition on a missing tenant", async () => {
    const ctx = makeCtx();
    expect((await findHandler(ctx, "platform.tenants.suspend")(input("platform_admin", { params: { id: randomUUID() } })) as JsonOut).status).toBe(404);
  });
});

describe("platform-admin — stats", () => {
  it("counts tenants by status", async () => {
    const ctx = makeCtx();
    const a = await createdId(ctx, "one");
    await createdId(ctx, "two");
    const c = await createdId(ctx, "three");
    await findHandler(ctx, "platform.tenants.suspend")(input("platform_admin", { params: { id: a } }));
    await findHandler(ctx, "platform.tenants.archive")(input("platform_admin", { params: { id: c } }));
    const out = (await findHandler(ctx, "platform.stats")(input("platform_admin"))) as JsonOut;
    expect(out.body["counts"]).toEqual({ active: 1, suspended: 1, archived: 1, deleted: 0, total: 3 });
  });
});

describe("platform-admin — auth gating", () => {
  it("401s an unauthenticated caller", async () => {
    const ctx = makeCtx();
    expect((await findHandler(ctx, "platform.tenants.list")(input(null)) as JsonOut).status).toBe(401);
    expect((await create(makeCtx(), {})).status).toBe(400); // sanity: create parses body after guard
    expect((await findHandler(ctx, "platform.tenants.create")(input(null, { body: { slug: "acme", name: "x" } })) as JsonOut).status).toBe(401);
  });

  it("403s a non-platform tenant role", async () => {
    const ctx = makeCtx();
    expect((await findHandler(ctx, "platform.tenants.list")(input("erp_admin")) as JsonOut).status).toBe(403);
    expect((await findHandler(ctx, "platform.stats")(input("erp_admin")) as JsonOut).status).toBe(403);
  });
});
