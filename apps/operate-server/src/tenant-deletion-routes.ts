import type { PathSegment, ResolvedPrincipal, RouteDefinition } from "@crossengin/api-gateway";
import type { Handler, HandlerOutput, PrincipalRoles } from "@crossengin/api-gateway-runtime";
import type { ExtraGatewayRoute } from "@crossengin/operate-runtime";
import { z } from "zod";
import {
  DeletionAttestationSchema,
  type DeletionAttestation,
} from "@crossengin/tenant-lifecycle";

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

/**
 * Structural mirror of a `DeletionAttestation`, kept for the **read** side only (ADR-0329).
 *
 * The route used to parse an incoming attestation against a copy of this — `subsystem: string`,
 * `outcome: string` — and the request body is now parsed by `DeletionAttestationSchema` itself,
 * because a loose mirror on the *write* side accepts a typo and turns a bad request into an
 * assembly refusal naming a subsystem that does not exist. On the read side the looseness is
 * harmless and deliberate: `tombstonesFor` returns whatever is stored, and a stored row that no
 * longer satisfies the contract is a finding for the audit path (ADR-0323), not something this
 * route should refuse to display.
 */
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
    /**
     * What a v2/v3 receipt needs to be **independently verifiable**, which is the whole point of
     * ADR-0320's receipt: a bare "deleted" would be ADR-0317's defect in response form.
     *
     * Without these a caller holding the receipt cannot recompute `contentManifestSha256` at all —
     * absent `proofVersion` they cannot even choose the domain tag, and absent the declaration and
     * the obligations they cannot reconstruct v2 or v3 bytes. The receipt regressed at v2 and was one
     * field further away at v3. It also shipped `retainedReason` without `retainedDataReference`, so
     * it said *why* data survived and not *where*.
     */
    readonly proofVersion?: string;
    readonly capabilityDeclaration?: Readonly<Record<string, string>>;
    readonly retainedObligations?: readonly string[];
    readonly retainedDataReference?: string;
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
      /**
       * The second performed subsystem (ADR-0329), and the reason this is a separate field rather
       * than folded into `erased`: the two are different claims with different scopes — a tenant's
       * own schema, and the tenant-scoped rows in the platform's shared `meta` tables — and the
       * tombstone carries them as two attestations. Summing them into one figure would make the
       * receipt unable to say which erasure a number came from, which is the whole point of
       * composing a scope from per-subsystem reports.
       */
      readonly erasedSharedTables: {
        readonly schema: string;
        readonly tables: readonly string[];
        readonly rowCount: number;
        readonly storageBytes: number;
        /** Every erasable table, so a reader can see the coverage the scope does not carry. */
        readonly examinedTables: readonly string[];
        /** Every table the retention set deliberately left in place. */
        readonly retainedTables: readonly string[];
        /**
         * What is lawfully still there, and why (ADR-0330).
         *
         * `null` when nothing was retained — never an empty list, so "nothing to claim" cannot
         * collapse into the silence the attestation schema refuses. It deliberately carries **no
         * count**: a figure on the retained side could be read as part of the erasure, and
         * ADR-0317's whole subject is numbers that mean something other than what a reader assumes.
         *
         * This is the sentence an operator sends in answer to an Article 17 request: everything was
         * destroyed except these rows, which are held under this obligation.
         */
        readonly statutoryRetained: {
          readonly obligations: readonly string[];
          readonly dataReference: string;
        } | null;
      };
      /**
       * The `… -> deleted` transition as the pipeline recorded it, or `null` when the deployment
       * supplied no lifecycle store.
       *
       * A **required key with a nullable value**, not an optional field, which is the whole point:
       * `meta.tenant_lifecycle_events`' own protection note is that *"without it nothing in the
       * database distinguishes a tenant that was deleted from one that never existed"*, so an
       * absent trail has to be a thing this type can say rather than a field a mirror can forget.
       *
       * `transitionLegal` is **reported, never enforced**, and it is `false` here: this route
       * deletes straight from `active`, because ADR-0334 moved the tenant to `pending_deletion` on
       * the *asynchronous* route's verify only. Refusing would drop the only record of a deletion
       * that happened, and recording it silently would hide the gap — so the flag is on the receipt.
       */
      readonly lifecycleEvent: {
        readonly id: string;
        readonly fromState: string;
        readonly toState: string;
        readonly transitionLegal: boolean;
      } | null;
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
    // The contract's own type, not the mirror: this is the write side, and the pipeline will
    // require exactly this (ADR-0329).
    readonly attestations: readonly DeletionAttestation[];
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
    /**
     * Parsed by the **real** contract, not by a loose mirror of it (ADR-0329).
     *
     * This was `subsystem: z.string().min(1)` and `outcome: z.string().min(1)`, which accepts
     * `{subsystem: "objekt_storage", outcome: "erazed"}` — and `node.ts` then cast the array to
     * `DeletionAttestation[]`. It failed closed, because an unknown subsystem is never in the
     * required set and so never satisfies one: the assembly refused. But it refused by naming a
     * subsystem that does not exist, so a typo in a request body read as a platform bug, and a
     * misspelled *outcome* on a real subsystem read as a missing attestation. `DeletionAttestationSchema`
     * answers both at the edge, as a 400 naming the field — which is what the caller can act on.
     */
    attestations: z.array(DeletionAttestationSchema).default([]),
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
    // Read from the record, never inferred from whether a claim is attached: an inference would read
    // a *deleted* declaration as an older record, which is the tamper that covers its own tracks
    // (ADR-0329). `v1` is the honest default for a row written before the field existed.
    proofVersion: stored.record.proofVersion ?? "v1",
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
    ...(stored.record.capabilityDeclaration !== undefined
      ? { capabilityDeclaration: stored.record.capabilityDeclaration }
      : {}),
    // `[]` is the signed claim that nothing was kept, so this key is emitted whenever the bytes
    // cover a claim at all. Omitting it on an empty list would be the pre-v3 "cannot say" again, in
    // a new place — and it is the one distinction v3 exists to make.
    ...(stored.record.retainedObligations !== undefined
      ? { retainedObligations: stored.record.retainedObligations }
      : {}),
    ...(stored.record.retainedDataReference !== undefined
      ? { retainedDataReference: stored.record.retainedDataReference }
      : {}),
  };
}

