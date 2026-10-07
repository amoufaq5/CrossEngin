import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";

import type { PipelineExecution } from "@crossengin/api-gateway";
import {
  PostgresIdempotencyStore,
  PostgresPipelineExecutionStore,
  PostgresRateLimitChecker,
  probeDecisionSchema,
  surveyRoutePolicies,
} from "@crossengin/api-gateway-pg";
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
  encryptedEntityNames,
  eraseTenantSchema,
  eraseTenantSchemaWithin,
  ingestStripeWebhook,
  surveyTenantSchemaWithCollateral,
  type ColumnEncryptionKeySource,
} from "@crossengin/operate-runtime-pg";

import type { PruneOptions, ReplayOptions, ServeOptions, VerifyChainOptions } from "./cli.js";
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
import { DrReplayer, PostgresDrDrillStore, PostgresDrFailoverStore } from "@crossengin/dr-runtime-pg";
import {
  PostgresSloEnforcementActionStore,
  SloEnforcementReplayer,
} from "@crossengin/observability-runtime-pg";
import {
  AccessReviewReplayer,
  PostgresAccessReviewCampaignStore,
  PostgresAccessReviewDecisionStore,
  PostgresAccessReviewItemStore,
} from "@crossengin/access-reviews-runtime-pg";
import { GatewayReplayer } from "@crossengin/api-gateway-pg";
import { replayIncidents } from "@crossengin/incident-response-runtime-pg";
import {
  REPLAY_SUBSYSTEMS,
  runReplaySections,
  subsystemsServedBy,
  summarizeReplay,
  type ReplayCoverage,
  type ReplayReport,
  type ReplaySection,
  type ReplaySubsystem,
  type ReplaySubsystemRunner,
} from "./replay.js";
import { PruneScheduler } from "./prune-scheduler.js";
import {
  CAPTURE_FK_HINT,
  GatewayExecutionCaptureObserver,
  describeCaptureCost,
} from "./gateway-execution-capture.js";
import {
  COLUMN_ENCRYPTION_SECRET_VAR,
  buildColumnKeySource,
  decidePhiStorage,
  formatPhiStorageDecision,
  surveyPhiFields,
} from "./column-encryption.js";
import {
  ALLOW_CURSOR_DISCLOSURE_FLAG,
  CURSOR_ENCRYPTION_SECRET_VAR,
  formatCursorSealing,
  resolveCursorSealing,
} from "./cursor-encryption.js";
import {
  CLASSIFIED_WRITE_MASK_FLAG,
  buildSensitiveFieldPolicy,
  checkClassifiedWriteMask,
  formatSensitiveFieldSurvey,
  surveySensitiveFields,
  type SensitiveFieldDeclaration,
} from "./sensitive-field-policy.js";
import {
  AbacObligationsUnevaluable,
  checkAbacObligations,
  formatAbacObligationCheck,
} from "./abac-obligations.js";
import {
  ABAC_POLICY_FLAG,
  buildAbacBatchEvaluator,
  buildAbacEvaluator,
  formatAbacPolicies,
  parseAbacPolicies,
  recordBearingPolicyKeys,
} from "./abac-policy.js";
import {
  CachedAbacAttributeDirectory,
  abacAttributeDirectoryFromStore,
} from "./abac-attributes.js";
import {
  IDEMPOTENCY_FK_HINT,
  IDEMPOTENCY_GUARANTEE,
  IdempotencyPruneScheduler,
  ReportingIdempotencyStore,
} from "./gateway-idempotency.js";
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
import {
  PostgresJobRunEngine,
  PostgresWorkflowDefinitionStore,
  buildJobHandlerRegistry,
  buildPersistentEngine,
  probeJobQueueVisibility,
  requestJobCancellation,
  surveyManifestWorkflows,
  type JobHandlerProvider,
  type PersistentEngineBundle,
} from "@crossengin/workflow-runtime-pg";
import {
  DeletionReconciler,
  DeletionRunner,
  PostgresDeletionRequestStore,
  PostgresLifecycleEventStore,
  PostgresTombstoneStore,
  deleteTenantAtomically,
  lifecycleTrailGaps,
  probeLifecycleTrail,
} from "@crossengin/tenant-lifecycle-pg";
import {
  DeletionCapabilitiesSchema,
  type DeletionCapabilities,
} from "@crossengin/tenant-lifecycle";
import type { ExtraGatewayRoute, WriteMaskMode } from "@crossengin/operate-runtime";
import { buildMarketplaceAdminRoutes, loadPackCatalog } from "./marketplace-admin.js";
import { buildMarketplaceAuthoringRoutes } from "./marketplace-authoring.js";
import { PostgresTenantStore, buildPlatformAdminRoutes } from "./platform-admin.js";
import {
  CachedTenantStatusDirectory,
  surveyTenantStatusCoverage,
  tenantStatusDirectoryFromStore,
  type TenantStatusGateOptions,
} from "./tenant-status-gate.js";
import { buildTenantStateMover } from "./tenant-state-mover.js";
import {
  MEMBERSHIP_GRANTED_OPERATION,
  MEMBERSHIP_TRANSITIONED_OPERATION,
  PostgresUserStore,
  REGISTRY_REFUSED_OPERATION,
  buildPlatformUserRoutes,
} from "./platform-users.js";
import { formatUserFkReadiness, surveyUserFkReadiness } from "./user-fk-readiness.js";
import {
  PREFERENCE_ADMIN_OPERATION,
  PREFERENCE_CLEARED_OPERATION,
  PREFERENCE_DENIED_OPERATION,
  PREFERENCE_SET_OPERATION,
  buildPreferenceRoutes,
} from "./preference-routes.js";
import { PostgresNotificationPreferenceStore } from "./preference-store.js";
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
import {
  BACKFILL_DENIED_OPERATION,
  BACKFILL_GRANTED_OPERATION,
  buildReadStateRoutes,
} from "./read-state-routes.js";
import { PostgresFaxObservationStore } from "./fax-observation-store.js";
import { appendIncidentNote } from "./incident-note.js";
import { PostgresReadStateStore } from "./read-state-store.js";
import { buildWorkflowCancellationRoutes } from "./workflow-cancellation-routes.js";
import {
  buildWorkflowWorkerSupervisor,
  consoleWorkflowWorkerEvents,
  parseWorkflowWorkerConfig,
  type WorkflowWorkerSupervisor,
} from "./workflow-workers.js";
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
  /**
   * Resolves one tenant's at-rest column key. Present only when this deployment actually
   * encrypts — so a per-tenant store built later gets the same resolver, and its derivation
   * cache, rather than a second one.
   */
  readonly columnKey?: ColumnEncryptionKeySource;
}

