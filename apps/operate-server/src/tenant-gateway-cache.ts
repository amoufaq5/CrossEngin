import { ManifestSchema, tryValidateManifest, type Manifest } from "@crossengin/kernel/manifest";

import type { RawHttpRequest, RawHttpResponse } from "./http.js";
import type { ApiKeySpec } from "./principals.js";
import type { OperateHttpServer } from "./server.js";

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_REFUSAL_RETRY_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 1_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GATEWAY_UNAVAILABLE_TYPE = "https://crossengin.io/problems/tenant-gateway-unavailable";

function headerValue(headers: RawHttpRequest["headers"], name: string): string | null {
  const lower = name.toLowerCase();
  for (const [key, raw] of Object.entries(headers)) {
    if (key.toLowerCase() !== lower) continue;
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value !== undefined && value !== "") return value;
  }
  return null;
}

function requestToken(raw: RawHttpRequest): string | null {
  const apiKey = headerValue(raw.headers, "x-api-key");
  if (apiKey !== null) return apiKey;
  const auth = headerValue(raw.headers, "authorization");
  if (auth === null) return null;
  const match = /^bearer\s+(.+)$/i.exec(auth);
  const token = match?.[1]?.trim();
  return token === undefined || token === "" ? null : token;
}

/**
 * Resolves the tenant an incoming raw request belongs to. The authenticated
 * credential is authoritative: a registered API key token (`x-api-key` or
 * `authorization: Bearer <token>`) resolves to its bound tenant. The spoofable
 * `x-tenant-id` header is honored only for requests carrying a Bearer
 * credential the key set does not know (a JWT, whose tenant the gateway's
 * P1.18 cross-check will verify against the claim) and only when it is a
 * canonical UUID — so an unauthenticated flood of random tenant headers never
 * reaches the manifest source or the cache.
 */
export function resolveRequestTenant(raw: RawHttpRequest, apiKeys: readonly ApiKeySpec[]): string | null {
  const token = requestToken(raw);
  if (token !== null) {
    const spec = apiKeys.find((k) => k.key === token);
    if (spec !== undefined) return spec.tenantId;
  }
  const bearer = headerValue(raw.headers, "authorization");
  if (bearer === null || !/^bearer\s/i.test(bearer)) return null;
  const hint = headerValue(raw.headers, "x-tenant-id");
  if (hint === null || !UUID_RE.test(hint)) return null;
  return hint.toLowerCase();
}

/**
 * Why a tenant's own manifest parsed, validated, and still could not be compiled into a gateway.
 *
 * `unknown` is a member rather than a fall-through, so the map below has no hole: a throw this
 * module does not recognise has to be *classified* somewhere, and naming it makes the
 * classification visible instead of leaving it to whichever branch a condition ended on.
 */
export const GATEWAY_BUILD_REFUSAL_KINDS = [
  "abac_obligation_unevaluable",
  "column_encryption_unavailable",
  "unknown",
] as const;

export type GatewayBuildRefusalKind = (typeof GATEWAY_BUILD_REFUSAL_KINDS)[number];

/**
 * Whether each refusal is permanent, and so whether it may be memoised.
 *
 * A total map rather than a predicate over the caught error, so a fourth refusal kind is a compile
 * error here instead of silently inheriting one of the two answers — the repo's
 * `PHI_VERDICT_MAY_SERVE` / `CURSOR_DISCLOSURE_MAY_SERVE` idiom.
 *
 * Both permanent members are refusals this repo built *deliberately*: `AbacObligationsUnevaluable`
 * is thrown by `buildOperateHttpServer` for a manifest declaring an obligation this deployment
 * cannot discharge (ADR-0340), and `ColumnEncryptionUnavailable` by `ColumnMappedEntityStore`'s
 * constructor for a classified field with no key (ADR-0338). Neither clears without an operator
 * changing the *deployment*, so rebuilding on every request buys nothing but the work.
 *
 * The genuinely degradable cause never arrives here at all: `UndecidedColumnTypeError` is converted
 * by `applyTenantManifestSchema` into a *returned* refusal that the store registry memoises
 * (ADR-0314). So the one cause the old "a provisioning failure is usually transient" reading would
 * have been right about is the one already handled a layer down, and `unknown` — which is what is
 * left of that reading — stays uncached precisely because nothing is known about it.
 */
export const GATEWAY_BUILD_REFUSALS: Record<
  GatewayBuildRefusalKind,
  { readonly permanent: boolean }
> = {
  abac_obligation_unevaluable: { permanent: true },
  column_encryption_unavailable: { permanent: true },
  unknown: { permanent: false },
};

/** `Error.name` → refusal kind. The only mapping; see `refusalKindOf`. */
const REFUSAL_BY_ERROR_NAME: Readonly<Record<string, GatewayBuildRefusalKind>> = {
  AbacObligationsUnevaluable: "abac_obligation_unevaluable",
  ColumnEncryptionUnavailable: "column_encryption_unavailable",
};

