import type {
  AbacBatchEvaluator,
  AbacEvaluator,
  RoleDefinition,
  RoleName,
  SensitiveFieldPolicy,
} from "@crossengin/auth";
import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import type { PathSegment, RouteDefinition } from "@crossengin/api-gateway";
import { resolvedFields } from "@crossengin/kernel/ddl";
import { manifestHash, type Manifest } from "@crossengin/kernel/manifest";
import {
  GatewayRuntime,
  HandlerRegistry,
  InMemoryIdempotencyStore,
  InMemoryPrincipalResolver,
  InMemoryRateLimitChecker,
  InMemoryRouteRegistry,
  MapRedactionRegistry,
  redactionRegistryFromManifest,
  type GatewayRuntimeOptions,
  type Handler,
  type IdempotencyStore,
  type JwksProvider,
  type HmacKeyLookup,
  type MtlsClientLookup,
  type OpaqueTokenLookup,
  type PrincipalResolver,
  type PrincipalRoles,
  type RequiredJwtClaim,
  type RateLimitChecker,
  type RedactedOperation,
  type ResponseRecordShape,
} from "@crossengin/api-gateway-runtime";

import {
  buildAdminSettingsReadHandler,
  buildAdminSettingsUpdateHandler,
  type AdminContext,
} from "./admin-handlers.js";
import { buildSpecHandler, type HandlerContext } from "./handlers.js";
import { approvalContentFromManifest } from "./maker-checker.js";
import { buildSystemEntityAccess, type SystemEntityAccess } from "./system-writer.js";
import type { CursorSealer } from "./cursor-seal.js";
import { manifestRouteSpecs, routeFromSpec, type RouteAction, type RouteSpec } from "./operations.js";
import {
  associationCountRouteFromSpec,
  associationRouteFromSpec,
  associationWriteRouteFromSpec,
  buildAssociationCountHandler,
  buildAssociationListHandler,
  buildAssociationWriteHandler,
  manifestAssociationCountRoutes,
  manifestAssociationRoutes,
  manifestAssociationWriteRoutes,
} from "./association.js";
import { literalDefaultPlans, type LiteralDefaultPlan } from "./defaults.js";
import { buildValidationPlans } from "./validation.js";
import { sequenceFieldPlans, type SequenceAllocator, type SequenceFieldPlan } from "./sequences.js";
import { planHasSettingsDefaults, settingsDefaultPlan, type SettingsDefaultPlan } from "./settings-defaults.js";
import {
  journalPostingGuard,
  currencyPrecisionGuard,
  lifecycleStateGuard,
  lockedDocumentGuard,
  postedEntryImmutabilityGuard,
  SETTLEMENT_COVERAGE_DOCUMENTS,
  settlementCoverageGuard,
  type WriteGuard,
} from "./write-guards.js";
import {
  bookingRateStampEffect,
  creditNoteGlPostingEffect,
  invoiceVoidCreditNoteEffect,
  journalReversalEffect,
  paymentApplicationEffect,
  postingReversalEffect,
  paymentSettlementGlPostingEffect,
  recognitionGlPostingEffect,
  unrealizedFxRevaluationEffect,
  whtCertificateClearingEffect,
  type PostingFxConfig,
  type WriteEffect,
} from "./write-effects.js";
import { lifecycleStateField } from "./list-query.js";
import {
  goodsReceiptCancellationEffect,
  goodsReceiptPostingEffect,
  grniClearingEffect,
  inventoryPolicyFrom,
  inventoryShape,
  shipmentIssueEffect,
  standardCostRevaluationEffect,
  stockLevelEditEffect,
  stockMovementEffect,
  stockMovementLedgerGuard,
  threeWayMatchGuard,
  type InventoryConfig,
} from "./inventory.js";
import {
  buildOpenApiHandler,
  OPENAPI_OPERATION_ID,
  OPENAPI_PATH_SEGMENTS,
} from "./openapi-handler.js";
import type { OpenApiCoverageGap, OpenApiResidencyDeclaration } from "./openapi.js";
import { buildAgingHandler, type AgingSpec } from "./aging-handler.js";
import { buildEntitlementHandler } from "./entitlement-handler.js";
import { buildUsageHandler } from "./usage-handler.js";
import {
  buildBillingPortalHandler,
  type BillingCustomerResolver,
  type BillingPortalCreator,
} from "./billing-portal-handler.js";
import { buildWhtReconciliationHandler } from "./wht-reconciliation-handler.js";
import { buildJobInvokeHandler, type JobInvoker } from "./job-invoke-handler.js";
import { withEntitlement, withRecordLimit, type EntitlementResolver } from "./entitlement.js";
import type { SettingsStore, TenantSettings } from "./settings.js";
import { transactionSettingsScope } from "./settings-snapshot.js";
import type { TaxDeterminationConfig } from "./tax-determination.js";
import { operationId, type CrudOperation } from "./slugs.js";
import type { EntityStore } from "./store.js";
import { temporalFieldIndexFromManifest, withDatetimeWireType } from "./datetime-store.js";
import { decimalFieldIndexFromManifest, withDecimalWireType } from "./decimal-store.js";
import { listValueTypesForManifest, withListValueTypes } from "./list-value-types.js";
import {
  buildUiSchema,
  buildUiSchemaHandler,
  type UiUserIdentityResolver,
} from "./ui-schema.js";
import { buildClassifiedFieldIndex, type WriteMaskMode } from "./write-mask.js";
import type { EntityWriteAuditor } from "./entity-audit.js";
import { buildWriteSurfaces, type EffectStamp, type WriteSurface } from "./write-surface.js";

export interface OperateRuntimeOptions {
  readonly store: EntityStore;
  /** Bridges the gateway's scope-bearing principal to its effective roles. */
  readonly principalRoles: (principal: ResolvedPrincipal | null) => PrincipalRoles;
  readonly policyForEntity?: (entity: string) => SensitiveFieldPolicy | undefined;
  /**
   * Which half of the field-level write rule the handlers enforce. Defaults to `explicit_only`,
   * which honours the per-field `update` grants the manifest already declares and nothing more —
   * 7 fields across the seven packs, each one a pack author's deliberate restriction, and a set
   * that cannot make an entity uncreatable because a declared grant names a role that holds it.
   *
   * `classified` additionally applies ADR-0329's symmetric default (a sensitive field with no
   * `update` grant needs a role privileged for its class) and is opt-in: nothing in
   * `apps/operate-server` produces a `policyForEntity` yet, so the policy is `{}` and the default
   * would refuse the 12 `required: true` sensitive fields in the packs for every role, making
   * `Patient`, `Lead`, `Employee`, `Opportunity`, `FixedAsset`, `Student` and `Permit`
   * uncreatable. See `write-mask.ts`.
   */
  readonly writeMaskMode?: WriteMaskMode;
  /**
   * Discharges an ABAC obligation — a `RbacGrant.abac` policy key — on an entity grant, a
   * transition grant or a per-field `read`/`update` grant. One evaluator for the whole manifest
   * and threaded from here rather than per reader, because this is the only place that holds all
   * five of them: the two handler families' `rbacCheck` calls, the write mask, and the response
   * redaction registry. Two evaluators would let the read side and the write side disagree about
   * one grant, which is the divergence ADR-0329 put `privilegedForClass` behind one definition to
   * prevent and ADR-0339 found had happened anyway.
   *
   * Absent, an obligation resolves `undischargeable` and the grant is refused. That is the
   * fail-closed answer and not an opt-out: `apps/operate-server` refuses at boot rather than
   * serving a manifest whose declared obligations it would silently deny on every request.
   */
  readonly abacEvaluator?: AbacEvaluator;
  /**
   * The optional **sibling** of `abacEvaluator` — never a replacement — for the one reader with a
   * fan-out. Since ADR-0343 response redaction computes a field set per record, so a page of N
   * records with F obligated fields asks N×F questions; this lets the deployment be asked once.
   *
   * It is forwarded to the redaction registry **and to the handler context**. ADR-0344 forwarded it
   * to the registry alone and said the handler path had no reader with a fan-out, which was true of
   * the readers that existed: `rbacCheck` asks one question per call, and the write mask stops at
   * the first refusing field, so batching it would evaluate past the rejection — more work, and it
   * would hand the policy layer questions whose answers were never needed (ADR-0340's reason
   * `rbacCheck` consults the evaluator only after the role check). Row filtering added the reader
   * that was missing: `rbacCheckForRecords` decides one `list` grant for a whole page, so the list
   * handler now has exactly the fan-out the registry had.
   *
   * Absent is not an opt-out and needs no refusal: the obligation is still enforced, through N
   * single calls, which is exactly what every deployment did before this existed.
   */
  readonly abacBatchEvaluator?: AbacBatchEvaluator;
  /**
   * Seals the keyset cursor an entity list hands back, and opens the one it is given (ADR-0346).
   *
   * Absent serves the cursor as the plaintext `base64url(JSON.stringify({k, id}))` it has always
   * been, which is every deployment without a cursor secret. That is a disclosure rather than a
   * degradation — ADR-0345's row filtering derives `nextCursor` from the last row of the *store's*
   * slice, so under filtering it names rows the caller is never shown — so the choice is made where
   * a deployment can be told about it: `apps/operate-server` refuses to boot when a list grant
   * filters rows and no sealer is configured.
   *
   * It reaches the handler context and nothing else. The stores are deliberately untouched: a
   * cursor is opaque to the **client**, not to the store, so sealing is an envelope at the request
   * boundary and `encodeKeyset` / `decodeKeyset` keep producing and consuming the plaintext keyset.
   */
  readonly cursorSealer?: CursorSealer;
  /** Allocates document numbers for sequence-defaulted fields on create. */
  readonly allocator?: SequenceAllocator;
  /**
   * Absences in this deployment's API description that the emitter cannot see for itself — chiefly
   * the paths served *ahead* of route matching, which are in no registry and which only the
   * deploying app knows.
   *
   * A **thunk**, read on the first request, for the same reason `describe` is one and measured the
   * same way: of the four out-of-registry mounts in `node.ts`, three wrap the dispatch target
   * *after* `buildOperateHttpServer` has returned (`node.ts:4852`, `:4973`, `:5015` against `:3863`),
   * so a value passed here could only ever be computed from the flags a second time. Two of those
   * conditions are compound, which is where a second spelling drifts — so a thunk over a set each
   * mount site adds itself to keeps the declaration and the mount one fact.
   *
   * Optional, and a dropped value is safe **by construction** rather than by a check: the emitter
   * declares `surface_outside_registry` generically whatever this carries, so forgetting it
   * degrades the document to a weaker true statement and never to a false one. That matters because
   * this is a forwarding-literal hop of exactly the shape ADR-0386 and ADR-0391 each found a field
   * dropped from, both times silently — so the field is designed so that the drop cannot lie.
   */
  readonly openApiCoverage?: () => readonly OpenApiCoverageGap[];
  /**
   * What the region gate wrapping this server's handlers covers, or `null` when there is none
   * (ADR-0462). A thunk for `openApiCoverage`'s reason: the gate is applied to the handler registry
   * *after* this function returns, so the answer exists only once it has run, and the document reads
   * it on its first request. Absent reads as `null` — no gate — which is correct for every caller
   * that applies none; `buildOperateHttpServer`, the one that may apply one, always supplies it.
   */
  readonly openApiResidency?: () => OpenApiResidencyDeclaration | null;
  /** Backs the admin settings endpoints + runtime numbering overrides. */
  readonly settingsStore?: SettingsStore;
  /**
   * Resolves the signed-in person's own name and email for `GET /v1/meta/schema`'s viewer.
   *
   * Optional on `settingsStore`'s precedent and for its reason: this package has no Postgres
   * dependency, so the read has to be supplied. Absent, the viewer still carries the person's
   * `userId` — that comes from the principal and needs no store at all.
   */
  readonly userIdentity?: UiUserIdentityResolver;
  /** Roles permitted to read/write tenant settings. Defaults to {"erp_admin"}. */
  readonly adminRoles?: readonly RoleName[];
  /** Roles permitted to read finance reports (e.g. aging). Defaults to a finance-role set. */
  readonly financeRoles?: readonly RoleName[];
  /** Runtime data invariants checked before each write (e.g. balanced journal postings). */
  readonly writeGuards?: readonly WriteGuard[];
  /**
   * Accepts knowingly that a document may be marked settled while completed payments do not cover
   * its total — the state in which the aging subledger reports nothing open and the GL control
   * account still carries the residual, with nothing reconciling the two.
   *
   * Default `false`, so the guard is on. `--allow-plaintext-phi`'s shape and deliberately not
   * ADR-0340's no-hatch shape, and the two halves of that argument are:
   *
   * - **Refusing breaks nothing that was right.** ADR-0338's premise, and it holds here: a
   *   document reading `paid` while its receivable is still on the books and its subledger shows
   *   nothing is not a deployment serving this correctly, so nothing that worked stops working.
   *   Measured on the seven packs, the population is three lifecycle transitions, all in
   *   `erp-core`.
   * - **An uncovered settlement is degraded-but-recoverable.** Record the payment and the two
   *   views reconcile; the guard's own detail names that act. That is the difference from an
   *   unevaluated ABAC obligation, which is the *opposite* of what the manifest declares and which
   *   nothing a tenant does can repair — so unlike that one, this is a state an operator may
   *   knowingly accept, and accepting it earns a flag rather than a refusal with no way past it.
   *
   * It does **not** suppress the boot survey: a deployment that passes this is still told which of
   * its settleable documents are now unguarded, because the whole defect was the silence.
   */
  readonly allowUncoveredSettlement?: boolean;
  /**
   * Refuse an approve-class transition (`approveClassTransitions`) fired by the person recorded as
   * the record's creator. Opt-in, because a single-user tenant has no second person: on, every
   * approval there would be refused. See `--segregation-of-duties`.
   */
  readonly segregationOfDuties?: boolean;
  /**
   * Where each successful entity write is recorded, with its sensitive values withheld — see
   * `entity-audit.ts`. Absent, nothing is recorded; present, a write whose record cannot be made is
   * refused with a 503 and, on a transactional store, rolled back with it.
   */
  readonly entityAudit?: EntityWriteAuditor;
  /** Side effects run after a successful write (e.g. auto-generating a reversal entry). */
  readonly writeEffects?: readonly WriteEffect[];
  /** Extra effects appended after the resolved base effects (e.g. entity-event emission) — additive. */
  readonly additionalWriteEffects?: readonly WriteEffect[];
  /**
   * Optional subscription gate: when set, every entity + report operation is pre-checked
   * against the caller tenant's entitlement — a lapsed/suspended tenant gets a 402 (and
   * `past_due` tenants keep read access but can't write). Omit for an ungated deployment.
   */
  readonly entitlementResolver?: EntitlementResolver;
  /**
   * Optional Stripe Billing Portal: when set, registers `POST /v1/meta/billing-portal`, which
   * mints a hosted portal session for the caller tenant (own tenant only). Omit for
   * deployments without cloud billing.
   */
  readonly billingPortal?: BillingPortalWiring;
  /**
   * Optional on-demand job invocation: when set, registers `POST /v1/meta/jobs/invoke`, which
   * enqueues the caller tenant's `userInvoked` jobs for a named action. Omit to not expose it.
   */
  readonly jobInvoker?: JobInvoker;
  /**
   * Roles permitted to call `POST /v1/meta/jobs/invoke`. When set, the endpoint is role-gated
   * (fail-closed); omit to leave it open to any authenticated tenant principal.
   */
  readonly jobInvokeRoles?: readonly RoleName[];
  /**
   * Per-action role overrides for `POST /v1/meta/jobs/invoke`, keyed by action. An action present here
   * uses its own role set instead of `jobInvokeRoles`; actions absent fall back to `jobInvokeRoles`.
   */
  readonly jobInvokeActionRoles?: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * Extra gateway routes registered as-is, ungated (the handler self-authorizes) — the seam a
   * deployment uses to inject an admin surface this package has no domain knowledge of (e.g.
   * marketplace pack install). Registered after the built-in routes.
   */
  readonly extraRoutes?: readonly ExtraGatewayRoute[];
  readonly clock?: { now(): Date };
}

