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
  type WriteEffect,
} from "./write-effects.js";
import type { SettingsStore } from "./settings.js";
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
  /** Runtime data invariants checked before each write (e.g. balanced journal postings). */
  readonly writeGuards?: readonly WriteGuard[];
  /** Side effects run after a successful write (e.g. auto-generating a reversal entry). */
  readonly writeEffects?: readonly WriteEffect[];
  readonly clock?: { now(): Date };
}

const DEFAULT_ADMIN_ROLES: readonly RoleName[] = ["erp_admin" as RoleName];

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
function defaultWriteEffects(manifest: Manifest, clock?: { now(): Date }): readonly WriteEffect[] {
  const names = new Set((manifest.entities ?? []).map((e) => e.name));
  const effects: WriteEffect[] = [];
  if (names.has("JournalEntry") && names.has("JournalLine")) {
    effects.push(journalReversalEffect(clock !== undefined ? { clock } : {}));
  }
  if (names.has("Invoice")) {
    effects.push(
      invoiceVoidCreditNoteEffect({
        ...(names.has("InvoiceLine") ? { lineEntity: "InvoiceLine" } : {}),
        ...(clock !== undefined ? { clock } : {}),
      }),
    );
    // AR↔GL bridge: post the matching GL entry when a credit note is issued.
    if (names.has("JournalEntry") && names.has("JournalLine")) {
      effects.push(creditNoteGlPostingEffect(clock !== undefined ? { clock } : {}));
    }
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
    writeEffects: options.writeEffects ?? defaultWriteEffects(manifest, options.clock),
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
