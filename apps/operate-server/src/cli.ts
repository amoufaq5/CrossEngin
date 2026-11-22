import {
  RateLimitPolicyDeclarationError,
  declareRateLimitPolicies,
  parseRateLimitPolicySpec,
  type DeclaredRateLimitPolicy,
  type RateLimitPolicyDeclaration,
} from "@crossengin/api-gateway-pg";
import { REQUIRED_JWT_CLAIMS } from "@crossengin/api-gateway-runtime";
import { REGIONS } from "@crossengin/residency";
import { PackCompatibilitySchema, PackPublisherRegistry, parsePackPublisherSpec } from "@crossengin/marketplace";
import {
  DEFAULT_DELETION_GRACE_DAYS,
  DELETION_SUBSYSTEMS,
  SUBSYSTEM_DISPOSITIONS,
} from "@crossengin/tenant-lifecycle";
import {
  parsePgPoolSetting,
  pgPoolSettingForFlag,
  type PgPoolSettings,
} from "@crossengin/kernel-pg";
import {
  SENSITIVE_DATA_CLASSIFICATIONS,
  type DataClassification,
} from "@crossengin/types/meta-schema";

import { COLUMN_ENCRYPTION_SECRET_VAR } from "./column-encryption.js";
import {
  httpListenerSettingForFlag,
  parseHttpListenerSetting,
  resolveHttpListenerSettings,
  type HttpListenerSettings,
} from "./http-listener.js";
import { PRE_AUTH_LIMIT_FLAG, parsePreAuthLimitPolicy, type PreAuthLimitPolicy } from "./pre-auth-limit.js";
import { ALLOW_CURSOR_DISCLOSURE_FLAG } from "./cursor-encryption.js";
import { ALLOW_UNCOVERED_SETTLEMENT_FLAG } from "./settlement-coverage-survey.js";
import type { DeclaredModelPrice } from "./ai-design.js";
import { AiModelPriceInvalid, parseDeclaredModelPrice } from "./ai-design-pricing.js";
import { AiSettingInvalid, parseAiMaxOutputTokens, parseAiProviderTimeoutMs } from "./ai-model-source.js";
import {
  AI_TENANT_PSEUDONYM_FLAG,
  AI_TENANT_PSEUDONYM_MODES,
  DEFAULT_AI_TENANT_PSEUDONYM_MODE,
  isAiTenantPseudonymMode,
  type AiTenantPseudonymMode,
} from "./ai-tenant-pseudonym.js";
import { parseAiProviderRef } from "./ai-provider-residency.js";
import {
  COLUMN_KEY_MODES,
  COLUMN_KEY_MODE_FLAG,
  COLUMN_KEY_TTL_BOUNDS,
  COLUMN_KEY_TTL_FLAG,
  DEFAULT_COLUMN_KEY_TTL_MS,
  type ColumnKeyMode,
} from "./data-key-envelope.js";
import {
  COLUMN_KEY_SURVEY_CEILING_BOUNDS,
  COLUMN_KEY_SURVEY_CEILING_FLAG,
  PER_TENANT_SURVEY_CEILING,
} from "./column-key-consistency.js";
import { ABAC_POLICY_FLAG } from "./abac-policy.js";
import {
  SENSITIVE_FIELD_CLASS_FLAG,
  SENSITIVE_FIELD_ROLE_FLAG,
} from "./sensitive-field-policy.js";
import {
  MIN_LOGIN_LOCKOUT_ATTEMPTS,
  MIN_LOGIN_LOCKOUT_SECONDS,
  DEFAULT_LOGIN_LOCKOUT_ATTEMPTS,
  DEFAULT_LOGIN_LOCKOUT_SECONDS,
} from "./auth-token-route.js";
import {
  MAX_SESSION_TOKEN_SECONDS,
  MIN_SESSION_TOKEN_SECONDS,
  DEFAULT_SESSION_TOKEN_SECONDS,
} from "./token-mint.js";
import { CREDENTIAL_PEPPER_VAR, TOKEN_SIGNING_KEY_VAR } from "./credential-auth-env.js";
import {
  DEFAULT_MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
  MIN_MIN_PASSWORD_LENGTH,
} from "./credential-routes.js";
import type { SetCredentialOptions } from "./set-credential.js";
import { NEW_PASSWORD_VAR } from "./set-credential.js";
import { parseHmacKeySpec, parseJwksKeySpec, parseMtlsClientSpec } from "./principals.js";
import { BUILTIN_PACK_NAMES } from "./manifest-source.js";
import {
  RETENTION_FLAG,
  RetentionPolicyError,
  resolveRetentionPolicy,
  type RetentionPolicy,
} from "./operational-retention.js";
import { DEFAULT_ADMIN_ROLES } from "./recipient-resolver.js";
import { MIN_FAX_SUPPRESSION_THRESHOLD } from "@crossengin/notification-providers";
import { DEFAULT_UNREAD_SCAN_LIMIT, MAX_UNREAD_SCAN_LIMIT } from "./read-state-routes.js";
import { parseRequestBodyLimit, parseRouteBodyLimits } from "./request-body-limit.js";
import type { RekeyOptions } from "./rekey.js";
import { REPLAY_SUBSYSTEMS, type ReplaySubsystem } from "./replay.js";
import {
  GatewayExecutionCaptureConfigSchema,
  type GatewayExecutionCaptureConfig,
} from "./gateway-execution-capture.js";

export type StoreKind = "memory" | "pg" | "pg-columns";