/** A deployment-supplied gateway route + handler injected via `extraRoutes`. */
export interface ExtraGatewayRoute {
  readonly route: RouteDefinition;
  readonly handler: Handler;
}

export interface BillingPortalWiring {
  readonly customers: BillingCustomerResolver;
  readonly portal: BillingPortalCreator;
  readonly returnUrl: string;
}

const DEFAULT_ADMIN_ROLES: readonly RoleName[] = ["erp_admin" as RoleName];
const DEFAULT_FINANCE_ROLES: readonly RoleName[] = [
  "erp_admin",
  "controller",
  "erp_accountant",
  "ap_clerk",
].map((r) => r as RoleName);

function literalRoute(
  operationId: string,
  method: RouteDefinition["method"],
  segments: readonly string[],
): RouteDefinition {
  const pathSegments: PathSegment[] = segments.map((value) => ({ kind: "literal", value }));
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

function buildSequencePlans(manifest: Manifest): Map<string, readonly SequenceFieldPlan[]> {
  const plans = new Map<string, readonly SequenceFieldPlan[]>();
  for (const entity of manifest.entities ?? []) {
    const p = sequenceFieldPlans(entity);
    if (p.length > 0) plans.set(entity.name, p);
  }
  return plans;
}

function buildDefaultPlans(manifest: Manifest): Map<string, readonly LiteralDefaultPlan[]> {
  const plans = new Map<string, readonly LiteralDefaultPlan[]>();
  for (const entity of manifest.entities ?? []) {
    const p = literalDefaultPlans(entity);
    if (p.length > 0) plans.set(entity.name, p);
  }
  return plans;
}

/**
 * The remedy a locked document's refusal names, per locked state: the declared transitions out of
 * that state which correct the document, each with the sentence that names it.
 *
 * Read off the entity's own lifecycle rather than written once per document, because one sentence
 * per document was false of some of its locked states — `void it instead` to a `paid` invoice
 * (`void` fires from draft, sent and overdue), `amend it instead` to a `paid` tax return. A state no
 * correction leaves gets no remedy at all, which is ADR-0334's rule: naming a fix that cannot work
 * is worse than naming none. An entity with no lifecycle has no transitions to name, so it gets an
 * empty map rather than the sentence a pack's lifecycle would have earned.
 */
function correctionHints(
  manifest: Manifest,
  entity: string,
  lockedStates: readonly string[],
  corrections: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const hints: Record<string, string> = {};
  for (const wf of Object.values(manifest.workflows ?? {})) {
    if (wf.kind !== "entityLifecycle" || wf.entity !== entity) continue;
    for (const state of lockedStates) {
      const clauses = wf.transitions
        .filter((t) => corrections[t.name] !== undefined && (Array.isArray(t.from) ? t.from : [t.from]).includes(state))
        .map((t) => corrections[t.name] as string);
      if (clauses.length > 0) hints[state] = clauses.join("; or ");
    }
  }
  return hints;
}

function hasLifecycle(manifest: Manifest, entity: string): boolean {
  return lifecycleStateField(manifest, entity) !== null;
}

/**
 * The entities `defaultWriteGuards` locks by a `state` field even where no lifecycle declares one —
 * its `lockedDocumentGuard`s and the posted-entry guard, whose `stateField` defaults to `state`.
 */
const STATE_LOCKED_ENTITIES = [
  "Invoice",
  "TaxReturn",
  "SalesOrder",
  "PurchaseOrder",
  "Bill",
  "Payment",
  "WhtCertificate",
  "JournalEntry",
] as const;

/**
 * The field each entity's write is decided from: its lifecycle state field, through
 * `lifecycleStateField` so there is one reading, and for a lock-guarded entity with no lifecycle the
 * `state` its guard reads. The second half is live on every shipped pack: `WhtCertificate` has no
 * lifecycle, its state moves by PATCH and its clearing posting fires on entering `confirmed`, so with
 * no precondition two concurrent confirms both landed and posted twice, and a delete decided on
 * `draft` removed a certificate a concurrent confirm had just posted for (measured: 200/200 with the
 * effect fired twice, and 200/204 with the record gone).
 */
function lifecycleStateFieldIndex(manifest: Manifest): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const entity of manifest.entities ?? []) {
    const field = lifecycleStateField(manifest, entity.name);
    if (field !== null) out.set(entity.name, field);
    else if (
      (STATE_LOCKED_ENTITIES as readonly string[]).includes(entity.name) &&
      resolvedFields(entity, manifest.traits ?? []).some((f) => f.name === "state")
    ) {
      out.set(entity.name, "state");
    }
  }
  return out;
}

/**
 * The documents whose state, once reached, has caused a general-ledger posting, and the states that
 * lock them. Enumerated from `defaultWriteEffects`' own triggers rather than chosen: `Bill`'s
 * recognition fires on entering `approved`, a `Payment`'s settlement on entering `completed`, and a
 * `WhtCertificate`'s clearing on entering `confirmed` (the invoice and journal-entry triggers are
 * already locked above them). The rule is *a document whose state has caused a posting cannot be
 * deleted, and its posting-relevant fields and lines cannot change* — otherwise deleting it and
 * creating it again with the same number posts a second time, which was measured live for an
 * approved Bill (204, 201, 200: two journal entries for one bill number).
 *
 * The locked set is every state at or past the trigger, including the ones that **post no
 * reversal**: a voided bill, a refunded payment and a voided certificate all leave their posting in
 * the ledger, and no effect in this file reverses any of them, so leaving them unlocked would reopen
 * the delete-and-recreate route one state further on. `void` is reachable from `draft` too, so a
 * bill voided without ever being approved is locked as well; a stored record does not say which way
 * it came, and refusing to delete a void document is the `Invoice` precedent.
 *
 * Deliberately **not** here: `Expense`, which no effect posts from in any state. `FiscalPeriod` is
 * locked by its own block below and only where a lifecycle declares the reopening: there a closed
 * period's dates are what decide which postings it holds, so editing them reopens it by another
 * name, while `reopen` is the named, permission-gated way. With no lifecycle the status is a plain
 * field and a lock would forbid reopening outright, which is a decision nobody has made. The
 * revaluation posts only the difference from the period's own prior entries, so a re-close
 * revalues the period once.
 */