/**
 * The refusal kind a caught build failure belongs to.
 *
 * **This is the weak link in the mechanism, which is why it sits in exactly one place.** The
 * classification is by `Error.name` and not `instanceof`: both classes set `this.name` in their
 * constructors, while an `instanceof` across a package boundary is defeated by two resolutions of
 * one module through `dist/` — an ordinary condition in this workspace rather than a corner case.
 * The containment is the *direction* of the failure it can have: renaming either class
 * reclassifies its refusal as `unknown`, and `unknown` is transient, so a missed match costs a
 * rebuild per request and can never produce a memoised wrong answer.
 */
function refusalKindOf(err: unknown): GatewayBuildRefusalKind {
  const name = err instanceof Error ? err.name : "";
  return REFUSAL_BY_ERROR_NAME[name] ?? "unknown";
}

/**
 * What this cache can answer about one tenant. The three arms exist because `null` meant two
 * different things and they must not share an answer: *this tenant has no manifest of their own*
 * is the per-tenant-manifest feature working, and *this tenant's manifest cannot be served* is a
 * refusal. Collapsed into one value, the second was served as the first.
 */
export type GatewayResolution =
  | { readonly kind: "server"; readonly server: OperateHttpServer }
  | { readonly kind: "none" }
  | {
      readonly kind: "refused";
      readonly reason: GatewayBuildRefusalKind;
      /** Seconds to advertise as `Retry-After` — this cache's own refusal window, not a guess. */
      readonly retryAfterSeconds: number;
    };

export interface TenantGatewayCacheOptions {
  source: { activeManifestFor(tenantId: string): Promise<Record<string, unknown> | null> };
  /**
   * Compiles the tenant's gateway. It receives the tenant id, and may be async, because a build
   * can have to *provision* before it can serve: the per-tenant column store applies this
   * manifest's DDL to that tenant's own schema first. A build that throws yields a `refused`
   * resolution, which the caller answers rather than papering over — see `GATEWAY_BUILD_REFUSALS`
   * for which refusals are then memoised.
   */
  build: (manifest: Manifest, tenantId: string) => OperateHttpServer | Promise<OperateHttpServer>;
  ttlMs?: number;
  now?: () => number;
  /** A stored manifest that fails `ManifestSchema` or kernel cross-validation. */
  onInvalidManifest?: (tenantId: string, issues: readonly string[]) => void;
  /**
   * A manifest that passed both gates and could not be compiled. Separate from
   * `onInvalidManifest` because the old shared callback's sentence was *false* for this case —
   * the manifest is valid — and so was its implied remedy: nothing about the manifest needs
   * editing, the deployment needs configuring. `detail` carries the thrown message for the log
   * and must never reach a response; see `gatewayUnavailableProblem`.
   */
  onBuildRefused?: (tenantId: string, kind: GatewayBuildRefusalKind, detail: string) => void;
  /**
   * How long a permanent build refusal is remembered before the build is retried (default 60s).
   * Copied from `TenantColumnStoreRegistry`, including the figure, because it answers the same
   * question about the same tenant one layer up: a refusal is memoised at all so a tenant whose
   * deployment cannot serve their manifest does not re-run a DDL application and a full compile on
   * every request, and it *expires* so an operator who fixes the deployment is picked up without a
   * restart. What is deliberately **not** copied is that registry's `POSITIVE_INFINITY` for a
   * success: a compiled gateway here still expires on `ttlMs`, which is how an activation on
   * another replica is noticed at all.
   */
  refusalRetryMs?: number;
  /** Hard cap on cached entries; the oldest entry is evicted at capacity (default 1000). */
  maxEntries?: number;
}

interface CacheEntry {
  readonly resolution: GatewayResolution;
  readonly expiresAt: number;
}

/**
 * A TTL cache of per-tenant compiled `OperateHttpServer`s built from each tenant's stored active
 * manifest, answering a three-way `GatewayResolution` per tenant.
 *
 * A tenant with no stored manifest, or one that fails `ManifestSchema` or kernel
 * cross-validation, resolves `none` and is cached until ttl expiry — the caller falls back to the
 * deployment's gateway, which is the per-tenant-manifest feature behaving as designed. A manifest
 * that passes both gates and cannot be *compiled* resolves `refused`, which the caller answers
 * rather than falling back: serving a tenant the deployment's entities, roles and permissions is
 * not a degraded form of serving their own, and on the shipped `--store pg` the fallback store is
 * the same object holding the same `(tenant_id, entity, record_id)` rows, so it is the tenant's
 * own data under somebody else's rules.
 *
 * A source throw resolves `none` for that call only and is NOT cached, so the next request retries
 * the source: unlike a build refusal there is nothing in hand to refuse *from* — whether this
 * tenant even has a manifest is unknown.
 */