export interface ServeOptions {
  readonly port: number;
  readonly pack: string | null;
  readonly manifestPath: string | null;
  readonly store: StoreKind;
  /**
   * Serve a manifest declaring `phi`/`regulated` fields from a store that cannot encrypt them.
   *
   * Off by default, and that default is a *refusal* rather than this repo's usual opt-in posture:
   * ADR-0334 left `--tenant-status-gate` opt-in because on-by-default would refuse requests of a
   * deployment that works today, and here the reasoning inverts — no deployment serves PHI
   * correctly today, so refusing breaks nothing that worked. `--store pg` and `--store memory`
   * hold a classified field as plaintext (verified live: `document->>'mrn'` reads back the value),
   * and a classification that silently means nothing is worse than one that refuses.
   *
   * It does not rescue `--store pg-columns` without a key: there the column is `BYTEA`, so the
   * write cannot succeed at all and "allow plaintext" would name an outcome that store cannot
   * produce.
   */
  readonly allowPlaintextPhi: boolean;
  /**
   * Accepts ADR-0345's cursor disclosure knowingly, when a `list` grant filters rows and no
   * `CURSOR_ENCRYPTION_SECRET` is set.
   *
   * `--allow-plaintext-phi`'s shape and not `obligation_unevaluable`'s: ADR-0340 refused an escape
   * hatch because serving a grant with its qualifier removed is the *opposite* of what the manifest
   * declares, while a plaintext cursor is degraded-but-coherent — the filter works, the rows are
   * withheld, and only their positions leak. An operator whose ids are opaque and whose sort key is
   * uninteresting may reasonably accept that; one who has not thought about it should be refused.
   *
   * It accepts a disclosure rather than requesting one, so it does **not** suppress sealing: a
   * deployment that sets the secret gets sealed cursors whether or not it also passes this.
   */
  readonly allowCursorDisclosure: boolean;
  /**
   * Accepts knowingly that a document may be marked settled while completed payments do not cover
   * its total — the state in which the aging subledger reports nothing open and the GL control
   * account still carries the residual, with nothing reconciling the two.
   *
   * `--allow-plaintext-phi`'s shape and deliberately not ADR-0340's no-hatch shape, and the
   * distinction is the same one `allowCursorDisclosure` draws two fields up: an unevaluated ABAC
   * obligation is the *opposite* of what the manifest declares and nothing a tenant does repairs
   * it, while an uncovered settlement is degraded-but-**recoverable** — record the payment and the
   * two views reconcile — so it is a state an operator may reasonably accept.
   *
   * It does not suppress the boot survey: a deployment that passes it is still told which of its
   * settleable documents are now unguarded, because the defect being closed was the silence.
   */
  readonly allowUncoveredSettlement: boolean;
  /**
   * Keeps `--store pg` storing a reference to a record that does not exist and deleting a record
   * others reference — the document store's behaviour before it enforced references.
   *
   * Off by default, on ADR-0338's rule read carefully: what the enforcement refuses is a write whose
   * reference names no record (the general ledger's fallback account code, measured to post journal
   * lines naming no account) and a delete that would leave references dangling, and neither of
   * those was a correct answer. But one of them is a workflow a deployment runs today — sending an
   * invoice before the tenant's ledger accounts are configured — so the old behaviour stays one
   * announced flag away. Uniqueness is not affected by it. Refused on any store but `pg`, because
   * the column store's foreign keys are DDL that no flag removes, and a flag that changed nothing
   * there would read as having done something.
   */
  readonly allowDanglingReferences: boolean;
  /**
   * Refuse an approve-class transition (approve, post, mark_paid, reimburse, Payment.complete)
   * fired by the person recorded as the record's creator. Off by default, because a single-user
   * tenant has nobody else to approve with — on there, every bill would be unapprovable.
   */
  readonly segregationOfDuties: boolean;
  /**
   * How the at-rest column key is obtained (ADR-0347): `derived` recomputes it from
   * `COLUMN_ENCRYPTION_SECRET` on demand and stores nothing, `envelope` stores a wrapped per-tenant
   * data key so it can be **destroyed**.
   *
   * `derived` stays the default because switching is one-way per tenant in practice — the first
   * request provisions a row, and a tenant seeded from the derived key keeps its ciphertext
   * readable while one provisioned at random does not go back. The mode is declared rather than
   * inferred from whether the table has rows, so a deployment cannot drift into the envelope by
   * accident.
   */
  readonly columnKeyMode: ColumnKeyMode;
  /**
   * How long a resolved per-tenant column key is served from memory, or `null` for the default.
   *
   * It exists because a **rekey** changes that key out of process. ADR-0347 cached it with no
   * expiry and argued the staleness was harmless; a rekey makes it reachable in the worse
   * direction, since a process still holding the previous key writes new ciphertext under it. The
   * TTL bounds the window and does not close it.
   */
  readonly columnKeyTtlMs: number | null;
  /**
   * How many tenants the boot column-key survey reads one by one on a confined session before it
   * reports the rest as unexamined (ADR-0455, ADR-0460). Defaulted at parse to
   * `PER_TENANT_SURVEY_CEILING`, so it is always a number here and the boot line can state it.
   */
  readonly columnKeySurveyCeiling: number;
  readonly schema: string | null;
  readonly apiKeys: readonly string[];
  /**
   * `--hmac-key keyId:role:tenant[:principalId]`, repeatable.
   *
   * On argv and **not** behind an environment variable, which is the one place in this file that
   * departs from ADR-0301 deliberately rather than by omission: the first field is a key *id*, not
   * a credential — it travels in the clear in every signed request's header — so publishing it via
   * `ps` discloses nothing. The secret it derives from is `REQUEST_SIGNING_SECRET`, read from the
   * environment by `request-signing.ts` and reachable through no flag at all.
   */
  readonly hmacKeys: readonly string[];
  /**
   * `--mtls-client fingerprint:role:tenant:principalId`, repeatable.
   *
   * Carries **nothing secret**, which is a stronger statement than `--hmac-key`'s and is why there
   * is no environment route beside it: a certificate's sha256 is derived from material the client
   * presents to everyone it connects to, so there is no value here `ps` could disclose.
   */
  readonly mtlsClients: readonly string[];
  /**
   * Whether the hop in front of this process performs mutual TLS and **overwrites**
   * `CrossEngin-Client-Cert-Sha256`, `CrossEngin-Tls-Version` and the `x-forwarded-*` headers.
   *
   * The declaration every forwarded fact is read under. It is a statement about the *network*, which
   * is why it is a flag and not something the gateway could establish: nothing in this process can
   * tell a header its edge set from one a caller set.
   */
  readonly trustedEdgeClientCert: boolean;
  readonly jwksKeys: readonly string[];
  readonly jwksFile: string | null;
  readonly jwksUrl: string | null;
  readonly jwksRefreshMs: number | null;
  readonly jwtIssuer: string | null;
  readonly jwtAudience: string | null;
  /**
   * JWT claims this deployment will accept a token **without**, declared per claim.
   *
   * The relaxation is what is declared, so the default is strict: before ADR-0386 every claim guard
   * was *present and wrong*, so a token carrying none of `exp`/`iss`/`aud` verified as
   * `authenticated`. Per claim and not one boolean because the three costs differ, and an operator
   * who must accept one absence has not thereby accepted the others.
   */
  readonly jwtOptionalClaims: readonly string[];
  /**
   * Mounts `POST /v1/auth/token`, which turns a password into a session token the gateway's own
   * JWKS stage verifies. Needs a Postgres store, `CREDENTIAL_PEPPER` and
   * `OPERATE_TOKEN_SIGNING_KEY` in the environment, and `--jwt-issuer` / `--jwt-audience` -- the
   * minted token has to assert exactly what the verifier beside it expects.
   */
  readonly credentialLogin: boolean;
  /** Session token lifetime in seconds. Also how long a revoked membership keeps its role. */
  readonly sessionTokenTtl: number | null;
  /** Consecutive failed passwords before an account locks. Refused below the floor, not clamped. */
  readonly loginLockoutAttempts: number | null;
  readonly loginLockoutSeconds: number | null;
  /**
   * The shortest password the credential routes and `set-credential` accept (H-07). Null is
   * `DEFAULT_MIN_PASSWORD_LENGTH`. Checked when a password is SET, never at login, so an existing
   * hash under a shorter password keeps working until its holder changes it.
   */
  readonly minPasswordLength: number | null;
  /**
   * Boot with an `--api-key` / `OPERATE_API_KEY_SPECS` token whose estimated entropy is under the
   * floor, which otherwise refuses the boot (M-28). Announced at boot; a short token is a guessable
   * credential, so the hatch exists for a deployment rotating keys rather than as a default.
   */
  readonly allowWeakApiKeys: boolean;
  /**
   * Let a bearer token signed by a key this deployment does not mint with carry a platform role
   * (H-04). Off, such a token has every platform-authority role removed from its scopes, so an
   * IdP's `scope` cannot grant tenant provision or deletion. Announced at boot either way.
   */
  readonly idpPlatformRoles: boolean;
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
  /** Count consecutive Twilio `AnsweredBy=fax` verdicts per number in meta.notification_fax_observations. Counting only; suppression needs the threshold below. */
  readonly bounceFaxObservations: boolean;
  /**
   * Consecutive fax verdicts before a **permanent** voice_call hard_bounce is recorded.
   *
   * Null is the designed default — count, report, never suppress — not a degradation:
   * `AnsweredBy` is a detector's guess from a few hundred ms of audio, and ADR-0302's rule is that
   * a safety record never widens on an inference, so the one suppression derived from one is the
   * one a deployment asks for (`transientSuppressionHours`' precedent).
   *
   * Permanent rather than bounded for a mechanical reason: the suppression store's only conflict
   * action is `DO NOTHING` and its id commits to (tenant, channel, address, reason), so a bounded
   * row **cannot be renewed** — it would mean suppressed for N days and then never suppressible
   * again, carrying the full risk of being wrong and keeping none of the benefit.
   */
  readonly bounceFaxSuppressAfter: number | null;
  /** How long a run of fax verdicts stays one run (default 168h). A verdict arriving later restarts it at one: a number gets reassigned, and verdicts months apart are not evidence about the same device. */
  readonly bounceFaxWindowHours: number | null;
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
  /**
   * Roles permitted to cancel a workflow instance (repeatable); empty refuses everyone.
   *
   * Its **own** grant, deliberately not `--job-invoke-role`. The job-cancel route shares that one
   * on the argument that starting and stopping a job are one privilege over one queue, and that
   * does not transfer: a workflow instance is not a job run, and a `compensate` cancellation runs
   * reversing handlers over real GL postings (ADR-0329). Fail-closed on empty, like job-cancel.
   */
  readonly workflowCancelRoles: readonly string[];
  /**
   * Mount the three durable workers (timer / activity / job) that drive the workflow queues. The
   * engine has been present since ADR-0331 and nothing polled it, so a due timer never fired and
   * `--schedule-ms` enqueued job runs that nothing drained.
   */
  readonly workflowWorkers: boolean;
  /** Path to a `WorkflowWorkerConfig` JSON (batch limit, lease, poll cadence, drain budget). */
  readonly workflowWorkerConfig: string | null;
  /**
   * Leave a scheduled activity at rest for the activity worker instead of running its handler
   * inline. Only meaningful with `--workflow-workers`, and refused without it — see the refusal.
   */
  readonly workflowDeferActivities: boolean;
  /**
   * Enforce `meta.tenants.status` on the request path (ADR-0334): a `suspended` / `archived` /
   * `pending_deletion` tenant is read-only and a `deleted` one is refused outright.
   *
   * **On by default on a Postgres store**, with `--no-tenant-status-gate` as the announced hatch.
   * ADR-0334 left it opt-in because the gate refuses a credential whose tenant has no
   * `meta.tenants` row — and ADR-0376 measured what that "working" request was: a 200 writing
   * records under a `tenant_id` with no parent, while a suspended or `pending_deletion` tenant went
   * on writing into data about to be destroyed. Serving an unprovisioned tenant is not a correct
   * answer, so refusing it breaks nothing that worked (ADR-0338's rule); the shipped compose has
   * passed the flag since ADR-0376, so the binary default now agrees with the deployment. A boot
   * survey still names unprovisioned API-key tenants before the first request.
   */
  readonly tenantStatusGate: boolean;
  /** How the gate's setting was reached, so the boot line can say a default is a default. */
  readonly tenantStatusGateSource: "flag" | "default" | "disabled_by_flag" | "not_applicable";
  /** How long a resolved tenant status is cached (ms). Default 30s. */
  readonly tenantStatusTtlMs: number | null;
  /**
   * A per-process bound on requests before authentication, keyed on address and credential shape.
   * `null` is off, the default — on the shipped stack every caller reaches the API from the proxy's
   * one address, so a per-address bound is a single shared budget there (see `pre-auth-limit.ts`).
   */
  readonly preAuthRateLimit: PreAuthLimitPolicy | null;
  /**
   * Mount the platform **user registry** (`meta.users` + `meta.user_tenant_membership`).
   *
   * Neither table had a writer, while 50 catalogued columns carry a `NOT NULL ON DELETE RESTRICT`
   * reference into `meta.users` — ten of them on tables with a live writer, so ten stores could not
   * insert a row. `deploy/README.md` told operators to put a real `meta.users.id` into an
   * `--api-key` spec with no documented way to make one. And with one row provisioned,
   * `PostgresRecipientResolver` resolved a real audience for the first time: until then every
   * audience in every deployment resolved to `[]`, so the notification stack had never had a
   * recipient (ADR-0335).
   */
  /**
   * The rate-limit policies this deployment declares, or `null` for none — in which case the
   * gateway keeps `InMemoryRateLimitChecker`'s hardcoded 10,000/60s and persists nothing, as today.
   *
   * **Not** defaulted to `CONSERVATIVE_RATE_LIMIT_POLICY`: which limit a deployment permits is not
   * something silence may answer (ADR-0328's rule), and switching an existing deployment from
   * 10,000/60s to 600/60s on upgrade would refuse traffic that works today.
   */
  readonly rateLimitPolicies: RateLimitPolicyDeclaration | null;
  /**
   * `true` ⇒ the gateway's replay guard is `meta.gateway_idempotency_records`. Absent ⇒
   * `InMemoryIdempotencyStore`, which is today's behaviour and is **per process**: a retried `POST`
   * landing on another replica, or on this one after a restart, is not deduplicated — including on
   * `--tenant-deletion-routes`, the one route here that *requires* a key, because a retry mints a
   * second tombstone id and then answers `409 scope_empty` for a request that had succeeded.
   *
   * The guarantee it buys is bounded and stated rather than implied (`IDEMPOTENCY_GUARANTEE`):
   * the gateway reserves the key before the handler runs, so a concurrent retry is answered `409`
   * in progress across the fleet, and a handler outliving the reservation's lease is the bound.
   */
  readonly pgIdempotencyStore: boolean;
  /**
   * The operational-table retention policy, or `null` when `--retention-sweep` is absent and
   * nothing is pruned. Opt-in because the sweep deletes rows a working deployment keeps today —
   * an old in-app notice disappears from its reader's inbox — so it is an operator's decision and
   * not an upgrade's (ADR-0338's rule read the other way). The boot line says either way.
   */
  readonly retention: RetentionPolicy | null;
  /**
   * Persist this fraction of `PipelineExecution` rows — the writer
   * `meta.gateway_pipeline_executions` never had, and the only thing that gives `GatewayReplayer`
   * a row to read. `null` ⇒ nothing persisted, as today.
   *
   * The rate is **required** when the flag is given and has no `z.default()`: ≈2.1 KB a row
   * including indexes is ≈6.6 TB/year at 100 req/s and ≈66 TB/year at 1,000 req/s unsampled — the
   * same order as the figure that refused `meta.feature_flag_evaluations` a writer altogether — and
   * a write volume must not be chosen by silence (ADR-0328's rule).
   */
  readonly gatewayExecutionCapture: GatewayExecutionCaptureConfig | null;
  readonly platformUserRoutes: boolean;
  /**
   * Roles permitted to administer that registry. Fail-closed: empty ⇒ the routes refuse everything.
   *
   * Separate from `--platform-admin-role`, which administers *tenants*: a deployment may well want
   * the people who can create tenants to be a different set from the people who can create the
   * identities inside them.
   */
  readonly platformUserRoles: readonly string[];
  /**
   * Roles permitted to set **another** user's password, over
   * `POST /v1/platform/users/{id}/credential`.
   *
   * Separate from `--platform-user-role` for a reason stronger than the tenants/identities split
   * above: `meta.users` has no `tenant_id`, no RLS and no policies, so for a write to that table
   * the route's role check is the *entire* authorisation — there is no policy behind it that would
   * refuse a session which got past the handler, which is the belt every tenant-scoped write here
   * has. Provisioning a principal and taking over its credential are different privileges, and the
   * second has nothing underneath it.
   *
   * There is deliberately no `--credential-routes` boolean beside this. The **self**-service change
   * (`POST /v1/account/password`) mounts whenever `--credential-login` does, because a deployment
   * that can log in must be able to change the password it logs in with, and putting that behind a
   * second opt-in is a feature with a trap in it (`--idempotency-store`'s reaper argument).
   */
  readonly credentialAdminRoles: readonly string[];
  /** Mount the per-user notification preference routes (`meta.notification_preferences`). */
  readonly preferenceRoutes: boolean;
  /** Roles permitted to read and set one's own preferences. Fail-closed on empty. */
  readonly preferenceRoles: readonly string[];
  /** Additive grant for setting another user's preferences, recorded before the write. */
  readonly preferenceAdminRoles: readonly string[];
  /** Path to a marketplace pack-catalog JSON ({packs:[...]}) — enables the /v1/admin/packs routes (needs pg). */
  readonly packCatalogFile: string | null;
  /** Enable the third-party authoring routes (/v1/authoring/packs — submit/review/publish pack versions). Needs pg. */
  readonly marketplaceAuthoring: boolean;
  /**
   * The platform's pinned publisher keys, each `<namespace>:<authorKind>:<publicKeyBase64>`. A pack is
   * verified against the registered key its signature names, never a key supplied with it; both
   * marketplace surfaces refuse to mount with none.
   */
  readonly packPublisherKeys: readonly string[];
  /** The platform version a pack's compatibility envelope is compared against; unknown when absent. */
  readonly marketplacePlatformVersion: string | null;
  /** Roles allowed to install and uninstall catalog packs for their tenant (default erp_admin). */
  readonly packAdminRoles: readonly string[];
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
  /**
   * Mount the checkpoint scheduler over `DEFAULT_CHECKPOINT_CONFIG` — the schema's own defaults
   * plus `allTenants` — with no file.
   *
   * A boolean rather than a documented `{}` because the file's natural content is a trap: an empty
   * config resolves to the platform chain alone, which on a deployment with no escalation flag is
   * empty, and an empty scope's report is discarded (ADR-0399) — so the pass anchors nothing,
   * verifies nothing and prints nothing. Mutually exclusive with `--checkpoint-config`.
   */
  readonly checkpoints: boolean;
  /** Path to a JSON integrity-proof config ({schema?, intervalMs?, verifiedBy?, tenants?, includePlatform?, allTenants?, tenantStatuses?, auditRowLimit?, fromCheckpoint?, recordVerdict?, escalation?}) — periodically runs BOTH halves of the audit-integrity proof (row↔anchor and the chain's own links + signatures) per tenant, records the verdict in the chain, and with `escalation` declares an incident + pages once per compromised episode (needs --store pg + --audit-chain-config). */
  readonly integrityProofConfig: string | null;
  /** `--checkpoints`' sibling for the integrity proof; same literal shape, same reason. */
  readonly integrityProof: boolean;
  /**
   * `--integrity-proof`'s `fullFoldEveryPasses` (H-18): fold the whole chain on the first pass and
   * every Nth, 0 never. Null keeps the default. The file route states it in the file.
   */
  readonly integrityProofFullEvery: number | null;
  /** Refresh interval (ms) for live per-tenant audit sampling read from meta.operate_tenant_settings; enables the live policy cache (needs --store pg + --audit-chain-config). Null disables it. */
  readonly auditSamplingRefreshMs: number | null;
  /** Expose the platform super-admin tenant-management routes under /v1/platform (list/create/suspend/archive/reactivate tenants + stats over meta.tenants; needs --store pg|pg-columns). */
  readonly platformAdmin: boolean;
  /** Roles allowed to call the platform-admin routes (repeatable; default platform_admin). */
  readonly platformAdminRoles: readonly string[];
  /**
   * Roles allowed to read and write this tenant's own settings (`/v1/admin/settings`), which
   * includes the document-numbering overrides and the formatting defaults the UI renders from.
   *
   * Deliberately NOT `platformAdminRoles`: that grant is cross-tenant and administers the tenant
   * *registry*, while this one is a tenant administering its own row — so a deployment can grant
   * one without the other, which is the split `--notification-admin-role` and
   * `--credential-admin-role` already draw. Repeatable; defaults to `erp_admin`, which is what
   * every deployment got when the role was hardcoded, so declaring nothing changes nothing.
   */
  readonly adminRoles: readonly string[];
  /**
   * The role(s) background jobs act as when they write — the primary first. A job's write goes
   * through the same handler a request is served by, so these roles are checked against the
   * manifest's own grants exactly as a person's are: a job may do what this role may do, and a
   * reviewer reads that off the manifest rather than out of handler code. Repeatable; defaults to
   * `erp_admin`, which every shipped pack declares and grants the writes the shipped handlers make.
   */
  readonly jobActorRoles: readonly string[];
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
  /** Let the principal that requested a design approve it (H-28's hatch; off by default). */
  readonly allowDesignSelfApproval: boolean;
  /** Path to a JSON metering config ({meter?, source?, tenantSubscriptions, countStatuses?, flushIntervalMs?}) — meters the live request stream into billing usage (needs --store pg). */
  readonly meteringConfig: string | null;
  /** Path to a JSON Stripe usage-sync config ({intervalMs?, tenants, subscriptionItems}) — periodically reports persisted usage records to Stripe (needs --store pg + --stripe-api-key). */
  readonly stripeUsageSyncConfig: string | null;
  /** Per-request USD ceiling on AI design spend; null leaves the per-request gate off (the monthly one still applies). */
  readonly aiMaxRequestDollars: number | null;
  /** How long a provider call may go without sending a byte before it is aborted; null is the provider default. */
  readonly aiProviderTimeoutMs: number | null;
  /** `--ai-max-output-tokens`: each design attempt's output budget, or null for the default 8192. */
  readonly aiMaxOutputTokens: number | null;
  /** A declared per-token price for the configured model, which the ceilings are computed from. */
  readonly aiModelPrice: DeclaredModelPrice | null;
  /** Serve a model with no catalogue or declared price, whose ceilings then bound nothing. */
  readonly allowUnpricedModel: boolean;
  /** Where the AI provider runs, as a residency profile's allowedLlmProviders names it. */
  readonly aiProviderRef: string | null;
  /** Whether AI design requests carry the keyed per-tenant pseudonym (ADR-0456) or none (ADR-0461). */
  readonly aiTenantPseudonym: AiTenantPseudonymMode;
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
  /**
   * Per-class sensitive grants, as `<class>=<role>` repeated (ADR-0329).
   *
   * `--audit-read-sensitive-role` is wholesale: a role granted it reads pii *and* phi, so a HIPAA
   * deployment that wants support staff to see a customer's contact details had to expose patient
   * records too, or redact everything from them. A class named here is **authoritative for that
   * class** and the wholesale grant no longer reaches it, which is what makes "pii but not phi"
   * expressible at all — `--audit-read-sensitive-class phi=` (no role) withholds phi from everyone.
   */
  readonly auditReadSensitiveClasses: Readonly<Record<string, readonly string[]>>;
  /**
   * Roles privileged for every sensitive class on the **entity** routes (repeatable).
   *
   * The counterpart of `--audit-read-sensitive-role`, which governs the audit trail and nothing
   * else. `policyForEntity` has never had a producer, so entity responses have been redacted with
   * an empty policy — **39 of the 46 sensitive fields across the seven packs are unreadable by
   * every role in every deployment**, and only the 7 carrying an explicit per-field `read` grant
   * come back at all. This is the declaration that was missing, and it governs reads and writes
   * through the one `privilegedForClass` both sides already share.
   */
  readonly sensitiveFieldRoles: readonly string[];
  /**
   * The deployment's ABAC policies, as `<key>=<attribute>:<op>[:<value>]` repeated. These are what a
   * manifest grant's `abac` key resolves against, and declaring one is also what switches on the
   * membership-attribute directory — the producer is wired exactly when a consumer exists, so a
   * deployment with no policy pays no per-request lookup. Parsed in `node.ts`, like `--api-key`.
   */
  readonly abacPolicies: readonly string[];
  /**
   * Per-class entity grants, as `<class>=<role>` repeated — the same grammar and the same
   * authoritative-per-class rule as `--audit-read-sensitive-class` (ADR-0329), deliberately,
   * because two grant vocabularies that look alike and differ is worse than either.
   * `--sensitive-field-class phi=` withholds phi from everyone, wholesale grantees included.
   */
  readonly sensitiveFieldClasses: Readonly<Record<string, readonly string[]>>;
  /**
   * Enforce the **classification default** on writes: a sensitive field with no declared `update`
   * grant is writable only by a privileged role.
   *
   * Opt-in, and separate from the declaration above on purpose — the declaration fixes what a role
   * may *read*, this turns on write enforcement, and conflating them would mean a deployment fixing
   * its reads silently acquired a write refusal. An explicitly declared per-field `update` grant is
   * enforced either way, without this flag: honouring a declaration the manifest actually makes
   * needs no opt-in.
   *
   * It refuses at boot when the declaration would leave a *required* sensitive field writable by
   * nobody, because that makes its entity uncreatable — true of 12 fields across 7 entities in the
   * shipped packs today, so the refusal and its list are the migration guide.
   */
  readonly classifiedWriteMask: boolean;
  /** Expose the per-viewer notification read-state routes under /v1/notifications (mark read, read-through watermark, unread count; needs --store pg). */
  readonly readStateRoutes: boolean;
  /** Roles permitted to record their own read state and read their own unread count (repeatable; default none ⇒ the routes refuse everyone). */
  readonly readStateRoles: readonly string[];
  /**
   * Roles permitted to assert `source=system_backfill` on the watermark route (repeatable; default
   * none ⇒ nobody).
   *
   * **Additive on top of `--read-state-role`, not a substitute** — a backfill role that is not also
   * granted there is refused by the base grant first, which is the fail-closed order. A backfill
   * marks an entire backlog read in one call, so it is in ADR-0313's class and is recorded before
   * the write; it therefore also requires an audit emitter, i.e. `--store pg`.
   */
  readonly readStateBackfillRoles: readonly string[];
  /** How many dispatches the unread count examines in one page (default 200, 1–1000). The response reports `examined` and `truncated` rather than a quietly wrong total. */
  readonly readStateUnreadScan: number;
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
  /** JSON escalation config ({severity?, category?, declaredBy?, severityByDefect?, alertPolicy}) — declares a sev1 and pages when a deletion proof does not verify, which is the one tamper the forensic chain cannot see. */
  readonly deletionEscalationConfig: string | null;
  /**
   * The deployment's `DeletionCapabilities`, as a JSON file (ADR-0328).
   *
   * Required by the deletion flow rather than defaulted, because every default is wrong: `absent`
   * for the unimplemented subsystems signs a proof that is silent about four places a tenant's data
   * may still be, and that silence is exactly what ADR-0317 refused. It replaced a field read from
   * the **request body** with `[]` as its default, so a remote caller chose how much of the
   * deployment the proof covered.
   */
  readonly deletionCapabilities: string | null;
  /**
   * The same six-value declaration, stated inline through repeatable `--deletion-capability`
   * `<subsystem>=<disposition>` pairs, or null when none was passed.
   *
   * A second route and not a replacement: the file keeps working and the two are mutually
   * exclusive, because two configs for one declaration is the precedence question again and this
   * declaration decides the reach of a cryptographic proof. The inline route exists because the
   * file had **no route at all** on a shipped deployment — the `api` service declares no
   * `volumes:` key, so the only way a file reached the container was a commit baked into an image
   * layer, which costs a full `pnpm install && pnpm -r build` to change one word. Inline, the
   * declaration is in `docker-compose.yml` where a diff shows it and
   * `deployment-defaults.test.ts` can fence it; a mounted file's content is outside every
   * workspace rule and every test by construction.
   */
  readonly deletionCapabilityDeclarations: Readonly<Record<string, string>> | null;
  /**
   * Whether a verified Article 17 request erases one data subject or the whole tenant.
   *
   * REQUIRED by the deletion runner, and there is no default because neither value is safe to
   * assume: `tenant` destroys every subject's data when one person asks, which is honest only where
   * a tenant is one subject, and the alternative is refused at parse because nothing can perform it.
   * Before this the runner hardcoded `data_subject_erasure` over a tenant-wide erasure, so the
   * question was answered — wrongly, and in the signed proof.
   */
  readonly deletionSubjectScope: "tenant" | null;
  /** Run the reverse-direction audit (completed requests whose proof no longer stands up) every Nth deletion-runner tick. Default 0 = never; it re-hashes every completed request's tombstone, so it is far more expensive than the forward pass. */
  readonly deletionAuditEveryTicks: number | null;
  /**
   * How many consecutive non-advancing tombstone-sweep attempts make a stall (default 3).
   *
   * `stallAfterAttempts` has existed on the scheduler since ADR-0329 with no flag reaching it, so
   * every deployment ran on the hardcoded default. Worth exposing now that a stall declares an
   * incident rather than only logging. The scheduler reads a malformed value as the **default, not
   * off** — the opposite of `deletionAuditEveryTicks`, because there "off" is the status quo and
   * here "off" is the silence this exists to end — so refusing it here is belt-and-braces.
   */
  readonly deletionSweepStallAfter: number | null;
  /**
   * How many days before an Article 12(3) deadline a still-unanswered request becomes a finding
   * (default 7, ADR-0387).
   *
   * The one policy in that increment nothing else can set: the cadence is derived from the runner's
   * interval and needs no flag, while this decides *which* requests the sweep reports and would
   * otherwise be a constant in a package an operator cannot edit. It moves the warning horizon
   * only — a breach is a breach at any setting — and every finding names the horizon it was judged
   * under, so a report read later cannot be ambiguous about which value produced it.
   */
  readonly deletionWarningDays: number | null;
  /** Days from submission to the Article 12(3) deadline (default 30, cap 90). Set per deployment rather than per request. */
  readonly deletionRequestDeadlineDays: number | null;
  /** Run verified deletion requests out of band every N ms (needs --tenant-deletion-routes' wiring). Off unless set; the first tick is one interval after boot, never at boot. */
  readonly deletionRunnerMs: number | null;
  /** The actor unattended deletions execute as (default `system:deletion-runner`). */
  readonly deletionRunnerExecutedBy: string | null;
  /**
   * Days a verified deletion request waits before the runner may execute it (default
   * `DEFAULT_DELETION_GRACE_DAYS`, 0 to run at the next tick). The wait is the window in which a
   * verify can still be rejected — the cancellation — and it yields to the Article 12(3) deadline,
   * so it can never cause a breach.
   */
  readonly deletionGraceDays: number;
  /** Requests the runner may take per tick (default 5). Each one is a whole tenant's data. */
  readonly deletionRunnerBatchSize: number | null;
  /** Maximum buffered request body, as bytes or a size like 25mb (default 10mb, floor 1kb, ceiling 1gb). */
  readonly maxRequestBodyBytes: number | null;
  /**
   * Overrides of the serving pool's bounds and per-session limits (`SERVING_POOL_SETTINGS` in
   * `@crossengin/kernel-pg`); a key absent here takes that default. Only the serving connection
   * reads these — migrate and the operator subcommands run unbounded on purpose.
   */
  readonly pgPool: Partial<PgPoolSettings>;
  /**
   * Overrides of the HTTP listener's bounds and the shutdown grace (`DEFAULT_HTTP_LISTENER_SETTINGS`
   * in `http-listener.ts`); a key absent here takes that default.
   */
  readonly httpListener: Partial<HttpListenerSettings>;
  /**
   * Per-route body-size overrides as `<path-prefix>=<size>` (repeatable), longest prefix winning.
   *
   * ADR-0312 left "a per-route or per-tenant request-body limit is unaddressed". The cost of one
   * number is that it must be the **largest legitimate body in the deployment**, which then applies
   * to every cheap endpoint — so the real point of this is that `--max-request-body` can finally be
   * set *small*, with the few large routes named. A **per-tenant** limit is deliberately not here:
   * the tenant comes from the credential and resolving one means verifying a JWT, which is a
   * gateway pipeline stage running after the body is read (ADR-0331).
   */
  readonly maxRequestBodyRoutes: readonly { readonly prefix: string; readonly bytes: number }[];
  readonly defaultScheme: "http" | "https";
  readonly help: boolean;
  readonly version: boolean;
}

export class CliUsageError extends Error {}

const DEFAULT_PORT = 8787;

/**
 * Refused and never clamped (ADR-0332): a floor of 1 is the defect restated, and raising it for the
 * operator would leave the deployment believing it had configured something it had not.
 */
