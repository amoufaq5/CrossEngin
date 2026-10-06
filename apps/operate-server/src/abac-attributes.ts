import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import type { PrincipalResolver, PrincipalResolverInput } from "@crossengin/api-gateway-runtime";
import { DEFAULT_MAX_STALE_MS } from "./tenant-status-gate.js";

/**
 * The attribute source ADR-0340 left as its own Q1: `meta.user_tenant_membership.abac_attributes`
 * on the request path.
 *
 * That column has carried `JSONB NOT NULL DEFAULT '{}'::jsonb` since Phase 1 and has had a writer
 * *and* a reader since ADR-0335 (`--platform-user-routes`), so ADR-0339's claim that closing this
 * needed an attribute source was wrong — what was missing is the wire. Five non-test sites hardcode
 * `Principal.abacAttributes` to `{}`; this module is what lets them read a fact instead.
 *
 * ## `null` is a different fact from `{}`, and the whole module turns on it
 *
 * `@crossengin/auth`'s `Principal.abacAttributes` is `Readonly<Record<string, unknown>> | null`
 * where `null` means **no directory was consulted** and `{}` asserts **this principal has no
 * attributes**, and `dischargeAbac` refuses an obligation on `null` without calling the evaluator
 * precisely because an evaluator cannot tell the two apart. So this directory answers `null` for
 * every path where nothing was gathered, and `withAbacAttributes` leaves the field **absent** rather
 * than setting `{}` — an absent field the caller maps to `null`, which fails closed. A `{}` that
 * came back from a real read is passed through unchanged, because then it *is* the answer: an active
 * membership whose attribute record is empty.
 *
 * ## No SQL here
 *
 * `PostgresUserStore.membershipFor` already reads this row, already runs inside `withTenantContext`
 * and already binds the strict `scopeFilter` beside it — `meta.user_tenant_membership` carries one
 * `ALL`-scope isolation policy with no platform arm, and a table's owner bypasses its policies
 * (ADR-0333). A second spelling of that read is the defect class this repo keeps sweeping out, so
 * this module takes a reader interface and writes no statement of its own.
 */

/**
 * What a principal's ABAC attributes are, as far as the request path is concerned.
 *
 * `null` means **no active membership**, so nothing was resolved for this principal — distinct from
 * `{}`, which is an active membership carrying no attributes. A lookup that *fails* is an exception,
 * and the two are handled asymmetrically by every caller below.
 */
export interface AbacAttributeDirectory {
  attributesFor(
    tenantId: string,
    userId: string,
  ): Promise<Readonly<Record<string, unknown>> | null>;
}

/** The subset of `PostgresUserStore` a directory reads. */
export interface MembershipAttributeReader {
  membershipFor(
    tenantId: string,
    userId: string,
  ): Promise<{
    readonly status: string;
    readonly abacAttributes: Readonly<Record<string, unknown>>;
  } | null>;
}

/**
 * `user_tenant_membership_status_check`'s one value that grants access now.
 *
 * `invited` promises access and `revoked` withdrew it; neither supplies attributes, and the filter
 * is `recipient-resolver.ts`'s `m.status = 'active'` read at a different layer. `status` is typed
 * `string` on the reader rather than the `MembershipStatus` enum so the comparison is total by
 * construction: a fourth value added to the CHECK by hand is not active, which is the safe answer
 * without this module having to know the vocabulary.
 */
export const ACTIVE_MEMBERSHIP_STATUS = "active";

/**
 * The directory over the one existing reader of `meta.user_tenant_membership`.
 *
 * The status filter lives **here** rather than as a second query with `AND status = 'active'`:
 * `membershipFor` returns every status by design — `buildMembershipTransitionHandler` needs the
 * current one to gate its transition — and narrowing it would break that caller to save this one a
 * comparison.
 */
export function abacAttributeDirectoryFromStore(
  store: MembershipAttributeReader,
): AbacAttributeDirectory {
  return {
    async attributesFor(
      tenantId: string,
      userId: string,
    ): Promise<Readonly<Record<string, unknown>> | null> {
      const membership = await store.membershipFor(tenantId, userId);
      if (membership === null) return null;
      if (membership.status !== ACTIVE_MEMBERSHIP_STATUS) return null;
      return membership.abacAttributes;
    },
  };
}

