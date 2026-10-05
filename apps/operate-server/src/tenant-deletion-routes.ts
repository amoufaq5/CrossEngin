import type { PathSegment, ResolvedPrincipal, RouteDefinition } from "@crossengin/api-gateway";
import type { Handler, HandlerOutput, PrincipalRoles } from "@crossengin/api-gateway-runtime";
import type { ExtraGatewayRoute } from "@crossengin/operate-runtime";
import { z } from "zod";

/**
 * `POST /v1/platform/tenants/{id}/delete` and `GET /v1/platform/tenants/{id}/tombstones` — the route
 * that runs the GDPR Article 17 flow, and the one that reads its receipt.
 *
 * ADR-0319 made the deletion atomic and left it unreachable: erase, attest, assemble, anchor and store
 * all commit together, and nothing called them. This is the endpoint, and it is deliberately the
 * *only* way to reach the `deleted` state — `platform-admin.ts`'s `TENANT_STATUS_TRANSITIONS` excludes
 * `deleted` from every set on purpose, with the comment that "tenant deletion is the GDPR Article 17
 * flow in `tenant-lifecycle`, not a console button". This is that flow.
 *
 * Four properties the route owns, because the pipeline below it cannot.
 *
 * **Its own grant, fail-closed.** Not the erasure's: erasing a schema destroys a tenant's business
 * data, and *deleting the tenant* additionally ends the relationship and issues a signed receipt for
 * it. One is a step the other contains, so sharing a grant would mean anybody who can do the step can
 * do the whole thing.
 *
 * **Four-eyes, structurally.** `executedBy` is the authenticated caller and is never read from the
 * body; `approvedBy` comes from the body and must differ. The pipeline refuses it too, and so does the
 * column (ADR-0318) — three layers for one rule, because this is the most destructive act the platform
 * can perform.
 *
 * **The tenant row is retired *after* the pipeline commits, never before.** ADR-0316 found the
 * ordering the hard way: the tombstone's chain anchor references `meta.tenants`, so retiring the row
 * first makes the deletion unrecordable. Committed in this order a failure to retire leaves a correct,
 * anchored tombstone and a tenant row that still says `active` — visible, recoverable, and with the
 * data correctly gone and proven gone. The reverse leaves data destroyed with no provenance.
 *
 * **The response carries the receipt.** A caller who deleted a tenant needs the tombstone id and its
 * chain coordinates, because that is the only thing that can later establish what was destroyed. A 200
 * that reported merely "deleted" would be the ADR-0317 defect in response form.
 */

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Mirrors `TOMBSTONE_ID_REGEX` in the contract, so a generated id cannot fail downstream. */
const TOMBSTONE_ID_RE = /^tomb_[A-Za-z0-9_-]{12,40}$/;

export const DELETABLE_TOMBSTONE_KINDS = ["tenant_deletion", "data_subject_erasure"] as const;
export type DeletableTombstoneKind = (typeof DELETABLE_TOMBSTONE_KINDS)[number];

/** Structural mirror of a `DeletionAttestation`, so the route layer imports no contracts package. */
export interface AttestationLike {
  readonly subsystem: string;
  readonly outcome: string;
  readonly scope?: Readonly<Record<string, unknown>>;
  readonly retentionObligation?: string;
  readonly retainedDataReference?: string;
  readonly attestedBy: string;
  readonly attestedAt: string;
}

export interface StoredTombstoneLike {
  readonly record: {
    readonly id: string;
    readonly kind: string;
    readonly tenantId: string;
    readonly deletedAt: string;
    readonly scope: Readonly<Record<string, unknown>>;
    readonly contentManifestSha256: string;
    readonly proofSha256: string;
    readonly anchors: readonly { readonly kind: string; readonly reference: string }[];
    readonly retainedReason?: string;
  };
  readonly attestations: readonly AttestationLike[];
  readonly chainEntryHash: string | null;
  readonly chainSequenceNumber: number | null;
}

export type DeletionOutcomeLike =
  | {
      readonly ok: true;
      readonly stored: StoredTombstoneLike;
      readonly erased: {
        readonly schema: string;
        readonly tables: readonly string[];
        readonly rowCount: number;
        readonly storageBytes: number;
        readonly alreadyAbsent: boolean;
      };
    }
  | {
      readonly ok: false;
      readonly refusals: readonly { readonly stage: string; readonly reason: string; readonly detail: string }[];
    };