const POSTED_DOCUMENT_LOCKS = {
  Bill: { lockedStates: ["approved", "overdue", "paid", "void"], child: { entity: "BillLine", parentField: "bill_id" }, error: "bill_locked", noun: "approved bill" },
  Payment: { lockedStates: ["completed", "refunded"], child: null, error: "payment_locked", noun: "completed payment" },
  WhtCertificate: { lockedStates: ["confirmed", "void"], child: null, error: "wht_certificate_locked", noun: "confirmed WHT certificate" },
  FiscalPeriod: { lockedStates: ["closed", "locked"], child: null, error: "fiscal_period_locked", noun: "closed fiscal period" },
} as const;

/** Guards inferred from the manifest's shape; opt out by passing `writeGuards: []`. */
function defaultWriteGuards(
  manifest: Manifest,
  allowUncoveredSettlement: boolean,
  stamps: readonly EffectStamp[],
  settingsStore?: SettingsStore,
): readonly WriteGuard[] {
  const names = new Set((manifest.entities ?? []).map((e) => e.name));
  const guards: WriteGuard[] = [];
  // First: a state value the caller may not write is refused before any other guard reads it as a
  // fact. Otherwise a `PATCH {"state":"paid"}` from `sent` reaches `invoice_locked … void it
  // instead`, which is true and is not the remedy — the state moves through `mark_paid`.
  for (const wf of Object.values(manifest.workflows ?? {})) {
    if (wf.kind !== "entityLifecycle" || !names.has(wf.entity)) continue;
    guards.push(
      lifecycleStateGuard({
        entity: wf.entity,
        stateField: wf.stateField,
        initialState: wf.initialState,
        transitions: wf.transitions.map((t) => ({
          name: t.name,
          from: Array.isArray(t.from) ? [...t.from] : [t.from],
          to: t.to,
        })),
      }),
    );
  }
  if (names.has("Currency")) guards.push(currencyPrecisionGuard());
  if (names.has("JournalEntry") && names.has("JournalLine")) {
    guards.push(
      journalPostingGuard(postingPeriodsOf(manifest) !== undefined ? { postingPeriods: {} } : {}),
      // With no lifecycle the guard's own default stands: its `posted → reversed` plain update is the
      // route a lifecycle-less entry is reversed by, so `reverse it instead` is real there.
      postedEntryImmutabilityGuard(
        {},
        hasLifecycle(manifest, "JournalEntry")
          ? correctionHints(manifest, "JournalEntry", ["posted", "reversed"], { reverse: "reverse it instead" })
          : undefined,
      ),
    );
  }
  // Issued invoices are legal records: once out of draft they can't be edited or
  // deleted (correct by void/credit note); their lines lock with them.
  if (names.has("Invoice")) {
    guards.push(
      lockedDocumentGuard({
        entity: "Invoice",
        lockedStates: ["sent", "overdue", "paid", "void"],
        ...(names.has("InvoiceLine") ? { childEntity: "InvoiceLine", childParentField: "invoice_id" } : {}),
        lockedError: "invoice_locked",
        childLockedError: "invoice_locked_lines",
        noun: "issued invoice",
        // `void` fires from `draft` too, so a void invoice may never have been issued.
        nounByState: { void: "void invoice" },
        hintByState: correctionHints(manifest, "Invoice", ["sent", "overdue", "paid", "void"], { void: "void it instead" }),
      }),
    );
  }
  // Filed tax returns are submitted to authorities: once filed/paid they can't be
  // edited or deleted (correct via the amend transition).
  if (names.has("TaxReturn")) {
    guards.push(
      lockedDocumentGuard({
        entity: "TaxReturn",
        lockedStates: ["filed", "paid"],
        lockedError: "tax_return_locked",
        noun: "filed tax return",
        hintByState: correctionHints(manifest, "TaxReturn", ["filed", "paid"], { amend: "amend it instead" }),
      }),
    );
  }
  // A committed sales order is a customer commitment: once it leaves draft it
  // can't be edited or deleted out of band (cancel via the lifecycle instead).
  // States span the core (confirmed→…→closed) and retail (placed/returned) lifecycles.
  // Core's line entity is `SalesOrderLine` and retail's is `OrderLine`, and a resolved retail manifest
  // carries both — so each present one gets the child arm. Keying on `SalesOrderLine` alone left a
  // `placed` retail order's own lines editable, movable and deletable while its states were listed
  // here as locked.
  if (names.has("SalesOrder")) {
    const SALES_ORDER_LOCKED_STATES = ["confirmed", "fulfilled", "invoiced", "closed", "placed", "returned"];
    const lineEntities = ["SalesOrderLine", "OrderLine"].filter((n) => names.has(n));
    for (const child of lineEntities.length > 0 ? lineEntities : [null]) {
      guards.push(
        lockedDocumentGuard({
          entity: "SalesOrder",
          lockedStates: SALES_ORDER_LOCKED_STATES,
          ...(child !== null ? { childEntity: child, childParentField: "sales_order_id" } : {}),
          lockedError: "sales_order_locked",
          childLockedError: "sales_order_locked_lines",
          noun: "committed sales order",
          hintByState: correctionHints(manifest, "SalesOrder", SALES_ORDER_LOCKED_STATES, { cancel: "cancel it instead" }),
        }),
      );
    }
  }
  // An approved purchase order is a supplier commitment: locked once submitted.
  if (names.has("PurchaseOrder")) {
    guards.push(
      lockedDocumentGuard({
        entity: "PurchaseOrder",
        lockedStates: ["submitted", "approved", "received", "closed"],
        ...(names.has("PurchaseOrderLine") ? { childEntity: "PurchaseOrderLine", childParentField: "purchase_order_id" } : {}),
        lockedError: "purchase_order_locked",
        childLockedError: "purchase_order_locked_lines",
        noun: "approved purchase order",
        // `submitted` precedes approval, so "an approved purchase order" was false of it.
        nounByState: { submitted: "submitted purchase order", received: "received purchase order", closed: "closed purchase order" },
        hintByState: correctionHints(manifest, "PurchaseOrder", ["submitted", "approved", "received", "closed"], {
          cancel: "cancel it instead",
        }),
      }),
    );
  }
  // Documents whose state has caused a GL posting — see `POSTED_DOCUMENT_LOCKS` for the enumeration
  // and for the two that are deliberately absent.
  if (names.has("Bill")) {
    const lock = POSTED_DOCUMENT_LOCKS.Bill;
    guards.push(
      lockedDocumentGuard({
        entity: "Bill",
        lockedStates: lock.lockedStates,
        ...(names.has(lock.child.entity) ? { childEntity: lock.child.entity, childParentField: lock.child.parentField } : {}),
        lockedError: lock.error,
        childLockedError: "bill_locked_lines",
        noun: lock.noun,
        nounByState: { void: "void bill", paid: "paid bill", overdue: "overdue bill" },
        hintByState: correctionHints(manifest, "Bill", lock.lockedStates, {
          void: "void it instead, which reverses its posting",
        }),
      }),
    );
  }
  if (names.has("Payment")) {
    const lock = POSTED_DOCUMENT_LOCKS.Payment;
    guards.push(
      lockedDocumentGuard({
        entity: "Payment",
        lockedStates: lock.lockedStates,
        lockedError: lock.error,
        noun: lock.noun,
        nounByState: { refunded: "refunded payment" },
        hintByState: correctionHints(manifest, "Payment", lock.lockedStates, {
          refund: "refund it if the money was returned, which reverses its settlement",
        }),
      }),
    );
  }
  // No lifecycle in any shipped pack, so its state moves by a plain update and the lifecycle guard
  // does not reach it: `confirmed → draft → confirmed` posted the clearing entry once per arrival.
  // The one move left open is `confirmed → void`, the field's declared forward value, which posts
  // nothing and lands in a locked state, so it cannot be walked back into `confirmed`.
  if (names.has("WhtCertificate")) {
    const lock = POSTED_DOCUMENT_LOCKS.WhtCertificate;
    const stateField = lifecycleStateField(manifest, "WhtCertificate");
    guards.push(
      lockedDocumentGuard({
        entity: "WhtCertificate",
        ...(stateField !== null ? { stateField } : {}),
        lockedStates: lock.lockedStates,
        ...(stateField === null ? { allowedUpdateTransitions: { confirmed: ["void"] }, ignoredFields: ["confirmed_at"] } : {}),
        lockedError: lock.error,
        noun: lock.noun,
        nounByState: { void: "void WHT certificate" },
        hintByState:
          stateField === null
            ? { confirmed: "set its state to 'void' instead, which reverses its clearing" }
            : correctionHints(manifest, "WhtCertificate", lock.lockedStates, {
                void: "void it instead, which reverses its clearing",
              }),
      }),
    );
  }
  if (names.has("FiscalPeriod") && hasLifecycle(manifest, "FiscalPeriod")) {
    const lock = POSTED_DOCUMENT_LOCKS.FiscalPeriod;
    const stateField = lifecycleStateField(manifest, "FiscalPeriod");
    guards.push(
      lockedDocumentGuard({
        entity: "FiscalPeriod",
        ...(stateField !== null ? { stateField } : {}),
        lockedStates: lock.lockedStates,
        lockedError: lock.error,
        noun: lock.noun,
        nounByState: { locked: "locked fiscal period" },
        hintByState: correctionHints(manifest, "FiscalPeriod", lock.lockedStates, {
          reopen: "reopen it instead, which is its own permission and its own audit row",
        }),
      }),
    );
  }
  // A document may not enter its settled state while completed payments do not cover its total.
  // Built from `SETTLEMENT_COVERAGE_DOCUMENTS` rather than listed again here, so the guards that
  // exist and the boot survey's claim about which documents are covered read **one** declaration.
  //
  // Gated on `Payment` as well as the document, which every settlement effect below is too: with no
  // Payment entity there is nothing to read, so the guard would drain an entity the manifest does
  // not declare — harmless on the in-memory store and a missing table on `--store pg-columns`.
  //
  // **Last, and the order is load-bearing rather than incidental** — measured live, because the
  // first version of this had it the other way round and the comment claimed this one. A plain
  // `PATCH {"state":"paid"}` on an invoice in `sent` satisfies *both* guards: `sent` is one of
  // Invoice's locked states, so the edit is refused whatever the coverage. Coverage-first answered
  // `uncovered_settlement: 70.00 of 120.00 still owed`, whose remedy — record the payment — would
  // **not** let that PATCH through, because the locked guard would then refuse it. ADR-0334's rule
  // is that naming a fix which cannot work is worse than naming none. Locked-first answers
  // `invoice_locked … void it instead`, which is true and complete.
  //
  // Everything this guard is for still reaches it, which is why last costs nothing: a `transition`
  // (the locked guard returns null on that operation by design, so `mark_paid` lands here), a
  // `create`, an update from an unlocked state — `draft` is Invoice's only one, and `draft → paid`
  // is no declared transition — and, on `Bill`, an update from `draft`, its one unlocked state.
  // The state PATCHes in this paragraph are answered by the lifecycle guard at the head of the list
  // now; the order between these two is still observable on a write raising a paid invoice's total.
  //
  // `stateField` comes from the entity's own lifecycle rather than from the guard's `state`
  // fallback, and that is a correctness fix rather than a generalisation: the guard reads the field
  // by name, so on a manifest whose lifecycle drives `status` — which `validateWorkflows` accepts,
  // and which is the normal shape for `Opportunity.stage`, `WorkOrder.status` and
  // `Enrollment.status` — it read `after["state"]`, got `undefined`, and returned `null` for every
  // write **while the boot survey went on naming the entity as guarded**. ADR-0337's falsely-true
  // direction on the one surface built to make the gap legible. Reachable from a tenant's own
  // activated manifest, which is the path this guard is wired into. An entity with no lifecycle
  // keeps the fallback, because a plain `PATCH {"state":…}` is exactly what it is for.
  if (!allowUncoveredSettlement && names.has("Payment")) {
    for (const doc of SETTLEMENT_COVERAGE_DOCUMENTS) {
      if (!names.has(doc.entity)) continue;
      const stateField = lifecycleStateField(manifest, doc.entity);
      // Withholding reduces what is owed only where an effect stamps it: a caller-written figure —
      // a manifest with no tax codes, or a deployment passing its own effects — would otherwise let
      // `mark_paid` through with nothing paid by typing the withholding equal to the total.
      const { withholdingField, ...rest } = doc;
      const withholding =
        withholdingField !== undefined && isStamped(stamps, doc.entity, withholdingField) ? { withholdingField } : {};
      const config = { ...rest, ...withholding };
      guards.push(settlementCoverageGuard(stateField === null ? config : { ...config, stateField }));
    }
  }
  // Stock: the movement ledger is append-only, a posted goods receipt is locked (it may only be
  // cancelled, which takes back what it received, and a cancelled one is final so its entry number
  // cannot recur), and a bill matched to order lines is checked against them on approval.
  const inventory = inventoryShape(manifest);
  if (inventory.ledger) guards.push(stockMovementLedgerGuard());
  if (inventory.goodsReceipt) {
    guards.push(
      lockedDocumentGuard({
        entity: "GoodsReceipt",
        stateField: "status",
        lockedStates: ["posted", "cancelled"],
        allowedUpdateTransitions: { posted: ["cancelled"] },
        lockedError: "goods_receipt_locked",
        noun: "posted goods receipt",
        nounByState: { cancelled: "cancelled goods receipt" },
        hintByState: {
          posted: "set its status to 'cancelled' instead, which takes back what it received",
          cancelled: "record a new goods receipt instead",
        },
      }),
    );
  }
  if (inventory.billMatch) {
    guards.push(threeWayMatchGuard({ ...inventoryConfigFor(settingsStore), receiptsCreditGrni: inventory.goodsReceipt }));
  }
  return guards;
}

