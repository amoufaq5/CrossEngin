import { REGIONS } from "@crossengin/residency";

import { BUILTIN_PACK_NAMES } from "./manifest-source.js";

export type StoreKind = "memory" | "pg" | "pg-columns";

export interface ServeOptions {
  readonly port: number;
  readonly pack: string | null;
  readonly manifestPath: string | null;
  readonly store: StoreKind;
  readonly schema: string | null;
  readonly apiKeys: readonly string[];
  readonly jwksKeys: readonly string[];
  readonly jwksFile: string | null;
  readonly jwksUrl: string | null;
  readonly jwksRefreshMs: number | null;
  readonly jwtIssuer: string | null;
  readonly jwtAudience: string | null;
  /** Path to an offline Ed25519 license token file (on-prem subscription entitlement). */
  readonly licenseFile: string | null;
  /** The licensor's Ed25519 public key (base64) used to verify the license. */
  readonly licenseKey: string | null;
  /** Stripe webhook signing secret — enables POST /v1/webhooks/stripe (needs a pg store). */
  readonly stripeWebhookSecret: string | null;
  /** Path to a plan-catalog JSON ({plans:[...]}) — resolves record caps for webhook events. */
  readonly planCatalogFile: string | null;
  /** Stripe secret API key (sk_…) — enables POST /v1/meta/billing-portal (needs a pg store). */
  readonly stripeApiKey: string | null;
  /** Where Stripe returns the customer after the Billing Portal (required with --stripe-api-key). */
  readonly billingPortalReturnUrl: string | null;
  /** Cron scheduler tick interval (ms) — enables in-process scheduled-job enqueue (needs a pg store). */
  readonly scheduleMs: number | null;
  /** Tenant ids the cron scheduler fires jobs for (repeatable; one of this or --schedule-all-tenants). */
  readonly scheduleTenants: readonly string[];
  /** Fire the cron scheduler for every active tenant in meta.tenants (DB-backed source). */
  readonly scheduleAllTenants: boolean;
  /** Dangling-link prune sweep interval (ms) — periodically prunes every active tenant's dangling m2m links (needs --store pg). */
  readonly pruneLinksMs: number | null;
  /** Emit an entity-write event per create/update/delete/transition → event-triggered jobs (needs pg). */
  readonly emitEntityEvents: boolean;
  /** Optional namespace prefix for emitted entity-event names (e.g. `retail`). */
  readonly eventPrefix: string | null;
  /** Expose POST /v1/meta/jobs/invoke to run userInvoked jobs on demand (needs a pg store). */
  readonly enableJobInvoke: boolean;
  /** Roles permitted to call the job-invoke route (repeatable); empty ⇒ open to any tenant principal. */
  readonly jobInvokeRoles: readonly string[];
  /** Per-action role overrides for job-invoke as `action:role` specs (repeatable). */
  readonly jobInvokeActionRoles: readonly string[];
  /** Path to a marketplace pack-catalog JSON ({packs:[...]}) — enables the /v1/admin/packs routes (needs pg). */
  readonly packCatalogFile: string | null;
  /** Enable the third-party authoring routes (/v1/authoring/packs — submit/review/publish pack versions). Needs pg. */
  readonly marketplaceAuthoring: boolean;
  /** This instance's serving region id (from @crossengin/residency) — enables residency edge routing with --residency-file. */
  readonly region: string | null;
  /** Path to a residency file ({tenants:[{tenantId, profile}]}) — the tenant→region directory (requires --region). */
  readonly residencyFile: string | null;
  /** Use the Postgres tenant_residency_profiles table as the directory (requires --region + pg store). */
  readonly residencyStore: boolean;
  /** Path to a JSON SLO config ({alertPolicy, systemActorUserId, availability?, latency?}) — auto-enforces SLOs over the live request stream. */
  readonly sloConfig: string | null;
  /** Derive default availability + latency SLOs from the manifest (one per entity operation) — enforce without a hand-written config. Mutually exclusive with --slo-config. */
  readonly sloDefaults: boolean;
  /** Path to a partial SLO-defaults override ({alertPolicy?, systemActorUserId?, target tweaks, extra*?}) layered onto the derived defaults. Requires --slo-defaults. */
  readonly sloDefaultsOverride: string | null;
  /** Path to a JSON DR-readiness config ({tenantId?, intervalMs?, input:{runbooks,backups,replication}}) — periodically assesses + persists DR readiness (needs --store pg). */
  readonly drReadinessConfig: string | null;
  /** Path to a JSON access-reviews config ({systemActorUserId, campaigns, grants, principals}) — runs attestation campaigns on a schedule (needs --store pg). */
  readonly accessReviewsConfig: string | null;
  /** Source the review grants from this instance's configured API-key principals (their live role assignments) instead of the config's static grants. Requires --access-reviews-config. */
  readonly accessReviewsLiveGrants: boolean;
  /** Path to a JSON certification config ({tenantId?, intervalMs?, schema?, frameworks?, drReadiness?, accessReviews?, forensicChain?}) — periodically certifies each framework from live control-evidence and persists sealed reports (needs --store pg). */
  readonly certificationConfig: string | null;
  /** Path to a JSON audit-chain config ({schema?, actorReference?, privateKeyBase64, publicKeyBase64, outcomes?, operations?, sampleRate?, tenantOverrides?}) — appends a signed, hash-linked audit-log entry per request into the tamper-evident chain + registers its sealing key (needs --store pg). */
  readonly auditChainConfig: string | null;
  /** Path to a JSON checkpoint config ({schema?, intervalMs?, checkpointedBy?, tenants?, includePlatform?, allTenants?, tenantStatuses?}) — periodically anchors a chain checkpoint per tenant (or every active tenant when allTenants) so verification stays bounded (needs --store pg + --audit-chain-config). */
  readonly checkpointConfig: string | null;
  /** Refresh interval (ms) for live per-tenant audit sampling read from meta.operate_tenant_settings; enables the live policy cache (needs --store pg + --audit-chain-config). Null disables it. */
  readonly auditSamplingRefreshMs: number | null;
  /** Path to a JSON metering config ({meter?, source?, tenantSubscriptions, countStatuses?, flushIntervalMs?}) — meters the live request stream into billing usage (needs --store pg). */
  readonly meteringConfig: string | null;
  /** Path to a JSON Stripe usage-sync config ({intervalMs?, tenants, subscriptionItems}) — periodically reports persisted usage records to Stripe (needs --store pg + --stripe-api-key). */
  readonly stripeUsageSyncConfig: string | null;
  readonly defaultScheme: "http" | "https";
  readonly help: boolean;
  readonly version: boolean;
}

