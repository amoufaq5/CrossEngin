import type { PathSegment, ResolvedPrincipal, RouteDefinition } from "@crossengin/api-gateway";
import {
  aiProviderResidencyRefusal,
  type AiProviderResidencyRefusalInput,
  type Handler,
  type HandlerOutput,
  type PrincipalRoles,
} from "@crossengin/api-gateway-runtime";
import type { ExtraGatewayRoute } from "@crossengin/operate-runtime";
import { z } from "zod";

import type { ActivationCheck } from "./activation-check.js";
import {
  diffFragment,
  schemaFragment,
  type ActiveManifestSourceLike,
  type DiffLineageLike,
  type ManifestDiffer,
  type ManifestProjector,
  type ReviewStatusLike,
} from "./design-review-routes.js";
import {
  DESIGN_JOB_MAX_ATTEMPTS,
  type DesignJobStoreLike,
  type DesignRunnerInput,
} from "./design-runner.js";
import {
  MANIFEST_PROPOSAL_STATUSES,
  type ManifestProposalSource,
  type ManifestProposalStatus,
} from "./tenant-manifests.js";

/*
 * The manifest status and source domains are *imported* from `tenant-manifests.ts` rather than
 * declared here, and that asymmetry is deliberate: `AiManifestRecordLike` below is a structural
 * seam, because this module must not depend on the concrete store — but a value set is not a
 * structure. Spelling one twice is how a declaration ends up naming a constant no writer binds
 * (ADR-0354): `AI_MANIFEST_SOURCES` here and `MANIFEST_PROPOSAL_SOURCES` there were the same two
 * members in one app, and the catalog's `operate_tenant_manifests.source` CHECK answers to the one
 * `tenant-manifests.ts` writes.
 */

export interface AiManifestRecordLike {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly description: string;
  readonly manifest: Record<string, unknown>;
  readonly manifestHash: string;
  readonly status: ManifestProposalStatus;
  readonly source: ManifestProposalSource;
  readonly providerLabel: string | null;
  readonly designedBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly activatedAt: string | null;
}

export interface AiManifestCreateInput {
  readonly name: string;
  readonly description: string;
  readonly manifest: Record<string, unknown>;
  readonly manifestHash: string;
  readonly source: ManifestProposalSource;
  readonly providerLabel?: string | null;
  /** The requesting principal, which the review route refuses as the approver (H-28). */
  readonly designedBy: string | null;
}

export interface AiManifestListQuery {
  readonly status?: ManifestProposalStatus;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface AiManifestListPage {
  readonly data: readonly AiManifestRecordLike[];
  readonly nextCursor: string | null;
}

export interface AiManifestStore {
  create(tenantId: string, input: AiManifestCreateInput): Promise<AiManifestRecordLike>;
  list(tenantId: string, query?: AiManifestListQuery): Promise<AiManifestListPage>;
  getById(tenantId: string, id: string): Promise<AiManifestRecordLike | null>;
  setStatus(tenantId: string, id: string, status: ManifestProposalStatus): Promise<AiManifestRecordLike | null>;
  activate(tenantId: string, id: string): Promise<AiManifestRecordLike | null>;
}

export interface DesignResultLike {
  readonly ok: boolean;
  readonly manifest: Record<string, unknown> | null;
  readonly manifestHash: string | null;
  readonly issues: readonly string[];
  readonly attempts: number;
  readonly providerLabel: string | null;
  readonly usage: { inputTokens: number; outputTokens: number; cost: number } | null;
  /** Why the run ended without a manifest, when it did (`DesignFailureKind`). */
  readonly failure?: string | null;
}

export type ManifestDesignerLike = (input: {
  tenantId: string;
  description: string;
  name?: string;
}) => Promise<DesignResultLike>;

/**
 * Whether this deployment's AI provider may process a tenant's business description, by the
 * tenant's residency profile. A refusal names its decision and the routes build the answer through
 * `aiProviderResidencyRefusal`, so the status, the problem type and the code have one spelling
 * (ADR-0462) rather than one per producer of an admission.
 */
export type AiProviderAdmission =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly refusal: AiProviderResidencyRefusalInput };