/** The slice of the pipeline this route drives. One call; there is no un-delete. */
export interface TenantDeleterLike {
  delete(input: {
    readonly tenantId: string;
    readonly tombstoneId: string;
    readonly kind: DeletableTombstoneKind;
    readonly executedBy: string;
    readonly approvedBy: string;
    readonly attestations: readonly AttestationLike[];
    readonly relatedDeletionRequestId?: string;
  }): Promise<DeletionOutcomeLike>;
  /** Retires the tenant row. Called only after the pipeline has committed. */
  retire(tenantId: string): Promise<boolean>;
  tombstonesFor(tenantId: string): Promise<readonly StoredTombstoneLike[]>;
}

export const TENANT_DELETED_OPERATION = "platform.tenant_deleted";
export const TENANT_DELETE_REFUSED_OPERATION = "platform.tenant_delete_refused";
export const TENANT_TOMBSTONES_READ_OPERATION = "platform.tenant_tombstones_read";

export interface TenantDeletionEvent {
  readonly tenantId: string;
  readonly principalId: string;
  readonly approvedBy: string | null;
  readonly operation: string;
  readonly tombstoneId: string | null;
  readonly chainEntryHash: string | null;
  readonly rowCount: number;
  readonly refusals: readonly string[];
  readonly tenantRetired: boolean;
  readonly at: string;
}

/**
 * Required. Deleting a tenant unrecorded is the one outcome worse than not deleting it, and unlike the
 * erasure's recorder this one has a *second* record behind it — the tombstone — so a failure here is
 * reported without claiming the deletion itself failed.
 */
export type TenantDeletionRecorder = (event: TenantDeletionEvent) => Promise<void>;

export interface TenantDeletionRoutesContext {
  readonly deleter: TenantDeleterLike;
  readonly principalRoles: (principal: ResolvedPrincipal | null) => PrincipalRoles;
  /** Roles permitted to delete a tenant. Fail-closed: empty ⇒ nobody. */
  readonly deleteRoles: ReadonlySet<string>;
  /**
   * Roles permitted to read a tenant's tombstones. Defaults to `deleteRoles` when absent, since
   * anybody trusted to destroy a tenant is trusted to read the receipt — but separable, because
   * reading receipts is a reasonable thing to grant an auditor who may not delete.
   */
  readonly readRoles?: ReadonlySet<string>;
  readonly recordAction: TenantDeletionRecorder;
  readonly newTombstoneId?: () => string;
  readonly clock?: () => Date;
  readonly onRecordError?: (err: unknown, operation: string) => void;
  readonly onRetireError?: (err: unknown, tenantId: string) => void;
}

export const DeleteTenantInputSchema = z
  .object({
    approvedBy: z.string().min(1).max(200),
    /** An irreversible act should not be one mistyped path segment away. */
    confirmTenantId: z.string().regex(UUID_RE),
    kind: z.enum(DELETABLE_TOMBSTONE_KINDS).default("tenant_deletion"),
    /*
     * `requiredSubsystems` used to stand here, read from this body with `[]` as its default — so a
     * remote caller chose how much of the deployment the Article 17 proof covered, and omitting the
     * field covered nothing (ADR-0328). What a deployment holds is a property of the deployment, not
     * of a request, exactly as ADR-0321 found for the Article 12(3) deadline: it is declared once
     * with `--deletion-capabilities` and the route cannot narrow it.
     */
    attestations: z
      .array(
        z
          .object({
            subsystem: z.string().min(1),
            outcome: z.string().min(1),
            scope: z.record(z.unknown()).optional(),
            retentionObligation: z.string().min(1).optional(),
            retainedDataReference: z.string().min(1).optional(),
            attestedBy: z.string().min(1),
            attestedAt: z.string().datetime({ offset: true }),
          })
          .strict(),
      )
      .default([]),
    relatedDeletionRequestId: z.string().min(1).optional(),
  })
  .strict();
export type DeleteTenantInput = z.infer<typeof DeleteTenantInputSchema>;

function json(status: number, body: unknown): HandlerOutput {
  return { kind: "json", status, body };
}

function rolesOf(
  ctx: TenantDeletionRoutesContext,
  principal: ResolvedPrincipal | null,
): readonly string[] {
  const { primaryRole, secondaryRoles } = ctx.principalRoles(principal);
  return [primaryRole, ...(secondaryRoles ?? [])];
}

function allowed(
  ctx: TenantDeletionRoutesContext,
  principal: ResolvedPrincipal | null,
  grant: ReadonlySet<string>,
): boolean {
  if (grant.size === 0) return false;
  return rolesOf(ctx, principal).some((r) => grant.has(r));
}

/** A `tomb_…` id the contract accepts, from a UUID's hex. */
export function newTombstoneId(uuid: string): string {
  const id = `tomb_${uuid.replace(/-/g, "").slice(0, 32)}`;
  if (!TOMBSTONE_ID_RE.test(id)) {
    throw new Error(`generated tombstone id is invalid: ${JSON.stringify(id)}`);
  }
  return id;
}

