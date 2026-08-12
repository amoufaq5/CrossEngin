import type { PathSegment, ResolvedPrincipal, RouteDefinition } from "@crossengin/api-gateway";
import type { Handler, HandlerOutput, PrincipalRoles } from "@crossengin/api-gateway-runtime";
import {
  DISTRIBUTION_CHANNELS,
  PackManifestSchema,
  PackSignatureSchema,
} from "@crossengin/marketplace";
import type {
  PersistentPackSubmissionEngine,
  PostgresPackVersionStore,
} from "@crossengin/marketplace-runtime-pg";
import type { ExtraGatewayRoute } from "@crossengin/operate-runtime";
import { z } from "zod";

/** The handler context for the third-party authoring routes. */
export interface MarketplaceAuthoringContext {
  readonly engine: PersistentPackSubmissionEngine;
  readonly store: PostgresPackVersionStore;
  readonly principalRoles: (principal: ResolvedPrincipal | null) => PrincipalRoles;
  /** Roles permitted to submit versions (authors). Fail-closed: empty ⇒ nobody. */
  readonly authorRoles: ReadonlySet<string>;
  /** Roles permitted to record reviews + publish. Fail-closed: empty ⇒ nobody. */
  readonly reviewerRoles: ReadonlySet<string>;
}

const SHA256 = /^[0-9a-f]{64}$/;

const SubmitBodySchema = z
  .object({
    packId: z.string().min(1),
    version: z.string().min(1),
    manifest: PackManifestSchema,
    channel: z.enum(DISTRIBUTION_CHANNELS),
    bundleSha256: z.string().regex(SHA256),
    bundleSizeBytes: z.number().int().positive(),
    manifestSha256: z.string().regex(SHA256),
    signature: PackSignatureSchema,
    publicKeyBase64: z.string().min(1),
    changelog: z.string().min(1),
  })
  .strict();

const ReviewBodySchema = z.object({ status: z.enum(["passed", "failed"]) }).strict();
const RetireBodySchema = z.object({ reason: z.string().min(1) }).strict();

function json(status: number, body: unknown): HandlerOutput {
  return { kind: "json", status, body };
}

function hasRole(
  ctx: MarketplaceAuthoringContext,
  principal: ResolvedPrincipal | null,
  allowed: ReadonlySet<string>,
): boolean {
  const { primaryRole, secondaryRoles } = ctx.principalRoles(principal);
  return [primaryRole, ...(secondaryRoles ?? [])].some((r) => allowed.has(r));
}

/** Guards a handler to a role set + a tenant/principal, returning the principal id or a denial. */
function guard(
  ctx: MarketplaceAuthoringContext,
  principal: ResolvedPrincipal | null,
  allowed: ReadonlySet<string>,
): { readonly principalId: string } | HandlerOutput {
  if ((principal?.tenantId ?? null) === null) return json(401, { error: "authentication_required" });
  if (!hasRole(ctx, principal, allowed)) return json(403, { error: "forbidden", detail: "insufficient role" });
  const principalId = principal?.principalId ?? null;
  if (principalId === null) return json(401, { error: "principal_required" });
  return { principalId };
}

function isDenial(v: { readonly principalId: string } | HandlerOutput): v is HandlerOutput {
  return "kind" in v;
}

function submissionErrorStatus(message: string): number {
  return /signature/i.test(message) ? 400 : 409;
}

/** `POST /v1/authoring/packs` — submit a new signed pack version (→ draft). */
export function buildSubmitHandler(ctx: MarketplaceAuthoringContext): Handler {
  return async ({ principal, parsedBody }) => {
    const g = guard(ctx, principal, ctx.authorRoles);
    if (isDenial(g)) return g;
    const parsed = SubmitBodySchema.safeParse(parsedBody ?? {});
    if (!parsed.success) return json(400, { error: "invalid_request", detail: parsed.error.issues });
    try {
      const version = await ctx.engine.submit(parsed.data);
      return json(201, { status: version.status, version });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return json(submissionErrorStatus(message), { error: "submission_rejected", detail: message });
    }
  };
}

/** Loads the version named by the route params, or a 404 output. */
async function loadVersion(
  ctx: MarketplaceAuthoringContext,
  params: Record<string, string>,
): Promise<Awaited<ReturnType<PostgresPackVersionStore["getByPackVersion"]>> | HandlerOutput> {
  const packId = params["packId"] ?? "";
  const version = params["version"] ?? "";
  const record = await ctx.store.getByPackVersion(packId, version);
  if (record === null) return json(404, { error: "version_not_found", detail: `${packId}@${version}` });
  return record;
}

