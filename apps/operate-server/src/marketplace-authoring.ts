import type { PathSegment, ResolvedPrincipal, RouteDefinition } from "@crossengin/api-gateway";
import type { Handler, HandlerOutput, PrincipalRoles } from "@crossengin/api-gateway-runtime";
import type { PackVersionRecord, PackVersionStatus } from "@crossengin/marketplace";
import {
  PackSubmissionBodySchema,
  PackSubmissionError,
  type PackSubmissionRefusal,
  type StoredVersionRefusal,
} from "@crossengin/marketplace-runtime";
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

/**
 * The status each refusal answers, as a total map so a new refusal is a compile error here. A signer
 * the registry does not admit for this pack is a 403 — the request is well formed and the caller is
 * not allowed to publish it — where the old mapping keyed a 400 on the word "signature" in a message.
 */
const SUBMISSION_REFUSAL_STATUS: Readonly<Record<PackSubmissionRefusal, number>> = Object.freeze({
  // A well-formed body in a signature form this build refuses: the remedy is the caller's (re-sign the
  // release), so 400 and not 403, which would say the signer is not allowed rather than unheard.
  legacy_signature_form: 400,
  publisher_unregistered: 403,
  pack_outside_publisher_namespace: 403,
  author_kind_not_registered: 403,
  signature_invalid: 400,
  // The signature verified and names a different release than the body submits: the body disagrees
  // with its own signature, which is the replay ADR-0452 measured. 400 for the same reason as
  // `manifest_digest_mismatch` — the request contradicts itself, independent of who sent it.
  release_pack_mismatch: 400,
  release_manifest_mismatch: 400,
  release_version_mismatch: 400,
  release_bundle_mismatch: 400,
  pack_id_mismatch: 400,
  manifest_digest_mismatch: 400,
  version_exists: 409,
  version_changed: 409,
  illegal_transition: 409,
  review_not_open: 409,
  review_not_cleared: 409,
  // The request is well formed and the caller may make it; the stored row is what cannot be
  // advanced, because it no longer verifies against the registry. A conflict with stored state, like
  // `version_changed`, so neither 400 (nothing in the request is wrong) nor 403 (the caller holds the
  // grant). The remedy is reachable by both roles that can meet this: withdraw is granted to authors
  // and reviewers alike, and a reviewer may also record a failed review.
  stored_release_unverified: 409,
});

/**
 * How a stored version's release stands against the publisher registry now (ADR-0459). Carried on
 * every version a read route returns rather than hiding a row that fails, because a hidden row reads
 * exactly like a version nobody submitted — an absence of evidence presented as evidence (ADR-0372)
 * — while the author reading this route is the one person who can tell a release they never made,
 * and a resubmit of that number would answer `version_exists` about a row they cannot see.
 */
export type ReleaseVerificationView =
  | { readonly verified: true }
  | { readonly verified: false; readonly refusal: StoredVersionRefusal; readonly detail: string };

/**
 * What the log line tells an operator to do, by the row's status — a total map, because the honest
 * remedy differs: a row still moving through review is held back by the lifecycle gate, a row
 * already published passed that gate under a registry that admitted it (or was edited to
 * `published` directly) and is in distribution, and a withdrawn row needs nothing, so it is silent.
 */
const UNVERIFIED_RELEASE_REMEDY: Readonly<Record<PackVersionStatus, string | null>> = Object.freeze({
  draft: "it cannot be submitted for review; an author or reviewer role can withdraw it",
  in_review: "it cannot be passed or published; a reviewer can record a failed review, or an author or reviewer role can withdraw it",
  published: "it is published and in distribution; an author or reviewer role should withdraw it",
  deprecated: "it is deprecated and still listed; an author or reviewer role should withdraw it",
  withdrawn: null,
});

/**
 * The one log line for a stored version that does not verify, or `null` when the row needs nothing.
 * It names the pack, the version, the status and the reason, and deliberately not the refusal's
 * detail: a reason is the contract and enough to act on, and nothing about the key — not even a
 * fingerprint prefix — belongs in a line an operator's log aggregator keeps.
 */
export function unverifiedReleaseLine(
  packId: string,
  version: string,
  status: PackVersionStatus,
  refusal: StoredVersionRefusal,
): string | null {
  const remedy = UNVERIFIED_RELEASE_REMEDY[status];
  if (remedy === null) return null;
  return (
    `[marketplace] stored release unverified pack=${packId} version=${version} status=${status} reason=${refusal} — ` +
    `the row does not verify against the configured --pack-publisher-key set; ${remedy}`
  );
}

/**
 * Reports unverified rows. A read route reports a given (pack, version, status, reason) once per
 * process: a list is read on every page view, and after a key rotation every row the key signed
 * would otherwise log on every request, burying the finding. A refused lifecycle step is an act
 * somebody attempted and is reported every time.
 */
export interface UnverifiedReleaseReporter {
  onRead(record: PackVersionRecord, refusal: StoredVersionRefusal): void;
  onRefusedStep(record: PackVersionRecord, refusal: StoredVersionRefusal): void;
}

export function createUnverifiedReleaseReporter(
  log: (line: string) => void = (line) => console.error(line),
): UnverifiedReleaseReporter {
  const seen = new Set<string>();
  return {
    onRead(record, refusal) {
      const line = unverifiedReleaseLine(record.packId, record.version, record.status, refusal);
      if (line === null) return;
      const key = `${record.packId}|${record.version}|${record.status}|${refusal}`;
      if (seen.has(key)) return;
      seen.add(key);
      log(line);
    },
    onRefusedStep(record, refusal) {
      const line = unverifiedReleaseLine(record.packId, record.version, record.status, refusal);
      if (line !== null) log(line);
    },
  };
}