/** The receipt a caller needs to establish later what was destroyed. */
export function tombstoneReceipt(stored: StoredTombstoneLike): Record<string, unknown> {
  return {
    tombstoneId: stored.record.id,
    kind: stored.record.kind,
    deletedAt: stored.record.deletedAt,
    scope: stored.record.scope,
    contentManifestSha256: stored.record.contentManifestSha256,
    proofSha256: stored.record.proofSha256,
    anchors: stored.record.anchors,
    chainEntryHash: stored.chainEntryHash,
    chainSequenceNumber: stored.chainSequenceNumber,
    attestedBy: stored.attestations.map((a) => `${a.subsystem}:${a.attestedBy}`),
    ...(stored.record.retainedReason !== undefined
      ? { retainedReason: stored.record.retainedReason }
      : {}),
  };
}

function buildDeleteHandler(ctx: TenantDeletionRoutesContext): Handler {
  return async (input) => {
    const principal = input.principal;
    if (principal === null) return json(401, { error: "authentication_required" });
    if (!allowed(ctx, principal, ctx.deleteRoles)) {
      return json(403, { error: "forbidden", detail: "deleting a tenant is not granted to this role" });
    }
    const tenantId = input.params["id"] ?? "";
    if (!UUID_RE.test(tenantId)) {
      return json(400, { error: "invalid_request", detail: "tenant id must be a uuid" });
    }
    const parsed = DeleteTenantInputSchema.safeParse(input.parsedBody ?? {});
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
    const executedBy = principal.principalId;
    if (executedBy === parsed.data.approvedBy) {
      return json(403, {
        error: "four_eyes_required",
        detail: "approvedBy must not be the caller: deleting a tenant needs a second person",
      });
    }
    if (parsed.data.kind === "data_subject_erasure" && parsed.data.relatedDeletionRequestId === undefined) {
      // The contract requires it and the pipeline would abort *after* the drop had executed. Refusing
      // here keeps a recoverable mistake from costing a rolled-back transaction over a tenant's data.
      return json(400, {
        error: "invalid_request",
        detail: "data_subject_erasure requires relatedDeletionRequestId",
      });
    }

    const at = (ctx.clock ?? ((): Date => new Date()))().toISOString();
    const tombstoneId = (ctx.newTombstoneId ?? (() => newTombstoneId(crypto.randomUUID())))();

    let outcome: DeletionOutcomeLike;
    try {
      outcome = await ctx.deleter.delete({
        tenantId,
        tombstoneId,
        kind: parsed.data.kind,
        executedBy,
        approvedBy: parsed.data.approvedBy,
        attestations: parsed.data.attestations,
        ...(parsed.data.relatedDeletionRequestId !== undefined
          ? { relatedDeletionRequestId: parsed.data.relatedDeletionRequestId }
          : {}),
      });
    } catch (err) {
      // Includes `DeletionPipelineAborted`, which means the whole transaction rolled back — the
      // tenant is exactly as it was. Reported as a 409 rather than a 500 because nothing is broken:
      // the deletion was refused after the drop and correctly undone.
      await record(ctx, {
        tenantId,
        principalId: executedBy,
        approvedBy: parsed.data.approvedBy,
        operation: TENANT_DELETE_REFUSED_OPERATION,
        tombstoneId: null,
        chainEntryHash: null,
        rowCount: 0,
        refusals: refusalReasons(err),
        tenantRetired: false,
        at,
      });
      return json(409, {
        error: "deletion_rolled_back",
        detail: "the deletion was refused and the transaction rolled back; the tenant is unchanged",
        refusals: refusalReasons(err),
      });
    }

    if (!outcome.ok) {
      await record(ctx, {
        tenantId,
        principalId: executedBy,
        approvedBy: parsed.data.approvedBy,
        operation: TENANT_DELETE_REFUSED_OPERATION,
        tombstoneId: null,
        chainEntryHash: null,
        rowCount: 0,
        refusals: outcome.refusals.map((r) => `${r.stage}/${r.reason}`),
        tenantRetired: false,
        at,
      });
      return json(409, { error: "deletion_refused", refusals: outcome.refusals });
    }

    // Committed. From here the data is gone and proven gone, so nothing below may report failure in a
    // way that suggests otherwise.
    let retired = false;
    try {
      retired = await ctx.deleter.retire(tenantId);
    } catch (err) {
      // Ordered deliberately after the commit (ADR-0316): the tombstone's anchor references
      // `meta.tenants`, so retiring first makes the deletion unrecordable. Failing here leaves a
      // correct anchored tombstone and a row that still says active — visible and recoverable.
      ctx.onRetireError?.(err, tenantId);
    }

    await record(ctx, {
      tenantId,
      principalId: executedBy,
      approvedBy: parsed.data.approvedBy,
      operation: TENANT_DELETED_OPERATION,
      tombstoneId: outcome.stored.record.id,
      chainEntryHash: outcome.stored.chainEntryHash,
      rowCount: outcome.erased.rowCount,
      refusals: [],
      tenantRetired: retired,
      at,
    });

    return json(200, {
      tenantId,
      deleted: true,
      tenantRetired: retired,
      erased: outcome.erased,
      // The receipt, not a bare "deleted": it is the only thing that can later establish what was
      // destroyed, and a response without it would be ADR-0317's defect in response form.
      tombstone: tombstoneReceipt(outcome.stored),
    });
  };
}

