import type { PathSegment, ResolvedPrincipal, RouteDefinition } from "@crossengin/api-gateway";
import type { Handler, HandlerOutput, PrincipalRoles } from "@crossengin/api-gateway-runtime";
import type { ExtraGatewayRoute } from "@crossengin/operate-runtime";
import { z } from "zod";

/**
 * `GET /v1/platform/tenants/{id}/schema` and `POST /v1/platform/tenants/{id}/erase-schema` — the
 * surface that makes a tenant deletion true (ADR-0314's gap).
 *
 * ADR-0314 provisioned a tenant's activated manifest into its own Postgres schema; nothing removed it,
 * so `tenant-lifecycle`'s GDPR Article 17 flow signed a `TombstoneRecord` — a content-manifest hash
 * and a `proofSha256` over a `DeletionScope` — while every row of the tenant's business data survived.
 * The contract was never the problem: `DeletionScopeSchema.schemas` existed, and
 * `TombstoneRecordSchema` already refuses a `tenant_deletion` declaring no schema, table, bucket or
 * backup. What was missing was anything that could *fill it in truthfully*.
 *
 * These two routes are deliberately a pair, and the split is the point.
 *
 * **The survey is a separate, read-only route** because a destructive action an operator cannot see the
 * extent of first is one they approve blind. It writes nothing and takes no lock, so it is safe to
 * render in a console.
 *
 * **Four-eyes is structural, not advisory.** `executedBy` is the authenticated caller and is never read
 * from the body; `approvedBy` comes from the body and must differ. So the route cannot be driven by one
 * person holding one credential, which is the same rule `TombstoneRecordSchema` enforces on the
 * receipt — applied here *before* the data is gone, because a record that fails to parse afterwards is
 * a refusal that arrives too late to matter.
 *
 * **The response is the tombstone's evidence.** It carries the schema, the schema-qualified table list,
 * the exact row count and the byte total, which is what a caller merges into `DeletionScope`. A
 * refusal carries its reasons instead and the scope stays empty, so an under-informed tombstone cannot
 * be assembled from a failed erasure.
 *
 * Note what these routes do **not** do: they do not transition the tenant to `deleted`. That state is
 * reachable only through `pending_deletion` in `tenant-lifecycle`, and the console's own transition map
 * excludes it on purpose. Erasing the schema is the step that earns the transition; it is not the
 * transition.
 */

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Structural mirror of `TenantSchemaRelation`, so the route layer imports no Postgres package. */
export interface ErasureRelationLike {
  readonly table: string;
  readonly rowCount: number;
  readonly storageBytes: number;
}

export interface ErasureRefusalLike {
  readonly reason: string;
  readonly detail: string;
}

export interface SchemaSurveyLike {
  readonly tenantId: string;
  readonly schema: string;
  readonly exists: boolean;
  readonly relations: readonly ErasureRelationLike[];
  readonly rowCount: number;
  readonly storageBytes: number;
  /**
   * What a trial cascade showed it would destroy outside the schema. Advisory here — the erasure
   * re-establishes it under the per-tenant lock, which is the answer that decides — so a console can
   * show an operator "this would also drop X" before they approve.
   */
  readonly collateral: ReadonlyArray<{ readonly description: string; readonly schema: string | null }>;
}

export interface SchemaErasureLike {
  readonly tenantId: string;
  readonly schema: string;
  readonly erased: boolean;
  readonly alreadyAbsent: boolean;
  readonly statements: readonly string[];
  readonly refusals: readonly ErasureRefusalLike[];
  readonly erasedRelations: readonly ErasureRelationLike[];
  readonly rowCount: number;
  readonly storageBytes: number;
  readonly erasedAt: string;
}

export interface ErasureAuthorityLike {
  readonly executedBy: string;
  readonly approvedBy: string;
}

/** Structural mirror of the two calls this surface needs. No listing, no un-erase. */
export interface TenantSchemaEraserLike {
  survey(tenantId: string): Promise<SchemaSurveyLike>;
  erase(tenantId: string, authority: ErasureAuthorityLike): Promise<SchemaErasureLike>;
}