/**
 * The refusal on the wire: an RFC 9457 problem, the minority shape among these routes' refusals and
 * deliberately so — it is a residency answer, and every residency answer is in the registry. The
 * `content-type` header survives because the dispatcher fills it only when absent; the length is
 * the dispatcher's to compute from the body it serializes, as in `residency-gate.ts`.
 */
function providerResidencyRefusal(input: AiProviderResidencyRefusalInput): HandlerOutput {
  const env = aiProviderResidencyRefusal(input);
  const { "content-length": _length, ...headers } = env.response.headers;
  return { kind: "json", status: env.body.status, headers, body: env.body };
}

export interface AiDesignContext {
  readonly store: AiManifestStore;
  /** null ⇒ no AI provider configured — design requests get 503. */
  readonly designer: ManifestDesignerLike | null;
  readonly principalRoles: (principal: ResolvedPrincipal | null) => PrincipalRoles;
  /** Roles permitted to use the AI Architect. Fail-closed: empty ⇒ nobody. */
  readonly allowedRoles: ReadonlySet<string>;
  readonly onActivated?: (tenantId: string) => void;
  /**
   * The per-tenant month, read before a design is accepted so an exhausted tenant is told at once
   * rather than after a job is queued. It is a courtesy and not the fence: the designer reserves
   * each attempt against the month itself (`DesignerBudget.reserve`), and that is what holds under
   * concurrency. The routes therefore no longer record spend — the designer has charged it.
   */
  readonly budget?: {
    check(tenantId: string): Promise<BudgetCheckLike>;
  };
  /**
   * Whether the proposal can be served, asked before an activation is written (ADR-0470).
   *
   * **Required**, so a deployment cannot wire the activate route and forget it: an optional check
   * defaulting to *admit* would be the pre-ADR-0470 behaviour kept as the default, where an
   * unservable manifest is activated with a 200 and its tenant gets a 503 on every request after.
   */
  readonly activationCheck: ActivationCheck;
  /** The tenant's residency profile against this deployment's AI provider; absent admits all. */
  readonly providerAdmission?: (tenantId: string) => Promise<AiProviderAdmission>;
  readonly summarize: (manifest: Record<string, unknown>) => unknown;
  /** Optional: when wired, proposal detail responses carry a rendered schema view. */
  readonly projectSchema?: ManifestProjector;
  /** Optional: with `activeManifests`, detail responses also carry what activation would change. */
  readonly diffManifests?: ManifestDiffer;
  readonly activeManifests?: ActiveManifestSourceLike;
  /** Optional: with the two above, the diff compares what the tenant is served, lineage composed. */
  readonly diffLineage?: DiffLineageLike;
  /** Async design mode. Both must be wired or the job routes self-503. */
  readonly jobs?: DesignJobStoreLike;
  readonly startJob?: (tenantId: string, jobId: string, input: DesignRunnerInput) => void;
  /** When set, activation requires platform approval: resolves the proposal's review status. */
  readonly reviewGate?: { reviewStatusFor(tenantId: string, id: string): Promise<ReviewStatusLike | null> };
}

/**
 * Structural mirror of `BudgetCheck` in `ai-design-budget.ts`. Discriminated, because "the month is
 * spent" and "the ledger could not be read" have different answers: the first is a 402 the tenant
 * can only wait out, the second a 503 that is over when the database is back (ADR-0470).
 */
export type BudgetCheckLike =
  | { readonly allowed: true; readonly spentUsd: number; readonly limitUsd: number }
  | {
      readonly allowed: false;
      readonly reason: "month_exceeded";
      readonly spentUsd: number;
      readonly limitUsd: number;
    }
  | { readonly allowed: false; readonly reason: "unavailable"; readonly limitUsd: number };

