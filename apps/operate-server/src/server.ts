import type { ForwardedProto, HttpMethod, PipelineExecution } from "@crossengin/api-gateway";
import type {
  AbacBatchEvaluator,
  AbacEvaluator,
  RoleName,
  SensitiveFieldPolicy,
} from "@crossengin/auth";
import type {
  CursorSealer,
  OpenApiCoverageGap,
  UiUserIdentityResolver,
} from "@crossengin/operate-runtime";
// A value import, not a type-only one: `decideCursorDisclosure` and `surveySortableClassifiedFields`
// are called below, which is what makes the per-tenant survey possible. There is no cycle —
// `cursor-encryption.ts` references `server.js` zero times.
import {
  decideCursorDisclosure,
  surveySortableClassifiedFields,
  type CursorDisclosureDecision,
  type CursorSealingMode,
} from "./cursor-encryption.js";
import type {
  HmacKeyLookup,
  MtlsClientLookup,
  IdempotencyStore,
  RateLimitChecker,
} from "@crossengin/api-gateway-runtime";
import type { Manifest } from "@crossengin/kernel/manifest";
import type { Region } from "@crossengin/residency";
import { decideRegionRouting, type TenantResidencyDirectory } from "@crossengin/residency-runtime";
import {
  buildOperateGateway,
  type BillingPortalWiring,
  type EntitlementResolver,
  type EntityStore,
  type ExtraGatewayRoute,
  type JobInvoker,
  type OperateServer,
  type SequenceAllocator,
  type SettingsStore,
  type WriteEffect,
  type WriteMaskMode,
} from "@crossengin/operate-runtime";

import type { EdgeTrust } from "@crossengin/api-gateway-runtime";
import { parseMethod, rawToIncoming, splitTarget, type RawHttpRequest, type RawHttpResponse } from "./http.js";
import {
  buildPrincipalWiring,
  type ApiKeySpec,
  type HmacKeySpec,
  type MtlsClientSpec,
  type JwtVerifyConfig,
} from "./principals.js";
import { applyTenantStatusGate, type TenantStatusGateOptions } from "./tenant-status-gate.js";
import { AbacObligationsUnevaluable, checkAbacObligations } from "./abac-obligations.js";
import { surveySensitiveFields, type SensitiveFieldSurvey } from "./sensitive-field-policy.js";
import {
  withAbacAttributes,
  withMembershipRevocationCheck,
  type AbacAttributeDirectory,
} from "./abac-attributes.js";

let requestCounter = 0;
function defaultRequestId(): string {
  requestCounter += 1;
  return `req_${Date.now().toString(36)}${requestCounter.toString(36).padStart(4, "0")}`;
}

/**
 * A pre-dispatch route handled directly (bypassing the gateway auth pipeline) — for
 * signature-authenticated ingress like Stripe webhooks, where the request is verified by
 * its signature, not an API key/JWT. Matched by exact method + path before the gateway runs.
 */
export interface WebhookRoute {
  readonly method: HttpMethod;
  readonly path: string;
  handle(body: Uint8Array | null, headers: RawHttpRequest["headers"]): Promise<RawHttpResponse>;
}

/**
 * Data-residency edge routing: this instance's `region` + a tenant→profile
 * directory. Before dispatch, a request carrying a tenant hint whose profile
 * forbids `region` is redirected to the tenant's home region (or denied), so a
 * tenant's data is only ever served from a residency-compatible region.
 */
export interface RegionGuardConfig {
  readonly region: Region;
  readonly directory: TenantResidencyDirectory;
  /** Header carrying the tenant hint used for pre-auth routing (default `x-tenant-id`). */
  readonly tenantHeader?: string;
}