export class CliUsageError extends Error {}

const DEFAULT_PORT = 8787;

function takeValue(arg: string, next: string | undefined, flag: string): string {
  if (arg.includes("=")) return arg.slice(arg.indexOf("=") + 1);
  if (next === undefined) throw new CliUsageError(`flag ${flag} requires a value`);
  return next;
}

function isInline(arg: string): boolean {
  return arg.includes("=");
}

/**
 * Parses `operate-server` argv into `ServeOptions`. Supports `--flag value` and
 * `--flag=value`; `--api-key` repeats. Validation of mutual requirements
 * (exactly one manifest source, port range) happens here so the bin is a thin
 * dispatcher.
 */
export function parseServeArgs(argv: readonly string[]): ServeOptions {
  let port = DEFAULT_PORT;
  let pack: string | null = null;
  let manifestPath: string | null = null;
  let store: StoreKind = "memory";
  let schema: string | null = null;
  let defaultScheme: "http" | "https" = "http";
  const apiKeys: string[] = [];
  const jwksKeys: string[] = [];
  let jwksFile: string | null = null;
  let jwksUrl: string | null = null;
  let jwksRefreshMs: number | null = null;
  let jwtIssuer: string | null = null;
  let jwtAudience: string | null = null;
  let licenseFile: string | null = null;
  let licenseKey: string | null = null;
  let stripeWebhookSecret: string | null = null;
  let planCatalogFile: string | null = null;
  let stripeApiKey: string | null = null;
  let billingPortalReturnUrl: string | null = null;
  let scheduleMs: number | null = null;
  const scheduleTenants: string[] = [];
  let scheduleAllTenants = false;
  let pruneLinksMs: number | null = null;
  let emitEntityEvents = false;
  let eventPrefix: string | null = null;
  let enableJobInvoke = false;
  const jobInvokeRoles: string[] = [];
  const jobInvokeActionRoles: string[] = [];
  let packCatalogFile: string | null = null;
  let marketplaceAuthoring = false;
  let region: string | null = null;
  let residencyFile: string | null = null;
  let residencyStore = false;
  let sloConfig: string | null = null;
  let sloDefaults = false;
  let sloDefaultsOverride: string | null = null;
  let drReadinessConfig: string | null = null;
  let accessReviewsConfig: string | null = null;
  let accessReviewsLiveGrants = false;
  let certificationConfig: string | null = null;
  let auditChainConfig: string | null = null;
  let checkpointConfig: string | null = null;
  let auditSamplingRefreshMs: number | null = null;
  let meteringConfig: string | null = null;
  let stripeUsageSyncConfig: string | null = null;
  let help = false;
  let version = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    const next = argv[i + 1];
    const consumed = (): number => (isInline(arg) ? 0 : 1);
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--version" || arg === "-v") {
      version = true;
    } else if (arg === "--port" || arg.startsWith("--port=")) {
      const raw = takeValue(arg, next, "--port");
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0 || n > 65535) {
        throw new CliUsageError(`invalid --port: ${raw}`);
      }
      port = n;
      i += consumed();
    } else if (arg === "--pack" || arg.startsWith("--pack=")) {
      pack = takeValue(arg, next, "--pack");
      i += consumed();
    } else if (arg === "--manifest" || arg.startsWith("--manifest=")) {
      manifestPath = takeValue(arg, next, "--manifest");
      i += consumed();
    } else if (arg === "--store" || arg.startsWith("--store=")) {
      const raw = takeValue(arg, next, "--store");
      if (raw !== "memory" && raw !== "pg" && raw !== "pg-columns") {
        throw new CliUsageError(`invalid --store: ${raw} (memory|pg|pg-columns)`);
      }
      store = raw;
      i += consumed();
    } else if (arg === "--schema" || arg.startsWith("--schema=")) {
      schema = takeValue(arg, next, "--schema");
      i += consumed();
    } else if (arg === "--scheme" || arg.startsWith("--scheme=")) {
      const raw = takeValue(arg, next, "--scheme");
      if (raw !== "http" && raw !== "https") throw new CliUsageError(`invalid --scheme: ${raw} (http|https)`);
      defaultScheme = raw;
      i += consumed();
    } else if (arg === "--api-key" || arg.startsWith("--api-key=")) {
      apiKeys.push(takeValue(arg, next, "--api-key"));
      i += consumed();
    } else if (arg === "--jwks-key" || arg.startsWith("--jwks-key=")) {
      jwksKeys.push(takeValue(arg, next, "--jwks-key"));
      i += consumed();
    } else if (arg === "--jwks-file" || arg.startsWith("--jwks-file=")) {
      jwksFile = takeValue(arg, next, "--jwks-file");
      i += consumed();
    } else if (arg === "--jwks-url" || arg.startsWith("--jwks-url=")) {
      jwksUrl = takeValue(arg, next, "--jwks-url");
      i += consumed();
    } else if (arg === "--jwks-refresh-ms" || arg.startsWith("--jwks-refresh-ms=")) {
      const raw = takeValue(arg, next, "--jwks-refresh-ms");
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1000) throw new CliUsageError(`invalid --jwks-refresh-ms: ${raw} (>= 1000)`);
      jwksRefreshMs = n;
      i += consumed();
    } else if (arg === "--jwt-issuer" || arg.startsWith("--jwt-issuer=")) {
      jwtIssuer = takeValue(arg, next, "--jwt-issuer");
      i += consumed();
    } else if (arg === "--jwt-audience" || arg.startsWith("--jwt-audience=")) {
      jwtAudience = takeValue(arg, next, "--jwt-audience");
      i += consumed();
    } else if (arg === "--license" || arg.startsWith("--license=")) {
      licenseFile = takeValue(arg, next, "--license");
      i += consumed();
    } else if (arg === "--license-key" || arg.startsWith("--license-key=")) {
      licenseKey = takeValue(arg, next, "--license-key");
      i += consumed();
    } else if (arg === "--stripe-webhook-secret" || arg.startsWith("--stripe-webhook-secret=")) {
      stripeWebhookSecret = takeValue(arg, next, "--stripe-webhook-secret");
      i += consumed();
    } else if (arg === "--plan-catalog" || arg.startsWith("--plan-catalog=")) {
      planCatalogFile = takeValue(arg, next, "--plan-catalog");
      i += consumed();
    } else if (arg === "--stripe-api-key" || arg.startsWith("--stripe-api-key=")) {
      stripeApiKey = takeValue(arg, next, "--stripe-api-key");
      i += consumed();
    } else if (arg === "--billing-portal-return-url" || arg.startsWith("--billing-portal-return-url=")) {
      billingPortalReturnUrl = takeValue(arg, next, "--billing-portal-return-url");
      i += consumed();
    } else if (arg === "--schedule-ms" || arg.startsWith("--schedule-ms=")) {
      const raw = takeValue(arg, next, "--schedule-ms");
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1000) throw new CliUsageError(`invalid --schedule-ms: ${raw} (>= 1000)`);
      scheduleMs = n;
      i += consumed();
    } else if (arg === "--schedule-tenant" || arg.startsWith("--schedule-tenant=")) {
      scheduleTenants.push(takeValue(arg, next, "--schedule-tenant"));
      i += consumed();
    } else if (arg === "--schedule-all-tenants") {
      scheduleAllTenants = true;
    } else if (arg === "--prune-links-ms" || arg.startsWith("--prune-links-ms=")) {
      const raw = takeValue(arg, next, "--prune-links-ms");
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1000) throw new CliUsageError(`invalid --prune-links-ms: ${raw} (>= 1000)`);
      pruneLinksMs = n;
      i += consumed();
    } else if (arg === "--emit-entity-events") {
      emitEntityEvents = true;
    } else if (arg === "--event-prefix" || arg.startsWith("--event-prefix=")) {
      eventPrefix = takeValue(arg, next, "--event-prefix");
      i += consumed();
    } else if (arg === "--enable-job-invoke") {
      enableJobInvoke = true;
    } else if (arg === "--job-invoke-role" || arg.startsWith("--job-invoke-role=")) {
      jobInvokeRoles.push(takeValue(arg, next, "--job-invoke-role"));
      i += consumed();
    } else if (arg === "--job-invoke-action-role" || arg.startsWith("--job-invoke-action-role=")) {
      jobInvokeActionRoles.push(takeValue(arg, next, "--job-invoke-action-role"));
      i += consumed();
    } else if (arg === "--pack-catalog" || arg.startsWith("--pack-catalog=")) {
      packCatalogFile = takeValue(arg, next, "--pack-catalog");
      i += consumed();
    } else if (arg === "--marketplace-authoring") {
      marketplaceAuthoring = true;
    } else if (arg === "--region" || arg.startsWith("--region=")) {
      const raw = takeValue(arg, next, "--region");
      if (!(REGIONS as readonly string[]).includes(raw)) {
        throw new CliUsageError(`invalid --region: ${raw} (one of ${REGIONS.join(", ")})`);
      }
      region = raw;
      i += consumed();
    } else if (arg === "--residency-file" || arg.startsWith("--residency-file=")) {
      residencyFile = takeValue(arg, next, "--residency-file");
      i += consumed();
    } else if (arg === "--residency-store") {
      residencyStore = true;
    } else if (arg === "--slo-config" || arg.startsWith("--slo-config=")) {
      sloConfig = takeValue(arg, next, "--slo-config");
      i += consumed();
    } else if (arg === "--slo-defaults") {
      sloDefaults = true;
    } else if (arg === "--slo-defaults-override" || arg.startsWith("--slo-defaults-override=")) {
      sloDefaultsOverride = takeValue(arg, next, "--slo-defaults-override");
      i += consumed();
    } else if (arg === "--dr-readiness-config" || arg.startsWith("--dr-readiness-config=")) {
      drReadinessConfig = takeValue(arg, next, "--dr-readiness-config");
      i += consumed();
    } else if (arg === "--access-reviews-config" || arg.startsWith("--access-reviews-config=")) {
      accessReviewsConfig = takeValue(arg, next, "--access-reviews-config");
      i += consumed();
    } else if (arg === "--access-reviews-live-grants") {
      accessReviewsLiveGrants = true;
    } else if (arg === "--certification-config" || arg.startsWith("--certification-config=")) {
      certificationConfig = takeValue(arg, next, "--certification-config");
      i += consumed();
    } else if (arg === "--audit-chain-config" || arg.startsWith("--audit-chain-config=")) {
      auditChainConfig = takeValue(arg, next, "--audit-chain-config");
      i += consumed();
    } else if (arg === "--checkpoint-config" || arg.startsWith("--checkpoint-config=")) {
      checkpointConfig = takeValue(arg, next, "--checkpoint-config");
      i += consumed();
    } else if (arg === "--audit-sampling-refresh-ms" || arg.startsWith("--audit-sampling-refresh-ms=")) {
      const raw = takeValue(arg, next, "--audit-sampling-refresh-ms");
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1000) {
        throw new CliUsageError(`invalid --audit-sampling-refresh-ms: ${raw} (>= 1000)`);
      }
      auditSamplingRefreshMs = n;
      i += consumed();
    } else if (arg === "--metering-config" || arg.startsWith("--metering-config=")) {
      meteringConfig = takeValue(arg, next, "--metering-config");
      i += consumed();
    } else if (arg === "--stripe-usage-sync-config" || arg.startsWith("--stripe-usage-sync-config=")) {
      stripeUsageSyncConfig = takeValue(arg, next, "--stripe-usage-sync-config");
      i += consumed();
    } else {
      throw new CliUsageError(`unknown argument: ${arg}`);
    }
  }

  if (licenseFile !== null && licenseKey === null) {
    throw new CliUsageError("--license requires --license-key (the licensor's base64 Ed25519 public key)");
  }
  if (stripeWebhookSecret !== null && store === "memory") {
    throw new CliUsageError("--stripe-webhook-secret requires a Postgres store (--store pg or pg-columns)");
  }
  if (planCatalogFile !== null && stripeWebhookSecret === null) {
    throw new CliUsageError("--plan-catalog requires --stripe-webhook-secret (it feeds webhook record caps)");
  }
  if (stripeApiKey !== null && billingPortalReturnUrl === null && stripeUsageSyncConfig === null) {
    throw new CliUsageError(
      "--stripe-api-key requires --billing-portal-return-url or --stripe-usage-sync-config (nothing would use the key)",
    );
  }
  if (stripeApiKey !== null && store === "memory") {
    throw new CliUsageError("--stripe-api-key requires a Postgres store (--store pg or pg-columns)");
  }
  if (stripeUsageSyncConfig !== null && stripeApiKey === null) {
    throw new CliUsageError("--stripe-usage-sync-config requires --stripe-api-key");
  }
  if (scheduleMs !== null && store === "memory") {
    throw new CliUsageError("--schedule-ms requires a Postgres store (--store pg or pg-columns)");
  }
  if (scheduleMs !== null && scheduleTenants.length === 0 && !scheduleAllTenants) {
    throw new CliUsageError("--schedule-ms requires --schedule-tenant or --schedule-all-tenants");
  }
  if (scheduleTenants.length > 0 && scheduleAllTenants) {
    throw new CliUsageError("--schedule-tenant and --schedule-all-tenants are mutually exclusive");
  }
  if ((scheduleTenants.length > 0 || scheduleAllTenants) && scheduleMs === null) {
    throw new CliUsageError("--schedule-tenant / --schedule-all-tenants require --schedule-ms (the tick interval)");
  }
  if (pruneLinksMs !== null && store !== "pg") {
    throw new CliUsageError(
      "--prune-links-ms requires the JSONB Postgres store (--store pg); the column store cascades and can't dangle",
    );
  }
  if (emitEntityEvents && store === "memory") {
    throw new CliUsageError("--emit-entity-events requires a Postgres store (--store pg or pg-columns)");
  }
  if (eventPrefix !== null && !emitEntityEvents) {
    throw new CliUsageError("--event-prefix requires --emit-entity-events");
  }
  if (enableJobInvoke && store === "memory") {
    throw new CliUsageError("--enable-job-invoke requires a Postgres store (--store pg or pg-columns)");
  }
  if (jobInvokeRoles.length > 0 && !enableJobInvoke) {
    throw new CliUsageError("--job-invoke-role requires --enable-job-invoke");
  }
  if (jobInvokeActionRoles.length > 0 && !enableJobInvoke) {
    throw new CliUsageError("--job-invoke-action-role requires --enable-job-invoke");
  }
  for (const spec of jobInvokeActionRoles) {
    const idx = spec.indexOf(":");
    if (idx <= 0 || idx === spec.length - 1) {
      throw new CliUsageError(`invalid --job-invoke-action-role: ${spec} (expected action:role)`);
    }
  }
  if (marketplaceAuthoring && store === "memory") {
    throw new CliUsageError("--marketplace-authoring requires a Postgres store (--store pg or pg-columns)");
  }
  if (packCatalogFile !== null && store === "memory") {
    throw new CliUsageError("--pack-catalog requires a Postgres store (--store pg or pg-columns)");
  }
  if (residencyFile !== null && region === null) {
    throw new CliUsageError("--residency-file requires --region (this instance's serving region)");
  }
  if (residencyStore && region === null) {
    throw new CliUsageError("--residency-store requires --region (this instance's serving region)");
  }
  if (residencyStore && store === "memory") {
    throw new CliUsageError("--residency-store requires a Postgres store (--store pg or pg-columns)");
  }
  if (residencyStore && residencyFile !== null) {
    throw new CliUsageError("--residency-store and --residency-file are mutually exclusive");
  }
  if (sloDefaults && sloConfig !== null) {
    throw new CliUsageError("--slo-defaults and --slo-config are mutually exclusive");
  }
  if (sloDefaultsOverride !== null && !sloDefaults) {
    throw new CliUsageError("--slo-defaults-override requires --slo-defaults");
  }
  if (accessReviewsLiveGrants && accessReviewsConfig === null) {
    throw new CliUsageError("--access-reviews-live-grants requires --access-reviews-config");
  }

  if (
    (jwksKeys.length > 0 || jwksFile !== null || jwksUrl !== null) &&
    (jwtIssuer === null || jwtAudience === null)
  ) {
    throw new CliUsageError("--jwt-issuer and --jwt-audience are required when a JWKS is configured");
  }

  if (!help && !version) {
    if (pack === null && manifestPath === null) {
      throw new CliUsageError("one of --pack or --manifest is required");
    }
    if (pack !== null && manifestPath !== null) {
      throw new CliUsageError("--pack and --manifest are mutually exclusive");
    }
  }

  return {
    port,
    pack,
    manifestPath,
    store,
    schema,
    apiKeys,
    jwksKeys,
    jwksFile,
    jwksUrl,
    jwksRefreshMs,
    jwtIssuer,
    jwtAudience,
    licenseFile,
    licenseKey,
    stripeWebhookSecret,
    planCatalogFile,
    stripeApiKey,
    billingPortalReturnUrl,
    scheduleMs,
    scheduleTenants,
    scheduleAllTenants,
    pruneLinksMs,
    emitEntityEvents,
    eventPrefix,
    enableJobInvoke,
    jobInvokeRoles,
    jobInvokeActionRoles,
    packCatalogFile,
    marketplaceAuthoring,
    region,
    residencyFile,
    residencyStore,
    sloConfig,
    sloDefaults,
    sloDefaultsOverride,
    drReadinessConfig,
    accessReviewsLiveGrants,
    accessReviewsConfig,
    certificationConfig,
    auditChainConfig,
    checkpointConfig,
    auditSamplingRefreshMs,
    meteringConfig,
    stripeUsageSyncConfig,
    defaultScheme,
    help,
    version,
  };
}