/** The inventory postings' account codes and stock policy, read from the tenant's settings. */
function inventoryConfigFor(settingsStore: SettingsStore | undefined): InventoryConfig {
  if (settingsStore === undefined) return {};
  return {
    resolveAccountCodes: async (tenantId) => {
      const f = (await settingsStore.get(tenantId)).finance ?? {};
      return {
        ...(f.inventoryAccountCode !== undefined ? { inventory: f.inventoryAccountCode } : {}),
        ...(f.cogsAccountCode !== undefined ? { cogs: f.cogsAccountCode } : {}),
        ...(f.grniAccountCode !== undefined ? { grni: f.grniAccountCode } : {}),
        ...(f.inventoryVarianceAccountCode !== undefined ? { variance: f.inventoryVarianceAccountCode } : {}),
        ...(f.expenseAccountCode !== undefined ? { expense: f.expenseAccountCode } : {}),
      };
    },
    resolvePolicy: async (tenantId) => inventoryPolicyFrom((await settingsStore.get(tenantId)).inventory),
  };
}

/**
 * The fields the default effects stamp onto the document that triggered them. Each name is the one
 * handed to the effect's own config below, so the stamp list and the effect read one constant.
 */
const STAMPED_BOOKING_RATE_FIELD = "booking_rate";
const STAMPED_WITHHOLDING_FIELD = "withholding_total";
const STAMPED_RECEIVED_QUANTITY_FIELD = "received_quantity";
const STAMPED_PAID_AT_FIELD = "paid_at";

/**
 * The posting-period rule reads a fiscal period's dates and status by name, as a filter. A tenant's
 * own manifest may declare a `FiscalPeriod` without them, and there the typed store refuses a filter
 * on a column it does not have — which would refuse every posting the deployment makes. Such a
 * calendar cannot be resolved from a date, so it gets no date rule; a named period's own status is
 * still checked by the guard.
 */
function postingPeriodsOf(manifest: Manifest): Record<string, never> | undefined {
  const period = (manifest.entities ?? []).find((e) => e.name === "FiscalPeriod");
  if (period === undefined) return undefined;
  const fields = new Set(resolvedFields(period, manifest.traits ?? []).map((f) => f.name));
  return ["start_date", "end_date", "status"].every((f) => fields.has(f)) ? {} : undefined;
}

function isStamped(stamps: readonly EffectStamp[], entity: string, field: string): boolean {
  return stamps.some((s) => s.entity === entity && s.field === field);
}

/**
 * The fields the default write effects stamp on a document, for this manifest. Derived by building
 * the effects and keeping only the stamp half, so the list cannot describe a set of effects other
 * than the one that runs.
 */
export function defaultEffectStamps(manifest: Manifest): readonly EffectStamp[] {
  return defaultWriteEffectsWithStamps(manifest).stamps;
}