async function resolveStore(options: ServeOptions, manifest: Manifest): Promise<ResolvedStores> {
  // Decided before a connection is opened, because every outcome here is about whether this
  // deployment may serve this manifest at all. A classification that silently means nothing is
  // the defect being closed: `--store pg` and `--store memory` hold a phi/regulated field as
  // plaintext (verified live — `document->>'mrn'` reads the value straight back), and
  // `--store pg-columns` cannot write one at all without a key.
  const rawSecret = process.env[COLUMN_ENCRYPTION_SECRET_VAR] ?? "";
  const phiDecision = decidePhiStorage({
    store: options.store,
    phiFields: surveyPhiFields(manifest),
    secretPresent: rawSecret.trim().length > 0,
    allowPlaintextPhi: options.allowPlaintextPhi,
  });
  if (!phiDecision.mayServe) throw new Error(formatPhiStorageDecision(phiDecision));
  // Built *before* the decision is logged, and the order is load-bearing. `secretPresent` is
  // "the variable is non-empty", which cannot see a secret that is present and too weak to use
  // — under 32 bytes, or fewer than 16 distinct byte values. Such a secret decides `encrypted`
  // and is then refused by the parser, so logging first would put "this deployment encrypts
  // PHI" on the record and throw immediately after: the very shape of defect this increment
  // closes, one layer in. Built once and shared, so the per-tenant derivation is cached across
  // every store that needs it rather than once per store.
  const columnKey =
    phiDecision.verdict === "encrypted" ? buildColumnKeySource(rawSecret) : undefined;
  if (phiDecision.fields.length > 0) {
    // Said at boot either way, including when it is fine: "this deployment encrypts PHI" and
    // "this deployment stores PHI in the clear because it was told to" are the two facts an
    // operator needs on the record, and the second is reachable only through a flag whose name
    // is the admission.
    const line = formatPhiStorageDecision(phiDecision);
    if (phiDecision.verdict === "plaintext_accepted") console.warn(`[phi] ${line}`);
    else console.info(`[phi] ${line}`);
  }
  // A secret that is set and not used is a deployment believing it has encryption it has not
  // got. It is not a refusal — the variable may be set globally for a sibling service, and
  // refusing would break a deployment that works — but going quiet is how the original defect
  // lasted four phases.
  if (rawSecret.trim().length > 0 && columnKey === undefined) {
    console.warn(
      `[phi] ${COLUMN_ENCRYPTION_SECRET_VAR} is set and unused: ` +
        (phiDecision.fields.length === 0
          ? "this manifest declares no phi/regulated field."
          : `verdict ${phiDecision.verdict} — only --store pg-columns encrypts a column.`),
    );
  }

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
    const store = new ColumnMappedEntityStore(conn, manifest, {
      ...(options.schema !== null ? { schema: options.schema } : {}),
      ...(columnKey !== undefined ? { encryptionKey: columnKey } : {}),
    });
    await store.ensureSchema();
    return { store, allocator, settingsStore, conn, columnKey };
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
  const { store, allocator, settingsStore, conn, columnKey } = await resolveStore(
    options,
    manifest,
  );
  // Who may read and write each sensitive class. One declaration, both directions: the same policy
  // object reaches the response-redaction registry and the write mask, because `privilegedForClass`
  // has a single definition precisely so a role cannot end up able to write a class it may not read
  // (ADR-0329) — and two policy sources would have made that property unenforceable.
  // Said at boot either way, and checked *before* the sensitive-field survey below. `rbacCheck`
  // refuses an obligated grant, so an obligation on a required field's `update` grant makes that
  // field unwritable and would trip `checkClassifiedWriteMask`'s `would_make_entity_uncreatable`
  // refusal — naming the classification declaration as the remedy for something no declaration can
  // fix. First refusal wins, so it has to be the one whose remedy is true.
  // `buildOperateHttpServer` re-asks: this covers the boot manifest, that one covers an activated
  // per-tenant manifest and an embedder, and both read the one rule in `abac-obligations.ts`.
  // The deployment's ABAC policy layer. `--abac-policy` is what makes the attribute directory worth
  // running at all, so the two are one decision rather than two flags: the producer is wired exactly
  // when a consumer exists, and a deployment with no policy pays no membership lookup.
  const abacPolicies = parseAbacPolicies(options.abacPolicies);
  if (abacPolicies.size > 0 && conn === undefined) {
    // Refused rather than mounted with no directory. With no `meta.user_tenant_membership` to read,
    // every principal's attributes are unresolved and every obligation answers `undischargeable` —
    // a total denial that looks exactly like the policy working, which is the silence ADR-0340's
    // boot refusal exists to end.
    throw new Error(
      `${ABAC_POLICY_FLAG} requires a Postgres store (--store pg or pg-columns):` +
        " attributes come from meta.user_tenant_membership and there is none under --store memory",
    );
  }
  const abacEvaluator = abacPolicies.size > 0 ? buildAbacEvaluator(abacPolicies) : undefined;
  if (abacPolicies.size > 0) console.info(`[abac] ${formatAbacPolicies(abacPolicies)}`);

  const abacRecordBearingKeys = recordBearingPolicyKeys(abacPolicies);
  // Read from the environment and never argv (ADR-0301: `ps` can read argv), like the column
  // secret above it. Resolved before the obligation check because that check refuses a boot whose
  // list grants filter rows with the cursor left in the clear, and it can only ask that question
  // once it knows which of the three modes is in force.
  const cursorSealing = resolveCursorSealing({
    secret: process.env[CURSOR_ENCRYPTION_SECRET_VAR] ?? null,
    allowDisclosure: options.allowCursorDisclosure,
  });
  const abacObligations = checkAbacObligations({
    manifest,
    answerableKeys: new Set(abacPolicies.keys()),
    recordBearingKeys: abacRecordBearingKeys,
    cursorSealing: cursorSealing.mode,
  });
  console.info(`[abac] ${formatAbacObligationCheck(abacObligations)}`);
  if (abacObligations.refusal !== null) throw new AbacObligationsUnevaluable(abacObligations);
  // Said on every boot, not only when a list filters rows: a deployment that set the secret should
  // see that its cursors are sealed, and one that accepted the disclosure should see that it did.
  console.info(`[cursor] ${formatCursorSealing(cursorSealing.mode)}`);
  // `--allow-plaintext-phi`'s "set and unused" shape rather than its CLI refusal: the refusal there
  // can be decided from argv alone (`--store pg-columns` cannot produce plaintext), while whether
  // this flag is redundant depends on an environment variable `parseServeArgs` deliberately cannot
  // read. So it is said here, where both halves are in hand. A warning and not a refusal, because
  // the flag accepts a disclosure rather than requesting one — a deployment that set the secret
  // *and* passed the flag gets sealed cursors, which is what it would want either way.
  if (cursorSealing.mode === "sealed" && options.allowCursorDisclosure) {
    console.warn(
      `[cursor] ${ALLOW_CURSOR_DISCLOSURE_FLAG} is set and unused: ` +
        `${CURSOR_ENCRYPTION_SECRET_VAR} is configured, so cursors are sealed and there is no` +
        " disclosure to accept. Drop the flag.",
    );
  }

  const sensitiveFieldDeclaration = {
    privilegedRoles: options.sensitiveFieldRoles,
    privilegedRolesByClass: options.sensitiveFieldClasses as SensitiveFieldDeclaration["privilegedRolesByClass"],
  } satisfies SensitiveFieldDeclaration;
  const sensitivePolicyForEntity = buildSensitiveFieldPolicy(sensitiveFieldDeclaration);
  const writeMaskMode: WriteMaskMode = options.classifiedWriteMask ? "classified" : "explicit_only";
  // Surveyed over the *manifest's* roles rather than the api-key roles: `uncreatable` answers
  // "can this required field be written by anybody at all", and a JWT deployment can present any
  // role the manifest declares, so the narrower set would produce a false boot refusal.
  const sensitiveSurvey = surveySensitiveFields({
    manifest,
    declaration: sensitiveFieldDeclaration,
    roles: Object.keys(manifest.roles ?? {}),
    classifiedWriteMask: options.classifiedWriteMask,
  });
  if (options.classifiedWriteMask) {
    const admissible = checkClassifiedWriteMask(sensitiveSurvey);
    if (!admissible.ok) {
      // ADR-0334's conversion a third time: without this the deployment discovers it as a 403 on
      // create with nothing naming the missing declaration. The refusal's list *is* the migration
      // guide, which is why there is no `--allow-…` past it — declare the roles, or do not mount.
      throw new Error(
        `${CLASSIFIED_WRITE_MASK_FLAG} refused (${admissible.reason}): ${admissible.detail}`,
      );
    }
  }
  // A declared role the manifest does not define grants nothing, and silently: every predicate
  // wraps `resolveEffectiveRoles`, which throws `UnknownRoleError` for an undeclared name, and
  // answers false — fail-closed, and for an undefined role also the true answer. But a grant that
  // reaches nobody because of a typo is a declaration that does nothing, which is the whole class
  // this increment exists to end, so it is said rather than left to be inferred from a field that
  // stayed redacted.
  const manifestRoleNames = new Set(Object.keys(manifest.roles ?? {}));
  const undeclaredGrantees = [
    ...new Set([
      ...options.sensitiveFieldRoles,
      ...Object.values(options.sensitiveFieldClasses).flat(),
    ]),
  ].filter((r) => !manifestRoleNames.has(r));
  if (undeclaredGrantees.length > 0) {
    console.warn(
      `[sensitive] ${undeclaredGrantees.length} declared grantee(s) are not roles this manifest` +
        ` defines, so they grant nothing: ${undeclaredGrantees.join(", ")}` +
        ` (manifest roles: ${[...manifestRoleNames].sort().join(", ") || "none"})`,
    );
  }
  if (sensitiveSurvey.totalSensitive > 0) {
    // Said at boot either way. A deployment that declares nothing has every classified field
    // readable by nobody and writable by anybody, which is the state this closes and is invisible
    // from the outside — total redaction looks exactly like classification working.
    console.info(`[sensitive] ${formatSensitiveFieldSurvey(sensitiveSurvey)}`);
  }
  const apiKeys = options.apiKeys.map(parseApiKeySpec);
  const { config: jwt, poller } = await resolveJwtConfig(options);
  const schemaOpt = options.schema !== null ? { schema: options.schema } : {};
  // Resolved once per request in the auth stage and cached, so the five places that build an
  // `auth.Principal` read one answer instead of each asking its own. Built only alongside an
  // evaluator (see the policy block above), and reading through `PostgresUserStore.membershipFor`,
  // which already carries the `withTenantContext` and strict `scopeFilter` this read needs — a
  // second spelling of that query is what this repo refuses.
  const abacAttributeDirectory =
    abacEvaluator !== undefined && conn !== undefined
      ? new CachedAbacAttributeDirectory(
          abacAttributeDirectoryFromStore(new PostgresUserStore(conn, schemaOpt)),
        )
      : undefined;
  // Grouped so the evaluator, the keys it answers and the directory feeding it cannot be supplied
  // apart — see `BuildOperateHttpServerOptions.abac`.
  const abac =
    abacEvaluator === undefined
      ? undefined
      : {
          evaluator: abacEvaluator,
          answerableKeys: new Set(abacPolicies.keys()),
          recordBearingKeys: abacRecordBearingKeys,
          // Derived from the evaluator instance above, so the batch *is* that evaluator mapped and
          // the two cannot answer one question differently. For a map lookup it buys nothing; it is
          // supplied so the branch a deployment with a real batch takes is the branch this
          // deployment runs, rather than one reached only from its own tests (ADR-0336's class).
          evaluateBatch: buildAbacBatchEvaluator(abacEvaluator),
          ...(abacAttributeDirectory !== undefined ? { attributeDirectory: abacAttributeDirectory } : {}),
        };
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
  // The tenant lifecycle trail. One store for every transition surface — the console, the
  // synchronous deletion, the asynchronous verify and reject — because they record one tenant's
  // history and a second instance would be a second schema resolution of the same table.
  //
  // Constructed unconditionally under `--store pg`, with **no flag**: a transition the deployment
  // already performs either leaves a record or does not, and making the record opt-in would be the
  // thing that made this table empty in every deployment for four phases. `meta.tenant_lifecycle_events`
  // was declared in Phase 1 and its own `PLATFORM_RECORD_TABLES` comment says why it matters —
  // without it nothing in the database distinguishes a tenant that was deleted from one that never
  // existed.
  const lifecycleEvents = conn !== undefined ? new PostgresLifecycleEventStore(conn, schemaOpt) : null;
  if (conn !== undefined) {
    // Not a refusal: ADR-0322's rule, that a surface which degrades rather than refusing has to say
    // so out loud. The trail degrades to *no record* rather than to a wrong one, so a boot line is
    // the proportionate response — and `cascades_with_tenant` is the verdict worth shouting, since
    // under it the record is destroyed by the very deletion it exists to witness.
    try {
      const trail = await probeLifecycleTrail(conn, options.schema ?? "meta");
      if (trail.verdict !== "durable") {
        console.warn(`[lifecycle] trail is not durable (${trail.verdict}): ${trail.detail}`);
      }
    } catch (err) {
      console.warn(
        `[lifecycle] trail probe failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // A compile-time census read at boot: an action with no producer is an outcome the trail can
    // never show, and saying which is the difference between a gap and a silence.
    const gaps = lifecycleTrailGaps();
    if (gaps.length > 0) {
      console.warn(`[lifecycle] actions with no producer: ${gaps.join(", ")}`);
    }
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
        ...(lifecycleEvents !== null ? { lifecycleEvents } : {}),
        onLifecycleError: (err, action) =>
          console.error(`[lifecycle] console ${action} not recorded`, err),
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
  // `--read-state-routes` is in this list because it needs the notice source and the recipient
  // resolver, and nothing else here. Left out, it mounted nothing and warned that it "requires a
  // Postgres store" on a server started with `--store pg` — a refusal naming the wrong cause, which
  // is the one thing worse than no refusal. Found by booting the real binary.
  if (
    (options.aiDesign ||
      options.perTenantManifests ||
      options.designReview ||
      options.readStateRoutes) &&
    conn !== undefined
  ) {
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
                  ...(lifecycleEvents !== null
                    ? {
                        lifecycle: {
                          store: lifecycleEvents,
                          eventId: randomUUID(),
                          // `customer_request`, not `compliance_directive`: an Article 17 erasure
                          // *is* a data subject request, and `compliance_directive` is in
                          // `PROTECTED_TRIGGERS`, which the contract requires a `relatedIncidentId`
                          // for — a route with none in hand must not name a trigger it cannot
                          // substantiate.
                          trigger: "customer_request" as const,
                          // A constant rather than a request field, because this route collects no
                          // reason: the act it performs *is* the reason, and `LifecycleEvent.reason`
                          // is `z.string().min(1)`, so there is nothing to default from.
                          reason: "article 17 right to erasure",
                        },
                      }
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
  // to "whose row is this" — and since ADR-0331 a platform-scope page *can* leave a row, because
  // `meta.audit_log.tenant_id` is nullable and NULL means platform scope. What the recorder still
  // will not do is invent a tenant: a resolver that throws, or answers blank, stays unrecorded,
  // because only a resolved `null` is a positive statement that this page is about the deployment.
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
  // The incident's own timeline, which is the *other* place a page is written down (ADR-0327). It
  // was the only one that worked for a platform-scope page while `meta.audit_log.tenant_id` was NOT
  // NULL; ADR-0331 made that row possible, so the two are now a pair rather than a substitute. The
  // timeline keeps its job either way: it has no tenant column to get wrong, it is append-only, it
  // sits on the record an incident review actually opens, and it is what still lands when the audit
  // emitter itself is unreachable — which is the condition a compromise finding escalates for.
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
      // The stall episode's durable record of *which kind* it currently is (ADR-0332, closing
      // ADR-0330's open end). The title and detail are written once at declaration and an adoption
      // writes nothing, so an episode that began `no_pages` and became `pinned_cursor` read as
      // `no_pages` forever — and the two send a responder to different halves of the system.
      //
      // The timeline rather than an audit row, for `notePage`'s reasons: no tenant column to get
      // wrong, append-only, appendable in any status, and on the record a review actually opens.
      // The previous kind is read back *off that record* rather than remembered in this process, so
      // a flip is detected after a restart and by a different replica.
      ...(pagedNoteStore !== null
        ? {
            note: async (incidentId, note): Promise<void> => {
              const outcome = await appendIncidentNote(pagedNoteStore, incidentId, {
                kind: "observation",
                message: note.message,
                metadata: note.metadata,
                actorUserId: PAGE_NOTE_ACTOR,
              });
              if (!outcome.recorded) {
                console.warn(
                  `[deletion-evidence] stall-kind note not added to ${incidentId}: ` +
                    `${outcome.reason ?? "unknown"}`,
                );
              }
            },
          }
        : {}),
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
          ...(lifecycleEvents !== null ? { lifecycleEvents } : {}),
          onLifecycleError: (err, action) =>
            console.error(`[lifecycle] deletion request ${action} not recorded`, err),
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
          // The tenant row moves with the request (ADR-0334): a verification makes the tenant
          // read-only and a rejection restores it. Before this, `meta.tenants.status` could not hold
          // `pending_deletion` at all and nothing on the request path read the column, so a tenant
          // whose erasure was verified and queued kept accepting writes into data about to be
          // destroyed. Both transitions are guarded in the predicate, so a console suspension in
          // between wins the row rather than being overwritten.
          tenantState: buildTenantStateMover(new PostgresTenantStore(reqConn), {
            onNoMatch: ({ tenantId, to, from }) =>
              console.warn(
                `[deletion-request] tenant ${tenantId} not moved to ${to}:` +
                  ` not in {${from.join(", ")}}`,
              ),
          }),
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
            // A cross-tenant read names no single tenant and is recorded against the **reader's**
            // own. ADR-0313 gave a mechanical reason for that — `meta.audit_log.tenant_id` was NOT
            // NULL — and ADR-0331 made it nullable, so the mechanical reason has expired while the
            // decision has not.
            //
            // The real justification: this record is about a **person**, and that person belongs to
            // a tenant. Filing it in their tenant's trail is what makes the read accountable to the
            // people whose data it touched — their own `GET /v1/audit/entries` shows that somebody
            // holding a platform grant read across them. Moving it to platform scope would put it
            // behind `app.platform_audit`, readable only by the same population that performed the
            // read, which removes the one reader the record exists for. Platform scope is the right
            // home for a fact about the *deployment*; a privileged human's read is not one.
            //
            // So a reader with no resolvable tenant still cannot read, and must **not** be handed a
            // platform row instead now that one is expressible: that would admit an *unattributable*
            // privileged read, which is worse than refusing one.
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

  // One engine for both surfaces, because `WorkflowWorkerSupervisorInput` requires exactly that:
  // "the same engine the cancellation route holds: one process, one view of the log". Two engines
  // over one connection would each hold their own definition map and their own inline-vs-deferred
  // activity policy, so a cancellation and a timer fire could disagree about the same instance.
  let workflowEngine: PersistentEngineBundle | null = null;
  let workflowDefinitionCount = 0;
  if (options.workflowCancelRoles.length > 0 || options.workflowWorkers) {
    if (conn === undefined) {
      console.warn("[workflow] the workflow engine requires a Postgres store; skipping");
    } else {
      // Loaded with no tenant filter, because the engine's map is keyed by `definitionId`, which is
      // unique table-wide: an instance's definition is determined by the id on its `instance_started`
      // event, and tenant isolation on *instances* is enforced by the route and the canceller, not
      // by narrowing this map. Every status is loaded, not only `published` — a missing definition
      // makes the engine go quiet rather than raise (a due timer is skipped, a signal declined), so
      // a map narrowed to `published` would silently strand in-flight instances of a `deprecated`
      // definition; `startInstance` already refuses a non-published one by name.
      const definitionStore = new PostgresWorkflowDefinitionStore(conn, schemaOpt);
      const definitions = await definitionStore.loadEngineDefinitions({});
      // Said out loud, because this is the degradation ADR-0329 refused to mount for. Under RLS as
      // a non-owner role with no tenant context the load sees only platform-wide rows, so a
      // deployment whose definitions are all tenant-scoped gets an empty map — and the route would
      // then answer 404 for every instance, which reads as "no such instance" rather than as "this
      // server loaded no definitions".
      if (definitions.size === 0) {
        console.warn(
          "[workflow] no workflow definitions loaded: every cancellation will report an unknown" +
            " instance, and every worker will refuse to start. meta.workflow_definitions may be" +
            " empty, or this connection's role may see only platform-wide rows under RLS",
        );
      } else {
        console.log(`[workflow] ${definitions.size.toString()} definition(s) loaded`);
      }
      // `deferActivities` is a biconditional, not a preference, and its own contract says so: a
      // deployment that runs the activity worker must defer, and one that does not must not —
      // inline, the row is `scheduled` only between the `activity_scheduled` and `activity_started`
      // appends, so a worker polling the same database can claim it inside that window and run the
      // handler a second time. Both directions are closed: the CLI refuses deferral without the
      // workers, and the supervisor refuses the activity worker without deferral
      // (`activities_run_inline`).
      const bundle = buildPersistentEngine({
        conn,
        definitions,
        ...(options.workflowDeferActivities ? { deferActivities: true } : {}),
      });
      workflowEngine = bundle;
      workflowDefinitionCount = definitions.size;
      if (options.workflowCancelRoles.length > 0) {
        extraRouteList.push(
          ...buildWorkflowCancellationRoutes({
            canceller: bundle.engine,
            principalRoles: buildPrincipalWiring(apiKeys).principalRoles,
            allowedRoles: new Set(options.workflowCancelRoles),
            onDecided: (result, tenantId, instanceId) =>
              console.log(
                `[workflow] cancel ${instanceId} (tenant ${tenantId}): ${result.outcome}`,
              ),
          }),
        );
      }
      // A manifest workflow the engine cannot serve is the defect this survey exists to name. Under
      // the authored model the cost of an absent definition is an *absent* workflow rather than a
      // wrong one, so it has to be said rather than inferred from nothing happening.
      const survey = surveyManifestWorkflows({
        workflows: manifest.workflows,
        publishedDefinitionKeys: [...definitions.values()]
          .filter((d) => d.status === "published")
          .map((d) => d.definitionKey),
      });
      for (const finding of survey.findings) {
        if (!survey.unreachable.includes(finding.name)) continue;
        console.warn(
          `[workflow] manifest workflow '${finding.name}' (${finding.kind}) is` +
            ` ${finding.verdict}: it will never run until a definition is published for it`,
        );
      }
    }
  }

  // Per-user notification preferences (ADR-0335). The table was read by `preferencesFor` on every
  // drained dispatch and written by nothing, so every user's preferences were the built-in defaults
  // for ever and `isPreferenceOptedIn` could only ever answer from an absent entry — which made the
  // whole consent half of `computeDispatchEligibility` unreachable by construction.
  if (options.preferenceRoutes) {
    if (conn === undefined) {
      console.warn(
        "[preferences] --preference-routes requires a Postgres store (--store pg); skipping",
      );
    } else if (options.preferenceRoles.length === 0) {
      // Fail-closed and said out loud: the routes would mount and refuse everything, which reads as
      // the feature being broken rather than as ungranted.
      console.warn(
        "[preferences] --preference-routes is on with no --preference-role: every request will be" +
          " refused",
      );
    } else {
      extraRouteList.push(
        ...buildPreferenceRoutes({
          store: new PostgresNotificationPreferenceStore(conn, schemaOpt),
          principalRoles: buildPrincipalWiring(apiKeys).principalRoles,
          allowedRoles: new Set(options.preferenceRoles),
          adminRoles: new Set(options.preferenceAdminRoles),
          // Every preference write is recorded, which is where this parts company with read state.
          // ADR-0331 refused an audit row for a per-notice mark because the row *is* the record;
          // that is true here too but not sufficient — the row holds only the **current** value, so
          // a preference flipped off and on again leaves nothing saying it was ever off, and a
          // consent record whose history cannot be reconstructed is what ADR-0302's rule exists to
          // prevent.
          audit: async (event): Promise<void> => {
            await requireEmitter("--preference-routes").emit(
              auditEntry({
                id: randomUUID(),
                tenantId: event.tenantId,
                occurredAt: event.at,
                operation: event.granted
                  ? event.onBehalf
                    ? PREFERENCE_ADMIN_OPERATION
                    : event.optedIn === null
                      ? PREFERENCE_CLEARED_OPERATION
                      : PREFERENCE_SET_OPERATION
                  : PREFERENCE_DENIED_OPERATION,
                entity: "NotificationPreference",
                // The **subject**, not the caller: this row's job is to say whose consent moved.
                entityId: event.subjectUserId,
                actor: auditActor({ userId: event.principalId }),
                after: {
                  category: event.category,
                  channel: event.channel,
                  optedIn: event.optedIn,
                  source: event.source,
                  onBehalf: event.onBehalf,
                  granted: event.granted,
                  roles: event.roles,
                },
              }),
            );
          },
        }),
      );
      if (options.preferenceAdminRoles.length === 0) {
        // Not a refusal — the self-service surface is the point and works without it — but worth one
        // line, because a deployment expecting support staff to fix somebody's preferences gets a
        // route that is not mounted rather than a 403.
        console.info("[preferences] no --preference-admin-role: the on-behalf route is not mounted");
      }
    }
  }
  // The platform user registry (ADR-0335). Neither `meta.users` nor `meta.user_tenant_membership`
  // had a writer, while 50 catalogued columns reference the former NOT NULL ON DELETE RESTRICT —
  // ten on tables with a live writer — and every notification audience resolved to the empty set.
  if (options.platformUserRoutes) {
    if (conn === undefined) {
      console.warn(
        "[platform-users] --platform-user-routes requires a Postgres store (--store pg); skipping",
      );
    } else if (options.platformUserRoles.length === 0) {
      console.warn(
        "[platform-users] --platform-user-routes is on with no --platform-user-role: every request" +
          " will be refused",
      );
    } else {
      const emitter = requireEmitter("--platform-user-routes");
      extraRouteList.push(
        ...buildPlatformUserRoutes({
          store: new PostgresUserStore(conn, schemaOpt),
          principalRoles: buildPrincipalWiring(apiKeys).principalRoles,
          adminRoles: new Set(options.platformUserRoles),
          // Required rather than optional: every route here mints a principal or grants it a role
          // inside a tenant, so it is ADR-0313's privileged-write class without exception.
          //
          // `tenantId` is the tenant the act is *about* — null for a bare user write, which is
          // platform scope since ADR-0331 made the column nullable — and never the caller's: a
          // platform operator provisions into tenants they are not a member of, so recording their
          // own tenant would file the grant under the wrong one.
          audit: async (event): Promise<void> => {
            await emitter.emit(
              auditEntry({
                id: randomUUID(),
                tenantId: event.tenantId,
                occurredAt: event.at,
                operation: event.operation,
                // A refused row carries the attempted operation in `detail.attempted`, so it is
                // filed against whichever entity the attempt was about: a reader counting refusals
                // against their pair needs both on the same entity.
                entity:
                  event.operation === MEMBERSHIP_GRANTED_OPERATION ||
                  event.operation === MEMBERSHIP_TRANSITIONED_OPERATION ||
                  (event.operation === REGISTRY_REFUSED_OPERATION &&
                    typeof event.detail["attempted"] === "string" &&
                    event.detail["attempted"].startsWith("platform.membership"))
                    ? "UserTenantMembership"
                    : "User",
                entityId: event.subjectUserId,
                actor: auditActor({ userId: event.principalId }),
                after: { roles: event.roles, ...event.detail },
              }),
            );
          },
        }),
      );
      console.info(
        `[platform-users] registry routes mounted for roles: ${options.platformUserRoles.join(", ")}`,
      );
    }
  }
  if (options.readStateRoutes) {
    if (conn === undefined) {
      console.warn(
        "[read-state] --read-state-routes requires a Postgres store (--store pg); skipping",
      );
    } else if (notificationStore === null) {
      // Two conditions, two messages. Folded into the one above, this printed "requires a Postgres
      // store" at an operator who had supplied exactly that, and the only way to find the real cause
      // was to read this file. It is unreachable now that the flag constructs the store, which is
      // why it names itself as a bug rather than as something to configure.
      console.warn(
        "[read-state] --read-state-routes has a Postgres store but no notification source was " +
          "constructed; this is a wiring bug, not a configuration one — skipping",
      );
    } else if (options.readStateRoles.length === 0) {
      // Fail-closed and said out loud. The routes would mount and refuse every request, which reads
      // as the feature being broken rather than as ungranted.
      console.warn(
        "[read-state] --read-state-routes is on with no --read-state-role: every request will be refused",
      );
    } else {
      const notices = notificationStore;
      extraRouteList.push(
        ...buildReadStateRoutes({
          store: new PostgresReadStateStore(conn, schemaOpt),
          notices,
          principalRoles: buildPrincipalWiring(apiKeys).principalRoles,
          allowedRoles: new Set(options.readStateRoles),
          backfillRoles: new Set(options.readStateBackfillRoles),
          unreadScanLimit: options.readStateUnreadScan,
          // Per-recipient, the same resolver the inbox listing uses. Unwired, an unread count is
          // tenant-wide — exactly how the listing already behaves, so the two agree either way.
          ...(recipientResolver !== null
            ? {
                resolveIdentity: (tenantId: string, principalId: string) =>
                  recipientResolver.identityFor(tenantId, principalId),
              }
            : {}),
          // A granted backfill marks a whole backlog read in one call, which is ADR-0313's class:
          // recorded *before* the write, and a failure to record refuses it. The ordinary per-notice
          // mark is not recorded, because the read-state row **is** that record — reader, subject
          // and tenant are one principal by construction, so a second row would protect nobody and
          // would bury the entries ADR-0313 exists to surface under every inbox poll.
          ...(options.readStateBackfillRoles.length > 0
            ? {
                auditBackfill: async (event): Promise<void> => {
                  await requireEmitter("--read-state-backfill-role").emit(
                    auditEntry({
                      id: randomUUID(),
                      tenantId: event.tenantId,
                      occurredAt: event.at,
                      operation: event.granted
                        ? BACKFILL_GRANTED_OPERATION
                        : BACKFILL_DENIED_OPERATION,
                      entity: "NotificationReadWatermark",
                      entityId: event.userId,
                      actor: auditActor({ userId: event.principalId }),
                      // The **clamped** position, which is what says how much was marked read; the
                      // requested one may have been in the future and was not honoured.
                      after: {
                        readThroughAt: event.readThroughAt,
                        roles: event.roles,
                        granted: event.granted,
                      },
                    }),
                  );
                },
              }
            : {}),
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
  // Tenant lifecycle enforcement on the request path (ADR-0334). The column has existed since
  // Phase 1 and nothing on this path read it, so a `suspended` tenant kept writing and a tenant
  // whose Article 17 erasure was verified and queued kept writing into data about to be destroyed.
  //
  // Opt-in for one concrete reason: the gate refuses a credential whose tenant has no
  // `meta.tenants` row, and `--api-key 'key:role:tenant'` specs name arbitrary UUIDs that nothing
  // requires to exist — so on-by-default would 403 every request of a deployment that is working
  // today. The survey names those tenants at boot instead of leaving an operator to read it off a
  // 403, which is the rule this file keeps relearning: a surface that refuses has to say so first.
  let tenantStatusGate: TenantStatusGateOptions | undefined;
  if (options.tenantStatusGate) {
    if (conn === undefined) {
      console.error(
        "[tenant-status] --tenant-status-gate needs a Postgres store; NOT mounted, so" +
          " meta.tenants.status is unenforced on the request path",
      );
    } else {
      const directory = new CachedTenantStatusDirectory(
        tenantStatusDirectoryFromStore(new PostgresTenantStore(conn)),
        {
          ...(options.tenantStatusTtlMs !== null ? { ttlMs: options.tenantStatusTtlMs } : {}),
          onRefreshError: (tenantId, err, servedStale) =>
            console.error(
              `[tenant-status] refresh failed for ${tenantId} (` +
                `${servedStale ? "serving the last known answer" : "no cached answer — refusing"})`,
              err,
            ),
        },
      );
      tenantStatusGate = {
        directory,
        events: {
          onRefused: ({ decision, operationId, tenantId, status }) =>
            console.warn(
              `[tenant-status] ${decision} tenant=${tenantId} status=${status ?? "-"}` +
                ` op=${operationId}`,
            ),
        },
      };
      const survey = await surveyTenantStatusCoverage(
        directory,
        apiKeys.map((k) => k.tenantId),
      );
      if (survey.missing.length > 0) {
        console.error(
          `[tenant-status] ${survey.missing.length.toString()} configured API-key tenant(s) have no` +
            ` meta.tenants row and EVERY request from them will be refused 403: ` +
            survey.missing.join(", "),
        );
      }
      if (survey.unreachable.length > 0) {
        console.warn(
          "[tenant-status] could not read the status of " +
            `${survey.unreachable.length.toString()} configured tenant(s) at boot (reported as` +
            " unreachable, not as absent): " +
            survey.unreachable.join(", "),
        );
      }
      for (const { tenantId, status } of survey.blocked) {
        console.warn(`[tenant-status] tenant ${tenantId} is ${status}: writes will be refused`);
      }
      console.info(
        `[tenant-status] gate mounted over ${survey.checked.length.toString()} configured tenant(s)` +
          `; /v1/platform routes exempt`,
      );
    }
  }
  // Unconditional, and deliberately so. ADR-0334's `--tenant-status-gate` survey runs only when
  // the gate is on, because the gate is what would 403. This finding is a property of the
  // deployment's own `--api-key` specs and is true whether or not a registry surface is mounted: the
  // ten stores carrying a NOT NULL `meta.users` reference fail at their first INSERT either way, and
  // nothing else in the boot path said so.
  //
  // Only specs that **name** a principal. A bare `key:role:tenant` resolves as a `service_account`
  // sharing `DEFAULT_PRINCIPAL_ID` (ADR-0331) and every per-person surface already refuses it, so
  // listing it would name a row that must *not* be created — provisioning it would undo ADR-0331's
  // fix by making the shared placeholder satisfy those guards again.
  if (conn !== undefined) {
    try {
      const readiness = await surveyUserFkReadiness(
        conn,
        apiKeys.filter((spec) => spec.namesPrincipal).map((spec) => spec.principalId),
        schemaOpt,
      );
      const line = formatUserFkReadiness(readiness);
      if (line !== null) console.warn(`[platform-users] ${line}`);
    } catch (err) {
      // A survey that cannot run must not stop the boot: this is a finding, not a gate.
      console.warn(
        `[platform-users] readiness survey failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  // The rate-limit checker. Absent ⇒ `buildOperateGateway` installs `InMemoryRateLimitChecker` at
  // 10,000/window, which is what every deployment has had: `PostgresRateLimitChecker` existed with
  // tests and nothing in this binary constructed it, so `meta.rate_limit_decisions` has never held
  // a row and the sliding window was per-replica and per-restart.
  let rateLimitChecker: PostgresRateLimitChecker | undefined;
  if (options.rateLimitPolicies !== null && conn !== undefined) {
    // Probed **once at boot** rather than lazily on the request path: the remedy for an unpatched
    // catalog is standing manual SQL an operator runs once, and a per-request error cannot carry
    // that legibly where a boot line can.
    const decisionSchema = await probeDecisionSchema(conn);
    for (const defect of decisionSchema.defects) console.error(`[rate-limit] ${defect}`);
    if (decisionSchema.remediationSql.length > 0) {
      console.error(
        `[rate-limit] run once, as the table owner:\n  ${decisionSchema.remediationSql.join("\n  ")}`,
      );
    }
    // Mounted either way, loudly — ADR-0322's rule rather than a refusal that never fires. The limit
    // is enforced correctly whether or not the decision row can be written; what is lost is the
    // record, and refusing here would cost the enforcement to protect its own projection.
    rateLimitChecker = new PostgresRateLimitChecker({
      conn,
      policies: options.rateLimitPolicies,
      schema: decisionSchema,
    });
  }
  // The gateway's replay guard. Absent ⇒ `buildOperateGateway` installs `InMemoryIdempotencyStore`,
  // which is a `Map` in one process: `PostgresIdempotencyStore` existed with tests and nothing
  // constructed it, so every deployment's idempotency has been per-replica and per-restart —
  // including on `--tenant-deletion-routes`, the one route here that requires a key. Said out loud
  // either way, because the guarantee it buys is bounded (ADR-0322's rule): there is no reserve
  // step between the stage-10 read and the post-handler write, so two *concurrent* retries of one
  // key can still both execute, and only the sequential case is closed.
  let idempotencyStore: ReportingIdempotencyStore | undefined;
  let idempotencyPrune: IdempotencyPruneScheduler | null = null;
  if (options.pgIdempotencyStore && conn !== undefined) {
    const pgIdempotency = new PostgresIdempotencyStore(conn);
    idempotencyStore = new ReportingIdempotencyStore(pgIdempotency, {
      // Reported, never thrown. `persistIdempotency` runs *after* the handler's own transaction
      // committed, so raising would turn a successful mutation into a 500 — and a client retrying
      // that 500 re-executes, with no record to stop it, so the throw would cause the exact harm
      // the record prevents. ADR-0333's rule, and the hole is logged rather than absorbed.
      onPersistError: (err, where) =>
        console.error(
          `[idempotency] tenant ${where.tenantId} key ${where.key}: record not stored; a retry of` +
            ` this mutation will re-execute: ${err instanceof Error ? err.message : String(err)}`,
        ),
    });
    console.info(`[idempotency] meta.gateway_idempotency_records: ${IDEMPOTENCY_GUARANTEE}`);
    console.info(`[idempotency] ${IDEMPOTENCY_FK_HINT}`);
    // Not a second flag: a durable store that needs another opt-in to stop growing is a feature
    // with a trap in it, so mounting the store mounts the reaper.
    idempotencyPrune = new IdempotencyPruneScheduler({
      store: pgIdempotency,
      tenants: new PostgresTenantSource(conn),
      onError: (err) =>
        console.error(
          `[idempotency] prune failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
    });
  } else if (options.pgIdempotencyStore) {
    console.warn(
      "[idempotency] --idempotency-store pg needs a Postgres connection; the in-memory guard is" +
        " per process and a retry on another replica will re-execute",
    );
  }
  // Sampled `PipelineExecution` capture — the writer `meta.gateway_pipeline_executions` never had,
  // and the only thing that gives `GatewayReplayer` a row to read.
  let executionCapture: GatewayExecutionCaptureObserver | null = null;
  if (options.gatewayExecutionCapture !== null && conn !== undefined) {
    executionCapture = new GatewayExecutionCaptureObserver({
      store: new PostgresPipelineExecutionStore(conn),
      config: options.gatewayExecutionCapture,
      onError: (err) =>
        console.error(
          `[gateway-capture] execution not stored: ${err instanceof Error ? err.message : String(err)}`,
        ),
    });
    // The figure at boot whether or not anything goes wrong: a cost accepted silently is a cost
    // nobody chose.
    console.info(`[gateway-capture] ${describeCaptureCost(options.gatewayExecutionCapture)}`);
    console.info(`[gateway-capture] ${CAPTURE_FK_HINT}`);
    // Said because the replay surface finds it on every row otherwise, and an operator should
    // know before the sweep tells them. Measured live: with the in-memory checker, 0 decisions are
    // written while every captured execution still stamps an `rld_…` id, so `GatewayReplayer`
    // reports `rate_limit_decision_not_found` for **every** request (6 of 6). Declaring a policy
    // makes both halves line up (3 decisions, 3 executions, 0 findings). The id is not wrong — the
    // decision really was taken — it is simply not persisted, so the reference dangles by
    // configuration rather than by defect.
    if (options.rateLimitPolicies === null) {
      console.warn(
        "[gateway-capture] no --rate-limit-policy declared: the in-memory checker persists no" +
          " decision row, so every captured execution will carry a rate_limit_decision_id that" +
          " resolves to nothing and `operate-server replay --subsystem gateway` will report" +
          " rate_limit_decision_not_found on every row",
      );
    }
  } else if (options.gatewayExecutionCapture !== null) {
    console.warn(
      "[gateway-capture] --gateway-execution-capture needs a Postgres connection; skipping",
    );
  }
  // Compose the per-request observers (SLO + metering + audit chain) into one execution sink.
  const executionSinks: ((execution: PipelineExecution) => void)[] = [];
  if (sloEnforcement !== null) executionSinks.push(sloEnforcement.observer.asExecutionSink());
  if (metering !== null) executionSinks.push(metering.observer.asExecutionSink());
  if (auditChain !== null) executionSinks.push(auditChain.observer.asExecutionSink());
  if (executionCapture !== null) executionSinks.push(executionCapture.asExecutionSink());
  const onExecution =
    executionSinks.length > 0
      ? (execution: PipelineExecution): void => {
          for (const sink of executionSinks) sink(execution);
        }
      : undefined;
  const { httpServer, gateway } = buildOperateHttpServer({
    manifest,
    store,
    apiKeys,
    cursorSealing,
    allocator,
    settingsStore,
    policyForEntity: sensitivePolicyForEntity,
    writeMaskMode,
    ...(abac !== undefined ? { abac } : {}),
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
    ...(tenantStatusGate !== undefined ? { tenantStatusGate } : {}),
    ...(rateLimitChecker !== undefined ? { rateLimitChecker } : {}),
    ...(idempotencyStore !== undefined ? { idempotencyStore } : {}),
  });
  if (rateLimitChecker !== undefined && options.rateLimitPolicies !== null) {
    const policySurvey = surveyRoutePolicies(options.rateLimitPolicies, gateway.routes.list());
    // Said before the first request, because an undeclared policy is a *refusal* at request time and
    // the one thing worse than refusing is refusing without having said it would.
    for (const finding of policySurvey.undeclared) {
      console.error(
        `[rate-limit] route ${finding.operationId} names undeclared policy ${finding.policyId}; every request to it will be refused`,
      );
    }
    if (policySurvey.unusedPolicyIds.length > 0) {
      console.warn(`[rate-limit] declared and unused: ${policySurvey.unusedPolicyIds.join(", ")}`);
    }
    const def = options.rateLimitPolicies.defaultPolicy;
    console.info(
      `[rate-limit] ${String(policySurvey.findings.length)} route(s); default ${def.policyId} ` +
        `(${String(def.limit)}/${String(def.windowSeconds)}s)`,
    );
  }
  // The manifest's job declarations, read once. Two readers (the handler registry and the cron
  // scheduler) over two copies of one expression is the `FEATURE_FLAG_COLUMN_NAMES` shape (ADR-0332).
  const manifestJobs = Object.values(manifest.jobs ?? {});
  // The handlers this binary knows how to run. A `JobDeclaration` carries an id, a trigger, a retry
  // policy, concurrency, data classes and a prose `description` — and **no field of any kind that
  // describes the work**, not even the `z.unknown()` slot an orchestration `Workflow` has. So there
  // is nothing in a manifest to compile and a handler is a *deployment* concern, registered against
  // the job's id by the process that holds the code and the credentials. What the manifest owns is
  // how the run is *governed* — the ceiling, the backoff, the data classes, the failure strategy —
  // and `buildJobHandlerRegistry` reads all of that off the declaration and refuses a provider that
  // restates any of it, so the queue cannot disagree with the manifest a reviewer approved.
  //
  // The shipped provider list is **empty, and that is the honest state rather than a gap**: all 25
  // declarations across the seven packs are tenant-domain ERP work (eight are third-party
  // integrations with no client in this repo, the rest need `operate-runtime`'s entity store and the
  // packs have no runtime layer to hold the behaviour). None duplicates one of this app's in-process
  // schedulers, which are platform work. No noop handler ships: a run reported `completed` having
  // done nothing is exactly the surface-reports-success-and-records-nothing class ADR-0332 and
  // ADR-0333 exist to end.
  const JOB_HANDLER_PROVIDERS: readonly JobHandlerProvider[] = [];
  const jobHandlers =
    conn !== undefined && (options.scheduleMs !== null || options.workflowWorkers)
      ? buildJobHandlerRegistry({ jobs: manifestJobs, providers: JOB_HANDLER_PROVIDERS })
      : null;
  if (jobHandlers !== null) {
    // ADR-0331's rule applied to jobs: a declaration that will never run is named with the reason,
    // never passed over. This is the sentence that was missing — an enqueue that succeeds is
    // indistinguishable from work that happens.
    if (jobHandlers.servedJobIds.length > 0) {
      console.info(
        `[jobs] ${jobHandlers.servedJobIds.length.toString()} job handler(s) registered: ` +
          jobHandlers.servedJobIds.join(", "),
      );
    }
    for (const finding of jobHandlers.survey.findings) {
      if (finding.verdict === "handler_missing" || finding.verdict === "no_producer") {
        console.warn(`[jobs] ${finding.jobId} (${finding.verdict}): ${finding.detail}`);
      }
    }
  }
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
      jobs: manifestJobs,
      tenants,
      intervalMs: options.scheduleMs,
      ...schemaOpt,
    });
    // Said at boot, because the comment above has been describing a fleet that did not exist: the
    // scheduler's enqueue is idempotent and durable, so with nothing claiming, `meta.job_runs`
    // accumulates `pending` rows indefinitely and the manifest's scheduled jobs have never run in
    // this binary. --workflow-workers is what drains it — and even then the job worker refuses
    // while no job handler is registered in this process, which is still the case.
    // Two independent reasons the queue will not drain, and they need different fixes: no worker is
    // mounted at all, or one is mounted and no handler serves the jobs being enqueued.
    const unservedJobs = jobHandlers?.survey.unservable ?? [];
    if (!options.workflowWorkers) {
      console.warn(
        "[jobs] --schedule-ms enqueues job runs into meta.job_runs, and no worker in this process" +
          " claims them: they will stay pending. Mount --workflow-workers to drain the queue",
      );
    } else if (unservedJobs.length > 0) {
      console.warn(
        `[jobs] --schedule-ms will enqueue runs for ${unservedJobs.length.toString()} job(s) no` +
          ` handler in this process serves (${unservedJobs.slice(0, 5).join(", ")}): those runs stay` +
          " pending. The enqueue is deliberately not gated on the local registry — a worker tier and" +
          " a web tier are a legitimate split, so the producer must not refuse what another replica" +
          " serves",
      );
    }
  }
  // The three durable workers that drive the workflow queues. The engine has been mountable since
  // ADR-0331 and nothing polled it, so this is the half that makes a due timer actually fire. Each
  // worker refuses for a named reason rather than polling uselessly; the supervisor prints which.
  let workflowWorkers: WorkflowWorkerSupervisor | null = null;
  if (options.workflowWorkers && conn !== undefined && workflowEngine !== null) {
    const workerConfig =
      options.workflowWorkerConfig !== null
        ? parseWorkflowWorkerConfig(
            JSON.parse(await readFile(options.workflowWorkerConfig, "utf8")) as unknown,
          )
        : undefined;
    // hostname:pid, because this value lands in `claimed_by` and its job is to let an operator
    // answer "which process is holding this lease" from the row alone. A random id would be unique
    // too and would answer nothing.
    const workerId = `${hostname()}:${process.pid.toString()}`;
    workflowWorkers = buildWorkflowWorkerSupervisor({
      conn,
      engine: workflowEngine.engine,
      workerId,
      definitionCount: workflowDefinitionCount,
      activitiesDeferred: options.workflowDeferActivities,
      // A job engine iff some handler is registered. With none, the supervisor still reports
      // `no_job_handlers` — the same refusal as before, but computed from the registry rather than
      // from a hard-coded absence. The `serves` filter is what makes mounting it safe: the claim's
      // `due` CTE names only the served job ids, so an unserved run is never claimed at all rather
      // than claimed and finalized `failed` with handler_not_found, and an unserved backlog cannot
      // starve served runs out of a batch.
      ...(jobHandlers !== null && jobHandlers.servedJobIds.length > 0
        ? {
            jobEngine: new PostgresJobRunEngine(conn, jobHandlers.registry, {
              ...schemaOpt,
              onDeadLetterError: (err, detail) =>
                console.error(
                  `[jobs] run ${detail.runId} was finalized but its meta.dead_letter_jobs row was` +
                    " not written; the run's terminal status is correct and its dead letter is missing",
                  err,
                ),
            }),
            jobServes: { jobIds: jobHandlers.servedJobIds },
          }
        : {}),
      ...schemaOpt,
      ...(workerConfig !== undefined ? { config: workerConfig } : {}),
      events: consoleWorkflowWorkerEvents(),
    });
    // `meta.job_runs`, `meta.dead_letter_jobs` and `meta.job_costs` each carry one `ALL`-scope
    // tenant-isolation policy and no platform arm, while the fleet is deliberately cross-tenant. As a
    // non-owner with no tenant context the claim matches **0 rows** and `executeJobRun` answers
    // `not_claimable` — observed live — and neither is an error: an empty claim is what an empty
    // queue looks like. So a fleet that can never execute anything reads exactly like an idle one,
    // which is why this asks the catalog (RLS enabled, role bypass, ownership) rather than counting
    // rows. The queue tables are always in `meta`, independent of the entity `--schema`.
    const queueVisibility = await probeJobQueueVisibility(conn);
    if (queueVisibility.visibility !== "visible") {
      console.warn(`[jobs] job queue not visible to this connection: ${queueVisibility.detail}`);
    }
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
              ...(lifecycleEvents !== null
                ? {
                    lifecycle: {
                      store: lifecycleEvents,
                      eventId: randomUUID(),
                      trigger: "customer_request" as const,
                      // Names the request, which is what makes this trail joinable to the handle a
                      // caller holds — and unlike the synchronous route, this transition's
                      // `fromState` is `pending_deletion`, so `transitionLegal` is true here and
                      // false there. The difference is visible in the row rather than inferred.
                      reason: `deletion request ${input.relatedDeletionRequestId} executed`,
                    },
                  }
                : {}),
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
        // The same resolver the boot store got, so a tenant's key is derived from the one
        // deployment secret and cached once. Absent when this deployment encrypts nothing, in
        // which case a tenant activating a manifest with a classified field is refused by the
        // store's own constructor — named, rather than 500ing on their first PHI write.
        ...(columnKey !== undefined ? { encryptionKey: columnKey } : {}),
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
    // One router *per tenant*, not one for the deployment, and that is the whole reason this is a
    // function rather than a value. Without `encryptedEntities` the fallback is a silent downgrade
    // from ciphertext to plaintext: a tenant whose DDL application is *refused* is served from the
    // JSONB store, which has no encryption, so their PHI would land in the clear while the log
    // reported a refusal and the caller got a 201. Declaring the set makes those entities refuse
    // instead — the fail-closed invariant, at the same cost ADR-0314 already accepts for a refused
    // application, minus the silence.
    //
    // And the set has to come from the *tenant's own* manifest. Under per-tenant manifests a
    // tenant authors independently, so A's classified fields are not B's and neither is the boot
    // pack's; a deployment-wide set taken from the boot manifest would have been correct only for
    // tenants serving that pack, and would have left exactly the tenant-declared PHI field
    // unguarded. The registry stays shared — it owns provisioning and the memoised per-tenant
    // store — while the router is a thin dispatcher, so one per gateway costs nothing.
    const tenantStoreFor = (tenantManifest: Manifest): EntityStore =>
      tenantStoreRegistry === null
        ? jsonbStore
        : new TenantColumnStoreRouter({
            registry: tenantStoreRegistry,
            fallback: jsonbStore,
            encryptedEntities: encryptedEntityNames(tenantManifest),
          });
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
          store: tenantStoreFor(tenantManifest),
          // The deployment's, not the tenant's: the secret is one deployment secret and the key is
          // derived per tenant inside the sealer, so an activated manifest gets sealed cursors on
          // the same terms — and the boot refusal travels with it, since this is the function that
          // carries the obligation check (ADR-0340's placement).
          cursorSealing,
          // The same declaration a per-tenant gateway gets, because the policy is a property of
          // the deployment rather than of one manifest. The *survey* is not re-run here — see
          // ADR-0339 Q6: a tenant activating a manifest whose required classified field no role
          // can write discovers it as a 403 on create, and the check belongs beside ADR-0334's
          // `unservable_field_type` in `applyTenantManifestSchema`.
          policyForEntity: sensitivePolicyForEntity,
          writeMaskMode,
          // One policy layer for every gateway: a policy key is a deployment declaration and an
          // attribute is a fact about a membership in the tenant being served, so neither varies
          // with whose manifest is compiled. The per-tenant manifest's own obligations are checked
          // against `answerableKeys` by `buildOperateHttpServer`.
          ...(abac !== undefined ? { abac } : {}),
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
          // A tenant serving their own manifest is still that tenant, so the gate travels with the
          // per-tenant gateway too — one directory instance, so the cache is shared rather than
          // re-read per compiled tenant.
          ...(tenantStatusGate !== undefined ? { tenantStatusGate } : {}),
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
      // The consecutive-fax counter (ADR-0332). Constructed only when asked for, because a run is
      // a durable row per (tenant, number) and a deployment that does not want the count should not
      // be accumulating one.
      const faxObservations = options.bounceFaxObservations
        ? new PostgresFaxObservationStore(conn, schemaOpt)
        : null;
      if (options.bounceFaxObservations) {
        console.info(
          "[bounce-webhook] counting consecutive fax verdicts" +
            (options.bounceFaxSuppressAfter === null
              ? " (counting only — no --bounce-fax-suppress-after, so nothing will be suppressed)"
              : `, suppressing after ${options.bounceFaxSuppressAfter.toString()}`),
        );
        if (process.env["TWILIO_VOICE_MACHINE_DETECTION"] === undefined) {
          // A warning rather than a refusal: the counter is harmless while inert, and machine
          // detection can be enabled at Twilio without restarting this process. But said out loud,
          // because without it Twilio never reports `AnsweredBy` and no run can ever start — a
          // threshold configured and structurally unreachable.
          console.warn(
            "[bounce-webhook] --bounce-fax-observations is on but TWILIO_VOICE_MACHINE_DETECTION" +
              " is unset, so Twilio will never report AnsweredBy and no fax verdict can arrive",
          );
        }
      }
      const intercept = buildBounceWebhookInterceptor({
        store: suppressions,
        secretForTenant: resolver,
        ...(options.bounceTransientHours !== null
          ? { transientSuppressionHours: options.bounceTransientHours }
          : {}),
        ...(faxObservations !== null ? { faxObservations } : {}),
        ...(options.bounceFaxSuppressAfter !== null
          ? { faxSuppressAfter: options.bounceFaxSuppressAfter }
          : {}),
        ...(options.bounceFaxWindowHours !== null
          ? { faxObservationWindowHours: options.bounceFaxWindowHours }
          : {}),
        // No address and no CallSid: a voice suppression names a real person's telephone number.
        // The run length is what an operator acts on, and it is the thing nothing recorded before.
        onObserved: (info) =>
          console.info(
            `[bounce-webhook] tenant=${info.tenantId} ${info.signal} ${info.disposition}` +
              ` run=${info.consecutiveCount.toString()} suppressed=${String(info.suppressionPlanned)}`,
          ),
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
  workflowWorkers?.start();
  pruneScheduler?.start();
  idempotencyPrune?.start();
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
        idempotencyPrune?.stop();
        // The aggregate, once, at the one moment it is actionable. Every swallowed `put` is already
        // logged individually, but a count is what says whether the guard was working at all —
        // `failed > 0` means that many mutations have no dedup record and a retry of each would
        // re-execute, which is precisely the thing the flag was turned on to prevent.
        if (idempotencyStore !== undefined) {
          const report = idempotencyStore.report();
          if (report.failed > 0) {
            console.error(
              `[idempotency] ${String(report.persisted)} record(s) stored, ` +
                `${String(report.failed)} NOT stored — a retry of each would re-execute; ` +
                `first failure: ${report.firstFailure ?? "unknown"}`,
            );
          } else {
            console.info(`[idempotency] ${String(report.persisted)} record(s) stored, 0 failed`);
          }
        }
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
        // Hand every claimed timer, activity and job run back before the process goes away, so
        // another replica picks them up immediately instead of waiting out the lease. Reported
        // rather than silent: past the drain budget the in-flight item is abandoned to its lease,
        // which is the design — but a shutdown that left work leased is exactly what an operator
        // needs in the log when the next replica looks idle for 30 seconds.
        // Awaited and not reported here: the supervisor's own `onDrained` event already names each
        // worker, whether it stopped, and how many claims it released — and words the budget-elapsed
        // case better than a second line at this call site did. Logging it twice was the first thing
        // the live boot showed, including a dangling "drained: " with an empty detail when all three
        // workers had refused and there was nothing to drain.
        const workersDrained: Promise<unknown> =
          workflowWorkers?.drain() ?? Promise.resolve(undefined);
        // Both drains, not one after the other: they touch different things (the chain's append
        // queue and the claim tables) and a shutdown should not pay for them serially.
        // Drain any queued audit-chain appends too, so no request's entry is lost on shutdown.
        void Promise.all([
          auditChain?.observer.drain() ?? Promise.resolve(),
          workersDrained,
          // The capture's in-flight writes, in the same parallel set rather than after it. Purely
          // observational, so abandoning them would lose a fraction of a fraction — but it is
          // bounded by `maxInFlight` and costs nothing to wait for, and a shutdown that dropped
          // rows it had already decided to sample would make the sample a lie about itself.
          executionCapture?.drain() ?? Promise.resolve(),
        ]).finally(() => {
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
/**
 * `operate-server replay` — the first caller any of the six drift replayers has ever had.
 *
 * Read-only by construction: every runner below calls a `verify*` / `replay*` method and none
 * calls a write. The repairing half of the workflow replayer (`resyncInstance` / `bulkResync`) is
 * deliberately **not** reachable from here. Its derivation is authorised — an append-only log is
 * the authority and a projection behind it is simply wrong — but the implementation is not safe to
 * apply yet: the repair is not one transaction (so a failure mid-loop leaves the half-resynced
 * instance its own comment says it exists to prevent), and it writes `workflow_timers.status` and
 * `workflow_activities.status`, which are the very columns `claimDueTimers` and
 * `claimDueActivities` select on — so a resync is a second writer editing a running fleet's queue
 * with no guard clause. `--workflow-workers` mounts that fleet, so this is live rather than
 * hypothetical. Detection is wireable today; repair is not, and the honest surface says so by
 * offering only the former.
 */
export async function runReplay(options: ReplayOptions): Promise<ReplayReport> {
  const conn = createNodePgConnection(parsePgEnvConfig());
  try {
    const selected: readonly ReplaySubsystem[] =
      options.subsystems.length > 0 ? options.subsystems : REPLAY_SUBSYSTEMS;
    const runners = buildReplayRunners(options.schema);
    const sections: ReplaySection[] = [];

    if (options.allTenants) {
      // A loop over `meta.tenants`, which for two of the six subsystems is the only complete mode:
      // their tables carry the isolation policy as their only arm, so an unscoped read matches
      // zero rows as a non-owner. `prune-links`' precedent, and the same reason.
      const tenants = await new PostgresTenantSource(conn).activeTenantIds();
      for (const tenantId of tenants) {
        const coverage: ReplayCoverage = { kind: "tenant", tenantId };
        const servable = selected.filter((sub) => subsystemsServedBy(coverage).includes(sub));
        sections.push(
          ...(await runReplaySections(conn, coverage, servable, runners, options.limit)),
        );
      }
      // Then the platform scope and the unscoped subsystems, so `--all-tenants` means every scope
      // rather than every tenant: a platform-scope row belongs to no tenant and would otherwise be
      // the one thing a full sweep never examined.
      for (const coverage of [{ kind: "platform" } as const, { kind: "unscoped" } as const]) {
        const servable = selected.filter((sub) => subsystemsServedBy(coverage).includes(sub));
        if (servable.length > 0) {
          sections.push(
            ...(await runReplaySections(conn, coverage, servable, runners, options.limit)),
          );
        }
      }
      // Anything the whole sweep could never reach is still reported, rather than quietly absent.
      const reached = new Set(sections.map((sec) => sec.subsystem));
      for (const sub of selected) {
        if (!reached.has(sub)) {
          sections.push({
            subsystem: sub,
            coverage: { kind: "unscoped" },
            complete: false,
            scanned: 0,
            refusal: "no scope in this sweep can serve this subsystem",
            findings: [],
          });
        }
      }
      return summarizeReplay(sections);
    }

    const coverage: ReplayCoverage =
      options.tenantId !== null
        ? { kind: "tenant", tenantId: options.tenantId }
        : options.platform
          ? { kind: "platform" }
          : { kind: "unscoped" };
    return summarizeReplay(
      await runReplaySections(conn, coverage, selected, runners, options.limit),
    );
  } finally {
    await conn.close();
  }
}

/**
 * One runner per subsystem, each rendering its own findings vocabulary to strings at this
 * boundary.
 *
 * Rendered here and not merged upstream: the five vocabularies mean genuinely different things — a
 * stored outcome contradicting its own stage log, an append-only timeline out of order, a
 * close-out the store refused, a row that no longer satisfies its contract — and collapsing them
 * into one enum would either lose those distinctions or grow to forty-odd members. So each
 * package keeps its own enum and only the *presentation* is uniform.
 *
 * `workflow` is absent, deliberately. `WorkflowReplayer` needs a definition map, which means
 * `PostgresWorkflowDefinitionStore` + `loadEngineDefinitions`, and under RLS as a non-owner with no
 * tenant context that map loads **empty** — whereupon the replayer refuses every instance by name
 * (`definition_unresolved`) rather than reporting drift, which is correct but means the section
 * would consist entirely of refusals. It also requires an RLS-bypassing session by its own
 * account. Reporting `no runner wired` with that reason is more honest than a section of refusals
 * that reads like a failure of the instances rather than of the session.
 */
function buildReplayRunners(
  schema: string | null,
): Readonly<Partial<Record<ReplaySubsystem, ReplaySubsystemRunner>>> {
  const schemaOpt = schema !== null ? { schema } : {};
  void schemaOpt;
  return {
    dr: {
      run: async (conn, coverage, limit) => {
        const replayer = new DrReplayer(
          new PostgresDrFailoverStore(conn),
          new PostgresDrDrillStore(conn),
        );
        const scope = coverage.kind === "tenant" ? coverage.tenantId : null;
        const issues = await replayer.bulkVerify(scope, limit);
        const summary = await replayer.summarize(scope, limit);
        return {
          complete: summary.failovers + summary.drills < limit * 2,
          scanned: summary.failovers + summary.drills,
          refusal: null,
          findings: issues.map((i) => `${i.kind} [${i.executionId}]: ${i.detail}`),
        };
      },
    },
    slo: {
      run: async (conn, coverage, limit) => {
        const replayer = new SloEnforcementReplayer(new PostgresSloEnforcementActionStore(conn));
        const scope = coverage.kind === "tenant" ? coverage.tenantId : null;
        const issues = await replayer.verifyRecent(limit, scope);
        const summary = await replayer.summarizeRecent(limit, scope);
        return {
          complete: summary.total < limit,
          scanned: summary.total,
          refusal: null,
          findings: issues.map((i) => `${i.kind} [${i.actionId}]: ${i.detail}`),
        };
      },
    },
    access_reviews: {
      run: async (conn, coverage) => {
        // Guarded by `scopeRefusal` before this runs, but asserted rather than assumed: the
        // tenant id is the only thing that makes this read return a row at all.
        if (coverage.kind !== "tenant") throw new Error("access_reviews requires a tenant scope");
        const replayer = new AccessReviewReplayer({
          campaignStore: new PostgresAccessReviewCampaignStore(conn),
          itemStore: new PostgresAccessReviewItemStore(conn),
          decisionStore: new PostgresAccessReviewDecisionStore(conn),
        });
        const replays = await replayer.replayTenant(coverage.tenantId);
        return {
          complete: true,
          scanned: replays.length,
          refusal: null,
          findings: replays.flatMap((r) =>
            r.issues.map((i) => `${i.kind} [${r.campaignId}]: ${i.detail}`),
          ),
        };
      },
    },
    gateway: {
      run: async (conn, coverage, limit) => {
        const replayer = new GatewayReplayer({ conn });
        const scope = coverage.kind === "tenant" ? coverage.tenantId : null;
        const reports = await replayer.bulkVerify({ scope, maxExecutions: limit });
        const drifted = reports.filter((r) => r.drifted);
        return {
          complete: reports.length < limit,
          scanned: reports.length,
          refusal: null,
          findings: drifted.flatMap((r) =>
            r.issues.map((i) => `${i.code} [${r.requestId}]: ${i.detail}`),
          ),
        };
      },
    },
    incidents: {
      run: async (conn, _coverage, limit) => {
        const report = await replayIncidents(conn, { limit });
        return {
          complete: report.windowComplete,
          scanned: report.scanned,
          refusal: null,
          findings: report.drift.map((d) => `${d.kind} [${d.incidentId}]: ${d.detail}`),
        };
      },
    },
  };
}

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