export interface OperateHttpServerOptions {
  readonly gateway: OperateServer;
  readonly webhookRoute?: WebhookRoute;
  readonly regionGuard?: RegionGuardConfig;
  /**
   * Whether to believe a request's forwarded facts. **Required**, and passed unconditionally.
   *
   * Required on both this interface and `BuildOperateHttpServerOptions` because the literal that
   * forwards between them is a conditional spread, which bypasses TypeScript's excess-property
   * check — so an optional field dropped there typechecks, and ADR-0391 measured exactly that
   * shape silently disarming a whole increment while `tsc` exited 0. Required at both ends, the
   * drop is a compile error at the literal.
   */
  readonly edgeTrust: EdgeTrust;
  readonly defaultScheme?: ForwardedProto;
  readonly idGenerator?: () => string;
  readonly now?: () => Date;
  /**
   * Invoked with the `PipelineExecution` of every gateway-dispatched request
   * (after the response is produced). The SLO request observer subscribes here
   * to feed the live request stream into the enforcement engines. Never throws
   * out of dispatch — an observer error is swallowed so observation can't break
   * serving.
   */
  readonly onExecution?: (execution: PipelineExecution) => void;
}

const METHOD_NOT_ALLOWED_TYPE = "https://crossengin.io/problems/method-not-allowed";
const MISDIRECTED_REGION_TYPE = "https://crossengin.io/problems/misdirected-region";
const RESIDENCY_VIOLATION_TYPE = "https://crossengin.io/problems/residency-violation";

/**
 * The framework-agnostic serving core: turns a `RawHttpRequest` + body into a
 * `RawHttpResponse` by mapping it to a gateway `IncomingRequest`, running the
 * full pipeline, and projecting the `OutgoingResponse` back out. Binds no
 * socket, so it is unit-tested offline; the Node `http` adapter is a thin shell
 * over `dispatch`.
 */
export class OperateHttpServer {
  private readonly gateway: OperateServer;
  private readonly webhookRoute: WebhookRoute | null;
  private readonly regionGuard: RegionGuardConfig | null;
  private readonly scheme: ForwardedProto;
  private readonly edgeTrust: EdgeTrust;
  private readonly idGenerator: () => string;
  private readonly now: () => Date;
  private readonly onExecution: ((execution: PipelineExecution) => void) | null;

  constructor(opts: OperateHttpServerOptions) {
    this.gateway = opts.gateway;
    this.webhookRoute = opts.webhookRoute ?? null;
    this.regionGuard = opts.regionGuard ?? null;
    this.scheme = opts.defaultScheme ?? "http";
    this.edgeTrust = opts.edgeTrust;
    this.idGenerator = opts.idGenerator ?? defaultRequestId;
    this.now = opts.now ?? (() => new Date());
    this.onExecution = opts.onExecution ?? null;
  }

  async dispatch(raw: RawHttpRequest, body: Uint8Array | null): Promise<RawHttpResponse> {
    const method = parseMethod(raw.method);
    if (method === null) {
      return problem(405, METHOD_NOT_ALLOWED_TYPE, "Method not allowed", `unsupported method ${raw.method}`);
    }
    // Signature-authenticated webhook ingress bypasses the gateway auth pipeline.
    if (this.webhookRoute !== null && method === this.webhookRoute.method && splitTarget(raw.url).path === this.webhookRoute.path) {
      return this.webhookRoute.handle(body, raw.headers);
    }
    // Data-residency edge routing (pre-auth): route/deny by the request's tenant hint before dispatch.
    const residency = await this.checkResidency(raw);
    if (residency !== null) return residency;
    // `x-forwarded-proto` is read **only from a trusted edge**, which is the fifth member of the
    // same class as the certificate and the TLS version: it is a caller-settable header, and before
    // the trust declaration existed this line let any caller tell the gateway its own connection was
    // https. Untrusted, the configured `defaultScheme` is what this process knows — the scheme it
    // was told it is serving on — which is the honest answer rather than a caller's claim.
    const forwardedProto =
      this.edgeTrust === "trusted" ? (headerScheme(raw) ?? this.scheme) : this.scheme;
    const incoming = rawToIncoming(raw, body, {
      method,
      scheme: forwardedProto,
      id: this.idGenerator(),
      receivedAt: this.now().toISOString(),
      edgeTrust: this.edgeTrust,
    });
    const { response, execution } = await this.gateway.runtime.handleRequest(incoming);
    if (this.onExecution !== null) {
      try {
        this.onExecution(execution);
      } catch {
        // Observation must never break serving.
      }
    }
    return { status: response.status, headers: { ...response.headers }, body: response.bodyBytes };
  }