/** How long a client is told to wait before retrying a design the ledger could not admit. */
export const BUDGET_UNAVAILABLE_RETRY_AFTER_SECONDS = 30;

/** How long a client is told to wait after an activation check that established nothing. */
export const ACTIVATION_CHECK_RETRY_AFTER_SECONDS = 5;

export const DesignRequestSchema = z.object({
  description: z.string().min(1).max(4000),
  name: z.string().min(1).max(200).optional(),
});
export type DesignRequest = z.infer<typeof DesignRequestSchema>;

export const DEFAULT_PROPOSAL_NAME = "Untitled system";

function json(status: number, body: unknown): HandlerOutput {
  return { kind: "json", status, body };
}

function hasRole(ctx: AiDesignContext, principal: ResolvedPrincipal | null): boolean {
  const { primaryRole, secondaryRoles } = ctx.principalRoles(principal);
  return [primaryRole, ...(secondaryRoles ?? [])].some((r) => ctx.allowedRoles.has(r));
}

/** 401 when unauthenticated, 403 when the caller lacks an allowed role, else null (allowed). */
function guard(ctx: AiDesignContext, principal: ResolvedPrincipal | null): HandlerOutput | null {
  if (principal === null) return json(401, { error: "authentication_required" });
  if (!hasRole(ctx, principal)) {
    return json(403, { error: "forbidden", detail: "insufficient role" });
  }
  return null;
}

function tenantOf(principal: ResolvedPrincipal | null): string | null {
  return principal?.tenantId ?? null;
}

/**
 * Who asked for a design, as the review route will compare it against the approver. The principal
 * id and not `principalUserId`: a bare api-key's shared placeholder names nobody, and recording
 * `null` for it would make its design approvable by the same key, while recording the placeholder
 * makes it unapprovable by any key resolving to that placeholder — the conservative reading of an
 * identity that cannot tell two people apart.
 */
function designerOf(principal: ResolvedPrincipal | null): string | null {
  const id = principal?.principalId;
  return id === undefined || id.length === 0 ? null : id;
}

function firstQueryValue(value: string | readonly string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : (value as string);
}

function readListQuery(input: Parameters<Handler>[0]): AiManifestListQuery {
  const query = (input.request as { query?: Record<string, string | string[]> } | undefined)?.query ?? {};
  const statusRaw = firstQueryValue(query["status"]);
  const status =
    statusRaw !== undefined && (MANIFEST_PROPOSAL_STATUSES as readonly string[]).includes(statusRaw)
      ? (statusRaw as ManifestProposalStatus)
      : undefined;
  const limitRaw = firstQueryValue(query["limit"]);
  const limit = limitRaw === undefined ? undefined : Number.parseInt(limitRaw, 10);
  const cursor = firstQueryValue(query["cursor"]);
  return { status, limit, cursor };
}

/**
 * The two gates before a design is accepted: the tenant's residency profile against the provider,
 * then the month. Residency first, because a tenant whose data may not go to this provider is
 * refused whatever its budget says, and telling it about money first would name the wrong remedy.
 */
async function admitDesign(ctx: AiDesignContext, tenant: string): Promise<HandlerOutput | null> {
  if (ctx.providerAdmission !== undefined) {
    const admission = await ctx.providerAdmission(tenant);
    if (!admission.allowed) return providerResidencyRefusal(admission.refusal);
  }
  // Spend gate before the LLM call: an unbounded design loop is the one way a tenant admin
  // can run up real money on this endpoint. Fail-closed (a ledger read error denies) — and denies
  // as what it is: a 503 with a retry, not a 402 telling the tenant its month is spent when nobody
  // could read the month (ADR-0470).
  if (ctx.budget !== undefined) {
    const budget = await ctx.budget.check(tenant);
    if (!budget.allowed && budget.reason === "unavailable") {
      return {
        kind: "json",
        status: 503,
        headers: { "retry-after": BUDGET_UNAVAILABLE_RETRY_AFTER_SECONDS.toString() },
        body: {
          error: "ai_budget_unavailable",
          detail: "the AI design budget ledger could not be read, so no design was started; try again shortly",
        },
      };
    }
    if (!budget.allowed) {
      return json(402, {
        error: "ai_budget_exceeded",
        detail: `monthly AI design budget of $${budget.limitUsd.toString()} is exhausted`,
        spentUsd: budget.spentUsd,
        limitUsd: budget.limitUsd,
      });
    }
  }
  return null;
}