export interface CachedAbacAttributeDirectoryOptions {
  /**
   * How long a resolved attribute record is served without re-reading. An attribute set changes when
   * an operator re-grants a membership, so a per-request query would be paid on every request for a
   * value that is almost always the same one — and this read sits in the auth stage, so without a
   * cache its rate *is* the request rate.
   */
  readonly ttlMs?: number;
  /**
   * How long an **absence** is served. Shorter than `ttlMs`, and deliberately a separate figure: the
   * two mistakes are not symmetric. Stale attributes delay a policy change by the TTL; a stale
   * absence goes on refusing a principal whose membership an operator has just granted — and under
   * ADR-0340 an unresolved attribute set makes every obligation `undischargeable`, so the refusal is
   * total rather than partial.
   */
  readonly absenceTtlMs?: number;
  /**
   * How long a value already past its TTL may be served when the refresh **fails**. Serving the last
   * known answer through a database blip is right — "we knew a minute ago" is real evidence — but it
   * cannot mean forever: a revoked membership whose row nobody can re-read would otherwise go on
   * supplying attributes for as long as the outage lasts.
   */
  readonly maxStaleMs?: number;
  readonly now?: () => Date;
  /**
   * Called when a refresh throws, with whether the stale value was served.
   *
   * Not in the dictated surface and added for one reason: without it a stale serve is silent, and a
   * degradation nobody announces is the shape of defect this repo keeps finding. `withAbacAttributes`
   * itself never swallows, so this is the only place a *survived* failure can be reported from.
   */
  readonly onRefreshError?: (
    tenantId: string,
    userId: string,
    err: unknown,
    servedStale: boolean,
  ) => void;
}

export const DEFAULT_ABAC_TTL_MS = 30_000;
export const DEFAULT_ABAC_ABSENCE_TTL_MS = 5_000;
/**
 * The same bound as the tenant-status directory's, **imported** rather than restated: both answer
 * how long a cached authorization input may outlive the database that produced it, and two copies
 * of one figure drift apart at the first tuning.
 */
export const DEFAULT_ABAC_MAX_STALE_MS = DEFAULT_MAX_STALE_MS;

interface CacheEntry {
  readonly attributes: Readonly<Record<string, unknown>> | null;
  readonly readAtMs: number;
}

/**
 * The cache key is **both** ids, and that is not an optimisation.
 *
 * One person legitimately holds a membership in several tenants with different attributes in each —
 * the unique constraint is `(user_id, tenant_id)` — so a key of the user id alone would serve one
 * tenant's attributes for them in another, which under multi-tenancy is a cross-tenant disclosure
 * feeding an authorization decision. The separator is NUL so no pair of ids can compose another
 * pair's key.
 */
function cacheKey(tenantId: string, userId: string): string {
  return `${tenantId}\u0000${userId}`;
}

/**
 * A TTL cache in front of a directory, with the two failure modes separated.
 *
 * A **first** lookup that throws propagates: nothing was ever known about this principal and a guess
 * in either direction is wrong — attributes invented would be an allow nobody gathered, and `null`
 * invented would be an `undischargeable` nobody measured. A **refresh** that throws serves the last
 * known answer until `maxStaleMs`, then propagates. `CachedTenantStatusDirectory`'s structure, for
 * the same reasons at the same point in the request.
 */
export class CachedAbacAttributeDirectory implements AbacAttributeDirectory {
  private readonly inner: AbacAttributeDirectory;
  private readonly entries: Map<string, CacheEntry> = new Map();
  private readonly inflight: Map<string, Promise<Readonly<Record<string, unknown>> | null>> =
    new Map();
  private readonly ttlMs: number;
  private readonly absenceTtlMs: number;
  private readonly maxStaleMs: number;
  private readonly now: () => Date;
  private readonly onRefreshError:
    | ((t: string, u: string, e: unknown, s: boolean) => void)
    | null;

  constructor(inner: AbacAttributeDirectory, opts: CachedAbacAttributeDirectoryOptions = {}) {
    this.inner = inner;
    this.ttlMs = opts.ttlMs ?? DEFAULT_ABAC_TTL_MS;
    this.absenceTtlMs = opts.absenceTtlMs ?? DEFAULT_ABAC_ABSENCE_TTL_MS;
    this.maxStaleMs = opts.maxStaleMs ?? DEFAULT_ABAC_MAX_STALE_MS;
    this.now = opts.now ?? ((): Date => new Date());
    this.onRefreshError = opts.onRefreshError ?? null;
  }

  private ttlFor(attributes: Readonly<Record<string, unknown>> | null): number {
    return attributes === null ? this.absenceTtlMs : this.ttlMs;
  }

  async attributesFor(
    tenantId: string,
    userId: string,
  ): Promise<Readonly<Record<string, unknown>> | null> {
    const key = cacheKey(tenantId, userId);
    const nowMs = this.now().getTime();
    const cached = this.entries.get(key);
    if (cached !== undefined && nowMs - cached.readAtMs < this.ttlFor(cached.attributes)) {
      return cached.attributes;
    }
    // Concurrent requests for one principal share a single read. Without this, a cold cache under
    // load issues one query per in-flight request for the same answer — and this runs in the auth
    // stage, so that is the whole request rate for that credential.
    const existing = this.inflight.get(key);
    if (existing !== undefined) return existing;
    const promise = this.refresh(tenantId, userId, key, cached, nowMs).finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, promise);
    return promise;
  }

  private async refresh(
    tenantId: string,
    userId: string,
    key: string,
    cached: CacheEntry | undefined,
    nowMs: number,
  ): Promise<Readonly<Record<string, unknown>> | null> {
    try {
      const attributes = await this.inner.attributesFor(tenantId, userId);
      this.entries.set(key, { attributes, readAtMs: this.now().getTime() });
      return attributes;
    } catch (err) {
      const servable = cached !== undefined && nowMs - cached.readAtMs <= this.maxStaleMs;
      this.onRefreshError?.(tenantId, userId, err, servable);
      if (servable) return cached.attributes;
      throw err;
    }
  }

  /** Test/diagnostic seam: forget everything, so the next lookup re-reads. */
  clear(): void {
    this.entries.clear();
  }
}

