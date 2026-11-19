import {
  isPrincipalRefused,
  principalNamesAPerson,
  type PrincipalRefused,
  type ResolvedPrincipal,
} from "@crossengin/api-gateway";
import type { PrincipalResolver, PrincipalResolverInput } from "@crossengin/api-gateway-runtime";

import type { SessionStanding } from "./credential-store.js";
import { DEFAULT_MAX_STALE_MS } from "./tenant-status-gate.js";
import { SESSION_EPOCH_CLAIM } from "./token-mint.js";

/**
 * The two facts about a **person** a session is checked against on every request: whether
 * `meta.users.status` still lets them act, and which generation of sessions is current.
 *
 * ADR-0381's membership check read the membership row and nothing else, so a user suspended in
 * `meta.users` while their membership stayed `active` kept their session until it expired — the two
 * statuses are independent columns on independent tables. And a session token is verified by
 * signature, so nothing about it can change after it is minted: a password change, an operator's
 * reset and a sign-out could only end a session by moving something the request path reads. That
 * is `session_epoch`, which the mint stamps into the token (`SESSION_EPOCH_CLAIM`) and every one of
 * those acts advances.
 *
 * A counter and not a denylist of token ids, argued: a denylist needs a table, a writer, a sweep of
 * expired entries and a lookup per request, and it ends one token where the three acts above each
 * mean *every* session this person holds. The cost is the other direction and is stated rather than
 * hidden: signing out on one device signs out every device.
 */
export interface SessionStandingDirectory {
  standingOf(userId: string): Promise<SessionStanding | null>;
}

/** The one value of `users_status_check` that lets a person act. */
export const ACTIVE_USER_STATUS = "active";

export const SESSION_STANDING_REFUSALS = [
  "user_not_active",
  "session_superseded",
  "user_unknown",
] as const;
export type SessionStandingRefusal = (typeof SESSION_STANDING_REFUSALS)[number];

export interface SessionStandingCheckOptions {
  readonly directory: SessionStandingDirectory;
  /**
   * The key id this deployment signs its own sessions with, or `null` when it mints none. The
   * generation is read only from a token **this** key signed: a foreign IdP's token carries no such
   * claim and its sessions end on the IdP's terms, while its subject's `status` is still checked.
   */
  readonly loginKid: string | null;
  readonly onRefused?: (userId: string, refusal: SessionStandingRefusal) => void;
}

/**
 * The generation a token carries: absent is zero, because every token minted before the claim
 * existed was minted against a row whose generation defaulted to zero. Anything present and not a
 * non-negative integer is `null`, which refuses — a key this deployment holds signed it, so a
 * malformed value is not a case to be lenient about.
 */