export const TENANT_SCHEMA_SURVEY_OPERATION = "platform.tenant_schema_surveyed";
export const TENANT_SCHEMA_ERASED_OPERATION = "platform.tenant_schema_erased";
export const TENANT_SCHEMA_ERASE_REFUSED_OPERATION = "platform.tenant_schema_erase_refused";

export interface TenantErasureEvent {
  readonly tenantId: string;
  readonly schema: string;
  readonly principalId: string | null;
  readonly operation: string;
  /** Null for a survey, which erases nothing. */
  readonly approvedBy: string | null;
  readonly rowCount: number;
  readonly storageBytes: number;
  readonly tables: readonly string[];
  readonly refusals: readonly string[];
  readonly at: string;
}

/**
 * Required, not optional. Destroying a tenant's data unrecorded is the one outcome worse than not
 * destroying it: the deletion then has no provenance at all, which is what a tombstone exists to
 * supply. An erasure whose record cannot be written is refused.
 */
export type TenantErasureRecorder = (event: TenantErasureEvent) => Promise<void>;

export interface TenantErasureRoutesContext {
  readonly eraser: TenantSchemaEraserLike;
  readonly principalRoles: (principal: ResolvedPrincipal | null) => PrincipalRoles;
  /**
   * Roles permitted to survey and erase. Fail-closed: empty ⇒ nobody. Deliberately one grant for both
   * — somebody who may see exactly what a tenant holds is already trusted with that tenant's data, and
   * splitting them would mostly produce operators who can erase without looking first.
   */
  readonly adminRoles: ReadonlySet<string>;
  readonly recordAction: TenantErasureRecorder;
  readonly clock?: () => Date;
  readonly onRecordError?: (err: unknown, operation: string) => void;
}

export const EraseSchemaInputSchema = z
  .object({
    /** The second person. Refused when it equals the caller — see the module note. */
    approvedBy: z.string().min(1).max(200),
    /**
     * The tenant id, repeated in the body. A destructive, irreversible action should not be one
     * mistyped path segment away, so the path and the body must agree.
     */
    confirmTenantId: z.string().regex(UUID_RE),
  })
  .strict();
export type EraseSchemaInput = z.infer<typeof EraseSchemaInputSchema>;

function json(status: number, body: unknown): HandlerOutput {
  return { kind: "json", status, body };
}

function rolesOf(
  ctx: TenantErasureRoutesContext,
  principal: ResolvedPrincipal | null,
): readonly string[] {
  const { primaryRole, secondaryRoles } = ctx.principalRoles(principal);
  return [primaryRole, ...(secondaryRoles ?? [])];
}

function authorized(ctx: TenantErasureRoutesContext, principal: ResolvedPrincipal | null): boolean {
  if (ctx.adminRoles.size === 0) return false;
  return rolesOf(ctx, principal).some((r) => ctx.adminRoles.has(r));
}

function qualify(schema: string, relations: readonly ErasureRelationLike[]): readonly string[] {
  return relations.map((r) => `${schema}.${r.table}`);
}

/**
 * The erasure as a `DeletionAttestation` for `@crossengin/tenant-lifecycle`'s assembler, in exactly
 * the shape it parses.
 *
 * Emitted rather than left to the caller because transcribing it by hand is how ADR-0316's defect
 * happened one level up: a scope assembled from memory rather than from what a subsystem reported.
 * Shaped structurally instead of importing the type, like every mirror in this module, so the route
 * layer keeps no dependency on the contracts package.
 *
 * `outcome` distinguishes the two honest answers: `erased` carries figures, `nothing_to_erase` carries
 * none and is what an already-absent schema reports — the assembler refuses a scope on anything but
 * `erased`, so there is no way to report figures for a deletion that did not happen.
 */