/** Effects inferred from the manifest's shape, with what they stamp; opt out by passing `writeEffects: []`. */
function defaultWriteEffectsWithStamps(
  manifest: Manifest,
  clock?: { now(): Date },
  settingsStore?: SettingsStore,
): { readonly effects: readonly WriteEffect[]; readonly stamps: readonly EffectStamp[] } {
  const names = new Set((manifest.entities ?? []).map((e) => e.name));
  const effects: WriteEffect[] = [];
  const stamps: EffectStamp[] = [];
  const clockOpt = clock !== undefined ? { clock } : {};
  // Every posting an effect writes is checked against the period its date falls in.
  const periodsOpt = postingPeriodsOf(manifest) !== undefined ? { periods: {} } : {};
  const hasGl = names.has("JournalEntry") && names.has("JournalLine") && names.has("LedgerAccount");
  // Maps the tenant's finance settings to an effect's account-code resolver.
  const codeResolver = <T>(pick: (f: NonNullable<TenantSettings["finance"]>) => T) =>
    settingsStore === undefined
      ? {}
      : { resolveAccountCodes: async (tenantId: string) => pick((await settingsStore.get(tenantId)).finance ?? {}) };
  // The tenant's functional (reporting) currency, from defaults.currency.
  const functionalResolver =
    settingsStore === undefined
      ? {}
      : { resolveFunctionalCurrency: async (tenantId: string) => (await settingsStore.get(tenantId)).defaults?.currency };
  // Multi-currency booking-rate capture is possible only when the rate tables exist.
  const hasFx = names.has("Currency") && names.has("ExchangeRate");
  // Line-level tax codes drive a per-code recognition split only when TaxCode exists.
  const hasTaxCodes = names.has("TaxCode");
  // Exactly the condition under which recognition stamps `withholding_total` below, and so the one
  // under which the field is a server fact rather than a figure the caller typed: only then may
  // what is owed be read as total less it.
  const invoiceWithholdingStamped = names.has("Invoice") && hasGl && hasTaxCodes && names.has("InvoiceLine");
  // Tax determination from the tenant's declared jurisdiction and its rules, where the manifest
  // declares both and there is a settings store for the tenant to declare the jurisdiction in.
  const taxDetermination = (
    side: "sales" | "purchase",
    dateField: string,
  ): { determination?: TaxDeterminationConfig } =>
    settingsStore === undefined || !names.has("TaxRule") || !names.has("TaxJurisdiction")
      ? {}
      : {
          determination: {
            side,
            dateField,
            resolveJurisdictionCode: async (tenantId: string) =>
              (await settingsStore.get(tenantId)).finance?.defaultTaxJurisdiction,
            ...(side === "purchase"
              ? {
                  selfAssessedAccountRef: "tax_payable",
                  resolveSelfAssessedAccountCode: async (tenantId: string) =>
                    (await settingsStore.get(tenantId)).finance?.taxPayableAccountCode,
                }
              : {}),
          },
        };
  // Per-jurisdiction default tax accounts, from finance settings (jurisdiction → code).
  const jurisdictionResolver =
    settingsStore === undefined
      ? {}
      : {
          resolveJurisdictionAccounts: async (tenantId: string) =>
            (await settingsStore.get(tenantId)).finance?.taxAccountsByJurisdiction ?? {},
        };

  // The rate a foreign-currency document posts at, where the manifest declares the rate tables: its
  // own stamped booking rate, else the rate on its date — and refused by name, for a tenant that has
  // declared its functional currency, when there is none.
  const postingFx = (dateField: string): { fx?: PostingFxConfig } =>
    hasFx ? { fx: { dateField, bookingRateField: STAMPED_BOOKING_RATE_FIELD, ...functionalResolver } } : {};

  if (names.has("JournalEntry") && names.has("JournalLine")) {
    effects.push(
      journalReversalEffect({
        ...clockOpt,
        ...periodsOpt,
        // A partial credit note reverses part of its invoice's recognition and leaves it posted.
        partialReversals: [{ sourceSuffix: "-AR", reversalSuffix: "-CN-GL" }],
      }),
    );
  }
  if (names.has("Invoice")) {
    effects.push(
      invoiceVoidCreditNoteEffect({
        ...(names.has("InvoiceLine") ? { lineEntity: "InvoiceLine" } : {}),
        ...(hasGl && hasTaxCodes && names.has("InvoiceLine") ? { withholdingField: STAMPED_WITHHOLDING_FIELD } : {}),
        ...clockOpt,
      }),
    );
    if (hasGl) {
      // Recognition (tax-split): invoice issued → debit AR; credit revenue + tax payable.
      effects.push(
        recognitionGlPostingEffect({
          entity: "Invoice",
          triggerState: "sent",
          controlSide: "debit",
          sourceValue: "invoice",
          entrySuffix: "-AR",
          numberField: "invoice_number",
          // A credit note sent through the API posts the mirror of a sale; one a void issued is
          // created in `sent` by the void itself, which runs no effects, and posts as `-CN-GL`.
          contraDocumentType: { field: "document_type", value: "credit_note" },
          ...postingFx("issue_date"),
          controlAccountRef: "accounts_receivable",
          netAccountRef: "revenue",
          taxAccountRef: "tax_payable",
          controlDescription: "Invoice — accounts receivable",
          netDescription: "Invoice — revenue",
          taxDescription: "Invoice — tax payable",
          ...(hasTaxCodes && names.has("InvoiceLine")
            ? {
                taxLines: {
                  entity: "InvoiceLine",
                  refField: "invoice_id",
                  netField: "line_total",
                  // The receivable `whtCertificateClearingEffect` later credits, so the two agree.
                  withholdingAccountRef: "wht_receivable",
                  ...taxDetermination("sales", "issue_date"),
                },
                stampWithholdingField: STAMPED_WITHHOLDING_FIELD,
                ...jurisdictionResolver,
              }
            : {}),
          ...clockOpt,
          ...periodsOpt,
          ...codeResolver((f) => ({
            ...(f.arAccountCode !== undefined ? { control: f.arAccountCode } : {}),
            ...(f.revenueAccountCode !== undefined ? { net: f.revenueAccountCode } : {}),
            ...(f.taxPayableAccountCode !== undefined ? { tax: f.taxPayableAccountCode } : {}),
            ...(f.whtReceivableAccountCode !== undefined ? { withholding: f.whtReceivableAccountCode } : {}),
          })),
        }),
      );
      // AR reversal on credit-note issuance: the mirror of the recognition entry above, tax included.
      effects.push(
        creditNoteGlPostingEffect({
          recognitionEntrySuffix: "-AR",
          ...clockOpt,
          ...periodsOpt,
          ...codeResolver((f) => ({
            ...(f.arAccountCode !== undefined ? { ar: f.arAccountCode } : {}),
            ...(f.revenueAccountCode !== undefined ? { revenue: f.revenueAccountCode } : {}),
          })),
        }),
      );
      // The recognition effect above stamps the withholding total only when it is given tax lines.
      if (hasTaxCodes && names.has("InvoiceLine")) {
        stamps.push({ entity: "Invoice", field: STAMPED_WITHHOLDING_FIELD });
      }
      // Capture the booking rate at issue so period-close revaluation is exact.
      if (hasFx) {
        effects.push(
          bookingRateStampEffect({
            entity: "Invoice",
            triggerState: "sent",
            dateField: "issue_date",
            bookingRateField: STAMPED_BOOKING_RATE_FIELD,
            ...clockOpt,
            ...functionalResolver,
          }),
        );
        stamps.push({ entity: "Invoice", field: STAMPED_BOOKING_RATE_FIELD });
      }
    }
  }
  if (names.has("Bill") && hasGl) {
    // Recognition (tax-split): bill approved → credit AP; debit expense + input tax.
    effects.push(
      recognitionGlPostingEffect({
        entity: "Bill",
        triggerState: "approved",
        controlSide: "credit",
        sourceValue: "bill",
        entrySuffix: "-GL",
        numberField: "bill_number",
        ...postingFx("bill_date"),
        controlAccountRef: "accounts_payable",
        netAccountRef: "expense",
        taxAccountRef: "tax_input",
        controlDescription: "Bill — accounts payable",
        netDescription: "Bill — expense",
        taxDescription: "Bill — input tax",
        ...(hasTaxCodes && names.has("BillLine")
          ? {
              taxLines: {
                entity: "BillLine",
                refField: "bill_id",
                netField: "amount",
                // Tax withheld from a vendor is owed to the authority: a liability, not input tax.
                withholdingAccountRef: "wht_payable",
                ...taxDetermination("purchase", "bill_date"),
              },
              ...jurisdictionResolver,
            }
          : {}),
        ...clockOpt,
        ...periodsOpt,
        ...codeResolver((f) => ({
          ...(f.apAccountCode !== undefined ? { control: f.apAccountCode } : {}),
          ...(f.expenseAccountCode !== undefined ? { net: f.expenseAccountCode } : {}),
          ...(f.taxInputAccountCode !== undefined ? { tax: f.taxInputAccountCode } : {}),
          ...(f.whtPayableAccountCode !== undefined ? { withholding: f.whtPayableAccountCode } : {}),
        })),
      }),
    );
    // A bill voided after approval reverses the entry its approval posted.
    effects.push(
      postingReversalEffect({
        entity: "Bill",
        fromStates: ["approved", "overdue"],
        toState: "void",
        numberField: "bill_number",
        sourceSuffix: "-GL",
        reversalSuffix: "-VOID",
        sourceLabel: "bill",
        ...(names.has("Payment") ? { refuseWhileSettledBy: "bill_id" } : {}),
        ...clockOpt,
        ...periodsOpt,
      }),
    );
    if (hasFx) {
      effects.push(
        bookingRateStampEffect({
          entity: "Bill",
          triggerState: "approved",
          dateField: "bill_date",
          bookingRateField: STAMPED_BOOKING_RATE_FIELD,
          ...clockOpt,
          ...functionalResolver,
        }),
      );
      stamps.push({ entity: "Bill", field: STAMPED_BOOKING_RATE_FIELD });
    }
  }
  // Payment-driven settlement (supports partial payments + realized FX gain/loss).
  if (names.has("Payment") && hasGl) {
    effects.push(
      paymentSettlementGlPostingEffect({
        ...postingFx("paid_at"),
        settledDocuments: [
          ...(names.has("Invoice") ? [{ refField: "invoice_id", entity: "Invoice" }] : []),
          ...(names.has("Bill") ? [{ refField: "bill_id", entity: "Bill" }] : []),
        ],
        ...clockOpt,
        ...periodsOpt,
        ...codeResolver((f) => ({
          ...(f.cashAccountCode !== undefined ? { cash: f.cashAccountCode } : {}),
          ...(f.arAccountCode !== undefined ? { ar: f.arAccountCode } : {}),
          ...(f.apAccountCode !== undefined ? { ap: f.apAccountCode } : {}),
          ...(f.fxGainLossAccountCode !== undefined ? { fx: f.fxGainLossAccountCode } : {}),
        })),
      }),
      // A refund takes the money back, so it reverses the settlement the completion posted.
      postingReversalEffect({
        entity: "Payment",
        fromStates: ["completed"],
        toState: "refunded",
        numberField: "payment_number",
        sourceSuffix: "-SETTLE",
        reversalSuffix: "-REFUND",
        sourceLabel: "payment",
        ...clockOpt,
        ...periodsOpt,
      }),
    );
  }
  // Per-document application: a completed payment linked to an invoice/bill
  // accumulates and auto-settles the document once fully covered.
  if (names.has("Payment") && names.has("Invoice")) {
    effects.push(
      paymentApplicationEffect({
        documentEntity: "Invoice",
        refField: "invoice_id",
        settleableStates: ["sent", "overdue"],
        paidAtField: STAMPED_PAID_AT_FIELD,
        ...(invoiceWithholdingStamped ? { withholdingField: STAMPED_WITHHOLDING_FIELD } : {}),
        refundedState: "refunded",
        reopenState: "sent",
        ...clockOpt,
      }),
    );
    stamps.push({ entity: "Invoice", field: STAMPED_PAID_AT_FIELD });
  }
  if (names.has("Payment") && names.has("Bill")) {
    effects.push(
      paymentApplicationEffect({
        documentEntity: "Bill",
        refField: "bill_id",
        settleableStates: ["approved", "overdue"],
        paidAtField: STAMPED_PAID_AT_FIELD,
        refundedState: "refunded",
        reopenState: "approved",
        ...clockOpt,
      }),
    );
    stamps.push({ entity: "Bill", field: STAMPED_PAID_AT_FIELD });
  }
  // Unrealized FX revaluation at period close: when a FiscalPeriod closes, revalue every
  // open foreign-currency receivable/payable to the period-end rate and post one balanced
  // adjusting entry. Needs the GL, the fiscal calendar, the FX rate tables, and at least
  // one of Invoice/Bill to revalue.
  if (
    names.has("FiscalPeriod") &&
    hasGl &&
    names.has("Currency") &&
    names.has("ExchangeRate") &&
    (names.has("Invoice") || names.has("Bill"))
  ) {
    const fxDocuments = [
      ...(names.has("Invoice")
        ? [
            {
              entity: "Invoice",
              openStates: ["sent", "overdue"],
              paymentRefField: "invoice_id",
              side: "ar" as const,
              ...(invoiceWithholdingStamped ? { withholdingField: STAMPED_WITHHOLDING_FIELD } : {}),
              // The aging report's grouping (`creditNote` on its AR section), so the two agree.
              creditNote: {
                typeField: "document_type",
                typeValue: "credit_note",
                refField: "credit_note_of",
                creditedStates: ["void"],
              },
            },
          ]
        : []),
      ...(names.has("Bill")
        ? [{ entity: "Bill", openStates: ["approved", "overdue"], paymentRefField: "bill_id", side: "ap" as const }]
        : []),
    ];
    effects.push(
      unrealizedFxRevaluationEffect({
        documents: fxDocuments,
        ...(settingsStore !== undefined
          ? {
              resolveFunctionalCurrency: async (tenantId: string) =>
                (await settingsStore.get(tenantId)).defaults?.currency,
            }
          : {}),
        ...clockOpt,
        ...periodsOpt,
        ...codeResolver((f) => ({
          ...(f.unrealizedFxGainLossAccountCode !== undefined ? { fx: f.unrealizedFxGainLossAccountCode } : {}),
          ...(f.arAccountCode !== undefined ? { ar: f.arAccountCode } : {}),
          ...(f.apAccountCode !== undefined ? { ap: f.apAccountCode } : {}),
        })),
      }),
    );
  }
  // WHT certificate clearing: confirming a certificate reclasses the withheld tax from a
  // receivable into an income-tax-recoverable credit (needs the GL).
  // Stock and its valuation (see `inventory.ts`): each posting is wired only where the manifest has
  // every entity and field it reads, so a tenant's own manifest lacking one gets no posting rather
  // than a refusal on every write.
  const inventory = inventoryShape(manifest);
  const inventoryConfig: InventoryConfig = { ...clockOpt, ...periodsOpt, ...inventoryConfigFor(settingsStore) };
  if (inventory.ledger) {
    effects.push(stockMovementEffect(inventoryConfig), stockLevelEditEffect(inventoryConfig));
    if (hasGl) effects.push(standardCostRevaluationEffect(inventoryConfig));
  }
  if (inventory.goodsReceipt && hasGl) {
    effects.push(
      goodsReceiptPostingEffect(inventoryConfig),
      goodsReceiptCancellationEffect(inventoryConfig),
    );
    // The receipt is the only writer of what was received. A client-written figure is what both
    // the receipt (outstanding = quantity − received) and the three-way match read, so typing it
    // on a draft line would let a bill approve against goods no receipt moved, and the receipt
    // then receive none of them.
    stamps.push({ entity: "PurchaseOrderLine", field: STAMPED_RECEIVED_QUANTITY_FIELD });
  }
  if (inventory.shipment && hasGl) effects.push(shipmentIssueEffect(inventoryConfig));
  if (inventory.billMatch && hasGl) {
    effects.push(
      grniClearingEffect(inventoryConfig),
      postingReversalEffect({
        entity: "Bill",
        fromStates: ["approved", "overdue"],
        toState: "void",
        numberField: "bill_number",
        sourceSuffix: "-GRNI",
        reversalSuffix: "-GRNI-VOID",
        sourceLabel: "bill",
        ...clockOpt,
        ...periodsOpt,
      }),
    );
  }
  if (names.has("WhtCertificate") && hasGl) {
    effects.push(
      whtCertificateClearingEffect({
        ...postingFx("issue_date"),
        ...clockOpt,
        ...periodsOpt,
        ...codeResolver((f) => ({
          ...(f.whtReceivableAccountCode !== undefined ? { whtReceivable: f.whtReceivableAccountCode } : {}),
          ...(f.taxRecoverableAccountCode !== undefined ? { taxRecoverable: f.taxRecoverableAccountCode } : {}),
        })),
      }),
      // A void certificate no longer evidences the credit, so voiding it reverses its clearing.
      postingReversalEffect({
        entity: "WhtCertificate",
        fromStates: ["confirmed"],
        toState: "void",
        numberField: "certificate_number",
        sourceSuffix: "-WHT",
        reversalSuffix: "-WHT-VOID",
        sourceLabel: "system",
        ...clockOpt,
        ...periodsOpt,
      }),
    );
  }
  return { effects, stamps };
}