export function tokenSessionEpoch(claims: Readonly<Record<string, unknown>>): number | null {
  const value = claims[SESSION_EPOCH_CLAIM];
  if (value === undefined) return 0;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/** Which refusal, if any, a person's standing owes this request. Pure, so every arm is testable. */
export function sessionStandingRefusal(input: {
  readonly standing: SessionStanding | null;
  readonly mintedHere: boolean;
  readonly tokenEpoch: number | null;
}): SessionStandingRefusal | null {
  if (input.standing === null) {
    // A session this deployment minted names a row its login read; a foreign subject or an api-key
    // principal with no row is the membership check's business, not this one's.
    return input.mintedHere ? "user_unknown" : null;
  }
  if (input.standing.status !== ACTIVE_USER_STATUS) return "user_not_active";
  // `!==` and not `<`: a token naming a generation the row has not reached can only come from a
  // database restored to an earlier state, and the sessions minted after that point are exactly the
  // ones nothing can vouch for.
  if (input.mintedHere && input.tokenEpoch !== input.standing.sessionEpoch) {
    return "session_superseded";
  }
  return null;
}

/**
 * Decorates a resolver so a person whose standing no longer admits this session is refused.
 *
 * Refused as `principal_disabled` and not `null`, for `withMembershipRevocationCheck`'s reason: the
 * caller gets the same 401 whatever the cause, while the gateway's record does not claim that a
 * principal who exists does not. A directory failure propagates — this runs before the handler, so
 * deferring costs nothing, and admitting a session nobody could vouch for is the one wrong answer.
 */
export function withSessionStandingCheck(
  resolver: PrincipalResolver,
  opts: SessionStandingCheckOptions,
): PrincipalResolver {
  return {
    async resolve(
      input: PrincipalResolverInput,
    ): Promise<ResolvedPrincipal | PrincipalRefused | null> {
      const resolved = await resolver.resolve(input);
      if (resolved === null || isPrincipalRefused(resolved)) return resolved;
      if (!principalNamesAPerson(resolved)) return resolved;
      const mintedHere =
        input.authScheme === "bearer_jwt" &&
        opts.loginKid !== null &&
        input.bearer?.kid === opts.loginKid;
      const standing = await opts.directory.standingOf(resolved.principalId);
      const refusal = sessionStandingRefusal({
        standing,
        mintedHere,
        tokenEpoch: mintedHere ? tokenSessionEpoch(input.bearer?.claims ?? {}) : null,
      });
      if (refusal === null) return resolved;
      opts.onRefused?.(resolved.principalId, refusal);
      return { refusedAs: "principal_disabled" };
    },
  };
}

export const DEFAULT_SESSION_STANDING_TTL_MS = 30_000;
export const DEFAULT_SESSION_STANDING_ABSENCE_TTL_MS = 5_000;

export interface CachedSessionStandingDirectoryOptions {
  /** How long a standing is served without re-reading: the most a suspension takes to bite. */
  readonly ttlMs?: number;
  readonly absenceTtlMs?: number;
  /** How long a value past its TTL is served when the refresh fails; then the failure propagates. */
  readonly maxStaleMs?: number;
  readonly now?: () => Date;
  readonly onRefreshError?: (userId: string, err: unknown, servedStale: boolean) => void;
}

interface Entry {
  readonly standing: SessionStanding | null;
  readonly readAtMs: number;
}

/**
 * A TTL cache in front of the standing read, with `CachedAbacAttributeDirectory`'s two failure
 * modes: a **first** read that throws propagates, a refresh that throws serves the last answer
 * until `maxStaleMs`. Keyed on the user id alone, because `meta.users` has no tenant column — one
 * person's standing is one fact in every tenant they belong to.
 *
 * `forget` is what makes an act this process performed bite here at once rather than after the
 * TTL: the routes that end sessions call it after the write. Another replica still waits out its
 * own TTL, which is the bound the boot line states.
 */
export class CachedSessionStandingDirectory implements SessionStandingDirectory {
  private readonly entries: Map<string, Entry> = new Map();
  private readonly inflight: Map<string, Promise<SessionStanding | null>> = new Map();
  /**
   * Bumped by `forget`, so a read that was already in flight when the act committed cannot write
   * its pre-act answer back into the cache after the act dropped it: without this, a request racing
   * a sign-out re-cached the standing the sign-out ended, for a whole TTL, on the very replica that
   * performed it.
   */
  private readonly generations: Map<string, number> = new Map();
  private readonly ttlMs: number;
  private readonly absenceTtlMs: number;
  private readonly maxStaleMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly inner: SessionStandingDirectory,
    private readonly opts: CachedSessionStandingDirectoryOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_SESSION_STANDING_TTL_MS;
    this.absenceTtlMs = opts.absenceTtlMs ?? DEFAULT_SESSION_STANDING_ABSENCE_TTL_MS;
    this.maxStaleMs = opts.maxStaleMs ?? DEFAULT_MAX_STALE_MS;
    this.now = opts.now ?? ((): Date => new Date());
  }

  get standingTtlMs(): number {
    return this.ttlMs;
  }

  async standingOf(userId: string): Promise<SessionStanding | null> {
    const key = userId.toLowerCase();
    const nowMs = this.now().getTime();
    const cached = this.entries.get(key);
    const ttl = cached?.standing === null ? this.absenceTtlMs : this.ttlMs;
    if (cached !== undefined && nowMs - cached.readAtMs < ttl) return cached.standing;
    const existing = this.inflight.get(key);
    if (existing !== undefined) return existing;
    const promise = this.refresh(userId, key, cached, nowMs).finally(() => {
      if (this.inflight.get(key) === promise) this.inflight.delete(key);
    });
    this.inflight.set(key, promise);
    return promise;
  }

  private async refresh(
    userId: string,
    key: string,
    cached: Entry | undefined,
    nowMs: number,
  ): Promise<SessionStanding | null> {
    const generation = this.generations.get(key) ?? 0;
    try {
      const standing = await this.inner.standingOf(userId);
      if ((this.generations.get(key) ?? 0) === generation) {
        this.entries.set(key, { standing, readAtMs: this.now().getTime() });
      }
      return standing;
    } catch (err) {
      const servable = cached !== undefined && nowMs - cached.readAtMs <= this.maxStaleMs;
      this.opts.onRefreshError?.(userId, err, servable);
      if (servable) return cached.standing;
      throw err;
    }
  }

  forget(userId: string): void {
    const key = userId.toLowerCase();
    this.entries.delete(key);
    // A read begun before the act may have seen the row before it moved; the next caller must not
    // join it, and its answer must not be cached.
    this.inflight.delete(key);
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
  }
}

/** The boot line: what ends a session, and how long it takes to bite on another replica. */
export function formatSessionStanding(ttlMs: number, loginKid: string | null): string {
  const seconds = Math.round(ttlMs / 1000).toString();
  return (
    "[auth] session standing checked per request: a person whose meta.users.status is not active" +
    " is refused" +
    (loginKid === null
      ? ""
      : `, and a session minted here (kid ${loginKid}) ends when its holder's password is set,` +
        " reset, or they sign out (POST /v1/account/logout ends every session they hold)") +
    ` — immediately on the replica that performed the act, within ${seconds}s on any other`
  );
}