/**
 * Options for the `prune-links` maintenance subcommand — sweep a tenant's
 * dangling m2m association links from the JSONB store's `operate_entity_links`
 * table. Always runs against the JSONB store (the column store's join-table FKs
 * cascade, so it never dangles), so there is no `--store` flag.
 */
export interface PruneOptions {
  readonly pack: string | null;
  readonly manifestPath: string | null;
  readonly schema: string | null;
  readonly tenantId: string | null;
  /** Sweep every active tenant from meta.tenants (mutually exclusive with --tenant). */
  readonly allTenants: boolean;
  /** Report what would be pruned without deleting anything. */
  readonly dryRun: boolean;
  readonly help: boolean;
}

const TENANT_ID_RE = /^[0-9a-fA-F-]{1,64}$/;

/**
 * Parses the argv *after* the `prune-links` subcommand token into
 * `PruneOptions`. Shares the manifest-source + `--schema` flags with `serve`
 * and adds a required `--tenant`.
 */
export function parsePruneArgs(argv: readonly string[]): PruneOptions {
  let pack: string | null = null;
  let manifestPath: string | null = null;
  let schema: string | null = null;
  let tenantId: string | null = null;
  let allTenants = false;
  let dryRun = false;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    const next = argv[i + 1];
    const consumed = (): number => (isInline(arg) ? 0 : 1);
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--pack" || arg.startsWith("--pack=")) {
      pack = takeValue(arg, next, "--pack");
      i += consumed();
    } else if (arg === "--manifest" || arg.startsWith("--manifest=")) {
      manifestPath = takeValue(arg, next, "--manifest");
      i += consumed();
    } else if (arg === "--schema" || arg.startsWith("--schema=")) {
      schema = takeValue(arg, next, "--schema");
      i += consumed();
    } else if (arg === "--tenant" || arg.startsWith("--tenant=")) {
      tenantId = takeValue(arg, next, "--tenant");
      i += consumed();
    } else if (arg === "--all-tenants") {
      allTenants = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else {
      throw new CliUsageError(`unknown argument: ${arg}`);
    }
  }

  if (!help) {
    if (pack === null && manifestPath === null) {
      throw new CliUsageError("one of --pack or --manifest is required");
    }
    if (pack !== null && manifestPath !== null) {
      throw new CliUsageError("--pack and --manifest are mutually exclusive");
    }
    if (tenantId === null && !allTenants) {
      throw new CliUsageError("prune-links requires --tenant <uuid> or --all-tenants");
    }
    if (tenantId !== null && allTenants) {
      throw new CliUsageError("--tenant and --all-tenants are mutually exclusive");
    }
    if (tenantId !== null && !TENANT_ID_RE.test(tenantId)) {
      throw new CliUsageError(`invalid --tenant: ${tenantId}`);
    }
  }

  return { pack, manifestPath, schema, tenantId, allTenants, dryRun, help };
}