export function erasureAttestation(
  erasure: SchemaErasureLike,
  attestedBy: string,
): {
  readonly subsystem: "tenant_schema";
  readonly outcome: "erased" | "nothing_to_erase";
  readonly scope?: {
    readonly schemas: readonly string[];
    readonly tables: readonly string[];
    readonly rowCount: number;
    readonly storageBytes: number;
  };
  readonly attestedBy: string;
  readonly attestedAt: string;
} {
  if (!erasure.erased) {
    return {
      subsystem: "tenant_schema",
      outcome: "nothing_to_erase",
      attestedBy,
      attestedAt: erasure.erasedAt,
    };
  }
  return {
    subsystem: "tenant_schema",
    outcome: "erased",
    scope: {
      schemas: [erasure.schema],
      tables: qualify(erasure.schema, erasure.erasedRelations),
      rowCount: erasure.rowCount,
      storageBytes: erasure.storageBytes,
    },
    attestedBy,
    attestedAt: erasure.erasedAt,
  };
}

/** The `DeletionScope` fields this erasure accounts for, in the shape a tombstone takes. */
export function erasureScopeView(erasure: SchemaErasureLike): {
  readonly schemas: readonly string[];
  readonly tables: readonly string[];
  readonly rowCount: number;
  readonly storageBytes: number;
} {
  if (!erasure.erased) return { schemas: [], tables: [], rowCount: 0, storageBytes: 0 };
  return {
    schemas: [erasure.schema],
    tables: qualify(erasure.schema, erasure.erasedRelations),
    rowCount: erasure.rowCount,
    storageBytes: erasure.storageBytes,
  };
}

function buildSurveyHandler(ctx: TenantErasureRoutesContext): Handler {
  return async (input) => {
    if (input.principal === null) return json(401, { error: "authentication_required" });
    if (!authorized(ctx, input.principal)) {
      return json(403, { error: "forbidden", detail: "surveying a tenant's schema is not granted to this role" });
    }
    const tenantId = input.params["id"] ?? "";
    if (!UUID_RE.test(tenantId)) {
      return json(400, { error: "invalid_request", detail: "tenant id must be a uuid" });
    }
    let survey: SchemaSurveyLike;
    try {
      survey = await ctx.eraser.survey(tenantId);
    } catch {
      return json(503, { error: "survey_unavailable", detail: "the tenant's schema could not be surveyed" });
    }
    const at = (ctx.clock ?? ((): Date => new Date()))().toISOString();
    // A survey reads exactly what a deletion would destroy, so it is recorded — but a failure to
    // record does not refuse it, because nothing was destroyed and a 503 here would only stop an
    // operator from looking before they act.
    try {
      await ctx.recordAction({
        tenantId,
        schema: survey.schema,
        principalId: input.principal.principalId,
        operation: TENANT_SCHEMA_SURVEY_OPERATION,
        approvedBy: null,
        rowCount: survey.rowCount,
        storageBytes: survey.storageBytes,
        tables: qualify(survey.schema, survey.relations),
        refusals: [],
        at,
      });
    } catch (err) {
      ctx.onRecordError?.(err, TENANT_SCHEMA_SURVEY_OPERATION);
    }
    return json(200, {
      tenantId,
      schema: survey.schema,
      exists: survey.exists,
      tables: survey.relations.map((r) => ({
        table: `${survey.schema}.${r.table}`,
        rowCount: r.rowCount,
        storageBytes: r.storageBytes,
      })),
      rowCount: survey.rowCount,
      storageBytes: survey.storageBytes,
      collateral: survey.collateral,
      // Spelled out rather than left for the caller to infer from an empty array: "nothing here" and
      // "blocked" are different answers and an operator must not read one as the other.
      erasable: survey.exists && survey.collateral.length === 0,
    });
  };
}

