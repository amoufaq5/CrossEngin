import type { PathSegment, ResolvedPrincipal, RouteDefinition } from "@crossengin/api-gateway";
import type { Handler, HandlerOutput, PrincipalRoles } from "@crossengin/api-gateway-runtime";
import type { ExtraGatewayRoute } from "@crossengin/operate-runtime";
import { z } from "zod";

export type ReviewStatusLike = "not_required" | "pending" | "approved" | "rejected";

const REVIEW_STATUS_VALUES: readonly ReviewStatusLike[] = [
  "not_required",
  "pending",
  "approved",
  "rejected",
];

/** Only a pending proposal may be approved; a rejection may also revoke a standing approval. */
const APPROVABLE_FROM: readonly ReviewStatusLike[] = ["pending"];
const REJECTABLE_FROM: readonly ReviewStatusLike[] = ["pending", "approved"];

export interface DesignReviewRecordLike {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly description: string;
  readonly manifest: Record<string, unknown>;
  readonly manifestHash: string;
  readonly status: string;
  readonly reviewStatus: ReviewStatusLike;
  readonly reviewedBy: string | null;
  readonly reviewedAt: string | null;
  readonly reviewNotes: string | null;
  readonly providerLabel: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DesignReviewListQueryLike {
  readonly reviewStatus?: ReviewStatusLike;
  readonly tenantId?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface DesignReviewListPageLike {
  readonly data: readonly DesignReviewRecordLike[];
  readonly nextCursor: string | null;
}

export interface DesignReviewCountsLike {
  readonly pending: number;
  readonly approved: number;
  readonly rejected: number;
  readonly notRequired: number;
  readonly total: number;
}

export interface DesignReviewDecisionInput {
  readonly reviewedBy: string;
  readonly notes?: string | null;
}

export interface DesignReviewStoreLike {
  list(query?: DesignReviewListQueryLike): Promise<DesignReviewListPageLike>;
  getById(id: string): Promise<DesignReviewRecordLike | null>;
  counts(): Promise<DesignReviewCountsLike>;
  approve(id: string, input: DesignReviewDecisionInput): Promise<DesignReviewRecordLike | null>;
  reject(id: string, input: DesignReviewDecisionInput): Promise<DesignReviewRecordLike | null>;
}

export interface RiskReportLike {
  readonly level: "low" | "medium" | "high";
  readonly findings: readonly {
    code: string;
    level: string;
    message: string;
    entities: readonly string[];
  }[];
  readonly counts: {
    entities: number;
    fields: number;
    roles: number;
    relations: number;
    sensitiveFields: number;
  };
}

/**
 * Structural mirror of the manifest display projection. Declared here rather than imported so
 * the route layer stays decoupled from the projector implementation — the projection itself is
 * injected, exactly like `assessRisk`.
 */
export interface ManifestViewLike {
  readonly meta: {
    readonly name: string | null;
    readonly slug: string | null;
    readonly version: string | null;
    readonly description: string | null;
  };
  readonly entities: readonly {
    readonly name: string;
    readonly label: string;
    readonly traits: readonly string[];
    readonly auditable: boolean;
    readonly fields: readonly {
      readonly name: string;
      readonly kind: string;
      readonly type: string;
      readonly required: boolean;
      readonly classification: string | null;
      readonly sensitive: boolean;
      readonly referenceTarget: string | null;
    }[];
    readonly permissions: readonly { readonly operation: string; readonly roles: readonly string[] }[];
    readonly lifecycle: {
      readonly stateField: string | null;
      readonly initialState: string | null;
      readonly states: readonly {
        readonly name: string;
        readonly label: string;
        readonly category: string | null;
      }[];
      readonly transitions: readonly {
        readonly name: string;
        readonly from: readonly string[];
        readonly to: string;
      }[];
    } | null;
  }[];
  readonly relations: readonly {
    readonly kind: string;
    readonly from: string;
    readonly to: string;
    readonly field: string | null;
    readonly onDelete: string | null;
  }[];
  readonly roles: readonly {
    readonly name: string;
    readonly label: string;
    readonly description: string | null;
    readonly grantCount: number;
  }[];
  readonly counts: {
    readonly entities: number;
    readonly fields: number;
    readonly roles: number;
    readonly relations: number;
    readonly sensitiveFields: number;
    readonly lifecycles: number;
  };
}

export type ManifestProjector = (manifest: Record<string, unknown>) => ManifestViewLike;

/**
 * Structural mirror of the manifest change projection. Declared here rather than imported so
 * the route layer stays decoupled from the differ implementation — the differ itself is
 * injected, exactly like `assessRisk` and `projectSchema`.
 */
export interface ManifestDiffViewLike {
  readonly comparable: boolean;
  readonly impact: "none" | "additive" | "breaking";
  readonly warnings: readonly {
    readonly code: string;
    readonly impact: "additive" | "breaking";
    readonly message: string;
    readonly entities: readonly string[];
  }[];
  readonly entitiesAdded: readonly string[];
  readonly entitiesRemoved: readonly string[];
  readonly entitiesModified: readonly string[];
  readonly fieldChanges: readonly {
    readonly entity: string;
    readonly field: string;
    readonly change: string;
    readonly from: string | null;
    readonly to: string | null;
  }[];
  readonly permissionChanges: readonly {
    readonly entity: string;
    readonly operation: string;
    readonly granted: readonly string[];
    readonly revoked: readonly string[];
  }[];
  readonly relationChanges: readonly {
    readonly change: string;
    readonly label: string;
    readonly detail: string | null;
  }[];
  readonly rolesAdded: readonly string[];
  readonly rolesRemoved: readonly string[];
  readonly lifecycleChanges: readonly { readonly entity: string; readonly detail: string }[];
  readonly counts: {
    readonly added: number;
    readonly removed: number;
    readonly modified: number;
    readonly warnings: number;
  };
}

export type ManifestDiffer = (
  active: Record<string, unknown> | null,
  next: Record<string, unknown>,
) => ManifestDiffViewLike;

/** Resolves the tenant's currently-active manifest, or null when they have no live system yet. */
export interface ActiveManifestSourceLike {
  activeManifestFor(tenantId: string): Promise<Record<string, unknown> | null>;
}

export interface DesignReviewContext {
  readonly store: DesignReviewStoreLike;
  readonly principalRoles: (principal: ResolvedPrincipal | null) => PrincipalRoles;
  /** Roles permitted to review proposals platform-wide. Fail-closed: empty ⇒ nobody. */
  readonly adminRoles: ReadonlySet<string>;
  readonly assessRisk: (manifest: Record<string, unknown>) => RiskReportLike;
  /** Optional: when wired, the detail response carries a rendered schema view alongside the risk. */
  readonly projectSchema?: ManifestProjector;
  /** Optional: with `activeManifests`, the detail response also carries what would change. */
  readonly diffManifests?: ManifestDiffer;
  readonly activeManifests?: ActiveManifestSourceLike;
}

/** Spreads to nothing when no projector is wired, so the key is absent rather than undefined. */
export function schemaFragment(
  projectSchema: ManifestProjector | undefined,
  manifest: Record<string, unknown>,
): { schema?: ManifestViewLike } {
  return projectSchema === undefined ? {} : { schema: projectSchema(manifest) };
}

/** Spreads to nothing unless BOTH halves of the diff seam are wired, so the key is never undefined. */
export async function diffFragment(
  diffManifests: ManifestDiffer | undefined,
  activeManifests: ActiveManifestSourceLike | undefined,
  tenantId: string,
  next: Record<string, unknown>,
): Promise<{ diff?: ManifestDiffViewLike }> {
  if (diffManifests === undefined || activeManifests === undefined) return {};
  let active: Record<string, unknown> | null = null;
  try {
    active = await activeManifests.activeManifestFor(tenantId);
  } catch {
    // The diff is an aid, not the payload: a failure reading the tenant's live manifest degrades
    // to the not-comparable view rather than 500ing the whole proposal page.
    active = null;
  }
  return { diff: diffManifests(active, next) };
}

export const ReviewDecisionInputSchema = z.object({
  notes: z.string().max(2000).optional(),
});
export type ReviewDecisionInput = z.infer<typeof ReviewDecisionInputSchema>;

function json(status: number, body: unknown): HandlerOutput {
  return { kind: "json", status, body };
}

function hasRole(ctx: DesignReviewContext, principal: ResolvedPrincipal | null): boolean {
  const { primaryRole, secondaryRoles } = ctx.principalRoles(principal);
  return [primaryRole, ...(secondaryRoles ?? [])].some((r) => ctx.adminRoles.has(r));
}

/** 401 when unauthenticated, 403 when the caller lacks a platform-reviewer role, else null. */
function guard(ctx: DesignReviewContext, principal: ResolvedPrincipal | null): HandlerOutput | null {
  if (principal === null) return json(401, { error: "authentication_required" });
  if (!hasRole(ctx, principal)) {
    return json(403, { error: "forbidden", detail: "insufficient role" });
  }
  return null;
}

function firstQueryValue(value: string | readonly string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : (value as string);
}

function readListQuery(input: Parameters<Handler>[0]): DesignReviewListQueryLike {
  const query =
    (input.request as { query?: Record<string, string | string[]> } | undefined)?.query ?? {};
  const statusRaw = firstQueryValue(query["reviewStatus"]);
  const reviewStatus =
    statusRaw !== undefined && (REVIEW_STATUS_VALUES as readonly string[]).includes(statusRaw)
      ? (statusRaw as ReviewStatusLike)
      : undefined;
  const tenantIdRaw = firstQueryValue(query["tenantId"]);
  const tenantId = tenantIdRaw === undefined || tenantIdRaw.length === 0 ? undefined : tenantIdRaw;
  const limitRaw = firstQueryValue(query["limit"]);
  const limit = limitRaw === undefined ? undefined : Number.parseInt(limitRaw, 10);
  const cursor = firstQueryValue(query["cursor"]);
  return { reviewStatus, tenantId, limit, cursor };
}

/**
 * The queue listing strips `manifest` — a proposal document runs to hundreds of KB and the
 * queue only needs the risk summary computed from it; the full manifest ships on the single
 * `platform.designReviews.get` response.
 */
function toListItem(ctx: DesignReviewContext, record: DesignReviewRecordLike): Record<string, unknown> {
  const { manifest, ...rest } = record;
  return { ...rest, risk: ctx.assessRisk(manifest) };
}

function buildListHandler(ctx: DesignReviewContext): Handler {
  return async (input) => {
    const denial = guard(ctx, input.principal);
    if (denial !== null) return denial;
    const page = await ctx.store.list(readListQuery(input));
    return json(200, {
      data: page.data.map((r) => toListItem(ctx, r)),
      page: { nextCursor: page.nextCursor },
    });
  };
}

function buildStatsHandler(ctx: DesignReviewContext): Handler {
  return async ({ principal }) => {
    const denial = guard(ctx, principal);
    if (denial !== null) return denial;
    return json(200, { counts: await ctx.store.counts() });
  };
}

function buildGetHandler(ctx: DesignReviewContext): Handler {
  return async ({ principal, params }) => {
    const denial = guard(ctx, principal);
    if (denial !== null) return denial;
    const id = params["id"] ?? "";
    const review = await ctx.store.getById(id);
    if (review === null) return json(404, { error: "review_not_found", detail: id });
    // The diff is resolved against the proposal's OWN tenant, not the reviewer's: this is a
    // platform route and a platform reviewer has no tenant system of their own to compare to.
    const diff = await diffFragment(
      ctx.diffManifests,
      ctx.activeManifests,
      review.tenantId,
      review.manifest,
    );
    return json(200, {
      review,
      risk: ctx.assessRisk(review.manifest),
      ...schemaFragment(ctx.projectSchema, review.manifest),
      ...diff,
    });
  };
}

/**
 * Approve / reject. `reviewedBy` is taken from the authenticated principal, never from the
 * request body — a reviewer cannot attribute a decision to someone else.
 */
function buildDecisionHandler(ctx: DesignReviewContext, target: "approved" | "rejected"): Handler {
  const allowedFrom = target === "approved" ? APPROVABLE_FROM : REJECTABLE_FROM;
  return async ({ principal, params, parsedBody }) => {
    const denial = guard(ctx, principal);
    if (denial !== null) return denial;
    const parsed = ReviewDecisionInputSchema.safeParse(parsedBody ?? {});
    if (!parsed.success) return json(400, { error: "invalid_request", detail: parsed.error.issues });
    const id = params["id"] ?? "";
    const current = await ctx.store.getById(id);
    if (current === null) return json(404, { error: "review_not_found", detail: id });
    if (!allowedFrom.includes(current.reviewStatus)) {
      return json(409, {
        error: "illegal_transition",
        detail: `${current.reviewStatus} -> ${target}`,
      });
    }
    const decision: DesignReviewDecisionInput = {
      reviewedBy: principal?.principalId ?? "",
      notes: parsed.data.notes ?? null,
    };
    const review =
      target === "approved"
        ? await ctx.store.approve(id, decision)
        : await ctx.store.reject(id, decision);
    if (review === null) return json(404, { error: "review_not_found", detail: id });
    return json(200, { review });
  };
}

/** The platform design-review queue routes to inject via the gateway's `extraRoutes` hook. */
export function buildDesignReviewRoutes(ctx: DesignReviewContext): readonly ExtraGatewayRoute[] {
  const v = (
    op: string,
    method: RouteDefinition["method"],
    segs: ReadonlyArray<string | { param: string }>,
    handler: Handler,
  ): ExtraGatewayRoute => ({ route: route(op, method, segs), handler });
  return [
    v(
      "platform.designReviews.list",
      "GET",
      ["v1", "platform", "design-reviews"],
      buildListHandler(ctx),
    ),
    v(
      "platform.designReviews.stats",
      "GET",
      ["v1", "platform", "design-reviews", "stats"],
      buildStatsHandler(ctx),
    ),
    v(
      "platform.designReviews.get",
      "GET",
      ["v1", "platform", "design-reviews", { param: "id" }],
      buildGetHandler(ctx),
    ),
    v(
      "platform.designReviews.approve",
      "POST",
      ["v1", "platform", "design-reviews", { param: "id" }, "approve"],
      buildDecisionHandler(ctx, "approved"),
    ),
    v(
      "platform.designReviews.reject",
      "POST",
      ["v1", "platform", "design-reviews", { param: "id" }, "reject"],
      buildDecisionHandler(ctx, "rejected"),
    ),
  ];
}

function route(
  operationId: string,
  method: RouteDefinition["method"],
  segments: ReadonlyArray<string | { param: string }>,
): RouteDefinition {
  const pathSegments: PathSegment[] = segments.map((s) =>
    typeof s === "string"
      ? { kind: "literal", value: s }
      : { kind: "parameter", name: s.param, pattern: null },
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