export const pruneHelpText = `operate-server prune-links — remove a tenant's dangling m2m association links

Usage:
  operate-server prune-links --pack <name> --tenant <uuid> [--schema <name>]
  operate-server prune-links --manifest <file.json> --all-tenants [--dry-run]

Sweeps the JSONB store's operate_entity_links table, deleting links whose left
or right record no longer exists (the column store's join-table FKs cascade, so
this is JSONB-store-only). Reports pruned/kept per relation. Uses standard PG*
env vars for the connection.

Options:
  --pack <name>        Built-in vertical pack: ${BUILTIN_PACK_NAMES.join(", ")}
  --manifest <file>    Path to a resolved manifest JSON document
  --tenant <uuid>      Tenant to sweep (one of this or --all-tenants)
  --all-tenants        Sweep every active tenant in meta.tenants
                       (mutually exclusive with --tenant)
  --schema <name>      Postgres schema for the entity store (default meta)
  --dry-run            Report what would be pruned without deleting anything
  --help, -h           Show this help
`;

/**
 * Options for the `verify-chain` maintenance subcommand — read a scope's forensic audit chain (with a
 * signer-free reader) and verify hash-chain integrity + per-entry signatures against the crypto-pg key
 * registry. Read-only; uses standard PG* env vars.
 */