  /**
   * Residency edge decision for a request. Uses the (unverified) tenant hint header only to *route*
   * (redirect to the tenant's home region) or *deny* a forbidden region — never to grant access, so a
   * spoofed hint can at worst misdirect the attacker's own request. A tenant with no residency profile
   * is unconstrained (returns null → dispatch proceeds); the gateway still authenticates authoritatively.
   */
  private async checkResidency(raw: RawHttpRequest): Promise<RawHttpResponse | null> {
    if (this.regionGuard === null) return null;
    const header = this.regionGuard.tenantHeader ?? "x-tenant-id";
    const raw0 = raw.headers[header];
    const hint = Array.isArray(raw0) ? raw0[0] : raw0;
    if (hint === undefined || hint === "") return null;
    const profile = await this.regionGuard.directory.resolve(hint);
    if (profile === null) return null;
    const decision = decideRegionRouting(profile, this.regionGuard.region);
    if (decision.action === "redirect") {
      return regionProblem(421, MISDIRECTED_REGION_TYPE, "Misdirected region", decision.reason, decision.region);
    }
    if (decision.action === "deny") {
      return regionProblem(403, RESIDENCY_VIOLATION_TYPE, "Residency violation", decision.reason, null);
    }
    return null;
  }
}

/** A residency problem doc carrying the correct region (as a header + an extension). */
function regionProblem(status: number, type: string, title: string, detail: string, correctRegion: Region | null): RawHttpResponse {
  const extensions = correctRegion !== null ? { correctRegion } : {};
  const bodyBytes = new TextEncoder().encode(JSON.stringify({ type, title, status, detail, extensions }));
  const headers: Record<string, string> = {
    "content-type": "application/problem+json",
    "content-length": bodyBytes.byteLength.toString(),
  };
  if (correctRegion !== null) headers["x-crossengin-region"] = correctRegion;
  return { status, headers, body: bodyBytes };
}

function headerScheme(raw: RawHttpRequest): ForwardedProto | null {
  const v = raw.headers["x-forwarded-proto"];
  const proto = Array.isArray(v) ? v[0] : v;
  return proto === "https" || proto === "http" ? proto : null;
}

function problem(status: number, type: string, title: string, detail: string): RawHttpResponse {
  const body = new TextEncoder().encode(JSON.stringify({ type, title, status, detail, extensions: {} }));
  return {
    status,
    headers: {
      "content-type": "application/problem+json",
      "content-length": body.byteLength.toString(),
    },
    body,
  };
}

