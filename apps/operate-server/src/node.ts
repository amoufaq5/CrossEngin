import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";

import type { PipelineExecution } from "@crossengin/api-gateway";
import { StripeClient } from "@crossengin/billing-stripe";
import { createNodePgConnection, parsePgEnvConfig } from "@crossengin/kernel-pg";
import type { Manifest } from "@crossengin/kernel/manifest";
import {
  InMemoryEntityStore,
  InMemorySequenceAllocator,
  InMemorySettingsStore,
  LicenseEntitlementResolver,
  buildPlanCatalog,
  entityEventEffect,
  type WriteEffect,
  type BillingPortalWiring,
  type EntitlementResolver,
  type PlanLimitsLookup,
  type EntityStore,
  type SequenceAllocator,
  type SettingsStore,
} from "@crossengin/operate-runtime";
import { type PgConnection } from "@crossengin/kernel-pg";
import {
  ColumnMappedEntityStore,
  PostgresEntitlementResolver,
  PostgresEntityStore,
  PostgresSequenceAllocator,
  PostgresSettingsStore,
  PostgresSubscriptionStore,
  TenantColumnStoreRegistry,
  TenantColumnStoreRouter,
  eraseTenantSchema,
  eraseTenantSchemaWithin,
  ingestStripeWebhook,
  surveyTenantSchemaWithCollateral,
} from "@crossengin/operate-runtime-pg";

import type { PruneOptions, ServeOptions, VerifyChainOptions } from "./cli.js";
import type { RawHttpRequest, RawHttpResponse } from "./http.js";
import {
  DEFAULT_MAX_REQUEST_BODY_BYTES,
  routeBodyLimitFor,
  type RouteBodyLimit,
  RequestBodyTooLargeError,
  readLimitedBody,
  resolveMaxRequestBodyBytes,
} from "./request-body-limit.js";
import { loadBuiltinPack, loadManifestFromJson } from "./manifest-source.js";
import {
  isDanglingLinkPruner,
  relationPairsFromManifest,
  sweepDanglingLinksForTenants,
  type MultiTenantSweepReport,
} from "./link-sweep.js";
import { PruneScheduler } from "./prune-scheduler.js";
import { DeliveryScheduler } from "./delivery-scheduler.js";
import { PostgresDeliveryStore } from "./delivery-store.js";
import { PostgresRecipientResolver } from "./recipient-resolver.js";
import { buildSenderRegistryFromEnv } from "./delivery-senders-env.js";
import { buildBounceSecretResolverFromEnv } from "./bounce-webhook-env.js";
import {
  BOUNCE_WEBHOOK_PATH_PREFIX,
  buildBounceWebhookInterceptor,
} from "./bounce-webhook-routes.js";
import { BOUNCE_WEBHOOK_SOURCES } from "@crossengin/notification-providers";
import { PostgresSuppressionStore } from "./suppression-store.js";
import { PostgresDigestStore } from "./digest-store.js";
import { PostgresTemplateStore } from "./template-store.js";
import { PostgresAuditEmitter, auditActor, auditEntry } from "./audit-log-store.js";
import {
  TENANT_SCOPE_DENIED_OPERATION,
  TENANT_SCOPE_GRANTED_OPERATION,
} from "./notification-routes.js";
import { randomUUID } from "node:crypto";
import { renderDigest } from "./digest-template.js";
import { memberFromItem } from "./digest-assembler.js";
import { DIGEST_TEMPLATE_ID, digestLocale } from "./digest-assembly.js";
import { parseNotificationPolicy, type NotificationPolicy } from "./delivery-throttle.js";
import { JwksRefreshPoller, RemoteJwksProvider } from "./jwks.js";
import {
  buildJwksProvider,
  buildPrincipalWiring,
  parseApiKeySpec,
  parseJwksKeySpec,
  type JwksKeySpec,
  type JwtVerifyConfig,
} from "./principals.js";
import {
  PersistentMarketplaceInstallEngine,
  PostgresInstallationStore,
  PostgresPackVersionStore,
  buildPersistentPackSubmissionEngine,
} from "@crossengin/marketplace-runtime-pg";
import { requestJobCancellation } from "@crossengin/workflow-runtime-pg";
import {
  DeletionReconciler,
  DeletionRunner,
  PostgresDeletionRequestStore,
  PostgresTombstoneStore,
  deleteTenantAtomically,
} from "@crossengin/tenant-lifecycle-pg";
import {
  DeletionCapabilitiesSchema,
  type DeletionCapabilities,
} from "@crossengin/tenant-lifecycle";
import type { ExtraGatewayRoute } from "@crossengin/operate-runtime";
import { buildMarketplaceAdminRoutes, loadPackCatalog } from "./marketplace-admin.js";
import { buildMarketplaceAuthoringRoutes } from "./marketplace-authoring.js";
import { PostgresTenantStore, buildPlatformAdminRoutes } from "./platform-admin.js";
import { PostgresTenantManifestStore, manifestSummary } from "./tenant-manifests.js";
import { buildDesignDesigner, buildDesignProviderFromEnv } from "./ai-design.js";
import { buildAiDesignRoutes } from "./ai-design-routes.js";
import { TenantGatewayCache, buildPerTenantDispatch } from "./tenant-gateway-cache.js";
import {
  ManifestActivationPoller,
  PostgresActivationWatermarkSource,
} from "./manifest-activation-poller.js";
import { DEFAULT_AI_DESIGN_MAX_USD_PER_MONTH, buildAiDesignBudget } from "./ai-design-budget.js";
import { PostgresDesignJobStore } from "./design-jobs.js";
import { PostgresDesignReviewStore } from "./design-review-store.js";
import { buildDesignReviewRoutes } from "./design-review-routes.js";
import { buildIntegrityVerdictRoutes } from "./integrity-verdict-routes.js";
import { buildJobCancelRoutes } from "./job-cancel-routes.js";
import { buildTenantErasureRoutes } from "./tenant-erasure-routes.js";
import {
  TENANT_DELETED_OPERATION,
  buildTenantDeletionRoutes,
  newTombstoneId,
} from "./tenant-deletion-routes.js";
import { buildDeletionRequestRoutes, newRequestId } from "./deletion-request-routes.js";
import { DeletionEscalationConfigSchema } from "./deletion-escalation-config.js";
import { DeletionEvidenceEscalator } from "./deletion-evidence-escalation.js";
import { buildPageDispatcher, buildPageSendersFromEnv } from "./page-senders-env.js";
import { PageRecorder, formatPageRecord } from "./page-record.js";
import { formatPageReport, type PageDeliveryReport } from "@crossengin/notification-providers";
import type { PageDirective } from "@crossengin/observability-runtime";
import {
  DEFAULT_DELETION_APPROVED_BY,
  DEFAULT_DELETION_EXECUTED_BY,
  DeletionScheduler,
  type TombstoneSweepPage,
  type TombstoneSweepProgress,
} from "./deletion-scheduler.js";
import { buildAuditReadRoutes, entityFieldLookupFrom } from "./audit-read-routes.js";
import { PostgresAuditReadStore } from "./audit-read-store.js";
import { buildNotificationTemplateRoutes } from "./notification-template-routes.js";
import { PostgresNotificationTemplateStore } from "./notification-template-store.js";
import { PostgresIntegrityVerdictStore } from "./integrity-verdict-store.js";
import { assessManifestRisk } from "./design-review.js";
import { projectManifestView } from "./manifest-view.js";
import { diffManifests } from "./manifest-diff.js";
import { enrolNewProposalsForReview } from "./review-enrolment.js";
import { buildDesignDecisionDispatch } from "./design-notifications.js";
import { PostgresNotificationStore } from "./notification-store.js";
import { buildNotificationRoutes } from "./notification-routes.js";
import { startDesignJob } from "./design-runner.js";
import {
  PostgresEstimateInflationStore,
  PostgresTenantCostStore,
} from "@crossengin/ai-architect-runtime-pg";
import { loadResidencyDirectory } from "./residency-source.js";
import type { Region } from "@crossengin/residency";
import type { TenantResidencyDirectory } from "@crossengin/residency-runtime";
import { PostgresTenantResidencyDirectory } from "@crossengin/residency-runtime-pg";
import { OperateHttpServer, buildOperateHttpServer, type WebhookRoute } from "./server.js";
import { JobScheduler, PostgresTenantSource, StaticTenantSource, type TenantSource } from "./scheduler.js";
import { PostgresEntityEventSink } from "./entity-events.js";
import { buildSloEnforcement, loadSloConfig } from "./slo-config.js";
import {
  deriveSloConfig,
  loadSloDefaultsOverride,
  sloDefaultsOptionsFromOverride,
} from "./slo-defaults.js";
import {
  buildDrReadinessLifecycle,
  loadDrReadinessConfig,
  type DrReadinessLifecycle,
} from "./dr-readiness.js";
import {
  buildAccessReviewsLifecycle,
  loadAccessReviewsConfig,
  type AccessReviewsLifecycle,
} from "./access-reviews-lifecycle.js";
import { AuthLiveGrantSource, apiKeyPrincipalProvider } from "./live-grants.js";
import {
  buildCertificationLifecycle,
  loadCertificationConfig,
  type CertificationLifecycle,
} from "./certification.js";
import {
  IntegrityEscalator,
  formatIntegrityEscalation,
} from "./integrity-escalation.js";
import {
  buildIntegrityProofLifecycle,
  loadIntegrityProofConfig,
  formatIntegrityProof,
  type IntegrityProofLifecycle,
} from "./integrity-proof.js";
import {
  auditChainStore,
  buildAuditChain,
  ed25519ChainSigner,
  loadAuditChainConfig,
  type AuditChain,
  type AuditChainConfig,
} from "./audit-chain.js";
import { registerAuditChainKey } from "./audit-chain-key-registration.js";
import {
  buildCheckpointLifecycle,
  loadCheckpointConfig,
  tenantSourceScopes,
  type CheckpointLifecycle,
} from "./checkpoint-scheduler.js";
import { PostgresKeyRegistry } from "@crossengin/crypto-pg";
import { PostgresChainCheckpointStore, PostgresChainLogReader } from "@crossengin/forensics-pg";
import {
  PostgresIncidentDeclarer,
  PostgresIncidentStore,
} from "@crossengin/incident-response-runtime-pg";
import {
  buildTenantAuditPolicyCache,
  type TenantAuditPolicyLifecycle,
} from "./audit-sampling-policy-source.js";
import {
  verifyChainFromCheckpoint,
  verifyChainFull,
  type ChainVerificationReport,
} from "./chain-verify.js";
import { buildRequestMetering, loadMeteringConfig, type RequestMetering } from "./metering.js";
import {
  buildStripeUsageSync,
  loadStripeUsageSyncConfig,
  type StripeUsageSync,
} from "./stripe-usage-sync.js";
import { PostgresJobInvoker, buildActionRoleMap, mergeActionRoleMaps } from "./job-invoke.js";
import { invokeRolesByAction } from "@crossengin/jobs";

function firstHeader(v: string | readonly string[] | undefined): string | undefined {
  return v === undefined ? undefined : Array.isArray(v) ? v[0] : (v as string);
}

function jsonRaw(status: number, body: unknown): RawHttpResponse {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return { status, headers: { "content-type": "application/json", "content-length": bytes.byteLength.toString() }, body: bytes };
}

/** The slice of Node's `IncomingMessage` the adapter reads. */
export interface NodeReqLike extends AsyncIterable<Uint8Array> {
  readonly method?: string | undefined;
  readonly url?: string | undefined;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly socket?: { readonly remoteAddress?: string | undefined } | undefined;
}

/** The slice of Node's `ServerResponse` the adapter writes. */
export interface NodeResLike {
  writeHead(status: number, headers?: Record<string, string>): void;
  end(chunk?: Uint8Array): void;
}

/**
 * Kept as a re-export, not a second definition: this was the only cap for the whole of P1.7 and
 * callers import it. It is now the *default*, and the enforcement lives in `request-body-limit.ts`
 * so the Node listener and the Fetch adapter cannot drift apart on what the cap is or when it fires.
 */
export const MAX_REQUEST_BODY_BYTES = DEFAULT_MAX_REQUEST_BODY_BYTES;

/**
 * Who a page's timeline note is attributed to (ADR-0327).
 *
 * `TimelineEntry.actorUserId` is a non-empty string, not a uuid, and the deployment is the honest
 * answer: no human chose to page, a scheduler did. The same name the escalation configs default
 * `declaredBy` to, so the declaration and the page it caused read as one actor on the timeline.
 */
export const PAGE_NOTE_ACTOR = "operate-server";

/** The dispatch surface the Node listener needs — an `OperateHttpServer` or a per-tenant wrapper. */
/**
 * Whether this deployment can write audit rows at all — which is exactly "does it have a database",
 * and deliberately **not** a list of features any more (ADR-0327).
 *
 * `needsAuditEmitter` used to answer this by enumerating every flag whose feature writes an audit
 * row, and the list was forgotten three times. ADR-0288: gating the emitter on `--ai-design` meant a
 * deployment running only `--integrity-proof-config` reported `audited=false` for every escalation,
 * and the row that ADR relies on was never written. Then `--audit-read-routes`, whose recorder is
 * *required*, was added without being added to the list, so the surface refused to mount and a
 * deployment that asked for it silently got nothing — found by booting the real server, not by a
 * test. The list grew a test per flag after that, and the third miss still got through it:
 * `--deletion-escalation-config` was listed in the test and **absent from the predicate**, and the
 * test passed anyway because the argument parser happens to turn `--deletion-request-routes` on
 * alongside it. A per-flag test over a hand-maintained list cannot catch a flag missing from both.
 *
 * So the list is gone. Constructing a `PostgresAuditEmitter` is an object allocation — no
 * connection, no scheduler, no DDL — so gating it never bought anything and cost three defects. The
 * emitter now exists whenever a connection does, which is the only condition that was ever real, and
 * a feature added tomorrow cannot omit itself from a list that no longer exists.
 */
export function auditEmitterAvailable(options: { readonly store: string }): boolean {
  return options.store === "pg";
}

export interface DispatchTarget {
  dispatch(raw: RawHttpRequest, body: Uint8Array | null): Promise<RawHttpResponse>;
}

/**
 * Builds a Node `http` request listener over an `OperateHttpServer`: collects
 * the body, dispatches through the gateway, and writes the `RawHttpResponse`. A
 * dispatch throw becomes a 500 problem document rather than a hung socket.
 */