export interface VerifyChainOptions {
  readonly tenantId: string | null;
  /** Verify the platform (null-tenant) chain (mutually exclusive with --tenant). */
  readonly platform: boolean;
  readonly schema: string | null;
  readonly format: "human" | "json";
  /** Verify only the suffix after the latest persisted checkpoint (bounded), instead of from genesis. */
  readonly fromCheckpoint: boolean;
  readonly help: boolean;
}

/** Parses the argv *after* the `verify-chain` token. Requires exactly one of --tenant / --platform. */
export function parseVerifyChainArgs(argv: readonly string[]): VerifyChainOptions {
  let tenantId: string | null = null;
  let platform = false;
  let schema: string | null = null;
  let format: "human" | "json" = "human";
  let fromCheckpoint = false;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    const next = argv[i + 1];
    const consumed = (): number => (isInline(arg) ? 0 : 1);
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--tenant" || arg.startsWith("--tenant=")) {
      tenantId = takeValue(arg, next, "--tenant");
      i += consumed();
    } else if (arg === "--platform") {
      platform = true;
    } else if (arg === "--from-checkpoint") {
      fromCheckpoint = true;
    } else if (arg === "--schema" || arg.startsWith("--schema=")) {
      schema = takeValue(arg, next, "--schema");
      i += consumed();
    } else if (arg === "--format" || arg.startsWith("--format=")) {
      const raw = takeValue(arg, next, "--format");
      if (raw !== "human" && raw !== "json") throw new CliUsageError(`invalid --format: ${raw} (human|json)`);
      format = raw;
      i += consumed();
    } else {
      throw new CliUsageError(`unknown argument: ${arg}`);
    }
  }

  if (!help) {
    if (tenantId === null && !platform) {
      throw new CliUsageError("verify-chain requires --tenant <uuid> or --platform");
    }
    if (tenantId !== null && platform) {
      throw new CliUsageError("--tenant and --platform are mutually exclusive");
    }
    if (tenantId !== null && !TENANT_ID_RE.test(tenantId)) {
      throw new CliUsageError(`invalid --tenant: ${tenantId}`);
    }
  }

  return { tenantId, platform, schema, format, fromCheckpoint, help };
}

