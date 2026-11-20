import type { PgConnection } from "@crossengin/kernel-pg";
import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import type { HandlerInput, HandlerOutput } from "@crossengin/api-gateway-runtime";
import { generateEd25519Keypair } from "@crossengin/crypto";
import {
  PackManifestSchema,
  PackPublisherRegistry,
  parsePackPublisherSpec,
  signPackRelease,
  type TenantContext,
} from "@crossengin/marketplace";
import { PersistentMarketplaceInstallEngine, PostgresInstallationStore } from "@crossengin/marketplace-runtime-pg";
import { describe, expect, it } from "vitest";

import {
  InMemoryPackCatalog,
  buildMarketplaceAdminRoutes,
  buildPackInstallHandler,
  buildPackListHandler,
  buildPackUninstallHandler,
  formatPackCatalogSurvey,
  loadPackCatalog,
  surveyPackCatalog,
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

const KEY = generateEd25519Keypair();
const PUBLISHERS = new PackPublisherRegistry([
  parsePackPublisherSpec(`com.crossengin:crossengin_official:${KEY.publicKeyBase64}`),
]);
const KNOWN: TenantContext = {
  platformVersion: "1.2.0",
  region: "us-east",
  planTier: "professional",
  compliancePacks: [],
  isDedicatedTenant: false,
};

const BUNDLE_SHA = "a".repeat(64);

function catalogEntry(overrides: Record<string, unknown> = {}, kp = KEY): PackCatalogEntry {
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
  const signature = signPackRelease({
    manifest: pack,
    version: "1.0.0",
    bundleSha256: BUNDLE_SHA,
    privateKeyBase64: kp.privateKeyBase64,
    publicKeyBase64: kp.publicKeyBase64,
    signedAt: "2026-05-16T12:00:00.000Z",
  });
  return {
    pack,
    version: "1.0.0",
    bundleSha256: BUNDLE_SHA,
    signature,
    compatibility: { minPlatformVersion: "1.0.0", allowedRegions: [], blockedRegions: [], requiredCompliancePacks: [], requiresDedicatedTenant: false },
    securityReviewStatus: "passed",
  };
}

function makeCtx(
  entries: readonly PackCatalogEntry[],
  tenantContext: (tenantId: string) => Promise<TenantContext> = async () => KNOWN,
): MarketplaceAdminContext {
  const conn = fakePg();
  const store = new PostgresInstallationStore(conn);
  return {
    engine: new PersistentMarketplaceInstallEngine(store),
    store,
    catalog: new InMemoryPackCatalog(entries),
    publishers: PUBLISHERS,
    principalRoles: (p: ResolvedPrincipal | null) => ({ primaryRole: p?.grantedScopes[0] ?? "anon" }),
    adminRoles: new Set(["erp_admin"]),
    tenantContext,
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
  it("rejects an entry with no bundle digest, which the signed release must name", () => {
    const { bundleSha256: _bundle, ...noBundle } = catalogEntry();
    expect(() => loadPackCatalog(JSON.stringify({ packs: [noBundle] }))).toThrow(/bundleSha256/);
  });
  it("loads a catalog written before the registry when its stated key did produce the signature", () => {
    const legacy = { ...catalogEntry(), publisherPublicKeyBase64: KEY.publicKeyBase64 };
    expect(loadPackCatalog(JSON.stringify({ packs: [legacy] })).list()).toHaveLength(1);
  });
  it("refuses a catalog entry stating a key other than the one that signed it", () => {
    const wrong = { ...catalogEntry(), publisherPublicKeyBase64: generateEd25519Keypair().publicKeyBase64 };
    expect(() => loadPackCatalog(JSON.stringify({ packs: [wrong] }))).toThrow(/did not produce its signature/);
  });
});

describe("surveyPackCatalog", () => {
  it("names the entries the registry will refuse, and only those", () => {
    const stranger = catalogEntry({ id: "com.crossengin.other" }, generateEd25519Keypair());
    const findings = surveyPackCatalog(new InMemoryPackCatalog([catalogEntry(), stranger]), PUBLISHERS);
    expect(findings.map((f) => [f.packId, f.refusal])).toEqual([["com.crossengin.other", "publisher_unregistered"]]);
  });

  it("names a catalog entry filed under a version or bundle its release does not name, and a manifest-only signature", () => {
    const entry = catalogEntry();
    const { release: _release, ...legacySignature } = entry.signature;
    const findings = surveyPackCatalog(
      new InMemoryPackCatalog([
        { ...entry, version: "1.0.1" },
        { ...entry, bundleSha256: "b".repeat(64) },
        { ...entry, signature: legacySignature },
      ]),
      PUBLISHERS,
    );
    expect(findings.map((f) => f.refusal)).toEqual([
      "release_version_mismatch",
      "release_bundle_mismatch",
      "legacy_signature_form",
    ]);
  });
});

describe("formatPackCatalogSurvey", () => {
  it("counts a release-mismatched entry as refused, not as unsigned, and never says 'signed by'", () => {
    // Entry 2 carries a signature that verifies against a registered key over 1.0.0 while filed as
    // 2.0.0; it is refused at install, but calling it "not signed by a registered publisher" would
    // be false — so the headline names what it measures.
    const entry = catalogEntry();
    const catalog = new InMemoryPackCatalog([entry, { ...entry, version: "2.0.0" }]);
    const findings = surveyPackCatalog(catalog, PUBLISHERS);
    expect(findings.map((f) => f.refusal)).toEqual(["release_version_mismatch"]);
    const line = formatPackCatalogSurvey(catalog.list().length, findings);
    expect(line).toBe("[marketplace] pack catalog: 2 version(s), 1 installable as catalogued, 1 refused at install");
    expect(line).not.toMatch(/signed by/);
  });
});

describe("buildPackInstallHandler — the signed release", () => {
  it("409s installing a catalog version the publisher did not sign", async () => {
    const ctx = makeCtx([{ ...catalogEntry(), version: "2.0.0" }]);
    const out = await buildPackInstallHandler(ctx)(input("erp_admin", { packId: "com.crossengin.example", version: "2.0.0" }));
    expect(out.status).toBe(409);
    expect(bodyOf(out)["reason"]).toBe("release_version_mismatch");
  });

  it("refuses at boot and at install a catalog line whose version and signed claim were both rewritten (ADR-0459)", async () => {
    // ADR-0454 measured that a stored row edited in both places reads as a valid release. Install's
    // input is re-verified against the registry at every admission, so the same edit on a catalog
    // line fails the Ed25519 check — named at boot and refused at install, with nothing recorded.
    const entry = catalogEntry();
    const rewritten: PackCatalogEntry = {
      ...entry,
      version: "9.9.9",
      signature: { ...entry.signature, release: { ...entry.signature.release!, version: "9.9.9" } },
    };
    const catalog = new InMemoryPackCatalog([entry, rewritten]);
    const findings = surveyPackCatalog(catalog, PUBLISHERS);
    expect(findings).toMatchObject([{ version: "9.9.9", refusal: "signature_invalid" }]);
    expect(formatPackCatalogSurvey(catalog.list().length, findings)).toContain("1 installable as catalogued, 1 refused at install");

    const ctx = makeCtx([entry, rewritten]);
    const out = await buildPackInstallHandler(ctx)(input("erp_admin", { packId: "com.crossengin.example", version: "9.9.9" }));
    expect(out.status).toBe(409);
    expect(bodyOf(out)["reason"]).toBe("signature_invalid");
    expect((await ctx.store.listForTenant(TENANT)).records).toHaveLength(0);
    // Control: the untouched 1.0.0 installs, so the zero above is a refusal and not a broken read.
    const ok = await buildPackInstallHandler(ctx)(input("erp_admin", { packId: "com.crossengin.example", version: "1.0.0" }));
    expect(ok.status).toBe(201);
    expect((await ctx.store.listForTenant(TENANT)).records).toHaveLength(1);
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
    // The response says what an install is here, so it cannot be read as more.
    expect(bodyOf(out).effect).toMatchObject({ executesPack: false, grantsConsulted: false });
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

  it("refuses a pack whose signer is not a registered publisher, however valid its signature", async () => {
    const stranger = catalogEntry({}, generateEd25519Keypair());
    const out = await buildPackInstallHandler(makeCtx([stranger]))(
      input("erp_admin", { packId: "com.crossengin.example", version: "1.0.0" }),
    );
    expect(out.status).toBe(409);
    expect(bodyOf(out).reason).toBe("publisher_unregistered");
  });

  it("asks the caller's own tenant's facts, so a region-blocked pack is refused for an EU tenant", async () => {
    const asked: string[] = [];
    const euBlocked = {
      ...catalogEntry(),
      compatibility: {
        minPlatformVersion: "1.0.0",
        allowedRegions: [],
        blockedRegions: ["eu-central" as const],
        requiredCompliancePacks: [],
        requiresDedicatedTenant: false,
      },
    };
    const ctx = makeCtx([euBlocked], async (tenantId) => {
      asked.push(tenantId);
      return { ...KNOWN, region: "eu-central" };
    });
    const out = await buildPackInstallHandler(ctx)(input("erp_admin", { packId: "com.crossengin.example", version: "1.0.0" }));
    expect(asked).toEqual([TENANT]);
    expect(out.status).toBe(409);
    expect(bodyOf(out).reason).toBe("incompatible");
    expect(bodyOf(out).reasons).toEqual(["region 'eu-central' is blocked"]);
  });

  it("refuses a region-blocked pack when the tenant's region is unknown, rather than guessing one", async () => {
    const euBlocked = {
      ...catalogEntry(),
      compatibility: {
        minPlatformVersion: "1.0.0",
        allowedRegions: [],
        blockedRegions: ["eu-central" as const],
        requiredCompliancePacks: [],
        requiresDedicatedTenant: false,
      },
    };
    const ctx = makeCtx([euBlocked], async () => ({ ...KNOWN, region: null }));
    const out = await buildPackInstallHandler(ctx)(input("erp_admin", { packId: "com.crossengin.example", version: "1.0.0" }));
    expect(out.status).toBe(409);
    expect(bodyOf(out).reason).toBe("incompatible");
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

  it("uninstalls a recorded install no installer completed, and the pack can then be installed again", async () => {
    // This pinned a 409 before: an admitted install sits in `installing` and nothing here runs a
    // pack, so the route that could only uninstall from `installed` left every install stuck and
    // every reinstall `already_installed`.
    const ctx = makeCtx([catalogEntry()]);
    const installed = await buildPackInstallHandler(ctx)(input("erp_admin", { packId: "com.crossengin.example", version: "1.0.0" }));
    const id = (bodyOf(installed).installation as { id: string }).id;
    const out = await buildPackUninstallHandler(ctx)(input("erp_admin", undefined, { id }));
    expect(out.status).toBe(200);
    expect(bodyOf(out).status).toBe("uninstalled");
    const again = await buildPackInstallHandler(ctx)(input("erp_admin", { packId: "com.crossengin.example", version: "1.0.0" }));
    expect(again.status).toBe(201);
  });

  it("409 for uninstalling what is already uninstalled", async () => {
    const ctx = makeCtx([catalogEntry()]);
    const installed = await buildPackInstallHandler(ctx)(input("erp_admin", { packId: "com.crossengin.example", version: "1.0.0" }));
    const id = (bodyOf(installed).installation as { id: string }).id;
    await buildPackUninstallHandler(ctx)(input("erp_admin", undefined, { id }));
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
