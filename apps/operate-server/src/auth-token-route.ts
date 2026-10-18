import {
  PASSWORD_OUTCOME_ADMITS,
  PASSWORD_SCRYPT_DEFAULTS,
  type PasswordScryptParams,
  type PasswordVerifyOutcome,
  hashPassword,
  passwordHashIsStale,
  spendPasswordWork,
  verifyPassword,
} from "@crossengin/crypto";
import { z } from "zod";

import type { CredentialRecord, PostgresCredentialStore } from "./credential-store.js";
import type { RawHttpRequest, RawHttpResponse } from "./http.js";
import { dedupedSessionRoles, roleNameIsScopeSafe, type SessionRoles } from "./token-mint.js";

/**
 * `POST /v1/auth/token` -- the one surface that turns a password into a session token.
 *
 * ## Why it is an interceptor and not a gateway route
 *
 * `authenticate` runs **before** `match_route`, so every gateway route is behind a credential.
 * A login request carries none, and worse: a browser holding a stale session token that hits the
 * login route to re-authenticate would be 401'd by the auth stage before this handler ever ran.
 * The precedent is settled -- the bounce webhook and ADR-0357's health probes both wrap the
 * dispatch target for the same reason -- and wrapping the target rather than the Node listener
 * keeps the route available to the Fetch/Workers adapter, which dispatches through it too.
 *
 * ## What that costs, and the answer
 *
 * In front of the gateway there is no rate limiting, no idempotency guard and no audit emitter.
 * Of those the first is the one that matters, and the KDF cost is **not** an acceptable substitute:
 * scrypt at the shipped parameters is ~130 ms on a libuv pool of 4 shared with fs and dns, so
 * treating the derivation as the limiter is a denial of service against the rest of the process.
 * Hence the per-user lockout, counted in SQL.
 *
 * ## The one rule the whole module is built around
 *
 * **Every refusal is the same status, the same body and the same cost.** An unknown email, a user
 * with no password, a wrong password, a suspended user, a tenant that blocks reads and a user with
 * no membership in the named tenant all answer `401` with one body. Where a path would be *cheaper*
 * than a real verification it spends a derivation anyway, because latency is as good an oracle as
 * a message. The only thing that varies is what the deployment's own log line says.
 */

/* --------------------------------------------------------------------- request */

export const AuthTokenRequestSchema = z
  .object({
    tenant: z.string().min(1).max(200),
    email: z.string().min(3).max(320),
    // No max() lower than this and deliberately no min() above 1: a floor on a *user's* password
    // is a product decision this increment does not take, and `password.ts` imposes none. The
    // ceiling exists only so an unauthenticated caller cannot hand scrypt a megabyte -- the HMAC
    // in front of the KDF already flattens the cost, so this is a body-size guard, not a policy.
    password: z.string().min(1).max(1024),
  })
  .strict();
export type AuthTokenRequest = z.infer<typeof AuthTokenRequestSchema>;

/* -------------------------------------------------------------------- outcomes */

/**
 * Why a login did not produce a token. Reported to the **deployment**, never to the caller: the
 * response body is one string for every member, and these are what distinguishes a misconfigured
 * deployment from a wrong password in the operator's log.
 */
export const LOGIN_REFUSALS = [
  "malformed_request",
  "tenant_unknown",
  "tenant_blocks_access",
  "user_unknown",
  "user_not_active",
  "no_credential_set",
  "credential_unreadable",
  "password_mismatch",
  "account_locked",
  "no_active_membership",
  /**
   * The membership exists, is active, and names a role the `scope` claim cannot carry.
   *
   * `no_active_membership`'s sibling and ADR-0369's only new refusal. It exists because the
   * backstop it replaces was **worse than the fault it guarded**: `sessionScope` throws, the
   * throw escaped `ctx.mint(outcome)` uncaught, and the login answered a **500 carrying the
   * exception's message** -- on the one route whose entire design is that every refusal looks
   * identical, and as a status clients retry for a condition no retry can fix. Found by the live
   * run and not by a test, because every test supplies a well-formed role list.
   *
   * So the check moves into `verifyLogin`, where it takes the uniform 401 body like every other
   * refusal and the detail reaches the operator through `onFailure`. The mint's throw stays as a
   * pure backstop that this path can no longer reach -- `dischargeAbac`'s shape, where the refusal
   * sits before the call so a caller that forgets cannot get it wrong.
   */
  "membership_role_unusable",
] as const;
export type LoginRefusal = (typeof LOGIN_REFUSALS)[number];