function buildDesignHandler(ctx: AiDesignContext): Handler {
  return async ({ principal, parsedBody }) => {
    const denial = guard(ctx, principal);
    if (denial !== null) return denial;
    const tenant = tenantOf(principal);
    if (tenant === null) return json(400, { error: "tenant_required" });
    if (ctx.designer === null) {
      return json(503, { error: "ai_unavailable", detail: "no AI provider configured" });
    }
    const parsed = DesignRequestSchema.safeParse(parsedBody ?? {});
    if (!parsed.success) return json(400, { error: "invalid_request", detail: parsed.error.issues });
    const admitted = await admitDesign(ctx, tenant);
    if (admitted !== null) return admitted;
    const result = await ctx.designer({ tenantId: tenant, ...parsed.data });
    if (result.failure === "monthly_budget_exhausted") {
      return json(402, {
        error: "ai_budget_exceeded",
        detail: result.issues[0] ?? "the monthly AI design budget cannot absorb this design",
        attempts: result.attempts,
      });
    }
    if (!result.ok || result.manifest === null || result.manifestHash === null) {
      return json(422, { error: "design_failed", issues: result.issues, attempts: result.attempts });
    }
    const proposal = await ctx.store.create(tenant, {
      name: parsed.data.name ?? DEFAULT_PROPOSAL_NAME,
      description: parsed.data.description,
      manifest: result.manifest,
      manifestHash: result.manifestHash,
      source: "ai",
      providerLabel: result.providerLabel,
      designedBy: designerOf(principal),
    });
    return json(201, { proposal, summary: ctx.summarize(proposal.manifest) });
  };
}

function buildDesignJobCreateHandler(ctx: AiDesignContext): Handler {
  return async ({ principal, parsedBody }) => {
    const denial = guard(ctx, principal);
    if (denial !== null) return denial;
    const tenant = tenantOf(principal);
    if (tenant === null) return json(400, { error: "tenant_required" });
    if (ctx.designer === null) {
      return json(503, { error: "ai_unavailable", detail: "no AI provider configured" });
    }
    const { jobs, startJob } = ctx;
    if (jobs === undefined || startJob === undefined) {
      return json(503, { error: "async_unavailable", detail: "no design job store configured" });
    }
    const parsed = DesignRequestSchema.safeParse(parsedBody ?? {});
    if (!parsed.success) return json(400, { error: "invalid_request", detail: parsed.error.issues });
    // Same gates as the synchronous route: enqueueing must not be a way around either.
    const admitted = await admitDesign(ctx, tenant);
    if (admitted !== null) return admitted;
    const name = parsed.data.name ?? DEFAULT_PROPOSAL_NAME;
    const job = await jobs.create(tenant, {
      name,
      description: parsed.data.description,
      maxAttempts: DESIGN_JOB_MAX_ATTEMPTS,
    });
    startJob(tenant, job.id, {
      description: parsed.data.description,
      name,
      designedBy: designerOf(principal),
    });
    return json(202, { job });
  };
}

