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
  ingestStripeWebhook,
} from "@crossengin/operate-runtime-pg";

import type { PruneOptions, ServeOptions, VerifyChainOptions } from "./cli.js";
import type { RawHttpRequest, RawHttpResponse } from "./http.js";
import { loadBuiltinPack, loadManifestFromJson } from "./manifest-source.js";
import {
  isDanglingLinkPruner,
  relationPairsFromManifest,
  sweepDanglingLinksForTenants,
  type MultiTenantSweepReport,
} from "./link-sweep.js";
import { PruneScheduler } from "./prune-scheduler.js";
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
import { startDesignJob } from "./design-runner.js";
import { PostgresTenantCostStore } from "@crossengin/ai-architect-runtime-pg";
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

export const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;

class BodyTooLargeError extends Error {
  constructor(limit: number) {
    super(`request body exceeds ${limit.toString()} bytes`);
    this.name = "BodyTooLargeError";
  }
}

async function readBody(req: NodeReqLike): Promise<Uint8Array | null> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of req) {
    chunks.push(chunk);
    total += chunk.byteLength;
    if (total > MAX_REQUEST_BODY_BYTES) throw new BodyTooLargeError(MAX_REQUEST_BODY_BYTES);
  }
  if (total === 0) return null;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** The dispatch surface the Node listener needs — an `OperateHttpServer` or a per-tenant wrapper. */
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
): (req: NodeReqLike, res: NodeResLike) => Promise<void> {
  return async (req, res) => {
    try {
      const body = await readBody(req);
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
      if (err instanceof BodyTooLargeError) {
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
  // In-product AI Architect: /v1/ai routes let a tenant admin describe their business, get a
  // kernel-validated manifest proposal (meta.operate_tenant_manifests), and activate it as the
  // tenant's live system. The designer resolves from env (Anthropic → OpenAI, OPENAI_BASE_URL
  // for self-hosted OSS servers); with no provider the routes answer 503 but review/activate of
  // existing proposals still works. Activation invalidates the per-tenant gateway cache below.
  let manifestStore: PostgresTenantManifestStore | null = null;
  let gatewayCache: TenantGatewayCache | null = null;
  let manifestPoller: ManifestActivationPoller | null = null;
  if ((options.aiDesign || options.perTenantManifests) && conn !== undefined) {
    manifestStore = new PostgresTenantManifestStore(conn, schemaOpt);
  }
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
        "[ai-design] no AI provider configured (set ANTHROPIC_API_KEY or OPENAI_API_KEY); POST /v1/ai/design will answer 503",
      );
    }
    const store = manifestStore;
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
            maxUsdPerMonth: options.aiMaxUsdPerMonth ?? DEFAULT_AI_DESIGN_MAX_USD_PER_MONTH,
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
        ...(budget !== undefined ? { budget } : {}),
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
  const sloEnforcement =
    sloConfig !== null
      ? buildSloEnforcement(sloConfig, {
          onDecision: (d) =>
            console.info(
              `[slo] ${d.signal} ${d.kind} surface=${d.surface} slo=${d.sloId}` +
                (d.incidentId !== null ? ` incident=${d.incidentId}` : ""),
            ),
          onError: (err) => console.error("[slo] evaluation error", err),
        })
      : null;
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
  let auditConfig: AuditChainConfig | null = null;
  let auditPolicy: TenantAuditPolicyLifecycle | null = null;
  if (options.auditChainConfig !== null) {
    if (conn === undefined) {
      console.warn("[audit-chain] --audit-chain-config requires a Postgres store (--store pg); skipping");
    } else {
      auditConfig = await loadAuditChainConfig(options.auditChainConfig);
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
  // Per-tenant manifest serving: a tenant with an activated custom manifest gets a gateway
  // compiled from it (cached, ttl'd, invalidated on activation); everyone else — and any
  // request whose tenant can't be resolved — falls through to the default full-featured
  // server above. Tenant gateways carry auth + store + numbering + settings; the peripheral
  // observers (SLO, audit chain, metering, billing) stay on the default server for now.
  let dispatchTarget: DispatchTarget = httpServer;
  if (options.perTenantManifests && manifestStore !== null) {
    // The column-mapped store only knows the boot pack's entities (its column plans are derived
    // at boot), so custom-manifest tenants are served from the manifest-agnostic JSONB store
    // over the same connection instead of 500ing on every unplanned entity.
    const tenantStore: EntityStore =
      store instanceof ColumnMappedEntityStore && conn !== undefined
        ? new PostgresEntityStore(conn, schemaOpt)
        : store;
    gatewayCache = new TenantGatewayCache({
      source: manifestStore,
      // Tenant gateways mirror the default server's cross-cutting wiring — extra routes (AI
      // design, platform admin), the subscription gate, the residency guard, the per-request
      // observer chain (SLO burn/latency, usage metering, audit chain), write effects and job
      // invocation — so activating a custom manifest never drops a tenant out of enforcement,
      // billing, or the tamper-evident audit trail. Only the deployment-wide singletons that
      // are not per-request (the Stripe webhook + billing-portal routes) stay on the default
      // server, which still handles them for every tenant.
      build: (tenantManifest): OperateHttpServer =>
        buildOperateHttpServer({
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
        }).httpServer,
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
        onInvalidated: (tenantId) =>
          console.info(`[manifest-refresh] tenant ${tenantId} activated elsewhere; cache invalidated`),
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
  poller?.start();
  manifestPoller?.start();
  jobScheduler?.start();
  pruneScheduler?.start();
  sloEnforcement?.scheduler.start();
  drReadiness?.scheduler.start();
  accessReviews?.scheduler.start();
  certification?.scheduler.start();
  checkpoints?.scheduler.start();
  auditPolicy?.refresher.start();
  metering?.flushScheduler?.start();
  stripeUsageSync?.scheduler.start();
  const listener = createNodeRequestListener(dispatchTarget);
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
        sloEnforcement?.scheduler.stop();
        drReadiness?.scheduler.stop();
        accessReviews?.scheduler.stop();
        certification?.scheduler.stop();
        checkpoints?.scheduler.stop();
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