/**
 * Whether a refusal should count against the lockout.
 *
 * A total map rather than a condition, because the two that answer `false` are the two a condition
 * would get wrong. `credential_unreadable` must not count: a corrupt or foreign-format row would
 * otherwise lock a user out of an account whose password they typed **correctly**, and the remedy
 * is a reset rather than waiting. `account_locked` must not count either, or hammering a locked
 * account would extend its own lock indefinitely -- a caller could keep an account locked forever
 * without ever knowing a password.
 *
 * `user_unknown` answers `false` because there is no row to count on; the timing is equalised by
 * spending the work, not by writing a counter for an account that does not exist.
 */
export const REFUSAL_COUNTS_AGAINST_LOCKOUT: Readonly<Record<LoginRefusal, boolean>> =
  Object.freeze({
    malformed_request: false,
    tenant_unknown: false,
    tenant_blocks_access: false,
    user_unknown: false,
    user_not_active: false,
    no_credential_set: false,
    credential_unreadable: false,
    password_mismatch: true,
    account_locked: false,
    no_active_membership: false,
    // The password was correct. This is a malformed membership, so counting it would lock a user
    // out of an account whose credential they hold for a defect they cannot fix —
    // `credential_unreadable`'s reasoning on the other side of the verification.
    membership_role_unusable: false,
  });

export type LoginOutcome =
  | {
      readonly ok: true;
      readonly userId: string;
      readonly tenantId: string;
      readonly roles: SessionRoles;
      /**
       * A hash re-derived under the deployment's current parameters, when the stored one was
       * produced under weaker ones -- `null` when there is nothing to upgrade. The caller stores
       * it; see `verifyLogin` for why this is a correctness fix and not an optimisation.
       */
      readonly rehashTo: string | null;
    }
  | {
      readonly ok: false;
      readonly refusal: LoginRefusal;
      readonly userId: string | null;
      readonly detail: string;
    };

/* ------------------------------------------------------------------- lockout */

export const MIN_LOGIN_LOCKOUT_ATTEMPTS = 3;
export const DEFAULT_LOGIN_LOCKOUT_ATTEMPTS = 10;
export const MIN_LOGIN_LOCKOUT_SECONDS = 30;
export const DEFAULT_LOGIN_LOCKOUT_SECONDS = 900;

export interface LoginLockoutPolicy {
  readonly attempts: number;
  readonly seconds: number;
}

export const DEFAULT_LOGIN_LOCKOUT: LoginLockoutPolicy = Object.freeze({
  attempts: DEFAULT_LOGIN_LOCKOUT_ATTEMPTS,
  seconds: DEFAULT_LOGIN_LOCKOUT_SECONDS,
});

/**
 * Refuses a threshold below the floor rather than clamping it, which is ADR-0332's rule for the
 * fax-run counter and holds for the same reason: a threshold of 1 locks a real user out on a
 * single typo, and silently raising it to 3 would leave the deployment believing it had configured
 * something it had not. A deployment that wants 1 has to be told it cannot have it.
 */