export interface BuildOperateHttpServerOptions {
  readonly manifest: Manifest;
  readonly store: EntityStore;
  readonly apiKeys: readonly ApiKeySpec[];
  /** Optional production identity: verify Bearer JWTs against a JWKS. */
  readonly jwt?: JwtVerifyConfig;
  /**
   * Who is privileged for each sensitive data class, for **both** the response redaction and the
   * write mask (ADR-0339).
   *
   * Absent until this option existed, which is why 39 of the 46 classified fields in the packs
   * were unreadable by every role: the redaction policy was `{}`, so `privilegedForClass` answered
   * false for everyone and only a field with an explicit per-field `read` grant came back. One
   * policy reaches both directions deliberately — `privilegedForClass` has one definition so that a
   * role cannot end up able to write a class it may not read (ADR-0329), and two policy sources
   * would have made that property unenforceable.
   */
  readonly policyForEntity?: (entity: string) => SensitiveFieldPolicy | undefined;
  /**
   * `explicit_only` (the default) enforces a per-field `update` grant the manifest declares;
   * `classified` adds the classification default. See `--classified-write-mask` for why the second
   * is opt-in and refuses at boot.
   */
  readonly writeMaskMode?: WriteMaskMode;
  /**
   * Accepts knowingly that a document may be marked settled while completed payments do not cover
   * its total. Default (absent) builds the coverage guard. See `--allow-uncovered-settlement`.
   */
  readonly allowUncoveredSettlement?: boolean;
  /** Allocates document numbers for sequence-defaulted fields on create. */
  readonly allocator?: SequenceAllocator;
  /**
   * Absences in this deployment's API description that only this app knows — the paths it
   * serves ahead of route matching. A thunk, read on the first request, because three of the
   * four such mounts happen after this function returns.
   */
  readonly openApiCoverage?: () => readonly OpenApiCoverageGap[];
  /** Backs the `/v1/admin/settings` endpoints + runtime numbering overrides. */
  readonly settingsStore?: SettingsStore;
  /** Resolves the signed-in person's own name and email for the UI-schema viewer. */
  readonly userIdentity?: UiUserIdentityResolver;
  /** Roles permitted to manage tenant settings. */
  readonly adminRoles?: readonly string[];
  /** Optional subscription gate: denies a lapsed tenant (past_due → read-only). */
  readonly entitlementResolver?: EntitlementResolver;
  /** Optional Stripe Billing Portal route (POST /v1/meta/billing-portal). */
  readonly billingPortal?: BillingPortalWiring;
  /** Optional signature-authenticated webhook route handled ahead of the gateway. */
  readonly webhookRoute?: WebhookRoute;
  /** Optional data-residency edge guard: routes/denies by tenant home region before dispatch. */
  readonly regionGuard?: RegionGuardConfig;
  /** Extra after-write effects appended to the defaults (e.g. entity-event → job emission). */
  readonly additionalWriteEffects?: readonly WriteEffect[];
  /** Optional on-demand job invocation route (POST /v1/meta/jobs/invoke). */
  readonly jobInvoker?: JobInvoker;
  /** Roles permitted to call the job-invoke route; omit to leave it open to any tenant principal. */
  readonly jobInvokeRoles?: readonly string[];
  /** Per-action role overrides for the job-invoke route ({action → roles}). */
  readonly jobInvokeActionRoles?: ReadonlyMap<string, ReadonlySet<string>>;
  /** Deployment-injected admin routes (e.g. marketplace pack install), registered ungated. */
  readonly extraRoutes?: readonly ExtraGatewayRoute[];
  /** Whether to believe a request's forwarded facts. Required — see `OperateHttpServerOptions`. */
  readonly edgeTrust: EdgeTrust;
  readonly defaultScheme?: ForwardedProto;
  readonly now?: () => Date;
  readonly idGenerator?: () => string;
  /** Optional live-request observer sink (e.g. the SLO request observer). */
  readonly onExecution?: (execution: PipelineExecution) => void;
  /**
   * Enforce the caller tenant's lifecycle state on every request (ADR-0334). Absent ⇒ no gate, which
   * is what every deployment had: `meta.tenants.status` was a column nothing on the request path
   * read, so a `pending_deletion` tenant went on accepting writes into data about to be destroyed.
   */
  readonly tenantStatusGate?: TenantStatusGateOptions;
  /**
   * The per-request rate-limit decision maker. Absent ⇒ `buildOperateGateway` installs
   * `InMemoryRateLimitChecker` at 10,000/window, which is today's behaviour and persists nothing:
   * `meta.rate_limit_decisions` had a store and no caller, so no deployment has ever written a row.
   */
  readonly rateLimitChecker?: RateLimitChecker;
  /**
   * The gateway's replay guard. Absent ⇒ `buildOperateGateway` installs `InMemoryIdempotencyStore`,
   * which is today's behaviour and is **per process**: a retried `POST` landing on another replica,
   * or on this one after a restart, is not deduplicated — including on the tenant-deletion route,
   * the one route here that requires an idempotency key precisely because a retry mints a second
   * tombstone.
   */
  readonly idempotencyStore?: IdempotencyStore;
  /**
   * Seals the keyset cursors entity lists hand back (ADR-0346), and the mode the boot check is told.
   *
   * Grouped for `abac`'s reason: the sealer and the mode must agree, and they are silently wrong if
   * formed apart — a sealer with mode `absent` would seal cursors while the check refused the boot
   * for not sealing them, and a mode of `sealed` with no sealer would pass the check while serving
   * the disclosure it exists to prevent. `resolveCursorSealing` is the one producer of the pair.
   */
  readonly cursorSealing?: {
    readonly mode: CursorSealingMode;
    readonly sealer: CursorSealer | null;
  };
  /**
   * Where the two **reporting** surveys of this manifest go. Optional, and the absence is a
   * coherent state rather than a drop: a caller that only wants a gateway need not read them.
   *
   * It exists because `TenantGatewayCache` had no channel for a report. Its two callbacks,
   * `onInvalidManifest` and `onBuildRefused`, are both failure-only, which is why ADR-0340's
   * obligation check reaches an operator at all — it **throws**, and the throw is classified into
   * `GATEWAY_BUILD_REFUSAL_KINDS`. A finding that must not refuse had nowhere to be sent, so the
   * sensitive-field and cursor-disclosure surveys stayed at boot and answered for the boot pack
   * only. Both are reachable on every store now.
   *
   * Called **once per compiled manifest**, which is once at boot and once per tenant whose
   * activated manifest is built or rebuilt — not per request. The cache memoises on the manifest
   * hash, so a tenant's report is emitted when their design is activated rather than repeatedly.
   */
  readonly onSurvey?: (report: {
    readonly sensitive: SensitiveFieldSurvey;
    readonly cursorDisclosure: CursorDisclosureDecision;
  }) => void;
  /**
   * The deployment's ABAC policy layer, or absent for none — in which case a manifest declaring an
   * obligation is refused below (ADR-0340).
   *
   * One object rather than three options, because the three must agree and two of the pairings are
   * silently wrong if they can be formed separately. An `evaluator` without its `answerableKeys`
   * leaves this function unable to check that the manifest's obligations are ones the layer can
   * answer, which is the per-key gap ADR-0341 made the boot refusal ask about; and an evaluator
   * without an `attributeDirectory` refuses every obligation, since `dischargeAbac` treats an
   * unresolved attribute set as unanswerable. So `answerableKeys` is required beside the evaluator
   * and the directory is the one genuinely optional member — a policy over no attributes at all
   * (`present` on nothing) is expressible, if useless.
   *
   * `recordBearingKeys` joined them for the same reason: without it this function cannot tell a
   * policy that compares against the record from one that does not, so a manifest putting a record
   * policy on a `create` would compile and deny that grant at every request.
   *
   * `evaluateBatch` is the **second** genuinely optional member, beside the directory, and for the
   * opposite reason to the two required ones: absent, every obligation is still enforced through
   * one call per question, which is what every deployment did before it existed. It can only make
   * the asking cheaper, never the answer different — so there is nothing for its absence to break
   * and nothing to refuse at boot.
   */
  readonly abac?: {
    readonly evaluator: AbacEvaluator;
    /** The policy keys `evaluator` can answer. Checked against the manifest's obligations. */
    readonly answerableKeys: ReadonlySet<string>;
    /** Of those, the keys whose comparison references a field of the record. */
    readonly recordBearingKeys: ReadonlySet<string>;
    /** Answers a whole set of questions at once, for the per-record redaction pass (ADR-0344). */
    readonly evaluateBatch?: AbacBatchEvaluator;
    readonly attributeDirectory?: AbacAttributeDirectory;
  };
  /**
   * Re-consult a session's membership on every request, so revoking one takes effect in seconds
   * rather than at the next login.
   *
   * Supplied iff this deployment mints its own sessions (`--credential-login`), which is **mutually
   * exclusive with `--jwks-url`** — so every Bearer session reaching the check was minted here from
   * a membership this deployment read, which is what makes an absent row a revocation rather than a
   * foreign subject. Its own field and not a member of `abac` above, because the two arrive under
   * different declarations: a deployment with a login and no ABAC policy must still get the check,
   * and that is the shipped compose.
   */
  readonly sessionRevocation?: {
    readonly directory: AbacAttributeDirectory;
    readonly onRefused?: (tenantId: string, userId: string) => void;
  };
  /**
   * The HMAC signing-key lookup, present exactly when this deployment declared `--hmac-key` and
   * holds a usable `REQUEST_SIGNING_SECRET`.
   *
   * Grouped with its tolerance rather than offered as two sibling options, which is ADR-0342's
   * rule: a tolerance with no lookup is a policy over a scheme this deployment does not serve, and
   * the pair is formed from one resolution so it cannot be stated half way. `toleranceSeconds` is
   * optional *within* the group because its absence has a correct answer
   * (`DEFAULT_REQUEST_SIGNATURE_TOLERANCE_SECONDS`) where the lookup's does not.
   */
  /**
   * The enrolled client-certificate registry, present exactly when this deployment declared
   * `--mtls-client` **and** `--trusted-edge-client-cert`.
   *
   * Grouped like `requestSigning` and for its reason: the lookup answers *which principal this
   * certificate is* and the specs are what lets the resolver answer one stage later, so a lookup
   * without the specs is a 401 for a credential that was just accepted. There is no tolerance
   * sibling here because there is nothing to time — the credential is the connection, not a
   * timestamped message.
   */
  readonly mtlsClients?: {
    readonly lookup: MtlsClientLookup;
    readonly clients: readonly MtlsClientSpec[];
  };
  readonly requestSigning?: {
    readonly lookup: HmacKeyLookup;
    /**
     * The specs behind that lookup, so the principal resolver can register who each key is.
     *
     * Both halves in one group rather than two options, because a lookup without the specs is the
     * defect a live run found: the signature verifies, `authPrincipalRef` is set, and
     * `resolve_principal` answers nothing — a 401 one stage after the credential was accepted.
     * Grouped, that state does not typecheck.
     */
    readonly keys: readonly HmacKeySpec[];
    readonly toleranceSeconds?: number;
  };
}