export function parseMinPasswordLength(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < MIN_MIN_PASSWORD_LENGTH || n > MAX_PASSWORD_LENGTH) {
    throw new CliUsageError(
      `invalid --min-password-length: ${raw} (integer ${MIN_MIN_PASSWORD_LENGTH.toString()}..` +
        `${MAX_PASSWORD_LENGTH.toString()}; a lower floor is refused rather than raised for you)`,
    );
  }
  return n;
}

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
  let allowPlaintextPhi = false;
  let allowCursorDisclosure = false;
  let allowUncoveredSettlement = false;
  let allowDanglingReferences = false;
  let segregationOfDuties = false;
  let columnKeyMode: ColumnKeyMode = "derived";
  let columnKeyTtlMs: number | null = null;
  let columnKeySurveyCeiling = PER_TENANT_SURVEY_CEILING;
  let schema: string | null = null;
  let defaultScheme: "http" | "https" = "http";
  const apiKeys: string[] = [];
  const hmacKeys: string[] = [];
  const mtlsClients: string[] = [];
  let trustedEdgeClientCert = false;
  const jwksKeys: string[] = [];
  let jwksFile: string | null = null;
  let jwksUrl: string | null = null;
  let jwksRefreshMs: number | null = null;
  let jwtIssuer: string | null = null;
  let jwtAudience: string | null = null;
  const jwtOptionalClaims: string[] = [];
  let credentialLogin = false;
  let sessionTokenTtl: number | null = null;
  let loginLockoutAttempts: number | null = null;
  let minPasswordLength: number | null = null;
  let allowWeakApiKeys = false;
  let idpPlatformRoles = false;
  let loginLockoutSeconds: number | null = null;
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
  let bounceFaxObservations = false;
  let bounceFaxSuppressAfter: number | null = null;
  let bounceFaxWindowHours: number | null = null;
  const notificationAdminRoles: string[] = [];
  const notificationAuditRoles: string[] = [];
  let emitEntityEvents = false;
  let eventPrefix: string | null = null;
  let enableJobInvoke = false;
  const jobInvokeRoles: string[] = [];
  const workflowCancelRoles: string[] = [];
  let workflowWorkers = false;
  let workflowWorkerConfig: string | null = null;
  let workflowDeferActivities = false;
  const rateLimitPolicySpecs: string[] = [];
  let rateLimitDefaultPolicyId: string | null = null;
  let idempotencyStoreKind: string | null = null;
  let retentionSweep = false;
  const retentionSpecs: string[] = [];
  let gatewayCaptureRate: string | null = null;
  const gatewayCaptureOperations: string[] = [];
  let platformUserRoutes = false;
  const platformUserRoles: string[] = [];
  const credentialAdminRoles: string[] = [];
  let preferenceRoutes = false;
  const preferenceRoles: string[] = [];
  const preferenceAdminRoles: string[] = [];
  let tenantStatusGateFlag: "on" | "off" | null = null;
  let tenantStatusTtlMs: number | null = null;
  let preAuthRateLimit: PreAuthLimitPolicy | null = null;
  const jobInvokeActionRoles: string[] = [];
  let packCatalogFile: string | null = null;
  let marketplaceAuthoring = false;
  const packPublisherKeys: string[] = [];
  let marketplacePlatformVersion: string | null = null;
  const packAdminRoles: string[] = [];
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
  let checkpoints = false;
  let integrityProof = false;
  let integrityProofFullEvery: number | null = null;
  let auditSamplingRefreshMs: number | null = null;
  let platformAdmin = false;
  const platformAdminRoles: string[] = [];
  const adminRoles: string[] = [];
  const jobActorRoles: string[] = [];
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
  let allowDesignSelfApproval = false;
  let meteringConfig: string | null = null;
  let stripeUsageSyncConfig: string | null = null;
  let aiMaxRequestDollars: number | null = null;
  let aiProviderTimeoutMs: number | null = null;
  let aiMaxOutputTokens: number | null = null;
  let aiModelPrice: DeclaredModelPrice | null = null;
  let allowUnpricedModel = false;
  let aiProviderRef: string | null = null;
  let aiTenantPseudonym: AiTenantPseudonymMode = DEFAULT_AI_TENANT_PSEUDONYM_MODE;
  let aiTenantPseudonymGiven = false;
  let notificationTemplateRoutes = false;
  const notificationTemplateAuthorRoles: string[] = [];
  const notificationTemplateApproverRoles: string[] = [];
  const notificationTemplateUnconditionalRoles: string[] = [];
  let auditReadRoutes = false;
  const auditReadTenantRoles: string[] = [];
  const auditReadPlatformRoles: string[] = [];
  const auditReadSensitiveRoles: string[] = [];
  const auditReadSensitiveClasses: Record<string, string[]> = {};
  const sensitiveFieldRoles: string[] = [];
  const abacPolicies: string[] = [];
  const sensitiveFieldClasses: Record<string, string[]> = {};
  let classifiedWriteMask = false;
  let auditReadMaxRangeDays: number | null = null;
  let readStateRoutes = false;
  const readStateRoles: string[] = [];
  const readStateBackfillRoles: string[] = [];
  let readStateUnreadScan = DEFAULT_UNREAD_SCAN_LIMIT;
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
  let deletionEscalationConfig: string | null = null;
  let deletionCapabilities: string | null = null;
  const deletionCapabilityDeclarations: Record<string, string> = {};
  let deletionSubjectScope: "tenant" | null = null;
  let deletionAuditEveryTicks: number | null = null;
  let deletionWarningDays: number | null = null;
  let deletionSweepStallAfter: number | null = null;
  let deletionRequestDeadlineDays: number | null = null;
  let deletionRunnerMs: number | null = null;
  let deletionRunnerExecutedBy: string | null = null;
  let deletionGraceDays: number = DEFAULT_DELETION_GRACE_DAYS;
  let deletionRunnerBatchSize: number | null = null;
  let maxRequestBodyBytes: number | null = null;
  const pgPool: { -readonly [K in keyof PgPoolSettings]?: number } = {};
  const httpListener: { -readonly [K in keyof HttpListenerSettings]?: number } = {};
  const maxRequestBodyRouteSpecs: string[] = [];
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
    } else if (arg === "--hmac-key" || arg.startsWith("--hmac-key=")) {
      {
        // Validated here as well as at boot, for `--jwks-key`'s stated reason: the parser can answer
        // with a usage error and the help text (exit 2) where `resolveRequestSigning` can only
        // report an absence, and `parseHmacKeySpec` is pure so there is nothing to defer.
        const spec = takeValue(arg, next, "--hmac-key");
        try {
          parseHmacKeySpec(spec);
        } catch (err) {
          throw new CliUsageError(err instanceof Error ? err.message : String(err));
        }
        hmacKeys.push(spec);
      }
      i += consumed();
    } else if (arg === "--mtls-client" || arg.startsWith("--mtls-client=")) {
      {
        // Validated here as well as at boot, for `--hmac-key`'s stated reason: the parser can answer
        // with a usage error and the help text (exit 2) where `resolveMtlsClients` can only report an
        // absence, and `parseMtlsClientSpec` is pure so there is nothing to defer. It is the one of
        // the three credential specs whose first field has a *shape* to check, so this is also where
        // an unmatchable enrolment is caught rather than accepted into a registry that cannot fire.
        const spec = takeValue(arg, next, "--mtls-client");
        try {
          parseMtlsClientSpec(spec);
        } catch (err) {
          throw new CliUsageError(err instanceof Error ? err.message : String(err));
        }
        mtlsClients.push(spec);
      }
      i += consumed();
    } else if (arg === "--trusted-edge-client-cert") {
      trustedEdgeClientCert = true;
    } else if (arg === "--jwks-key" || arg.startsWith("--jwks-key=")) {
      {
        // Validated here as well as at boot, and that is not redundancy: the parser can answer
        // with a usage error and the help text (exit 2), where `resolveJwtConfig` can only throw.
        // `parseJwksKeySpec` is pure, so there is no reason to defer it -- and until this
        // increment nothing validated the value at all, so a typo'd key booted cleanly and turned
        // every Bearer request into an `invalid_signature` 401 that names nothing.
        const spec = takeValue(arg, next, "--jwks-key");
        try {
          parseJwksKeySpec(spec);
        } catch (err) {
          throw new CliUsageError((err as Error).message);
        }
        jwksKeys.push(spec);
      }
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
    } else if (arg === "--jwt-optional-claim" || arg.startsWith("--jwt-optional-claim=")) {
      jwtOptionalClaims.push(takeValue(arg, next, "--jwt-optional-claim"));
      i += consumed();
    } else if (arg === "--jwt-audience" || arg.startsWith("--jwt-audience=")) {
      jwtAudience = takeValue(arg, next, "--jwt-audience");
      i += consumed();
    } else if (arg === "--credential-login") {
      credentialLogin = true;
    } else if (arg === "--session-token-ttl" || arg.startsWith("--session-token-ttl=")) {
      const raw = takeValue(arg, next, "--session-token-ttl");
      const n = Number(raw);
      if (
        !Number.isInteger(n) ||
        n < MIN_SESSION_TOKEN_SECONDS ||
        n > MAX_SESSION_TOKEN_SECONDS
      ) {
        throw new CliUsageError(
          `invalid --session-token-ttl: ${raw} (${MIN_SESSION_TOKEN_SECONDS.toString()}..` +
            `${MAX_SESSION_TOKEN_SECONDS.toString()} seconds)`,
        );
      }
      sessionTokenTtl = n;
      i += consumed();
    } else if (arg === "--login-lockout-attempts" || arg.startsWith("--login-lockout-attempts=")) {
      const raw = takeValue(arg, next, "--login-lockout-attempts");
      const n = Number(raw);
      // Refused and never clamped, which is ADR-0332's rule: a threshold of 1 locks a real user
      // out on one typo, and silently raising it to the floor would leave the deployment believing
      // it had configured something it had not.
      if (!Number.isInteger(n) || n < MIN_LOGIN_LOCKOUT_ATTEMPTS) {
        throw new CliUsageError(
          `invalid --login-lockout-attempts: ${raw} (integer >= ` +
            `${MIN_LOGIN_LOCKOUT_ATTEMPTS.toString()}; a lower threshold locks a real user out on` +
            " a typo, so it is refused rather than raised for you)",
        );
      }
      loginLockoutAttempts = n;
      i += consumed();
    } else if (arg === "--login-lockout-seconds" || arg.startsWith("--login-lockout-seconds=")) {
      const raw = takeValue(arg, next, "--login-lockout-seconds");
      const n = Number(raw);
      if (!Number.isInteger(n) || n < MIN_LOGIN_LOCKOUT_SECONDS) {
        throw new CliUsageError(
          `invalid --login-lockout-seconds: ${raw} (integer >= ` +
            `${MIN_LOGIN_LOCKOUT_SECONDS.toString()})`,
        );
      }
      loginLockoutSeconds = n;
      i += consumed();
    } else if (arg === "--min-password-length" || arg.startsWith("--min-password-length=")) {
      minPasswordLength = parseMinPasswordLength(takeValue(arg, next, "--min-password-length"));
      i += consumed();
    } else if (arg === "--allow-weak-api-keys") {
      allowWeakApiKeys = true;
    } else if (arg === "--idp-platform-roles") {
      idpPlatformRoles = true;
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
    } else if (arg === "--bounce-fax-observations") {
      bounceFaxObservations = true;
    } else if (
      arg === "--bounce-fax-suppress-after" ||
      arg.startsWith("--bounce-fax-suppress-after=")
    ) {
      const raw = takeValue(arg, next, "--bounce-fax-suppress-after");
      const n = Number(raw);
      // Refused rather than clamped: a threshold of 1 is "suppress on a single detector sample",
      // which is the thing the count exists to avoid — and an operator who typed 1 believes they
      // asked for something supported, so silently raising it imposes a policy they did not choose.
      if (!Number.isInteger(n) || n < MIN_FAX_SUPPRESSION_THRESHOLD) {
        throw new CliUsageError(
          `invalid --bounce-fax-suppress-after: ${raw} (a whole number >= ` +
            `${MIN_FAX_SUPPRESSION_THRESHOLD.toString()}; 1 would suppress on a single detector sample)`,
        );
      }
      bounceFaxSuppressAfter = n;
      i += consumed();
    } else if (arg === "--bounce-fax-window-hours" || arg.startsWith("--bounce-fax-window-hours=")) {
      const raw = takeValue(arg, next, "--bounce-fax-window-hours");
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) {
        throw new CliUsageError(`invalid --bounce-fax-window-hours: ${raw} (>= 1)`);
      }
      bounceFaxWindowHours = n;
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
    } else if (arg === "--workflow-cancel-role" || arg.startsWith("--workflow-cancel-role=")) {
      workflowCancelRoles.push(takeValue(arg, next, "--workflow-cancel-role"));
      i += consumed();
    } else if (arg === "--allow-plaintext-phi") {
      allowPlaintextPhi = true;
    } else if (arg === ALLOW_CURSOR_DISCLOSURE_FLAG) {
      allowCursorDisclosure = true;
    } else if (arg === ALLOW_UNCOVERED_SETTLEMENT_FLAG) {
      allowUncoveredSettlement = true;
    } else if (arg === "--allow-dangling-references") {
      allowDanglingReferences = true;
    } else if (arg === "--segregation-of-duties") {
      segregationOfDuties = true;
    } else if (arg === COLUMN_KEY_MODE_FLAG || arg.startsWith(`${COLUMN_KEY_MODE_FLAG}=`)) {
      const raw = takeValue(arg, next, COLUMN_KEY_MODE_FLAG);
      if (!(COLUMN_KEY_MODES as readonly string[]).includes(raw)) {
        throw new CliUsageError(
          `${COLUMN_KEY_MODE_FLAG} must be one of ${COLUMN_KEY_MODES.join(" | ")}, got '${raw}'`,
        );
      }
      columnKeyMode = raw as ColumnKeyMode;
      i += consumed();
    } else if (arg === COLUMN_KEY_TTL_FLAG || arg.startsWith(`${COLUMN_KEY_TTL_FLAG}=`)) {
      const raw = takeValue(arg, next, COLUMN_KEY_TTL_FLAG);
      const n = Number(raw);
      // Refused rather than clamped, out of band in either direction: below the floor the cache
      // stops collapsing a cold tenant's concurrent first writes into one provisioning, and above
      // the ceiling a rekey's stale-key window outlasts any plausible maintenance pause. Silently
      // moving it would make the deployment believe a window it did not choose.
      if (
        !Number.isInteger(n) ||
        n < COLUMN_KEY_TTL_BOUNDS.min ||
        n > COLUMN_KEY_TTL_BOUNDS.max
      ) {
        throw new CliUsageError(
          `${COLUMN_KEY_TTL_FLAG} must be an integer between ${COLUMN_KEY_TTL_BOUNDS.min.toString()}` +
            ` and ${COLUMN_KEY_TTL_BOUNDS.max.toString()} ms, got '${raw}'`,
        );
      }
      columnKeyTtlMs = n;
      i += consumed();
    } else if (
      arg === COLUMN_KEY_SURVEY_CEILING_FLAG ||
      arg.startsWith(`${COLUMN_KEY_SURVEY_CEILING_FLAG}=`)
    ) {
      const raw = takeValue(arg, next, COLUMN_KEY_SURVEY_CEILING_FLAG);
      // `Number("")` is 0 and `Number("1e4")` is 10000, so the digits are required before the
      // number is read: a ceiling is a count an operator types, and a spelling that merely parses
      // is not one. Refused rather than clamped, either way out of band (ADR-0460): below the floor
      // a handful of tenants at the head of the id order decide a whole-deployment refusal, above
      // the ceiling the confined boot outlasts the healthcheck, and moving the value silently would
      // make the boot line state a ceiling the operator did not choose.
      const n = /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
      if (
        !Number.isSafeInteger(n) ||
        n < COLUMN_KEY_SURVEY_CEILING_BOUNDS.min ||
        n > COLUMN_KEY_SURVEY_CEILING_BOUNDS.max
      ) {
        throw new CliUsageError(
          `${COLUMN_KEY_SURVEY_CEILING_FLAG} must be an integer between ` +
            `${COLUMN_KEY_SURVEY_CEILING_BOUNDS.min.toString()} and ` +
            `${COLUMN_KEY_SURVEY_CEILING_BOUNDS.max.toString()} tenants, got '${raw}'`,
        );
      }
      columnKeySurveyCeiling = n;
      i += consumed();
    } else if (arg === "--classified-write-mask") {
      classifiedWriteMask = true;
    } else if (
      arg === SENSITIVE_FIELD_ROLE_FLAG ||
      arg.startsWith(`${SENSITIVE_FIELD_ROLE_FLAG}=`)
    ) {
      sensitiveFieldRoles.push(takeValue(arg, next, SENSITIVE_FIELD_ROLE_FLAG));
      i += consumed();
    } else if (arg === ABAC_POLICY_FLAG || arg.startsWith(`${ABAC_POLICY_FLAG}=`)) {
      // Collected raw and parsed in `node.ts` alongside `--api-key`, so one module owns both the
      // grammar and the refusal text an operator reads.
      abacPolicies.push(takeValue(arg, next, ABAC_POLICY_FLAG));
      i += consumed();
    } else if (
      arg === SENSITIVE_FIELD_CLASS_FLAG ||
      arg.startsWith(`${SENSITIVE_FIELD_CLASS_FLAG}=`)
    ) {
      // Deliberately byte-for-byte the grammar of `--audit-read-sensitive-class`, including the
      // empty-role meaning and the refusal of an unknown class: these two declarations describe the
      // same privilege over the same classes on two surfaces, and a reader who learns one must not
      // have to re-learn the other.
      const raw = takeValue(arg, next, SENSITIVE_FIELD_CLASS_FLAG);
      const eq = raw.indexOf("=");
      if (eq < 1) {
        throw new CliUsageError(
          `invalid ${SENSITIVE_FIELD_CLASS_FLAG}: ${raw} (expected <class>=<role>, or <class>= to grant it to nobody)`,
        );
      }
      const cls = raw.slice(0, eq).trim();
      const role = raw.slice(eq + 1).trim();
      // Checked against the real set for the same reason the audit flag checks it: a typo'd class
      // would be accepted, apply to nothing, and leave the wholesale grant quietly reaching the
      // class the operator meant to withhold.
      if (!SENSITIVE_DATA_CLASSIFICATIONS.has(cls as DataClassification)) {
        throw new CliUsageError(
          `invalid ${SENSITIVE_FIELD_CLASS_FLAG}: unknown sensitive class '${cls}' (one of ` +
            `${[...SENSITIVE_DATA_CLASSIFICATIONS].sort().join(", ")})`,
        );
      }
      const bucket = sensitiveFieldClasses[cls] ?? [];
      if (role.length > 0) bucket.push(role);
      sensitiveFieldClasses[cls] = bucket;
      i += consumed();
      // And deliberately **not** `classifiedWriteMask = true`, which is where this parser departs
      // from the audit one (that flag implies `--audit-read-routes`). The declaration says who may
      // see a class; the mask says writes are enforced against it. A deployment declaring a grant
      // to make PHI readable by its clinicians must not silently acquire a write refusal on the 39
      // fields no manifest grants.
    } else if (arg === "--workflow-workers") {
      workflowWorkers = true;
    } else if (arg === "--workflow-worker-config" || arg.startsWith("--workflow-worker-config=")) {
      workflowWorkerConfig = takeValue(arg, next, "--workflow-worker-config");
      i += consumed();
    } else if (arg === "--workflow-defer-activities") {
      workflowDeferActivities = true;
    } else if (arg === "--rate-limit-policy" || arg.startsWith("--rate-limit-policy=")) {
      rateLimitPolicySpecs.push(takeValue(arg, next, "--rate-limit-policy"));
      i += consumed();
    } else if (
      arg === "--rate-limit-default-policy" ||
      arg.startsWith("--rate-limit-default-policy=")
    ) {
      rateLimitDefaultPolicyId = takeValue(arg, next, "--rate-limit-default-policy");
      i += consumed();
    } else if (arg === "--idempotency-store" || arg.startsWith("--idempotency-store=")) {
      idempotencyStoreKind = takeValue(arg, next, "--idempotency-store");
      i += consumed();
    } else if (arg === "--retention-sweep") {
      retentionSweep = true;
    } else if (arg === RETENTION_FLAG || arg.startsWith(`${RETENTION_FLAG}=`)) {
      retentionSpecs.push(takeValue(arg, next, RETENTION_FLAG));
      i += consumed();
    } else if (
      arg === "--gateway-execution-capture" ||
      arg.startsWith("--gateway-execution-capture=")
    ) {
      gatewayCaptureRate = takeValue(arg, next, "--gateway-execution-capture");
      i += consumed();
    } else if (
      arg === "--gateway-execution-capture-operation" ||
      arg.startsWith("--gateway-execution-capture-operation=")
    ) {
      gatewayCaptureOperations.push(takeValue(arg, next, "--gateway-execution-capture-operation"));
      i += consumed();
    } else if (arg === "--platform-user-routes") {
      platformUserRoutes = true;
    } else if (arg === "--platform-user-role" || arg.startsWith("--platform-user-role=")) {
      platformUserRoles.push(takeValue(arg, next, "--platform-user-role"));
      i += consumed();
    } else if (
      arg === "--credential-admin-role" ||
      arg.startsWith("--credential-admin-role=")
    ) {
      credentialAdminRoles.push(takeValue(arg, next, "--credential-admin-role"));
      i += consumed();
    } else if (arg === "--preference-routes") {
      preferenceRoutes = true;
    } else if (arg === "--preference-role" || arg.startsWith("--preference-role=")) {
      preferenceRoles.push(takeValue(arg, next, "--preference-role"));
      i += consumed();
    } else if (arg === "--preference-admin-role" || arg.startsWith("--preference-admin-role=")) {
      preferenceAdminRoles.push(takeValue(arg, next, "--preference-admin-role"));
      i += consumed();
    } else if (arg === "--tenant-status-gate" || arg === "--no-tenant-status-gate") {
      const wanted = arg === "--tenant-status-gate" ? "on" : "off";
      if (tenantStatusGateFlag !== null && tenantStatusGateFlag !== wanted) {
        throw new CliUsageError(
          "--tenant-status-gate and --no-tenant-status-gate contradict each other; pass one",
        );
      }
      tenantStatusGateFlag = wanted;
    } else if (arg === PRE_AUTH_LIMIT_FLAG || arg.startsWith(`${PRE_AUTH_LIMIT_FLAG}=`)) {
      if (preAuthRateLimit !== null) {
        throw new CliUsageError(`${PRE_AUTH_LIMIT_FLAG} given twice; pass it once`);
      }
      const raw = takeValue(arg, next, PRE_AUTH_LIMIT_FLAG);
      try {
        preAuthRateLimit = parsePreAuthLimitPolicy(raw);
      } catch (err) {
        throw new CliUsageError(err instanceof Error ? err.message : String(err));
      }
      i += consumed();
    } else if (arg === "--tenant-status-ttl-ms" || arg.startsWith("--tenant-status-ttl-ms=")) {
      const raw = takeValue(arg, next, "--tenant-status-ttl-ms");
      const n = Number(raw);
      // A floor of a second and a ceiling of five minutes. The floor is because the gate runs on
      // every request and a sub-second TTL turns it into a per-request query; the ceiling is because
      // the value is how long a `pending_deletion` tenant goes on accepting writes after the state
      // changed, and a gate that lags by an hour is not enforcing much.
      if (!Number.isInteger(n) || n < 1000 || n > 300_000) {
        throw new CliUsageError(`invalid --tenant-status-ttl-ms: ${raw} (1000..300000)`);
      }
      tenantStatusTtlMs = n;
      i += consumed();
    } else if (arg === "--job-invoke-action-role" || arg.startsWith("--job-invoke-action-role=")) {
      jobInvokeActionRoles.push(takeValue(arg, next, "--job-invoke-action-role"));
      i += consumed();
    } else if (arg === "--pack-catalog" || arg.startsWith("--pack-catalog=")) {
      packCatalogFile = takeValue(arg, next, "--pack-catalog");
      i += consumed();
    } else if (arg === "--marketplace-authoring") {
      marketplaceAuthoring = true;
    } else if (arg === "--pack-publisher-key" || arg.startsWith("--pack-publisher-key=")) {
      const raw = takeValue(arg, next, "--pack-publisher-key");
      try {
        parsePackPublisherSpec(raw);
      } catch (err) {
        throw new CliUsageError(`invalid --pack-publisher-key: ${err instanceof Error ? err.message : String(err)}`);
      }
      packPublisherKeys.push(raw);
      i += consumed();
    } else if (arg === "--marketplace-platform-version" || arg.startsWith("--marketplace-platform-version=")) {
      const raw = takeValue(arg, next, "--marketplace-platform-version");
      if (!PackCompatibilitySchema.safeParse({ minPlatformVersion: raw }).success) {
        throw new CliUsageError(`invalid --marketplace-platform-version: ${raw} (a semver such as 1.4.0)`);
      }
      marketplacePlatformVersion = raw;
      i += consumed();
    } else if (arg === "--pack-admin-role" || arg.startsWith("--pack-admin-role=")) {
      packAdminRoles.push(takeValue(arg, next, "--pack-admin-role"));
      i += consumed();
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
    } else if (arg === "--checkpoints") {
      checkpoints = true;
    } else if (arg === "--integrity-proof") {
      integrityProof = true;
    } else if (arg === "--integrity-proof-full-every" || arg.startsWith("--integrity-proof-full-every=")) {
      const raw = takeValue(arg, next, "--integrity-proof-full-every");
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) {
        throw new CliUsageError(`invalid --integrity-proof-full-every: ${raw} (an integer >= 0; 0 never)`);
      }
      integrityProofFullEvery = n;
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
    } else if (arg === "--admin-role" || arg.startsWith("--admin-role=")) {
      adminRoles.push(takeValue(arg, next, "--admin-role"));
      i += consumed();
    } else if (arg === "--job-actor-role" || arg.startsWith("--job-actor-role=")) {
      jobActorRoles.push(takeValue(arg, next, "--job-actor-role"));
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
    } else if (arg === "--allow-design-self-approval") {
      allowDesignSelfApproval = true;
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
    } else if (arg === "--ai-provider-timeout-ms" || arg.startsWith("--ai-provider-timeout-ms=")) {
      const raw = takeValue(arg, next, "--ai-provider-timeout-ms");
      try {
        aiProviderTimeoutMs = parseAiProviderTimeoutMs(raw, "--ai-provider-timeout-ms");
      } catch (err) {
        if (err instanceof AiSettingInvalid) throw new CliUsageError(err.message);
        throw err;
      }
      i += consumed();
    } else if (arg === "--ai-max-output-tokens" || arg.startsWith("--ai-max-output-tokens=")) {
      const raw = takeValue(arg, next, "--ai-max-output-tokens");
      try {
        aiMaxOutputTokens = parseAiMaxOutputTokens(raw, "--ai-max-output-tokens");
      } catch (err) {
        if (err instanceof AiSettingInvalid) throw new CliUsageError(err.message);
        throw err;
      }
      i += consumed();
    } else if (arg === "--ai-model-price" || arg.startsWith("--ai-model-price=")) {
      const raw = takeValue(arg, next, "--ai-model-price");
      try {
        aiModelPrice = parseDeclaredModelPrice(raw);
      } catch (err) {
        if (err instanceof AiModelPriceInvalid) throw new CliUsageError(err.message);
        throw err;
      }
      i += consumed();
    } else if (arg === "--ai-allow-unpriced-model") {
      allowUnpricedModel = true;
    } else if (arg === AI_TENANT_PSEUDONYM_FLAG || arg.startsWith(`${AI_TENANT_PSEUDONYM_FLAG}=`)) {
      const raw = takeValue(arg, next, AI_TENANT_PSEUDONYM_FLAG);
      if (!isAiTenantPseudonymMode(raw)) {
        throw new CliUsageError(
          `invalid ${AI_TENANT_PSEUDONYM_FLAG}: ${raw} (${AI_TENANT_PSEUDONYM_MODES.join("|")})`,
        );
      }
      aiTenantPseudonym = raw;
      aiTenantPseudonymGiven = true;
      i += consumed();
    } else if (arg === "--ai-provider-ref" || arg.startsWith("--ai-provider-ref=")) {
      const raw = takeValue(arg, next, "--ai-provider-ref");
      try {
        aiProviderRef = parseAiProviderRef(raw);
      } catch (err) {
        throw new CliUsageError(err instanceof Error ? err.message : String(err));
      }
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
    } else if (
      arg === "--audit-read-sensitive-class" ||
      arg.startsWith("--audit-read-sensitive-class=")
    ) {
      const raw = takeValue(arg, next, "--audit-read-sensitive-class");
      const eq = raw.indexOf("=");
      if (eq < 1) {
        throw new CliUsageError(
          `invalid --audit-read-sensitive-class: ${raw} (expected <class>=<role>, or <class>= to grant it to nobody)`,
        );
      }
      const cls = raw.slice(0, eq).trim();
      const role = raw.slice(eq + 1).trim();
      // Checked against the real set, not a copy of it: a typo'd class would otherwise be
      // accepted, apply to nothing, and leave the wholesale grant quietly reaching the class the
      // operator meant to withhold — a narrowing that silently does not narrow.
      if (!SENSITIVE_DATA_CLASSIFICATIONS.has(cls as DataClassification)) {
        throw new CliUsageError(
          `invalid --audit-read-sensitive-class: unknown sensitive class '${cls}' (one of ` +
            `${[...SENSITIVE_DATA_CLASSIFICATIONS].sort().join(", ")})`,
        );
      }
      // An empty role is the point, not an error: naming a class with no role is how a deployment
      // withholds it from everyone, including a wholesale `--audit-read-sensitive-role` grantee.
      const bucket = auditReadSensitiveClasses[cls] ?? [];
      if (role.length > 0) bucket.push(role);
      auditReadSensitiveClasses[cls] = bucket;
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
    } else if (arg === "--read-state-routes") {
      readStateRoutes = true;
    } else if (arg === "--read-state-role" || arg.startsWith("--read-state-role=")) {
      readStateRoles.push(takeValue(arg, next, "--read-state-role"));
      i += consumed();
      readStateRoutes = true;
    } else if (
      arg === "--read-state-backfill-role" ||
      arg.startsWith("--read-state-backfill-role=")
    ) {
      readStateBackfillRoles.push(takeValue(arg, next, "--read-state-backfill-role"));
      i += consumed();
      readStateRoutes = true;
    } else if (arg === "--read-state-unread-scan" || arg.startsWith("--read-state-unread-scan=")) {
      const raw = takeValue(arg, next, "--read-state-unread-scan");
      const n = Number(raw);
      // Refused out of band rather than clamped, which is ADR-0312's rule: a deployment that asked
      // for 5000 and silently got 1000 would render a badge it believes is exact.
      if (!Number.isInteger(n) || n < 1 || n > MAX_UNREAD_SCAN_LIMIT) {
        throw new CliUsageError(
          `invalid --read-state-unread-scan: ${raw} (1–${MAX_UNREAD_SCAN_LIMIT.toString()})`,
        );
      }
      readStateUnreadScan = n;
      i += consumed();
      readStateRoutes = true;
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
    } else if (
      arg === "--deletion-escalation-config" ||
      arg.startsWith("--deletion-escalation-config=")
    ) {
      deletionEscalationConfig = takeValue(arg, next, "--deletion-escalation-config");
      i += consumed();
      deletionRequestRoutes = true;
    } else if (
      arg === "--deletion-capabilities" ||
      arg.startsWith("--deletion-capabilities=")
    ) {
      deletionCapabilities = takeValue(arg, next, "--deletion-capabilities");
      i += consumed();
    } else if (
      arg === "--deletion-capability" ||
      arg.startsWith("--deletion-capability=")
    ) {
      // Deliberately byte-for-byte the grammar of `--audit-read-sensitive-class`, including the
      // `eq < 1` test and the "expected <k>=<v>" wording, because an operator who has written one
      // of this binary's `k=v` flags has written them all. What differs is the three refusals
      // below, and each of them is a decision rather than validation hygiene.
      const raw = takeValue(arg, next, "--deletion-capability");
      const eq = raw.indexOf("=");
      if (eq < 1) {
        throw new CliUsageError(
          `invalid --deletion-capability: ${raw} (expected <subsystem>=<disposition>)`,
        );
      }
      const subsystem = raw.slice(0, eq).trim();
      const disposition = raw.slice(eq + 1).trim();
      // Checked against the REAL vocabularies, not copies: a typo'd subsystem would otherwise be
      // accepted, satisfy nothing, and leave the completeness check below refusing the subsystem
      // the operator believes they declared — while a typo'd disposition would silently answer a
      // different question about the same subsystem.
      if (!(DELETION_SUBSYSTEMS as readonly string[]).includes(subsystem)) {
        throw new CliUsageError(
          `invalid --deletion-capability: unknown subsystem '${subsystem}' (one of ` +
            `${[...DELETION_SUBSYSTEMS].sort().join(", ")})`,
        );
      }
      if (!(SUBSYSTEM_DISPOSITIONS as readonly string[]).includes(disposition)) {
        throw new CliUsageError(
          `invalid --deletion-capability: unknown disposition '${disposition}' for ${subsystem}` +
            ` (one of ${[...SUBSYSTEM_DISPOSITIONS].sort().join(", ")})`,
        );
      }
      // A repeated subsystem is REFUSED rather than accumulated, which is where this departs from
      // every other repeatable flag here: a role list is a set and a disposition is one decision,
      // so last-wins would let argv order decide what a signed Article 17 proof claims about a
      // subsystem (ADR-0357's refusal of precedence, one declaration across).
      const already = deletionCapabilityDeclarations[subsystem];
      if (already !== undefined) {
        throw new CliUsageError(
          `invalid --deletion-capability: ${subsystem} declared twice ('${already}' then` +
            ` '${disposition}') — a disposition is one decision, so state it once`,
        );
      }
      deletionCapabilityDeclarations[subsystem] = disposition;
      i += consumed();
    } else if (
      arg === "--deletion-subject-scope" ||
      arg.startsWith("--deletion-subject-scope=")
    ) {
      const raw = takeValue(arg, next, "--deletion-subject-scope");
      /*
       * `subject` is in the vocabulary and refused by name, rather than left out so the flag has one
       * legal value. An operator whose deployment really does need to erase one person has a
       * declaration to reach for and a refusal naming what is missing; leaving it out would make
       * them read the single legal value as the platform's position on the question.
       *
       * Refused at parse rather than at boot because nothing about the deployment changes the
       * answer: no code anywhere can scope an erasure to a subject, so the refusal is a property of
       * this binary (ADR-0340's shape, not ADR-0338's — there is no degraded-but-coherent version).
       */
      if (raw === "subject") {
        throw new CliUsageError(
          "--deletion-subject-scope subject: this platform cannot erase one data subject's data." +
            " Nothing scopes an erasure to a subject — the deletion pipeline destroys every table" +
            " carrying the tenant's id and drops its schema — so declaring it would make every" +
            " verified request refuse. Declare 'tenant' if a request here means the whole tenant," +
            " and see register P1.4 (GDPR Article 15/20 and per-subject erasure are unbuilt).",
        );
      }
      if (raw !== "tenant") {
        throw new CliUsageError(
          `invalid --deletion-subject-scope: ${raw} (tenant | subject)`,
        );
      }
      deletionSubjectScope = raw;
      i += consumed();
    } else if (
      arg === "--deletion-audit-every-ticks" ||
      arg.startsWith("--deletion-audit-every-ticks=")
    ) {
      const raw = takeValue(arg, next, "--deletion-audit-every-ticks");
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) {
        throw new CliUsageError(`invalid --deletion-audit-every-ticks: ${raw} (>= 1)`);
      }
      deletionAuditEveryTicks = n;
      i += consumed();
    } else if (
      arg === "--deletion-warning-days" ||
      arg.startsWith("--deletion-warning-days=")
    ) {
      const raw = takeValue(arg, next, "--deletion-warning-days");
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) {
        throw new CliUsageError(`invalid --deletion-warning-days: ${raw} (>= 1)`);
      }
      deletionWarningDays = n;
      i += consumed();
    } else if (
      arg === "--deletion-sweep-stall-after" ||
      arg.startsWith("--deletion-sweep-stall-after=")
    ) {
      const raw = takeValue(arg, next, "--deletion-sweep-stall-after");
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) {
        throw new CliUsageError(`invalid --deletion-sweep-stall-after: ${raw} (>= 1)`);
      }
      deletionSweepStallAfter = n;
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
      // Refused by name rather than ignored (H-05): the approver of an unattended deletion is the
      // principal who verified the request, recorded when they did it. A configured string was a
      // claim that somebody approved, typed by the operator who started the binary.
      takeValue(arg, next, "--deletion-runner-approved-by");
      throw new CliUsageError(
        "--deletion-runner-approved-by is no longer accepted: the runner's approver is the " +
          "principal who verified each request, and the runner refuses a request whose verifier " +
          "is its own executor. Remove the flag",
      );
    } else if (arg === "--deletion-grace-days" || arg.startsWith("--deletion-grace-days=")) {
      const raw = takeValue(arg, next, "--deletion-grace-days");
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0 || n > 90) {
        throw new CliUsageError(`invalid --deletion-grace-days: ${raw} (0..90)`);
      }
      deletionGraceDays = n;
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
    } else if (
      arg === "--max-request-body-route" ||
      arg.startsWith("--max-request-body-route=")
    ) {
      maxRequestBodyRouteSpecs.push(takeValue(arg, next, "--max-request-body-route"));
      i += consumed();
    } else if (arg === "--max-request-body" || arg.startsWith("--max-request-body=")) {
      const raw = takeValue(arg, next, "--max-request-body");
      const parsed = parseRequestBodyLimit(raw);
      if (!parsed.ok) throw new CliUsageError(`invalid --max-request-body: ${parsed.reason}`);
      maxRequestBodyBytes = parsed.bytes;
      i += consumed();
    } else if (httpListenerSettingForFlag(arg.split("=")[0] ?? "") !== undefined) {
      const flag = arg.split("=")[0] ?? "";
      const key = httpListenerSettingForFlag(flag);
      const raw = takeValue(arg, next, flag);
      if (key === undefined) throw new CliUsageError(`unknown flag: ${flag}`);
      if (httpListener[key] !== undefined) throw new CliUsageError(`${flag} given more than once`);
      try {
        httpListener[key] = parseHttpListenerSetting(key, raw);
      } catch (err) {
        throw new CliUsageError(err instanceof Error ? err.message : String(err));
      }
      i += consumed();
    } else if (pgPoolSettingForFlag(arg.split("=")[0] ?? "") !== undefined) {
      const flag = arg.split("=")[0] ?? "";
      const key = pgPoolSettingForFlag(flag);
      const raw = takeValue(arg, next, flag);
      if (key === undefined) throw new CliUsageError(`unknown flag: ${flag}`);
      // Refused rather than last-wins: which of two values bounds every statement must not depend
      // on argv order.
      if (pgPool[key] !== undefined) throw new CliUsageError(`${flag} given more than once`);
      try {
        pgPool[key] = parsePgPoolSetting(key, raw);
      } catch (err) {
        throw new CliUsageError(err instanceof Error ? err.message : String(err));
      }
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
  if (allowDanglingReferences && store !== "pg") {
    throw new CliUsageError(
      `--allow-dangling-references applies to --store pg only: --store ${store} ` +
        (store === "pg-columns"
          ? "enforces references with foreign keys in its DDL, which no flag removes"
          : "keeps no durable records whose references could dangle"),
    );
  }
  if (platformAdmin && store === "memory") {
    throw new CliUsageError("--platform-admin requires a Postgres store (--store pg or pg-columns)");
  }
  if ((aiDesign || perTenantManifests) && store === "memory") {
    throw new CliUsageError("--ai-design / --per-tenant-manifests require a Postgres store (--store pg or pg-columns)");
  }
  // Both of these refuse a flag that would otherwise be SILENTLY INERT, which is the one thing
  // worse than not having it: an operator who asked for an approval gate and got none believes
  // their tenants' designs are reviewed. `--require-design-review` sets `designReview` too, so one
  // condition covers both spellings.
  //
  // The store arm: `reviewStore` is built only inside `options.designReview && conn !== undefined`,
  // so without Postgres the review routes do not mount, nothing enrols a proposal as `pending`,
  // and `reviewGate` is never passed to the design routes — the activation handler skips the check
  // entirely and every proposal activates unreviewed. It is reached only on a deployment that did
  // NOT pass `--ai-design`, because that flag's own store refusal above fires first and is the
  // better sentence there; it is kept as its own condition rather than left to that entailment, so
  // removing the producer arm below cannot silently take the store requirement with it.
  if (designReview && store === "memory") {
    throw new CliUsageError(
      "--design-review / --require-design-review require a Postgres store (--store pg or pg-columns)",
    );
  }
  // The producer arm: a review queue has exactly one thing that can fill it. `source: "ai"` in
  // `buildDesignRoutes` is the only proposal producer in the workspace — `MANIFEST_PROPOSAL_SOURCES`
  // declares `manual` and nothing writes it — so a reviewer without `--ai-design` is handed a
  // console over a queue that can never be non-empty, and "nothing pending" is indistinguishable
  // from "nothing to approve".
  // Nothing reads the mode without the Architect, so naming it there is a declaration that changes
  // nothing — and `off` would read as a privacy decision the deployment had taken.
  if (aiTenantPseudonymGiven && !aiDesign) {
    throw new CliUsageError(
      `${AI_TENANT_PSEUDONYM_FLAG} requires --ai-design: it decides what an AI design request ` +
        "carries, and without --ai-design no request is made",
    );
  }
  if (designReview && !aiDesign) {
    throw new CliUsageError(
      "--design-review / --require-design-review require --ai-design: the only producer of a" +
        " reviewable proposal is the Architect, so the queue would never be non-empty",
    );
  }
  // The hatch relaxes a rule only the review routes enforce, so without them it would be a flag
  // that reads as a decision and changes nothing.
  if (allowDesignSelfApproval && !designReview) {
    throw new CliUsageError(
      "--allow-design-self-approval requires --design-review or --require-design-review: it relaxes a" +
        " rule only the review routes enforce",
    );
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
  if ((auditReadRoutes || notificationTemplateRoutes) && store === "memory") {
    // Refused here rather than warned about at boot, like every sibling above: both surfaces read and
    // write `meta.*` tables, so on the memory store they cannot work at all — and `--audit-read-routes`
    // in particular would otherwise start a server that silently serves none of what was asked for.
    throw new CliUsageError(
      "--audit-read-routes / --notification-template-routes require a Postgres store (--store pg or pg-columns)",
    );
  }
  if (readStateRoutes && store === "memory") {
    // Read state is a persisted per-viewer record and the store needs a `PgConnection`; on the
    // memory store the routes would mount and 503 on every call.
    throw new CliUsageError(
      "--read-state-routes requires a Postgres store (--store pg or pg-columns)",
    );
  }
  if (readStateBackfillRoles.length > 0) {
    // `buildReadStateRoutes` already throws without an auditor, but the message it can give names a
    // constructor argument rather than the flag the operator typed. A backfill marks a whole backlog
    // read in one call and is recorded *before* the write, so an unrecordable one is refused — which
    // would be a 503 the first time somebody used it rather than a refusal at boot.
    const notAlsoGranted = readStateBackfillRoles.filter((r) => !readStateRoles.includes(r));
    if (notAlsoGranted.length > 0) {
      // Additive, not a substitute: the base grant is checked first, so a backfill role missing from
      // it is refused by that check and the backfill grant never comes into play. Said at boot
      // rather than discovered as a 403 that looks like the backfill grant not working.
      throw new CliUsageError(
        `--read-state-backfill-role is additive on top of --read-state-role: ${notAlsoGranted
          .sort()
          .join(", ")} must also be granted with --read-state-role`,
      );
    }
  }
  if (stripeWebhookSecret !== null && store === "memory") {
    throw new CliUsageError("--stripe-webhook-secret requires a Postgres store (--store pg or pg-columns)");
  }
  // `--plan-catalog` without a webhook secret, and `--stripe-usage-sync-config` without an API key,
  // are refused at BOOT now (`stripeRequirementRefusal`), over the resolved secrets: the secret may
  // arrive through STRIPE_WEBHOOK_SECRET / STRIPE_API_KEY, which this parser cannot see by design.
  if (stripeApiKey !== null && billingPortalReturnUrl === null && stripeUsageSyncConfig === null) {
    throw new CliUsageError(
      "--stripe-api-key requires --billing-portal-return-url or --stripe-usage-sync-config (nothing would use the key)",
    );
  }
  if (stripeApiKey !== null && store === "memory") {
    throw new CliUsageError("--stripe-api-key requires a Postgres store (--store pg or pg-columns)");
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
  if (bounceFaxObservations && !bounceWebhook) {
    throw new CliUsageError("--bounce-fax-observations requires --bounce-webhook");
  }
  if (bounceFaxObservations && store === "memory") {
    // The counter is a table, so on the memory store it cannot work at all.
    throw new CliUsageError(
      "--bounce-fax-observations requires a Postgres store (--store pg or pg-columns)",
    );
  }
  // Both of these configure the counter, so neither means anything without it — and a threshold
  // that silently counts nothing is the shape of misconfiguration this whole family refuses.
  if (bounceFaxSuppressAfter !== null && !bounceFaxObservations) {
    throw new CliUsageError("--bounce-fax-suppress-after requires --bounce-fax-observations");
  }
  if (bounceFaxWindowHours !== null && !bounceFaxObservations) {
    throw new CliUsageError("--bounce-fax-window-hours requires --bounce-fax-observations");
  }
  if (notificationAdminRoles.length > 0 && notificationDrainMs === null) {
    throw new CliUsageError("--notification-admin-role requires --notification-drain-ms (the drain interval)");
  }
  if (emitEntityEvents && store === "memory") {
    throw new CliUsageError("--emit-entity-events requires a Postgres store (--store pg or pg-columns)");
  }
  // Refused at parse time, not at the first request: a spec that cannot match, or a duplicated
  // prefix where an operator believes both are in force, is a limit nobody configured (ADR-0331).
  const parsedRouteLimits = parseRouteBodyLimits(maxRequestBodyRouteSpecs);
  if (!parsedRouteLimits.ok) {
    throw new CliUsageError(
      `invalid --max-request-body-route: ${parsedRouteLimits.reasons.join("; ")}`,
    );
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
  // ADR-0329 refused this flag outright, because the premise it names was true: the binary
  // instantiated no `WorkflowEngine` and `meta.workflow_definitions` had no writer, so there was no
  // source of definitions for one to be built from, and a route over an empty map would have
  // answered `unknown_instance` for every instance.
  //
  // There is a writer now (ADR-0331), so the refusal narrows to the one thing still required: the
  // definitions live in Postgres, so the memory store cannot serve them. Still a refusal rather
  // than a warning, for ADR-0329's reason — a cancellation route that cannot find any instance is
  // worse than one that is absent, because the 404 reads as "no such instance" rather than as
  // "this server has no engine".
  if (workflowCancelRoles.length > 0 && store === "memory") {
    throw new CliUsageError(
      "--workflow-cancel-role requires a Postgres store (--store pg or pg-columns): the engine's" +
        " definitions are loaded from meta.workflow_definitions and its instances are projected" +
        " into meta.workflow_instances, neither of which the memory store has.",
    );
  }
  // The workers claim from meta.workflow_timers / _activities / _job_runs, so the same refusal as
  // the cancellation route and for the same reason — three poll loops against tables that do not
  // exist is worse than no workers, because each claim throws on a cadence rather than once.
  if (workflowWorkers && store === "memory") {
    throw new CliUsageError(
      "--workflow-workers requires a Postgres store (--store pg or pg-columns): the workers claim" +
        " from meta.workflow_timers, meta.workflow_activities and meta.job_runs, none of which the" +
        " memory store has.",
    );
  }
  // A tuning block for a fleet that is not mounted is read, validated and then ignored, which is
  // the silence this family of flags keeps producing. Refused rather than warned, because the
  // operator who passed it believes they changed a lease or a batch size.
  if (workflowWorkerConfig !== null && !workflowWorkers) {
    throw new CliUsageError(
      "--workflow-worker-config has no effect without --workflow-workers: it tunes the worker" +
        " fleet, and no worker is mounted.",
    );
  }
  // The load-bearing refusal of the three. `deferActivities` makes the engine leave a scheduled
  // activity at rest *for a worker to claim*; with no worker claiming, every activity is scheduled
  // and never runs, so an instance stalls at its first activity with no error anywhere — strictly
  // worse than both alternatives. Mounting the workers is the only thing that makes deferral mean
  // anything, so it is required rather than assumed.
  // Refused rather than ignored, on this file's standing rule: a flag whose name asserts something
  // the deployment cannot do is worse than no flag. On `pg-columns` an encrypt-at-rest column is
  // genuinely `BYTEA`, so a plaintext write cannot succeed — the outcome is ciphertext or a boot
  // refusal for a missing key, never the plaintext this flag claims to authorise. Silently
  // accepting it would let an operator believe they had opted into something, which is the shape
  // `--gateway-execution-capture 0` and `--workflow-defer-activities` are both refused for.
  if (allowPlaintextPhi && store === "pg-columns") {
    throw new CliUsageError(
      "--allow-plaintext-phi is not applicable to --store pg-columns: a phi/regulated column is" +
        " BYTEA there, so the write is encrypted or refused for a missing" +
        ` ${COLUMN_ENCRYPTION_SECRET_VAR}, never stored as plaintext. Drop the flag.`,
    );
  }
  if (workflowDeferActivities && !workflowWorkers) {
    throw new CliUsageError(
      "--workflow-defer-activities requires --workflow-workers: deferring leaves every scheduled" +
        " activity at rest for a worker to claim, so with no worker mounted each instance stalls" +
        " at its first activity and nothing reports it.",
    );
  }
  let rateLimitPolicies: RateLimitPolicyDeclaration | null = null;
  if (rateLimitPolicySpecs.length > 0 || rateLimitDefaultPolicyId !== null) {
    // A default with no policies. The declaration needs exactly one policy for the routes that name
    // none — which today is every route — and picking one would be choosing the operator's ceiling.
    if (rateLimitPolicySpecs.length === 0) {
      throw new CliUsageError(
        "--rate-limit-default-policy requires at least one" +
          " --rate-limit-policy <rlp_id>:<limit>:<windowSeconds>",
      );
    }
    let parsedPolicies: readonly DeclaredRateLimitPolicy[];
    try {
      parsedPolicies = rateLimitPolicySpecs.map((spec) => parseRateLimitPolicySpec(spec));
    } catch (err) {
      throw new CliUsageError(
        `invalid --rate-limit-policy: ${err instanceof RateLimitPolicyDeclarationError ? err.message : String(err)}`,
      );
    }
    // With more than one policy the default must be named; with exactly one it is unambiguous, so
    // requiring the operator to say it twice would be ceremony.
    const defaultId =
      rateLimitDefaultPolicyId ?? (parsedPolicies.length === 1 ? parsedPolicies[0]!.policyId : null);
    if (defaultId === null) {
      throw new CliUsageError(
        "--rate-limit-default-policy is required when more than one --rate-limit-policy is declared",
      );
    }
    const defaultPolicy = parsedPolicies.find((policy) => policy.policyId === defaultId);
    // A default naming a policy nobody declared. Falling back would apply terms the operator did not
    // write down, which is the defect being fixed.
    if (defaultPolicy === undefined) {
      throw new CliUsageError(
        `--rate-limit-default-policy ${defaultId} is not among the declared policies` +
          ` (${parsedPolicies.map((policy) => policy.policyId).join(", ")})`,
      );
    }
    try {
      rateLimitPolicies = declareRateLimitPolicies({ defaultPolicy, policies: parsedPolicies });
    } catch (err) {
      throw new CliUsageError(
        `invalid rate-limit declaration: ${err instanceof RateLimitPolicyDeclarationError ? err.message : String(err)}`,
      );
    }
    // The decision row is the point; under `--store memory` there is no
    // `meta.rate_limit_decisions` to write and the declaration would silently buy only a different
    // in-memory number (`--workflow-cancel-role`'s shape, ADR-0331).
    if (store === "memory") {
      throw new CliUsageError(
        "--rate-limit-policy requires a Postgres store (--store pg or pg-columns): a policy is" +
          " declared so the persisted decision can name it, and there is no" +
          " meta.rate_limit_decisions under --store memory",
      );
    }
  }
  let pgIdempotencyStore = false;
  if (idempotencyStoreKind !== null) {
    if (idempotencyStoreKind !== "memory" && idempotencyStoreKind !== "pg") {
      throw new CliUsageError(
        `--idempotency-store must be 'memory' or 'pg', got ${JSON.stringify(idempotencyStoreKind)}`,
      );
    }
    pgIdempotencyStore = idempotencyStoreKind === "pg";
    // There is no `meta.gateway_idempotency_records` under `--store memory`, so the flag would buy
    // a second in-memory Map — `--workflow-cancel-role`'s shape (ADR-0331).
    if (pgIdempotencyStore && store === "memory") {
      throw new CliUsageError(
        "--idempotency-store pg requires a Postgres store (--store pg or pg-columns): there is no" +
          " meta.gateway_idempotency_records under --store memory",
      );
    }
  }
  let retention: RetentionPolicy | null = null;
  if (retentionSpecs.length > 0 && !retentionSweep) {
    // The specs alone would be parsed and then read by nothing — an operator who wrote
    // `--retention job_runs=30` believes their queue is bounded.
    throw new CliUsageError(
      `${RETENTION_FLAG} requires --retention-sweep: the policy is read only by the sweep, so` +
        " without it nothing is pruned",
    );
  }
  if (retentionSweep) {
    if (store === "memory") {
      throw new CliUsageError(
        "--retention-sweep requires a Postgres store (--store pg or pg-columns): there are no" +
          " operational tables to prune under --store memory",
      );
    }
    try {
      retention = resolveRetentionPolicy(retentionSpecs);
    } catch (err) {
      if (err instanceof RetentionPolicyError) throw new CliUsageError(err.message);
      throw err;
    }
  }
  let gatewayExecutionCapture: GatewayExecutionCaptureConfig | null = null;
  if (gatewayCaptureRate !== null) {
    const rate = Number(gatewayCaptureRate);
    if (!Number.isFinite(rate)) {
      throw new CliUsageError(
        `invalid --gateway-execution-capture: ${gatewayCaptureRate} is not a number`,
      );
    }
    // 0 is refused rather than honoured: "capture nothing" is spelled by omitting the flag, and a
    // sink that is mounted and writes nothing is the surface-reports-success-and-records-nothing
    // class this increment exists to close, not a setting.
    if (rate <= 0 || rate > 1) {
      throw new CliUsageError(
        `--gateway-execution-capture must be in (0, 1], got ${gatewayCaptureRate}` +
          (rate === 0 ? " — omit the flag to capture nothing" : ""),
      );
    }
    if (store === "memory") {
      throw new CliUsageError(
        "--gateway-execution-capture requires a Postgres store (--store pg or pg-columns): there" +
          " is no meta.gateway_pipeline_executions under --store memory",
      );
    }
    gatewayExecutionCapture = GatewayExecutionCaptureConfigSchema.parse({
      sampleRate: rate,
      ...(gatewayCaptureOperations.length > 0 ? { operations: gatewayCaptureOperations } : {}),
    });
  } else if (gatewayCaptureOperations.length > 0) {
    // A narrowing with no surface mounted reads as configured and does nothing.
    throw new CliUsageError(
      "--gateway-execution-capture-operation requires --gateway-execution-capture <rate>",
    );
  }
  // A grant with no surface mounted reads as configured and does nothing — the same shape as
  // `--workflow-defer-activities` without `--workflow-workers` (ADR-0333).
  if (platformUserRoles.length > 0 && !platformUserRoutes) {
    throw new CliUsageError(
      "--platform-user-role requires --platform-user-routes: a registry grant with no registry" +
        " surface mounted is silently inert",
    );
  }
  // The same inert-grant rule one surface across, and the surface it names is `--credential-login`
  // rather than a routes flag: the credential routes are built from the material
  // `resolveCredentialAuth` returns, so without a login there is no pepper to hash under and the
  // grant would reach a route that was never mounted.
  if (credentialAdminRoles.length > 0 && !credentialLogin) {
    throw new CliUsageError(
      "--credential-admin-role requires --credential-login: the credential routes hash under the" +
        " same pepper the login verifies with, so a grant with no login mounted is silently inert",
    );
  }
  // The refusal that lets `mtlsClientLookupConfigured` be **one** gate key for a scheme that needs
  // two facts. Without the edge declaration `buildIncomingRequest` drops the forwarded fingerprint,
  // so no request can carry an mtls credential and a registry alone would report the scheme served
  // while nothing could authenticate — the falsely-true direction (ADR-0337). Refused at parse
  // rather than reported at boot because the remedy is a flag the operator is already typing, which
  // is where `--credential-admin-role`'s refusal above draws the same line.
  //
  // One-directional on purpose: `--trusted-edge-client-cert` **without** `--mtls-client` is
  // legitimate and not refused. The declaration governs every forwarded fact — `x-forwarded-for`,
  // `x-forwarded-proto`, `x-forwarded-host` and the TLS version — so a deployment behind a trusted
  // edge that serves no client certificates still wants its client IPs and its TLS floor believed.
  if (mtlsClients.length > 0 && !trustedEdgeClientCert) {
    throw new CliUsageError(
      "--mtls-client requires --trusted-edge-client-cert: a forwarded client-certificate" +
        " fingerprint is dropped unless the edge is declared trusted, so an enrolment with no" +
        " declaration is silently unmatchable",
    );
  }
  if (platformUserRoutes && store === "memory") {
    throw new CliUsageError(
      "--platform-user-routes requires a Postgres store (--store pg or pg-columns): the registry is" +
        " meta.users and meta.user_tenant_membership, which the memory store has no tables for",
    );
  }
  if (preferenceRoles.length > 0 && !preferenceRoutes) {
    throw new CliUsageError(
      "--preference-role requires --preference-routes: a grant with no surface mounted is silently" +
        " inert",
    );
  }
  if (preferenceAdminRoles.length > 0 && !preferenceRoutes) {
    throw new CliUsageError(
      "--preference-admin-role requires --preference-routes: it is additive on --preference-role",
    );
  }
  if (preferenceRoutes && store === "memory") {
    throw new CliUsageError(
      "--preference-routes requires a Postgres store (--store pg or pg-columns):" +
        " meta.notification_preferences has no in-memory equivalent",
    );
  }
  // A pool bound with no pool is a setting read, validated and ignored, which reads to an operator
  // as tuned.
  try {
    resolveHttpListenerSettings(httpListener);
  } catch (err) {
    throw new CliUsageError(err instanceof Error ? err.message : String(err));
  }
  const pgPoolFlagsGiven = Object.keys(pgPool);
  if (pgPoolFlagsGiven.length > 0 && store === "memory") {
    throw new CliUsageError(
      "the --pg-* pool flags need a Postgres store (--store pg or pg-columns): --store memory " +
        "opens no database connection, so they would bound nothing.",
    );
  }
  // The gate reads `meta.tenants`, which the memory store does not have — and unlike a scheduler
  // that would merely go quiet, a gate whose directory throws refuses *every* request with a 503.
  if (tenantStatusGateFlag === "on" && store === "memory") {
    throw new CliUsageError(
      "--tenant-status-gate requires a Postgres store (--store pg or pg-columns): the gate reads" +
        " meta.tenants, which the memory store has no registry for, so every request would be" +
        " refused 503 rather than gated.",
    );
  }
  // The memory store has no registry to gate on, so a default does not reach it; only an explicit
  // request is refused above.
  const tenantStatusGate =
    tenantStatusGateFlag === "on" || (tenantStatusGateFlag === null && store !== "memory");
  const tenantStatusGateSource: ServeOptions["tenantStatusGateSource"] =
    tenantStatusGateFlag === "on"
      ? "flag"
      : tenantStatusGateFlag === "off"
        ? "disabled_by_flag"
        : store === "memory"
          ? "not_applicable"
          : "default";
  // A TTL for a gate that is not mounted is the same silence as `--workflow-worker-config` without
  // workers: read, validated, ignored, and the operator believes they tuned something.
  if (tenantStatusTtlMs !== null && !tenantStatusGate) {
    throw new CliUsageError(
      "--tenant-status-ttl-ms has no effect without --tenant-status-gate: it tunes how long the" +
        " gate caches a tenant's status, and no gate is mounted (--no-tenant-status-gate, or a" +
        " memory store).",
    );
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
  // Without a registered publisher key the only key a pack's signature could be checked against is
  // one supplied beside it, which proves nothing — so a marketplace surface with no key refuses
  // rather than verifying a signature against its own signer. The registry is also built here so an
  // overlapping or ambiguous set is refused at parse rather than at the first install.
  if ((packCatalogFile !== null || marketplaceAuthoring) && packPublisherKeys.length === 0) {
    throw new CliUsageError(
      `${packCatalogFile !== null ? "--pack-catalog" : "--marketplace-authoring"} requires at least one --pack-publisher-key <namespace>:<authorKind>:<publicKeyBase64>: a pack is verified against a key the platform registered, never one shipped with it`,
    );
  }
  // These configure a surface; given without one they would be read by nothing (ADR-0368's rule).
  if (packCatalogFile === null) {
    const inert = [
      ...(packAdminRoles.length > 0 ? ["--pack-admin-role"] : []),
      ...(marketplacePlatformVersion !== null ? ["--marketplace-platform-version"] : []),
      ...(packPublisherKeys.length > 0 && !marketplaceAuthoring ? ["--pack-publisher-key"] : []),
    ];
    if (inert.length > 0) {
      throw new CliUsageError(
        `${inert.join(", ")} configure${inert.length === 1 ? "s" : ""} a marketplace surface and none is mounted: pass --pack-catalog${inert.includes("--pack-publisher-key") ? " or --marketplace-authoring" : ""}`,
      );
    }
  }
  if (packPublisherKeys.length > 0) {
    try {
      new PackPublisherRegistry(packPublisherKeys.map(parsePackPublisherSpec));
    } catch (err) {
      throw new CliUsageError(`invalid --pack-publisher-key set: ${err instanceof Error ? err.message : String(err)}`);
    }
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

  // Two configs for one mount is the precedence question again, and here it decides what a
  // tamper-evidence pass covers — so it is refused rather than resolved by a rule nobody reads.
  if (checkpoints && checkpointConfig !== null) {
    throw new CliUsageError("--checkpoints and --checkpoint-config are mutually exclusive");
  }
  if (integrityProof && integrityProofConfig !== null) {
    throw new CliUsageError("--integrity-proof and --integrity-proof-config are mutually exclusive");
  }
  // Refused rather than ignored: on the file route the cadence is the file's `fullFoldEveryPasses`,
  // and with no proof mounted at all the flag would be inert while reading as configured.
  if (integrityProofFullEvery !== null && !integrityProof) {
    throw new CliUsageError(
      integrityProofConfig !== null
        ? "--integrity-proof-full-every applies to --integrity-proof; with --integrity-proof-config set fullFoldEveryPasses in the file"
        : "--integrity-proof-full-every needs --integrity-proof",
    );
  }

  const declaredCapabilities = Object.keys(deletionCapabilityDeclarations);
  if (declaredCapabilities.length > 0 && deletionCapabilities !== null) {
    throw new CliUsageError(
      "--deletion-capability and --deletion-capabilities are mutually exclusive (two declarations" +
        " of one proof's reach — state it once, inline or in the file)",
    );
  }
  if (declaredCapabilities.length > 0) {
    // An INCOMPLETE set is refused naming what is missing, which is what preserves ADR-0328's rule
    // that silence may not answer the reach of an Article 17 proof. `DeletionCapabilitiesSchema` is
    // a total `z.object` with all six keys required for exactly this reason, so a partial inline
    // set would be refused one layer in with six `invalid_type` issues naming neither the flag nor
    // the remedy — this says which subsystems are unanswered, at the layer the operator typed.
    const missing = DELETION_SUBSYSTEMS.filter(
      (s) => deletionCapabilityDeclarations[s] === undefined,
    );
    if (missing.length > 0) {
      throw new CliUsageError(
        `--deletion-capability: ${missing.length.toString()} of ` +
          `${DELETION_SUBSYSTEMS.length.toString()} subsystems undeclared ` +
          `(${[...missing].sort().join(", ")}) — the reach of an Article 17 proof is total or it` +
          " is nothing (ADR-0328), so every subsystem states its disposition",
      );
    }
  }

  if (
    (jwksKeys.length > 0 || jwksFile !== null || jwksUrl !== null) &&
    (jwtIssuer === null || jwtAudience === null)
  ) {
    throw new CliUsageError("--jwt-issuer and --jwt-audience are required when a JWKS is configured");
  }

  if (jwtOptionalClaims.length > 0) {
    // Refused for an unknown name rather than ignored, because the flag's whole effect is to
    // *remove* a check: a typo would be read as "relaxed nothing", which is the safe answer by
    // accident and silently not the one the operator asked for.
    const unknown = jwtOptionalClaims.filter((c) => !(REQUIRED_JWT_CLAIMS as readonly string[]).includes(c));
    if (unknown.length > 0) {
      throw new CliUsageError(
        `--jwt-optional-claim: unknown claim(s) ${unknown.join(", ")}; this binary can relax only ` +
          `${REQUIRED_JWT_CLAIMS.join(", ")} (nbf is never required, because its absence means valid from issuance)`,
      );
    }
    // Refused when nothing verifies a JWT at all, on the rule that a flag which is silently inert
    // is worse than absent: an operator who relaxed a claim believes they changed what is accepted.
    // Both token paths verify through the same guards -- `--credential-login` mints and verifies its
    // own, a JWKS verifies a foreign one -- so either makes the flag live.
    if (!credentialLogin && jwksKeys.length === 0 && jwksFile === null && jwksUrl === null) {
      throw new CliUsageError(
        "--jwt-optional-claim requires --credential-login or a JWKS (--jwks-key/--jwks-file/--jwks-url): " +
          "with neither, no JWT is verified and relaxing a claim changes nothing",
      );
    }
  }

  if (credentialLogin) {
    // The minted token asserts `iss` and `aud`, and the verifier beside it checks both. Without
    // them the runtime falls back to `https://crossengin.io` / `https://api.crossengin.io`, so a
    // minter using any other issuer would answer `issuer_mismatch` for a token it had just
    // signed -- a login that succeeds and whose token is refused on the next request.
    if (jwtIssuer === null || jwtAudience === null) {
      throw new CliUsageError(
        "--credential-login requires --jwt-issuer and --jwt-audience: the minted token asserts" +
          " both and the gateway verifies both, so they are one declaration",
      );
    }
    if (store === "memory") {
      throw new CliUsageError(
        "--credential-login requires a Postgres store (--store pg or pg-columns): the credential" +
          " lives in meta.users and there is no such table under --store memory",
      );
    }
    // `node.ts` branches on the URL and *discards* the static key specs, so the key derived from
    // OPERATE_TOKEN_SIGNING_KEY would never be registered and every minted token would come back
    // `invalid_signature`. Refused rather than warned: there is no degraded behaviour to protect,
    // and the failure lands at the gateway rather than at the mint, so the mint looks fine in
    // testing.
    if (jwksUrl !== null) {
      throw new CliUsageError(
        "--credential-login and --jwks-url are mutually exclusive: --jwks-url replaces the static" +
          " JWKS, so the key this deployment signs with would not be registered and every login's" +
          " token would be refused invalid_signature",
      );
    }
  } else {
    for (const [flag, value] of [
      ["--session-token-ttl", sessionTokenTtl],
      ["--login-lockout-attempts", loginLockoutAttempts],
      ["--login-lockout-seconds", loginLockoutSeconds],
      ["--min-password-length", minPasswordLength],
    ] as const) {
      if (value !== null) {
        throw new CliUsageError(`${flag} requires --credential-login`);
      }
    }
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
    hmacKeys,
    mtlsClients,
    trustedEdgeClientCert,
    jwksKeys,
    jwksFile,
    jwksUrl,
    jwksRefreshMs,
    jwtIssuer,
    jwtAudience,
    jwtOptionalClaims,
    credentialLogin,
    sessionTokenTtl,
    loginLockoutAttempts,
    loginLockoutSeconds,
    minPasswordLength,
    allowWeakApiKeys,
    idpPlatformRoles,
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
    bounceFaxObservations,
    bounceFaxSuppressAfter,
    bounceFaxWindowHours,
    notificationAdminRoles:
      notificationAdminRoles.length > 0 ? notificationAdminRoles : DEFAULT_ADMIN_ROLES,
    notificationAuditRoles,
    emitEntityEvents,
    eventPrefix,
    enableJobInvoke,
    jobInvokeRoles,
    workflowCancelRoles,
    allowPlaintextPhi,
    allowCursorDisclosure,
    allowUncoveredSettlement,
    allowDanglingReferences,
    segregationOfDuties,
    columnKeyMode,
    columnKeyTtlMs,
    columnKeySurveyCeiling,
    sensitiveFieldRoles,
    abacPolicies,
    sensitiveFieldClasses,
    classifiedWriteMask,
    workflowWorkers,
    workflowWorkerConfig,
    workflowDeferActivities,
    rateLimitPolicies,
    pgIdempotencyStore,
    retention,
    gatewayExecutionCapture,
    platformUserRoutes,
    platformUserRoles,
    credentialAdminRoles,
    preferenceRoutes,
    preferenceRoles,
    preferenceAdminRoles,
    tenantStatusGate,
    tenantStatusGateSource,
    tenantStatusTtlMs,
    preAuthRateLimit,
    jobInvokeActionRoles,
    packCatalogFile,
    marketplaceAuthoring,
    packPublisherKeys,
    marketplacePlatformVersion,
    packAdminRoles: packAdminRoles.length > 0 ? packAdminRoles : ["erp_admin"],
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
    checkpoints,
    integrityProof,
    integrityProofFullEvery,
    auditSamplingRefreshMs,
    platformAdmin,
    platformAdminRoles: platformAdminRoles.length > 0 ? platformAdminRoles : ["platform_admin"],
    // `erp_admin` is what `compileOperateServer`'s own default has always been, so a deployment
    // declaring nothing keeps exactly the grant it had. Widening it here would silently hand
    // `platform_admin` a tenant's settings on every deployment, which is a privilege decision
    // rather than a default.
    adminRoles: adminRoles.length > 0 ? adminRoles : ["erp_admin"],
    jobActorRoles: jobActorRoles.length > 0 ? jobActorRoles : ["erp_admin"],
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
    allowDesignSelfApproval,
    meteringConfig,
    stripeUsageSyncConfig,
    aiMaxRequestDollars,
    aiProviderTimeoutMs,
    aiMaxOutputTokens,
    aiModelPrice,
    allowUnpricedModel,
    aiProviderRef,
    aiTenantPseudonym,
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
    auditReadSensitiveClasses,
    auditReadMaxRangeDays,
    readStateRoutes,
    readStateRoles,
    readStateBackfillRoles,
    readStateUnreadScan,
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
    deletionEscalationConfig,
    deletionCapabilities,
    deletionCapabilityDeclarations:
      Object.keys(deletionCapabilityDeclarations).length > 0 ? deletionCapabilityDeclarations : null,
    deletionSubjectScope,
    deletionAuditEveryTicks,
    deletionWarningDays,
    deletionSweepStallAfter,
    deletionRequestDeadlineDays,
    deletionRunnerMs,
    deletionRunnerExecutedBy,
    deletionGraceDays,
    deletionRunnerBatchSize,
    maxRequestBodyBytes,
    pgPool,
    httpListener,
    maxRequestBodyRoutes: parsedRouteLimits.limits,
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

/**
 * Options for the `document-indexes` maintenance subcommand: build the JSONB store's per-manifest
 * unique indexes **as the table's owner**, before the API boots.
 *
 * It exists because of a measured interaction between two fixes. ADR-0423 enforces a declared
 * `unique` field on `--store pg` with one partial unique expression index per field on the shared
 * `meta.operate_entity_records`, created from the served manifest; ADR-0424 connects the API as a
 * confined role that owns nothing. Postgres refuses `CREATE INDEX` to a non-owner — and refuses
 * `CREATE INDEX IF NOT EXISTS` too, even when the index exists, because the ownership check comes
 * first. So on the shipped stack the API alone could never build one, and every declared unique
 * field read `index_not_owner` at boot. The owner already runs two one-shots before the API
 * (`migrate`, `app-role`); this is the third, and it is the only step that reads the manifest.
 */
export interface DocumentIndexesOptions {
  readonly pack: string | null;
  readonly manifestPath: string | null;
  readonly schema: string | null;
  readonly help: boolean;
}

/** Parses the argv *after* the `document-indexes` token. */
export function parseDocumentIndexesArgs(argv: readonly string[]): DocumentIndexesOptions {
  let pack: string | null = null;
  let manifestPath: string | null = null;
  let schema: string | null = null;
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
  }
  return { pack, manifestPath, schema, help };
}

export const documentIndexesHelpText = `operate-server document-indexes — build the JSONB store's unique indexes as the owner

Usage:
  operate-server document-indexes --pack <name> [--schema <name>]
  operate-server document-indexes --manifest <file.json> [--schema <name>]

Creates one partial unique index per declared unique field of the manifest on
meta.operate_entity_records, the table --store pg serves from. Run it as the
table's OWNER (the role that ran migrate), before the API boots: the API's own
role owns nothing, and Postgres refuses CREATE INDEX to a non-owner even when the
index already exists. Idempotent. Uses standard PG* env vars for the connection.

A field whose existing rows already hold duplicates is reported and skipped,
never fixed: deduplicate, then re-run. Exits 1 when an index could not be built
for a reason other than duplicates (most often: this is not the owner), 2 on a
usage error, 0 otherwise.

Options:
  --pack <name>        Built-in vertical pack: ${BUILTIN_PACK_NAMES.join(", ")}
  --manifest <file>    Path to a resolved manifest JSON document
  --schema <name>      Schema holding operate_entity_records (default meta)
  -h, --help           Show this help
`;

/**
 * Options for the `column-schema` maintenance subcommand: apply `--store pg-columns`' DDL **as the
 * schema's owner** and grant the serving role its DML, before the API boots.
 *
 * `document-indexes`' reason one store over (ADR-0423). Measured on PG 16 as the shipped serving
 * role, the column store's boot DDL raised at its first statement (`CREATE SCHEMA IF NOT EXISTS`,
 * `permission denied for database`), and every later statement is refused to a non-owner even when
 * its object exists — `CREATE TABLE IF NOT EXISTS` by schema privilege, `ADD COLUMN IF NOT EXISTS`
 * and `CREATE INDEX IF NOT EXISTS` by ownership — so the API cannot apply it and only verifies.
 */
export interface ColumnSchemaOptions {
  readonly pack: string | null;
  readonly manifestPath: string | null;
  readonly schema: string | null;
  /** Roles granted USAGE on the schema and the four DML privileges on every planned table. */
  readonly grantTo: readonly string[];
  readonly help: boolean;
}

const ROLE_NAME = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;

/** Parses the argv *after* the `column-schema` token. */
export function parseColumnSchemaArgs(argv: readonly string[]): ColumnSchemaOptions {
  let pack: string | null = null;
  let manifestPath: string | null = null;
  let schema: string | null = null;
  const grantTo: string[] = [];
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
    } else if (arg === "--grant-to" || arg.startsWith("--grant-to=")) {
      const role = takeValue(arg, next, "--grant-to");
      if (!ROLE_NAME.test(role)) {
        throw new CliUsageError(`--grant-to: '${role}' is not a role name (letters, digits, _ and $)`);
      }
      if (!grantTo.includes(role)) grantTo.push(role);
      i += consumed();
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
  }
  return { pack, manifestPath, schema, grantTo, help };
}

export const columnSchemaHelpText = `operate-server column-schema — apply --store pg-columns' tables as the owner

Usage:
  operate-server column-schema --pack <name> [--schema <name>] [--grant-to <role>]...
  operate-server column-schema --manifest <file.json> [--schema <name>] [--grant-to <role>]...

Creates and migrates the per-entity tables --store pg-columns serves from (the
same DDL the API applied at boot before it connected as a role that owns
nothing), then grants each --grant-to role USAGE on the schema and SELECT,
INSERT, UPDATE and DELETE on every planned table. Run it as the schema's OWNER
(the role that runs migrate), before the API boots, for the pack the API
serves: Postgres refuses CREATE TABLE IF NOT EXISTS and ADD COLUMN IF NOT EXISTS
to a non-owner even when the object exists, so the API only verifies the schema
and refuses at boot, naming what is missing, when it does not match the
manifest. Idempotent. Uses standard PG* env vars for the connection.

Exits 1 when the DDL or a grant fails, 2 on a usage error, 0 otherwise. A unique
index that existing duplicate rows prevent is reported and does not fail it.

Options:
  --pack <name>        Built-in vertical pack: ${BUILTIN_PACK_NAMES.join(", ")}
  --manifest <file>    Path to a resolved manifest JSON document
  --schema <name>      Schema holding the entity tables (default public)
  --grant-to <role>    A role to grant DML to (repeatable); none grants nothing
  -h, --help           Show this help
`;

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
public key resolved from the crypto-pg key registry (meta.crypto_keys). Read-only.

It also audits the scope's whole anchor table, meta.forensic_chain_checkpoints, and
reports that beneath the chain's own verdict — every row, not the newest one, so a
checkpoint row the contract refuses is found wherever it sits (ADR-0375). Exits 0
only when the chain verifies AND that audit found nothing AND it read the whole
table; a scan the ceiling stopped did not read everything, and an exit code has no
third answer for that.

With --from-checkpoint, verifies only the suffix after the scope's latest persisted
checkpoint (bounded cost for long chains) — integrity anchored at the checkpoint's
root hash, signatures over just the suffix. It falls back to a full verify in four
cases, not one: no checkpoint for this scope yet, an anchor recording no verified
prefix, an anchor predating the provenance column, and an anchor this binary cannot
read. The header names which.

Whether a checkpoint's root hash is compared against the chain entry at its
sequence turns on one thing: was the prefix read? A fold from genesis reads it and
asks, so the full mode asks — and so do all four of the --from-checkpoint fallbacks
above, since each of them folds from genesis. The one path that does not ask is a
bounded verify over an anchor it admitted, which by definition did not read the
prefix. A full fold over a chain holding a row this binary cannot read does not ask
either, because a correspondence computed from an incomplete chain would blame the
wrong table (ADR-0375). The audit says which case it is on its own line rather than
going quiet.

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

Subcommands (each takes --help):
  prune-links          Remove a tenant's dangling m2m links
  document-indexes     Build --store pg's unique indexes as the table owner (before the API)
  column-schema        Apply --store pg-columns' tables and grants as the owner (before the API)
  verify-chain         Verify the audit chain's links, signatures and anchors
  replay               Re-derive each subsystem's projections from its log and report drift
  rekey                Move one tenant's at-rest column key to a fresh random data key
  set-credential       Set a user's login password (the bootstrap path; no mail channel)
  ai-pseudonym-lookup  Name the tenant an AI provider's report means by its ctp_ pseudonym

Manifest source (exactly one):
  --pack <name>        Built-in vertical pack: ${BUILTIN_PACK_NAMES.join(", ")}
  --manifest <file>    Path to a resolved manifest JSON document

Options:
  --port <n>           Port to listen on (default 8787)
  --store <kind>       Entity store: memory | pg (JSONB) | pg-columns (typed
                       per-entity tables) (default memory)
  --allow-plaintext-phi
                       Serve a manifest with phi/regulated fields from a store
                       that cannot encrypt them (pg | memory). Off by default:
                       those stores hold a classified field as plaintext, so a
                       manifest declaring one is refused at boot unless this
                       says otherwise. Not applicable to pg-columns, which
                       encrypts (set COLUMN_ENCRYPTION_SECRET in the
                       environment -- never argv, which ps can read).
  --allow-dangling-references
                       On --store pg, keep storing a reference to a record that
                       does not exist and deleting a record others reference.
                       Off by default: such a write is refused 422 (or 500 when
                       the server wrote the reference), a restrict delete 409,
                       and cascade / set_null deletes apply as the column
                       store's foreign keys do. Declared unique fields stay
                       enforced either way.
  --allow-cursor-disclosure
                       Serve plaintext keyset cursors on a list whose abac
                       policy filters rows. Off by default: nextCursor is
                       base64url JSON derived from the last row the STORE
                       returned, which under filtering may be a row the caller
                       was never shown -- so it names withheld rows' positions,
                       and at limit=1 their ids. Set CURSOR_ENCRYPTION_SECRET in
                       the environment (never argv) to seal them instead; this
                       flag only accepts the disclosure, and does not suppress
                       sealing when a secret is set.
  ${ALLOW_UNCOVERED_SETTLEMENT_FLAG}
                       Let a document be marked paid while completed payments do
                       not cover its total. Off by default: the aging report
                       drops a document that is not open, so it then shows
                       nothing owed while the GL control account still carries
                       the residual, and nothing reconciles the two. An
                       uncovered document is recoverable -- record the payment
                       and the two views agree -- which is why this is a flag
                       and not a refusal with no way past it. The boot survey
                       reports which documents are unguarded either way.
  --segregation-of-duties
                       Refuse an approve-class transition (approve, post,
                       mark_paid, reimburse, Payment.complete) fired by the
                       person recorded as the record's creator (422
                       maker_cannot_approve). A record with no recorded creator
                       -- created before creators were stamped, or by an api-key
                       naming no person -- is refused too, because nothing shows
                       a second person checked it. Off by default: a single-user
                       tenant has no second person.
  --column-key-mode <m>
                       How the at-rest column key is obtained: derived | envelope
                       (default derived). derived recomputes it per tenant from
                       COLUMN_ENCRYPTION_SECRET and stores nothing, so it cannot
                       be destroyed and an erased tenant's PHI stays recoverable
                       from any backup for as long as that secret exists.
                       envelope stores a wrapped per-tenant data key, so
                       destroying the row bounds recovery to backups taken
                       before it, until those expire. A tenant that already has
                       a schema is seeded from the derived key to keep its
                       ciphertext readable, and is then NOT shreddable; one
                       provisioned fresh gets a random key and is. Use
                       'operate-server rekey' to move a seeded tenant to a
                       random key, which is what makes a destruction mean
                       anything.
  --column-key-ttl-ms <n>  How long a resolved per-tenant column key is served
                       from memory (${COLUMN_KEY_TTL_BOUNDS.min.toString()}..${COLUMN_KEY_TTL_BOUNDS.max.toString()}, default ${DEFAULT_COLUMN_KEY_TTL_MS.toString()}). A rekey
                       changes that key out of process, so until the entry
                       expires this process's reads of the rekeyed tenant raise
                       'Wrong key or corrupt data' and its WRITES would store
                       new values under the old key. Lower it before a rekey,
                       or quiesce the tenant for the window.
  ${COLUMN_KEY_SURVEY_CEILING_FLAG} <n>
                       How many tenants the boot column-key survey reads one at
                       a time when this role is confined by row-level security
                       (${COLUMN_KEY_SURVEY_CEILING_BOUNDS.min.toString()}..${COLUMN_KEY_SURVEY_CEILING_BOUNDS.max.toString()}, default ${PER_TENANT_SURVEY_CEILING.toString()}). Past it the rest are
                       reported as unexamined, never as consistent, and the line
                       says where it stopped. Each tenant costs up to four round
                       trips (two for the key survey, two for the ciphertext
                       scan; ~3.5 s per 10,000 tenants on loopback), so raising
                       it lengthens every pg-columns boot.
  --schema <name>      Postgres schema for the entity store (default meta;
                       public for pg-columns)
  --scheme <proto>     Default request scheme: http | https (default http)
  --api-key <spec>     API key binding key:role:tenant[:principalId] (repeatable;
                       the token IS a credential and argv is readable via ps, so
                       prefer OPERATE_API_KEY_SPECS — newline/comma-separated)
  --hmac-key <spec>    HMAC request-signing key keyId:role:tenant:principalId
                       (repeatable; all four fields required). The key id is NOT
                       a credential — it travels in the clear in every signed
                       request — so argv is fine; the secret is
                       REQUEST_SIGNING_SECRET in the environment. Declaring a
                       key with no secret set refuses the boot. principalId must
                       be a provisioned meta.users UUID: unlike --api-key there
                       is no bare form and no shared placeholder principal.
  --mtls-client <spec> Enrolled client certificate
                       fingerprint:role:tenant:principalId (repeatable; all four
                       fields required). The fingerprint is the certificate's
                       sha256 as 64 hex chars — openssl x509 -outform der |
                       openssl dgst -sha256. Nothing here is secret, so there is
                       no environment route: a fingerprint is derived from what
                       the client presents to everyone. Requires
                       --trusted-edge-client-cert, without which the forwarded
                       fingerprint is dropped and the enrolment cannot match.
  --trusted-edge-client-cert
                       Believe this request's forwarded facts: the edge performs
                       mutual TLS and OVERWRITES CrossEngin-Client-Cert-Sha256,
                       CrossEngin-Tls-Version and x-forwarded-*. Without it those
                       headers are dropped, because a caller can set any of them.
                       Legitimate on its own: it governs client IPs and the TLS
                       floor whether or not any certificate is enrolled.
  --jwks-key <spec>    JWKS public key kid:base64-ed25519-pubkey (repeatable)
  --jwks-file <file>   JSON [{kid, publicKeyBase64}, ...] of the IdP's keys
  --jwks-url <url>     Remote JWKS endpoint (cached, refetched on kid rotation)
  --jwks-refresh-ms <n> Background JWKS refresh interval (with --jwks-url; >=1000)
  --jwt-issuer <iss>   Expected JWT issuer (required with a JWKS)
  --jwt-audience <aud> Expected JWT audience (required with a JWKS)
  --credential-login   Mount POST /v1/auth/token, which turns a password into a session
                       token the gateway's own JWKS stage verifies. Needs a Postgres
                       store, --jwt-issuer, --jwt-audience, and ${CREDENTIAL_PEPPER_VAR}
                       plus ${TOKEN_SIGNING_KEY_VAR} in the environment (never argv --
                       ADR-0301). The token's public key is DERIVED from the signing
                       seed, so there is no second declaration to keep in step, which
                       is also why this is mutually exclusive with --jwks-url
  --session-token-ttl <n>
                       Session token lifetime in seconds (${MIN_SESSION_TOKEN_SECONDS.toString()}..${MAX_SESSION_TOKEN_SECONDS.toString()},
                       default ${DEFAULT_SESSION_TOKEN_SECONDS.toString()}). Also how long a revoked or downgraded
                       membership keeps its old role: the role is read at mint time and
                       frozen in the token, so this is the staleness window
  --login-lockout-attempts <n>
                       Consecutive wrong passwords before an account locks (>= ${MIN_LOGIN_LOCKOUT_ATTEMPTS.toString()},
                       default ${DEFAULT_LOGIN_LOCKOUT_ATTEMPTS.toString()}). A lower value is REFUSED rather than raised
                       for you: a threshold of 1 locks a real user out on one typo
  --login-lockout-seconds <n>
                       How long that lock lasts (>= ${MIN_LOGIN_LOCKOUT_SECONDS.toString()}, default ${DEFAULT_LOGIN_LOCKOUT_SECONDS.toString()})
  --min-password-length <n>
                       Shortest password a credential route or set-credential accepts
                       (${MIN_MIN_PASSWORD_LENGTH.toString()}..${MAX_PASSWORD_LENGTH.toString()}, default ${DEFAULT_MIN_PASSWORD_LENGTH.toString()}; requires --credential-login).
                       Checked when a password is set, never at login, so an
                       existing shorter password works until it is changed
  --allow-weak-api-keys
                       Boot although an api-key token's estimated entropy is under
                       the floor (refused otherwise; announced at boot)
  --idp-platform-roles Let a bearer token signed by a key this deployment does not
                       mint with (--jwks-key/--jwks-file/--jwks-url) carry a platform
                       role. Off, such a token's platform roles are removed, so an
                       IdP's scope cannot grant tenant provision or deletion
  --license <file>     Offline Ed25519 license token file (on-prem entitlement)
  --license-key <b64>  Licensor Ed25519 public key, base64 (required with --license)
  --stripe-webhook-secret <s>  Enable POST /v1/webhooks/stripe → billing_subscriptions
                       (needs --store pg|pg-columns; also enforces the subscription gate).
                       Prefer STRIPE_WEBHOOK_SECRET in the environment: argv is readable
                       via ps. Both may be set only if they agree
  --plan-catalog <file>  Plan-catalog JSON {plans:[...]} resolving webhook record caps
                       by plan/price id (requires a webhook secret, flag or environment)
  --stripe-api-key <sk>  Stripe secret key — enables POST /v1/meta/billing-portal
                       (needs --store pg|pg-columns + --billing-portal-return-url).
                       Prefer STRIPE_API_KEY in the environment, for the same reason
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
  --bounce-webhook     Serve POST /v1/notifications/bounces/{tenantId}/{ses|twilio|twilio_voice},
                       which records provider bounces and complaints as suppressions. The
                       source is the path segment, not sniffed from the payload: a call
                       callback posted to /twilio would be parsed as a messaging one. Needs
                       NOTIFICATION_BOUNCE_SECRET in the environment (>=32 chars); the
                       per-tenant key is HMAC-SHA256(secret, "bounce-webhook:"+tenantId),
                       which the signing edge must derive the same way
                       (needs --store pg|pg-columns)
  --bounce-transient-hours <n>  How long a soft/transient bounce suppresses an address.
                       Omitted, a transient bounce suppresses nothing
                       (needs --bounce-webhook)
  --bounce-fax-observations
                       Count consecutive Twilio AnsweredBy=fax verdicts per number in
                       meta.notification_fax_observations. Counts only: suppression needs
                       --bounce-fax-suppress-after. One fax verdict is a detector's guess from a
                       few hundred ms of audio and must never suppress on its own. Needs
                       TWILIO_VOICE_MACHINE_DETECTION, or Twilio never reports AnsweredBy at all
                       (needs --bounce-webhook and --store pg)
  --bounce-fax-suppress-after <n>
                       Consecutive fax verdicts before a PERMANENT voice_call hard_bounce is
                       recorded. >= 2, refused rather than clamped. Unset means never suppress,
                       which is the default. Permanent rather than bounded because the suppression
                       store's only conflict action is DO NOTHING, so a bounded row cannot be
                       renewed - it would mean blocked for N days and then never blockable again
  --bounce-fax-window-hours <n>
                       How long a run of fax verdicts stays one run (default 168). A verdict
                       arriving later restarts the run at one: a number gets reassigned, and
                       verdicts months apart are not evidence about the same device
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
  --workflow-cancel-role <r>  Role permitted to cancel a workflow instance (repeatable). Mounts the
                       engine over meta.workflow_definitions. Fail-closed on empty. Needs --store pg
  --workflow-workers   Mount the three durable workers that DRIVE the workflow queues — timer,
                       activity and job. Without them the engine is present and nothing polls it,
                       so a due timer never fires and --schedule-ms enqueues runs nothing drains.
                       Each worker refuses for a named reason it prints (no_definitions,
                       activities_run_inline, no_job_handlers). Needs --store pg|pg-columns
  --workflow-worker-config <file>  WorkflowWorkerConfig JSON: batchLimit (1-200, default 20),
                       leaseMs (>=1000, default 30000), idlePollMs — the latency a due timer pays —
                       activePollMs, drainTimeoutMs, noticeIntervalMs (repeat-notice collapse
                       window). The renewal heartbeat is derived at leaseMs/3, not configured
  --workflow-defer-activities  Leave a scheduled activity at rest for the activity worker instead
                       of running its handler inline. REQUIRES --workflow-workers: with no worker
                       claiming, every instance stalls at its first activity and nothing says so
  --rate-limit-policy <rlp_id>:<limit>:<windowSeconds>  Declare a rate-limit policy (repeatable).
                       Until this existed, api-gateway-pg had ZERO importers: the checker, the
                       idempotency store, the route registry, the pipeline-execution store and the
                       replayer were all unreachable from this binary, and meta.rate_limit_decisions
                       had never held a row. A starting point: rlp_conservativedefault:600:60.
                       Needs --store pg|pg-columns
  --rate-limit-default-policy <rlp_id>  Which declared policy governs a route that names none
                       (required when more than one is declared; unambiguous with exactly one)
  --idempotency-store memory|pg  Where the gateway's replay guard lives. Default memory, which is
                       PER PROCESS: a retried POST landing on another replica, or on this one after
                       a restart, is not deduplicated -- including on --tenant-deletion-routes, the
                       one route that requires a key because a retry mints a second tombstone.
                       pg deduplicates a sequential retry fleet-wide; two CONCURRENT retries of one
                       key can still both execute (there is no reserve step). Needs --store pg or
                       pg-columns
  --retention-sweep    Prune operational tables hourly, per tenant, in batches: terminal job_runs
                       older than 90 days (the newest run of each job is kept: it is the cron
                       scheduler's memory), gateway_pipeline_executions and rate_limit_decisions
                       older than 30, and finished notification_dispatches older than 365 -- which
                       removes an old in-app notice from its reader's inbox, which is why this is
                       opt-in. Never touches a retained or audit table. Needs a Postgres store
  --retention <table>=<days|off>  Override one table's period (repeatable, 1..36500 days). Needs
                       --retention-sweep. rate_limit_decisions may not be pruned sooner than
                       gateway_pipeline_executions, which names its decision rows
  --gateway-execution-capture <rate>  Persist this fraction of PipelineExecution rows, which is what
                       gives GatewayReplayer anything to read. No default: ~2100 B/row incl. indexes
                       is ~6.6 TB/yr at 100 req/s and ~66 TB/yr at 1,000 req/s unsampled, so the
                       rate is required rather than assumed. 0 is refused -- omit the flag instead.
                       A uniform sample, not an outcome filter: pass_with_4xx_or_5xx is a drift code
                       about a row whose outcome disagrees with its status, so filtering on that
                       outcome discards exactly the rows where the claim is false. Needs --store pg
                       or pg-columns
  --gateway-execution-capture-operation <operationId>  Narrow the capture to these operations
                       (repeatable). Requires --gateway-execution-capture
  --platform-user-routes  Mount the platform user registry under /v1/platform/users — provision a
                       principal, grant it a membership in a tenant, retire it. NOTHING wrote
                       meta.users before this, while 42 catalogued columns reference it NOT NULL
                       ON DELETE RESTRICT (ten on tables with a live writer), and every notification
                       audience resolved to the empty set. Needs --store pg|pg-columns
  --platform-user-role <role>  Role permitted to administer the registry (repeatable, fail-closed).
                       Separate from --platform-admin-role, which administers tenants
  --credential-admin-role <role>  Role permitted to set ANOTHER user's password, over
                       POST /v1/platform/users/{id}/credential (repeatable, fail-closed: with no
                       role the route is not mounted at all). Until this existed, setting a password
                       needed shell access — 'set-credential' is a subcommand because there is no
                       mail channel, which is right about the FIRST password and does not generalise
                       past it, so onboarding broke at step 3 of 4. Its own grant and not
                       --platform-user-role's: meta.users has no RLS, so this route's role check is
                       the entire authorisation with no policy behind it. Requires
                       --credential-login. The route refuses being aimed at the caller — changing
                       your own password is POST /v1/account/password, which needs no grant and
                       mounts with --credential-login
  --preference-routes  Mount the per-user notification preference routes. Without them every user's
                       preferences are the built-in defaults for ever, so the consent half of
                       computeDispatchEligibility was unreachable. Needs --store pg|pg-columns
  --preference-role <role>  Role permitted to read and set one's OWN preferences (repeatable,
                       fail-closed). A body naming another user is refused, not ignored
  --preference-admin-role <role>  Additive on --preference-role: may set another user's preference,
                       recorded before the write so an unrecordable privileged write is refused
  --tenant-status-gate  Enforce meta.tenants.status on EVERY request: a suspended, archived or
                       pending_deletion tenant is read-only and a deleted one is refused outright.
                       Without it the status is a column nothing on the request path reads, so a
                       tenant whose Article 17 erasure is queued goes on accepting writes into data
                       about to be destroyed. /v1/platform routes are exempt — they act on the
                       deployment, not on the caller's tenant. ON by default on --store pg and
                       pg-columns: a credential whose tenant has no meta.tenants row is refused 403,
                       and a boot survey names those tenants before the first request. Explicitly
                       passing it under --store memory is refused
  --no-tenant-status-gate  Turn the gate off, announced at boot. Every tenant status is then
                       unenforced on the request path
  --tenant-status-ttl-ms <ms>  How long a resolved tenant status is cached (1000..300000, default
                       30000). This is how long a state change takes to bite; the floor keeps the
                       gate off the per-request query path. With --tenant-status-gate
  --pre-auth-rate-limit <requests>/<seconds>  Bound requests per (address, credential shape)
                       BEFORE authentication, the login route included, per process; over it is
                       429 with retry-after. Off by default: behind a proxy the address is the
                       proxy's unless --trusted-edge-client-cert is passed (then the rightmost
                       x-forwarded-for entry), so without it this is one budget shared by every
                       caller
  --pack-catalog <file>  Marketplace pack-catalog JSON ({packs:[...]}) — enables the admin pack
                       routes GET /v1/admin/packs, POST /v1/admin/packs/install,
                       POST /v1/admin/packs/{id}/uninstall (needs --store pg|pg-columns)
  --marketplace-authoring  Enable the third-party authoring routes under /v1/authoring/packs —
                       submit a signed pack version, review it, publish/withdraw (needs --store pg).
                       A submitted version is immutable: re-submitting one is 409 version_exists
  --pack-publisher-key <namespace>:<authorKind>:<publicKeyBase64>  A publisher key the platform
                       pins (repeatable; required by --pack-catalog and --marketplace-authoring).
                       A pack must be signed by a registered key whose namespace covers its id, and
                       its manifest may claim only the author kind registered with that key
  --marketplace-platform-version <semver>  The platform version pack compatibility is checked
                       against. Unknown without it, which refuses every pack whose envelope
                       constrains the platform version
  --pack-admin-role <role>  Role allowed to install and uninstall catalog packs for its tenant
                       (repeatable; default erp_admin)
  --platform-admin     Expose the platform super-admin routes under /v1/platform — list/create/suspend/
                       archive/reactivate tenants + stats over meta.tenants (needs --store pg|pg-columns)
  --platform-admin-role <role>  Role allowed to call the /v1/platform routes (repeatable; default
                       platform_admin). Fail-closed: only these roles reach tenant management
  --admin-role <role>  Role allowed to read and write THIS tenant's settings at
                       GET/PUT /v1/admin/settings — the document-numbering overrides and the
                       formatting defaults the UI renders from (repeatable; default erp_admin,
                       which is the grant every deployment had when the role was hardcoded, so
                       declaring nothing changes nothing). Separate from --platform-admin-role,
                       which is cross-tenant and administers the tenant REGISTRY: a deployment can
                       grant either without the other. Fail-closed — a caller holding none of
                       these roles is 403 'admin role required' — and the settings routes are
                       mounted on every deployment and deliberately outside the subscription gate,
                       so a lapsed tenant can still open its billing screen. A declared role the
                       served manifest does not define is WARNED about at boot and not refused:
                       platform_admin is such a role on all seven packs and is a legitimate value
                       here, so a refusal would refuse a correct deployment
  --job-actor-role <role>  Role background job handlers act as when they write (repeatable, primary
                       first; default erp_admin). A job's write runs through the same handler a
                       request does — the manifest's grants, the write guards, the effects, the
                       lifecycle rule and the audit row — so this role is authorized exactly as a
                       person holding it would be; the audit row names the job run, never a person.
                       A role the served manifest does not declare registers no job handler at all,
                       said at boot
  --ai-design          Expose the in-product AI Architect under /v1/ai — POST a business description,
                       get a validated manifest proposal, activate it as the tenant's live system
                       (needs --store pg|pg-columns and a provider, tried in this order:
                       LOCAL_LLM_BASE_URL / OLLAMA_BASE_URL for a self-hosted model, then
                       ANTHROPIC_API_KEY, then OPENAI_API_KEY with optional OPENAI_BASE_URL for any
                       OpenAI-compatible host). Implies --per-tenant-manifests
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
  --ai-provider-timeout-ms <n>  Abort a provider call that sends nothing for this long (ms,
                       1000-3600000; default 120000; or OPERATE_AI_PROVIDER_TIMEOUT_MS). An
                       inactivity deadline, so a slow stream that keeps sending is never cut off
  --ai-max-output-tokens <n>  Output budget of each design attempt (1024-32768; default 8192; or
                       OPERATE_AI_MAX_OUTPUT_TOKENS). Lower it for a host whose per-minute token
                       allowance counts max tokens; a design that does not fit fails truncated_json
  --ai-model-price <in>:<out>[:<cachedIn>]  Declare the configured model's price, USD per million
                       tokens; both ceilings are computed from it. Needed for a model the built-in
                       catalogue does not price, and to correct a stale catalogue price (or
                       OPERATE_AI_MODEL_PRICE; 0:0 declares a free model)
  --ai-allow-unpriced-model  Serve a model with no catalogue or declared price. Its ceilings then
                       admit every request; refused at boot without this flag or --ai-model-price
  --ai-provider-ref <provider:qualifier>  Where the AI provider runs, as a tenant residency
                       profile's allowedLlmProviders names it (e.g. anthropic:us). A tenant whose
                       profile does not list it is refused AI design; undeclared, every profiled
                       tenant is refused
  --ai-tenant-pseudonym keyed|off  What an AI design request carries to identify its tenant
                       (default keyed): an opaque per-tenant id derived from
                       CURSOR_ENCRYPTION_SECRET, or nothing. off keeps sealed cursors and lets the
                       provider see no per-tenant identifier; the raw tenant id is never sent
                       either way. Needs --ai-design
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
  --audit-read-sensitive-class <class>=<role>  Narrower: grants ONE class to a role. A class named
                       here is authoritative for that class and --audit-read-sensitive-role no
                       longer reaches it, which is what makes "pii but not phi" expressible;
                       "<class>=" with no role withholds it from everyone
  --audit-read-max-range-days <n>  Largest queryable time range in days (>=1)
  --sensitive-field-role <r>  The same grant, for the ENTITY routes rather than the audit trail
                       (repeatable). Default none, which is why 39 of the 46 classified fields in
                       the packs are unreadable by every role: only the 7 carrying an explicit
                       per-field read grant come back. Governs reads and writes through one rule
  --sensitive-field-class <class>=<role>  Per-class entity grant, same grammar and same
                       authoritative-per-class rule as --audit-read-sensitive-class;
                       "<class>=" withholds it from everyone. Does NOT imply the write mask below
  --abac-policy <key>=<attr>:<op>[:<operand>]  Declare an ABAC policy a manifest grant's abac key
                       resolves against (repeatable). The attribute is the PRINCIPAL's, read from
                       meta.user_tenant_membership.abac_attributes. Ops over a declared VALUE:
                       eq, ne, in (comma list), present — e.g. clinical_only=department:eq:clinical.
                       Ops over a field of the RECORD: eq_record, ne_record, in_record — e.g.
                       same_dept=department:eq_record:department, owns=user_id:eq_record:owner_id.
                       A per-field read grant is answered per record, so a list page can disclose
                       the field on one row and withhold it on the next. A record op is refused at
                       boot on an entity create or list grant, where no call site can supply one.
                       Declaring any policy also switches on the attribute directory, and needs a
                       Postgres store
  --classified-write-mask  Enforce the classification default on writes: a sensitive field with no
                       declared update grant is writable only by a privileged role. Off by default
                       because a declared per-field update grant is enforced either way, and
                       because the default alone would make 12 required fields across 7 entities
                       (Patient, Employee, Lead, Opportunity, FixedAsset, Student, Permit)
                       writable by nobody. Refuses at boot, naming them, rather than 403ing on
                       the first create
  --read-state-routes  Expose per-viewer notification read state: POST /v1/notifications/{id}/read,
                       POST /v1/notifications/read-through, GET /v1/notifications/unread. The viewer
                       is ALWAYS the credential — a body naming one is refused, not ignored. Closes
                       ADR-0309's gap, where the web badge stood in recency for unread. Needs --store pg
  --read-state-role <r>  Role permitted to record its own read state and read its own unread count
                       (repeatable). Default none ⇒ the routes refuse everyone
  --read-state-backfill-role <r>  Role permitted to assert source=system_backfill on the watermark
                       route (repeatable). Default none ⇒ nobody. ADDITIVE on top of
                       --read-state-role, which is checked first. A backfill marks a whole backlog
                       read in one call, so it is recorded BEFORE the write and an unrecordable one
                       is refused. Watermark only: a row-wise backfill is unbounded
  --read-state-unread-scan <n>  Notices one unread answer may examine (1-${MAX_UNREAD_SCAN_LIMIT.toString()}, default ${DEFAULT_UNREAD_SCAN_LIMIT.toString()}).
                       The answer reports examined + truncated, so a client renders "200+" rather
                       than a quietly wrong total; an exact count needs a store-side anti-join
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
  --deletion-subject-scope <s>  tenant | subject. What a verified Article 17 request erases.
                       REQUIRED by --deletion-request-routes, with no default, because neither
                       value is safe to assume. "tenant" says a request here means the whole
                       tenant: every table carrying its id is emptied and its schema dropped, and
                       the proof says tenant_deletion referencing the request — honest only where a
                       tenant is one data subject, since otherwise one person's request destroys
                       everyone else's data. "subject" is REFUSED: nothing in this platform scopes
                       an erasure to a subject (register P1.4), so declaring it would make every
                       verified request refuse. Before this flag the runner hardcoded
                       data_subject_erasure over the tenant-wide erasure, so the question was
                       answered wrongly inside the signed proof
  --deletion-capabilities <file>  JSON: one of "erases" | "retains" | "absent" |
                       "present_not_erased" for every one of the six deletion subsystems. REQUIRED
                       by the deletion routes and the runner, because every default is wrong:
                       "absent" signs an Article 17 proof that is silent about a place the tenant's
                       data may still be, and that silence is the defect ADR-0317 was written for.
                       It replaced a field read from the request BODY with [] as its default, so a
                       remote caller chose the proof's reach.
                       "present_not_erased" is what a deployment holding BACKUPS should declare.
                       The other three forced it to lie: "erases" and "retains" keep the subsystem
                       in scope and nothing in this binary can attest for backups, so every
                       deletion refuses; "absent" is the only runnable value and it says "this
                       deployment does not take backups" inside a cryptographic proof. The fourth
                       leaves the attester requirement WITHOUT claiming the subsystem is not there,
                       which is ADR-0317 inverted rather than an instance of it: it is a positive
                       signed statement that the data is still held. Its horizon — "we hold it for
                       35 days" — is deliberately not expressible yet; see the boot line
  --deletion-capability <subsystem>=<disposition>  The same six-value declaration, inline and
                       repeatable, mutually exclusive with --deletion-capabilities. Exists because
                       the FILE had no route on a shipped deployment: the compose declares no
                       volumes: key, so the only way one reached the container was a commit baked
                       into an image layer, which costs a full install+build to change one word.
                       Inline, the declaration sits in docker-compose.yml where a diff shows it and
                       a test can fence it. All six or none — an incomplete set is refused naming
                       what is missing, because silence may not answer the reach of an Article 17
                       proof (ADR-0328) — and a repeated subsystem is refused rather than
                       last-wins, since a disposition is one decision and argv order must not
                       decide what a signed proof claims
  --deletion-escalation-config <file>  JSON ({severity?, category?, declaredBy?, alertPolicy}) —
                       declares an incident and pages when a deletion proof does not verify or two
                       tombstones name one request. These are the findings the forensic chain
                       CANNOT raise, because nothing in it commits to a tombstone's scope. One
                       incident per request, closed out when the finding resolves
  --deletion-request-deadline-days <n>  Days from submission to the Article 12(3) deadline
                       (default 30, max 90). Per deployment, not per request
  --deletion-runner-ms <n>  Run verified deletion requests out of band every n ms (>=1000). The
                       first tick is one interval AFTER boot, never at boot: the work is
                       irreversible and a boot is when a misconfiguration is most likely
  --deletion-runner-executed-by <a>  Actor unattended deletions execute as (default
                       system:deletion-runner)
  --deletion-grace-days <n>  Days a verified deletion request waits before the runner may
                       execute it (0..90, default ${DEFAULT_DELETION_GRACE_DAYS.toString()}). Rejecting the request inside the window
                       cancels it; the wait shortens itself so it can never cross the Article
                       12(3) deadline. The approver is the principal who verified the request
  --deletion-runner-batch-size <n>  Requests the runner may take per tick (1..100, default 5).
                       Each one is a whole tenant's data, and they run serially
  --max-request-body-route <prefix>=<size>  Per-route override, longest path prefix winning
                       (repeatable). Lets --max-request-body be set small, with the few routes that
                       legitimately take a large body named. Per-*tenant* is not expressible here:
                       the tenant comes from the credential and the limit is chosen before the body
                       is read
  --max-request-body <size>  Largest buffered request body — bytes or a size like 25mb (default
                       10mb, floor 1kb, ceiling 1gb). Not disableable; out-of-band values are
                       refused at boot rather than clamped
  --pg-pool-max <n>    Database connections the serving pool holds (1..1000, default 10)
  --pg-connect-timeout-ms <ms>  How long to wait to open a connection or for a free one in a full
                       pool (1000..600000, or 0 to wait for ever; default 30000)
  --pg-idle-timeout-ms <ms>  Close a pooled connection idle this long (1000..3600000, or 0 for
                       never; default 10000)
  --pg-statement-timeout-ms <ms>  Per-session statement_timeout (1000..86400000, or 0 to leave the
                       server's default; default 300000). An Article 17 erasure of a very large
                       tenant runs single DELETEs that can exceed it — raise it or set 0
  --pg-lock-timeout-ms <ms>  Per-session lock_timeout (100..86400000, or 0; default 60000)
  --pg-idle-in-transaction-timeout-ms <ms>  Per-session idle_in_transaction_session_timeout
                       (1000..86400000, or 0; default 60000). All six bound the serving connection
                       only and are printed at boot; migrate and the operator subcommands
                       (rekey, replay, verify-chain, prune-links, set-credential) run unbounded
  --http-headers-timeout-ms <ms>  How long a client may take to send the request head (1000..600000,
                       default 60000)
  --http-request-timeout-ms <ms>  How long a client may take to send the whole request (1000..3600000,
                       default 300000; must not be below the headers timeout)
  --http-keep-alive-timeout-ms <ms>  Idle keep-alive before the server closes a socket (1000..600000,
                       default 125000, longer than Caddy's 2-minute upstream idle so the proxy never
                       reuses a socket this server is closing)
  --http-max-connections <n>  Open sockets the listener accepts (1..1000000, default 4096)
  --shutdown-grace-ms <ms>  On SIGTERM, how long in-flight requests may finish before their sockets
                       are closed (0..300000, default 8000, inside Docker's 10 s stop timeout); the
                       database pool is closed after them. All five are printed at boot
  --design-review      Expose the platform design-review queue (/v1/platform/design-reviews)
  --design-review-role <r>  Role permitted to decide reviews (repeatable; default platform_admin)
  --require-design-review   Require platform approval before a tenant activates a proposal
                       (implies --design-review)
  --allow-design-self-approval  Let the principal that requested a design approve it. Off by
                       default: the requester is refused 403 designer_cannot_approve. For a
                       deployment run by one person; said at boot either way
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
  --audit-chain-config <file>  JSON audit-chain POLICY, with the keypair now optional ({schema?,
                       actorReference?, privateKeyBase64?, publicKeyBase64?, outcomes?, operations?,
                       sampleRate?, tenantOverrides?}) — appends a signed, hash-linked audit-log
                       entry per (sampled/filtered) request into the tamper-evident chain and
                       registers its sealing key in the key registry (needs --store pg).
                       The signing key's own route is the ENVIRONMENT: set AUDIT_CHAIN_SIGNING_KEY
                       to a base64 Ed25519 seed and the public half is derived, so there is one
                       value and not two and nothing can state the pair inconsistently. The
                       variable alone turns the chain on, so no file is needed for the defaults.
                       Until it existed this flag was the only route to the seed, and no shipped
                       compose could pass a file — so nothing was anchored anywhere. Both sources
                       may carry a key only if they state the SAME one (compared by fingerprint);
                       a disagreement is refused by name, because whichever won would decide the
                       fingerprint every entry announces
  --checkpoint-config <file>  JSON checkpoint config ({schema?, intervalMs?, checkpointedBy?, tenants?,
                       includePlatform?, allTenants?, tenantStatuses?}) — periodically anchors a chain
                       checkpoint per tenant (allTenants: every active tenant from the live registry,
                       tenantStatuses: which statuses to include) so verifying a long chain stays bounded.
                       includePlatform defaults to TRUE and is paired with the integrity proof's: the
                       proof's truncation check has no witness without a checkpoint
                       (needs --store pg + --audit-chain-config)
  --checkpoints        Mount the checkpoint scheduler with no file: the schema's own defaults plus
                       allTenants, over every tenant status rather than only 'active'. A boolean
                       rather than a documented empty file because an empty config resolves to the
                       PLATFORM chain alone — and on a deployment with no escalation flag that
                       chain is empty, so the pass anchors nothing, verifies nothing and prints
                       nothing. Measured live: 0 anchors / 0 verdicts / 0 log lines against
                       4 / 4 / 8 with allTenants. Mutually exclusive with --checkpoint-config
  --integrity-proof-config <file>  JSON integrity-proof config ({schema?, intervalMs?, verifiedBy?,
                       tenants?, includePlatform?, allTenants?, tenantStatuses?, auditRowLimit?,
                       fromCheckpoint?, recordVerdict?, escalation?}) — periodically runs BOTH
                       halves of the audit-integrity proof (each audit row against its anchor, and
                       the chain's own links + signatures), checks for chain truncation against the
                       latest checkpoint, and appends the verdict to the chain as a security_event.
                       With escalation ({severity?, category?, declaredBy?, alertPolicy}) a
                       compromised verdict declares an incident and pages once per episode.
                       includePlatform defaults to TRUE: three escalators write platform-scope rows,
                       so leaving it off meant writing rows nothing verified
                       (needs --store pg + --audit-chain-config)
  --integrity-proof    Mount the integrity proof with no file: --checkpoints' sibling, same
                       literal, same reason. No escalation block, so a deployment that wants a page
                       declares the alert policy itself. Mutually exclusive with
                       --integrity-proof-config
  --integrity-proof-full-every <n>  Fold the whole chain on the first pass after boot and every
                       Nth pass per scope, even where a signed checkpoint would keep the pass
                       bounded (default 24, a day at the hourly interval; 0 never). Needs
                       --integrity-proof; the config file's field is fullFoldEveryPasses
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

Auth: OPERATE_API_KEY_SPECS (or --api-key) for opaque tokens; --jwks-* + --jwt-*
to verify Bearer JWTs (EdDSA) against an IdP's public keys — the verified claims
(sub/scope/tenant_id) become the principal. Both api-key sources are read and
concatenated; a spec on argv is reported at boot because \`ps\` discloses it.
Postgres (--store pg): standard PG* env vars.
`;

/**
 * Options for the `replay` maintenance subcommand — re-derive each subsystem's projections from
 * their own logs and report where the two disagree. **Read-only**; uses standard PG* env vars.
 *
 * Six packages shipped a drift replayer and nothing constructed any of them, so this is the first
 * caller any of them has had. Two were bug-fixed in consecutive increments while nothing ran them.
 *
 * The scope flags mirror `prune-links` (`--tenant` / `--all-tenants`) rather than `verify-chain`
 * (`--tenant` / `--platform`) and add `--platform` as a third arm, because the subsystems do not
 * share one scoping story: two of the six read isolation-only tables where a non-owner with no
 * tenant context matches **zero** rows, so for those a tenant loop is the only complete mode. See
 * `REPLAY_SCOPE_SUPPORT` in `replay.ts` for the measurement.
 */
export interface ReplayOptions {
  readonly tenantId: string | null;
  /** Loop every active tenant from `meta.tenants` (mutually exclusive with --tenant/--platform). */
  readonly allTenants: boolean;
  /** Read the platform (null-tenant) scope (mutually exclusive with --tenant/--all-tenants). */
  readonly platform: boolean;
  /** Subsystems to replay; empty means every subsystem the chosen scope can serve. */
  readonly subsystems: readonly ReplaySubsystem[];
  readonly limit: number;
  readonly schema: string | null;
  readonly format: "human" | "json";
  readonly help: boolean;
}

/**
 * Parses the argv *after* the `replay` token.
 *
 * At most one scope flag, and **no default scope**: which rows a maintenance sweep examined is not
 * something silence may answer (ADR-0328's rule), and the unscoped read is an owner-only
 * diagnostic that returns 1 of 7 rows as a non-owner — so defaulting to it would make the most
 * misleading output the easiest one to produce.
 */
export function parseReplayArgs(argv: readonly string[]): ReplayOptions {
  let tenantId: string | null = null;
  let allTenants = false;
  let platform = false;
  const subsystems: ReplaySubsystem[] = [];
  let limit = 100;
  let schema: string | null = null;
  let format: "human" | "json" = "human";
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
    } else if (arg === "--all-tenants") {
      allTenants = true;
    } else if (arg === "--platform") {
      platform = true;
    } else if (arg === "--subsystem" || arg.startsWith("--subsystem=")) {
      const raw = takeValue(arg, next, "--subsystem");
      // Refused by name rather than ignored: a misspelled subsystem that silently selected nothing
      // would report "every selected subsystem found no drift" having run none of them.
      if (!(REPLAY_SUBSYSTEMS as readonly string[]).includes(raw)) {
        throw new CliUsageError(
          `unknown --subsystem: ${raw} (${REPLAY_SUBSYSTEMS.join(", ")})`,
        );
      }
      subsystems.push(raw as ReplaySubsystem);
      i += consumed();
    } else if (arg === "--limit" || arg.startsWith("--limit=")) {
      const raw = takeValue(arg, next, "--limit");
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) throw new CliUsageError(`invalid --limit: ${raw} (>= 1)`);
      limit = n;
      i += consumed();
    } else if (arg === "--schema" || arg.startsWith("--schema=")) {
      schema = takeValue(arg, next, "--schema");
      i += consumed();
    } else if (arg === "--format" || arg.startsWith("--format=")) {
      const raw = takeValue(arg, next, "--format");
      if (raw !== "human" && raw !== "json") {
        throw new CliUsageError(`invalid --format: ${raw} (human|json)`);
      }
      format = raw;
      i += consumed();
    } else {
      throw new CliUsageError(`unknown argument: ${arg}`);
    }
  }

  if (!help) {
    const chosen = [tenantId !== null, allTenants, platform].filter(Boolean).length;
    if (chosen === 0) {
      throw new CliUsageError(
        "replay requires exactly one of --tenant <uuid>, --all-tenants or --platform:" +
          " two of the six subsystems read isolation-only tables where an unscoped read matches" +
          " zero rows as a non-owner, so a scopeless sweep would print no findings having read nothing",
      );
    }
    if (chosen > 1) {
      throw new CliUsageError(
        "replay takes at most one of --tenant, --all-tenants and --platform",
      );
    }
    if (tenantId !== null && !TENANT_ID_RE.test(tenantId)) {
      throw new CliUsageError(`invalid --tenant: ${tenantId}`);
    }
  }

  return { tenantId, allTenants, platform, subsystems, limit, schema, format, help };
}

export const replayHelpText = `operate-server replay — re-derive each subsystem's projections from its own log and report drift

Usage:
  operate-server replay --tenant <uuid> [--subsystem <name>]... [options]
  operate-server replay --all-tenants [--subsystem <name>]... [options]
  operate-server replay --platform [--subsystem <name>]... [options]

Read-only: nothing is written, and the repairing half of the workflow replayer is deliberately
not reachable from here (its repair is not transactional and writes a live worker queue).

Scope (exactly one, no default):
  --tenant <uuid>      One tenant's projections
  --all-tenants        Every active tenant from meta.tenants, one pass each, plus the platform
  --platform           The platform (null-tenant) scope only

Subsystems (repeatable; default is every subsystem the chosen scope can serve):
  dr, slo, access_reviews, gateway, incidents, workflow

  Not every subsystem can serve every scope, and this is read off the catalog rather than chosen:
    access_reviews, workflow   tenant only -- their tables carry the isolation policy as their
                               ONLY arm, so an unscoped read matches zero rows as a non-owner
    dr, slo, gateway           tenant or platform -- isolation plus a platform SELECT arm
    incidents                  no scope -- meta.incidents has no tenant_id and no RLS, so a
                               scope flag is refused rather than ignored
  A subsystem the chosen scope cannot serve is reported NOT READ with the reason, not skipped.

Options:
  --limit <n>          Rows per subsystem (default 100). A truncated pass is marked TRUNCATED,
                       because "0 findings" over a cut window is not "nothing has drifted"
  --schema <name>      Meta-schema name (default meta)
  --format human|json  Output format (default human)

Exit: 0 when every selected subsystem was readable and found nothing; 1 when anything drifted
OR a subsystem could not be read -- an unread subsystem must not exit 0; 2 on a usage error.
`;

/**
 * Parses the argv *after* the `rekey` token.
 *
 * `--confirm-tenant` is required and must equal `--tenant`, following
 * `--tenant-erasure-routes`' `confirmTenantId` rule: the operation's last act is a `DELETE` of the
 * only copy of a key, and rekeying the **wrong** tenant rewrites every one of their PHI rows under a
 * key they were not previously under. There is no `--yes`, because a flag that means "I meant it"
 * can be pasted from a runbook without reading the tenant id, which is the thing being confirmed.
 *
 * Two schemas and not one, which is the flag this subcommand cannot avoid having twice: a single
 * `--schema` drives `PostgresDataKeyStore` (whose own default is `meta`) and
 * `ColumnMappedEntityStore` (whose default is `public`), so a tool taking one value would address
 * the wrapped key in the right place and the ciphertext in the wrong one for at least one
 * configuration — and finding no key where it looked, provision a second one.
 */
export function parseRekeyArgs(argv: readonly string[]): RekeyOptions {
  let tenantId: string | null = null;
  let confirmTenantId: string | null = null;
  let plan = false;
  let schema: string | null = null;
  let dataSchema: string | null = null;
  let allowLiveRekey = false;
  let rewrapKek = false;
  let columnKeyTtlMs: number | null = null;
  let format: "human" | "json" = "human";
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
    } else if (arg === "--confirm-tenant" || arg.startsWith("--confirm-tenant=")) {
      confirmTenantId = takeValue(arg, next, "--confirm-tenant");
      i += consumed();
    } else if (arg === "--plan") {
      plan = true;
    } else if (arg === "--schema" || arg.startsWith("--schema=")) {
      schema = takeValue(arg, next, "--schema");
      i += consumed();
    } else if (arg === "--data-schema" || arg.startsWith("--data-schema=")) {
      dataSchema = takeValue(arg, next, "--data-schema");
      i += consumed();
    } else if (arg === "--allow-live-rekey") {
      allowLiveRekey = true;
    } else if (arg === "--rewrap-kek") {
      rewrapKek = true;
    } else if (arg === COLUMN_KEY_TTL_FLAG || arg.startsWith(`${COLUMN_KEY_TTL_FLAG}=`)) {
      const raw = takeValue(arg, next, COLUMN_KEY_TTL_FLAG);
      const n = Number(raw);
      if (
        !Number.isInteger(n) ||
        n < COLUMN_KEY_TTL_BOUNDS.min ||
        n > COLUMN_KEY_TTL_BOUNDS.max
      ) {
        throw new CliUsageError(
          `${COLUMN_KEY_TTL_FLAG} must be an integer between ${COLUMN_KEY_TTL_BOUNDS.min.toString()}` +
            ` and ${COLUMN_KEY_TTL_BOUNDS.max.toString()} ms, got '${raw}'`,
        );
      }
      columnKeyTtlMs = n;
      i += consumed();
    } else if (arg === "--format" || arg.startsWith("--format=")) {
      const raw = takeValue(arg, next, "--format");
      if (raw !== "human" && raw !== "json") {
        throw new CliUsageError(`invalid --format: ${raw} (human|json)`);
      }
      format = raw;
      i += consumed();
    } else {
      throw new CliUsageError(`unknown argument: ${arg}`);
    }
  }

  if (!help) {
    if (tenantId === null) throw new CliUsageError("rekey requires --tenant <uuid>");
    if (!TENANT_ID_RE.test(tenantId)) throw new CliUsageError(`invalid --tenant: ${tenantId}`);
    // Required even under `--plan`, so the invocation an operator reviews is the invocation they
    // then re-run without the flag. A confirmation that appears only on the destructive run is one
    // they meet for the first time at the moment they are least likely to read it.
    if (confirmTenantId === null) {
      throw new CliUsageError(
        "rekey requires --confirm-tenant <uuid>: the tenant id is typed twice because rekeying" +
          " the wrong tenant rewrites every one of their encrypted rows under a new key",
      );
    }
    if (confirmTenantId.toLowerCase() !== tenantId.toLowerCase()) {
      throw new CliUsageError("--confirm-tenant must equal --tenant");
    }
    // A re-wrap changes no column key, so the hatch for a live rekey has nothing to admit there;
    // accepting it silently would let an operator believe the two runs are one.
    if (rewrapKek && allowLiveRekey) {
      throw new CliUsageError(
        "--rewrap-kek changes no column key, so --allow-live-rekey has nothing to allow; drop it",
      );
    }
  }

  return {
    tenantId: tenantId ?? "",
    confirmTenantId: confirmTenantId ?? "",
    plan,
    schema,
    dataSchema,
    allowLiveRekey,
    rewrapKek,
    columnKeyTtlMs,
    format,
    help,
  };
}

/**
 * Parses the argv *after* the `set-credential` token.
 *
 * `--confirm-user` is required and must equal `--user`, following `rekey`'s `--confirm-tenant`:
 * this overwrites a credential, so naming the wrong user locks a real person out *and* hands their
 * account to whoever typed the password. The password itself is never an argument — it comes from
 * `OPERATE_NEW_PASSWORD` in the environment, because argv is readable by anyone who can run `ps`
 * (ADR-0301).
 */
export function parseSetCredentialArgs(argv: readonly string[]): SetCredentialOptions {
  let userId: string | null = null;
  let confirmUserId: string | null = null;
  let schema: string | null = null;
  let format: "human" | "json" = "human";
  let help = false;
  let minPasswordLength: number | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    const next = argv[i + 1];
    const consumed = (): number => (isInline(arg) ? 0 : 1);
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--min-password-length" || arg.startsWith("--min-password-length=")) {
      minPasswordLength = parseMinPasswordLength(takeValue(arg, next, "--min-password-length"));
      i += consumed();
    } else if (arg === "--user" || arg.startsWith("--user=")) {
      userId = takeValue(arg, next, "--user");
      i += consumed();
    } else if (arg === "--confirm-user" || arg.startsWith("--confirm-user=")) {
      confirmUserId = takeValue(arg, next, "--confirm-user");
      i += consumed();
    } else if (arg === "--schema" || arg.startsWith("--schema=")) {
      schema = takeValue(arg, next, "--schema");
      i += consumed();
    } else if (arg === "--format" || arg.startsWith("--format=")) {
      const raw = takeValue(arg, next, "--format");
      if (raw !== "human" && raw !== "json") {
        throw new CliUsageError(`invalid --format: ${raw} (human|json)`);
      }
      format = raw;
      i += consumed();
    } else if (arg === "--password" || arg.startsWith("--password=")) {
      // Named explicitly so the refusal can say why, rather than falling through to "unknown
      // option" and leaving an operator to think they mistyped it.
      throw new CliUsageError(
        `--password is deliberately not an option: a password on argv is readable by anyone who` +
          ` can run 'ps'. Set ${NEW_PASSWORD_VAR} in the environment instead.`,
      );
    } else {
      throw new CliUsageError(`unknown option for set-credential: ${arg}`);
    }
  }

  if (help) return { userId, confirmUserId, schema, format, help: true };
  if (userId === null) {
    throw new CliUsageError("set-credential requires --user <uuid>");
  }
  if (confirmUserId === null) {
    throw new CliUsageError(
      "set-credential requires --confirm-user <uuid>: the user id is typed twice because this" +
        " overwrites a credential, so naming the wrong user both locks that person out and hands" +
        " their account to whoever typed the password",
    );
  }
  if (userId !== confirmUserId) {
    throw new CliUsageError(
      `--user and --confirm-user differ (${userId} vs ${confirmUserId})`,
    );
  }
  return {
    userId,
    confirmUserId,
    schema,
    format,
    help: false,
    ...(minPasswordLength !== null ? { minPasswordLength } : {}),
  };
}

