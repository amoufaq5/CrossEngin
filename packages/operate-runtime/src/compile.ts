import type {
  AbacBatchEvaluator,
  AbacEvaluator,
  RoleDefinition,
  RoleName,
  SensitiveFieldPolicy,
} from "@crossengin/auth";
import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import type { PathSegment, RouteDefinition } from "@crossengin/api-gateway";
import type { Manifest } from "@crossengin/kernel/manifest";
import {
  GatewayRuntime,
  HandlerRegistry,
  InMemoryIdempotencyStore,
  InMemoryPrincipalResolver,
  InMemoryRateLimitChecker,
  InMemoryRouteRegistry,
  MapRedactionRegistry,
  redactionRegistryFromManifest,
  type Handler,
  type IdempotencyStore,
  type JwksProvider,
  type OpaqueTokenLookup,
  type PrincipalResolver,
  type PrincipalRoles,
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
  lockedDocumentGuard,
  postedEntryImmutabilityGuard,
  type WriteGuard,
} from "./write-guards.js";
import {
  bookingRateStampEffect,
  creditNoteGlPostingEffect,
  invoiceVoidCreditNoteEffect,
  journalReversalEffect,
  paymentApplicationEffect,
  paymentSettlementGlPostingEffect,
  recognitionGlPostingEffect,
  unrealizedFxRevaluationEffect,
  whtCertificateClearingEffect,
  type WriteEffect,
} from "./write-effects.js";
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
import { operationId, type CrudOperation } from "./slugs.js";
import type { EntityStore } from "./store.js";
import { temporalFieldIndexFromManifest, withDatetimeWireType } from "./datetime-store.js";
import { decimalFieldIndexFromManifest, withDecimalWireType } from "./decimal-store.js";
import { listValueTypesForManifest, withListValueTypes } from "./list-value-types.js";
import { buildUiSchema, buildUiSchemaHandler } from "./ui-schema.js";
import { buildClassifiedFieldIndex, type WriteMaskMode } from "./write-mask.js";

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
  /** Backs the admin settings endpoints + runtime numbering overrides. */
  readonly settingsStore?: SettingsStore;
  /** Roles permitted to read/write tenant settings. Defaults to {"erp_admin"}. */
  readonly adminRoles?: readonly RoleName[];
  /** Roles permitted to read finance reports (e.g. aging). Defaults to a finance-role set. */
  readonly financeRoles?: readonly RoleName[];
  /** Runtime data invariants checked before each write (e.g. balanced journal postings). */
  readonly writeGuards?: readonly WriteGuard[];
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

/** Guards inferred from the manifest's shape; opt out by passing `writeGuards: []`. */
function defaultWriteGuards(manifest: Manifest): readonly WriteGuard[] {
  const names = new Set((manifest.entities ?? []).map((e) => e.name));
  const guards: WriteGuard[] = [];
  if (names.has("JournalEntry") && names.has("JournalLine")) {
    guards.push(journalPostingGuard(), postedEntryImmutabilityGuard());
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
        reverseHint: "void it instead",
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
        reverseHint: "amend it instead",
      }),
    );
  }
  // A committed sales order is a customer commitment: once it leaves draft it
  // can't be edited or deleted out of band (cancel via the lifecycle instead).
  // States span the core (confirmed→…→closed) and retail (placed/returned) lifecycles.
  if (names.has("SalesOrder")) {
    guards.push(
      lockedDocumentGuard({
        entity: "SalesOrder",
        lockedStates: ["confirmed", "fulfilled", "invoiced", "closed", "placed", "returned"],
        ...(names.has("SalesOrderLine") ? { childEntity: "SalesOrderLine", childParentField: "sales_order_id" } : {}),
        lockedError: "sales_order_locked",
        childLockedError: "sales_order_locked_lines",
        noun: "committed sales order",
        reverseHint: "cancel it instead",
      }),
    );
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
        reverseHint: "cancel it instead",
      }),
    );
  }
  return guards;
}