/**
 * The lifecycle trail's half of the receipt, which **always has a `recorded` flag**.
 *
 * Emitting the pipeline's `null` straight through would make "this deployment records no trail" and
 * "this response predates the field" the same bytes to a caller, and that is the exact confusion the
 * trail exists to end: a deleted tenant and one that never existed look identical without it. So the
 * absence is stated rather than left as a missing key.
 */
export function lifecycleReceipt(
  event: {
    readonly id: string;
    readonly fromState: string;
    readonly toState: string;
    readonly transitionLegal: boolean;
  } | null,
): Record<string, unknown> {
  if (event === null) {
    return {
      recorded: false,
      detail: "this deployment records no tenant lifecycle trail; the deletion is proven by the tombstone alone",
    };
  }
  return { recorded: true, ...event };
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
      // Both erasures (ADR-0329). The audit row has one figure and it means "rows this deletion
      // destroyed", so reporting only the schema half understated it by every tenant-scoped row in
      // the platform's own tables. The per-subsystem breakdown is not lost — it is in the
      // tombstone's attestations, which is where a claim about *which* subsystem destroyed what
      // belongs; this number is the total.
      rowCount: outcome.erased.rowCount + outcome.erasedSharedTables.rowCount,
      refusals: [],
      tenantRetired: retired,
      at,
    });

    return json(200, {
      tenantId,
      deleted: true,
      tenantRetired: retired,
      lifecycleEvent: lifecycleReceipt(outcome.lifecycleEvent),
      erased: outcome.erased,
      erasedSharedTables: outcome.erasedSharedTables,
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