export const setCredentialCliHelpText = `operate-server set-credential — set a user's login password

Usage:
  operate-server set-credential --user <uuid> --confirm-user <uuid> [options]

The password is read from ${NEW_PASSWORD_VAR} in the environment and never from argv, because argv
is readable by anyone who can run 'ps' (ADR-0301). $${CREDENTIAL_PEPPER_VAR} must be set to the same
value the server runs with, or the credential will not verify.

This is the bootstrap path: there is no mail channel in a fresh deployment, so an operator with
shell access is the only principal that exists before the first password does.

Options:
  --user <uuid>          The meta.users row to set a password on
  --confirm-user <uuid>  The same id again (required; there is no --yes)
  --schema <name>        Meta-schema name (default meta)
  --min-password-length <n>
                         The floor the server's credential routes enforce (default
                         ${DEFAULT_MIN_PASSWORD_LENGTH.toString()}); pass the same value as the server's flag
  --format human|json    Output format (default human)

Exit: 0 when the credential was set; 1 when refused; 2 on a usage error.
`;

export const rekeyHelpText = `operate-server rekey — move one tenant's at-rest column key to a fresh random data key

Usage:
  operate-server rekey --tenant <uuid> --confirm-tenant <uuid> [--plan] [options]

Why: under --column-key-mode envelope, a tenant that already held ciphertext when the deployment
switched modes was SEEDED from the key derived from COLUMN_ENCRYPTION_SECRET, so its stored key is
still recomputable and destroying the row destroys nothing. A rekey re-encrypts that tenant's
encrypted columns under a freshly generated random data key and retires the old generation, which
is what makes a later destruction bound the recovery horizon.

One transaction per tenant: either the re-encrypted columns and the new key row both commit, or
neither does. Every refusal lands before the first UPDATE, and the rotation is confirmed to read
back under the new key before the transaction commits.

Required:
  --tenant <uuid>          The tenant to rekey
  --confirm-tenant <uuid>  The same id again. Rekeying the wrong tenant rewrites every one of
                           their encrypted rows under a key they were not under before.

Options:
  --plan                   Survey only: print the current generation, the provenance, the columns
                           and their row counts, and write nothing
  --schema <name>          Schema holding meta.tenant_data_keys (default meta)
  --data-schema <name>     Schema holding the encrypted entity tables (default public; a tenant
                           serving its own activated manifest uses t_<hex>)
  --column-key-ttl-ms <n>  The SERVING fleet's --column-key-ttl-ms, so the stale-key window this
                           prints is your value rather than the default. This process does not run
                           the gateway and cannot read it; unstated, the line says so.
  --allow-live-rekey       Proceed although meta.tenants says this tenant still accepts writes.
                           A serving process holding the previous key in cache would write new
                           values under it, splitting this tenant's data across two keys with
                           nothing recording which — the one outcome here that cannot be undone.
  --rewrap-kek             Re-wrap the tenant's current data key under the current
                           key-encryption-key generation instead of rekeying it: the secret-rotation
                           step. No column is re-encrypted and no write gate applies. Needs
                           COLUMN_ENCRYPTION_SECRET_PREVIOUS while rows still name the old one.
  --format human|json      Output format (default human)

The deployment secret is read from COLUMN_ENCRYPTION_SECRET (with COLUMN_ENCRYPTION_SECRET_PREVIOUS
and COLUMN_ENCRYPTION_SECRET_GENERATION during a rotation) and never from argv. Postgres: standard
PG* env vars; run as a role row-level security does not confine, because a confined session's
"0 rows re-encrypted" is indistinguishable from "this tenant holds no ciphertext".

Before anything else — on --plan and --rewrap-kek too — the boot's column-key check runs for this
tenant: a secret ring that cannot open its stored data key (or the ciphertext its first key would be
seeded from) is refused with the condition and its remedy, and nothing past it runs.

Exit: 0 on a completed rekey or a clean plan; 1 when the column-key check or the survey refuses;
2 on a usage error.
`;