export function parseLoginLockout(attempts: number, seconds: number): LoginLockoutPolicy {
  if (!Number.isInteger(attempts) || attempts < MIN_LOGIN_LOCKOUT_ATTEMPTS) {
    throw new Error(
      `login lockout threshold must be an integer >= ${MIN_LOGIN_LOCKOUT_ATTEMPTS.toString()},` +
        ` got ${String(attempts)}`,
    );
  }
  if (!Number.isInteger(seconds) || seconds < MIN_LOGIN_LOCKOUT_SECONDS) {
    throw new Error(
      `login lockout window must be an integer >= ${MIN_LOGIN_LOCKOUT_SECONDS.toString()} seconds,` +
        ` got ${String(seconds)}`,
    );
  }
  return { attempts, seconds };
}

/* ------------------------------------------------------------------ the check */

/**
 * Resolves the roles a session carries. Returns null when no active membership exists.
 *
 * It answered one `string` until ADR-0369, which is where the membership's `secondary_roles` was
 * dropped on the way to the token -- the first of the two truncations that made that column reach
 * no authorization decision. The resolver returns the pair the row holds; the mint turns it into
 * one `scope` claim and `principalRoles` reads it back.
 */
export type MembershipRoleResolver = (
  tenantId: string,
  userId: string,
) => Promise<SessionRoles | null>;

export interface VerifyLoginInput {
  readonly request: AuthTokenRequest;
  readonly store: PostgresCredentialStore;
  readonly pepper: string;
  readonly roleFor: MembershipRoleResolver;
  readonly lockout: LoginLockoutPolicy;
  readonly now: Date;
  readonly scryptParams?: PasswordScryptParams;
  /** Whether a tenant in this state may be reached at all. Mirrors the tenant-status gate. */
  readonly tenantBlocksAccess: (status: string) => boolean;
}

/**
 * The whole decision, with the password work spent on every path that reaches it.
 *
 * The ordering is load-bearing in one place: the password is verified **before** the membership is
 * read. The other way round, a caller holding no password for a user could learn whether that user
 * is a member of a named tenant, which is a directory oracle on an unauthenticated route. Doing
 * the dear thing first costs a derivation on a request that was going to fail anyway, and buys
 * that nothing before the verification depends on the tenant the caller named.
 */