/** Effects inferred from the manifest's shape; opt out by passing `writeEffects: []`. */
function defaultWriteEffects(
  manifest: Manifest,
  clock?: { now(): Date },
  settingsStore?: SettingsStore,
): readonly WriteEffect[] {
  const names = new Set((manifest.entities ?? []).map((e) => e.name));
  const effects: WriteEffect[] = [];
  const clockOpt = clock !== undefined ? { clock } : {};
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
  // Per-jurisdiction default tax accounts, from finance settings (jurisdiction → code).
  const jurisdictionResolver =
    settingsStore === undefined
      ? {}
      : {
          resolveJurisdictionAccounts: async (tenantId: string) =>
            (await settingsStore.get(tenantId)).finance?.taxAccountsByJurisdiction ?? {},
        };

  if (names.has("JournalEntry") && names.has("JournalLine")) {
    effects.push(journalReversalEffect(clockOpt));
  }
  if (names.has("Invoice")) {
    effects.push(
      invoiceVoidCreditNoteEffect({
        ...(names.has("InvoiceLine") ? { lineEntity: "InvoiceLine" } : {}),
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
          skipDocumentType: { field: "document_type", value: "credit_note" },
          controlAccountRef: "accounts_receivable",
          netAccountRef: "revenue",
          taxAccountRef: "tax_payable",
          controlDescription: "Invoice — accounts receivable",
          netDescription: "Invoice — revenue",
          taxDescription: "Invoice — tax payable",
          ...(hasTaxCodes && names.has("InvoiceLine")
            ? { taxLines: { entity: "InvoiceLine", refField: "invoice_id", netField: "line_total" }, stampWithholdingField: "withholding_total", ...jurisdictionResolver }
            : {}),
          ...clockOpt,
          ...codeResolver((f) => ({
            ...(f.arAccountCode !== undefined ? { control: f.arAccountCode } : {}),
            ...(f.revenueAccountCode !== undefined ? { net: f.revenueAccountCode } : {}),
            ...(f.taxPayableAccountCode !== undefined ? { tax: f.taxPayableAccountCode } : {}),
          })),
        }),
      );
      // AR reversal on credit-note issuance.
      effects.push(
        creditNoteGlPostingEffect({
          ...clockOpt,
          ...codeResolver((f) => ({
            ...(f.arAccountCode !== undefined ? { ar: f.arAccountCode } : {}),
            ...(f.revenueAccountCode !== undefined ? { revenue: f.revenueAccountCode } : {}),
          })),
        }),
      );
      // Capture the booking rate at issue so period-close revaluation is exact.
      if (hasFx) {
        effects.push(
          bookingRateStampEffect({
            entity: "Invoice",
            triggerState: "sent",
            dateField: "issue_date",
            ...clockOpt,
            ...functionalResolver,
          }),
        );
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
        controlAccountRef: "accounts_payable",
        netAccountRef: "expense",
        taxAccountRef: "tax_input",
        controlDescription: "Bill — accounts payable",
        netDescription: "Bill — expense",
        taxDescription: "Bill — input tax",
        ...(hasTaxCodes && names.has("BillLine")
          ? { taxLines: { entity: "BillLine", refField: "bill_id", netField: "amount" }, ...jurisdictionResolver }
          : {}),
        ...clockOpt,
        ...codeResolver((f) => ({
          ...(f.apAccountCode !== undefined ? { control: f.apAccountCode } : {}),
          ...(f.expenseAccountCode !== undefined ? { net: f.expenseAccountCode } : {}),
          ...(f.taxInputAccountCode !== undefined ? { tax: f.taxInputAccountCode } : {}),
        })),
      }),
    );
    if (hasFx) {
      effects.push(
        bookingRateStampEffect({
          entity: "Bill",
          triggerState: "approved",
          dateField: "bill_date",
          ...clockOpt,
          ...functionalResolver,
        }),
      );
    }
  }
  // Payment-driven settlement (supports partial payments + realized FX gain/loss).
  if (names.has("Payment") && hasGl) {
    effects.push(
      paymentSettlementGlPostingEffect({
        ...clockOpt,
        ...codeResolver((f) => ({
          ...(f.cashAccountCode !== undefined ? { cash: f.cashAccountCode } : {}),
          ...(f.arAccountCode !== undefined ? { ar: f.arAccountCode } : {}),
          ...(f.apAccountCode !== undefined ? { ap: f.apAccountCode } : {}),
          ...(f.fxGainLossAccountCode !== undefined ? { fx: f.fxGainLossAccountCode } : {}),
        })),
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
        ...clockOpt,
      }),
    );
  }
  if (names.has("Payment") && names.has("Bill")) {
    effects.push(
      paymentApplicationEffect({
        documentEntity: "Bill",
        refField: "bill_id",
        settleableStates: ["approved", "overdue"],
        ...clockOpt,
      }),
    );
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
        ? [{ entity: "Invoice", openStates: ["sent", "overdue"], paymentRefField: "invoice_id", side: "ar" as const }]
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
  if (names.has("WhtCertificate") && hasGl) {
    effects.push(
      whtCertificateClearingEffect({
        ...clockOpt,
        ...codeResolver((f) => ({
          ...(f.whtReceivableAccountCode !== undefined ? { whtReceivable: f.whtReceivableAccountCode } : {}),
          ...(f.taxRecoverableAccountCode !== undefined ? { taxRecoverable: f.taxRecoverableAccountCode } : {}),
        })),
      }),
    );
  }
  return effects;
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
    // would be a category error. The classifications come from `entityClassifiedFields`, the same
    // function the redaction registry reads, so one declaration drives both halves of ADR-0329.
    classifiedFields: buildClassifiedFieldIndex(manifest),
    writeMaskMode: options.writeMaskMode ?? "explicit_only",
    writeGuards: options.writeGuards ?? defaultWriteGuards(manifest),
    writeEffects: [
      ...(options.writeEffects ?? defaultWriteEffects(manifest, options.clock, options.settingsStore)),
      ...(options.additionalWriteEffects ?? []),
    ],
    ...(options.allocator !== undefined ? { allocator: options.allocator } : {}),
    ...(options.settingsStore !== undefined ? { settingsStore: options.settingsStore } : {}),
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
      schema: buildUiSchema(manifest),
      principalRoles: options.principalRoles,
      ...(options.settingsStore !== undefined ? { settingsStore: options.settingsStore } : {}),
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
  const agingSections: Record<string, AgingSpec> = {};
  if (agingNames.has("Invoice") && agingNames.has("Payment")) {
    agingSections["ar"] = {
      entity: "Invoice",
      openStates: ["sent", "overdue"],
      paymentRefField: "invoice_id",
      numberField: "invoice_number",
    };
  }
  if (agingNames.has("Bill") && agingNames.has("Payment")) {
    agingSections["ap"] = {
      entity: "Bill",
      openStates: ["approved", "overdue"],
      paymentRefField: "bill_id",
      numberField: "bill_number",
    };
  }
  if (Object.keys(agingSections).length > 0) {
    routes.register(literalRoute("meta.aging.read", "GET", ["v1", "meta", "aging"]));
    handlers.register(
      "meta.aging.read",
      gate(
        buildAgingHandler({
          store,
          principalRoles: options.principalRoles,
          viewerRoles: new Set(options.financeRoles ?? DEFAULT_FINANCE_ROLES),
          sections: agingSections,
          ...(options.clock !== undefined ? { clock: options.clock } : {}),
        }),
        "read",
      ),
    );
  }

  // WHT reconciliation report: withheld (invoice withholding_total) vs certified
  // (confirmed WhtCertificate amounts), when the manifest models both.
  if (agingNames.has("Invoice") && agingNames.has("WhtCertificate")) {
    routes.register(literalRoute("meta.whtReconciliation.read", "GET", ["v1", "meta", "wht-reconciliation"]));
    handlers.register(
      "meta.whtReconciliation.read",
      gate(
        buildWhtReconciliationHandler({
          store,
          principalRoles: options.principalRoles,
          viewerRoles: new Set(options.financeRoles ?? DEFAULT_FINANCE_ROLES),
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
  };
}

export interface OperateGatewayOptions extends OperateRuntimeOptions {
  readonly principalResolver?: PrincipalResolver;
  readonly opaqueTokenLookup?: OpaqueTokenLookup;
  readonly idempotencyStore?: IdempotencyStore;
  readonly rateLimitChecker?: RateLimitChecker;
  readonly clock?: { now(): Date };
  /** Production identity: a JWKS provider + expected issuer/audience for Bearer-JWT auth. */
  readonly jwksProvider?: JwksProvider;
  readonly jwtIssuer?: string;
  readonly jwtAudience?: string;
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
    ...(options.jwksProvider !== undefined ? { jwksProvider: options.jwksProvider } : {}),
    ...(options.jwtIssuer !== undefined ? { jwtIssuer: options.jwtIssuer } : {}),
    ...(options.jwtAudience !== undefined ? { jwtAudience: options.jwtAudience } : {}),
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
  });
  return { ...compiled, runtime };
}