function buildSettingsDefaultPlans(manifest: Manifest): Map<string, SettingsDefaultPlan> {
  const plans = new Map<string, SettingsDefaultPlan>();
  for (const entity of manifest.entities ?? []) {
    const p = settingsDefaultPlan(entity);
    if (planHasSettingsDefaults(p)) plans.set(entity.name, p);
  }
  return plans;
}

/**
 * Entity → every operationId whose response can carry that entity's records,
 * read off the derived routes rather than computed from a list of action names.
 * That is the only form that can be right: a lifecycle transition's operationId
 * comes from the *manifest's workflow*, so a `(name: string) => string[]`
 * cannot name it, and the read-only convention this replaced
 * (`[<camel>.list, <camel>.read]`) left `create`, `update`, `delete` and every
 * transition out of the redaction registry — so a credential with update
 * permission read any record's `phi` fields by issuing a no-op PATCH.
 *
 * **Every** operation serving the entity goes in, with no exclusions. Redaction
 * is a no-op on a body that has no such key, so a 204 delete and an
 * association `{count}` cost nothing, while deciding per action whether its
 * response carries a record is the judgement call that produced the defect.
 */
/**
 * Which shape each entity action's response carries its records in, as a **total map** over
 * `RouteAction` so a seventh action is a compile error rather than a member inheriting whichever
 * answer a condition happened to give it — and the answer it would inherit is `record`, which on a
 * list would answer a per-field record policy against the *page wrapper* instead of a row.
 *
 * `delete` is `none` rather than `record`: it answers 204 with no body at all, so there is nothing
 * to locate and nothing to redact. A transition answers the updated record, like `update`.
 */
const ACTION_RECORD_SHAPE: Readonly<Record<RouteAction, ResponseRecordShape>> = {
  list: "page",
  read: "record",
  create: "record",
  update: "record",
  delete: "none",
  transition: "record",
};

/**
 * Entity → the operations whose responses can carry its records, each with the shape it carries
 * them in. The shape is **declared from the action**, never probed from the body: a heuristic over
 * the response (`"if it has a data array…"`) would misread a record that happens to carry one, and
 * this decides an authorization answer (ADR-0328's rule, ADR-0343).
 */
function entityOperationIndex(
  specs: readonly {
    readonly entity: string;
    readonly operationId: string;
    readonly recordShape: ResponseRecordShape;
  }[],
): ReadonlyMap<string, readonly RedactedOperation[]> {
  const index = new Map<string, RedactedOperation[]>();
  for (const spec of specs) {
    const ops = index.get(spec.entity);
    const op: RedactedOperation = {
      operationId: spec.operationId,
      recordShape: spec.recordShape,
    };
    if (ops === undefined) index.set(spec.entity, [op]);
    else if (!ops.some((o) => o.operationId === op.operationId)) ops.push(op);
  }
  return index;
}

/**
 * Fail closed when the index names no operation for an entity the manifest
 * declares: register the spec against the statically derivable CRUD ids, which
 * is less than the real set (it cannot know transitions) and far more than the
 * nothing an empty list would register. Unreachable today — `manifestRouteSpecs`
 * and `redactionRegistryFromManifest` both walk `manifest.entities`, so every
 * entity has at least its five CRUD specs — and here because "the index has no
 * entry" must never be the one path that serves classified fields in the clear.
 */
function fallbackOperationIds(entityName: string): readonly RedactedOperation[] {
  const actions: readonly CrudOperation[] = ["list", "create", "read", "update", "delete"];
  return actions.map((action) => ({
    operationId: operationId(entityName, action),
    recordShape: ACTION_RECORD_SHAPE[action],
  }));
}

export interface CompiledOperateServer {
  readonly routes: InMemoryRouteRegistry;
  readonly handlers: HandlerRegistry;
  readonly redactionRegistry: MapRedactionRegistry;
  readonly routeSpecs: readonly RouteSpec[];
  /**
   * The entity → operationIds mapping the redaction registry was keyed off.
   * Exposed because `MapRedactionRegistry` answers only `specFor(id)`, so
   * without it the mapping can be checked in one direction — "is this id
   * covered" — and never the other, "is every id covered one the route
   * derivation actually emits". The absence of that second direction is what
   * let a phantom `<entity>.get` and a lower-cased id sit in the old mapping
   * unnoticed, matching nothing.
   *
   * Each entry carries the shape its response holds records in (ADR-0343), so the mapping is
   * checkable in a third direction as well: not only that every covered id is one the derivation
   * emits, but that each is covered with the shape its own action produces.
   */
  readonly redactionOperationIds: ReadonlyMap<string, readonly RedactedOperation[]>;
  /**
   * Every server-side report this compile mounted, with what its handler reads and whom it admits.
   *
   * Read off the objects the handlers were built with rather than re-derived, because the role set
   * here is chosen independently of the manifest's entity grants (`financeRoles ?? the default`) and
   * a survey that re-spelled that `??` would describe the handler only until the option gained a
   * producer. Empty when the manifest models none of the entities a report needs.
   */
  readonly reportSurfaces: readonly ReportSurface[];
  /**
   * What a client may name in each entity's create and update body — the object the handlers
   * enforce, exposed so the OpenAPI document and a boot line read the same answer.
   */
  readonly writeSurfaces: ReadonlyMap<string, WriteSurface>;
  /**
   * Background work's way into this server's entities — through the same handlers, so a job's write
   * runs every guard, effect, lifecycle rule and audit record a request's does. See
   * `system-writer.ts`.
   */
  readonly systemEntityAccess: SystemEntityAccess;
}

/** One mounted report route, as built. See {@link CompiledOperateServer.reportSurfaces}. */
export interface ReportSurface {
  readonly operationId: string;
  /** Every entity the handler reads records of, the documents first. */
  readonly reads: readonly string[];
  /** The roles the handler admits — the same set object the handler holds. */
  readonly viewerRoles: ReadonlySet<RoleName>;
}

/**
 * Compiles a resolved manifest into the gateway wiring: a route per entity
 * operation (CRUD + lifecycle transitions), an RBAC-enforcing handler per route,
 * and a classification redaction registry — all derived from the manifest, none
 * hand-written.
 */