export async function verifyLogin(input: VerifyLoginInput): Promise<LoginOutcome> {
  const params = input.scryptParams ?? PASSWORD_SCRYPT_DEFAULTS;
  const { password } = input.request;

  const tenant = await input.store.resolveTenant(input.request.tenant);
  if (tenant === null) {
    await spendPasswordWork(password, input.pepper, params);
    return {
      ok: false,
      refusal: "tenant_unknown",
      userId: null,
      detail: `no tenant matches ${JSON.stringify(input.request.tenant)}`,
    };
  }
  if (input.tenantBlocksAccess(tenant.status)) {
    await spendPasswordWork(password, input.pepper, params);
    return {
      ok: false,
      refusal: "tenant_blocks_access",
      userId: null,
      detail: `tenant ${tenant.tenantId} is ${tenant.status}`,
    };
  }

  const record = await input.store.findByEmail(input.request.email);
  if (record === null) {
    await spendPasswordWork(password, input.pepper, params);
    return { ok: false, refusal: "user_unknown", userId: null, detail: "no user for that email" };
  }
  if (record.status !== "active") {
    await spendPasswordWork(password, input.pepper, params);
    return {
      ok: false,
      refusal: "user_not_active",
      userId: record.userId,
      detail: `user ${record.userId} is ${record.status}`,
    };
  }
  if (record.credentialHash === null) {
    await spendPasswordWork(password, input.pepper, params);
    return {
      ok: false,
      refusal: "no_credential_set",
      userId: record.userId,
      detail: `user ${record.userId} has no password; set one with 'operate-server set-credential'`,
    };
  }
  if (credentialIsLocked(record, input.now)) {
    // The work is spent even though the answer is already known, and that is the deliberate
    // choice. Short-circuiting here would make a locked account answer in a millisecond where an
    // unknown email takes ~130 ms, which is an enumeration oracle a caller can *create* on
    // demand: hammer an address until it either locks (it exists) or does not (it does not).
    // Spending the work costs CPU the lock was meant to save and keeps the one property this
    // module is built around.
    await spendPasswordWork(password, input.pepper, params);
    return {
      ok: false,
      refusal: "account_locked",
      userId: record.userId,
      detail: `user ${record.userId} is locked until ${record.lockedUntil ?? "?"}`,
    };
  }

  const outcome: PasswordVerifyOutcome = await verifyPassword(
    password,
    record.credentialHash,
    input.pepper,
  );
  if (!PASSWORD_OUTCOME_ADMITS[outcome]) {
    return {
      ok: false,
      refusal: outcome === "unreadable_hash" ? "credential_unreadable" : "password_mismatch",
      userId: record.userId,
      detail:
        outcome === "unreadable_hash"
          ? `user ${record.userId} has a credential this build cannot read`
          : "password did not match",
    };
  }

  const roles = await input.roleFor(tenant.tenantId, record.userId);
  // The **primary** is what makes a membership a session: a row carrying secondary roles and an
  // empty primary names no role the mint can put first, and `principalRoles` would read the first
  // secondary as the primary -- promoting a role nobody granted as such.
  if (roles === null || roles.primaryRole === "") {
    return {
      ok: false,
      refusal: "no_active_membership",
      userId: record.userId,
      detail: `user ${record.userId} has no active membership in tenant ${tenant.tenantId}`,
    };
  }
  // Asked here rather than left to `sessionScope`'s throw: that throw escapes the interceptor as a
  // 500 carrying its own message, which on this route is both a disclosure and a retryable status
  // for a permanent fault. `roleNameIsScopeSafe` is imported rather than restated, so the grant's
  // 400 and this 401 cannot come to disagree about which names are usable.
  const unusable = [roles.primaryRole, ...roles.secondaryRoles].find((r) => !roleNameIsScopeSafe(r));
  if (unusable !== undefined) {
    return {
      ok: false,
      refusal: "membership_role_unusable",
      userId: record.userId,
      detail:
        `user ${record.userId} has a membership in tenant ${tenant.tenantId} naming role` +
        ` ${JSON.stringify(unusable)}, which the session scope claim cannot carry`,
    };
  }
  return {
    ok: true,
    userId: record.userId,
    tenantId: tenant.tenantId,
    roles,
    // The one moment the plaintext is in hand, which is the only moment a re-derivation is
    // possible. It closes a timing oracle rather than merely strengthening an old hash:
    // `spendPasswordWork` has to derive under *some* parameters and the only honest choice is the
    // deployment's current ones, so a hash still stored under weaker ones costs measurably less
    // than an unknown email does -- an enumeration oracle that appears the moment an operator
    // raises `n` and widens with every account that has not logged in since. Re-hashing on
    // success is what makes the equaliser's assumption true over time.
    rehashTo: passwordHashIsStale(record.credentialHash, params)
      ? await hashPassword(password, input.pepper, { params })
      : null,
  };
}

/**
 * Whether this account's lock is still in force.
 *
 * Exported because the credential routes ask the same question (ADR-0364's follow-up) and a second
 * spelling of *is this account locked* is how two of them come to disagree -- which here would mean
 * one surface honouring a lock the other ignores, so the slower one is bypassed through the faster.
 * The login is the only caller that may *mint* on a false answer; the other reads it to refuse.
 */
export function credentialIsLocked(record: CredentialRecord, now: Date): boolean {
  if (record.lockedUntil === null) return false;
  const until = Date.parse(record.lockedUntil);
  // An unparseable lock reads as *locked*, not as unlocked: the column is written by one statement
  // from the database clock, so a value this cannot read means something unexpected wrote it, and
  // the fail-closed direction is to keep refusing.
  return Number.isNaN(until) ? true : until > now.getTime();
}