export function createNodeRequestListener(
  server: DispatchTarget,
  maxRequestBodyBytes?: number | null,
  /**
   * Per-route overrides (ADR-0331), chosen by longest matching path prefix.
   *
   * The URL is the *only* thing available before the body is read, which is what bounds this: a
   * **per-tenant** limit is not expressible here and is deliberately not attempted. The tenant
   * comes from the credential, and resolving one means verifying a JWT — which is a pipeline stage
   * inside the gateway, after the body. Doing it here would put a second verification path in
   * front of the first, to pick a buffer size.
   */
  routeBodyLimits: readonly RouteBodyLimit[] = [],
): (req: NodeReqLike, res: NodeResLike) => Promise<void> {
  // Resolved once, at build time, rather than per request: an out-of-band limit must fail the boot,
  // not every request after it. Each override is range-checked the same way, for the same reason.
  const limit = resolveMaxRequestBodyBytes(maxRequestBodyBytes);
  const overrides = routeBodyLimits.map((o) => ({
    prefix: o.prefix,
    bytes: resolveMaxRequestBodyBytes(o.bytes),
  }));
  return async (req, res) => {
    try {
      const body = await readLimitedBody(req, routeBodyLimitFor(req.url ?? "/", overrides, limit));
      const raw: RawHttpRequest = {
        method: req.method ?? "GET",
        url: req.url ?? "/",
        headers: req.headers,
        remoteAddress: req.socket?.remoteAddress ?? null,
      };
      const response = await server.dispatch(raw, body);
      res.writeHead(response.status, response.headers);
      res.end(response.body ?? undefined);
    } catch (err) {
      if (err instanceof RequestBodyTooLargeError) {
        const payload = new TextEncoder().encode(
          JSON.stringify({
            type: "https://crossengin.io/problems/payload-too-large",
            title: "Payload too large",
            status: 413,
            detail: err.message,
            extensions: {},
          }),
        );
        res.writeHead(413, {
          "content-type": "application/problem+json",
          "content-length": payload.byteLength.toString(),
        });
        res.end(payload);
        return;
      }
      const detail = err instanceof Error ? err.message : "unknown error";
      const payload = new TextEncoder().encode(
        JSON.stringify({
          type: "https://crossengin.io/problems/internal-error",
          title: "Internal server error",
          status: 500,
          detail,
          extensions: {},
        }),
      );
      res.writeHead(500, {
        "content-type": "application/problem+json",
        "content-length": payload.byteLength.toString(),
      });
      res.end(payload);
    }
  };
}

async function resolveJwtConfig(
  options: ServeOptions,
): Promise<{ config: JwtVerifyConfig | null; poller: JwksRefreshPoller | null }> {
  const specs: JwksKeySpec[] = options.jwksKeys.map(parseJwksKeySpec);
  if (options.jwksFile !== null) {
    const parsed = JSON.parse(await readFile(options.jwksFile, "utf8")) as unknown;
    if (!Array.isArray(parsed)) throw new Error(`--jwks-file must be a JSON array of {kid, publicKeyBase64}`);
    for (const k of parsed as JwksKeySpec[]) {
      if (typeof k.kid !== "string" || typeof k.publicKeyBase64 !== "string") {
        throw new Error(`--jwks-file entries must be {kid, publicKeyBase64}`);
      }
      specs.push({ kid: k.kid, publicKeyBase64: k.publicKeyBase64 });
    }
  }
  if (specs.length === 0 && options.jwksUrl === null) return { config: null, poller: null };
  if (options.jwtIssuer === null || options.jwtAudience === null) {
    throw new Error("--jwt-issuer and --jwt-audience are required when a JWKS is configured");
  }
  let poller: JwksRefreshPoller | null = null;
  let jwksProvider;
  if (options.jwksUrl !== null) {
    const remote = new RemoteJwksProvider({ url: options.jwksUrl });
    jwksProvider = remote;
    if (options.jwksRefreshMs !== null) {
      poller = new JwksRefreshPoller({ provider: remote, intervalMs: options.jwksRefreshMs });
    }
  } else {
    jwksProvider = buildJwksProvider(specs);
  }
  return { config: { jwksProvider, issuer: options.jwtIssuer, audience: options.jwtAudience }, poller };
}

interface ResolvedStores {
  readonly store: EntityStore;
  readonly allocator: SequenceAllocator;
  readonly settingsStore: SettingsStore;
  /** The Postgres connection (present only for pg stores), reused for billing wiring. */
  readonly conn?: PgConnection;
}

async function resolveStore(options: ServeOptions, manifest: Manifest): Promise<ResolvedStores> {
  if (options.store === "memory") {
    return {
      store: new InMemoryEntityStore(),
      allocator: new InMemorySequenceAllocator(),
      settingsStore: new InMemorySettingsStore(),
    };
  }
  const conn = createNodePgConnection(parsePgEnvConfig());
  const schema = options.schema ?? undefined;
  const allocator = new PostgresSequenceAllocator(conn, schema);
  const settingsStore = new PostgresSettingsStore(conn, schema);
  if (options.store === "pg-columns") {
    const store = new ColumnMappedEntityStore(conn, manifest, options.schema !== null ? { schema: options.schema } : {});
    await store.ensureSchema();
    return { store, allocator, settingsStore, conn };
  }
  const store = new PostgresEntityStore(conn, options.schema !== null ? { schema: options.schema } : {});
  return { store, allocator, settingsStore, conn };
}

export interface RunningServer {
  readonly port: number;
  readonly server: Server;
  close(): Promise<void>;
}

/**
 * Boots the full server from `ServeOptions`: loads + resolves the manifest
 * (pack or file), builds the entity store (in-memory or Postgres), wires the
 * API keys, and starts listening. Returns a handle for graceful shutdown.
 */
