import type { PgConnection } from "@crossengin/kernel-pg";
import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import type { HandlerInput, HandlerOutput } from "@crossengin/api-gateway-runtime";
import { generateEd25519Keypair } from "@crossengin/crypto";
import { PackManifestSchema, signPackManifest, type PackManifest } from "@crossengin/marketplace";
import {
  PostgresPackVersionStore,
  buildPersistentPackSubmissionEngine,
} from "@crossengin/marketplace-runtime-pg";
import { describe, expect, it } from "vitest";

import {
  buildMarketplaceAuthoringRoutes,
  buildSubmitHandler,
  type MarketplaceAuthoringContext,
} from "./marketplace-authoring.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-0000000000aa";
const SHA = "a".repeat(64);
const keypair = generateEd25519Keypair();

/** A fake PgConnection over the platform-wide pack_versions table (no tenant context). */
function fakePg(): PgConnection {
  const rows = new Map<string, Record<string, unknown>>();
  const run = async (sql: string, params?: readonly unknown[]) => {
    const p = params ?? [];
    if (sql.includes("INSERT INTO")) {
      rows.set(`${String(p[0])}|${String(p[1])}`, {
        pack_id: p[0], version: p[1], status: p[2], channel: p[3], bundle_sha256: p[4], bundle_size_bytes: p[5],
        manifest_sha256: p[6], signature: p[7], changelog: p[8], published_at: p[9] ?? null, published_by: p[10] ?? null,
        deprecated_at: p[11] ?? null, deprecated_reason: p[12] ?? null, withdrawn_at: p[13] ?? null, withdrawn_reason: p[14] ?? null,
        superseded_by: p[15] ?? null, security_review_status: p[16], security_reviewed_at: p[17] ?? null, security_reviewer: p[18] ?? null,
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SELECT")) {
      let visible = [...rows.values()].filter((r) => r["pack_id"] === p[0]);
      if (sql.includes("AND version = $2")) visible = visible.filter((r) => r["version"] === p[1]);
      if (sql.includes("AND status = $2")) visible = visible.filter((r) => r["status"] === p[1]);
      return { rows: visible, rowCount: visible.length };
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

function makeCtx(): MarketplaceAuthoringContext {
  const conn = fakePg();
  return {
    engine: buildPersistentPackSubmissionEngine(conn),
    store: new PostgresPackVersionStore(conn),
    principalRoles: (p: ResolvedPrincipal | null) => ({ primaryRole: p?.grantedScopes[0] ?? "anon" }),
    authorRoles: new Set(["pack_author"]),
    reviewerRoles: new Set(["marketplace_reviewer"]),
  };
}

function principal(role: string | null): ResolvedPrincipal | null {
  if (role === null) return null;
  return {
    principalId: USER, tenantId: TENANT, principalKind: "user", authScheme: "api_key_header",
    grantedScopes: [role], mfaProofAgeSeconds: null, resolvedAt: "2026-06-01T00:00:00.000Z",
  } as ResolvedPrincipal;
}

function input(role: string | null, body?: Record<string, unknown>, params: Record<string, string> = {}): HandlerInput {
  return { request: {} as never, route: {} as never, principal: principal(role), params, parsedBody: body ?? null };
}

function manifest(overrides: Partial<PackManifest> = {}): PackManifest {
  return PackManifestSchema.parse({
    id: "com.acme.loyalty",
    name: "Acme Loyalty",
    description: "Loyalty",
    kind: "vertical_template",
    author: { kind: "community", name: "Acme", contactEmail: "dev@acme.example" },
    license: "MIT",
    minPlatformVersion: "1.0.0",
    ...overrides,
  });
}

function submitBody(m: PackManifest, channel = "beta"): Record<string, unknown> {
  return {
    packId: "com.acme.loyalty",
    version: "1.0.0",
    manifest: m,
    channel,
    bundleSha256: SHA,
    bundleSizeBytes: 4096,
    manifestSha256: SHA,
    signature: signPackManifest({ manifest: m, privateKeyBase64: keypair.privateKeyBase64, publicKeyBase64: keypair.publicKeyBase64, signedAt: "2026-06-01T00:00:00.000Z" }),
    publicKeyBase64: keypair.publicKeyBase64,
    changelog: "Initial release",
  };
}

function findHandler(ctx: MarketplaceAuthoringContext, op: string) {
  const route = buildMarketplaceAuthoringRoutes(ctx).find((r) => r.route.operationId === op);
  if (route === undefined) throw new Error(`no route ${op}`);
  return route.handler;
}

const params = { packId: "com.acme.loyalty", version: "1.0.0" };

describe("authoring — submit", () => {
  it("accepts a signed submission from an author (→ draft, pending review)", async () => {
    const submit = buildSubmitHandler(makeCtx());
    const out = (await submit(input("pack_author", submitBody(manifest())))) as HandlerOutput & { status: number; body: { version: { status: string; securityReviewStatus: string } } };
    expect(out.status).toBe(201);
    expect(out.body.version.status).toBe("draft");
    expect(out.body.version.securityReviewStatus).toBe("pending");
  });

  it("401s an unauthenticated caller, 403s a non-author", async () => {
    const submit = buildSubmitHandler(makeCtx());
    expect(((await submit(input(null, submitBody(manifest())))) as HandlerOutput).status).toBe(401);
    expect(((await submit(input("cashier", submitBody(manifest())))) as HandlerOutput).status).toBe(403);
  });

  it("400s a submission whose signature does not verify", async () => {
    const submit = buildSubmitHandler(makeCtx());
    const wrong = generateEd25519Keypair();
    const body = { ...submitBody(manifest()), publicKeyBase64: wrong.publicKeyBase64 };
    expect(((await submit(input("pack_author", body))) as HandlerOutput).status).toBe(400);
  });
});

describe("authoring — review + publish flow", () => {
  it("drives submit → review → publish through the routes", async () => {
    const ctx = makeCtx();
    const submit = findHandler(ctx, "authoring.packs.submit");
    const forReview = findHandler(ctx, "authoring.packs.submitForReview");
    const review = findHandler(ctx, "authoring.packs.review");
    const publish = findHandler(ctx, "authoring.packs.publish");

    expect(((await submit(input("pack_author", submitBody(manifest(), "stable")))) as HandlerOutput).status).toBe(201);
    expect(((await forReview(input("pack_author", undefined, params))) as HandlerOutput).status).toBe(200);
    const reviewed = (await review(input("marketplace_reviewer", { status: "passed" }, params))) as HandlerOutput & { body: { version: { securityReviewStatus: string } } };
    expect(reviewed.body.version.securityReviewStatus).toBe("passed");
    const published = (await publish(input("marketplace_reviewer", undefined, params))) as HandlerOutput & { body: { version: { status: string } } };
    expect(published.body.version.status).toBe("published");
  });

  it("403s an author trying to review, and 409s publishing a failed review to stable", async () => {
    const ctx = makeCtx();
    const submit = findHandler(ctx, "authoring.packs.submit");
    const forReview = findHandler(ctx, "authoring.packs.submitForReview");
    const review = findHandler(ctx, "authoring.packs.review");
    const publish = findHandler(ctx, "authoring.packs.publish");

    await submit(input("pack_author", submitBody(manifest(), "stable")));
    expect(((await review(input("pack_author", { status: "passed" }, params))) as HandlerOutput).status).toBe(403);
    await forReview(input("pack_author", undefined, params));
    await review(input("marketplace_reviewer", { status: "failed" }, params));
    expect(((await publish(input("marketplace_reviewer", undefined, params))) as HandlerOutput).status).toBe(409);
  });

  it("404s a transition on a missing version", async () => {
    const forReview = findHandler(makeCtx(), "authoring.packs.submitForReview");
    expect(((await forReview(input("pack_author", undefined, { packId: "com.acme.x", version: "9.9.9" }))) as HandlerOutput).status).toBe(404);
  });
});

describe("authoring — reads", () => {
  it("gets + lists a submitted version", async () => {
    const ctx = makeCtx();
    await findHandler(ctx, "authoring.packs.submit")(input("pack_author", submitBody(manifest())));
    const get = (await findHandler(ctx, "authoring.packs.get")(input("pack_author", undefined, params))) as HandlerOutput & { body: { version: { version: string } } };
    expect(get.body.version.version).toBe("1.0.0");
    const list = (await findHandler(ctx, "authoring.packs.list")(input("pack_author", undefined, { packId: "com.acme.loyalty" }))) as HandlerOutput & { body: { data: unknown[] } };
    expect(list.body.data).toHaveLength(1);
  });
});