export const verifyChainHelpText = `operate-server verify-chain — verify a forensic audit chain's integrity + signatures

Usage:
  operate-server verify-chain --tenant <uuid> [--schema <name>] [--format human|json]
  operate-server verify-chain --platform [--format json]

Reads the scope's meta.forensic_chain_entries with a signer-free reader, folds the
hash chain from genesis, and verifies each entry's Ed25519 signature against the
public key resolved from the crypto-pg key registry (meta.crypto_keys). Read-only;
exits 0 when valid, 1 when integrity or a signature fails. Uses standard PG* env vars.

With --from-checkpoint, verifies only the suffix after the scope's latest persisted
checkpoint (bounded cost for long chains) — integrity anchored at the checkpoint's
root hash, signatures over just the suffix; falls back to a full verify when no
checkpoint exists yet.

Options:
  --tenant <uuid>      Tenant chain to verify (one of this or --platform)
  --platform           Verify the platform (null-tenant) chain
  --from-checkpoint    Verify only the suffix after the latest checkpoint (bounded)
  --schema <name>      Postgres schema for the chain (default meta)
  --format <fmt>       Output format: human (default) or json
  --help, -h           Show this help
`;

export const helpText = `operate-server — serve a resolved CrossEngin manifest as a live multi-tenant API

Usage:
  operate-server --pack <name> [options]
  operate-server --manifest <file.json> [options]

Subcommands:
  prune-links          Remove a tenant's dangling m2m links (see prune-links --help)

Manifest source (exactly one):
  --pack <name>        Built-in vertical pack: ${BUILTIN_PACK_NAMES.join(", ")}
  --manifest <file>    Path to a resolved manifest JSON document

Options:
  --port <n>           Port to listen on (default 8787)
  --store <kind>       Entity store: memory | pg (JSONB) | pg-columns (typed
                       per-entity tables) (default memory)
  --schema <name>      Postgres schema for the entity store (default meta;
                       public for pg-columns)
  --scheme <proto>     Default request scheme: http | https (default http)
  --api-key <spec>     API key binding key:role:tenant[:principalId] (repeatable)
  --jwks-key <spec>    JWKS public key kid:base64-ed25519-pubkey (repeatable)
  --jwks-file <file>   JSON [{kid, publicKeyBase64}, ...] of the IdP's keys
  --jwks-url <url>     Remote JWKS endpoint (cached, refetched on kid rotation)
  --jwks-refresh-ms <n> Background JWKS refresh interval (with --jwks-url; >=1000)
  --jwt-issuer <iss>   Expected JWT issuer (required with a JWKS)
  --jwt-audience <aud> Expected JWT audience (required with a JWKS)
  --license <file>     Offline Ed25519 license token file (on-prem entitlement)
  --license-key <b64>  Licensor Ed25519 public key, base64 (required with --license)
  --stripe-webhook-secret <s>  Enable POST /v1/webhooks/stripe → billing_subscriptions
                       (needs --store pg|pg-columns; also enforces the subscription gate)
  --plan-catalog <file>  Plan-catalog JSON {plans:[...]} resolving webhook record caps
                       by plan/price id (requires --stripe-webhook-secret)
  --stripe-api-key <sk>  Stripe secret key — enables POST /v1/meta/billing-portal
                       (needs --store pg|pg-columns + --billing-portal-return-url)
  --billing-portal-return-url <url>  Where Stripe returns the customer after the portal
  --schedule-ms <n>    Cron scheduler tick interval (ms, >=1000) — enqueues the
                       manifest's scheduled jobs into job_runs (needs --store pg|pg-columns)
  --schedule-tenant <uuid>  Tenant the scheduler fires jobs for (repeatable; one of this
                       or --schedule-all-tenants is required with --schedule-ms)
  --schedule-all-tenants  Fire the scheduler for every active tenant in meta.tenants
                       (DB-backed; mutually exclusive with --schedule-tenant)
  --prune-links-ms <n>  Dangling-link prune sweep interval (ms, >=1000) — periodically
                       prunes every active tenant's dangling m2m links (needs --store pg)
  --emit-entity-events  Emit a domain event per entity create/update/delete/transition,
                       firing event-triggered jobs into job_runs (needs --store pg|pg-columns)
  --event-prefix <p>   Namespace prefix for emitted event names (with --emit-entity-events)
  --enable-job-invoke  Expose POST /v1/meta/jobs/invoke to run userInvoked jobs on demand
                       (needs --store pg|pg-columns)
  --job-invoke-role <role>  Restrict job invocation to this role (repeatable; with
                       --enable-job-invoke). Omit to allow any authenticated tenant principal
  --job-invoke-action-role <action:role>  Per-action role override (repeatable); an action
                       listed here uses its own roles instead of --job-invoke-role
  --pack-catalog <file>  Marketplace pack-catalog JSON ({packs:[...]}) — enables the admin pack
                       routes GET /v1/admin/packs, POST /v1/admin/packs/install,
                       POST /v1/admin/packs/{id}/uninstall (needs --store pg|pg-columns)
  --marketplace-authoring  Enable the third-party authoring routes under /v1/authoring/packs —
                       submit a signed pack version, review it, publish/withdraw (needs --store pg)
  --region <id>        This instance's serving region (e.g. eu-central) — with --residency-file,
                       enables data-residency edge routing (redirect/deny by tenant home region)
  --residency-file <file>  Residency directory JSON ({tenants:[{tenantId, profile}]}) mapping each
                       tenant to its residency profile (requires --region)
  --residency-store    Use the Postgres tenant_residency_profiles table as the residency directory
                       (requires --region + --store pg|pg-columns; alternative to --residency-file)
  --slo-config <file>  JSON SLO config ({alertPolicy, systemActorUserId, availability?, latency?}) —
                       auto-enforces availability/latency SLOs over the live request stream, declaring
                       incidents + paging + optional flag rollback on a burn/latency breach
  --slo-defaults       Derive default availability + latency SLOs from the manifest (one per entity
                       operation, read vs. write targets) and enforce them — no config file needed.
                       Mutually exclusive with --slo-config
  --slo-defaults-override <file>  Partial override layered onto --slo-defaults ({alertPolicy?,
                       systemActorUserId?, target/interval tweaks, extraAvailability?, extraLatency?}) —
                       real paging + tuning without re-declaring every SLO. Requires --slo-defaults
  --dr-readiness-config <file>  JSON DR-readiness config ({tenantId?, intervalMs?, input:{runbooks,
                       backups, replication}}) — periodically folds live failover/drill executions into
                       the declared infra, assesses readiness, and persists a snapshot (needs --store pg)
  --access-reviews-config <file>  JSON access-reviews config ({systemActorUserId, campaigns, grants,
                       principals}) — runs attestation campaigns on a schedule: starts due campaigns,
                       generates items from the live grants, auto-revokes lapsed access (needs --store pg)
  --access-reviews-live-grants  Source the review grants from this instance's configured API-key
                       principals (their live role assignments) instead of the config's static grants.
                       Requires --access-reviews-config
  --certification-config <file>  JSON certification config ({tenantId?, intervalMs?, schema?, frameworks?,
                       drReadiness?, accessReviews?, forensicChain?}) — periodically certifies each
                       framework (SOC 2 / HIPAA / …) from live control-evidence (encryption coverage, DR
                       readiness, sealed access reviews, tamper-evident audit chain) and persists a sealed
                       report per framework (needs --store pg)
  --audit-chain-config <file>  JSON audit-chain config ({schema?, actorReference?, privateKeyBase64,
                       publicKeyBase64, outcomes?, operations?, sampleRate?, tenantOverrides?}) — appends a
                       signed, hash-linked audit-log entry per (sampled/filtered) request into the
                       tamper-evident chain and registers its sealing key in the key registry (needs
                       --store pg)
  --checkpoint-config <file>  JSON checkpoint config ({schema?, intervalMs?, checkpointedBy?, tenants?,
                       includePlatform?, allTenants?, tenantStatuses?}) — periodically anchors a chain
                       checkpoint per tenant (allTenants: every active tenant from the live registry,
                       tenantStatuses: which statuses to include) so verifying a long chain stays bounded
                       (needs --store pg + --audit-chain-config)
  --audit-sampling-refresh-ms <n>  Refresh interval (ms, >=1000) for live per-tenant audit sampling read
                       from meta.operate_tenant_settings (overrides the config map without a redeploy);
                       enables the live policy cache (needs --store pg + --audit-chain-config)
  --metering-config <file>  JSON metering config ({meter?, source?, tenantSubscriptions, countStatuses?,
                       flushIntervalMs?}) — meters each billable request into billing usage keyed by the
                       tenant's subscription, flushed to Postgres periodically (needs --store pg)
  --stripe-usage-sync-config <file>  JSON usage-sync config ({intervalMs?, tenants, subscriptionItems}) —
                       periodically reports persisted usage records to Stripe + marks them synced
                       (needs --store pg + --stripe-api-key)
  --help, -h           Show this help
  --version, -v        Print version

Auth: --api-key for dev opaque tokens; --jwks-* + --jwt-* to verify Bearer JWTs
(EdDSA) against an IdP's public keys — the verified claims (sub/scope/tenant_id)
become the principal. Postgres (--store pg): standard PG* env vars.
`;