export function compileOperateServer(
  manifest: Manifest,
  options: OperateRuntimeOptions,
): CompiledOperateServer {
  const routes = new InMemoryRouteRegistry();
  const handlers = new HandlerRegistry();
  const roles = new Map<RoleName, RoleDefinition>(Object.entries(manifest.roles ?? {}));
  // Every `decimal` field crossing the store carries the canonical wire form from here on. The
  // wrap happens at compile time because this is the one place that holds both the store and the
  // manifest that declares each field's precision and scale — so a deployment cannot forget it,
  // and the write effects, which create journal lines through the store they are handed, are
  // covered by the same seam as a client request.
  //
  // `withListValueTypes` rides the same seam for the same reason, and goes **inside**: it adds
  // nothing to a record, only per-field comparison types to a list query, so the wire-type
  // decorator's record mapping still runs over whatever page comes back. Without it a
  // text-holding store orders a `decimal` or an `integer` lexicographically, and since the keyset
  // cursor is built from that ordering, a list does not merely come back in the wrong order — it
  // skips and repeats rows at page boundaries.
  //
  // `withDatetimeWireType` is the third layer and the same seam: before it the two Postgres stores
  // disagreed about a timestamp's *spelling* before they could disagree about its order (the column
  // store canonicalises through `isoInstant`, the JSONB store echoes whatever the write put in its
  // document), and `validateBody` had no rule for a `datetime` field at all, so a client could
  // store any string and four spellings of one instant sorted into three positions. It goes
  // outside `withListValueTypes` and beside the decimal decorator because the two are independent:
  // no field is both a `decimal` and a `datetime`, so their record mappings cannot interact.
  const store = withDatetimeWireType(
    withDecimalWireType(
      withListValueTypes(options.store, listValueTypesForManifest(manifest)),
      decimalFieldIndexFromManifest(manifest),
    ),
    temporalFieldIndexFromManifest(manifest),
  );
  // Built once and read by both halves of ADR-0329 — the write mask on the handler context below,
  // and the response-redaction registry's `classifiedFieldsForEntity`. The gateway cannot derive
  // it: `api-gateway-runtime` does not depend on `@crossengin/kernel`, so it cannot resolve a
  // trait, which is exactly why its resolver is a required option rather than a read it performs
  // itself. One value, two readers, no second resolution to drift.
  const classifiedFieldIndex = buildClassifiedFieldIndex(manifest);
  // A deployment passing its own `writeEffects` declares no stamps: its effects are opaque here, so
  // a field one of them stamps stays client-writable rather than being guessed at.
  // The effects read tenant settings through this, never through the pool directly: see
  // `settings-snapshot.ts` for the pool deadlock a settings read inside a write transaction caused.
  const settingsScope =
    options.settingsStore !== undefined ? transactionSettingsScope(options.settingsStore) : undefined;
  const effectWiring =
    options.writeEffects !== undefined
      ? { effects: options.writeEffects, stamps: [] as readonly EffectStamp[] }
      : defaultWriteEffectsWithStamps(manifest, options.clock, settingsScope?.store);
  const writeSurfaces = buildWriteSurfaces(manifest, effectWiring.stamps);
  const ctx: HandlerContext = {
    store,
    permissions: manifest.permissions ?? {},
    roles,
    principalRoles: options.principalRoles,
    sequencePlans: buildSequencePlans(manifest),
    defaultPlans: buildDefaultPlans(manifest),
    settingsDefaultPlans: buildSettingsDefaultPlans(manifest),
    validationPlans: buildValidationPlans(manifest),
    // Field-level write authorization. Keyed by **entity**, deliberately not off
    // `entityOperationIndex` below: that index is a *response* mapping keyed by operationId, and
    // a write mask answers "may this principal write this field of this entity" — reusing it
    // would be a category error.
    //
    // This is `classifiedFieldIndex`, the **same value** the redaction registry below is given.
    // It used to say "the same *function* the redaction registry reads, so one declaration drives
    // both halves of ADR-0329" — which was true and bought nothing, because both read the
    // entity's own fields and so agreed *in being wrong*: a trait-contributed classified field was
    // invisible to the mask and to the redaction alike. One index read twice is the property that
    // comment wanted; the same narrow function called twice was not.
    classifiedFields: classifiedFieldIndex,
    writeMaskMode: options.writeMaskMode ?? "explicit_only",
    writeGuards:
      options.writeGuards ??
      defaultWriteGuards(manifest, options.allowUncoveredSettlement ?? false, effectWiring.stamps, settingsScope?.store),
    writeEffects: [...effectWiring.effects, ...(options.additionalWriteEffects ?? [])],
    writeSurfaces,
    lifecycleStateFields: lifecycleStateFieldIndex(manifest),
    ...(options.segregationOfDuties === true
      ? { segregationOfDuties: true, approvalContent: approvalContentFromManifest(manifest) }
      : {}),
    ...(options.entityAudit !== undefined ? { entityAudit: options.entityAudit } : {}),
    ...(options.allocator !== undefined ? { allocator: options.allocator } : {}),
    ...(options.settingsStore !== undefined ? { settingsStore: options.settingsStore } : {}),
    ...(settingsScope !== undefined ? { settingsScope } : {}),
    ...(options.policyForEntity !== undefined ? { policyForEntity: options.policyForEntity } : {}),
    ...(options.abacEvaluator !== undefined ? { abacEvaluator: options.abacEvaluator } : {}),
    ...(options.abacBatchEvaluator !== undefined
      ? { abacBatchEvaluator: options.abacBatchEvaluator }
      : {}),
    ...(options.cursorSealer !== undefined ? { cursorSealer: options.cursorSealer } : {}),
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
  };

  // Subscription gate (opt-in): wrap a handler with the entitlement pre-check. Reads pass
  // for `past_due` tenants; suspended/lapsed tenants get a 402. meta.schema + admin.settings
  // stay ungated so the UI can still render (and show a payment-required state).
  const resolver = options.entitlementResolver;
  const gate = (handler: Parameters<typeof handlers.register>[1], op: "read" | "write") =>
    resolver !== undefined ? withEntitlement(handler, op, resolver) : handler;

  const routeSpecs = manifestRouteSpecs(manifest);
  for (const spec of routeSpecs) {
    routes.register(routeFromSpec(spec));
    const base = buildSpecHandler(spec, ctx);
    // A create op runs the combined write-status + record-cap gate; every other op runs
    // the status-only gate (read for GET, write otherwise).
    const handler =
      resolver !== undefined && spec.action === "create"
        ? withRecordLimit(base, { resolver, store, entity: spec.entity })
        : gate(base, spec.method === "GET" ? "read" : "write");
    handlers.register(spec.operationId, handler);
  }

  // Association read routes: GET /v1/<owner>/{id}/<related> lists the m2m-linked related records.
  const associationListSpecs = manifestAssociationRoutes(manifest);
  for (const spec of associationListSpecs) {
    routes.register(associationRouteFromSpec(spec));
    handlers.register(spec.operationId, gate(buildAssociationListHandler(spec, ctx), "read"));
  }
  // Association write routes: PUT/DELETE /v1/<owner>/{id}/<related>/{relatedId} link/unlink.
  const associationWriteSpecs = manifestAssociationWriteRoutes(manifest);
  for (const spec of associationWriteSpecs) {
    routes.register(associationWriteRouteFromSpec(spec));
    handlers.register(spec.operationId, gate(buildAssociationWriteHandler(spec, ctx), "write"));
  }
  // Association count routes: GET /v1/<owner>/{id}/<related>/count counts the m2m-linked related records.
  const associationCountSpecs = manifestAssociationCountRoutes(manifest);
  for (const spec of associationCountSpecs) {
    routes.register(associationCountRouteFromSpec(spec));
    handlers.register(spec.operationId, gate(buildAssociationCountHandler(spec, ctx), "read"));
  }

  // Manifest-driven UI metadata: any authenticated principal may read the shape.
  routes.register(literalRoute("meta.schema.read", "GET", ["v1", "meta", "schema"]));
  handlers.register(
    "meta.schema.read",
    buildUiSchemaHandler({
      schema: buildUiSchema(manifest, new Date(), writeSurfaces),
      principalRoles: options.principalRoles,
      ...(options.settingsStore !== undefined ? { settingsStore: options.settingsStore } : {}),
      ...(options.userIdentity !== undefined ? { userIdentity: options.userIdentity } : {}),
    }),
  );

  // This deployment's own API description, derived from the registry above rather than from
  // `routeSpecs`. Registered beside `meta.schema.read` because they are one family — manifest-driven
  // metadata, ungated, each handler self-authorizing — and because the comparison decides the
  // authorization: this one discloses strictly *less* than that one already does.
  //
  // `describe` is a thunk and is read on the first request, which is what makes this registration's
  // POSITION irrelevant. `extraRoutes` are registered forty lines below, and on the shipped compose
  // those are 38 of the 375 routes a request reaches; a snapshot taken here would omit every one of
  // them with no refusal and no note, which is the falsely-complete direction (ADR-0337).
  routes.register(literalRoute(OPENAPI_OPERATION_ID, "GET", [...OPENAPI_PATH_SEGMENTS]));
  handlers.register(
    OPENAPI_OPERATION_ID,
    buildOpenApiHandler({
      describe: () => ({
        manifest,
        routes: routes.list(),
        routeSpecs,
        title: manifest.meta?.name ?? "CrossEngin Operate",
        // The manifest hash and deliberately not `manifest.meta.version`. OpenAPI's `info.version`
        // is the version of the *described contract*, and `meta.version` is a pack author's
        // declaration that moves when they choose it to — so it can sit at `0.1.0` across a
        // breaking entity change, which is the one thing this field must not do. The hash is
        // derived, so it moves exactly when the contract does, and it is already the identity the
        // activation flow and the reviewer's diff compare. The author's own figure is in the
        // description, where being advisory is honest.
        version: manifestHash(manifest),
        coverage: options.openApiCoverage?.() ?? [],
        writeSurfaces,
        residency: options.openApiResidency?.() ?? null,
      }),
    }),
  );

  if (options.settingsStore !== undefined) {
    const adminCtx: AdminContext = {
      settingsStore: options.settingsStore,
      principalRoles: options.principalRoles,
      adminRoles: new Set(options.adminRoles ?? DEFAULT_ADMIN_ROLES),
    };
    routes.register(literalRoute("admin.settings.read", "GET", ["v1", "admin", "settings"]));
    routes.register(literalRoute("admin.settings.update", "PUT", ["v1", "admin", "settings"]));
    handlers.register("admin.settings.read", buildAdminSettingsReadHandler(adminCtx));
    handlers.register("admin.settings.update", buildAdminSettingsUpdateHandler(adminCtx));
  }

  // Deployment-injected admin routes (e.g. marketplace pack install) — registered ungated; each
  // handler self-authorizes. The runtime treats them as opaque, so it needs no domain knowledge.
  for (const extra of options.extraRoutes ?? []) {
    routes.register(extra.route);
    handlers.register(extra.route.operationId, extra.handler);
  }

  // The caller tenant's own subscription/plan state, when a resolver is wired. Registered
  // UNGATED (like meta.schema + admin.settings) so a lapsed tenant can still load their
  // billing screen — a principal may always read their OWN tenant's plan.
  if (resolver !== undefined) {
    routes.register(literalRoute("meta.entitlement.read", "GET", ["v1", "meta", "entitlement"]));
    handlers.register("meta.entitlement.read", buildEntitlementHandler({ resolver }));
    // Per-entity record usage against the plan cap, for the billing screen's "N of M used" meter.
    routes.register(literalRoute("meta.usage.read", "GET", ["v1", "meta", "usage"]));
    handlers.register(
      "meta.usage.read",
      buildUsageHandler({ resolver, store, entities: (manifest.entities ?? []).map((e) => e.name) }),
    );
  }

  // Stripe Billing Portal (opt-in): a lapsed tenant can reach it to fix payment, so it is
  // registered UNGATED (own tenant only) even when the subscription gate is active.
  if (options.billingPortal !== undefined) {
    routes.register(literalRoute("meta.billing-portal.create", "POST", ["v1", "meta", "billing-portal"]));
    handlers.register("meta.billing-portal.create", buildBillingPortalHandler(options.billingPortal));
  }

  // On-demand job invocation (opt-in): an authenticated caller runs a userInvoked job for their own
  // tenant, enqueuing it into job_runs for the worker fleet.
  if (options.jobInvoker !== undefined) {
    routes.register(literalRoute("meta.jobs.invoke", "POST", ["v1", "meta", "jobs", "invoke"]));
    handlers.register(
      "meta.jobs.invoke",
      buildJobInvokeHandler(options.jobInvoker, {
        principalRoles: options.principalRoles,
        ...(options.jobInvokeRoles !== undefined
          ? { allowedRoles: new Set<string>(options.jobInvokeRoles as readonly string[]) }
          : {}),
        ...(options.jobInvokeActionRoles !== undefined ? { rolesByAction: options.jobInvokeActionRoles } : {}),
      }),
    );
  }

  // AR/AP aging report, when the manifest models invoices/bills + payments.
  const agingNames = new Set((manifest.entities ?? []).map((e) => e.name));
  // One set for both report handlers and for `reportSurfaces`, so what the survey says is the set
  // each handler enforces rather than a second spelling of this `??`.
  const financeRoles: ReadonlySet<RoleName> = new Set(options.financeRoles ?? DEFAULT_FINANCE_ROLES);
  const reportSurfaces: ReportSurface[] = [];
  // Passed to the handlers explicitly rather than left to their defaults, so the entities a surface
  // says it reads are the ones the handler was told to read.
  const paymentEntity = "Payment";
  const invoiceEntity = "Invoice";
  const certificateEntity = "WhtCertificate";
  const agingSections: Record<string, AgingSpec> = {};
  if (agingNames.has(invoiceEntity) && agingNames.has(paymentEntity)) {
    agingSections["ar"] = {
      entity: invoiceEntity,
      openStates: ["sent", "overdue"],
      paymentRefField: "invoice_id",
      numberField: "invoice_number",
      ...(isStamped(effectWiring.stamps, invoiceEntity, STAMPED_WITHHOLDING_FIELD)
        ? { withholdingField: STAMPED_WITHHOLDING_FIELD }
        : {}),
      creditNote: { typeField: "document_type", typeValue: "credit_note", refField: "credit_note_of", creditedStates: ["void"] },
    };
  }
  if (agingNames.has("Bill") && agingNames.has(paymentEntity)) {
    agingSections["ap"] = {
      entity: "Bill",
      openStates: ["approved", "overdue"],
      paymentRefField: "bill_id",
      numberField: "bill_number",
    };
  }
  if (Object.keys(agingSections).length > 0) {
    routes.register(literalRoute("meta.aging.read", "GET", ["v1", "meta", "aging"]));
    reportSurfaces.push({
      operationId: "meta.aging.read",
      reads: [...Object.values(agingSections).map((s) => s.entity), paymentEntity],
      viewerRoles: financeRoles,
    });
    handlers.register(
      "meta.aging.read",
      gate(
        buildAgingHandler({
          store,
          principalRoles: options.principalRoles,
          viewerRoles: financeRoles,
          paymentEntity,
          sections: agingSections,
          ...(options.clock !== undefined ? { clock: options.clock } : {}),
        }),
        "read",
      ),
    );
  }

  // WHT reconciliation report: withheld (invoice withholding_total) vs certified
  // (confirmed WhtCertificate amounts), when the manifest models both.
  if (agingNames.has(invoiceEntity) && agingNames.has(certificateEntity)) {
    routes.register(literalRoute("meta.whtReconciliation.read", "GET", ["v1", "meta", "wht-reconciliation"]));
    reportSurfaces.push({
      operationId: "meta.whtReconciliation.read",
      reads: [invoiceEntity, certificateEntity],
      viewerRoles: financeRoles,
    });
    handlers.register(
      "meta.whtReconciliation.read",
      gate(
        buildWhtReconciliationHandler({
          store,
          principalRoles: options.principalRoles,
          viewerRoles: financeRoles,
          invoiceEntity,
          certificateEntity,
        }),
        "read",
      ),
    );
  }

  // Every operationId whose response can carry an entity's records, taken from the routes this
  // compile actually derived — the entity routes above (CRUD *and* one per lifecycle transition,
  // whose ids come out of the manifest's workflows) plus the association routes, where the
  // records served belong to the *related* entity and the link/unlink pair belongs to the owner.
  //
  // The three association families carry their own shapes rather than an action: the list answers
  // `{data, page}` like an entity list, the count answers `{count}` and so carries no record at
  // all, and link/unlink answer a link summary and not the owner record — which is why that pair is
  // `none` even though its *attribution* is the owner entity. Attribution answers "whose fields
  // could appear here" and the shape answers "where"; a route can be attributed to an entity and
  // still return none of its records.
  const operationIdsByEntity = entityOperationIndex([
    ...routeSpecs.map((s) => ({
      entity: s.entity,
      operationId: s.operationId,
      recordShape: ACTION_RECORD_SHAPE[s.action],
    })),
    ...associationListSpecs.map((s) => ({
      entity: s.relatedEntity,
      operationId: s.operationId,
      recordShape: "page" as const,
    })),
    ...associationCountSpecs.map((s) => ({
      entity: s.relatedEntity,
      operationId: s.operationId,
      recordShape: "none" as const,
    })),
    ...associationWriteSpecs.map((s) => ({
      entity: s.ownerEntity,
      operationId: s.operationId,
      recordShape: "none" as const,
    })),
  ]);
  const redactionRegistry = redactionRegistryFromManifest(manifest, {
    rolesForPrincipal: options.principalRoles,
    // The same index the write mask holds, so the read half and the write half of ADR-0329 cannot
    // answer differently about which fields of an entity are classified. `?? []` is the honest
    // answer for an entity the index omits — `buildClassifiedFieldIndex` omits entities with no
    // classified field, and an empty set is the same statement as an absent one here, which is why
    // `redactionSpecForEntity` still correctly returns `null` for it.
    classifiedFieldsForEntity: (name) => classifiedFieldIndex.get(name) ?? [],
    operationsForEntity: (name) => operationIdsByEntity.get(name) ?? fallbackOperationIds(name),
    ...(options.policyForEntity !== undefined ? { policyForEntity: options.policyForEntity } : {}),
    ...(options.abacEvaluator !== undefined ? { abacEvaluator: options.abacEvaluator } : {}),
    ...(options.abacBatchEvaluator !== undefined
      ? { abacBatchEvaluator: options.abacBatchEvaluator }
      : {}),
  });

  return {
    routes,
    handlers,
    redactionRegistry,
    routeSpecs,
    redactionOperationIds: operationIdsByEntity,
    reportSurfaces,
    writeSurfaces,
    systemEntityAccess: buildSystemEntityAccess({
      handlers,
      routeSpecs,
      store,
      ...(options.clock !== undefined ? { clock: options.clock } : {}),
    }),
  };
}