export interface BuiltOperateHttpServer {
  readonly httpServer: OperateHttpServer;
  readonly gateway: OperateServer;
}

/**
 * Composes a resolved manifest + an entity store + an API-key set into a ready
 * `OperateHttpServer`: builds the gateway (routes + handlers + redaction from
 * the manifest) wired to the auth resolver derived from the API keys.
 */
export function buildOperateHttpServer(options: BuildOperateHttpServerOptions): BuiltOperateHttpServer {
  // Before anything is compiled, and here rather than in `node.ts`, because this function is also
  // what compiles a *per-tenant* activated manifest — the same placement that gives a per-tenant
  // gateway the tenant-status gate (ADR-0334). A tenant whose own manifest declares an obligation
  // this deployment cannot discharge gets no gateway, which is the fail-closed answer: ADR-0314's
  // degradation to the JSONB fallback is right for a schema it cannot apply and wrong for an
  // authorization rule it cannot enforce, because serving the rule unenforced is the defect.
  const obligations = checkAbacObligations({
    manifest: options.manifest,
    answerableKeys: options.abac?.answerableKeys ?? new Set(),
    recordBearingKeys: options.abac?.recordBearingKeys ?? new Set(),
    // `absent` when the caller supplied nothing, which is the refusing value: a caller that forgot
    // to resolve the mode must not be read as having sealed the cursors.
    cursorSealing: options.cursorSealing?.mode ?? "absent",
  });
  if (obligations.refusal !== null) throw new AbacObligationsUnevaluable(obligations);

  /*
   * The two surveys that were boot-only, run here for the same reason the obligation check is here:
   * this function is what compiles a **tenant's own activated manifest**, so a check that lives in
   * `serve()` answers for the boot pack and for nothing a tenant ever authored (ADR-0314).
   *
   * The register prescribed `applyTenantManifestSchema` for the sensitive-field half, and that is
   * refuted by measurement: its only caller is built solely under `--store pg-columns`, while the
   * shipped compose is `--store pg`, so the check would have been dark on the deployment that
   * ships. `buildOperateHttpServer` is reached on every store.
   *
   * They **report and never refuse**, which is the one way they differ from the obligation check
   * above, and the asymmetry is the same one those surveys already draw at boot:
   *
   *   - a write-open/read-closed classified field is a *capability* answer — the field is withheld
   *     from readers and writable by whoever holds entity `update` — so a tenant whose manifest
   *     has one still gets a working gateway, and refusing it would take a tenant's whole
   *     deployment away over a declaration they can fix (ADR-0348's split: a property of the
   *     manifest alone belongs to validation, and activation validates);
   *   - a plaintext cursor is `CURSOR_DISCLOSURE_MAY_SERVE`-true on every verdict by construction.
   *
   * `onSurvey` is therefore a **non-failure** channel, which `TenantGatewayCache` did not have:
   * it carried `onInvalidManifest` and `onBuildRefused` and nothing else, both failure-only, so
   * ADR-0340's check only reaches an operator because it *throws*. A report had nowhere to go.
   */
  if (options.onSurvey !== undefined) {
    // Computed only when something reads them, which is `--abac-policy`'s rule (ADR-0341: the
    // producer exists exactly when a consumer does). Not a micro-optimisation: `serve()` surveys
    // the boot manifest itself, before this function is reached, because
    // `--classified-write-mask`'s refusal has to fire before anything is mounted — so running
    // them here unconditionally would survey the boot pack twice and report it once.
    const sensitive = surveySensitiveFields({
      manifest: options.manifest,
      // `?? (() => undefined)` is the empty policy, not a skip: with no declaration every
      // sensitive field is unreadable by every role, which is exactly the state ADR-0339 measured
      // on 39 of 46 and is the finding worth reporting rather than a reason to report nothing.
      policyForEntity: options.policyForEntity ?? ((): undefined => undefined),
      roles: Object.keys(options.manifest.roles ?? {}),
      classifiedWriteMask: options.writeMaskMode === "classified",
    });
    const cursorDisclosure = decideCursorDisclosure({
      mode: options.cursorSealing?.mode ?? "absent",
      fields: surveySortableClassifiedFields(options.manifest),
    });
    options.onSurvey({ sensitive, cursorDisclosure });
  }

  // The hmac specs reach the wiring as well as the lookup, and the two halves are separate for a
  // stated reason: `requestSigning.lookup` answers *which key verifies this signature* and lives in
  // `request-signing.ts` beside the derivation, while the resolver answers *who that key is* and
  // belongs with every other principal. Passing only the first is the state a live run found —
  // signature verified, then 401 `principal_not_found` one stage later.
  const wiring = buildPrincipalWiring(options.apiKeys, {
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.requestSigning !== undefined ? { hmacKeys: options.requestSigning.keys } : {}),
    ...(options.mtlsClients !== undefined ? { mtlsClients: options.mtlsClients.clients } : {}),
  });
  // Decorated here rather than inside `buildPrincipalWiring`: the directory needs a connection and
  // this is the seam that already takes deployment-supplied collaborators, so the api-key and JWT
  // paths both get attributes from one wrap instead of two.
  const withAttributes =
    options.abac?.attributeDirectory !== undefined
      ? withAbacAttributes(wiring.principalResolver, options.abac.attributeDirectory)
      : wiring.principalResolver;
  /*
   * The revocation check wraps **outside** the attribute decoration.
   *
   * **Both clauses of what this comment used to claim for that are false**, measured by running the
   * built modules and counting the directory calls (ADR-0398). It read *"so a refused principal is
   * refused before anything is attached to it — and the inner `attributesFor` it then never reaches
   * costs nothing"*. An outer wrapper's `resolve` calls the inner one **first**, so the attribute
   * decoration runs, `attributesFor` is called, the attributes are attached, and only then does the
   * revocation check look — and call `attributesFor` a second time. Shipped order: two calls, the
   * second a cache hit. Reversed: one. Nothing is "never reached"; it is reached first.
   *
   * Reversing it would be strictly better — one directory call, and `withAbacAttributes`' refusal
   * pass-through arm would stop being dead code — and it is deliberately **not** done here, because
   * the ordering is latent (it needs `--abac-policy` *and* `--credential-login` together) and a
   * composition change argued from a corrected comment deserves its own increment rather than
   * riding on one. Recorded as an open question instead.
   *
   * Two declarations and not one: the directory arrives under `--abac-policy` and the gate under
   * `--credential-login`, so a deployment can have either, both or neither. `sessionRevocation`
   * carries its own directory for that reason rather than reading `options.abac` — a deployment with
   * a login and no ABAC policy must still get the check, and that is the shipped compose.
   */
  const principalResolver =
    options.sessionRevocation !== undefined
      ? withMembershipRevocationCheck(
          withAttributes,
          options.sessionRevocation.directory,
          options.sessionRevocation.onRefused,
        )
      : withAttributes;
  const gateway = buildOperateGateway(options.manifest, {
    store: options.store,
    principalRoles: wiring.principalRoles,
    principalResolver,
    opaqueTokenLookup: wiring.opaqueTokenLookup,
    ...(options.mtlsClients !== undefined
      ? { mtlsClientLookup: options.mtlsClients.lookup }
      : {}),
    ...(options.requestSigning !== undefined
      ? {
          hmacKeyLookup: options.requestSigning.lookup,
          ...(options.requestSigning.toleranceSeconds !== undefined
            ? { requestSignatureToleranceSeconds: options.requestSigning.toleranceSeconds }
            : {}),
        }
      : {}),
    ...(options.jwt !== undefined
      ? {
          jwksProvider: options.jwt.jwksProvider,
          jwtIssuer: options.jwt.issuer,
          jwtAudience: options.jwt.audience,
          requiredJwtClaims: options.jwt.requiredClaims,
        }
      : {}),
    ...(options.allocator !== undefined ? { allocator: options.allocator } : {}),
    ...(options.openApiCoverage !== undefined
      ? { openApiCoverage: options.openApiCoverage }
      : {}),
    ...(options.settingsStore !== undefined ? { settingsStore: options.settingsStore } : {}),
    ...(options.userIdentity !== undefined ? { userIdentity: options.userIdentity } : {}),
    // `as readonly RoleName[]` and not `as never`: the widening from `readonly string[]` needs a
    // cast because `RoleName` is branded, and `as never` accepts *any* type at all — so it would
    // have validated nothing if this field's type ever changed, which is ADR-0362's
    // annotation-standing-in-for-a-check in the forwarding literal for precisely this field.
    ...(options.adminRoles !== undefined
      ? { adminRoles: options.adminRoles as readonly RoleName[] }
      : {}),
    ...(options.entitlementResolver !== undefined ? { entitlementResolver: options.entitlementResolver } : {}),
    ...(options.billingPortal !== undefined ? { billingPortal: options.billingPortal } : {}),
    ...(options.additionalWriteEffects !== undefined ? { additionalWriteEffects: options.additionalWriteEffects } : {}),
    ...(options.jobInvoker !== undefined ? { jobInvoker: options.jobInvoker } : {}),
    ...(options.jobInvokeRoles !== undefined ? { jobInvokeRoles: options.jobInvokeRoles as never } : {}),
    ...(options.jobInvokeActionRoles !== undefined ? { jobInvokeActionRoles: options.jobInvokeActionRoles } : {}),
    ...(options.extraRoutes !== undefined ? { extraRoutes: options.extraRoutes } : {}),
    ...(options.rateLimitChecker !== undefined ? { rateLimitChecker: options.rateLimitChecker } : {}),
    ...(options.idempotencyStore !== undefined ? { idempotencyStore: options.idempotencyStore } : {}),
    ...(options.policyForEntity !== undefined ? { policyForEntity: options.policyForEntity } : {}),
    ...(options.writeMaskMode !== undefined ? { writeMaskMode: options.writeMaskMode } : {}),
    ...(options.allowUncoveredSettlement !== undefined
      ? { allowUncoveredSettlement: options.allowUncoveredSettlement }
      : {}),
    ...(options.abac !== undefined ? { abacEvaluator: options.abac.evaluator } : {}),
    ...(options.abac?.evaluateBatch !== undefined
      ? { abacBatchEvaluator: options.abac.evaluateBatch }
      : {}),
    ...(options.cursorSealing?.sealer != null
      ? { cursorSealer: options.cursorSealing.sealer }
      : {}),
    ...(options.now !== undefined ? { clock: { now: options.now } } : {}),
  });
  // After every registration and before the first request. The gate goes on the registry rather than
  // on each `register` call because that is the only way it is *total*: `operationIds()` is the whole
  // surface — manifest CRUD, lifecycle transitions, associations, the meta routes and every injected
  // `extraRoutes` entry — and a decorator applied per call site covers the ones somebody remembered.
  // `GatewayRuntime` resolves a handler per request from this same registry, so replacing entries
  // after it was constructed takes effect.
  if (options.tenantStatusGate !== undefined) {
    applyTenantStatusGate(gateway.handlers, options.tenantStatusGate);
  }
  const httpServer = new OperateHttpServer({
    gateway,
    edgeTrust: options.edgeTrust,
    ...(options.webhookRoute !== undefined ? { webhookRoute: options.webhookRoute } : {}),
    ...(options.regionGuard !== undefined ? { regionGuard: options.regionGuard } : {}),
    ...(options.defaultScheme !== undefined ? { defaultScheme: options.defaultScheme } : {}),
    ...(options.idGenerator !== undefined ? { idGenerator: options.idGenerator } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.onExecution !== undefined ? { onExecution: options.onExecution } : {}),
  });
  return { httpServer, gateway };
}