function buildDesignJobGetHandler(ctx: AiDesignContext): Handler {
  return async ({ principal, params }) => {
    const denial = guard(ctx, principal);
    if (denial !== null) return denial;
    const tenant = tenantOf(principal);
    if (tenant === null) return json(400, { error: "tenant_required" });
    const { jobs } = ctx;
    if (jobs === undefined) {
      return json(503, { error: "async_unavailable", detail: "no design job store configured" });
    }
    const id = params["id"] ?? "";
    const job = await jobs.getById(tenant, id);
    if (job === null) return json(404, { error: "job_not_found", detail: id });
    if (job.status !== "succeeded" || job.proposalId === null) return json(200, { job });
    // Hand the wizard the finished proposal in the same poll it learns the job is done.
    const proposal = await ctx.store.getById(tenant, job.proposalId);
    const diff =
      proposal === null
        ? {}
        : await diffFragment(
            ctx.diffManifests,
            ctx.activeManifests,
            tenant,
            proposal.manifest,
            ctx.diffLineage,
          );
    return json(200, {
      job,
      proposal,
      summary: proposal === null ? null : ctx.summarize(proposal.manifest),
      ...(proposal === null ? {} : schemaFragment(ctx.projectSchema, proposal.manifest)),
      ...diff,
    });
  };
}

function buildListHandler(ctx: AiDesignContext): Handler {
  return async (input) => {
    const denial = guard(ctx, input.principal);
    if (denial !== null) return denial;
    const tenant = tenantOf(input.principal);
    if (tenant === null) return json(400, { error: "tenant_required" });
    let page: AiManifestListPage;
    try {
      page = await ctx.store.list(tenant, readListQuery(input));
    } catch {
      // This handler had no catch at all, so a stored manifest row the contract no longer accepts
      // escaped as an unclassified 500 — and it is the one of these list routes that is live on a
      // flag the shipped compose passes (`--ai-design`). The declared consequence is that the design
      // list is unreadable for that tenant. Named, with no detail: a manifest row quotes a tenant's
      // own design.
      return json(500, { error: "manifest_page_unreadable" });
    }
    return json(200, { data: page.data, page: { nextCursor: page.nextCursor } });
  };
}

function buildGetHandler(ctx: AiDesignContext): Handler {
  return async ({ principal, params }) => {
    const denial = guard(ctx, principal);
    if (denial !== null) return denial;
    const tenant = tenantOf(principal);
    if (tenant === null) return json(400, { error: "tenant_required" });
    const id = params["id"] ?? "";
    const proposal = await ctx.store.getById(tenant, id);
    if (proposal === null) return json(404, { error: "proposal_not_found", detail: id });
    const diff = await diffFragment(
      ctx.diffManifests,
      ctx.activeManifests,
      tenant,
      proposal.manifest,
      ctx.diffLineage,
    );
    return json(200, {
      proposal,
      summary: ctx.summarize(proposal.manifest),
      ...schemaFragment(ctx.projectSchema, proposal.manifest),
      ...diff,
    });
  };
}