function refusalReasons(err: unknown): readonly string[] {
  const refusals = (err as { refusals?: unknown } | null)?.refusals;
  if (!Array.isArray(refusals)) return [err instanceof Error ? err.name : "unknown_error"];
  return refusals.map((r) => {
    const row = r as { stage?: unknown; reason?: unknown };
    return `${String(row.stage ?? "?")}/${String(row.reason ?? "?")}`;
  });
}

/**
 * Records, and never fails the request over it.
 *
 * Unlike the erasure's recorder (ADR-0316, which 500s because its record is the *only* provenance), a
 * deletion already has a stored, anchored tombstone by the time this runs. An unwritten audit line is
 * then a gap in the operational trail, not in the proof — so it is reported through `onRecordError`
 * rather than turned into a response that implies the deletion did not happen.
 */
async function record(ctx: TenantDeletionRoutesContext, event: TenantDeletionEvent): Promise<void> {
  try {
    await ctx.recordAction(event);
  } catch (err) {
    ctx.onRecordError?.(err, event.operation);
  }
}

function buildListHandler(ctx: TenantDeletionRoutesContext): Handler {
  return async (input) => {
    const principal = input.principal;
    if (principal === null) return json(401, { error: "authentication_required" });
    if (!allowed(ctx, principal, ctx.readRoles ?? ctx.deleteRoles)) {
      return json(403, {
        error: "forbidden",
        detail: "reading a tenant's tombstones is not granted to this role",
      });
    }
    const tenantId = input.params["id"] ?? "";
    if (!UUID_RE.test(tenantId)) {
      return json(400, { error: "invalid_request", detail: "tenant id must be a uuid" });
    }
    let tombstones: readonly StoredTombstoneLike[];
    try {
      tombstones = await ctx.deleter.tombstonesFor(tenantId);
    } catch {
      // The store re-parses every row, so a throw here can mean a stored record no longer satisfies
      // its contract (ADR-0289). That is a finding, and reporting it as "unavailable" rather than as
      // an empty list is what stops it reading as "this tenant was never deleted".
      return json(503, {
        error: "tombstones_unreadable",
        detail: "a stored tombstone could not be read; do not treat this as an absence",
      });
    }
    const at = (ctx.clock ?? ((): Date => new Date()))().toISOString();
    await record(ctx, {
      tenantId,
      principalId: principal.principalId,
      approvedBy: null,
      operation: TENANT_TOMBSTONES_READ_OPERATION,
      tombstoneId: null,
      chainEntryHash: null,
      rowCount: tombstones.length,
      refusals: [],
      tenantRetired: false,
      at,
    });
    return json(200, { tenantId, data: tombstones.map((t) => tombstoneReceipt(t)) });
  };
}

function route(
  operationId: string,
  method: RouteDefinition["method"],
  segments: ReadonlyArray<string | { param: string }>,
  idempotencyRequired: boolean,
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
    idempotencyRequired,
    requestSchemaSha256: null,
    responseSchemaSha256: null,
  };
}

export function buildTenantDeletionRoutes(
  ctx: TenantDeletionRoutesContext,
): readonly ExtraGatewayRoute[] {
  return [
    {
      /**
       * The one route in this app that **requires** an idempotency key. A retried delete generates a
       * *new* tombstone id, so without a key the duplicate would erase nothing the second time
       * (`alreadyAbsent`) and the assembler would refuse `scope_empty` — a 409 for a request that had
       * already succeeded, which is the worst possible answer to "did my deletion work?". The key
       * makes the retry return the first result.
       */
      route: route(
        "platform.tenants.delete",
        "POST",
        ["v1", "platform", "tenants", { param: "id" }, "delete"],
        true,
      ),
      handler: buildDeleteHandler(ctx),
    },
    {
      route: route(
        "platform.tenants.tombstones",
        "GET",
        ["v1", "platform", "tenants", { param: "id" }, "tombstones"],
        false,
      ),
      handler: buildListHandler(ctx),
    },
  ];
}