function step(
  ctx: MarketplaceAuthoringContext,
  allowed: ReadonlySet<string>,
  parse: ((body: unknown) => HandlerOutput | Record<string, unknown>) | null,
  run: (
    version: NonNullable<Awaited<ReturnType<PostgresPackVersionStore["getByPackVersion"]>>>,
    principalId: string,
    body: Record<string, unknown>,
  ) => Promise<unknown>,
): Handler {
  return async ({ principal, params, parsedBody }) => {
    const g = guard(ctx, principal, allowed);
    if (isDenial(g)) return g;
    const loaded = await loadVersion(ctx, params);
    if (loaded === null || (typeof loaded === "object" && "kind" in loaded)) {
      return loaded as HandlerOutput;
    }
    let body: Record<string, unknown> = {};
    if (parse !== null) {
      const parsed = parse(parsedBody ?? {});
      if ("kind" in parsed) return parsed as HandlerOutput;
      body = parsed;
    }
    try {
      const version = await run(loaded, g.principalId, body);
      return json(200, { version });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return json(submissionErrorStatus(message), { error: "transition_rejected", detail: message });
    }
  };
}

function parseWith<T>(schema: z.ZodType<T>): (body: unknown) => HandlerOutput | Record<string, unknown> {
  return (body) => {
    const parsed = schema.safeParse(body);
    if (!parsed.success) return json(400, { error: "invalid_request", detail: parsed.error.issues });
    return parsed.data as Record<string, unknown>;
  };
}

/** The third-party authoring routes to inject via the gateway's `extraRoutes` hook. */
export function buildMarketplaceAuthoringRoutes(ctx: MarketplaceAuthoringContext): readonly ExtraGatewayRoute[] {
  const v = (op: string, method: RouteDefinition["method"], segs: ReadonlyArray<string | { param: string }>, handler: Handler): ExtraGatewayRoute => ({
    route: route(op, method, segs),
    handler,
  });
  return [
    v("authoring.packs.submit", "POST", ["v1", "authoring", "packs"], buildSubmitHandler(ctx)),
    v(
      "authoring.packs.submitForReview",
      "POST",
      ["v1", "authoring", "packs", { param: "packId" }, "versions", { param: "version" }, "submit-for-review"],
      step(ctx, ctx.authorRoles, null, (version) => ctx.engine.submitForReview(version)),
    ),
    v(
      "authoring.packs.review",
      "POST",
      ["v1", "authoring", "packs", { param: "packId" }, "versions", { param: "version" }, "review"],
      step(ctx, ctx.reviewerRoles, parseWith(ReviewBodySchema), (version, reviewer, body) =>
        ctx.engine.recordReview(version, { status: body["status"] as "passed" | "failed", reviewer }),
      ),
    ),
    v(
      "authoring.packs.publish",
      "POST",
      ["v1", "authoring", "packs", { param: "packId" }, "versions", { param: "version" }, "publish"],
      step(ctx, ctx.reviewerRoles, null, (version, publishedBy) => ctx.engine.publish(version, { publishedBy })),
    ),
    v(
      "authoring.packs.withdraw",
      "POST",
      ["v1", "authoring", "packs", { param: "packId" }, "versions", { param: "version" }, "withdraw"],
      step(ctx, ctx.authorRoles, parseWith(RetireBodySchema), (version, _by, body) =>
        ctx.engine.withdraw(version, { reason: body["reason"] as string }),
      ),
    ),
    v(
      "authoring.packs.get",
      "GET",
      ["v1", "authoring", "packs", { param: "packId" }, "versions", { param: "version" }],
      buildGetHandler(ctx),
    ),
    v("authoring.packs.list", "GET", ["v1", "authoring", "packs", { param: "packId" }, "versions"], buildListHandler(ctx)),
  ];
}

function buildGetHandler(ctx: MarketplaceAuthoringContext): Handler {
  return async ({ principal, params }) => {
    const g = guard(ctx, principal, ctx.authorRoles);
    if (isDenial(g)) return g;
    const loaded = await loadVersion(ctx, params);
    if (loaded === null || (typeof loaded === "object" && "kind" in loaded)) return loaded as HandlerOutput;
    return json(200, { version: loaded });
  };
}

function buildListHandler(ctx: MarketplaceAuthoringContext): Handler {
  return async ({ principal, params }) => {
    const g = guard(ctx, principal, ctx.authorRoles);
    if (isDenial(g)) return g;
    const packId = params["packId"] ?? "";
    return json(200, { data: await ctx.store.listByPack(packId) });
  };
}

function route(operationId: string, method: RouteDefinition["method"], segments: ReadonlyArray<string | { param: string }>): RouteDefinition {
  const pathSegments: PathSegment[] = segments.map((s) =>
    typeof s === "string" ? { kind: "literal", value: s } : { kind: "parameter", name: s.param, pattern: null },
  );
  return {
    id: `rt_${operationId.replace(/[^a-z0-9]+/gi, "_")}`,
    operationId,
    method,
    pathSegments,
    apiVersion: "v1",
    isDeprecated: false,
    deprecatedSince: null,
    sunsetAt: null,
    successorOperationId: null,
    requiredScopes: [],
    rateLimitPolicyId: null,
    idempotencyRequired: false,
    requestSchemaSha256: null,
    responseSchemaSha256: null,
  };
}