export async function serve(options: ServeOptions): Promise<RunningServer> {
  const manifest =
    options.manifestPath !== null
      ? loadManifestFromJson(await readFile(options.manifestPath, "utf8"))
      : await loadBuiltinPack(options.pack ?? "");
  const { store, allocator, settingsStore, conn } = await resolveStore(options, manifest);
  const apiKeys = options.apiKeys.map(parseApiKeySpec);
  const { config: jwt, poller } = await resolveJwtConfig(options);
  const schemaOpt = options.schema !== null ? { schema: options.schema } : {};
  // Offline subscription entitlement: verify an Ed25519 license token against the
  // licensor's public key at boot (no cloud billing call). A lapsed/expired license
  // means the gate denies (past_due keeps read access).
  let entitlementResolver: EntitlementResolver | undefined =
    options.licenseFile !== null && options.licenseKey !== null
      ? new LicenseEntitlementResolver((await readFile(options.licenseFile, "utf8")).trim(), options.licenseKey)
      : undefined;
  // Cloud billing: a Stripe webhook writes subscription snapshots to billing_subscriptions
  // and (unless a license already gates) the gate reads them via a Postgres resolver — so a
  // Stripe subscription change flows straight into enforcement. Signature-authenticated, so
  // the route runs ahead of the gateway's API-key/JWT pipeline.
  // One subscription store backs both the webhook (writes snapshots) and the billing portal
  // (reads the tenant's Stripe customer id), when either is configured over a pg connection.
  const subscriptionStore =
    conn !== undefined && (options.stripeWebhookSecret !== null || options.stripeApiKey !== null)
      ? new PostgresSubscriptionStore(conn, schemaOpt)
      : undefined;
  let webhookRoute: WebhookRoute | undefined;
  if (options.stripeWebhookSecret !== null && conn !== undefined && subscriptionStore !== undefined) {
    const secret = options.stripeWebhookSecret;
    if (entitlementResolver === undefined) entitlementResolver = new PostgresEntitlementResolver(conn, schemaOpt);
    // Optional declarative plan catalog: a webhook event resolves its record cap + features from
    // the catalog (by plan or Stripe price id), falling back to the subscription's own metadata.
    let planLimits: PlanLimitsLookup | undefined;
    if (options.planCatalogFile !== null) {
      planLimits = buildPlanCatalog(JSON.parse(await readFile(options.planCatalogFile, "utf8"))).toLookup();
    }
    webhookRoute = {
      method: "POST",
      path: "/v1/webhooks/stripe",
      handle: async (body, headers) => {
        const payload = new TextDecoder().decode(body ?? new Uint8Array());
        const signatureHeader = firstHeader(headers["stripe-signature"]) ?? "";
        const result = await ingestStripeWebhook({
          payload,
          signatureHeader,
          secret,
          store: subscriptionStore,
          ...(planLimits !== undefined ? { planLimits } : {}),
        });
        return result.ok
          ? jsonRaw(200, { received: true, applied: result.applied })
          : jsonRaw(400, { error: "invalid_signature", reason: result.reason });
      },
    };
  }
  // Stripe Billing Portal: POST /v1/meta/billing-portal mints a hosted session so a tenant can
  // manage/fix their subscription. The subscription store resolves the tenant's Stripe customer
  // id; the Stripe client (with the secret key) creates the session. Both structural.
  let billingPortal: BillingPortalWiring | undefined;
  if (options.stripeApiKey !== null && options.billingPortalReturnUrl !== null && subscriptionStore !== undefined) {
    billingPortal = {
      customers: subscriptionStore,
      portal: new StripeClient({ apiKey: options.stripeApiKey }),
      returnUrl: options.billingPortalReturnUrl,
    };
  }
  // Entity-event emission: turn each served write into a domain event that fires event-triggered
  // (and delayed) jobs into job_runs. Best-effort (a failed enqueue never fails the write), appended
  // after the manifest's default financial effects. Enabled by --emit-entity-events over a pg store.
  const additionalWriteEffects: WriteEffect[] = [];
  if (options.emitEntityEvents && conn !== undefined) {
    const sink = new PostgresEntityEventSink(conn, Object.values(manifest.jobs ?? {}), schemaOpt);
    additionalWriteEffects.push(
      entityEventEffect({ sink, ...(options.eventPrefix !== null ? { eventPrefix: options.eventPrefix } : {}) }),
    );
  }
  // On-demand job invocation: POST /v1/meta/jobs/invoke enqueues the caller tenant's userInvoked
  // jobs. Enabled by --enable-job-invoke over a pg store (needs the conn + the manifest's jobs).
  const jobInvoker =
    options.enableJobInvoke && conn !== undefined
      ? new PostgresJobInvoker(conn, Object.values(manifest.jobs ?? {}), schemaOpt)
      : undefined;
  // Per-action invoke roles: the manifest's declared invokeRoles are the baseline; the operator's
  // --job-invoke-action-role overrides win per action.
  const invokeActionRoles =
    jobInvoker !== undefined
      ? mergeActionRoleMaps(
          invokeRolesByAction(Object.values(manifest.jobs ?? {})),
          buildActionRoleMap(options.jobInvokeActionRoles),
        )
      : new Map<string, ReadonlySet<string>>();
  // Marketplace admin: the /v1/admin/packs routes install/list/uninstall catalog packs per tenant via
  // the persistent install engine. Enabled by --pack-catalog over a pg store (needs the conn for the
  // installation store). The tenant context is a deployment default; per-tenant plan/region is a follow-up.
  const extraRouteList: ExtraGatewayRoute[] = [];
  if (options.packCatalogFile !== null && conn !== undefined) {
    extraRouteList.push(
      ...buildMarketplaceAdminRoutes({
        engine: new PersistentMarketplaceInstallEngine(new PostgresInstallationStore(conn, schemaOpt)),
        store: new PostgresInstallationStore(conn, schemaOpt),
        catalog: loadPackCatalog(await readFile(options.packCatalogFile, "utf8")),
        principalRoles: buildPrincipalWiring(apiKeys).principalRoles,
        adminRoles: new Set(["erp_admin"]),
        tenantContext: {
          platformVersion: "1.0.0",
          region: "us-east",
          planTier: "professional",
          compliancePacks: [],
          isDedicatedTenant: false,
        },
      }),
    );
  }
  // Third-party authoring: the /v1/authoring/packs routes let an author submit a signed pack version and
  // a reviewer take it through security review → publish, persisting to meta.pack_versions. Enabled by
  // --marketplace-authoring over a pg store.
  if (options.marketplaceAuthoring && conn !== undefined) {
    extraRouteList.push(
      ...buildMarketplaceAuthoringRoutes({
        engine: buildPersistentPackSubmissionEngine(conn),
        store: new PostgresPackVersionStore(conn),
        principalRoles: buildPrincipalWiring(apiKeys).principalRoles,
        authorRoles: new Set(["pack_author"]),
        reviewerRoles: new Set(["marketplace_reviewer"]),
      }),
    );
  }
  // Platform super-admin: the /v1/platform routes manage the meta.tenants registry (list/create/suspend/
  // archive/reactivate + stats) across all tenants, gated to the configured platform-admin role(s). Enabled
  // by --platform-admin over a pg store.
  if (options.platformAdmin && conn !== undefined) {
    extraRouteList.push(
      ...buildPlatformAdminRoutes({
        store: new PostgresTenantStore(conn),
        principalRoles: buildPrincipalWiring(apiKeys).principalRoles,
        adminRoles: new Set(options.platformAdminRoles),
      }),
    );
  }
  // The proposal store backs both the AI routes and the review queue's activation diff, so it is
  // built before either. A review-only deployment still needs it to resolve a tenant's live manifest.
  let manifestStore: PostgresTenantManifestStore | null = null;
  let gatewayCache: TenantGatewayCache | null = null;
  let manifestPoller: ManifestActivationPoller | null = null;
  let tenantStoreRegistry: TenantColumnStoreRegistry | null = null;
  let notificationStore: PostgresNotificationStore | null = null;
  let digestReadStore: PostgresDigestStore | null = null;
  let templateStore: PostgresTemplateStore | null = null;
  let recipientResolver: PostgresRecipientResolver | null = null;
  let auditEmitter: PostgresAuditEmitter | null = null;
  // The audit chain's producer is built here, ahead of its per-request observer, because the
  // audit-log emitter anchors into the SAME chain and needs it at wiring time. Both paths
  // appending to one chain per tenant is the point: a single tamper-evident trail, not two.
  let auditConfig: AuditChainConfig | null = null;
  let auditChainProducer: ReturnType<typeof auditChainStore> | null = null;
  if (options.auditChainConfig !== null && conn !== undefined) {
    auditConfig = await loadAuditChainConfig(options.auditChainConfig);
    auditChainProducer = auditChainStore(conn, auditConfig);
  }
  // Built for every Postgres deployment, gated on nothing else (ADR-0327 — see
  // `auditEmitterAvailable` for the three defects the old flag list caused).
  if (conn !== undefined) {
    auditEmitter = new PostgresAuditEmitter(conn, {
      ...schemaOpt,
      // No chain configured ⇒ rows are written unanchored. Verification reports them as
      // unproven rather than pretending they are intact (ADR-0286).
      ...(auditChainProducer !== null ? { chain: auditChainProducer } : {}),
    });
  }
  /**
   * The emitter, for a surface that has already established it has a connection.
   *
   * Non-null for every Postgres deployment now that nothing gates it, but that is an invariant of
   * this function rather than something the type system can see across the `conn === undefined`
   * branch above. Named once so the surfaces below do not each carry a null-check that cannot fire
   * — which is what the old flag list turned into four pieces of dead code with three misleading
   * messages. The throw is a boot-time programming error, not a runtime condition.
   */
  const requireEmitter = (surface: string): PostgresAuditEmitter => {
    if (auditEmitter === null) {
      throw new Error(
        `${surface} asked for the audit emitter, which every Postgres deployment has; this is a wiring bug`,
      );
    }
    return auditEmitter;
  };
  /**
   * What this deployment holds, declared once (ADR-0328).
   *
   * Loaded here rather than defaulted, and **required** by every path that signs a tombstone: the
   * field it replaced was read from the request body with `[]` as its default, so a remote caller
   * chose how much of the deployment the Article 17 proof covered. Every possible default is wrong —
   * `absent` signs a proof that is silent about a place the tenant's data may still be, which is the
   * defect ADR-0317 exists for, and `erases` refuses every deletion until the operator declares.
   * Refusing to mount is the loud failure, and the loud failure is the right one for a proof.
   */
  let deletionCapabilities: DeletionCapabilities | null = null;
  if (options.deletionCapabilities !== null) {
    deletionCapabilities = DeletionCapabilitiesSchema.parse(
      JSON.parse(await readFile(options.deletionCapabilities, "utf8")) as unknown,
    );
  }
  if ((options.aiDesign || options.perTenantManifests || options.designReview) && conn !== undefined) {
    manifestStore = new PostgresTenantManifestStore(conn, schemaOpt);
    notificationStore = new PostgresNotificationStore(conn, schemaOpt);
    digestReadStore = new PostgresDigestStore(conn, schemaOpt);
    templateStore = new PostgresTemplateStore(conn, schemaOpt);
    recipientResolver = new PostgresRecipientResolver(conn, {
      ...schemaOpt,
      adminRoles: options.notificationAdminRoles,
    });
  }
  // Platform design-review queue: /v1/platform/design-reviews lets an operator triage AI-generated
  // proposals across every tenant (with an automated risk report) before they can go live. The
  // cross-tenant reads run under the explicit, transaction-scoped `app.platform_review` grant.
  let reviewStore: PostgresDesignReviewStore | null = null;
  // The readable projection of each audit-integrity pass (ADR-0287). The chain commitment stays the
  // proof; this makes the verdict queryable, which it was not. Two grants, both fail-closed: no
  // configured role means nobody reads anything, and a tenant role never reaches the platform
  // chain's own verdicts — which `meta.audit_integrity_verdicts`' policy enforces independently of
  // this wiring, verified live against a non-owner role.
  if (options.integrityVerdictRoutes) {
    if (conn === undefined) {
      console.warn(
        "[audit] --audit-verdict-routes requires a Postgres store (--store pg); skipping",
      );
    } else {
      if (
        options.integrityVerdictPlatformRoles.length === 0 &&
        options.integrityVerdictTenantRoles.length === 0
      ) {
        console.warn(
          "[audit] --audit-verdict-routes is on with no --audit-verdict-platform-role or " +
            "--audit-verdict-tenant-role: every request will be refused",
        );
      }
      extraRouteList.push(
        ...buildIntegrityVerdictRoutes({
          source: new PostgresIntegrityVerdictStore(conn, schemaOpt),
          principalRoles: buildPrincipalWiring(apiKeys).principalRoles,
          platformRoles: new Set(options.integrityVerdictPlatformRoles),
          tenantRoles: new Set(options.integrityVerdictTenantRoles),
        }),
      );
    }
  }

  // Cancelling a run over HTTP (ADR-0269 left cancellation client-side only). Gated on the same
  // roles as invoking one: being able to start a job and being able to stop it are the same
  // privilege over the same queue, and splitting them would let somebody start work nobody can stop.
  if (jobInvoker !== undefined && conn !== undefined) {
    const cancelConn = conn;
    extraRouteList.push(
      ...buildJobCancelRoutes({
        canceller: {
          requestCancellation: async (request) =>
            requestJobCancellation(cancelConn, {
              runId: request.runId,
              tenantId: request.tenantId,
              requestedBy: request.requestedBy,
              ...(request.reason !== undefined ? { reason: request.reason } : {}),
              now: new Date().toISOString(),
              ...schemaOpt,
            }),
        },
        principalRoles: buildPrincipalWiring(apiKeys).principalRoles,
        allowedRoles: new Set(options.jobInvokeRoles),
        onDecided: (result, tenantId) =>
          console.info(
            `[jobs] tenant ${tenantId} run ${result.runId} cancel → ${result.outcome}` +
              ` (status ${result.status ?? "unknown"})`,
          ),
      }),
    );
  }
  // Template authoring over HTTP (ADR-0277/0279 left it CLI-only). Three grants, each fail-closed,
  // because the three privileges are genuinely different: drafting, approving someone else's draft
  // (four-eyes, enforced in the route), and authoring in a category that overrides a recipient's
  // preferences and suppressions — which is how an opted-out address gets mailed anyway.
  if (options.notificationTemplateRoutes) {
    if (conn === undefined) {
      console.warn(
        "[notifications] --notification-template-routes requires a Postgres store (--store pg); skipping",
      );
    } else {
      extraRouteList.push(
        ...buildNotificationTemplateRoutes({
          store: new PostgresNotificationTemplateStore(conn, schemaOpt),
          principalRoles: buildPrincipalWiring(apiKeys).principalRoles,
          authorRoles: new Set(options.notificationTemplateAuthorRoles),
          approverRoles: new Set(options.notificationTemplateApproverRoles),
          nonSuppressibleCategoryRoles: new Set(options.notificationTemplateUnconditionalRoles),
        }),
      );
    }
  }
  // The read side of the audit trail (ADR-0277/0279: nothing read it over HTTP). Payload redaction
  // is classification-driven from the served manifest, and the reads are themselves audited — an
  // unrecordable privileged read is refused, not served unaudited.
  // Erasing a tenant's own schema, which is what makes a tenant deletion true (ADR-0316). Mounted
  // here rather than beside the other platform-admin routes because its recorder is required and the
  // audit emitter does not exist yet up there — destroying a tenant's data unrecorded leaves the
  // deletion with no provenance at all, which is precisely what a tombstone exists to supply.
  if (options.tenantErasureRoutes) {
    if (conn === undefined) {
      console.warn(
        "[platform] --tenant-erasure-routes requires a Postgres store (--store pg); skipping",
      );
    } else {
      if (auditChainProducer === null) {
        // Mounts anyway, and says so out loud. The surface's own rule is that an erasure which
        // succeeds and cannot be *recorded* is refused (ADR-0316) — and without a chain it is still
        // recorded, just unanchored, so refusing here would deny a working surface over a weaker
        // guarantee. The branch this replaced tested `auditEmitter === null`, which the flag list
        // made unreachable, while its message claimed `--audit-chain-config` was required: a
        // refusal that never fired for a requirement that was not real. ADR-0322's lesson, again —
        // a surface that degrades rather than refusing has to say so.
        console.warn(
          "[platform] --tenant-erasure-routes has no --audit-chain-config: erasures are recorded " +
            "but their rows are UNANCHORED, so the integrity proof reports them as unproven",
        );
      }
      if (options.tenantErasureRoles.length === 0) {
        console.warn(
          "[platform] --tenant-erasure-routes is on with no --tenant-erasure-role: every request " +
            "will be refused",
        );
      }
      const eraseConn = conn;
      const emitter = requireEmitter("--tenant-erasure-routes");
      const registry = (): TenantColumnStoreRegistry | null => tenantStoreRegistry;
      extraRouteList.push(
        ...buildTenantErasureRoutes({
          eraser: {
            survey: async (tenantId) => {
              const { survey, collateral } = await surveyTenantSchemaWithCollateral(
                eraseConn,
                tenantId,
              );
              return { ...survey, collateral };
            },
            erase: async (tenantId, authority) => {
              const erasure = await eraseTenantSchema(eraseConn, tenantId, authority);
              // Forget before reporting: `storeFor` is synchronous and would otherwise keep handing
              // out a store bound to a schema that no longer exists, so the next request for this
              // tenant would fail against dropped tables instead of falling back.
              if (erasure.erased) registry()?.forget(tenantId);
              return erasure;
            },
          },
          principalRoles: buildPrincipalWiring(apiKeys).principalRoles,
          adminRoles: new Set(options.tenantErasureRoles),
          recordAction: async (event): Promise<void> => {
            await emitter.emit(
              auditEntry({
                id: randomUUID(),
                tenantId: event.tenantId,
                occurredAt: event.at,
                operation: event.operation,
                entity: "TenantSchema",
                entityId: event.schema,
                actor: auditActor({ userId: event.principalId }),
                // The figures a tombstone commits to, recorded in the tenant's own anchored trail so
                // the receipt and the proof agree.
                after: {
                  schema: event.schema,
                  approvedBy: event.approvedBy,
                  rowCount: event.rowCount,
                  storageBytes: event.storageBytes,
                  tables: event.tables,
                  ...(event.refusals.length > 0 ? { refusals: event.refusals } : {}),
                },
              }),
            );
          },
          onRecordError: (err, operation) =>
            console.error(`[platform] failed to record ${operation}`, err),
        }),
      );
    }
  }
  // The GDPR Article 17 flow, end to end and atomic (ADR-0320). Mounted here rather than with the
  // platform-admin routes for the same reason the erasure is: its recorder needs the audit emitter,
  // which does not exist up there.
  if (options.tenantDeletionRoutes) {
    if (conn === undefined) {
      console.warn(
        "[platform] --tenant-deletion-routes requires a Postgres store (--store pg); skipping",
      );
    } else if (auditChainProducer === null) {
      console.warn(
        "[platform] --tenant-deletion-routes needs the forensic chain (--audit-chain-config); skipping",
      );
    } else if (deletionCapabilities === null) {
      // Refused, not defaulted (ADR-0328). The scope of an Article 17 proof is a property of the
      // deployment, and until the deployment says what it holds there is no honest value: `absent`
      // for the unimplemented subsystems signs a proof that is silent about four places a tenant's
      // data may still be — the exact silence ADR-0317 was written for.
      console.warn(
        "[platform] --tenant-deletion-routes requires --deletion-capabilities (what this deployment " +
          "holds decides what its tombstones can claim); skipping",
      );
    } else {
      const capabilities = deletionCapabilities;
      if (options.tenantDeletionRoles.length === 0) {
        console.warn(
          "[platform] --tenant-deletion-routes is on with no --tenant-deletion-role: every request " +
            "will be refused",
        );
      }
      const delConn = conn;
      const emitter = requireEmitter("--tenant-deletion-routes");
      // The same chain the audit log anchors into, not a second one: one tamper-evident trail per
      // tenant is the point (ADR-0286).
      const tombstones = new PostgresTombstoneStore(delConn, auditChainProducer, schemaOpt);
      const tenantStore = new PostgresTenantStore(delConn);
      const registry = (): TenantColumnStoreRegistry | null => tenantStoreRegistry;
      extraRouteList.push(
        ...buildTenantDeletionRoutes({
          deleter: {
            delete: async (req) => {
              const outcome = await deleteTenantAtomically(
                delConn,
                tombstones,
                eraseTenantSchemaWithin,
                {
                  tenantId: req.tenantId,
                  tombstoneId: req.tombstoneId,
                  kind: req.kind,
                  executedBy: req.executedBy,
                  approvedBy: req.approvedBy,
                  capabilities,
                  // No cast: the route parses these with `DeletionAttestationSchema` itself now
                  // (ADR-0329), so `req.attestations` is already the contract's type.
                  attestations: req.attestations,
                  ...(req.relatedDeletionRequestId !== undefined
                    ? { relatedDeletionRequestId: req.relatedDeletionRequestId }
                    : {}),
                },
              );
              // Forget only on success: a rolled-back deletion left the schema in place, and
              // forgetting it would send that tenant to the JSONB fallback for no reason.
              if (outcome.ok) registry()?.forget(req.tenantId);
              return outcome;
            },
            retire: async (tenantId) => (await tenantStore.setStatus(tenantId, "deleted")) !== null,
            tombstonesFor: async (tenantId) => tombstones.listForTenant(tenantId),
          },
          principalRoles: buildPrincipalWiring(apiKeys).principalRoles,
          deleteRoles: new Set(options.tenantDeletionRoles),
          ...(options.tenantTombstoneReadRoles.length > 0
            ? { readRoles: new Set(options.tenantTombstoneReadRoles) }
            : {}),
          recordAction: async (event): Promise<void> => {
            await emitter.emit(
              auditEntry({
                id: randomUUID(),
                tenantId: event.tenantId,
                occurredAt: event.at,
                operation: event.operation,
                entity: "Tenant",
                entityId: event.tenantId,
                actor: auditActor({ userId: event.principalId }),
                after: {
                  approvedBy: event.approvedBy,
                  tombstoneId: event.tombstoneId,
                  chainEntryHash: event.chainEntryHash,
                  rowCount: event.rowCount,
                  tenantRetired: event.tenantRetired,
                  ...(event.refusals.length > 0 ? { refusals: event.refusals } : {}),
                },
              }),
            );
          },
          onRecordError: (err, operation) =>
            console.error(`[platform] failed to record ${operation}`, err),
          onRetireError: (err, tenantId) =>
            console.error(
              `[platform] tenant ${tenantId} was deleted and anchored but its row was not retired;` +
                " the data is gone and proven gone — retire the row by hand",
              err,
            ),
        }),
      );
    }
  }
  // The page transports (ADR-0325). Built once and shared by every escalator, because a page is the
  // same act whatever planned it; the per-escalator part is only the `signal` label in the payload.
  // `pagerduty_*` needs nothing — the Events API authenticates on the routing key the alert policy
  // already carries — so a deployment with a PagerDuty route pages correctly with no environment.
  const pageSenders = buildPageSendersFromEnv();
  // What *is* wired, beside what is not — the `[notify] channels:` line's counterpart. The skips
  // alone answered "did I misconfigure something", and left "can this deployment page at all"
  // unanswerable without reading the code: a deployment whose alert policy names a kind nothing
  // serves gets `unroutable` at the one moment nobody is reading logs (ADR-0329).
  console.info(`[paging] transports: ${pageSenders.report.kinds.join(", ")}`);
  for (const skipped of pageSenders.report.skipped) {
    console.warn(`[paging] not wired: ${skipped}`);
  }
  // A page is now written down as well as sent (ADR-0326). `tenantIdFor` is the deployment's answer
  // to "whose row is this": `meta.audit_log.tenant_id` is NOT NULL, so a page for a platform-scope
  // incident cannot leave a row and the recorder reports that rather than inventing a tenant.
  const pageRecorder =
    conn === undefined || auditEmitter === null
      ? null
      : new PageRecorder({
          audit: auditEmitter,
          onError: (err) => console.error("[paging] could not record a page", err),
        });
  const pageLogger =
    (surface: string) =>
    (report: PageDeliveryReport): void => {
      const text = `[${surface}] ${formatPageReport(report)}`;
      // An undelivered page is an error even though the escalation succeeded: the incident exists
      // and nobody has been told. A delivered one is informational.
      if (report.undelivered) console.error(text);
      else console.info(text);
    };
  // The incident's own timeline, which is the *other* place a page is written down — and the only
  // one that works for a platform-scope page (ADR-0327). `meta.audit_log.tenant_id` is NOT NULL, so
  // the SLO loop's pages can never leave an audit row; `meta.incidents.timeline` has no tenant
  // column, is append-only, and sits on the record an incident review actually opens.
  const pagedNoteStore = conn === undefined ? null : new PostgresIncidentStore(conn);
  /**
   * Appends the page to its incident's timeline.
   *
   * Returns rather than throws, like the audit record beside it: the page has already gone out and
   * the incident is already durable, so a failed note must not turn a successful escalation into an
   * error. `appendPagedNote` already reports instead of raising; this only logs what it reported.
   */
  const notePage = async (
    incidentId: string,
    report: PageDeliveryReport,
    operation: "trigger" | "resolve",
    surface: string,
  ): Promise<void> => {
    if (pagedNoteStore === null) return;
    const noted = await pagedNoteStore.appendPagedNote(incidentId, {
      facts: {
        // Channel **kinds** only, and the first provider-issued handle. Nothing from the finding —
        // ADR-0310's rule, which the note inherits because it is read by the same people.
        channels: report.outcomes.map((o) => o.kind),
        delivered: report.delivered,
        attempted: report.attempted,
        reference: report.outcomes.find((o) => o.reference !== null)?.reference ?? null,
        operation,
      },
      actorUserId: PAGE_NOTE_ACTOR,
    });
    if (!noted.recorded) {
      console.warn(`[${surface}] page note not added to ${incidentId}: ${noted.reason ?? "unknown"}`);
    }
  };
  /**
   * Delivers a page and writes it down twice, which only the call site can do: the report carries no
   * tenant (ADR-0325's content rule), so the audit row's tenant comes from the incident that caused
   * it — and when there is none, the timeline note is the record that still lands.
   *
   * A `resolve` fan-out is deliberately NOT routed through here — an all-`unsupported` resolve would
   * land as `platform.page_undelivered`, claiming a page failed when none was sent. It gets its own
   * timeline note instead, through `resolveAndNote`.
   */
  const deliverAndRecord = async (
    pager: { deliver: (d: PageDirective) => Promise<PageDeliveryReport> },
    directive: PageDirective,
    surface: string,
    tenantId: string | null,
  ): Promise<void> => {
    const report = await pager.deliver(directive);
    const outcome = await (pageRecorder?.record(report, tenantId) ??
      Promise.resolve({ audited: false, reason: "no recorder" }));
    if (!outcome.audited) console.warn(`[${surface}] ${formatPageRecord(report, outcome)}`);
    await notePage(directive.incidentId, report, "trigger", surface);
  };
  /**
   * Closes the alert and notes that it was closed.
   *
   * No audit row, for ADR-0326's reason — a resolve is not a page and must not be counted as one —
   * but very much a timeline entry: "the alert was closed at 03:52" is the other half of the story
   * the incident record is supposed to tell.
   */
  const resolveAndNote = async (
    pager: { resolve: (d: PageDirective) => Promise<PageDeliveryReport> },
    directive: PageDirective,
    surface: string,
  ): Promise<void> => {
    const report = await pager.resolve(directive);
    await notePage(directive.incidentId, report, "resolve", surface);
  };
  const deletionPager = buildPageDispatcher(
    "deletion-evidence",
    pageSenders,
    pageLogger("deletion-evidence"),
  );
  const integrityPager = buildPageDispatcher(
    "audit-integrity",
    pageSenders,
    pageLogger("integrity-proof"),
  );
  // The SLO loop's pages, which `EnforcementPlan.pages` has planned since Phase 2 and nothing has
  // ever read (ADR-0326).
  const sloPager = buildPageDispatcher("slo", pageSenders, pageLogger("slo"));
  // Escalation for the deletion-evidence findings the forensic chain cannot raise (ADR-0324).
  // Built once and shared by the routes and the scheduler, so one tampered record examined by
  // several paths is still one episode. The key is the **evidence record**, whichever handle names
  // it (ADR-0328): a tombstone a request names keys on the request, so the sweep adopts whatever
  // `auditCompleted` already declared; one no request names keys on `tombstone:<id>`, namespaced so
  // it cannot collide with a request id. `findOpen` is what enforces it.
  let deletionEscalator: DeletionEvidenceEscalator | null = null;
  if (options.deletionEscalationConfig !== null && conn !== undefined) {
    const parsed = DeletionEscalationConfigSchema.parse(
      JSON.parse(await readFile(options.deletionEscalationConfig, "utf8")) as unknown,
    );
    deletionEscalator = new DeletionEvidenceEscalator({
      config: parsed,
      // The escalation leaves its own anchored row, as the integrity escalator's does (ADR-0326):
      // the incident says a sev1 happened, this says why it was graded that way.
      ...(auditEmitter !== null ? { audit: auditEmitter } : {}),
      // Closes the provider's alert when the incident is cancelled on recovery.
      resolvePage: async (page): Promise<void> => {
        await resolveAndNote(deletionPager, page, "deletion-evidence");
      },
      // Store-backed, with no fallback declarer: unlike the integrity escalator's one-shot finding
      // (ADR-0304), this one is re-derived from the same two rows on the next pass, so a failed
      // declaration is retried rather than lost and an in-process id cannot collide with a stored
      // one for no gain (ADR-0293's reasoning for the SLO loop).
      declarer: new PostgresIncidentDeclarer({ conn }),
      page: async (page, incident): Promise<void> => {
        // Delivered, or loudly undelivered. The incident is already durable by here, so a failed
        // page is reported rather than thrown (ADR-0325). The incident is also where the tenant
        // comes from, since the page itself may not carry one (ADR-0326).
        await deliverAndRecord(
          deletionPager,
          page,
          "deletion-evidence",
          incident.affectedTenantIds[0] ?? null,
        );
      },
      // The subject id, not a request id: a tombstone episode's error would otherwise read as
      // though `tomb_…` were a request (ADR-0328).
      onError: (err, subjectId) =>
        console.error(`[deletion-evidence] escalation error for ${subjectId}`, err),
    });
  }
  // The handle (ADR-0321). ADR-0320 left the deletion synchronous and named the cost: a large
  // tenant's deletion can outlast a proxy timeout, after which the client never learns the receipt it
  // is obliged to keep. These four routes let a caller hold a request instead of an open connection,
  // and `--deletion-runner-ms` below does the work.
  if (options.deletionRequestRoutes) {
    if (conn === undefined) {
      console.warn(
        "[platform] --deletion-request-routes requires a Postgres store (--store pg); skipping",
      );
    } else {
      if (
        options.deletionRequestSubmitRoles.length === 0 &&
        options.deletionRequestVerifyRoles.length === 0
      ) {
        console.warn(
          "[platform] --deletion-request-routes is on with no --deletion-request-submit-role or " +
            "--deletion-request-verify-role: every request will be refused",
        );
      }
      if (auditChainProducer === null) {
        // Found by booting the real server: the emitter does not require the chain, so without
        // `--audit-chain-config` these routes mount, write *unanchored* audit rows, and reconciliation
        // has no tombstone table to read as evidence — it answers 501. Degrading quietly at boot is
        // the ADR-0288 defect, so it is said out loud (ADR-0322).
        console.warn(
          "[platform] --deletion-request-routes without --audit-chain-config: its audit rows are " +
            "unanchored and reconciliation is unavailable (the stranded routes answer 501)",
        );
      }
      const emitter = requireEmitter("--deletion-request-routes");
      const reqConn = conn;
      const requestStore = new PostgresDeletionRequestStore(reqConn, schemaOpt);
      // Reconciliation reads the tombstone table as its evidence (ADR-0322), so without the forensic
      // chain there is nothing to reconcile *from* and the two routes answer 501 rather than guessing.
      const requestReconciler =
        auditChainProducer === null
          ? undefined
          : new DeletionReconciler({
              requests: requestStore,
              tombstones: new PostgresTombstoneStore(reqConn, auditChainProducer, schemaOpt),
              retire: async (tenantId) =>
                (await new PostgresTenantStore(reqConn).setStatus(tenantId, "deleted")) !== null,
              ...(options.deletionStrandedAfterMs !== null
                ? { strandedAfterMs: options.deletionStrandedAfterMs }
                : {}),
            });
      extraRouteList.push(
        ...buildDeletionRequestRoutes({
          store: requestStore,
          principalRoles: buildPrincipalWiring(apiKeys).principalRoles,
          submitRoles: new Set(options.deletionRequestSubmitRoles),
          verifyRoles: new Set(options.deletionRequestVerifyRoles),
          ...(requestReconciler !== undefined ? { reconciler: requestReconciler } : {}),
          ...(options.deletionRequestReconcileRoles.length > 0
            ? { reconcileRoles: new Set(options.deletionRequestReconcileRoles) }
            : {}),
          ...(deletionEscalator !== null
            ? ((escalator: DeletionEvidenceEscalator) => ({
                escalate: async (finding): Promise<void> => {
                  const outcome = await escalator.onAuditFinding(finding);
                  if (outcome.action !== "none") {
                    console.error(
                      `[deletion-evidence] ${finding.requestId} → ${outcome.action}` +
                        ` ${outcome.incidentId ?? "-"}`,
                    );
                  }
                },
                // The sweep's own findings, which may name no request (ADR-0328). The episode key
                // follows the evidence record, so a referenced one adopts the request's incident
                // rather than declaring a second for the same tampered row.
                escalateTombstone: async (finding): Promise<void> => {
                  const outcome = await escalator.onTombstoneFinding({
                    tombstoneId: finding.tombstoneId,
                    tenantId: finding.tenantId,
                    reference: finding.reference,
                    relatedDeletionRequestId: finding.relatedDeletionRequestId,
                    detail: finding.detail,
                  });
                  if (outcome.action !== "none") {
                    console.error(
                      `[deletion-evidence] ${finding.tombstoneId} → ${outcome.action}` +
                        ` ${outcome.incidentId ?? "-"}`,
                    );
                  }
                },
                escalateVerdict: async (result): Promise<void> => {
                  const outcome = await escalator.onVerdict({
                    ...result,
                    ...(result.evidence?.defects !== undefined
                      ? { defects: result.evidence.defects }
                      : {}),
                  });
                  if (outcome.action !== "none") {
                    console.error(
                      `[deletion-evidence] ${result.requestId} → ${outcome.action}` +
                        ` ${outcome.incidentId ?? "-"}`,
                    );
                  }
                },
              }))(deletionEscalator)
            : {}),
          ...(options.deletionRequestReadRoles.length > 0
            ? { readRoles: new Set(options.deletionRequestReadRoles) }
            : {}),
          ...(options.deletionRequestDeadlineDays !== null
            ? { deadlineDays: options.deletionRequestDeadlineDays }
            : {}),
          newRequestId: () => newRequestId(randomUUID()),
          recordAction: async (event): Promise<void> => {
            await emitter.emit(
              auditEntry({
                id: randomUUID(),
                tenantId: event.tenantId,
                occurredAt: event.at,
                operation: event.operation,
                entity: "GdprDeletionRequest",
                entityId: event.requestId,
                actor: auditActor({ userId: event.principalId }),
                after: {
                  status: event.status,
                  ...(event.tombstoneId !== null ? { tombstoneId: event.tombstoneId } : {}),
                  ...(event.detail !== null ? { detail: event.detail } : {}),
                },
              }),
            );
          },
          onRecordError: (err, operation) =>
            console.error(`[platform] failed to record ${operation}`, err),
        }),
      );
    }
  }
  if (options.auditReadRoutes) {
    if (conn === undefined) {
      console.warn("[audit] --audit-read-routes requires a Postgres store (--store pg); skipping");
    } else {
      if (auditChainProducer === null) {
        // The routes take a *required* recorder and an unrecordable read is refused per request
        // (ADR-0313), so the surface is never open and unaudited — it is the *anchoring* that is
        // missing here, not the recording. Mount and say so, rather than the refusal this replaced,
        // which tested `auditEmitter === null` and so never fired at all.
        console.warn(
          "[audit] --audit-read-routes has no --audit-chain-config: each privileged read is still " +
            "recorded, but its row is UNANCHORED and the integrity proof reports it as unproven",
        );
      }
      if (
        options.auditReadTenantRoles.length === 0 &&
        options.auditReadPlatformRoles.length === 0
      ) {
        console.warn(
          "[audit] --audit-read-routes is on with no --audit-read-tenant-role or " +
            "--audit-read-platform-role: every request will be refused",
        );
      }
      const emitter = requireEmitter("--audit-read-routes");
      extraRouteList.push(
        ...buildAuditReadRoutes({
          source: new PostgresAuditReadStore(conn, schemaOpt),
          principalRoles: buildPrincipalWiring(apiKeys).principalRoles,
          platformRoles: new Set(options.auditReadPlatformRoles),
          tenantRoles: new Set(options.auditReadTenantRoles),
          classification: {
            fieldsFor: entityFieldLookupFrom(manifest),
            roles: new Map(Object.entries(manifest.roles ?? {})),
            policy: {
              privilegedRoles: options.auditReadSensitiveRoles,
              // Per-class grants, authoritative for the classes they name (ADR-0329). A class
              // listed here is no longer reached by the wholesale grant above, which is the only
              // way "pii but not phi" can be said.
              privilegedRolesByClass: options.auditReadSensitiveClasses,
            },
          },
          recordRead: async (event): Promise<void> => {
            // A cross-tenant read names no single tenant, so it is recorded against the *reader's*
            // own: `meta.audit_log.tenant_id` is NOT NULL, and an unrecordable read is a refused
            // one. A reader with no resolvable tenant at all therefore cannot read — which is the
            // same fail-closed direction the grant resolution already takes.
            const tenantId = event.tenantId ?? event.readerTenantId;
            if (tenantId === null) {
              throw new Error("audit read has no tenant to record against");
            }
            await emitter.emit(
              auditEntry({
                id: randomUUID(),
                tenantId,
                occurredAt: event.at,
                operation: event.operation,
                entity: "AuditLog",
                entityId: null,
                actor: auditActor({ userId: event.principalId }),
                // The query itself, not merely that something was read: `scope` says which trail,
                // and `tenantId` is present when the read crossed into another tenant's.
                after: {
                  scope: event.scopeKind,
                  granted: event.granted,
                  roles: event.roles,
                  ...(event.tenantId !== null ? { readTenantId: event.tenantId } : {}),
                  ...event.filters,
                },
              }),
            );
          },
          ...(options.auditReadMaxRangeDays !== null
            ? { maxRangeDays: options.auditReadMaxRangeDays }
            : {}),
          onRecordError: (err, scopeKind) =>
            console.error(`[audit] failed to record a ${scopeKind}-scoped audit read`, err),
        }),
      );
    }
  }

  if (options.designReview && conn !== undefined) {
    reviewStore = new PostgresDesignReviewStore(conn, schemaOpt);
    extraRouteList.push(
      ...buildDesignReviewRoutes({
        store: reviewStore,
        principalRoles: buildPrincipalWiring(apiKeys).principalRoles,
        adminRoles: new Set(options.designReviewRoles),
        assessRisk: assessManifestRisk,
        projectSchema: projectManifestView,
        ...(manifestStore !== null ? { diffManifests, activeManifests: manifestStore } : {}),
        // A decision the tenant never hears about is not a decision they can act on. The notice
        // rides the platform's existing notification ledger (meta.notification_dispatches), whose
        // unique (tenant_id, idempotency_key) makes re-deciding the same way a no-op.
        ...(notificationStore !== null
          ? {
              notifyDecision: async (notice): Promise<boolean> =>
                notificationStore.record(buildDesignDecisionDispatch(notice)),
              onNotifyError: (err, proposalId) =>
                console.error(`[design-review] notification failed for proposal ${proposalId}`, err),
            }
          : {}),
      }),
    );
  }
  // Tenant-facing read side: GET /v1/meta/notifications. The dispatch row stores only a hash of
  // the message variables, so the readable content is joined from the proposal at read time.
  if (notificationStore !== null && manifestStore !== null) {
    const proposals = manifestStore;
    extraRouteList.push(
      ...buildNotificationRoutes({
        source: notificationStore,
        principalRoles: buildPrincipalWiring(apiKeys).principalRoles,
        allowedRoles: new Set(options.aiDesignRoles),
        digestTemplateId: DIGEST_TEMPLATE_ID,
        // Per-recipient by default: a person's inbox is what the delivery ledger actually
        // delivered to one of their addresses. An unidentifiable principal therefore sees
        // nothing, which is the safe direction — the leak this closes was seeing everything.
        ...(recipientResolver !== null
          ? {
              resolveIdentity: (tenantId: string, principalId: string) =>
                recipientResolver.identityFor(tenantId, principalId),
              tenantScopeRoles: new Set(options.notificationAuditRoles),
              // Reading beyond your own inbox leaves a record in meta.audit_log — written
              // before the data is served, so a failure to record refuses the read.
              ...(auditEmitter !== null
                ? {
                    auditTenantScope: async (event): Promise<void> => {
                      await auditEmitter.emit(
                        auditEntry({
                          id: randomUUID(),
                          tenantId: event.tenantId,
                          occurredAt: event.at,
                          actor: auditActor({
                            userId: event.principalId,
                          }),
                          operation: event.granted
                            ? TENANT_SCOPE_GRANTED_OPERATION
                            : TENANT_SCOPE_DENIED_OPERATION,
                          entity: "notification_dispatches",
                          after: { roles: event.roles, filters: event.filters },
                          reason: event.granted
                            ? "tenant-scope notification read"
                            : "tenant-scope notification read refused",
                        }),
                      );
                    },
                  }
                : {}),
            }
          : {}),
        // The dispatch stores only a hash of its variables, so a digest's copy is rendered from
        // the pool it stands for at read time — with a tenant's authored template winning over
        // the platform's built-in default when one exists.
        ...(digestReadStore !== null && templateStore !== null
          ? {
              resolveDigest: async (tenantId: string, digestId: string) => {
                const digest = await digestReadStore.getByDigestId(tenantId, digestId);
                if (digest === null) return null;
                const items = await digestReadStore.itemsFor(tenantId, digestId);
                if (items.length === 0) return null;
                const members = items.map(memberFromItem);
                const locale = digestLocale(members);
                const override = await templateStore.find(tenantId, {
                  templateId: DIGEST_TEMPLATE_ID,
                  locale,
                  channel: digest.channel,
                });
                return renderDigest({
                  digest,
                  members,
                  locale,
                  ...(override !== null ? { content: override.content } : {}),
                });
              },
            }
          : {}),
        resolveProposal: async (tenantId, proposalId) => {
          const record = await proposals.getById(tenantId, proposalId);
          return record === null
            ? null
            : {
                name: record.name,
                reviewStatus: record.reviewStatus,
                reviewNotes: record.reviewNotes,
                reviewedAt: record.reviewedAt,
              };
        },
      }),
    );
  }
  // In-product AI Architect: /v1/ai routes let a tenant admin describe their business, get a
  // kernel-validated manifest proposal (meta.operate_tenant_manifests), and activate it as the
  // tenant's live system. The designer resolves from env, local first: LOCAL_LLM_BASE_URL /
  // OLLAMA_BASE_URL through the purpose-built local provider, then Anthropic, then OpenAI
  // (OPENAI_BASE_URL still serves a proxy). Local is tried first on purpose — a local base URL has
  // one meaning in this process, so honouring a stray cloud key instead would send the tenant's
  // business description to a vendor the operator deliberately opted out of. With no provider the
  // routes answer 503 but review/activate of existing proposals still works. Activation invalidates the per-tenant gateway cache below.
  if (options.aiDesign && manifestStore !== null) {
    const providerBuild = buildDesignProviderFromEnv(
      process.env,
      options.aiModel !== null ? { model: options.aiModel } : {},
    );
    const designer =
      providerBuild !== null
        ? buildDesignDesigner({
            provider: providerBuild.provider,
            model: providerBuild.model,
            providerLabel: providerBuild.providerLabel,
            ensureRoles: options.aiDesignRoles,
          })
        : null;
    if (providerBuild === null) {
      console.warn(
        "[ai-design] no AI provider configured (set LOCAL_LLM_BASE_URL / OLLAMA_BASE_URL for a " +
          "self-hosted model, or ANTHROPIC_API_KEY / OPENAI_API_KEY); POST /v1/ai/design will " +
          "answer 503. A local base URL that is set but malformed also lands here, rather than " +
          "falling through to a cloud vendor.",
      );
    }
    // With review required, a new proposal must enter the queue as `pending` — otherwise it
    // keeps the default `not_required`, the activation gate denies it forever, and it never
    // appears for a reviewer. Enrolment is best-effort: a failure never loses the proposal.
    const store =
      options.requireDesignReview && reviewStore !== null
        ? enrolNewProposalsForReview(manifestStore, {
            enroller: reviewStore,
            onError: (err, proposalId) =>
              console.error(`[design-review] failed to enrol proposal ${proposalId} for review`, err),
          })
        : manifestStore;
    // Async design: a durable job row carries live phase/attempt/progress so the wizard polls
    // instead of blocking ~a minute on one request. The job survives the client disconnecting
    // and is readable from any replica.
    const designJobs = conn !== undefined ? new PostgresDesignJobStore(conn, schemaOpt) : undefined;
    // Durable per-tenant monthly spend ceiling over meta.architect_tenant_cost (the same ledger
    // the Architect CLI writes), so a design loop can't run up an unbounded bill and the limit
    // holds across replicas and restarts.
    const budget =
      conn !== undefined
        ? buildAiDesignBudget({
            store: new PostgresTenantCostStore(conn, schemaOpt),
            // The estimator's learned correction, kept per tenant and across restarts (ADR-0330).
            // Its own table rather than a column on the monthly ledger, because that one is keyed
            // by period and would reset the correction every month — ADR-0311's forgetting on a
            // monthly cadence instead of a per-restart one.
            inflationStore: new PostgresEstimateInflationStore(conn, schemaOpt),
            onInflationFallback: (tenantId, provenance) =>
              console.warn(
                `[ai-design] tenant ${tenantId} cost estimator fell back to a pessimistic` +
                  ` correction (${provenance}); requests may be delayed until it is re-learned`,
              ),
            maxUsdPerMonth: options.aiMaxUsdPerMonth ?? DEFAULT_AI_DESIGN_MAX_USD_PER_MONTH,
            // Bounds one prompt rather than one month (ADR-0267). Off unless configured: a request
            // ceiling that is wrong refuses legitimate designs, which the monthly ceiling never
            // does, so this one is opt-in and the monthly one always applies.
            ...(options.aiMaxRequestDollars !== null
              ? { maxUsdPerRequest: options.aiMaxRequestDollars }
              : {}),
            onDenied: (tenantId, spentUsd, limitUsd) =>
              console.warn(
                `[ai-design] tenant ${tenantId} denied: $${spentUsd.toFixed(2)} of $${limitUsd.toFixed(2)} monthly budget spent`,
              ),
          })
        : undefined;
    extraRouteList.push(
      ...buildAiDesignRoutes({
        store,
        designer,
        principalRoles: buildPrincipalWiring(apiKeys).principalRoles,
        allowedRoles: new Set(options.aiDesignRoles),
        onActivated: (tenantId) => gatewayCache?.invalidate(tenantId),
        summarize: manifestSummary,
        projectSchema: projectManifestView,
        diffManifests,
        activeManifests: manifestStore,
        ...(budget !== undefined ? { budget } : {}),
        ...(options.requireDesignReview && reviewStore !== null ? { reviewGate: reviewStore } : {}),
        ...(designJobs !== undefined && designer !== null
          ? {
              jobs: designJobs,
              startJob: (tenantId: string, jobId: string, input: { description: string; name: string }): void =>
                startDesignJob(
                  {
                    jobs: designJobs,
                    manifests: store,
                    designer,
                    ...(budget !== undefined ? { budget } : {}),
                    onError: (err) => console.error(`[ai-design] job ${jobId} failed`, err),
                  },
                  tenantId,
                  jobId,
                  input,
                ),
            }
          : {}),
      }),
    );
  }
  const extraRoutes = extraRouteList.length > 0 ? extraRouteList : undefined;
  // Data-residency edge routing: this instance's region + a tenant→profile directory (a static file
  // via --residency-file, or the Postgres tenant_residency_profiles table via --residency-store). A
  // tenant hint whose profile forbids this region is redirected to its home region before dispatch.
  let residencyDirectory: TenantResidencyDirectory | undefined;
  if (options.residencyFile !== null) {
    residencyDirectory = loadResidencyDirectory(await readFile(options.residencyFile, "utf8"));
  } else if (options.residencyStore && conn !== undefined) {
    residencyDirectory = new PostgresTenantResidencyDirectory(conn, schemaOpt);
  }
  const regionGuard =
    options.region !== null && residencyDirectory !== undefined
      ? { region: options.region as Region, directory: residencyDirectory }
      : undefined;
  // Channel senders come from the environment, not from flags: all but the sender identity are
  // credentials and a process's argv is readable by anyone who can run `ps`. `in_app` is always
  // registered, so a delivery for an unconfigured channel is refused as `no_sender_configured`,
  // which the drain treats as retryable — configure the channel and re-drain and it goes out
  // (ADR-0274).
  const senderWiring = buildSenderRegistryFromEnv();
  const deliveryEnabled = options.notificationDrainMs !== null && conn !== undefined;
  console.info(`[notify] channels: ${senderWiring.report.channels.join(", ")}`);
  for (const skipped of senderWiring.report.skipped) {
    console.warn(`[notify] ${skipped}`);
  }
  if (!deliveryEnabled && senderWiring.report.channels.length > 1) {
    // Otherwise the line above reads as "email works" to an operator who configured a provider but
    // never started the drain, which is the same looks-healthy-sends-nothing failure the skip
    // reasons exist to prevent.
    console.warn(
      "[notify] a real channel is configured but no drain is running; pass --notification-drain-ms " +
        "(and a Postgres store) or nothing will be delivered",
    );
  }

  // Live SLO enforcement: availability/latency SLOs registered from a config file (--slo-config) or
  // derived from the manifest (--slo-defaults, one SLO per entity operation). The observer feeds every
  // dispatched request's outcome into the engines, and the scheduler evaluates burn/latency on an
  // interval, declaring incidents + paging + optional flag rollback on a breach.
  const sloConfig =
    options.sloConfig !== null
      ? await loadSloConfig(options.sloConfig)
      : options.sloDefaults
        ? deriveSloConfig(
            manifest,
            options.sloDefaultsOverride !== null
              ? sloDefaultsOptionsFromOverride(await loadSloDefaultsOverride(options.sloDefaultsOverride))
              : {},
          )
        : null;
  // With a Postgres store the engines persist: every evaluation, every enforcement action, and the
  // declared `IncidentRecord` itself, whose id is allocated from `meta.incidents` rather than from a
  // counter that restarts at 0001 (ADR-0289, ADR-0293).
  const sloEnforcement =
    sloConfig !== null
      ? buildSloEnforcement(sloConfig, {
          ...(conn !== undefined ? { conn } : {}),
          onDecision: (d) =>
            console.info(
              `[slo] ${d.signal} ${d.kind} surface=${d.surface} slo=${d.sloId}` +
                (d.incidentId !== null ? ` incident=${d.incidentId}` : "") +
                (d.closeOut !== null ? ` closeOut=${d.closeOut}` : ""),
            ),
          // The pages the engines have been planning since Phase 2 and nothing ever read. Awaited,
          // so a pass does not report a breach handled before anybody was told (ADR-0326).
          onPage: async (d): Promise<void> => {
            // An SLO surface is not a tenant, so these pages are recorded only if a future resolver
            // can name one — reported as unrecorded rather than attributed to a guess.
            for (const directive of d.pages) {
              await deliverAndRecord(sloPager, directive, "slo", null);
            }
          },
          // Closes those alerts when the breach recovers, over the directives that were actually
          // delivered rather than freshly-planned ones: a recovered decision carries no severity,
          // so there is nothing to re-plan from (ADR-0326). Not routed through `deliverAndRecord` —
          // a resolve is not a page and must not be recorded as one.
          onResolvePage: async (_decision, pages): Promise<void> => {
            for (const directive of pages) await resolveAndNote(sloPager, directive, "slo");
          },
          onError: (err) => console.error("[slo] evaluation error", err),
        })
      : null;
  if (sloEnforcement !== null && !sloEnforcement.persisted) {
    console.warn(
      "[slo] no Postgres store (--store pg): incidents are declared in memory only and their ids restart at 0001",
    );
  }
  // Periodic DR-readiness assessment: fold the failover/drill executions recorded through the API into
  // the config's declared infra, assess readiness, and persist a snapshot. Enabled by
  // --dr-readiness-config over a pg store (needs the conn for the execution stores).
  let drReadiness: DrReadinessLifecycle | null = null;
  if (options.drReadinessConfig !== null) {
    if (conn === undefined) {
      console.warn("[dr] --dr-readiness-config requires a Postgres store (--store pg); skipping");
    } else {
      drReadiness = buildDrReadinessLifecycle(conn, await loadDrReadinessConfig(options.drReadinessConfig), {
        onReport: (r) =>
          console.info(`[dr] readiness ready=${r.ready.toString()} issues=${r.counts.totalIssues.toString()}`),
        onError: (err) => console.error("[dr] readiness error", err),
      });
    }
  }
  // Scheduled access-review campaigns: start due campaigns, generate items from the config's live grants,
  // and auto-revoke lapsed access — persisting through the access-reviews runtime. Enabled by
  // --access-reviews-config over a pg store.
  let accessReviews: AccessReviewsLifecycle | null = null;
  if (options.accessReviewsConfig !== null) {
    if (conn === undefined) {
      console.warn("[access-reviews] --access-reviews-config requires a Postgres store (--store pg); skipping");
    } else {
      accessReviews = buildAccessReviewsLifecycle(conn, await loadAccessReviewsConfig(options.accessReviewsConfig), {
        ...(options.accessReviewsLiveGrants
          ? { grantSource: new AuthLiveGrantSource(apiKeyPrincipalProvider(apiKeys)) }
          : {}),
        onTick: (r) =>
          console.info(
            `[access-reviews] started=${r.startedCampaigns.length.toString()} items=${r.generatedItems.toString()} revoked=${r.autoRevocations.length.toString()}`,
          ),
        onError: (err) => console.error("[access-reviews] tick error", err),
      });
    }
  }
  // Periodic compliance certification: each pass collects live control-evidence (encryption coverage,
  // latest DR-readiness snapshot, latest sealed access-review evidence) per framework, certifies each
  // configured framework, and persists a sealed report. Enabled by --certification-config over a pg store.
  let certification: CertificationLifecycle | null = null;
  if (options.certificationConfig !== null) {
    if (conn === undefined) {
      console.warn("[certification] --certification-config requires a Postgres store (--store pg); skipping");
    } else {
      certification = buildCertificationLifecycle(
        conn,
        await loadCertificationConfig(options.certificationConfig),
        {
          onReports: (reports) => {
            for (const r of reports) {
              console.info(
                `[certification] ${r.framework} certifiable=${r.certifiable.toString()} ` +
                  `satisfied=${r.assessment.counts.satisfied.toString()}/${r.assessment.counts.total.toString()} report=${r.reportId}`,
              );
            }
          },
          onError: (err) => console.error("[certification] pass error", err),
          onSourceError: (err) => console.error("[certification] evidence source error", err),
        },
      );
    }
  }
  // Usage metering: each billable request (authenticated tenant, mapped subscription, counted status)
  // accumulates into a billing engine keyed by the tenant's subscription, flushed to Postgres on an
  // interval. Enabled by --metering-config over a pg store.
  let metering: RequestMetering | null = null;
  if (options.meteringConfig !== null) {
    if (conn === undefined) {
      console.warn("[metering] --metering-config requires a Postgres store (--store pg); skipping");
    } else {
      metering = buildRequestMetering(conn, await loadMeteringConfig(options.meteringConfig), {
        onFlush: (written) => console.info(`[metering] flushed ${written.toString()} usage record(s)`),
        onError: (err) => console.error("[metering] flush error", err),
      });
    }
  }
  // Stripe usage sync: periodically report each configured tenant's un-synced usage records to Stripe
  // and mark them synced. Enabled by --stripe-usage-sync-config over a pg store + --stripe-api-key.
  let stripeUsageSync: StripeUsageSync | null = null;
  if (options.stripeUsageSyncConfig !== null && conn !== undefined && options.stripeApiKey !== null) {
    stripeUsageSync = buildStripeUsageSync(
      conn,
      new StripeClient({ apiKey: options.stripeApiKey }),
      await loadStripeUsageSyncConfig(options.stripeUsageSyncConfig),
      {
        onSync: (o) =>
          console.info(`[stripe-usage] tenant=${o.tenant} synced=${o.synced.toString()} skipped=${o.skipped.toString()}`),
        onError: (err) => console.error("[stripe-usage] sync error", err),
      },
    );
  }
  // Audit chain: append a signed, hash-linked audit-log entry per request into the tamper-evident chain,
  // so certification's forensic-chain source has a live chain to verify. Enabled by --audit-chain-config
  // over a pg store.
  let auditChain: AuditChain | null = null;
  let auditPolicy: TenantAuditPolicyLifecycle | null = null;
  if (options.auditChainConfig !== null) {
    if (conn === undefined || auditConfig === null || auditChainProducer === null) {
      console.warn("[audit-chain] --audit-chain-config requires a Postgres store (--store pg); skipping");
    } else {
      // Live per-tenant sampling from meta.operate_tenant_settings (overrides the config map, no redeploy).
      // Enabled by --audit-sampling-refresh-ms; refreshed into an in-memory snapshot the observer reads.
      if (options.auditSamplingRefreshMs !== null) {
        auditPolicy = buildTenantAuditPolicyCache({
          settingsStore,
          tenants: new PostgresTenantSource(conn),
          intervalMs: options.auditSamplingRefreshMs,
          onError: (err, tenantId) =>
            console.error(`[audit-sampling] tenant=${tenantId} settings load error`, err),
          refreshOnError: (err) => console.error("[audit-sampling] refresh error", err),
        });
      }
      auditChain = buildAuditChain(conn, auditConfig, {
        // The producer the audit-log emitter already anchors into, so per-request entries and
        // per-record anchors share one chain (and one advisory lock) per tenant.
        store: auditChainProducer,
        onError: (err) => console.error("[audit-chain] append error", err),
        ...(auditPolicy !== null ? { policyCache: auditPolicy.cache } : {}),
      });
      // Register the sealing key's public half into the platform key registry (best-effort — a registry
      // failure must not stop serving) so a chain entry's signingKeyFingerprint resolves to a known key.
      try {
        const registered = await registerAuditChainKey(new PostgresKeyRegistry(conn), auditConfig);
        console.info(`[audit-chain] registered sealing key ${registered.keyId}`);
      } catch (err) {
        console.error("[audit-chain] key registration failed", err);
      }
    }
  }
  // Periodic per-tenant chain checkpointing: anchor a ChainCheckpoint at each configured scope's tail so
  // verification stays bounded (verify only the suffix after the latest checkpoint). Enabled by
  // --checkpoint-config over a pg store; reuses the audit chain's signing key, so it needs --audit-chain-config.
  let checkpoints: CheckpointLifecycle | null = null;
  if (options.checkpointConfig !== null) {
    if (conn === undefined) {
      console.warn("[checkpoint] --checkpoint-config requires a Postgres store (--store pg); skipping");
    } else if (auditConfig === null) {
      console.warn(
        "[checkpoint] --checkpoint-config requires --audit-chain-config (for the chain signing key); skipping",
      );
    } else {
      const checkpointConfig = await loadCheckpointConfig(options.checkpointConfig);
      // The tenant registry (meta.tenants) is always in `meta`, independent of the chain `schema`.
      const liveScopes = checkpointConfig.allTenants
        ? {
            tenants: tenantSourceScopes(
              new PostgresTenantSource(
                conn,
                checkpointConfig.tenantStatuses !== undefined
                  ? { statuses: checkpointConfig.tenantStatuses }
                  : {},
              ),
              { includePlatform: checkpointConfig.includePlatform },
            ),
          }
        : {};
      checkpoints = buildCheckpointLifecycle(conn, checkpointConfig, {
        signer: ed25519ChainSigner(auditConfig),
        ...liveScopes,
        onCheckpoint: (scope, cp) =>
          console.info(
            `[checkpoint] scope=${scope ?? "platform"} seq=${cp.sequenceNumber.toString()} root=${cp.rootHash.slice(0, 12)}`,
          ),
        onError: (err) => console.error("[checkpoint] pass error", err),
      });
    }
  }
  // Audit-integrity proof: periodically run BOTH halves of the proof ADR-0286 built — each audit row
  // against the chain entry that commits to it, and the chain's own links + signatures — and append the
  // verdict to the chain. A check nobody performs proves nothing; this is the thing that performs it.
  let integrityProof: IntegrityProofLifecycle | null = null;
  if (options.integrityProofConfig !== null) {
    if (conn === undefined) {
      console.warn(
        "[integrity-proof] --integrity-proof-config requires a Postgres store (--store pg); skipping",
      );
    } else if (auditConfig === null) {
      console.warn(
        "[integrity-proof] --integrity-proof-config requires --audit-chain-config (for the chain signing key); skipping",
      );
    } else {
      const proofConfig = await loadIntegrityProofConfig(options.integrityProofConfig);
      // The tenant registry (meta.tenants) is always in `meta`, independent of the chain `schema`.
      const liveScopes = proofConfig.allTenants
        ? {
            tenants: tenantSourceScopes(
              new PostgresTenantSource(
                conn,
                proofConfig.tenantStatuses !== undefined
                  ? { statuses: proofConfig.tenantStatuses }
                  : {},
              ),
              { includePlatform: proofConfig.includePlatform },
            ),
          }
        : {};
      // Escalation: a compromised verdict becomes a declared incident + a page, once per
      // episode rather than once per pass. The audit emitter is passed so the escalation
      // itself lands in meta.audit_log and is anchored in the chain (ADR-0286/0288); the
      // incident declarer persists the `IncidentRecord` so its lifecycle outlives this process
      // and its id is allocated from the rows that exist rather than a restarting counter
      // (ADR-0289).
      const escalator =
        proofConfig.escalation === undefined
          ? null
          : new IntegrityEscalator({
              config: proofConfig.escalation,
              ...(auditEmitter !== null ? { audit: auditEmitter } : {}),
              declarer: new PostgresIncidentDeclarer({ conn }),
              page: async (page, incident): Promise<void> => {
                // `affectedTenantIds` is empty for the platform chain, which is the genuinely
                // unrecordable case the integrity escalator already documents.
                await deliverAndRecord(
                  integrityPager,
                  page,
                  "integrity-proof",
                  incident.affectedTenantIds[0] ?? null,
                );
              },
              // Closes the alert the declaration opened once the proof stops finding the tamper.
              // Not routed through `deliverAndRecord`: a resolve is not a page, and recording it as
              // `platform.page_delivered` would claim somebody was woken (ADR-0326).
              resolvePage: async (page): Promise<void> => {
                await resolveAndNote(integrityPager, page, "integrity-proof");
              },
              onError: (err) => console.error("[integrity-proof] escalation error", err),
            });
      integrityProof = buildIntegrityProofLifecycle(conn, proofConfig, {
        signer: ed25519ChainSigner(auditConfig),
        registry: new PostgresKeyRegistry(conn),
        ...liveScopes,
        onPass: (report) =>
          console.info(
            `[integrity-proof] scope=${report.scope ?? "platform"} verdict=${report.verdict}`,
          ),
        // A provable tamper is the one outcome worth shouting about; `unproven` is not a finding.
        onFinding: (report) => console.error(`[integrity-proof] COMPROMISED\n${formatIntegrityProof(report)}`),
        ...(escalator !== null
          ? {
              escalate: async (report) => {
                const escalation = await escalator.observe(report);
                if (escalation.kind !== "none") {
                  console.error(`[integrity-proof] ${formatIntegrityEscalation(escalation)}`);
                }
                return escalation;
              },
            }
          : {}),
        onError: (err) => console.error("[integrity-proof] pass error", err),
      });
    }
  }
  // Compose the per-request observers (SLO + metering + audit chain) into one execution sink.
  const executionSinks: ((execution: PipelineExecution) => void)[] = [];
  if (sloEnforcement !== null) executionSinks.push(sloEnforcement.observer.asExecutionSink());
  if (metering !== null) executionSinks.push(metering.observer.asExecutionSink());
  if (auditChain !== null) executionSinks.push(auditChain.observer.asExecutionSink());
  const onExecution =
    executionSinks.length > 0
      ? (execution: PipelineExecution): void => {
          for (const sink of executionSinks) sink(execution);
        }
      : undefined;
  const { httpServer } = buildOperateHttpServer({
    manifest,
    store,
    apiKeys,
    allocator,
    settingsStore,
    ...(regionGuard !== undefined ? { regionGuard } : {}),
    ...(extraRoutes !== undefined ? { extraRoutes } : {}),
    ...(entitlementResolver !== undefined ? { entitlementResolver } : {}),
    ...(webhookRoute !== undefined ? { webhookRoute } : {}),
    ...(billingPortal !== undefined ? { billingPortal } : {}),
    ...(additionalWriteEffects.length > 0 ? { additionalWriteEffects } : {}),
    ...(jobInvoker !== undefined ? { jobInvoker } : {}),
    ...(jobInvoker !== undefined && options.jobInvokeRoles.length > 0
      ? { jobInvokeRoles: options.jobInvokeRoles }
      : {}),
    ...(jobInvoker !== undefined && invokeActionRoles.size > 0
      ? { jobInvokeActionRoles: invokeActionRoles }
      : {}),
    defaultScheme: options.defaultScheme,
    ...(jwt !== null ? { jwt } : {}),
    ...(onExecution !== undefined ? { onExecution } : {}),
  });
  // In-process cron scheduler: enqueue the manifest's scheduled jobs into job_runs per tenant, so the
  // distributed worker fleet runs them. Enabled by --schedule-ms + --schedule-tenant over a pg store;
  // idempotent enqueue makes running it on every replica safe.
  let jobScheduler: JobScheduler | null = null;
  if (options.scheduleMs !== null && conn !== undefined) {
    // The tenant registry (meta.tenants) is always in `meta` — independent of the entity `--schema`.
    const tenants: TenantSource = options.scheduleAllTenants
      ? new PostgresTenantSource(conn)
      : new StaticTenantSource(options.scheduleTenants);
    jobScheduler = new JobScheduler({
      conn,
      jobs: Object.values(manifest.jobs ?? {}),
      tenants,
      intervalMs: options.scheduleMs,
      ...schemaOpt,
    });
  }
  // In-process dangling-link prune sweep: periodically prune every active tenant's orphaned m2m
  // association links from the JSONB store. Enabled by --prune-links-ms over the JSONB pg store
  // (the column store's join-table FKs cascade, so it never dangles — hence the pruner guard).
  let pruneScheduler: PruneScheduler | null = null;
  if (options.pruneLinksMs !== null && conn !== undefined && isDanglingLinkPruner(store)) {
    pruneScheduler = new PruneScheduler({
      pruner: store,
      pairs: relationPairsFromManifest(manifest),
      tenantSource: new PostgresTenantSource(conn, schemaOpt),
      intervalMs: options.pruneLinksMs,
    });
  }
  // Verified deletion requests, run out of band (ADR-0321). This is the half of the handle that does
  // the work: the routes above move a request to `verified`, and this claims one, runs the atomic
  // pipeline and writes the tombstone id back onto the request. Unlike every sibling scheduler here it
  // does **not** run at boot — see `DeletionScheduler`.
  let deletionScheduler: DeletionScheduler | null = null;
  if (options.deletionRunnerMs !== null) {
    if (conn === undefined) {
      console.warn("[platform] --deletion-runner-ms requires a Postgres store (--store pg); skipping");
    } else if (auditChainProducer === null || auditEmitter === null) {
      console.warn(
        "[platform] --deletion-runner-ms requires --audit-chain-config (the tombstone is anchored " +
          "in the chain, and the deletion is recorded); skipping",
      );
    } else if (deletionCapabilities === null) {
      // Refused for the same reason as the synchronous route (ADR-0328), and more sharply: the
      // runner's old `requiredSubsystems ?? []` made **every scheduled deletion** declare five of
      // the six subsystems out of scope by omission, unattended and with nobody looking.
      console.warn(
        "[platform] --deletion-runner-ms requires --deletion-capabilities (an unattended deletion " +
          "signs a proof nobody reviews); skipping",
      );
    } else {
      const runConn = conn;
      const runnerCapabilities = deletionCapabilities;
      const emitter = auditEmitter;
      const tombstones = new PostgresTombstoneStore(runConn, auditChainProducer, schemaOpt);
      const requests = new PostgresDeletionRequestStore(runConn, schemaOpt);
      const tenantStore = new PostgresTenantStore(runConn);
      const registry = (): TenantColumnStoreRegistry | null => tenantStoreRegistry;
      const executedBy = options.deletionRunnerExecutedBy ?? DEFAULT_DELETION_EXECUTED_BY;
      const approvedBy = options.deletionRunnerApprovedBy ?? DEFAULT_DELETION_APPROVED_BY;
      const runner = new DeletionRunner({
        store: requests,
        executedBy,
        approvedBy,
        newTombstoneId: () => newTombstoneId(randomUUID()),
        capabilities: runnerCapabilities,
        run: async (input) => {
          const outcome = await deleteTenantAtomically(
            runConn,
            tombstones,
            eraseTenantSchemaWithin,
            {
              tenantId: input.tenantId,
              tombstoneId: input.tombstoneId,
              // Unattended, so always the data subject's erasure — never a commercial wind-down,
              // which is a decision a person makes through the synchronous route.
              kind: "data_subject_erasure",
              executedBy: input.executedBy,
              approvedBy: input.approvedBy,
              capabilities: input.capabilities,
              attestations: [],
              relatedDeletionRequestId: input.relatedDeletionRequestId,
            },
          );
          if (outcome.ok) registry()?.forget(input.tenantId);
          return outcome;
        },
        onRun: (result) => {
          const line =
            `[platform] deletion request ${result.requestId} (tenant ${result.tenantId}) → ` +
            `${result.outcome}${result.tombstoneId !== null ? ` ${result.tombstoneId}` : ""}`;
          // `aborted` and `completed_unrecorded` both leave the request `in_progress` for a human, so
          // they are errors in the log even though the tick itself succeeded.
          if (result.outcome === "aborted" || result.outcome === "completed_unrecorded") {
            console.error(`${line} — needs reconciliation: ${result.detail ?? "no detail"}`);
          } else if (result.outcome !== "not_claimed") {
            console.log(line);
          }
          if (result.outcome !== "completed") return;
          // Retiring the row is ordered after the pipeline for ADR-0316's reason: the tombstone's
          // anchor references `meta.tenants`.
          void tenantStore
            .setStatus(result.tenantId, "deleted")
            .then(async (row) => {
              if (row === null) {
                console.error(
                  `[platform] tenant ${result.tenantId} was deleted and anchored but no row was ` +
                    "retired; the data is gone and proven gone — retire the row by hand",
                );
              }
              await emitter.emit(
                auditEntry({
                  id: randomUUID(),
                  tenantId: result.tenantId,
                  occurredAt: new Date().toISOString(),
                  operation: TENANT_DELETED_OPERATION,
                  entity: "Tenant",
                  entityId: result.tenantId,
                  actor: auditActor({ userId: executedBy }),
                  after: {
                    approvedBy,
                    tombstoneId: result.tombstoneId,
                    relatedDeletionRequestId: result.requestId,
                    tenantRetired: row !== null,
                  },
                }),
              );
            })
            .catch((err: unknown) =>
              console.error(
                `[platform] tenant ${result.tenantId} was deleted and anchored but the bookkeeping ` +
                  "after it failed; the data is gone and proven gone",
                err,
              ),
            );
        },
      });
      deletionScheduler = new DeletionScheduler({
        runner,
        // The reverse-direction audit on a multiple of the tick (ADR-0326). Off unless asked for:
        // it re-reads and re-hashes every completed request's tombstone, so running it every tick
        // would re-verify the same rows hundreds of times an hour to find a tamper that is not
        // time-critical in minutes.
        ...(options.deletionAuditEveryTicks !== null
          ? { auditEveryTicks: options.deletionAuditEveryTicks }
          : {}),
        ...(options.deletionSweepStallAfter !== null
          ? { stallAfterAttempts: options.deletionSweepStallAfter }
          : {}),
        // The repair half (ADR-0322). Conclusive verdicts only: a scheduler may record a deletion
        // that demonstrably happened, and may never reject a request on the *absence* of evidence.
        reconciler: new DeletionReconciler({
          requests,
          tombstones,
          retire: async (tenantId) => (await tenantStore.setStatus(tenantId, "deleted")) !== null,
          ...(options.deletionStrandedAfterMs !== null
            ? { strandedAfterMs: options.deletionStrandedAfterMs }
            : {}),
        }),
        intervalMs: options.deletionRunnerMs,
        ...(options.deletionRunnerBatchSize !== null
          ? { batchSize: options.deletionRunnerBatchSize }
          : {}),
        onError: (err) => console.error("[platform] deletion runner tick failed", err),
        ...(deletionEscalator !== null
          ? ((escalator: DeletionEvidenceEscalator) => ({
              onEscalate: async (results): Promise<void> => {
                for (const result of results) {
                  const outcome = await escalator.onVerdict({
                    ...result,
                    // Graded per defect rather than every finding being sev1 (ADR-0326).
                    ...(result.evidence?.defects !== undefined
                      ? { defects: result.evidence.defects }
                      : {}),
                  });
                  // `adopted` is the steady state for an unresolved finding and would otherwise be
                  // logged every tick; only a transition is worth a line.
                  if (outcome.action === "declared" || outcome.action === "closed_out") {
                    console.error(
                      `[deletion-evidence] ${result.requestId} → ${outcome.action}` +
                        ` ${outcome.incidentId ?? "-"}${outcome.closeOut === null ? "" : ` (${outcome.closeOut})`}`,
                    );
                  }
                }
              },
            }))(deletionEscalator)
          : {}),
        // The tombstone sweep (ADR-0327), now escalated as well as logged (ADR-0328). Its
        // findings name a *proof*, and the ones that matter most name no request at all — so the
        // episode is keyed on the evidence record: a tombstone a request names adopts that
        // request's episode, one no request names gets `tombstone:<id>`.
        onTombstoneFindings: ((): ((page: TombstoneSweepPage, progress: TombstoneSweepProgress) => Promise<void>) => {
          // Logging is deduped here rather than in the scheduler, which reports every page
          // honestly. An unproven tombstone is a *standing* fact — nothing repairs one yet, and a
          // short lap re-reads the same rows — so logging it on every tick is how an operator
          // learns to mute the log, which would defeat the sweep. ADR-0322 answered the same shape
          // by logging only what it wrote; there is nothing written here, so the equivalent is to
          // log only what **changed**. The *escalation* is not deduped and does not need to be:
          // `findOpen` makes a re-declaration an adoption, which writes nothing.
          let last: string | null = null;
          return async (page, progress): Promise<void> => {
            for (const finding of page.findings) {
              try {
                const outcome = await deletionEscalator?.onTombstoneFinding({
                  tombstoneId: finding.tombstoneId,
                  tenantId: finding.tenantId,
                  reference: finding.reference,
                  relatedDeletionRequestId: finding.relatedDeletionRequestId,
                  detail: finding.detail,
                });
                if (outcome?.action === "declared") {
                  console.error(
                    `[deletion-evidence] sweep found ${finding.tombstoneId} → declared` +
                      ` ${outcome.incidentId ?? "-"}`,
                  );
                }
              } catch (err) {
                console.error(`[deletion-evidence] escalating ${finding.tombstoneId} failed`, err);
              }
            }
            const fingerprint = JSON.stringify([
              progress.lapsCompleted,
              page.examined,
              page.findings.map((f) => [f.tombstoneId, f.detail]),
            ]);
            if (fingerprint === last) return;
            last = fingerprint;
            // The lap is the coverage claim, so it is what the line leads with: "every stored
            // Article 17 proof has been verified since <time>" is only true per *completed* lap.
            // And on the page that completes one, `examinedThisLap` has already reset to 0 —
            // `examinedLastLap` is where the figure went, which is the whole reason it exists. A
            // line reading "0 proofs verified" beside a finding was the first thing the live run
            // showed (ADR-0328).
            const completed = page.nextAfterTombstoneId === null;
            const lap = completed
              ? `lap ${progress.lapsCompleted.toString()} complete,` +
                ` ${(progress.examinedLastLap ?? 0).toString()} proof(s) verified`
              : `lap ${(progress.lapsCompleted + 1).toString()} in progress,` +
                ` ${progress.examinedThisLap.toString()} proof(s) verified so far`;
            if (page.findings.length === 0) {
              console.info(`[platform] tombstone sweep: ${lap}, clean`);
              return;
            }
            console.error(
              `[platform] tombstone sweep: ${lap}, ${page.findings.length.toString()} UNPROVEN —\n` +
                page.findings
                  .map((f) => `  ${f.tombstoneId} (${f.reference}) tenant=${f.tenantId}: ${f.detail}`)
                  .join("\n"),
            );
          };
        })(),
        // The sweep's coverage claim, falsified (ADR-0329). ADR-0328 shipped `pagesAdvanced` and
        // left "nothing reads it, so a stalled sweep is detectable and undetected" open — which is
        // the worst shape a verifier can fail in, because the *findings* surface goes quiet in
        // exactly the same way whether every proof verifies or none is being read. A clean log line
        // and a stalled sweep are indistinguishable to an operator, so the stall gets its own line
        // and it leads with the consequence rather than the counter.
        //
        // Logged at error and deliberately **not** deduped: a stall is a standing condition, and
        // `attemptsWithoutAdvance` grows on each line, so the repetition is the signal — it says
        // how long this has been true, which is the one thing an operator needs and the one thing a
        // deduped line cannot say.
        onSweepStall: async (stall): Promise<void> => {
          // The log line **first and unchanged**: it is the record that still lands when the
          // declaration cannot be stored, and a `no_pages` stall is frequently the same Postgres
          // the declarer writes to. Deliberately not deduped — the growing counter is the signal.
          console.error(
            `[platform] tombstone sweep STALLED (${stall.kind}): no stored Article 17 proof has` +
              ` been verified in ${stall.attemptsWithoutAdvance.toString()} audit tick(s)` +
              ` (${stall.pagesWithoutAdvance.toString()} page(s) returned` +
              `, last advance ${stall.lastAdvanceAt ?? "never"}` +
              `, cursor ${stall.cursor ?? "start of table"}) — ${stall.detail}`,
          );
          try {
            // Declared at `sev2`, not paged at `sev1` (ADR-0329's successor reasoning): ADR-0324's
            // `sev1` is for a *detected* falsified proof — a fact in hand — while a stall concludes
            // nothing about any row and persists for as long as its cause does. Paging it would
            // compete with real tamper findings on the same rotation.
            const outcome = await deletionEscalator?.onSweepStall({
              kind: stall.kind,
              attemptsWithoutAdvance: stall.attemptsWithoutAdvance,
              pagesWithoutAdvance: stall.pagesWithoutAdvance,
              lastAdvanceAt: stall.lastAdvanceAt,
              cursor: stall.cursor,
              detail: stall.detail,
            });
            // `adopted` is the steady state while the condition stands; only the transition earns a
            // line, since the stall log above already repeats by design.
            if (outcome?.action === "declared") {
              console.error(
                `[deletion-evidence] sweep stall → declared ${outcome.incidentId ?? "-"}`,
              );
            }
          } catch (err) {
            console.error("[deletion-evidence] escalating the sweep stall failed", err);
          }
        },
        onSweepRecovered: async (progress): Promise<void> => {
          // An advance is **positive evidence of motion**, which is the exception to this family's
          // house rule that an absence is only an inference (ADR-0322). So this recovery may be
          // applied automatically where `never_committed` may not.
          console.info(
            `[platform] tombstone sweep recovered: cursor ${progress.cursor ?? "start of table"}` +
              `, last advance ${progress.lastAdvanceAt ?? "never"}` +
              `, ${progress.pagesAdvanced.toString()} page(s) advanced`,
          );
          try {
            const outcome = await deletionEscalator?.onSweepRecovered();
            if (outcome?.action === "closed_out") {
              console.info(
                `[deletion-evidence] sweep stall → closed_out ${outcome.incidentId ?? "-"}` +
                  ` (${outcome.closeOut ?? "-"})`,
              );
            }
          } catch (err) {
            console.error("[deletion-evidence] resolving the sweep stall failed", err);
          }
        },
        ...(deletionEscalator !== null && options.deletionAuditEveryTicks !== null
          ? ((escalator: DeletionEvidenceEscalator) => ({
              onAuditFindings: async (findings): Promise<void> => {
                for (const finding of findings) {
                  // The same escalator the forward direction uses, so one tampered row examined by
                  // both paths is still one episode (the key is the request).
                  const outcome = await escalator.onAuditFinding(finding);
                  if (outcome.action === "declared") {
                    console.error(
                      `[deletion-evidence] audit found ${finding.requestId} → declared` +
                        ` ${outcome.incidentId ?? "-"}`,
                    );
                  }
                }
              },
            }))(deletionEscalator)
          : {}),
        onReconciled: (results) => {
          for (const r of results) {
            console.log(
              `[platform] stranded deletion request ${r.requestId} reconciled → ${r.verdict}`,
            );
          }
        },
      });
    }
  }
  // Notification delivery drain: a queued dispatch is only a record of intent until something
  // sends it. Each tick claims every active tenant's queued dispatches (FOR UPDATE SKIP LOCKED,
  // so two servers can drain one database), resolves the audience to real recipients, applies
  // each one's preferences and suppressions, sends through the channel's registered sender, and
  // records an attempt per recipient before advancing the dispatch to a terminal status.
  let deliveryScheduler: DeliveryScheduler | null = null;
  if (options.notificationDrainMs !== null && conn !== undefined) {
    const deliveryStore = new PostgresDeliveryStore(conn, schemaOpt);
    const digestStore = new PostgresDigestStore(conn, schemaOpt);
    deliveryScheduler = new DeliveryScheduler({
      // A pooled digest becomes one summary dispatch when its window closes, and the notices it
      // stands for have their pending retries retired — otherwise the recipient would get the
      // digest AND every notice it was meant to replace.
      assembly: {
        digests: digestStore,
        deliveries: deliveryStore,
        dispatches: new PostgresNotificationStore(conn, schemaOpt),
        onError: (err, tenantId) =>
          console.error(`[notifications] digest assembly failed for tenant ${tenantId}`, err),
      },
      drain: {
        store: deliveryStore,
        resolver: new PostgresRecipientResolver(conn, {
          ...schemaOpt,
          adminRoles: options.notificationAdminRoles,
        }),
        senders: senderWiring.registry,
        digests: digestStore,
        // Quiet hours + digest cadence are live tenant settings, so an admin can change them
        // without a redeploy; an absent or malformed policy means "send now", never a stall.
        policySource: async (tenantId): Promise<NotificationPolicy> =>
          parseNotificationPolicy((await settingsStore.get(tenantId)).notifications),
        onError: (err, tenantId) =>
          console.error(`[notifications] drain failed for tenant ${tenantId}`, err),
      },
      tenantSource: new PostgresTenantSource(conn, schemaOpt),
      intervalMs: options.notificationDrainMs,
      onError: (err) => console.error("[notifications] drain sweep failed", err),
    });
  }
  // Per-tenant manifest serving: a tenant with an activated custom manifest gets a gateway
  // compiled from it (cached, ttl'd, invalidated on activation); everyone else — and any
  // request whose tenant can't be resolved — falls through to the default full-featured
  // server above. Tenant gateways carry auth + store + numbering + settings; the peripheral
  // observers (SLO, audit chain, metering, billing) stay on the default server for now.
  let dispatchTarget: DispatchTarget = httpServer;
  if (options.perTenantManifests && manifestStore !== null) {
    // The boot store's column plans are derived from the boot manifest, so it cannot serve a
    // custom manifest's entities. Two answers, in order of preference:
    //
    //  - a per-tenant **column** store: the tenant's own manifest applied as real typed tables in
    //    their own schema, provisioned by `registry.ensure` as part of building their gateway. This
    //    is what makes an activated manifest a first-class schema rather than a document shape.
    //  - the manifest-agnostic JSONB store as the fallback, which is what every custom-manifest
    //    tenant got before and is still what a tenant whose DDL application is *refused* gets —
    //    served, rather than 500ing on every unplanned entity.
    const jsonbStore: EntityStore =
      store instanceof ColumnMappedEntityStore && conn !== undefined
        ? new PostgresEntityStore(conn, schemaOpt)
        : store;
    if (store instanceof ColumnMappedEntityStore && conn !== undefined) {
      tenantStoreRegistry = new TenantColumnStoreRegistry(conn, {
        onApplication: (application) => {
          if (application.applied) {
            console.info(
              `[tenant-schema] ${application.tenantId} applied to ${application.schema}` +
                ` (${application.statements.length.toString()} statements)`,
            );
            return;
          }
          // A refusal is not a failure to report once and forget: the tenant is being served from
          // the fallback store until an operator runs the reported SQL, so it is logged loudly with
          // the reason attached.
          const blocking = application.changes.filter((c) => c.blocking);
          console.error(
            `[tenant-schema] ${application.tenantId} REFUSED; serving from the JSONB fallback. ` +
              blocking.map((c) => `${c.table}.${c.column ?? "-"}: ${c.detail}`).join("; "),
          );
        },
      });
    }
    const tenantStore: EntityStore =
      tenantStoreRegistry === null
        ? jsonbStore
        : new TenantColumnStoreRouter({ registry: tenantStoreRegistry, fallback: jsonbStore });
    gatewayCache = new TenantGatewayCache({
      source: manifestStore,
      // Tenant gateways mirror the default server's cross-cutting wiring — extra routes (AI
      // design, platform admin), the subscription gate, the residency guard, the per-request
      // observer chain (SLO burn/latency, usage metering, audit chain), write effects and job
      // invocation — so activating a custom manifest never drops a tenant out of enforcement,
      // billing, or the tamper-evident audit trail. Only the deployment-wide singletons that
      // are not per-request (the Stripe webhook + billing-portal routes) stay on the default
      // server, which still handles them for every tenant.
      build: async (tenantManifest, tenantId): Promise<OperateHttpServer> => {
        // Provision before compiling, not on first request: `storeFor` is synchronous and does not
        // provision, so a gateway built before `ensure` resolved would route that tenant's very
        // first requests to the fallback store and then silently switch tables under them.
        if (tenantStoreRegistry !== null) await tenantStoreRegistry.ensure(tenantId, tenantManifest);
        return buildOperateHttpServer({
          manifest: tenantManifest,
          store: tenantStore,
          apiKeys,
          allocator,
          settingsStore,
          ...(jwt !== null ? { jwt } : {}),
          ...(extraRoutes !== undefined ? { extraRoutes } : {}),
          ...(entitlementResolver !== undefined ? { entitlementResolver } : {}),
          ...(regionGuard !== undefined ? { regionGuard } : {}),
          ...(additionalWriteEffects.length > 0 ? { additionalWriteEffects } : {}),
          ...(jobInvoker !== undefined ? { jobInvoker } : {}),
          ...(jobInvoker !== undefined && options.jobInvokeRoles.length > 0
            ? { jobInvokeRoles: options.jobInvokeRoles }
            : {}),
          ...(jobInvoker !== undefined && invokeActionRoles.size > 0
            ? { jobInvokeActionRoles: invokeActionRoles }
            : {}),
          ...(onExecution !== undefined ? { onExecution } : {}),
          defaultScheme: options.defaultScheme,
        }).httpServer;
      },
      onInvalidManifest: (tenantId, issues) =>
        console.error(`[ai-design] tenant ${tenantId} stored manifest invalid: ${issues.slice(0, 3).join("; ")}`),
    });
    // Cross-replica invalidation: activation on replica A is invisible to B/C until their TTL
    // expires. One aggregate query per interval (independent of tenant count) detects changed
    // activation watermarks — and tenants whose active manifest was archived — and drops just
    // those cache entries.
    if (options.manifestRefreshMs !== null && conn !== undefined) {
      manifestPoller = new ManifestActivationPoller({
        source: new PostgresActivationWatermarkSource(conn, schemaOpt),
        cache: gatewayCache,
        intervalMs: options.manifestRefreshMs,
        onInvalidated: (tenantId) => {
          // Forget the schema too, not just the compiled gateway. A *changed* manifest has a
          // different hash and would re-apply regardless; what this catches is the re-activation of
          // an *unchanged* one, which is exactly what happens after an operator runs the SQL a
          // refused application reported. Without it that tenant stays on the fallback store until
          // the refusal memo expires, having already done the thing that fixes it.
          tenantStoreRegistry?.forget(tenantId);
          console.info(`[manifest-refresh] tenant ${tenantId} activated elsewhere; cache invalidated`);
        },
        onError: (err) => console.error("[manifest-refresh] poll error", err),
      });
    }
    dispatchTarget = {
      dispatch: buildPerTenantDispatch({
        defaultDispatch: (raw, body) => httpServer.dispatch(raw, body),
        cache: gatewayCache,
        apiKeys,
      }),
    };
  }
  // The bounce webhook wraps the dispatch target rather than registering as a gateway route, because
  // the HMAC covers the raw bytes and a gateway `Handler` only ever sees a parsed body — re-serializing
  // it is not byte-identical, and a Twilio status callback is form-encoded and would not survive a JSON
  // round-trip at all. Wrapping here rather than in the node listener keeps the route available to the
  // Fetch/Workers adapter, which goes through the same target.
  if (options.bounceWebhook && conn !== undefined) {
    const secrets = buildBounceSecretResolverFromEnv();
    if (secrets.resolver === null) {
      console.warn(`[bounce-webhook] ${secrets.skipped ?? "not configured"}`);
    } else {
      const resolver = secrets.resolver;
      const suppressions = new PostgresSuppressionStore(conn, schemaOpt);
      const intercept = buildBounceWebhookInterceptor({
        store: suppressions,
        secretForTenant: resolver,
        ...(options.bounceTransientHours !== null
          ? { transientSuppressionHours: options.bounceTransientHours }
          : {}),
        onRecorded: (info) =>
          console.info(
            `[bounce-webhook] tenant=${info.tenantId} source=${info.source}` +
              ` channel=${info.channel} inserted=${info.inserted.toString()}` +
              ` duplicates=${info.duplicates.toString()}`,
          ),
        // The address never reaches the log: a suppression names a real person's mailbox, and the
        // refusal code is what an operator needs anyway.
        onRefusal: (info) =>
          console.warn(
            `[bounce-webhook] refused status=${info.status.toString()} reason=${info.reason}` +
              ` source=${info.source ?? "?"}`,
          ),
        onError: (err, target) =>
          console.error(`[bounce-webhook] store failure for tenant ${target.tenantId}`, err),
      });
      const inner = dispatchTarget;
      dispatchTarget = {
        dispatch: async (raw, body): Promise<RawHttpResponse> =>
          (await intercept(raw, body)) ?? (await inner.dispatch(raw, body)),
      };
      // The source list is derived rather than written out, because this line was already wrong
      // once: ADR-0329 added `twilio_voice` and the boot log kept announcing two sources while the
      // route served three. `BOUNCE_WEBHOOK_SOURCES` is what `SOURCE_SET` is built from, so the two
      // cannot disagree again.
      console.info(
        `[bounce-webhook] serving ${BOUNCE_WEBHOOK_PATH_PREFIX}/{tenantId}/` +
          `{${BOUNCE_WEBHOOK_SOURCES.join("|")}}`,
      );
    }
  }

  poller?.start();
  manifestPoller?.start();
  jobScheduler?.start();
  pruneScheduler?.start();
  deletionScheduler?.start();
  deliveryScheduler?.start();
  sloEnforcement?.scheduler.start();
  drReadiness?.scheduler.start();
  accessReviews?.scheduler.start();
  certification?.scheduler.start();
  checkpoints?.scheduler.start();
  integrityProof?.scheduler.start();
  auditPolicy?.refresher.start();
  metering?.flushScheduler?.start();
  stripeUsageSync?.scheduler.start();
  const listener = createNodeRequestListener(
    dispatchTarget,
    options.maxRequestBodyBytes,
    options.maxRequestBodyRoutes,
  );
  const server = createServer((req, res) => {
    void listener(req as unknown as NodeReqLike, res as unknown as NodeResLike);
  });
  await new Promise<void>((resolve) => server.listen(options.port, resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port;
  return {
    port,
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        poller?.stop();
        manifestPoller?.stop();
        jobScheduler?.stop();
        pruneScheduler?.stop();
        deletionScheduler?.stop();
        deliveryScheduler?.stop();
        sloEnforcement?.scheduler.stop();
        drReadiness?.scheduler.stop();
        accessReviews?.scheduler.stop();
        certification?.scheduler.stop();
        checkpoints?.scheduler.stop();
        integrityProof?.scheduler.stop();
        auditPolicy?.refresher.stop();
        metering?.flushScheduler?.stop();
        stripeUsageSync?.scheduler.stop();
        // Drain any queued audit-chain appends before closing, so no request's entry is lost on shutdown.
        void (auditChain?.observer.drain() ?? Promise.resolve()).finally(() => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      }),
  };
}

/**
 * Runs the `prune-links` maintenance sweep: loads the manifest, opens a Postgres
 * connection (standard PG* env vars), builds a JSONB `PostgresEntityStore`, and
 * prunes every m2m relation's dangling links for the given tenant. Always the
 * JSONB store — the column store never dangles. Closes the connection before
 * returning the aggregated `SweepReport`.
 */
export async function runPruneLinks(options: PruneOptions): Promise<MultiTenantSweepReport> {
  if (options.tenantId === null && !options.allTenants) {
    throw new Error("prune-links requires a tenant id or --all-tenants");
  }
  const manifest =
    options.manifestPath !== null
      ? loadManifestFromJson(await readFile(options.manifestPath, "utf8"))
      : await loadBuiltinPack(options.pack ?? "");
  const conn = createNodePgConnection(parsePgEnvConfig());
  try {
    const store = new PostgresEntityStore(conn, options.schema !== null ? { schema: options.schema } : {});
    const pairs = relationPairsFromManifest(manifest);
    const tenantIds = options.allTenants
      ? await new PostgresTenantSource(
          conn,
          options.schema !== null ? { schema: options.schema } : {},
        ).activeTenantIds()
      : [options.tenantId ?? ""];
    return await sweepDanglingLinksForTenants(store, pairs, tenantIds, { dryRun: options.dryRun });
  } finally {
    await conn.close();
  }
}

/**
 * Runs the `verify-chain` subcommand: opens a Postgres connection (standard PG* env vars), reads the
 * scope's forensic audit chain with a signer-free `PostgresChainLogReader`, and verifies hash-chain
 * integrity + per-entry signatures against the crypto-pg key registry. Closes the connection before
 * returning the report.
 */
export async function runVerifyChain(options: VerifyChainOptions): Promise<ChainVerificationReport> {
  const conn = createNodePgConnection(parsePgEnvConfig());
  try {
    const schemaOpt = options.schema !== null ? { schema: options.schema } : {};
    const reader = new PostgresChainLogReader(conn, schemaOpt);
    const registry = new PostgresKeyRegistry(conn);
    const tenantId = options.platform ? null : options.tenantId;
    if (options.fromCheckpoint) {
      const checkpoints = new PostgresChainCheckpointStore(conn, schemaOpt);
      return await verifyChainFromCheckpoint(reader, registry, checkpoints, tenantId);
    }
    return await verifyChainFull(reader, registry, tenantId);
  } finally {
    await conn.close();
  }
}