function buildEraseHandler(ctx: TenantErasureRoutesContext): Handler {
  return async (input) => {
    if (input.principal === null) return json(401, { error: "authentication_required" });
    if (!authorized(ctx, input.principal)) {
      return json(403, { error: "forbidden", detail: "erasing a tenant's schema is not granted to this role" });
    }
    const tenantId = input.params["id"] ?? "";
    if (!UUID_RE.test(tenantId)) {
      return json(400, { error: "invalid_request", detail: "tenant id must be a uuid" });
    }
    const parsed = EraseSchemaInputSchema.safeParse(input.parsedBody ?? {});
    if (!parsed.success) {
      return json(400, {
        error: "invalid_request",
        detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      });
    }
    if (parsed.data.confirmTenantId.toLowerCase() !== tenantId.toLowerCase()) {
      return json(400, {
        error: "invalid_request",
        detail: "confirmTenantId must equal the tenant in the path",
      });
    }
    const executedBy = input.principal.principalId;
    if (executedBy === parsed.data.approvedBy) {
      // Also refused by the plan, which is the layer that matters; refused here so the caller gets a
      // 403 naming the rule rather than a generic refusal after a survey has already run.
      return json(403, {
        error: "four_eyes_required",
        detail: "approvedBy must not be the caller: erasing a tenant's data needs a second person",
      });
    }

    let erasure: SchemaErasureLike;
    try {
      erasure = await ctx.eraser.erase(tenantId, { executedBy, approvedBy: parsed.data.approvedBy });
    } catch (err) {
      // Includes the "dropped but still present" guard, which rolls back rather than reporting
      // success. No detail: the message can name the schema's internals.
      ctx.onRecordError?.(err, TENANT_SCHEMA_ERASED_OPERATION);
      return json(503, { error: "erasure_failed", detail: "the schema was not erased; nothing was changed" });
    }

    const at = (ctx.clock ?? ((): Date => new Date()))().toISOString();
    const refused = erasure.refusals.length > 0;
    try {
      await ctx.recordAction({
        tenantId,
        schema: erasure.schema,
        principalId: executedBy,
        operation: refused ? TENANT_SCHEMA_ERASE_REFUSED_OPERATION : TENANT_SCHEMA_ERASED_OPERATION,
        approvedBy: parsed.data.approvedBy,
        rowCount: erasure.rowCount,
        storageBytes: erasure.storageBytes,
        tables: qualify(erasure.schema, erasure.erasedRelations),
        refusals: erasure.refusals.map((r) => r.reason),
        at,
      });
    } catch (err) {
      ctx.onRecordError?.(err, TENANT_SCHEMA_ERASED_OPERATION);
      if (!refused) {
        // The data is gone and the record is not. Reported as a 500 naming exactly that, because a
        // 200 would let a caller build a tombstone with no provenance behind it, and a plain 503
        // would read as "nothing happened" — which is the one thing that is no longer true.
        return json(500, {
          error: "erasure_unrecorded",
          detail:
            `the schema for tenant ${tenantId} was erased but the action could not be recorded;` +
            " do not issue a tombstone from this response",
          scope: erasureScopeView(erasure),
        });
      }
    }

    if (refused) {
      return json(409, {
        error: "erasure_refused",
        refusals: erasure.refusals,
        scope: erasureScopeView(erasure),
      });
    }
    return json(200, {
      tenantId,
      schema: erasure.schema,
      erased: erasure.erased,
      alreadyAbsent: erasure.alreadyAbsent,
      erasedAt: erasure.erasedAt,
      statements: erasure.statements,
      scope: erasureScopeView(erasure),
      // Ready to POST into the tombstone assembler without transcription: a scope retyped by hand is
      // a scope that can disagree with what was destroyed.
      attestation: erasureAttestation(erasure, `operate-server/tenant-erasure:${executedBy}`),
    });
  };
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
    // Not required: the erasure is idempotent in its end state — a second call finds the schema absent
    // and reports `alreadyAbsent` rather than failing — so a retried POST needs no key to be safe.
    idempotencyRequired: false,
    requestSchemaSha256: null,
    responseSchemaSha256: null,
  };
}

export function buildTenantErasureRoutes(
  ctx: TenantErasureRoutesContext,
): readonly ExtraGatewayRoute[] {
  return [
    {
      route: route("platform.tenants.schema", "GET", [
        "v1",
        "platform",
        "tenants",
        { param: "id" },
        "schema",
      ]),
      handler: buildSurveyHandler(ctx),
    },
    {
      route: route("platform.tenants.eraseSchema", "POST", [
        "v1",
        "platform",
        "tenants",
        { param: "id" },
        "erase-schema",
      ]),
      handler: buildEraseHandler(ctx),
    },
  ];
}
