import type { UiUserIdentity, UiUserIdentityResolver } from "@crossengin/operate-runtime";

/**
 * The signed-in person's own name and email, for `GET /v1/meta/schema`'s viewer.
 *
 * `@crossengin/operate-runtime` has no Postgres dependency, so the read lives here and reaches the
 * handler as the `UiUserIdentityResolver` seam — `settingsStore`'s own shape on the same interface.
 */
export interface UserIdentityReader {
  getById(
    id: string,
  ): Promise<{ readonly displayName: string | null; readonly email: string } | null>;
}

/** Default TTL for a resolved identity. A name and an email change rarely; 60s is generous. */
export const DEFAULT_USER_IDENTITY_TTL_MS = 60_000;
/**
 * A shorter TTL for *absence*, on `CachedAbacAttributeDirectory`'s reasoning: the two mistakes are
 * not symmetric. A stale name is cosmetic for a minute; a stale absence keeps a person anonymous
 * to their own console after an operator has just provisioned them.
 */
export const DEFAULT_USER_IDENTITY_ABSENCE_TTL_MS = 5_000;

export interface UserIdentityResolverOptions {
  /** Reports a failed read. Required, because the whole failure mode is a silence. */
  readonly onError: (userId: string, error: unknown, servedStale: boolean) => void;
  readonly ttlMs?: number;
  readonly absenceTtlMs?: number;
  readonly now?: () => Date;
}

/**
 * The handler's resolver, plus the one write-side act it needs: forgetting a person.
 *
 * Still assignable to `UiUserIdentityResolver` — a function with a property is a function — so every
 * consumer that only resolves is unchanged, while the registry routes that change a person's row can
 * drop this process's answer at once. Before this the cache had a TTL and nothing else, so a person
 * provisioned a moment after their console first loaded was shown as nobody for the absence TTL, and
 * a renamed one under the old name for a minute, on the very replica that made the change.
 */
export interface EvictableUserIdentityResolver extends UiUserIdentityResolver {
  /**
   * Forget `userId` in this process. In-process only: another replica's entry still lapses on its own
   * TTL, which is what bounds it there. An in-flight read that began before the eviction is not
   * allowed to repopulate the entry, because what it read may be the row the write just replaced.
   */
  readonly evict: (userId: string) => void;
}

interface Entry {
  readonly identity: UiUserIdentity | null;
  readonly readAtMs: number;
}

/**
 * Wraps a user-row reader as the handler's resolver, with a TTL cache and in-flight collapse.
 *
 * **A failure here never propagates, and that is the one place this diverges from
 * `CachedAbacAttributeDirectory`, whose structure it otherwise copies.** That cache lets a first
 * lookup throw, because its answer feeds an authorization decision and a guess in either direction
 * is wrong. This answer feeds a *label*. `meta.schema.read` is the route every console page loads
 * first, so propagating would turn a console into a 500 because a display name could not be
 * fetched — and the degraded answer is exactly what the UI rendered before these fields existed:
 * the viewer still carries `userId`, `principalKind` and the role list, all of which come from the
 * principal and need no store at all.
 *
 * Which is why `onError` is **required** rather than optional: the whole failure mode is a silence,
 * so a deployment whose identity reads are failing must not discover it by noticing that every
 * page says "Signed in as erp_admin" again (ADR-0372's rule — a computed fact reaching nobody is
 * this repository's most-found shape).
 *
 * Keyed on the **user id alone**, which is the one structural difference from the ABAC directory's
 * `(tenantId, userId)` key and is forced rather than chosen: `meta.users` has no `tenant_id` column
 * and no RLS, so a person's name and email are the same fact in every tenant they hold a membership
 * in. Sharing that cache's key would have meant N reads of one row for a person in N tenants.
 */
export function userIdentityFromStore(
  reader: UserIdentityReader,
  opts: UserIdentityResolverOptions,
): EvictableUserIdentityResolver {
  const ttlMs = opts.ttlMs ?? DEFAULT_USER_IDENTITY_TTL_MS;
  const absenceTtlMs = opts.absenceTtlMs ?? DEFAULT_USER_IDENTITY_ABSENCE_TTL_MS;
  const now = opts.now ?? ((): Date => new Date());
  const entries = new Map<string, Entry>();
  const inflight = new Map<string, Promise<UiUserIdentity | null>>();
  // Bumped by `evict`. A read records the generation it started under and stores its answer only if
  // nothing evicted the person meanwhile — otherwise a read racing the write that triggered the
  // eviction would put the pre-write row straight back for a whole TTL.
  const generations = new Map<string, number>();
  const generationOf = (userId: string): number => generations.get(userId) ?? 0;

  const ttlFor = (identity: UiUserIdentity | null): number =>
    identity === null ? absenceTtlMs : ttlMs;

  const refresh = async (
    userId: string,
    cached: Entry | undefined,
  ): Promise<UiUserIdentity | null> => {
    const startedUnder = generationOf(userId);
    try {
      const row = await reader.getById(userId);
      const identity: UiUserIdentity | null =
        row === null ? null : { displayName: row.displayName, email: row.email };
      if (generationOf(userId) === startedUnder) {
        entries.set(userId, { identity, readAtMs: now().getTime() });
      }
      return identity;
    } catch (error) {
      // Serve the last known answer if we have one, else answer absent — never throw. The caller
      // renders a role where a name would have been, which is what it did before this existed.
      // Not the pre-eviction answer once evicted: that is the value the write may have replaced.
      const servedStale = cached !== undefined && generationOf(userId) === startedUnder;
      opts.onError(userId, error, servedStale);
      return servedStale ? cached.identity : null;
    }
  };

  const resolve = async (userId: string): Promise<UiUserIdentity | null> => {
    const nowMs = now().getTime();
    const cached = entries.get(userId);
    if (cached !== undefined && nowMs - cached.readAtMs < ttlFor(cached.identity)) {
      return cached.identity;
    }
    // One read per person under concurrent cold load. This runs on `meta.schema.read`, which every
    // console page fetches, so without it a cold cache costs one query per page load per person.
    const existing = inflight.get(userId);
    if (existing !== undefined) return existing;
    const promise: Promise<UiUserIdentity | null> = refresh(userId, cached).finally(() => {
      // Only this read's own slot: after an eviction a newer read may hold the key, and deleting it
      // would let a third caller start a second concurrent read instead of joining that one.
      if (inflight.get(userId) === promise) inflight.delete(userId);
    });
    inflight.set(userId, promise);
    return promise;
  };
  const evict = (userId: string): void => {
    generations.set(userId, generationOf(userId) + 1);
    entries.delete(userId);
    // A request arriving after the eviction must start its own read rather than join one that began
    // before it; the joined read's answer is the one the write may have replaced.
    inflight.delete(userId);
  };
  return Object.assign(resolve, { evict });
}
