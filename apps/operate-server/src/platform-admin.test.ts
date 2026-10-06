import { randomUUID } from "node:crypto";

import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import type { Handler, HandlerInput, HandlerOutput } from "@crossengin/api-gateway-runtime";
import type { PgConnection } from "@crossengin/kernel-pg";
import { PostgresLifecycleEventStore } from "@crossengin/tenant-lifecycle-pg";
import { describe, expect, it } from "vitest";

import {
  CONSOLE_ACTION,
  PostgresTenantStore,
  TransitionTenantBodySchema,
  buildPlatformAdminRoutes,
  consoleActionsNeedNoApprover,
  type PlatformAdminContext,
} from "./platform-admin.js";
import { TENANT_STATUSES, TENANT_STATUS_TRANSITIONS } from "./platform-tenants.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-0000000000aa";
const EVENT_ID = "9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f";

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
    // Anchored, not `includes`: `transitionStatus` reads the state it is about to move the row out
    // of with `SELECT status … FOR UPDATE`, and an `includes("UPDATE")` match would route that read
    // into the write branch — a fake answering a statement it could not really serve (ADR-0334).
    if (/^\s*UPDATE/i.test(sql)) {
      const row = rows.get(String(p[0]));
      if (row === undefined) return { rows: [], rowCount: 0 };
      // `transitionStatus` puts its source states in the predicate (ADR-0321's "the row is the
      // lock"), so the fake has to apply it. A fake that silently ignored the `status IN (…)` would
      // make a guarded write and an unguarded one indistinguishable — which is exactly the blind
      // spot ADR-0333 found, and `fakeCertificationPg` ignoring `tenant_id` is its other instance.
      if (sql.includes("AND status IN (")) {
        const allowed = p.slice(2).map((s) => String(s));
        if (!allowed.includes(String(row["status"]))) return { rows: [], rowCount: 0 };
      }
      row["status"] = String(p[1]);
      row["updated_at"] = new Date();
      // A **copy**, because a driver hands back values and not a live handle into the table. The
      // live object made `transitionStatus`' pre-write read see the status the write had just put
      // there, so the previous state it reported was the new one — a fake lying in the direction
      // that would have made a wrong `fromState` invisible.
      return { rows: [{ ...row }], rowCount: 1 };
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
      return { rows: row === undefined ? [] : [{ ...row }], rowCount: row === undefined ? 0 : 1 };
    }
    if (sql.includes("WHERE slug = $1")) {
      const row = [...rows.values()].find((r) => r["slug"] === p[0]);
      return { rows: row === undefined ? [] : [{ ...row }], rowCount: row === undefined ? 0 : 1 };
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
      const page = visible.slice(offset, offset + limit).map((r) => ({ ...r }));
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
    await findHandler(ctx, "platform.tenants.suspend")(input("platform_admin", { params: { id: suspendMe }, body: { reason: "operator request" } }));

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
    const ok = (await findHandler(ctx, "platform.tenants.get")(input("platform_admin", { params: { id }, body: { reason: "operator request" } }))) as JsonOut;
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
    const suspended = (await findHandler(ctx, "platform.tenants.suspend")(input("platform_admin", { params: { id }, body: { reason: "operator request" } }))) as JsonOut;
    expect(suspended.status).toBe(200);
    expect((suspended.body["tenant"] as { status: string }).status).toBe("suspended");
    const reactivated = (await findHandler(ctx, "platform.tenants.reactivate")(input("platform_admin", { params: { id }, body: { reason: "operator request" } }))) as JsonOut;
    expect((reactivated.body["tenant"] as { status: string }).status).toBe("active");
  });

  it("archives an active tenant", async () => {
    const ctx = makeCtx();
    const id = await createdId(ctx, "acme");
    const out = (await findHandler(ctx, "platform.tenants.archive")(input("platform_admin", { params: { id }, body: { reason: "operator request" } }))) as JsonOut;
    expect((out.body["tenant"] as { status: string }).status).toBe("archived");
  });

  it("409s reactivating an already-active tenant", async () => {
    const ctx = makeCtx();
    const id = await createdId(ctx, "acme");
    expect((await findHandler(ctx, "platform.tenants.reactivate")(input("platform_admin", { params: { id }, body: { reason: "operator request" } })) as JsonOut).status).toBe(409);
  });

  it("409s suspending an archived tenant", async () => {
    const ctx = makeCtx();
    const id = await createdId(ctx, "acme");
    await findHandler(ctx, "platform.tenants.archive")(input("platform_admin", { params: { id }, body: { reason: "operator request" } }));
    expect((await findHandler(ctx, "platform.tenants.suspend")(input("platform_admin", { params: { id }, body: { reason: "operator request" } })) as JsonOut).status).toBe(409);
  });

  it("404s a transition on a missing tenant", async () => {
    const ctx = makeCtx();
    expect((await findHandler(ctx, "platform.tenants.suspend")(input("platform_admin", { params: { id: randomUUID() }, body: { reason: "operator request" } })) as JsonOut).status).toBe(404);
  });
});

