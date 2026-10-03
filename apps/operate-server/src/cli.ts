import { REGIONS } from "@crossengin/residency";

import {
  DEFAULT_DELETION_APPROVED_BY,
  DEFAULT_DELETION_EXECUTED_BY,
} from "./deletion-scheduler.js";
import { BUILTIN_PACK_NAMES } from "./manifest-source.js";
import { DEFAULT_ADMIN_ROLES } from "./recipient-resolver.js";
import { parseRequestBodyLimit } from "./request-body-limit.js";

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
  /** Notification delivery drain interval (ms) — sends every active tenant's queued dispatches (needs a pg store). */
  readonly notificationDrainMs: number | null;
  readonly bounceWebhook: boolean;
  readonly bounceTransientHours: number | null;
  /** Roles treated as a tenant's admins when resolving a `tenant_admins` notification audience. */
  readonly notificationAdminRoles: readonly string[];
  /** Roles permitted to read the whole tenant's notifications via `?scope=tenant`. */
  readonly notificationAuditRoles: readonly string[];
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
  /** Path to a JSON integrity-proof config ({schema?, intervalMs?, verifiedBy?, tenants?, includePlatform?, allTenants?, tenantStatuses?, auditRowLimit?, fromCheckpoint?, recordVerdict?, escalation?}) — periodically runs BOTH halves of the audit-integrity proof (row↔anchor and the chain's own links + signatures) per tenant, records the verdict in the chain, and with `escalation` declares an incident + pages once per compromised episode (needs --store pg + --audit-chain-config). */
  readonly integrityProofConfig: string | null;
  /** Refresh interval (ms) for live per-tenant audit sampling read from meta.operate_tenant_settings; enables the live policy cache (needs --store pg + --audit-chain-config). Null disables it. */
  readonly auditSamplingRefreshMs: number | null;
  /** Expose the platform super-admin tenant-management routes under /v1/platform (list/create/suspend/archive/reactivate tenants + stats over meta.tenants; needs --store pg|pg-columns). */
  readonly platformAdmin: boolean;
  /** Roles allowed to call the platform-admin routes (repeatable; default platform_admin). */
  readonly platformAdminRoles: readonly string[];
  /** Expose the in-product AI Architect routes under /v1/ai — describe a business, get a validated manifest proposal, activate it (over meta.operate_tenant_manifests; needs --store pg|pg-columns; the designer needs ANTHROPIC_API_KEY or OPENAI_API_KEY [+ optional OPENAI_BASE_URL]). Implies per-tenant manifest serving. */
  readonly aiDesign: boolean;
  /** Roles allowed to call the AI-design routes (repeatable; default erp_admin + platform_admin). */
  readonly aiDesignRoles: readonly string[];
  /** Serve each tenant's activated custom manifest from meta.operate_tenant_manifests, falling back to the boot pack (needs --store pg|pg-columns). */
  readonly perTenantManifests: boolean;
  /** Model override for the AI designer (defaults per provider). */
  readonly aiModel: string | null;
  /** Poll interval (ms) for cross-replica manifest-activation invalidation of the per-tenant gateway cache; null disables it (TTL-only). */
  readonly manifestRefreshMs: number | null;
  /** Per-tenant monthly USD ceiling on AI design spend; null uses the built-in default. */
  readonly aiMaxUsdPerMonth: number | null;
  /** Expose the platform design-review queue under /v1/platform/design-reviews (needs --store pg|pg-columns). */
  readonly designReview: boolean;
  readonly integrityVerdictRoutes: boolean;
  readonly integrityVerdictPlatformRoles: readonly string[];
  readonly integrityVerdictTenantRoles: readonly string[];
  /** Roles permitted to decide design reviews (default platform_admin). */
  readonly designReviewRoles: readonly string[];
  /** Require platform approval before a tenant can activate an AI proposal. */
  readonly requireDesignReview: boolean;
  /** Path to a JSON metering config ({meter?, source?, tenantSubscriptions, countStatuses?, flushIntervalMs?}) — meters the live request stream into billing usage (needs --store pg). */
  readonly meteringConfig: string | null;
  /** Path to a JSON Stripe usage-sync config ({intervalMs?, tenants, subscriptionItems}) — periodically reports persisted usage records to Stripe (needs --store pg + --stripe-api-key). */
  readonly stripeUsageSyncConfig: string | null;
  /** Per-request USD ceiling on AI design spend; null leaves the per-request gate off (the monthly one still applies). */
  readonly aiMaxRequestDollars: number | null;
  /** Expose the notification-template authoring routes under /v1/notification-templates (draft/review/approve/retire over meta.notification_templates; needs --store pg). */
  readonly notificationTemplateRoutes: boolean;
  /** Roles permitted to draft and submit a template (repeatable; default erp_admin). */
  readonly notificationTemplateAuthorRoles: readonly string[];
  /** Roles permitted to approve or reject a submitted template (repeatable; default platform_admin). Four-eyes: an approver may not approve their own draft. */
  readonly notificationTemplateApproverRoles: readonly string[];
  /** Roles permitted to author a template in a non-suppressible category (security_alert, transactional), which overrides a recipient's preferences and suppressions (repeatable; default none ⇒ nobody). */
  readonly notificationTemplateUnconditionalRoles: readonly string[];
  /** Expose the read-only audit-trail routes under /v1/audit (list + fetch entries with their anchors; needs --store pg + --audit-chain-config). */
  readonly auditReadRoutes: boolean;
  /** Roles permitted to read their own tenant's audit trail (repeatable; default erp_admin). */
  readonly auditReadTenantRoles: readonly string[];
  /** Roles permitted to read any tenant's audit trail (repeatable; default platform_admin). Elevates via app.platform_audit. */
  readonly auditReadPlatformRoles: readonly string[];
  /** Roles permitted to see pii/phi/regulated payload fields unredacted (repeatable; default none — everyone gets the redacted view). */
  readonly auditReadSensitiveRoles: readonly string[];
  /** Maximum queryable time range in days; null uses the route default. */
  readonly auditReadMaxRangeDays: number | null;
  /** Expose the tenant-schema survey and erasure under /v1/platform/tenants/{id} — the step that makes a tenant deletion true, since ADR-0314's per-tenant schema was never removed (needs --store pg + --audit-chain-config). */
  readonly tenantErasureRoutes: boolean;
  /** Roles permitted to survey and erase a tenant's schema (repeatable; default none ⇒ nobody). Four-eyes is enforced separately: the caller may not be the approver. */
  readonly tenantErasureRoles: readonly string[];
  /** Expose the GDPR Article 17 deletion flow under /v1/platform/tenants/{id}/delete — erase, attest, assemble, anchor and store a tombstone in ONE transaction, then retire the tenant row (needs --store pg + --audit-chain-config). The only route that reaches the `deleted` state. */
  readonly tenantDeletionRoutes: boolean;
  /** Roles permitted to delete a tenant (repeatable; default none ⇒ nobody). Separate from the erasure's grant: erasing a schema is a step this contains. */
  readonly tenantDeletionRoles: readonly string[];
  /** Roles permitted to read a tenant's tombstones (repeatable; defaults to the delete roles). Separable so an auditor can read receipts without being able to delete. */
  readonly tenantTombstoneReadRoles: readonly string[];
  /** Expose the GDPR deletion-request handle under /v1/platform/deletion-requests — submit, verify, reject and poll, so a caller holds a handle instead of an open connection while a large tenant's deletion runs (needs --store pg + --audit-chain-config). */
  readonly deletionRequestRoutes: boolean;
  /** Roles permitted to submit a deletion request (repeatable; default none ⇒ nobody). */
  readonly deletionRequestSubmitRoles: readonly string[];
  /** Roles permitted to verify or reject one (repeatable; default none ⇒ nobody). Separate from submitting: the verifier may not be the submitter. */
  readonly deletionRequestVerifyRoles: readonly string[];
  /** Roles permitted to poll a request handle (repeatable; defaults to the submit and verify roles together). */
  readonly deletionRequestReadRoles: readonly string[];
  /** Roles permitted to list stranded requests and reconcile one (repeatable; default none ⇒ nobody). Its own grant: the verdict comes from evidence, but authorising the inference from an absence of evidence is a judgement. */
  readonly deletionRequestReconcileRoles: readonly string[];
  /** How long a request must be `in_progress` before an absence of evidence is read as "never committed" (ms, default 3600000). Presence of evidence is conclusive at any age. */
  readonly deletionStrandedAfterMs: number | null;
  /** Days from submission to the Article 12(3) deadline (default 30, cap 90). Set per deployment rather than per request. */
  readonly deletionRequestDeadlineDays: number | null;
  /** Run verified deletion requests out of band every N ms (needs --tenant-deletion-routes' wiring). Off unless set; the first tick is one interval after boot, never at boot. */
  readonly deletionRunnerMs: number | null;
  /** The actor unattended deletions execute as (default `system:deletion-runner`). */
  readonly deletionRunnerExecutedBy: string | null;
  /** Who authorised unattended execution (default `system:retention-policy`). Must differ from the executor — four-eyes still applies. */
  readonly deletionRunnerApprovedBy: string | null;
  /** Requests the runner may take per tick (default 5). Each one is a whole tenant's data. */
  readonly deletionRunnerBatchSize: number | null;
  /** Maximum buffered request body, as bytes or a size like 25mb (default 10mb, floor 1kb, ceiling 1gb). */
  readonly maxRequestBodyBytes: number | null;
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
  let notificationDrainMs: number | null = null;
  let bounceWebhook = false;
  let bounceTransientHours: number | null = null;
  const notificationAdminRoles: string[] = [];
  const notificationAuditRoles: string[] = [];
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
  let integrityProofConfig: string | null = null;
  let auditSamplingRefreshMs: number | null = null;
  let platformAdmin = false;
  const platformAdminRoles: string[] = [];
  let aiDesign = false;
  const aiDesignRoles: string[] = [];
  let perTenantManifests = false;
  let aiModel: string | null = null;
  let manifestRefreshMs: number | null = null;
  let aiMaxUsdPerMonth: number | null = null;
  let designReview = false;
  let integrityVerdictRoutes = false;
  const integrityVerdictPlatformRoles: string[] = [];
  const integrityVerdictTenantRoles: string[] = [];
  const designReviewRoles: string[] = [];
  let requireDesignReview = false;
  let meteringConfig: string | null = null;
  let stripeUsageSyncConfig: string | null = null;
  let aiMaxRequestDollars: number | null = null;
  let notificationTemplateRoutes = false;
  const notificationTemplateAuthorRoles: string[] = [];
  const notificationTemplateApproverRoles: string[] = [];
  const notificationTemplateUnconditionalRoles: string[] = [];
  let auditReadRoutes = false;
  const auditReadTenantRoles: string[] = [];
  const auditReadPlatformRoles: string[] = [];
  const auditReadSensitiveRoles: string[] = [];
  let auditReadMaxRangeDays: number | null = null;
  let tenantErasureRoutes = false;
  const tenantErasureRoles: string[] = [];
  let tenantDeletionRoutes = false;
  const tenantDeletionRoles: string[] = [];
  const tenantTombstoneReadRoles: string[] = [];
  let deletionRequestRoutes = false;
  const deletionRequestSubmitRoles: string[] = [];
  const deletionRequestVerifyRoles: string[] = [];
  const deletionRequestReadRoles: string[] = [];
  const deletionRequestReconcileRoles: string[] = [];
  let deletionStrandedAfterMs: number | null = null;
  let deletionRequestDeadlineDays: number | null = null;
  let deletionRunnerMs: number | null = null;
  let deletionRunnerExecutedBy: string | null = null;
  let deletionRunnerApprovedBy: string | null = null;
  let deletionRunnerBatchSize: number | null = null;
  let maxRequestBodyBytes: number | null = null;
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
    } else if (arg === "--notification-drain-ms" || arg.startsWith("--notification-drain-ms=")) {
      const raw = takeValue(arg, next, "--notification-drain-ms");
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1000) throw new CliUsageError(`invalid --notification-drain-ms: ${raw} (>= 1000)`);
      notificationDrainMs = n;
      i += consumed();
    } else if (arg === "--bounce-webhook") {
      bounceWebhook = true;
    } else if (arg === "--bounce-transient-hours" || arg.startsWith("--bounce-transient-hours=")) {
      const raw = takeValue(arg, next, "--bounce-transient-hours");
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) throw new CliUsageError(`invalid --bounce-transient-hours: ${raw} (>= 1)`);
      bounceTransientHours = n;
      i += consumed();
    } else if (arg === "--notification-admin-role" || arg.startsWith("--notification-admin-role=")) {
      notificationAdminRoles.push(takeValue(arg, next, "--notification-admin-role"));
      i += consumed();
    } else if (arg === "--notification-audit-role" || arg.startsWith("--notification-audit-role=")) {
      notificationAuditRoles.push(takeValue(arg, next, "--notification-audit-role"));
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
    } else if (arg === "--integrity-proof-config" || arg.startsWith("--integrity-proof-config=")) {
      integrityProofConfig = takeValue(arg, next, "--integrity-proof-config");
      i += consumed();
    } else if (arg === "--audit-sampling-refresh-ms" || arg.startsWith("--audit-sampling-refresh-ms=")) {
      const raw = takeValue(arg, next, "--audit-sampling-refresh-ms");
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1000) {
        throw new CliUsageError(`invalid --audit-sampling-refresh-ms: ${raw} (>= 1000)`);
      }
      auditSamplingRefreshMs = n;
      i += consumed();
    } else if (arg === "--platform-admin") {
      platformAdmin = true;
    } else if (arg === "--platform-admin-role" || arg.startsWith("--platform-admin-role=")) {
      platformAdminRoles.push(takeValue(arg, next, "--platform-admin-role"));
      i += consumed();
    } else if (arg === "--ai-design") {
      aiDesign = true;
    } else if (arg === "--ai-design-role" || arg.startsWith("--ai-design-role=")) {
      aiDesignRoles.push(takeValue(arg, next, "--ai-design-role"));
      i += consumed();
    } else if (arg === "--per-tenant-manifests") {
      perTenantManifests = true;
    } else if (arg === "--ai-model" || arg.startsWith("--ai-model=")) {
      aiModel = takeValue(arg, next, "--ai-model");
      i += consumed();
    } else if (arg === "--audit-verdict-routes") {
      integrityVerdictRoutes = true;
    } else if (
      arg === "--audit-verdict-platform-role" ||
      arg.startsWith("--audit-verdict-platform-role=")
    ) {
      integrityVerdictPlatformRoles.push(takeValue(arg, next, "--audit-verdict-platform-role"));
      i += consumed();
      integrityVerdictRoutes = true;
    } else if (
      arg === "--audit-verdict-tenant-role" ||
      arg.startsWith("--audit-verdict-tenant-role=")
    ) {
      integrityVerdictTenantRoles.push(takeValue(arg, next, "--audit-verdict-tenant-role"));
      i += consumed();
      integrityVerdictRoutes = true;
    } else if (arg === "--design-review") {
      designReview = true;
    } else if (arg === "--design-review-role" || arg.startsWith("--design-review-role=")) {
      designReviewRoles.push(takeValue(arg, next, "--design-review-role"));
      i += consumed();
    } else if (arg === "--require-design-review") {
      requireDesignReview = true;
      designReview = true;
    } else if (arg === "--manifest-refresh-ms" || arg.startsWith("--manifest-refresh-ms=")) {
      const raw = takeValue(arg, next, "--manifest-refresh-ms");
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1000) throw new CliUsageError(`invalid --manifest-refresh-ms: ${raw} (>= 1000)`);
      manifestRefreshMs = n;
      i += consumed();
    } else if (arg === "--ai-max-usd-per-month" || arg.startsWith("--ai-max-usd-per-month=")) {
      const raw = takeValue(arg, next, "--ai-max-usd-per-month");
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) throw new CliUsageError(`invalid --ai-max-usd-per-month: ${raw} (> 0)`);
      aiMaxUsdPerMonth = n;
      i += consumed();
    } else if (arg === "--ai-max-request-dollars" || arg.startsWith("--ai-max-request-dollars=")) {
      const raw = takeValue(arg, next, "--ai-max-request-dollars");
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) {
        throw new CliUsageError(`invalid --ai-max-request-dollars: ${raw} (> 0)`);
      }
      aiMaxRequestDollars = n;
      i += consumed();
    } else if (arg === "--notification-template-routes") {
      notificationTemplateRoutes = true;
    } else if (
      arg === "--notification-template-author-role" ||
      arg.startsWith("--notification-template-author-role=")
    ) {
      notificationTemplateAuthorRoles.push(
        takeValue(arg, next, "--notification-template-author-role"),
      );
      i += consumed();
      notificationTemplateRoutes = true;
    } else if (
      arg === "--notification-template-approver-role" ||
      arg.startsWith("--notification-template-approver-role=")
    ) {
      notificationTemplateApproverRoles.push(
        takeValue(arg, next, "--notification-template-approver-role"),
      );
      i += consumed();
      notificationTemplateRoutes = true;
    } else if (
      arg === "--notification-template-unconditional-role" ||
      arg.startsWith("--notification-template-unconditional-role=")
    ) {
      notificationTemplateUnconditionalRoles.push(
        takeValue(arg, next, "--notification-template-unconditional-role"),
      );
      i += consumed();
      notificationTemplateRoutes = true;
    } else if (arg === "--audit-read-routes") {
      auditReadRoutes = true;
    } else if (arg === "--audit-read-tenant-role" || arg.startsWith("--audit-read-tenant-role=")) {
      auditReadTenantRoles.push(takeValue(arg, next, "--audit-read-tenant-role"));
      i += consumed();
      auditReadRoutes = true;
    } else if (
      arg === "--audit-read-platform-role" ||
      arg.startsWith("--audit-read-platform-role=")
    ) {
      auditReadPlatformRoles.push(takeValue(arg, next, "--audit-read-platform-role"));
      i += consumed();
      auditReadRoutes = true;
    } else if (
      arg === "--audit-read-sensitive-role" ||
      arg.startsWith("--audit-read-sensitive-role=")
    ) {
      auditReadSensitiveRoles.push(takeValue(arg, next, "--audit-read-sensitive-role"));
      i += consumed();
      auditReadRoutes = true;
    } else if (
      arg === "--audit-read-max-range-days" ||
      arg.startsWith("--audit-read-max-range-days=")
    ) {
      const raw = takeValue(arg, next, "--audit-read-max-range-days");
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) {
        throw new CliUsageError(`invalid --audit-read-max-range-days: ${raw} (>= 1)`);
      }
      auditReadMaxRangeDays = n;
      i += consumed();
    } else if (arg === "--tenant-erasure-routes") {
      tenantErasureRoutes = true;
    } else if (arg === "--tenant-erasure-role" || arg.startsWith("--tenant-erasure-role=")) {
      tenantErasureRoles.push(takeValue(arg, next, "--tenant-erasure-role"));
      i += consumed();
      tenantErasureRoutes = true;
    } else if (arg === "--tenant-deletion-routes") {
      tenantDeletionRoutes = true;
    } else if (arg === "--tenant-deletion-role" || arg.startsWith("--tenant-deletion-role=")) {
      tenantDeletionRoles.push(takeValue(arg, next, "--tenant-deletion-role"));
      i += consumed();
      tenantDeletionRoutes = true;
    } else if (
      arg === "--tenant-tombstone-read-role" ||
      arg.startsWith("--tenant-tombstone-read-role=")
    ) {
      tenantTombstoneReadRoles.push(takeValue(arg, next, "--tenant-tombstone-read-role"));
      i += consumed();
      tenantDeletionRoutes = true;
    } else if (arg === "--deletion-request-routes") {
      deletionRequestRoutes = true;
    } else if (
      arg === "--deletion-request-submit-role" ||
      arg.startsWith("--deletion-request-submit-role=")
    ) {
      deletionRequestSubmitRoles.push(takeValue(arg, next, "--deletion-request-submit-role"));
      i += consumed();
      deletionRequestRoutes = true;
    } else if (
      arg === "--deletion-request-verify-role" ||
      arg.startsWith("--deletion-request-verify-role=")
    ) {
      deletionRequestVerifyRoles.push(takeValue(arg, next, "--deletion-request-verify-role"));
      i += consumed();
      deletionRequestRoutes = true;
    } else if (
      arg === "--deletion-request-read-role" ||
      arg.startsWith("--deletion-request-read-role=")
    ) {
      deletionRequestReadRoles.push(takeValue(arg, next, "--deletion-request-read-role"));
      i += consumed();
      deletionRequestRoutes = true;
    } else if (
      arg === "--deletion-request-reconcile-role" ||
      arg.startsWith("--deletion-request-reconcile-role=")
    ) {
      deletionRequestReconcileRoles.push(takeValue(arg, next, "--deletion-request-reconcile-role"));
      i += consumed();
      deletionRequestRoutes = true;
    } else if (
      arg === "--deletion-stranded-after-ms" ||
      arg.startsWith("--deletion-stranded-after-ms=")
    ) {
      const raw = takeValue(arg, next, "--deletion-stranded-after-ms");
      const n = Number(raw);
      // A floor of a minute, because the whole point of the window is that it is far longer than any
      // pipeline run: a shorter one would read "still running" as "never committed".
      if (!Number.isInteger(n) || n < 60_000) {
        throw new CliUsageError(`invalid --deletion-stranded-after-ms: ${raw} (>= 60000)`);
      }
      deletionStrandedAfterMs = n;
      i += consumed();
    } else if (
      arg === "--deletion-request-deadline-days" ||
      arg.startsWith("--deletion-request-deadline-days=")
    ) {
      const raw = takeValue(arg, next, "--deletion-request-deadline-days");
      const n = Number(raw);
      // Article 12(3) caps the extension at three months, and the contract refuses a longer one — so
      // the flag refuses it here, where the message can say why.
      if (!Number.isInteger(n) || n < 1 || n > 90) {
        throw new CliUsageError(
          `invalid --deletion-request-deadline-days: ${raw} (1..90; GDPR Article 12(3) caps it)`,
        );
      }
      deletionRequestDeadlineDays = n;
      i += consumed();
    } else if (arg === "--deletion-runner-ms" || arg.startsWith("--deletion-runner-ms=")) {
      const raw = takeValue(arg, next, "--deletion-runner-ms");
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1000) {
        throw new CliUsageError(`invalid --deletion-runner-ms: ${raw} (>= 1000)`);
      }
      deletionRunnerMs = n;
      i += consumed();
    } else if (
      arg === "--deletion-runner-executed-by" ||
      arg.startsWith("--deletion-runner-executed-by=")
    ) {
      deletionRunnerExecutedBy = takeValue(arg, next, "--deletion-runner-executed-by");
      i += consumed();
    } else if (
      arg === "--deletion-runner-approved-by" ||
      arg.startsWith("--deletion-runner-approved-by=")
    ) {
      deletionRunnerApprovedBy = takeValue(arg, next, "--deletion-runner-approved-by");
      i += consumed();
    } else if (
      arg === "--deletion-runner-batch-size" ||
      arg.startsWith("--deletion-runner-batch-size=")
    ) {
      const raw = takeValue(arg, next, "--deletion-runner-batch-size");
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 100) {
        throw new CliUsageError(`invalid --deletion-runner-batch-size: ${raw} (1..100)`);
      }
      deletionRunnerBatchSize = n;
      i += consumed();
    } else if (arg === "--max-request-body" || arg.startsWith("--max-request-body=")) {
      const raw = takeValue(arg, next, "--max-request-body");
      const parsed = parseRequestBodyLimit(raw);
      if (!parsed.ok) throw new CliUsageError(`invalid --max-request-body: ${parsed.reason}`);
      maxRequestBodyBytes = parsed.bytes;
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
  if (platformAdmin && store === "memory") {
    throw new CliUsageError("--platform-admin requires a Postgres store (--store pg or pg-columns)");
  }
  if ((aiDesign || perTenantManifests) && store === "memory") {
    throw new CliUsageError("--ai-design / --per-tenant-manifests require a Postgres store (--store pg or pg-columns)");
  }
  if (tenantDeletionRoutes && store === "memory") {
    throw new CliUsageError(
      "--tenant-deletion-routes requires a Postgres store (--store pg or pg-columns)",
    );
  }
  if (tenantErasureRoutes && store === "memory") {
    throw new CliUsageError(
      "--tenant-erasure-routes requires a Postgres store (--store pg or pg-columns)",
    );
  }
  if ((deletionRequestRoutes || deletionRunnerMs !== null) && store === "memory") {
    throw new CliUsageError(
      "--deletion-request-routes / --deletion-runner-ms require a Postgres store (--store pg or pg-columns)",
    );
  }
  if (
    (deletionRunnerExecutedBy ?? DEFAULT_DELETION_EXECUTED_BY) ===
    (deletionRunnerApprovedBy ?? DEFAULT_DELETION_APPROVED_BY)
  ) {
    // Compared against the *resolved* pair, not the flags: passing only
    // `--deletion-runner-executed-by system:retention-policy` would otherwise pass here and throw at
    // the runner's construction, which is at boot. Four-eyes holds for an unattended deletion exactly
    // as it does for a human one.
    throw new CliUsageError(
      "--deletion-runner-executed-by must differ from --deletion-runner-approved-by (four-eyes principle)",
    );
  }
  if ((auditReadRoutes || notificationTemplateRoutes) && store === "memory") {
    // Refused here rather than warned about at boot, like every sibling above: both surfaces read and
    // write `meta.*` tables, so on the memory store they cannot work at all — and `--audit-read-routes`
    // in particular would otherwise start a server that silently serves none of what was asked for.
    throw new CliUsageError(
      "--audit-read-routes / --notification-template-routes require a Postgres store (--store pg or pg-columns)",
    );
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
  if (notificationDrainMs !== null && store === "memory") {
    throw new CliUsageError("--notification-drain-ms requires a Postgres store (--store pg or pg-columns)");
  }
  if (bounceWebhook && store === "memory") {
    throw new CliUsageError("--bounce-webhook requires a Postgres store (--store pg or pg-columns)");
  }
  if (bounceTransientHours !== null && !bounceWebhook) {
    throw new CliUsageError("--bounce-transient-hours requires --bounce-webhook");
  }
  if (notificationAdminRoles.length > 0 && notificationDrainMs === null) {
    throw new CliUsageError("--notification-admin-role requires --notification-drain-ms (the drain interval)");
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
    notificationDrainMs,
    bounceWebhook,
    bounceTransientHours,
    notificationAdminRoles:
      notificationAdminRoles.length > 0 ? notificationAdminRoles : DEFAULT_ADMIN_ROLES,
    notificationAuditRoles,
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
    integrityProofConfig,
    auditSamplingRefreshMs,
    platformAdmin,
    platformAdminRoles: platformAdminRoles.length > 0 ? platformAdminRoles : ["platform_admin"],
    aiDesign,
    aiDesignRoles: aiDesignRoles.length > 0 ? aiDesignRoles : ["erp_admin", "platform_admin"],
    perTenantManifests: perTenantManifests || aiDesign,
    aiModel,
    manifestRefreshMs,
    aiMaxUsdPerMonth,
    designReview,
    integrityVerdictRoutes,
    integrityVerdictPlatformRoles,
    integrityVerdictTenantRoles,
    designReviewRoles: designReviewRoles.length > 0 ? designReviewRoles : ["platform_admin"],
    requireDesignReview,
    meteringConfig,
    stripeUsageSyncConfig,
    aiMaxRequestDollars,
    notificationTemplateRoutes,
    notificationTemplateAuthorRoles:
      notificationTemplateAuthorRoles.length > 0 ? notificationTemplateAuthorRoles : ["erp_admin"],
    notificationTemplateApproverRoles:
      notificationTemplateApproverRoles.length > 0
        ? notificationTemplateApproverRoles
        : ["platform_admin"],
    // No default, deliberately: authoring in a category that ignores a recipient's opt-out is how a
    // marketing blast reaches someone who unsubscribed, so it is nobody's privilege until granted.
    notificationTemplateUnconditionalRoles,
    auditReadRoutes,
    auditReadTenantRoles: auditReadTenantRoles.length > 0 ? auditReadTenantRoles : ["erp_admin"],
    auditReadPlatformRoles:
      auditReadPlatformRoles.length > 0 ? auditReadPlatformRoles : ["platform_admin"],
    // No default: an empty list means every reader gets the redacted view, which is the correct
    // default for a surface whose whole point is that reading pii is a separate, granted privilege.
    auditReadSensitiveRoles,
    auditReadMaxRangeDays,
    tenantErasureRoutes,
    // No default: irreversibly destroying a tenant's business data is nobody's privilege until it is
    // granted by name, not even the platform admin's by inheritance.
    tenantErasureRoles,
    tenantDeletionRoutes,
    // No default: this is the most destructive act the platform can perform, so it is nobody's
    // privilege until granted by name.
    tenantDeletionRoles,
    tenantTombstoneReadRoles,
    deletionRequestRoutes,
    // No defaults, for the same reason as the delete grant above: submitting a request for a tenant's
    // erasure, and attesting that the subject's identity was checked, are each granted by name.
    deletionRequestSubmitRoles,
    deletionRequestVerifyRoles,
    deletionRequestReadRoles,
    // No default: listing every tenant whose deletion is in doubt, and resolving one, is granted by
    // name like the rest of this flow.
    deletionRequestReconcileRoles,
    deletionStrandedAfterMs,
    deletionRequestDeadlineDays,
    deletionRunnerMs,
    deletionRunnerExecutedBy,
    deletionRunnerApprovedBy,
    deletionRunnerBatchSize,
    maxRequestBodyBytes,
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
  --notification-drain-ms <n>  Notification delivery drain interval (ms, >=1000) — sends every
                       active tenant's queued dispatches, applying per-recipient preferences
                       and suppressions, and records an attempt per recipient
                       (needs --store pg|pg-columns)
  --bounce-webhook     Serve POST /v1/notifications/bounces/{tenantId}/{ses|twilio}, which
                       records provider bounces and complaints as suppressions. Needs
                       NOTIFICATION_BOUNCE_SECRET in the environment (>=32 chars); the
                       per-tenant key is HMAC-SHA256(secret, "bounce-webhook:"+tenantId),
                       which the signing edge must derive the same way
                       (needs --store pg|pg-columns)
  --bounce-transient-hours <n>  How long a soft/transient bounce suppresses an address.
                       Omitted, a transient bounce suppresses nothing
                       (needs --bounce-webhook)
  --notification-admin-role <r>  Role treated as a tenant admin when resolving a
                       tenant_admins audience (repeatable; default erp_admin +
                       tenant_admin + platform_admin)
  --notification-audit-role <r>  Role permitted to read the whole tenant's notifications
                       via ?scope=tenant (repeatable; nobody by default — the inbox is
                       per-recipient)
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
  --platform-admin     Expose the platform super-admin routes under /v1/platform — list/create/suspend/
                       archive/reactivate tenants + stats over meta.tenants (needs --store pg|pg-columns)
  --platform-admin-role <role>  Role allowed to call the /v1/platform routes (repeatable; default
                       platform_admin). Fail-closed: only these roles reach tenant management
  --ai-design          Expose the in-product AI Architect under /v1/ai — POST a business description,
                       get a validated manifest proposal, activate it as the tenant's live system
                       (needs --store pg|pg-columns + ANTHROPIC_API_KEY or OPENAI_API_KEY, optional
                       OPENAI_BASE_URL for a self-hosted OSS model). Implies --per-tenant-manifests
  --ai-design-role <role>  Role allowed to call the /v1/ai routes (repeatable; default erp_admin +
                       platform_admin). Fail-closed
  --ai-model <id>      Model override for the AI designer (defaults per provider; passed through
                       verbatim to a self-hosted endpoint)
  --audit-verdict-routes  Enable GET /v1/audit-integrity/verdicts — the readable projection of each
                       audit-integrity pass (needs --store pg|pg-columns)
  --audit-verdict-platform-role <role>  Role granted the cross-tenant view, which includes the
                       platform chain's own verdicts (repeatable). Fail-closed: none ⇒ nobody
  --audit-verdict-tenant-role <role>  Role granted its OWN tenant's verdicts (repeatable).
                       Fail-closed: none ⇒ nobody
  --manifest-refresh-ms <n>  Poll interval (ms, >=1000) invalidating the per-tenant gateway
                       cache when another replica activates a manifest (default: TTL only)
  --ai-max-usd-per-month <n>  Per-tenant monthly USD ceiling on AI design spend
  --ai-max-request-dollars <n>  Per-REQUEST USD ceiling, refused before the call rather than
                       discovered after it. The monthly ceiling still applies; this bounds one
                       prompt. Off by default
  --notification-template-routes  Expose template authoring under /v1/notification-templates —
                       draft, submit, approve/reject, retire (needs --store pg)
  --notification-template-author-role <r>  Role permitted to draft and submit (repeatable;
                       default erp_admin)
  --notification-template-approver-role <r>  Role permitted to approve or reject (repeatable;
                       default platform_admin). Four-eyes: nobody approves their own draft
  --notification-template-unconditional-role <r>  Role permitted to author a template in a
                       non-suppressible category (security_alert, transactional), which overrides a
                       recipient's preferences AND suppressions (repeatable). Default none
  --audit-read-routes  Expose the read-only audit trail under /v1/audit — list and fetch entries
                       with their chain anchors (needs --store pg + --audit-chain-config)
  --audit-read-tenant-role <r>  Role permitted to read its OWN tenant's trail (repeatable;
                       default erp_admin). Fail-closed
  --audit-read-platform-role <r>  Role permitted to read ANY tenant's trail (repeatable; default
                       platform_admin). Elevates via app.platform_audit, which is SELECT-only
  --audit-read-sensitive-role <r>  Role permitted to see pii/phi/regulated payload fields
                       unredacted (repeatable). Default none: every reader gets the redacted view
  --audit-read-max-range-days <n>  Largest queryable time range in days (>=1)
  --tenant-erasure-routes  Expose GET /v1/platform/tenants/{id}/schema and POST .../erase-schema —
                       survey exactly what a tenant's own schema holds, then drop it. ADR-0314 gave a
                       tenant its own schema and nothing removed it, so a GDPR Article 17 tombstone
                       was signed over data that survived. Needs --store pg + --audit-chain-config:
                       an erasure is recorded before it is reported, and an unrecorded one is refused
  --tenant-erasure-role <r>  Role permitted to survey and erase (repeatable). Default none ⇒ nobody.
                       Four-eyes is separate and not overridable: the caller may not be the approver
  --tenant-deletion-routes  Expose POST /v1/platform/tenants/{id}/delete and GET .../tombstones —
                       the GDPR Article 17 flow. Erase the tenant's schema, attest what was
                       destroyed, assemble and anchor a tombstone, store it: all in ONE transaction,
                       so no outcome destroys data without a proof of it. Then retire the tenant
                       row, in that order, because the anchor references meta.tenants. The only
                       route that reaches 'deleted'. Needs --store pg + --audit-chain-config
  --tenant-deletion-role <r>  Role permitted to delete a tenant (repeatable). Default none ⇒
                       nobody. Separate from --tenant-erasure-role: erasing a schema is a step this
                       contains. Four-eyes is not overridable — the caller may not be the approver
  --tenant-tombstone-read-role <r>  Role permitted to read a tenant's tombstones (repeatable;
                       defaults to the delete roles), so an auditor can read receipts without
                       being able to delete
  --deletion-request-routes  Expose the GDPR deletion-request handle under /v1/platform/
                       deletion-requests — POST to submit, POST .../verify, POST .../reject, GET
                       .../{id} to poll. The caller holds a handle instead of an open connection
                       while a large tenant's deletion runs (needs --store pg + --audit-chain-config)
  --deletion-request-submit-role <r>  Role permitted to submit a deletion request (repeatable).
                       Default none ⇒ every request refused
  --deletion-request-verify-role <r>  Role permitted to verify or reject one (repeatable). Default
                       none ⇒ refused. Separate from submitting: the verifier may not be the submitter
  --deletion-request-read-role <r>  Role permitted to poll a handle (repeatable; defaults to the
                       submit and verify roles together)
  --deletion-request-reconcile-role <r>  Role permitted to GET .../stranded and POST
                       .../{id}/reconcile — resolving a request a failed run left in_progress, from
                       the tombstone evidence (repeatable). Default none => nobody
  --deletion-stranded-after-ms <n>  How long a request must sit in_progress before an ABSENCE of
                       evidence is read as "never committed" (>=60000, default 3600000). A tombstone
                       naming the request is conclusive at any age; an absence never is
  --deletion-request-deadline-days <n>  Days from submission to the Article 12(3) deadline
                       (default 30, max 90). Per deployment, not per request
  --deletion-runner-ms <n>  Run verified deletion requests out of band every n ms (>=1000). The
                       first tick is one interval AFTER boot, never at boot: the work is
                       irreversible and a boot is when a misconfiguration is most likely
  --deletion-runner-executed-by <a>  Actor unattended deletions execute as (default
                       system:deletion-runner)
  --deletion-runner-approved-by <a>  Who authorised unattended execution (default
                       system:retention-policy). Must differ from the executor
  --deletion-runner-batch-size <n>  Requests the runner may take per tick (1..100, default 5).
                       Each one is a whole tenant's data, and they run serially
  --max-request-body <size>  Largest buffered request body — bytes or a size like 25mb (default
                       10mb, floor 1kb, ceiling 1gb). Not disableable; out-of-band values are
                       refused at boot rather than clamped
  --design-review      Expose the platform design-review queue (/v1/platform/design-reviews)
  --design-review-role <r>  Role permitted to decide reviews (repeatable; default platform_admin)
  --require-design-review   Require platform approval before a tenant activates a proposal
                       (implies --design-review)
  --per-tenant-manifests  Serve each tenant's activated custom manifest (meta.operate_tenant_manifests),
                       falling back to the boot pack for tenants without one (needs --store pg|pg-columns)
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
  --integrity-proof-config <file>  JSON integrity-proof config ({schema?, intervalMs?, verifiedBy?,
                       tenants?, includePlatform?, allTenants?, tenantStatuses?, auditRowLimit?,
                       fromCheckpoint?, recordVerdict?, escalation?}) — periodically runs BOTH
                       halves of the audit-integrity proof (each audit row against its anchor, and
                       the chain's own links + signatures), checks for chain truncation against the
                       latest checkpoint, and appends the verdict to the chain as a security_event.
                       With escalation ({severity?, category?, declaredBy?, alertPolicy}) a
                       compromised verdict declares an incident and pages once per episode
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
