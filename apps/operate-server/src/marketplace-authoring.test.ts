import type { PgConnection } from "@crossengin/kernel-pg";
import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import type { HandlerInput, HandlerOutput } from "@crossengin/api-gateway-runtime";
import { generateEd25519Keypair } from "@crossengin/crypto";
import {
  packManifestDigest,
  PackManifestSchema,
  PackPublisherRegistry,
  parsePackPublisherSpec,
  signPackRelease,
  type PackManifest,
} from "@crossengin/marketplace";
import {
  PostgresPackVersionStore,
  buildPersistentPackSubmissionEngine,
} from "@crossengin/marketplace-runtime-pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildMarketplaceAuthoringRoutes,
  buildSubmitHandler,
  createUnverifiedReleaseReporter,
  unverifiedReleaseLine,
  type MarketplaceAuthoringContext,
} from "./marketplace-authoring.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-0000000000aa";
const SHA = "a".repeat(64);
const keypair = generateEd25519Keypair();

/** A fake PgConnection over the platform-wide pack_versions table (no tenant context). */
function fakePg(rows = new Map<string, Record<string, unknown>>()): PgConnection {
  const run = async (sql: string, params?: readonly unknown[]) => {
    const p = params ?? [];
    if (sql.includes("INSERT INTO")) {
      if (sql.includes("DO NOTHING") && rows.has(`${String(p[0])}|${String(p[1])}`)) return { rows: [], rowCount: 0 };
      rows.set(`${String(p[0])}|${String(p[1])}`, {
        pack_id: p[0], version: p[1], status: p[2], channel: p[3], bundle_sha256: p[4], bundle_size_bytes: p[5],
        manifest_sha256: p[6], signature: p[7], changelog: p[8], published_at: p[9] ?? null, published_by: p[10] ?? null,
        deprecated_at: p[11] ?? null, deprecated_reason: p[12] ?? null, withdrawn_at: p[13] ?? null, withdrawn_reason: p[14] ?? null,
        superseded_by: p[15] ?? null, security_review_status: p[16], security_reviewed_at: p[17] ?? null, security_reviewer: p[18] ?? null,
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE")) {
      const key = `${String(p[0])}|${String(p[1])}`;
      const row = rows.get(key);
      if (row === undefined || row["status"] !== p[13] || row["security_review_status"] !== p[14]) {
        return { rows: [], rowCount: 0 };
      }
      rows.set(key, {
        ...row, status: p[2], published_at: p[3] ?? null, published_by: p[4] ?? null, deprecated_at: p[5] ?? null,
        deprecated_reason: p[6] ?? null, withdrawn_at: p[7] ?? null, withdrawn_reason: p[8] ?? null,
        superseded_by: p[9] ?? null, security_review_status: p[10], security_reviewed_at: p[11] ?? null,
        security_reviewer: p[12] ?? null,
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

const PUBLISHERS = new PackPublisherRegistry([parsePackPublisherSpec(`com.acme:community:${keypair.publicKeyBase64}`)]);

function makeCtx(rows?: Map<string, Record<string, unknown>>): MarketplaceAuthoringContext {
  const conn = fakePg(rows);
  return {
    engine: buildPersistentPackSubmissionEngine(conn, { publishers: PUBLISHERS }),
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

function submitBody(m: PackManifest, channel = "beta", signer = keypair, bundleSha256 = SHA): Record<string, unknown> {
  return {
    packId: "com.acme.loyalty",
    version: "1.0.0",
    manifest: m,
    channel,
    bundleSha256,
    bundleSizeBytes: 4096,
    manifestSha256: packManifestDigest(m),
    signature: signPackRelease({
      manifest: m,
      version: "1.0.0",
      bundleSha256,
      privateKeyBase64: signer.privateKeyBase64,
      publicKeyBase64: signer.publicKeyBase64,
      signedAt: "2026-06-01T00:00:00.000Z",
    }),
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

  it("403s a submission signed by a key the platform did not register, however valid", async () => {
    const submit = buildSubmitHandler(makeCtx());
    const out = (await submit(input("pack_author", submitBody(manifest(), "beta", generateEd25519Keypair())))) as HandlerOutput & {
      body: { reason: string };
    };
    expect(out.status).toBe(403);
    expect(out.body.reason).toBe("publisher_unregistered");
  });

  it("400s a body that still carries a self-asserted key, rather than ignoring it", async () => {
    const submit = buildSubmitHandler(makeCtx());
    const body = { ...submitBody(manifest()), publicKeyBase64: keypair.publicKeyBase64 };
    expect(((await submit(input("pack_author", body))) as HandlerOutput).status).toBe(400);
  });

  it("409s re-submitting an existing version, and the stored version keeps its original bytes", async () => {
    const ctx = makeCtx();
    const submit = buildSubmitHandler(ctx);
    expect(((await submit(input("pack_author", submitBody(manifest())))) as HandlerOutput).status).toBe(201);
    // Re-signed for the new bundle, so it is the duplicate version and not the bundle that refuses.
    const again = submitBody(manifest(), "beta", keypair, "b".repeat(64));
    const out = (await submit(input("pack_author", again))) as HandlerOutput & { body: { reason: string } };
    expect(out.status).toBe(409);
    expect(out.body.reason).toBe("version_exists");
    expect((await ctx.store.getByPackVersion("com.acme.loyalty", "1.0.0"))?.bundleSha256).toBe(SHA);
  });

  // ADR-0452 measured this live as a 201: one signature re-sent as 9.9.9 with a new bundle.
  it.each([
    ["a different version", { version: "9.9.9" }, "release_version_mismatch"],
    ["a different bundle", { bundleSha256: "b".repeat(64) }, "release_bundle_mismatch"],
  ] as const)("400s a captured signature replayed with %s, and stores nothing", async (_label, patch, reason) => {
    const ctx = makeCtx();
    const submit = buildSubmitHandler(ctx);
    const out = (await submit(input("pack_author", { ...submitBody(manifest()), ...patch }))) as HandlerOutput & {
      body: { reason: string };
    };
    expect(out.status).toBe(400);
    expect(out.body.reason).toBe(reason);
    expect(await ctx.store.getByPackVersion("com.acme.loyalty", "9.9.9")).toBeNull();
    expect(await ctx.store.getByPackVersion("com.acme.loyalty", "1.0.0")).toBeNull();
  });

  it("400s a captured signature replayed over a different manifest carrying that manifest's own digest", async () => {
    const submit = buildSubmitHandler(makeCtx());
    const other = manifest({ name: "Loyalty, edited" });
    const body = { ...submitBody(manifest()), manifest: other, manifestSha256: packManifestDigest(other) };
    const out = (await submit(input("pack_author", body))) as HandlerOutput & { body: { reason: string } };
    expect(out.status).toBe(400);
    expect(out.body.reason).toBe("release_manifest_mismatch");
  });

  it("400s a manifest-only signature by name, not as a schema error", async () => {
    const submit = buildSubmitHandler(makeCtx());
    const body = submitBody(manifest());
    const { release: _release, ...legacy } = body["signature"] as Record<string, unknown>;
    const out = (await submit(input("pack_author", { ...body, signature: legacy }))) as HandlerOutput & {
      body: { error: string; reason: string };
    };
    expect(out.status).toBe(400);
    expect(out.body).toMatchObject({ error: "submission_rejected", reason: "legacy_signature_form" });
  });

  it("propagates a failure that is not a refusal instead of reporting it as one", async () => {
    const ctx = makeCtx();
    ctx.engine.submit = async () => Promise.reject(new Error("connection reset"));
    await expect(buildSubmitHandler(ctx)(input("pack_author", submitBody(manifest())))).rejects.toThrow(/connection reset/);
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

describe("authoring — a caller's malformed input is a refusal, never a 500", () => {
  it("400s a version that is not semver instead of throwing past the refusal map", async () => {
    const submit = buildSubmitHandler(makeCtx());
    const out = (await submit(input("pack_author", { ...submitBody(manifest()), version: "latest" }))) as HandlerOutput;
    expect(out.status).toBe(400);
  });

  it("409s publishing a failed review on a non-stable channel", async () => {
    const ctx = makeCtx();
    await findHandler(ctx, "authoring.packs.submit")(input("pack_author", submitBody(manifest(), "beta")));
    await findHandler(ctx, "authoring.packs.submitForReview")(input("pack_author", undefined, params));
    await findHandler(ctx, "authoring.packs.review")(input("marketplace_reviewer", { status: "failed" }, params));
    const out = (await findHandler(ctx, "authoring.packs.publish")(input("marketplace_reviewer", undefined, params))) as HandlerOutput & {
      body: { reason: string };
    };
    expect(out.status).toBe(409);
    expect(out.body.reason).toBe("review_not_cleared");
  });
});

describe("authoring — a stored row is re-verified against the publisher registry (ADR-0459)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * The owner's two-column rewrite ADR-0454 measured live: `version` and
   * `signature.release.version` both moved to 9.9.9, which `PackVersionRecordSchema` accepts
   * because the row agrees with itself.
   */
  function rewriteToNineNineNine(rows: Map<string, Record<string, unknown>>): void {
    const row = rows.get("com.acme.loyalty|1.0.0")!;
    const sig = JSON.parse(String(row["signature"])) as { release: Record<string, unknown> };
    rows.delete("com.acme.loyalty|1.0.0");
    rows.set("com.acme.loyalty|9.9.9", {
      ...row,
      version: "9.9.9",
      signature: JSON.stringify({ ...sig, release: { ...sig.release, version: "9.9.9" } }),
    });
  }

  const nine = { packId: "com.acme.loyalty", version: "9.9.9" };

  it("lists the rewritten row marked unverified rather than hiding it, and logs it once without key material", async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const ctx = makeCtx(rows);
    await findHandler(ctx, "authoring.packs.submit")(input("pack_author", submitBody(manifest())));
    rewriteToNineNineNine(rows);
    const logged: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m: unknown) => {
      logged.push(String(m));
    });
    const list = (await findHandler(ctx, "authoring.packs.list")(
      input("pack_author", undefined, { packId: "com.acme.loyalty" }),
    )) as HandlerOutput & { body: { data: { version: string; releaseVerification: { verified: boolean; refusal?: string } }[] } };
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({
      version: "9.9.9",
      releaseVerification: { verified: false, refusal: "signature_invalid" },
    });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("pack=com.acme.loyalty version=9.9.9 status=draft reason=signature_invalid");
    expect(logged[0]).not.toContain(keypair.publicKeyBase64);
    expect(logged[0]).not.toContain(PUBLISHERS.list()[0]!.fingerprint.slice(0, 12));
  });

  it("marks an untouched row verified (control)", async () => {
    const ctx = makeCtx();
    await findHandler(ctx, "authoring.packs.submit")(input("pack_author", submitBody(manifest())));
    const get = (await findHandler(ctx, "authoring.packs.get")(input("pack_author", undefined, params))) as HandlerOutput & {
      body: { version: { releaseVerification: { verified: boolean } } };
    };
    expect(get.body.version.releaseVerification).toEqual({ verified: true });
  });

  it("409s submitting the rewritten row for review, names the reason, and advances nothing", async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const ctx = makeCtx(rows);
    await findHandler(ctx, "authoring.packs.submit")(input("pack_author", submitBody(manifest())));
    rewriteToNineNineNine(rows);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const out = (await findHandler(ctx, "authoring.packs.submitForReview")(input("pack_author", undefined, nine))) as HandlerOutput & {
      body: { reason: string; releaseRefusal: string };
    };
    expect(out.status).toBe(409);
    expect(out.body).toMatchObject({ reason: "stored_release_unverified", releaseRefusal: "signature_invalid" });
    expect(rows.get("com.acme.loyalty|9.9.9")?.["status"]).toBe("draft");
  });

  it("409s publishing a rewritten row that was already in review, and leaves it unpublished", async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const ctx = makeCtx(rows);
    await findHandler(ctx, "authoring.packs.submit")(input("pack_author", submitBody(manifest(), "beta")));
    await findHandler(ctx, "authoring.packs.submitForReview")(input("pack_author", undefined, params));
    rewriteToNineNineNine(rows);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const out = (await findHandler(ctx, "authoring.packs.publish")(input("marketplace_reviewer", undefined, nine))) as HandlerOutput & {
      body: { reason: string };
    };
    expect(out.status).toBe(409);
    expect(out.body.reason).toBe("stored_release_unverified");
    expect(rows.get("com.acme.loyalty|9.9.9")?.["status"]).toBe("in_review");
  });

  it("still withdraws the rewritten row, which is the remedy", async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const ctx = makeCtx(rows);
    await findHandler(ctx, "authoring.packs.submit")(input("pack_author", submitBody(manifest())));
    rewriteToNineNineNine(rows);
    const out = (await findHandler(ctx, "authoring.packs.withdraw")(
      input("pack_author", { reason: "row edited outside the platform" }, nine),
    )) as HandlerOutput;
    expect(out.status).toBe(200);
    expect(rows.get("com.acme.loyalty|9.9.9")?.["status"]).toBe("withdrawn");
  });

  it("lets a reviewer — who meets the 409 at review and publish — withdraw the row too", async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const ctx = makeCtx(rows);
    await findHandler(ctx, "authoring.packs.submit")(input("pack_author", submitBody(manifest(), "beta")));
    await findHandler(ctx, "authoring.packs.submitForReview")(input("pack_author", undefined, params));
    rewriteToNineNineNine(rows);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const out = (await findHandler(ctx, "authoring.packs.withdraw")(
      input("marketplace_reviewer", { reason: "release no longer verifies" }, nine),
    )) as HandlerOutput;
    expect(out.status).toBe(200);
    expect(rows.get("com.acme.loyalty|9.9.9")?.["status"]).toBe("withdrawn");
    // A principal holding neither role still cannot.
    const denied = (await findHandler(ctx, "authoring.packs.withdraw")(input("viewer", { reason: "x" }, nine))) as HandlerOutput;
    expect(denied.status).toBe(403);
  });

  it("lets a reviewer record a failed review on the rewritten row, and still refuses a pass", async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const ctx = makeCtx(rows);
    await findHandler(ctx, "authoring.packs.submit")(input("pack_author", submitBody(manifest(), "beta")));
    await findHandler(ctx, "authoring.packs.submitForReview")(input("pack_author", undefined, params));
    rewriteToNineNineNine(rows);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const pass = (await findHandler(ctx, "authoring.packs.review")(input("marketplace_reviewer", { status: "passed" }, nine))) as HandlerOutput & {
      body: { reason: string };
    };
    expect(pass.status).toBe(409);
    expect(pass.body.reason).toBe("stored_release_unverified");
    const fail = (await findHandler(ctx, "authoring.packs.review")(input("marketplace_reviewer", { status: "failed" }, nine))) as HandlerOutput;
    expect(fail.status).toBe(200);
    expect(rows.get("com.acme.loyalty|9.9.9")?.["security_review_status"]).toBe("failed");
  });

  it("409s publishing a row whose unsigned review column was edited to 'exempt' for a community publisher", async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const ctx = makeCtx(rows);
    await findHandler(ctx, "authoring.packs.submit")(input("pack_author", submitBody(manifest())));
    await findHandler(ctx, "authoring.packs.submitForReview")(input("pack_author", undefined, params));
    const row = rows.get("com.acme.loyalty|1.0.0")!;
    expect(row["security_review_status"]).toBe("in_progress");
    rows.set("com.acme.loyalty|1.0.0", { ...row, security_review_status: "exempt" });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const out = (await findHandler(ctx, "authoring.packs.publish")(input("marketplace_reviewer", undefined, params))) as HandlerOutput & {
      body: { reason: string; releaseRefusal: string };
    };
    expect(out.status).toBe(409);
    expect(out.body).toMatchObject({ reason: "stored_release_unverified", releaseRefusal: "review_exemption_unsupported" });
    expect(rows.get("com.acme.loyalty|1.0.0")?.["status"]).toBe("in_review");
  });

  it("reports a row once per process across reads, and not at all once it is withdrawn", async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const ctx = makeCtx(rows);
    const logged: string[] = [];
    const routes = buildMarketplaceAuthoringRoutes(ctx, createUnverifiedReleaseReporter((l) => logged.push(l)));
    const handler = (op: string) => routes.find((r) => r.route.operationId === op)!.handler;
    await handler("authoring.packs.submit")(input("pack_author", submitBody(manifest())));
    rewriteToNineNineNine(rows);
    const list = () => handler("authoring.packs.list")(input("pack_author", undefined, { packId: "com.acme.loyalty" }));
    await list();
    await list();
    await handler("authoring.packs.get")(input("pack_author", undefined, nine));
    expect(logged).toHaveLength(1);
    await handler("authoring.packs.withdraw")(input("pack_author", { reason: "tampered" }, nine));
    await list();
    expect(logged).toHaveLength(1);
  });

  it("names a remedy matching the row's status, and none for a withdrawn row", () => {
    expect(unverifiedReleaseLine("p", "1.0.0", "published", "publisher_unregistered")).toContain("in distribution");
    expect(unverifiedReleaseLine("p", "1.0.0", "in_review", "signature_invalid")).toContain("record a failed review");
    expect(unverifiedReleaseLine("p", "1.0.0", "draft", "signature_invalid")).not.toContain("published");
    expect(unverifiedReleaseLine("p", "1.0.0", "withdrawn", "signature_invalid")).toBeNull();
  });
});