export class TenantGatewayCache {
  private readonly source: TenantGatewayCacheOptions["source"];
  private readonly build: TenantGatewayCacheOptions["build"];
  private readonly ttlMs: number;
  private readonly refusalRetryMs: number;
  private readonly now: () => number;
  private readonly onInvalidManifest: ((tenantId: string, issues: readonly string[]) => void) | null;
  private readonly onBuildRefused:
    | ((tenantId: string, kind: GatewayBuildRefusalKind, detail: string) => void)
    | null;
  private readonly maxEntries: number;
  private readonly entries = new Map<string, CacheEntry>();

  constructor(opts: TenantGatewayCacheOptions) {
    this.source = opts.source;
    this.build = opts.build;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.refusalRetryMs = opts.refusalRetryMs ?? DEFAULT_REFUSAL_RETRY_MS;
    this.now = opts.now ?? Date.now;
    this.onInvalidManifest = opts.onInvalidManifest ?? null;
    this.onBuildRefused = opts.onBuildRefused ?? null;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  async serverFor(tenantId: string): Promise<GatewayResolution> {
    const cached = this.entries.get(tenantId);
    if (cached !== undefined && cached.expiresAt > this.now()) return cached.resolution;

    let stored: Record<string, unknown> | null;
    try {
      stored = await this.source.activeManifestFor(tenantId);
    } catch {
      // A source failure is transient *and* leaves nothing to refuse from — it is not known
      // whether this tenant has a manifest at all — so it falls back for this call without being
      // cached, and the next request re-asks the source.
      return { kind: "none" };
    }
    if (stored === null) return this.remember(tenantId, { kind: "none" });

    const parsed = ManifestSchema.safeParse(stored);
    if (!parsed.success) {
      this.reportInvalid(
        tenantId,
        parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      );
      return this.remember(tenantId, { kind: "none" });
    }
    const validated = tryValidateManifest(parsed.data);
    if (!validated.ok) {
      this.reportInvalid(
        tenantId,
        validated.errors.map((err) => `${err.path}: ${err.message}`),
      );
      return this.remember(tenantId, { kind: "none" });
    }
    let built: OperateHttpServer;
    try {
      built = await this.build(parsed.data, tenantId);
    } catch (err) {
      // ORDERING, which is the one thing here that must not be got wrong: the refusal above —
      // `refused` instead of a fallback — has to land *before* or *with* this memo, never after.
      // Memoising a refusal while the caller still falls back extends the wrong answer from one
      // request to a whole retry window, which is exactly what the previous "not cached, because a
      // provisioning failure is usually transient" comment was protecting against. In that narrow
      // sense the uncached version was the lesser of the two bugs, and the memo is only safe
      // because the caller now refuses.
      const reason = refusalKindOf(err);
      this.reportBuildRefused(tenantId, reason, err instanceof Error ? err.message : String(err));
      return this.remember(tenantId, this.refusal(reason));
    }
    return this.remember(tenantId, { kind: "server", server: built });
  }

  invalidate(tenantId: string): void {
    this.entries.delete(tenantId);
  }

  invalidateAll(): void {
    this.entries.clear();
  }

  /** A refusal carrying the window this cache will actually hold it for. */
  private refusal(reason: GatewayBuildRefusalKind): GatewayResolution {
    return {
      kind: "refused",
      reason,
      retryAfterSeconds: Math.max(1, Math.ceil(this.refusalRetryMs / 1_000)),
    };
  }

  private remember(tenantId: string, resolution: GatewayResolution): GatewayResolution {
    // The permanence decision lives here and nowhere else, so no call site can memoise a refusal
    // it was not entitled to: a transient one is returned unremembered, on the source-throw arm's
    // rule that nothing known about *why* means the next request must re-ask rather than inherit a
    // guess.
    if (resolution.kind === "refused" && !GATEWAY_BUILD_REFUSALS[resolution.reason].permanent) {
      return resolution;
    }
    if (!this.entries.has(tenantId) && this.entries.size >= this.maxEntries) {
      const nowMs = this.now();
      for (const [key, entry] of this.entries) {
        if (entry.expiresAt <= nowMs) this.entries.delete(key);
      }
      if (this.entries.size >= this.maxEntries) {
        const oldest = this.entries.keys().next().value;
        if (oldest !== undefined) this.entries.delete(oldest);
      }
    }
    // Derived from the resolution rather than passed in, for the same reason: a refusal cannot end
    // up stored under the serving TTL, which would make the retry window depend on the call site.
    const lifetimeMs = resolution.kind === "refused" ? this.refusalRetryMs : this.ttlMs;
    this.entries.set(tenantId, { resolution, expiresAt: this.now() + lifetimeMs });
    return resolution;
  }

  private reportInvalid(tenantId: string, issues: readonly string[]): void {
    if (this.onInvalidManifest !== null) this.onInvalidManifest(tenantId, issues);
  }

  private reportBuildRefused(
    tenantId: string,
    kind: GatewayBuildRefusalKind,
    detail: string,
  ): void {
    if (this.onBuildRefused !== null) this.onBuildRefused(tenantId, kind, detail);
  }
}

/**
 * The 503 for a tenant whose own gateway could not be built.
 *
 * **503 and not 403.** ADR-0334 settled this split for `--tenant-status-gate`: a state that
 * *forbids* the request is 403, a state that could not be *established* is 503, because a 403 is a
 * claim about the tenant and there is none in hand. Here there is no authorization answer of any
 * kind — the gateway that would produce one does not exist. Not 404, which would say this route is
 * not served while the tenant's own manifest says it is. Not 500, because nothing failed in *this*
 * request.
 *
 * The status deliberately does not encode permanence, and permanent and transient get the same
 * one: the client's correct action is identical either way, the remedy is an operator action
 * picked up with no client change, and `ManifestActivationPoller` can invalidate mid-flight — so
 * "retry shortly" is frequently true even for a cause that is permanent right now.
 *
 * The body names the tenant and the refusal **kind** and nothing else; `err.message` must never
 * reach it. `AbacObligationsUnevaluable` names entities, fields and policy keys and
 * `ColumnEncryptionUnavailable` enumerates classified column labels, so the detail that makes the
 * log useful is exactly the detail a caller may not have — it goes to `onBuildRefused` instead.
 *
 * Constructed here rather than through the pipeline, following `regionProblem` in `server.ts`,
 * which refuses pre-auth the same way: there is no compiled gateway to route this through.
 */
function gatewayUnavailableProblem(
  tenantId: string,
  refusal: Extract<GatewayResolution, { kind: "refused" }>,
): RawHttpResponse {
  const body = new TextEncoder().encode(
    JSON.stringify({
      type: GATEWAY_UNAVAILABLE_TYPE,
      title: "Workspace gateway unavailable",
      status: 503,
      detail:
        "This workspace's own configuration could not be served, and the request was not run. " +
        "No substitute configuration was used.",
      tenantId,
      reason: refusal.reason,
    }),
  );
  return {
    status: 503,
    headers: {
      "content-type": "application/problem+json",
      "content-length": body.byteLength.toString(),
      // One number, taken from the cache's own refusal window, so the client's backoff and the
      // server's retry are not two independent guesses. For a *transient* refusal nothing is
      // cached and the very next request rebuilds, so the server retries sooner than this
      // advertises — the safe direction for a hint, since over-stating it cannot produce a hot
      // loop and under-stating it can (ADR-0327's `Retry-After: 0` floor, one layer out).
      "retry-after": refusal.retryAfterSeconds.toString(),
    },
    body,
  };
}

/**
 * Wraps a default dispatch with per-tenant routing: the request's tenant is resolved
 * (`resolveRequestTenant`), that tenant's resolution is looked up in the cache, and the request
 * dispatches to their own compiled server.
 *
 * It falls back to the default dispatch for `none` — no tenant resolved, or this tenant has no
 * manifest of their own — and **refuses** a `refused` resolution, because the two are not degrees
 * of one thing. A tenant with no manifest of their own is correctly served the deployment's; a
 * tenant whose manifest cannot be compiled would be served somebody else's *rules* over their own
 * rows, with their field grants, their classification and redaction, and the very ABAC obligation
 * that caused the refusal all simply absent. `server.ts` already calls that out as the defect for
 * the obligation case — "serving the rule unenforced is the defect" — and this is where the word
 * is kept.
 */
export function buildPerTenantDispatch(opts: {
  defaultDispatch: (raw: RawHttpRequest, body: Uint8Array | null) => Promise<RawHttpResponse>;
  cache: TenantGatewayCache;
  apiKeys: readonly ApiKeySpec[];
}): (raw: RawHttpRequest, body: Uint8Array | null) => Promise<RawHttpResponse> {
  return async (raw: RawHttpRequest, body: Uint8Array | null): Promise<RawHttpResponse> => {
    const tenantId = resolveRequestTenant(raw, opts.apiKeys);
    if (tenantId === null) return opts.defaultDispatch(raw, body);
    const resolved = await opts.cache.serverFor(tenantId);
    // Switched rather than tested for a sentinel, so a fourth resolution arm fails to compile here
    // instead of taking whichever branch the chain ended on — which, for `null`, was the fallback.
    switch (resolved.kind) {
      case "server":
        return resolved.server.dispatch(raw, body);
      case "refused":
        return gatewayUnavailableProblem(tenantId, resolved);
      case "none":
        return opts.defaultDispatch(raw, body);
    }
  };
}