/** A stored version with its release verification, reporting a failure as it is read. */
function withVerification(
  ctx: MarketplaceAuthoringContext,
  reporter: UnverifiedReleaseReporter,
  record: PackVersionRecord,
): PackVersionRecord & { readonly releaseVerification: ReleaseVerificationView } {
  const v = ctx.engine.engine.verifyStored(record);
  if (v.ok) return { ...record, releaseVerification: { verified: true } };
  reporter.onRead(record, v.refusal);
  return { ...record, releaseVerification: { verified: false, refusal: v.refusal, detail: v.detail } };
}

/** A refusal becomes its status; anything else is not a refusal and propagates as a 500. */
function refusalOutput(err: unknown, error: string): HandlerOutput {
  if (!(err instanceof PackSubmissionError)) throw err;
  return json(SUBMISSION_REFUSAL_STATUS[err.reason], {
    error,
    reason: err.reason,
    detail: err.message,
    ...(err.storedRefusal !== undefined ? { releaseRefusal: err.storedRefusal } : {}),
  });
}

/** `POST /v1/authoring/packs` — submit a new signed pack version (→ draft). */
export function buildSubmitHandler(ctx: MarketplaceAuthoringContext): Handler {
  return async ({ principal, parsedBody }) => {
    const g = guard(ctx, principal, ctx.authorRoles);
    if (isDenial(g)) return g;
    const parsed = PackSubmissionBodySchema.safeParse(parsedBody ?? {});
    if (!parsed.success) return json(400, { error: "invalid_request", detail: parsed.error.issues });
    try {
      const version = await ctx.engine.submit(parsed.data);
      return json(201, { status: version.status, version });
    } catch (err) {
      return refusalOutput(err, "submission_rejected");
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
  reporter: UnverifiedReleaseReporter,
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
      if (err instanceof PackSubmissionError && err.storedRefusal !== undefined) {
        reporter.onRefusedStep(loaded, err.storedRefusal);
      }
      return refusalOutput(err, "transition_rejected");
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
export function buildMarketplaceAuthoringRoutes(
  ctx: MarketplaceAuthoringContext,
  reporter: UnverifiedReleaseReporter = createUnverifiedReleaseReporter(),
): readonly ExtraGatewayRoute[] {
  // Withdraw is the remedy for a row that no longer verifies, and both roles that can meet the 409
  // must hold it: an author at submit-for-review, a reviewer at review or publish. A reviewer
  // withdrawing is the platform taking a version out of distribution, which a publish grant already
  // implies; for a forged row the author is exactly the party who did not make it.
  const retireRoles: ReadonlySet<string> = new Set([...ctx.authorRoles, ...ctx.reviewerRoles]);
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
      step(ctx, reporter, ctx.authorRoles, null, (version) => ctx.engine.submitForReview(version)),
    ),
    v(
      "authoring.packs.review",
      "POST",
      ["v1", "authoring", "packs", { param: "packId" }, "versions", { param: "version" }, "review"],
      step(ctx, reporter, ctx.reviewerRoles, parseWith(ReviewBodySchema), (version, reviewer, body) =>
        ctx.engine.recordReview(version, { status: body["status"] as "passed" | "failed", reviewer }),
      ),
    ),
    v(
      "authoring.packs.publish",
      "POST",
      ["v1", "authoring", "packs", { param: "packId" }, "versions", { param: "version" }, "publish"],
      step(ctx, reporter, ctx.reviewerRoles, null, (version, publishedBy) => ctx.engine.publish(version, { publishedBy })),
    ),
    v(
      "authoring.packs.withdraw",
      "POST",
      ["v1", "authoring", "packs", { param: "packId" }, "versions", { param: "version" }, "withdraw"],
      step(ctx, reporter, retireRoles, parseWith(RetireBodySchema), (version, _by, body) =>
        ctx.engine.withdraw(version, { reason: body["reason"] as string }),
      ),
    ),
    v(
      "authoring.packs.get",
      "GET",
      ["v1", "authoring", "packs", { param: "packId" }, "versions", { param: "version" }],
      buildGetHandler(ctx, reporter),
    ),
    v("authoring.packs.list", "GET", ["v1", "authoring", "packs", { param: "packId" }, "versions"], buildListHandler(ctx, reporter)),
  ];
}

function buildGetHandler(ctx: MarketplaceAuthoringContext, reporter: UnverifiedReleaseReporter): Handler {
  return async ({ principal, params }) => {
    const g = guard(ctx, principal, ctx.authorRoles);
    if (isDenial(g)) return g;
    const loaded = await loadVersion(ctx, params);
    if (loaded === null || (typeof loaded === "object" && "kind" in loaded)) return loaded as HandlerOutput;
    return json(200, { version: withVerification(ctx, reporter, loaded) });
  };
}

function buildListHandler(ctx: MarketplaceAuthoringContext, reporter: UnverifiedReleaseReporter): Handler {
  return async ({ principal, params }) => {
    const g = guard(ctx, principal, ctx.authorRoles);
    if (isDenial(g)) return g;
    const packId = params["packId"] ?? "";
    // The reporter is required, so a version row the contract refuses is named rather than dropped
    // from the page. It is a log line and not a body field: this is the author's view of their own
    // pack's versions and the remedy is the platform's, so the figure belongs where an operator
    // reads findings (ADR-0371's rule about where a diagnostic goes).
    const records = await ctx.store.listByPack(packId, (row) =>
      console.error(
        `[marketplace] unreadable pack version pack=${packId} id=${row.identity ?? "<unidentified>"}: ${row.detail}`,
      ),
    );
    return json(200, { data: records.map((r) => withVerification(ctx, reporter, r)) });
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