function buildActivateHandler(ctx: AiDesignContext): Handler {
  return async ({ principal, params }) => {
    const denial = guard(ctx, principal);
    if (denial !== null) return denial;
    const tenant = tenantOf(principal);
    if (tenant === null) return json(400, { error: "tenant_required" });
    const id = params["id"] ?? "";
    const current = await ctx.store.getById(tenant, id);
    if (current === null) return json(404, { error: "proposal_not_found", detail: id });
    if (current.status === "active") {
      return json(409, { error: "illegal_transition", detail: `${current.status} -> active` });
    }
    // A configured gate admits only an explicit `approved`. `not_required` is denied too:
    // turning review on must not leave proposals minted beforehand as a back door.
    if (ctx.reviewGate !== undefined) {
      const reviewStatus = await ctx.reviewGate.reviewStatusFor(tenant, id);
      if (reviewStatus !== "approved") {
        return json(403, {
          error: "review_required",
          detail: "this proposal must be approved by a platform reviewer before activation",
          reviewStatus,
        });
      }
    }
    // After the review gate, so an unreviewed proposal is told it needs review rather than what is
    // wrong with it; before `activate`, so a refusal writes nothing and the tenant goes on being
    // served what it was served (ADR-0470). 422 and not 503: the request was understood and the
    // manifest is what is wrong, so retrying it unchanged cannot succeed.
    //
    // Except for `unknown`, which says the reverse: nothing about the manifest was established —
    // the check threw something the cache could not classify — so the honest answer is the one the
    // gateway gives the same condition, a 503 a client may retry (`GATEWAY_BUILD_REFUSALS` marks
    // `unknown` non-permanent). A 422 there would tell a tenant admin their manifest is wrong while
    // its sentence tells them to try again.
    const refusal = await ctx.activationCheck(tenant, current.manifest);
    if (refusal !== null && refusal.kind === "unknown") {
      return {
        kind: "json",
        status: 503,
        headers: { "retry-after": ACTIVATION_CHECK_RETRY_AFTER_SECONDS.toString() },
        body: { error: "activation_check_unavailable", kind: refusal.kind, detail: refusal.sentence },
      };
    }
    if (refusal !== null) {
      return json(422, {
        error: "activation_unservable",
        kind: refusal.kind,
        detail: refusal.sentence,
        issues: refusal.issues,
      });
    }
    const proposal = await ctx.store.activate(tenant, id);
    if (proposal === null) return json(404, { error: "proposal_not_found", detail: id });
    ctx.onActivated?.(tenant);
    return json(200, { proposal });
  };
}

function buildArchiveHandler(ctx: AiDesignContext): Handler {
  return async ({ principal, params }) => {
    const denial = guard(ctx, principal);
    if (denial !== null) return denial;
    const tenant = tenantOf(principal);
    if (tenant === null) return json(400, { error: "tenant_required" });
    const id = params["id"] ?? "";
    const current = await ctx.store.getById(tenant, id);
    if (current === null) return json(404, { error: "proposal_not_found", detail: id });
    if (current.status === "archived") {
      return json(409, { error: "illegal_transition", detail: `${current.status} -> archived` });
    }
    const proposal = await ctx.store.setStatus(tenant, id, "archived");
    if (proposal === null) return json(404, { error: "proposal_not_found", detail: id });
    return json(200, { proposal });
  };
}

/**
 * The in-product AI Architect routes to inject via the gateway's `extraRoutes` hook.
 * The table is fixed at seven routes whether or not async mode is wired — the job
 * handlers self-503 — so the route table never varies with deployment config.
 */
export function buildAiDesignRoutes(ctx: AiDesignContext): readonly ExtraGatewayRoute[] {
  const v = (
    op: string,
    method: RouteDefinition["method"],
    segs: ReadonlyArray<string | { param: string }>,
    handler: Handler,
  ): ExtraGatewayRoute => ({ route: route(op, method, segs), handler });
  return [
    v("ai.design", "POST", ["v1", "ai", "design"], buildDesignHandler(ctx)),
    v("ai.design.jobs.create", "POST", ["v1", "ai", "design", "jobs"], buildDesignJobCreateHandler(ctx)),
    v(
      "ai.design.jobs.get",
      "GET",
      ["v1", "ai", "design", "jobs", { param: "id" }],
      buildDesignJobGetHandler(ctx),
    ),
    v("ai.manifests.list", "GET", ["v1", "ai", "manifests"], buildListHandler(ctx)),
    v("ai.manifests.get", "GET", ["v1", "ai", "manifests", { param: "id" }], buildGetHandler(ctx)),
    v(
      "ai.manifests.activate",
      "POST",
      ["v1", "ai", "manifests", { param: "id" }, "activate"],
      buildActivateHandler(ctx),
    ),
    v(
      "ai.manifests.archive",
      "POST",
      ["v1", "ai", "manifests", { param: "id" }, "archive"],
      buildArchiveHandler(ctx),
    ),
  ];
}

function route(
  operationId: string,
  method: RouteDefinition["method"],
  segments: ReadonlyArray<string | { param: string }>,
): RouteDefinition {
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
