import type { PgConnection } from "@crossengin/kernel-pg";
import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import type { HandlerInput, HandlerOutput } from "@crossengin/api-gateway-runtime";
import { generateEd25519Keypair } from "@crossengin/crypto";
import { PackManifestSchema, signPackManifest } from "@crossengin/marketplace";
import { PersistentMarketplaceInstallEngine, PostgresInstallationStore } from "@crossengin/marketplace-runtime-pg";
import { describe, expect, it } from "vitest";

import {
  InMemoryPackCatalog,
  buildMarketplaceAdminRoutes,
  buildPackInstallHandler,
  buildPackListHandler,
  buildPackUninstallHandler,
  loadPackCatalog,
  type MarketplaceAdminContext,
  type PackCatalogEntry,
} from "./marketplace-admin.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const ADMIN = "00000000-0000-4000-8000-0000000000aa";

/** A minimal fake PgConnection over an in-memory row map keyed by installation id. */
function fakePg(): PgConnection {
  const rows = new Map<string, Record<string, unknown>>();
  let ctx: string | null = null;
  const run = async (sql: string, params?: readonly unknown[]) => {
    const p = params ?? [];
    if (sql.includes("set_config")) {
      ctx = String(p[0]);
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("INSERT INTO")) {
      rows.set(String(p[0]), {
        id: p[0], tenant_id: p[1], pack_id: p[2], installed_version: p[3] ?? null, pinned_version: p[4] ?? null,
        status: p[5], update_policy: p[6], config: JSON.parse(String(p[7])), permission_grants: JSON.parse(String(p[8])),
        requested_at: p[9], requested_by: p[10], installed_at: p[11] ?? null, installed_by: p[12] ?? null,
        last_updated_at: p[13] ?? null, uninstalled_at: p[14] ?? null, uninstalled_by: p[15] ?? null,
        failure_reason: p[16] ?? null, isolation_sandbox: p[17] ?? null,
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SELECT")) {
      let visible = [...rows.values()].filter((r) => ctx !== null && r.tenant_id === ctx && r.tenant_id === p[0]);
      if (sql.includes("AND id = $2")) visible = visible.filter((r) => r.id === p[1]);
      return { rows: visible, rowCount: visible.length };
    }
    return { rows: [], rowCount: 0 };
  };
  const conn: PgConnection = {
    query: run as PgConnection["query"],
    transaction: (async <T>(fn: (tx: PgConnection) => Promise<T>) => {
      const before = ctx;
      try {
        return await fn(conn);
      } finally {
        ctx = before;
      }
    }) as PgConnection["transaction"],
    withAdvisoryLock: (async <T>(_k: bigint, fn: () => Promise<T>) => fn()) as PgConnection["withAdvisoryLock"],
    close: (async () => undefined) as PgConnection["close"],
  };
  return conn;
}

function catalogEntry(overrides: Record<string, unknown> = {}): PackCatalogEntry {
  const pack = PackManifestSchema.parse({
    id: "com.crossengin.example",
    name: "Example Pack",
    description: "A test pack",
    kind: "vertical_template",
    author: { kind: "crossengin_official", name: "CrossEngin", contactEmail: "t@example.com", verifiedAt: "2026-01-01T00:00:00.000Z" },
    license: "MIT",
    minPlatformVersion: "1.0.0",
    ...overrides,
  });
  const kp = generateEd25519Keypair();
  const signature = signPackManifest({ manifest: pack, privateKeyBase64: kp.privateKeyBase64, publicKeyBase64: kp.publicKeyBase64, signedAt: "2026-05-16T12:00:00.000Z" });
  return {
    pack,
    version: "1.0.0",
    signature,
    publisherPublicKeyBase64: kp.publicKeyBase64,
    compatibility: { minPlatformVersion: "1.0.0", allowedRegions: [], blockedRegions: [], requiredCompliancePacks: [], requiresDedicatedTenant: false },
    securityReviewStatus: "passed",
  };
}

function makeCtx(entries: readonly PackCatalogEntry[]): MarketplaceAdminContext {
  const conn = fakePg();
  const store = new PostgresInstallationStore(conn);
  return {
    engine: new PersistentMarketplaceInstallEngine(store),
    store,
    catalog: new InMemoryPackCatalog(entries),
    principalRoles: (p: ResolvedPrincipal | null) => ({ primaryRole: p?.grantedScopes[0] ?? "anon" }),
    adminRoles: new Set(["erp_admin"]),
    tenantContext: { platformVersion: "1.2.0", region: "us-east", planTier: "professional", compliancePacks: [], isDedicatedTenant: false },
  };
}

function principal(role: string | null): ResolvedPrincipal | null {
  if (role === null) return null;
  return {
    principalId: ADMIN, tenantId: TENANT, principalKind: "user", authScheme: "api_key_header",
    grantedScopes: [role], mfaProofAgeSeconds: null, resolvedAt: "2026-05-16T12:00:00.000Z",
  } as ResolvedPrincipal;
}

function input(role: string | null, body?: Record<string, unknown>, params: Record<string, string> = {}): HandlerInput {
  return { request: {} as never, route: {} as never, principal: principal(role), params, parsedBody: body ?? null };
}
function bodyOf(out: HandlerOutput): Record<string, unknown> {
  return out.kind === "json" ? (out.body as Record<string, unknown>) : {};
}

describe("loadPackCatalog", () => {
  it("parses a catalog document", () => {
    const cat = loadPackCatalog(JSON.stringify({ packs: [catalogEntry()] }));
    expect(cat.get("com.crossengin.example", "1.0.0")?.version).toBe("1.0.0");
    expect(cat.list()).toHaveLength(1);
  });
  it("rejects a malformed catalog", () => {
    expect(() => loadPackCatalog(JSON.stringify({ packs: [{ pack: {} }] }))).toThrow();
  });
});

describe("buildPackInstallHandler", () => {
  it("401 without a principal, 403 for a non-admin", async () => {
    const ctx = makeCtx([catalogEntry()]);
    const h = buildPackInstallHandler(ctx);
    expect((await h(input(null, { packId: "com.crossengin.example", version: "1.0.0" }))).status).toBe(401);
    expect((await h(input("cashier", { packId: "com.crossengin.example", version: "1.0.0" }))).status).toBe(403);
  });

  it("404 for a pack not in the catalog", async () => {
    const h = buildPackInstallHandler(makeCtx([catalogEntry()]));
    const out = await h(input("erp_admin", { packId: "com.crossengin.absent", version: "9.9.9" }));
    expect(out.status).toBe(404);
    expect(bodyOf(out).error).toBe("pack_not_found");
  });

  it("400 for a malformed body", async () => {
    const h = buildPackInstallHandler(makeCtx([catalogEntry()]));
    expect((await h(input("erp_admin", { version: "1.0.0" }))).status).toBe(400);
  });

  it("installs a catalog pack for the admin's tenant", async () => {
    const ctx = makeCtx([catalogEntry()]);
    const out = await buildPackInstallHandler(ctx)(input("erp_admin", { packId: "com.crossengin.example", version: "1.0.0" }));
    expect(out.status).toBe(201);
    expect(bodyOf(out).status).toBe("admitted");
    // persisted + visible via the list route
    const list = await buildPackListHandler(ctx)(input("erp_admin"));
    expect((bodyOf(list).data as unknown[])).toHaveLength(1);
  });

  it("rejects a second install of the same pack (persisted state)", async () => {
    const ctx = makeCtx([catalogEntry()]);
    await buildPackInstallHandler(ctx)(input("erp_admin", { packId: "com.crossengin.example", version: "1.0.0" }));
    const second = await buildPackInstallHandler(ctx)(input("erp_admin", { packId: "com.crossengin.example", version: "1.0.0" }));
    expect(second.status).toBe(409);
    expect(bodyOf(second).reason).toBe("already_installed");
  });
});

describe("buildPackUninstallHandler", () => {
  it("404 for an unknown installation, then uninstalls an installed pack", async () => {
    const ctx = makeCtx([catalogEntry()]);
    expect((await buildPackUninstallHandler(ctx)(input("erp_admin", undefined, { id: "nope" }))).status).toBe(404);

    const installed = await buildPackInstallHandler(ctx)(input("erp_admin", { packId: "com.crossengin.example", version: "1.0.0" }));
    const id = (bodyOf(installed).installation as { id: string }).id;
    // Simulate the install execution finishing (installing → installed) so it becomes uninstallable.
    const record = await ctx.store.get(TENANT, id);
    await ctx.engine.complete(record!, "1.0.0", ADMIN);

    const out = await buildPackUninstallHandler(ctx)(input("erp_admin", undefined, { id }));
    expect(out.status).toBe(200);
    expect(bodyOf(out).status).toBe("uninstalled");
  });

  it("409 when uninstalling a pack mid-install (installing → uninstall not allowed)", async () => {
    const ctx = makeCtx([catalogEntry()]);
    const installed = await buildPackInstallHandler(ctx)(input("erp_admin", { packId: "com.crossengin.example", version: "1.0.0" }));
    const id = (bodyOf(installed).installation as { id: string }).id;
    const out = await buildPackUninstallHandler(ctx)(input("erp_admin", undefined, { id }));
    expect(out.status).toBe(409);
    expect(bodyOf(out).error).toBe("invalid_transition");
  });
});

describe("buildMarketplaceAdminRoutes", () => {
  it("derives the three admin routes", () => {
    const routes = buildMarketplaceAdminRoutes(makeCtx([]));
    expect(routes.map((r) => r.route.operationId).sort()).toEqual([
      "admin.packs.install",
      "admin.packs.list",
      "admin.packs.uninstall",
    ]);
    const uninstall = routes.find((r) => r.route.operationId === "admin.packs.uninstall");
    expect(uninstall?.route.pathSegments.some((s) => s.kind === "parameter" && s.name === "id")).toBe(true);
  });
});
