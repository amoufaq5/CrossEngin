import type { RoleDefinition, RoleName, SensitiveFieldPolicy } from "@crossengin/auth";
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
  type IdempotencyStore,
  type JwksProvider,
  type OpaqueTokenLookup,
  type PrincipalResolver,
  type PrincipalRoles,
  type RateLimitChecker,
} from "@crossengin/api-gateway-runtime";

import {
  buildAdminSettingsReadHandler,
  buildAdminSettingsUpdateHandler,
  type AdminContext,
} from "./admin-handlers.js";
import { buildSpecHandler, type HandlerContext } from "./handlers.js";
import { manifestRouteSpecs, routeFromSpec, type RouteSpec } from "./operations.js";
import { literalDefaultPlans, type LiteralDefaultPlan } from "./defaults.js";
import { sequenceFieldPlans, type SequenceAllocator, type SequenceFieldPlan } from "./sequences.js";
import { planHasSettingsDefaults, settingsDefaultPlan, type SettingsDefaultPlan } from "./settings-defaults.js";
import {
  journalPostingGuard,
  lockedDocumentGuard,
  postedEntryImmutabilityGuard,
  type WriteGuard,
} from "./write-guards.js";
import {
  creditNoteGlPostingEffect,
  invoiceVoidCreditNoteEffect,
  journalReversalEffect,
  paymentApplicationEffect,
  paymentSettlementGlPostingEffect,
  recognitionGlPostingEffect,
  unrealizedFxRevaluationEffect,
  type WriteEffect,
} from "./write-effects.js";
import { buildAgingHandler, type AgingSpec } from "./aging-handler.js";
import type { SettingsStore, TenantSettings } from "./settings.js";
import { entityReadOperationIds } from "./slugs.js";
import type { EntityStore } from "./store.js";
import { buildUiSchema, buildUiSchemaHandler } from "./ui-schema.js";

export interface OperateRuntimeOptions {
  readonly store: EntityStore;
  /** Bridges the gateway's scope-bearing principal to its effective roles. */
  readonly principalRoles: (principal: ResolvedPrincipal | null) => PrincipalRoles;
  readonly policyForEntity?: (entity: string) => SensitiveFieldPolicy | undefined;
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
  readonly clock?: { now(): Date };
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
        ...clockOpt,
        ...codeResolver((f) => ({
          ...(f.apAccountCode !== undefined ? { control: f.apAccountCode } : {}),
          ...(f.expenseAccountCode !== undefined ? { net: f.expenseAccountCode } : {}),
          ...(f.taxInputAccountCode !== undefined ? { tax: f.taxInputAccountCode } : {}),
        })),
      }),
    );
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

export interface CompiledOperateServer {
  readonly routes: InMemoryRouteRegistry;
  readonly handlers: HandlerRegistry;
  readonly redactionRegistry: MapRedactionRegistry;
  readonly routeSpecs: readonly RouteSpec[];
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
  const ctx: HandlerContext = {
    store: options.store,
    permissions: manifest.permissions ?? {},
    roles,
    principalRoles: options.principalRoles,
    sequencePlans: buildSequencePlans(manifest),
    defaultPlans: buildDefaultPlans(manifest),
    settingsDefaultPlans: buildSettingsDefaultPlans(manifest),
    writeGuards: options.writeGuards ?? defaultWriteGuards(manifest),
    writeEffects: options.writeEffects ?? defaultWriteEffects(manifest, options.clock, options.settingsStore),
    ...(options.allocator !== undefined ? { allocator: options.allocator } : {}),
    ...(options.settingsStore !== undefined ? { settingsStore: options.settingsStore } : {}),
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
  };

  const routeSpecs = manifestRouteSpecs(manifest);
  for (const spec of routeSpecs) {
    routes.register(routeFromSpec(spec));
    handlers.register(spec.operationId, buildSpecHandler(spec, ctx));
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
      buildAgingHandler({
        store: options.store,
        principalRoles: options.principalRoles,
        viewerRoles: new Set(options.financeRoles ?? DEFAULT_FINANCE_ROLES),
        sections: agingSections,
        ...(options.clock !== undefined ? { clock: options.clock } : {}),
      }),
    );
  }

  const redactionRegistry = redactionRegistryFromManifest(manifest, {
    rolesForPrincipal: options.principalRoles,
    operationsForEntity: (name) => [...entityReadOperationIds(name)],
    ...(options.policyForEntity !== undefined ? { policyForEntity: options.policyForEntity } : {}),
  });

  return { routes, handlers, redactionRegistry, routeSpecs };
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
