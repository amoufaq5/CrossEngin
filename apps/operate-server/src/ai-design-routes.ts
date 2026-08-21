import type { PathSegment, ResolvedPrincipal, RouteDefinition } from "@crossengin/api-gateway";
import type { Handler, HandlerOutput, PrincipalRoles } from "@crossengin/api-gateway-runtime";
import type { ExtraGatewayRoute } from "@crossengin/operate-runtime";
import { z } from "zod";

export const AI_MANIFEST_STATUSES = ["draft", "active", "archived"] as const;
export type AiManifestStatus = (typeof AI_MANIFEST_STATUSES)[number];

export const AI_MANIFEST_SOURCES = ["ai", "manual"] as const;
export type AiManifestSource = (typeof AI_MANIFEST_SOURCES)[number];

export interface AiManifestRecordLike {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly description: string;
  readonly manifest: Record<string, unknown>;
  readonly manifestHash: string;
  readonly status: AiManifestStatus;
  readonly source: AiManifestSource;
  readonly providerLabel: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly activatedAt: string | null;
}

export interface AiManifestCreateInput {
  readonly name: string;
  readonly description: string;
  readonly manifest: Record<string, unknown>;
  readonly manifestHash: string;
  readonly source: AiManifestSource;
  readonly providerLabel?: string | null;
}

export interface AiManifestListQuery {
  readonly status?: AiManifestStatus;
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
  setStatus(tenantId: string, id: string, status: AiManifestStatus): Promise<AiManifestRecordLike | null>;
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
}

export type ManifestDesignerLike = (input: {
  description: string;
  name?: string;
}) => Promise<DesignResultLike>;

export interface AiDesignContext {
  readonly store: AiManifestStore;
  /** null ⇒ no AI provider configured — design requests get 503. */
  readonly designer: ManifestDesignerLike | null;
  readonly principalRoles: (principal: ResolvedPrincipal | null) => PrincipalRoles;
  /** Roles permitted to use the AI Architect. Fail-closed: empty ⇒ nobody. */
  readonly allowedRoles: ReadonlySet<string>;
  readonly onActivated?: (tenantId: string) => void;
  readonly summarize: (manifest: Record<string, unknown>) => unknown;
}

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

function firstQueryValue(value: string | readonly string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : (value as string);
}

function readListQuery(input: Parameters<Handler>[0]): AiManifestListQuery {
  const query = (input.request as { query?: Record<string, string | string[]> } | undefined)?.query ?? {};
  const statusRaw = firstQueryValue(query["status"]);
  const status =
    statusRaw !== undefined && (AI_MANIFEST_STATUSES as readonly string[]).includes(statusRaw)
      ? (statusRaw as AiManifestStatus)
      : undefined;
  const limitRaw = firstQueryValue(query["limit"]);
  const limit = limitRaw === undefined ? undefined : Number.parseInt(limitRaw, 10);
  const cursor = firstQueryValue(query["cursor"]);
  return { status, limit, cursor };
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
    const result = await ctx.designer(parsed.data);
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
    });
    return json(201, { proposal, summary: ctx.summarize(proposal.manifest) });
  };
}

function buildListHandler(ctx: AiDesignContext): Handler {
  return async (input) => {
    const denial = guard(ctx, input.principal);
    if (denial !== null) return denial;
    const tenant = tenantOf(input.principal);
    if (tenant === null) return json(400, { error: "tenant_required" });
    const page = await ctx.store.list(tenant, readListQuery(input));
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
    return json(200, { proposal, summary: ctx.summarize(proposal.manifest) });
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

/** The in-product AI Architect routes to inject via the gateway's `extraRoutes` hook. */
export function buildAiDesignRoutes(ctx: AiDesignContext): readonly ExtraGatewayRoute[] {
  const v = (
    op: string,
    method: RouteDefinition["method"],
    segs: ReadonlyArray<string | { param: string }>,
    handler: Handler,
  ): ExtraGatewayRoute => ({ route: route(op, method, segs), handler });
  return [
    v("ai.design", "POST", ["v1", "ai", "design"], buildDesignHandler(ctx)),
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