/**
 * A `ResolvedPrincipal` carrying the attributes a directory resolved for it.
 *
 * `ResolvedPrincipal` declares `abacAttributes?` with these exact semantics — **absent means not
 * resolved** — so this is a narrowing alias rather than a second spelling, and it exists to name the
 * post-decoration state at the one place that produces it. Stated as an intersection so this module
 * compiles against a `@crossengin/api-gateway` built either side of that field's addition; it
 * collapses to `ResolvedPrincipal`.
 */
export type PrincipalWithAbacAttributes = ResolvedPrincipal & {
  readonly abacAttributes?: Readonly<Record<string, unknown>>;
};

/**
 * Whether a principal kind names a **person** who could hold a membership row.
 *
 * A total map rather than a `!== "service_account"` comparison, so a fifth kind is a compile error
 * instead of a kind inheriting whichever answer the comparison happened to give it. `service_account`
 * is the load-bearing `false` and ADR-0331 is why: a bare `--api-key 'key:role:tenant'` names no
 * person and **every** such key in a deployment shares one `DEFAULT_PRINCIPAL_ID`, so looking that
 * id up would hand one placeholder's attributes to every service credential in the deployment —
 * exactly the per-person guard ADR-0331 closed. `ai_architect` and `system` are `false` for the
 * weaker reason that neither has a `meta.users` row to join, so a lookup could only ever resolve
 * `null` at the cost of a query.
 *
 * A spec that *names* a principal resolves `principalKind: "user"` and does get a lookup, even where
 * an operator means it as a service account — that is the operator's own declaration, and the id
 * they named is the one the membership is keyed on.
 */
export const PRINCIPAL_KIND_NAMES_A_PERSON: Readonly<
  Record<ResolvedPrincipal["principalKind"], boolean>
> = Object.freeze({
  user: true,
  service_account: false,
  ai_architect: false,
  system: false,
});

export function principalNamesAPerson(principal: ResolvedPrincipal): boolean {
  return PRINCIPAL_KIND_NAMES_A_PERSON[principal.principalKind];
}

/**
 * Decorates a resolver so a resolved principal carries its ABAC attributes.
 *
 * There is deliberately **no** try/catch: a directory failure propagates. This runs in the gateway's
 * auth stage, *before* the handler, so nothing has happened yet and deferring costs nothing — while
 * attaching "no attributes" from a read that failed would be a resolved-looking answer nobody
 * gathered, which is ADR-0336's `IdempotencyStore.get` rule (not knowing must not admit) pointed at
 * an authorization input. `CachedAbacAttributeDirectory`'s `maxStaleMs` arm is what keeps a blip
 * from becoming an outage; it is not this function's job to soften one.
 *
 * Every skip below leaves the field **absent** rather than `{}`, because `{}` asserts the principal
 * has no attributes and would let an evaluator answer from an input nobody collected.
 */
export function withAbacAttributes(
  resolver: PrincipalResolver,
  directory: AbacAttributeDirectory,
): PrincipalResolver {
  return {
    async resolve(input: PrincipalResolverInput): Promise<ResolvedPrincipal | null> {
      const resolved = await resolver.resolve(input);
      // No principal, so nothing to decorate — and returning the same `null` keeps the fail-closed
      // 401 the wrapped resolver decided on.
      if (resolved === null) return null;
      if (!principalNamesAPerson(resolved)) return resolved;
      // A membership is keyed `(user_id, tenant_id)`, so with no tenant there is no scope to read in
      // and no row to read. The gateway already decided whether such a request may proceed.
      if (resolved.tenantId === null) return resolved;
      const attributes = await directory.attributesFor(resolved.tenantId, resolved.principalId);
      if (attributes === null) return resolved;
      // A new object, never a mutation: the wrapped resolver may be handing out a shared instance —
      // `InMemoryPrincipalResolver` returns the very object it was registered with — so writing to
      // it would attach one request's attributes to every later resolution of that credential.
      const decorated: PrincipalWithAbacAttributes = { ...resolved, abacAttributes: attributes };
      return decorated;
    },
  };
}

// The absent→`null` mapping lives in `@crossengin/api-gateway` as `principalAbacAttributes`, beside
// the `ResolvedPrincipal` it reads: the three request-path sites that build an `auth.Principal` are
// in two other packages, so a copy here would have been the second spelling with no callers.