export interface OperateGatewayOptions extends OperateRuntimeOptions {
  readonly principalResolver?: PrincipalResolver;
  readonly opaqueTokenLookup?: OpaqueTokenLookup;
  readonly hmacKeyLookup?: HmacKeyLookup;
  /**
   * The enrolled client-certificate registry, for `mtls`.
   *
   * **Declared here for the reason the `requiredJwtClaims` note below gives, which this field
   * demonstrated by being omitted.** It was added to `GatewayRuntimeOptions` and to
   * `BuildOperateHttpServerOptions` and left off *this* interface, so the conditional spread in
   * `server.ts` dropped it with `tsc` exiting 0 — and the symptom was two boot lines disagreeing in
   * one process: `edge trust: … serving 1 enrolled certificate(s)` beside `mtls is served by this
   * binary and has no client-certificate registry configured`. Found by a live boot, exactly as
   * ADR-0386's instance was found by a live request.
   *
   * Worth knowing: ADR-0386's fence over this literal could not have caught it. That test compares
   * the fields **both** interfaces declare, so it finds a field dropped from the forwarding literal
   * and is blind to one never added to this interface at all — the intersection is empty for such a
   * field, so there is nothing to compare. See `compile.test.ts` for the widened check.
   */
  readonly mtlsClientLookup?: MtlsClientLookup;
  readonly requestSignatureToleranceSeconds?: number;
  readonly idempotencyStore?: IdempotencyStore;
  readonly rateLimitChecker?: RateLimitChecker;
  readonly clock?: { now(): Date };
  /** Production identity: a JWKS provider + expected issuer/audience for Bearer-JWT auth. */
  readonly jwksProvider?: JwksProvider;
  readonly jwtIssuer?: string;
  readonly jwtAudience?: string;
  /**
   * Which JWT claims a token must carry, beyond matching when it carries them (ADR-0386).
   *
   * Declared here because this function forwards **one named field at a time**, so an option absent
   * from this interface is dropped in silence — and the caller passes its JWT options inside a
   * conditional spread, which bypasses TypeScript's excess-property check, so nothing said so. That
   * is how `--jwt-optional-claim` came to print a relaxed boot line while the verifier required all
   * three: the field reached `buildOperateGateway` and stopped here, and `GatewayRuntime`'s own
   * default is the strict set, so the drop produced a *safe* wrong answer and was invisible to every
   * test. Found only by a live request.
   */
  readonly requiredJwtClaims?: ReadonlySet<RequiredJwtClaim>;
  /**
   * The idempotency lease and the largest response body a replay stores (ADR-0449). Declared and
   * forwarded for the reason `requiredJwtClaims` is: an option `GatewayRuntime` accepts and this
   * interface omits is dropped in silence, and this file's own fence found all three below doing so.
   */
  readonly idempotencyLeaseSeconds?: number;
  readonly idempotencyMaxStoredBodyBytes?: number;
  /**
   * Where a stage or handler that **threw** is reported, with the request id the caller was given.
   * Without it the cause survived only as a truncated stage reason, so a 500 from a thrown handler
   * left its stack in no log.
   */
  readonly onInternalError?: GatewayRuntimeOptions["onInternalError"];
}

export interface OperateServer extends CompiledOperateServer {
  readonly runtime: GatewayRuntime;
}

/**
 * Builds a ready-to-serve `GatewayRuntime` for a resolved manifest — the
 * keystone of `operate-server`. In-memory stores are the default; the Postgres
 * `EntityStore` + the HTTP binary slot in by swapping the injected pieces.
 */
export function buildOperateGateway(
  manifest: Manifest,
  options: OperateGatewayOptions,
): OperateServer {
  const compiled = compileOperateServer(manifest, options);
  const runtime = new GatewayRuntime({
    routes: compiled.routes,
    handlers: compiled.handlers,
    principalResolver: options.principalResolver ?? new InMemoryPrincipalResolver(),
    idempotencyStore: options.idempotencyStore ?? new InMemoryIdempotencyStore(),
    rateLimitChecker: options.rateLimitChecker ?? new InMemoryRateLimitChecker({ limit: 10_000 }),
    redactionRegistry: compiled.redactionRegistry,
    ...(options.opaqueTokenLookup !== undefined ? { opaqueTokenLookup: options.opaqueTokenLookup } : {}),
    ...(options.hmacKeyLookup !== undefined ? { hmacKeyLookup: options.hmacKeyLookup } : {}),
    ...(options.mtlsClientLookup !== undefined
      ? { mtlsClientLookup: options.mtlsClientLookup }
      : {}),
    ...(options.requestSignatureToleranceSeconds !== undefined
      ? { requestSignatureToleranceSeconds: options.requestSignatureToleranceSeconds }
      : {}),
    ...(options.jwksProvider !== undefined ? { jwksProvider: options.jwksProvider } : {}),
    ...(options.jwtIssuer !== undefined ? { jwtIssuer: options.jwtIssuer } : {}),
    ...(options.jwtAudience !== undefined ? { jwtAudience: options.jwtAudience } : {}),
    ...(options.requiredJwtClaims !== undefined ? { requiredJwtClaims: options.requiredJwtClaims } : {}),
    ...(options.idempotencyLeaseSeconds !== undefined
      ? { idempotencyLeaseSeconds: options.idempotencyLeaseSeconds }
      : {}),
    ...(options.idempotencyMaxStoredBodyBytes !== undefined
      ? { idempotencyMaxStoredBodyBytes: options.idempotencyMaxStoredBodyBytes }
      : {}),
    ...(options.onInternalError !== undefined ? { onInternalError: options.onInternalError } : {}),
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
  });
  return { ...compiled, runtime };
}