/* -------------------------------------------------------------------- the route */

export const AUTH_TOKEN_PATH = "/v1/auth/token";

/** The single body every refusal answers with. RFC 9457, and it names nothing about the attempt. */
export const LOGIN_REFUSED_PROBLEM = Object.freeze({
  type: "https://crossengin.io/errors/invalid-credentials",
  title: "Invalid credentials",
  status: 401,
  detail: "The tenant, email address or password was not accepted.",
});

/** What the mint hands back. Named so the handler can hold it across a `try`. */
export interface MintedToken {
  readonly token: string;
  readonly expiresAt: string;
}

export interface AuthTokenRouteContext {
  readonly verify: (request: AuthTokenRequest) => Promise<LoginOutcome>;
  readonly mint: (outcome: Extract<LoginOutcome, { ok: true }>) => MintedToken;
  /**
   * Clears the attempt counter, stamps `last_login_at`, and -- when `rehashTo` is non-null --
   * replaces the stored hash. One call rather than two, so a caller cannot reset the counter and
   * forget the upgrade.
   */
  readonly onSuccess: (userId: string, rehashTo: string | null) => Promise<void>;
  readonly onFailure: (userId: string, refusal: LoginRefusal) => Promise<void>;
  /** The deployment's own record. Must never receive the password or the minted token. */
  readonly onRefusal?: (info: { readonly refusal: LoginRefusal; readonly detail: string }) => void;
  readonly onError?: (err: unknown) => void;
}

function json(status: number, body: unknown): RawHttpResponse {
  return {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // A session token must not be stored by anything between here and the browser.
      "cache-control": "no-store",
    },
    body: new TextEncoder().encode(JSON.stringify(body)),
  };
}

export function isAuthTokenPath(url: string): boolean {
  const path = url.split("?")[0] ?? "";
  return path === AUTH_TOKEN_PATH;
}

/**
 * The adapter the server wires in: a `RawHttpResponse` for a login, or **null** when the request
 * is not ours so the caller falls through to the gateway.
 */