describe("platform-admin — stats", () => {
  it("counts tenants by status", async () => {
    const ctx = makeCtx();
    const a = await createdId(ctx, "one");
    await createdId(ctx, "two");
    const c = await createdId(ctx, "three");
    await findHandler(ctx, "platform.tenants.suspend")(input("platform_admin", { params: { id: a }, body: { reason: "operator request" } }));
    await findHandler(ctx, "platform.tenants.archive")(input("platform_admin", { params: { id: c }, body: { reason: "operator request" } }));
    const out = (await findHandler(ctx, "platform.stats")(input("platform_admin"))) as JsonOut;
    // Every declared status appears with a zero rather than being absent, and the keys are derived
    // from `TENANT_STATUSES` — so adding a state to the contract shows up here as a failing
    // assertion rather than as a tally that quietly stops adding up. `pending_deletion` is the
    // state ADR-0334 added; a console cannot reach it, which is why it is 0 here.
    expect(out.body["counts"]).toEqual({
      active: 1,
      suspended: 1,
      archived: 1,
      pending_deletion: 0,
      deleted: 0,
      total: 3,
    });
  });

  it("tallies every declared status, so a new state cannot go uncounted", () => {
    // The defect this pins: the tally was four hand-written keys against an enum that grew to five,
    // and a missing key makes `total` disagree with the sum of the parts.
    const counted = Object.keys({
      active: 0,
      suspended: 0,
      archived: 0,
      pending_deletion: 0,
      deleted: 0,
    }).sort();
    expect(counted).toEqual([...TENANT_STATUSES].sort());
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

describe("PostgresTenantStore.transitionStatus", () => {
  async function seeded(): Promise<PostgresTenantStore> {
    const store = new PostgresTenantStore(fakePg());
    await store.create({ slug: "acme", name: "Acme", tier: "small", region: "eu", searchLocale: "english" });
    return store;
  }

  async function idOf(store: PostgresTenantStore): Promise<string> {
    const page = await store.list();
    const row = page.data[0];
    if (row === undefined) throw new Error("no seeded tenant");
    return row.id;
  }

  it("moves a row whose current status is in the source set", async () => {
    const store = await seeded();
    const id = await idOf(store);
    const moved = await store.transitionStatus(id, "pending_deletion", ["active", "suspended"]);
    expect(moved?.tenant.status).toBe("pending_deletion");
    // The state it moved *out of*, which `RETURNING` cannot answer and the lifecycle trail requires:
    // the predicate's candidate list has two members and does not say which one matched.
    expect(moved?.previousStatus).toBe("active");
  });

  it("matches no row when the current status is outside the source set", async () => {
    const store = await seeded();
    const id = await idOf(store);
    await store.transitionStatus(id, "pending_deletion", ["active"]);
    // A second attempt starts from `pending_deletion`, which is not a source — so the row is the
    // lock and the caller's premise is refused rather than overwritten.
    expect(await store.transitionStatus(id, "pending_deletion", ["active"])).toBeNull();
  });

  it("restores only from pending_deletion", async () => {
    const store = await seeded();
    const id = await idOf(store);
    expect(await store.transitionStatus(id, "active", ["pending_deletion"])).toBeNull();
    await store.transitionStatus(id, "pending_deletion", ["active"]);
    const restored = await store.transitionStatus(id, "active", ["pending_deletion"]);
    expect(restored?.tenant.status).toBe("active");
    expect(restored?.previousStatus).toBe("pending_deletion");
  });

  it("matches no row for an unknown id", async () => {
    const store = await seeded();
    expect(await store.transitionStatus(TENANT, "suspended", ["active"])).toBeNull();
  });

  it("refuses an empty source set without issuing a statement", async () => {
    const store = await seeded();
    const id = await idOf(store);
    // An empty `IN ()` is a syntax error in Postgres, and an empty source set means "no transition
    // is permitted" — so it is answered here rather than sent.
    expect(await store.transitionStatus(id, "deleted", [])).toBeNull();
    expect((await store.getById(id))?.status).toBe("active");
  });
});

describe("CONSOLE_ACTION", () => {
  it("is total over TENANT_STATUSES, so a sixth state is a compile error", () => {
    expect(Object.keys(CONSOLE_ACTION).sort()).toEqual([...TENANT_STATUSES].sort());
    expect(Object.isFrozen(CONSOLE_ACTION)).toBe(true);
  });

  it("names an action for every state the console can actually reach", () => {
    // Derived from the console's own transition map rather than from a hand list: a target with no
    // action would be a console button that moves a tenant and records nothing.
    const reachable = new Set(TENANT_STATUSES.flatMap((f) => [...TENANT_STATUS_TRANSITIONS[f]]));
    expect([...reachable].sort()).toEqual(["active", "archived", "suspended"]);
    for (const to of reachable) expect(CONSOLE_ACTION[to]).not.toBeNull();
  });

  it("declares null for the two states no console transition targets", () => {
    // `deleted` is the Article 17 flow's terminus; `pending_deletion` is reached by *verifying* a
    // deletion request, under four-eyes and a named verifier, and that route records it itself.
    const reachable = new Set(TENANT_STATUSES.flatMap((f) => [...TENANT_STATUS_TRANSITIONS[f]]));
    for (const s of TENANT_STATUSES) {
      if (!reachable.has(s)) expect(CONSOLE_ACTION[s]).toBeNull();
    }
    expect(CONSOLE_ACTION["pending_deletion"]).toBeNull();
    expect(CONSOLE_ACTION["deleted"]).toBeNull();
  });

  it("maps each reachable state to the action whose target state it is", () => {
    expect(CONSOLE_ACTION["active"]).toBe("activate");
    expect(CONSOLE_ACTION["suspended"]).toBe("suspend");
    expect(CONSOLE_ACTION["archived"]).toBe("archive");
  });

  it("holds no action that would need an approver under platform_admin", () => {
    // The four-eyes refusal this route must never hit: `actionRequiresFourEyes` demands approval for
    // `schedule_deletion` under `platform_admin`, and the console collects no approver — so a
    // `pending_deletion: "schedule_deletion"` entry would make `lifecycleEventFor` refuse every such
    // transition. The implication is pinned, not the entry, so adding one fails with the reason.
    expect(consoleActionsNeedNoApprover()).toEqual([]);
  });
});

describe("the console transition body", () => {
  it("requires a reason", async () => {
    const ctx = makeCtx();
    const id = await createdId(ctx, "acme");
    const out = (await findHandler(ctx, "platform.tenants.suspend")(
      input("platform_admin", { params: { id } }),
    )) as JsonOut;
    // A caller-visible change: the route took no body at all. `LifecycleEvent.reason` is
    // `z.string().min(1)` with no default, and "(none given)" in the permanent record of why a
    // tenant lost access is ADR-0317's silence deciding what a record says.
    expect(out.status).toBe(400);
    expect(String(out.body["error"])).toBe("invalid_request");
  });

  it("rejects an empty reason and an unknown field", () => {
    expect(TransitionTenantBodySchema.safeParse({ reason: "" }).success).toBe(false);
    expect(TransitionTenantBodySchema.safeParse({ reason: "x", approvedBy: "y" }).success).toBe(false);
    expect(TransitionTenantBodySchema.safeParse({ reason: "x" }).success).toBe(true);
  });
});

describe("the console's lifecycle trail", () => {
  function trailCtx(opts: { readonly throws?: boolean } = {}): {
    readonly ctx: PlatformAdminContext;
    readonly statements: Array<{ sql: string; params: readonly unknown[] }>;
    readonly errors: string[];
  } {
    const statements: Array<{ sql: string; params: readonly unknown[] }> = [];
    const errors: string[] = [];
    const trail: PgConnection = {
      query: (async (sql: string, params?: readonly unknown[]) => {
        statements.push({ sql, params: params ?? [] });
        if (opts.throws === true) throw new Error("relation does not exist");
        return { rows: [], rowCount: 1 };
      }) as PgConnection["query"],
      transaction: (async <T>(fn: (tx: PgConnection) => Promise<T>) => fn(trail)) as PgConnection["transaction"],
      withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) => fn()) as PgConnection["withAdvisoryLock"],
      close: (async () => undefined) as PgConnection["close"],
    };
    return {
      ctx: {
        ...makeCtx(),
        lifecycleEvents: new PostgresLifecycleEventStore(trail),
        newEventId: () => EVENT_ID,
        clock: () => new Date("2026-10-03T13:00:00.000Z"),
        onLifecycleError: (_err, action): void => {
          errors.push(action);
        },
      },
      statements,
      errors,
    };
  }

  const insertOf = (
    statements: Array<{ sql: string; params: readonly unknown[] }>,
  ): { sql: string; params: readonly unknown[] } | undefined =>
    statements.find((s) => s.sql.includes("INSERT INTO meta.tenant_lifecycle_events"));

  async function suspend(ctx: PlatformAdminContext, id: string): Promise<JsonOut> {
    return (await findHandler(ctx, "platform.tenants.suspend")(
      input("platform_admin", { params: { id }, body: { reason: "non-payment" } }),
    )) as JsonOut;
  }

  it("appends the action, the state it moved out of and the platform_admin trigger", async () => {
    const t = trailCtx();
    const id = await createdId(t.ctx, "acme");
    const out = await suspend(t.ctx, id);
    expect(out.status).toBe(200);
    expect(out.body["lifecycleRecorded"]).toBe(true);
    const p = insertOf(t.statements)?.params ?? [];
    expect(p[0]).toBe(EVENT_ID);
    expect(p[1]).toBe(id);
    expect(p[2]).toBe("suspend");
    expect(p[3]).toBe("active");
    expect(p[4]).toBe("suspended");
    expect(p[5]).toBe("platform_admin");
    expect(p[7]).toBe(USER);
    expect(p[9]).toBe("non-payment");
    // No approver, and none required: the four-eyes columns stay null rather than being filled with
    // the actor, which `assertAppendable` would refuse as `four_eyes_violated`.
    expect(p[12]).toBe(false);
    expect(p[13]).toBeNull();
  });

  it("still 200s when the append fails, and reports lifecycleRecorded: false", async () => {
    const t = trailCtx({ throws: true });
    const id = await createdId(t.ctx, "acme");
    const out = await suspend(t.ctx, id);
    // The tenant really is suspended. A 5xx would report a transition that happened as one that
    // did not — ADR-0320's rule, as for `tenantRetired`.
    expect(out.status).toBe(200);
    expect((out.body["tenant"] as { status: string }).status).toBe("suspended");
    expect(out.body["lifecycleRecorded"]).toBe(false);
    expect(t.errors).toEqual(["suspend"]);
  });

  it("reports lifecycleRecorded: null when no trail store is configured", async () => {
    const ctx = makeCtx();
    const id = await createdId(ctx, "acme");
    const out = await suspend(ctx, id);
    expect(out.status).toBe(200);
    // `null` is "this deployment keeps no trail", not "the write failed" — the one distinction the
    // table exists to make.
    expect(out.body["lifecycleRecorded"]).toBeNull();
  });

  it("records nothing when the transition is refused", async () => {
    const t = trailCtx();
    const id = await createdId(t.ctx, "acme");
    await findHandler(t.ctx, "platform.tenants.archive")(
      input("platform_admin", { params: { id }, body: { reason: "wound down" } }),
    );
    t.statements.length = 0;
    const out = await suspend(t.ctx, id);
    expect(out.status).toBe(409);
    expect(insertOf(t.statements)).toBeUndefined();
  });

  it("issues a plain INSERT, because the trail is append-only", async () => {
    const t = trailCtx();
    const id = await createdId(t.ctx, "acme");
    await suspend(t.ctx, id);
    const sql = insertOf(t.statements)?.sql ?? "";
    expect(sql.startsWith("INSERT INTO")).toBe(true);
    expect(sql.toUpperCase()).not.toContain("DO UPDATE");
  });
});