export function buildAuthTokenInterceptor(
  ctx: AuthTokenRouteContext,
): (raw: RawHttpRequest, body: Uint8Array | null) => Promise<RawHttpResponse | null> {
  return async (raw, body) => {
    if (!isAuthTokenPath(raw.url)) return null;
    if (raw.method.toUpperCase() !== "POST") {
      return json(405, {
        type: "https://crossengin.io/errors/method-not-allowed",
        title: "Method not allowed",
        status: 405,
        detail: `${AUTH_TOKEN_PATH} accepts POST`,
      });
    }

    let parsed: AuthTokenRequest;
    try {
      const text = body === null ? "" : new TextDecoder().decode(body);
      parsed = AuthTokenRequestSchema.parse(JSON.parse(text === "" ? "{}" : text));
    } catch {
      // Deliberately NOT the zod issue list. A 422 naming which field was wrong is the right
      // answer on an authenticated write surface and the wrong one here: the field names are
      // public, but a parse error that distinguishes "no such field" from "password too long"
      // hands an unauthenticated caller a probe. One 400, no detail about the body.
      ctx.onRefusal?.({ refusal: "malformed_request", detail: "body did not parse" });
      return json(400, {
        type: "https://crossengin.io/errors/malformed-request",
        title: "Malformed request",
        status: 400,
        detail: `${AUTH_TOKEN_PATH} expects {tenant, email, password}`,
      });
    }

    let outcome: LoginOutcome;
    try {
      outcome = await ctx.verify(parsed);
    } catch (err) {
      // Nothing escapes: the operator gets the exception, the caller gets a 503 that says only
      // that login is unavailable -- 503 and not 401, because a store failure is not a statement
      // about the credential and a 401 would send a correct password away for good.
      //
      // This used to be argued from the dispatch stage handing the message to the client, and that
      // premise is gone: a thrown value is now a **500** whose body is a fixed sentence, with the
      // message in the recorded stage reason. The conclusion survives on its own terms, and in fact
      // is now the stronger of the two reasons — an unauthenticated caller must be told which of
      // "wrong password" and "the store is down" happened, and a generic 500 cannot say it.
      ctx.onError?.(err);
      return json(503, {
        type: "https://crossengin.io/errors/login-unavailable",
        title: "Login unavailable",
        status: 503,
        detail: "The credential directory could not be reached. Retry shortly.",
      });
    }

    if (!outcome.ok) {
      ctx.onRefusal?.({ refusal: outcome.refusal, detail: outcome.detail });
      if (outcome.userId !== null && REFUSAL_COUNTS_AGAINST_LOCKOUT[outcome.refusal]) {
        try {
          await ctx.onFailure(outcome.userId, outcome.refusal);
        } catch (err) {
          // Reported and swallowed: the refusal has already been decided and raising here would
          // turn a correctly-refused login into a 503, which is the one answer that invites a
          // retry. The cost is an uncounted attempt, which is the failure direction a counter can
          // afford -- unlike `put` in the idempotency store, nothing has been committed that a
          // retry would duplicate.
          ctx.onError?.(err);
        }
      }
      return json(401, LOGIN_REFUSED_PROBLEM);
    }

    // Wrapped for the same reason `ctx.verify` is, and the gap was found by review after ADR-0369
    // had closed the one defect that travelled through it. `mintSessionToken` throws for two
    // reasons: a role name the scope claim cannot carry, which `verifyLogin` now refuses before
    // reaching here, and a `lifetimeSeconds` outside its bounds — which `cli.ts` validates against
    // the same constants, so the shipped binary cannot produce it, and a programmatic `serve()`
    // can. Uncaught, either escapes to the listener's generic catch, which puts `err.message` in
    // a **500** problem document: the disclosure-plus-retryable-status pair this route exists not
    // to have. Closing the member and leaving the channel open is what the review caught, so the
    // channel is closed — the 503 its sibling returns, because a login that cannot be minted is
    // exactly "unavailable" and the password was correct.
    let minted: MintedToken;
    try {
      minted = ctx.mint(outcome);
    } catch (err) {
      ctx.onError?.(err);
      return json(503, {
        type: "https://crossengin.io/errors/login-unavailable",
        title: "Login unavailable",
        status: 503,
        detail: "The session token could not be minted. Retry shortly.",
      });
    }
    try {
      await ctx.onSuccess(outcome.userId, outcome.rehashTo);
    } catch (err) {
      // Also swallowed, and this is the sharper of the two: the password was correct, so refusing
      // now would deny a legitimate login to protect a counter reset and a `last_login_at` stamp.
      // The residual is an attempt count that stays high after a success, which costs the user an
      // earlier lockout and never admits anyone.
      ctx.onError?.(err);
    }
    return json(200, {
      token: minted.token,
      expiresAt: minted.expiresAt,
      tenantId: outcome.tenantId,
      role: outcome.roles.primaryRole,
      // `role` keeps its name and its meaning -- the primary -- and the list rides beside it
      // rather than replacing it. Since ADR-0369 a session carries more than one role, so a body
      // naming only the primary would *understate* what it had just minted: this is an existing
      // field completed, not a speculative one added (the client does not need it -- `/account`
      // reads the same list off `UiViewer.roles`, which is derived from the token).
      //
      // Read back out of the minted claim rather than echoed from the row, which is the whole
      // point and was wrong on the first pass: `sessionScope` de-duplicates and the row does not,
      // so a membership naming its primary in `secondary_roles` got a body claiming a secondary
      // the token does not carry. A field added so the body would not understate the session
      // cannot be allowed to misstate it, so it reports what was actually signed.
      secondaryRoles: dedupedSessionRoles(outcome.roles).secondaryRoles,
    });
  };
}
