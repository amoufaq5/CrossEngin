import type { PathSegment, ResolvedPrincipal, RouteDefinition } from "@crossengin/api-gateway";
import type { Handler, HandlerOutput, PrincipalRoles } from "@crossengin/api-gateway-runtime";
import { hashPassword, verifyPassword } from "@crossengin/crypto";
import type { ExtraGatewayRoute } from "@crossengin/operate-runtime";
import { z } from "zod";

import { credentialIsLocked } from "./auth-token-route.js";
import type { PostgresCredentialStore } from "./credential-store.js";
import { USER_STATUSES, type UserStatus } from "./platform-users.js";

/**
 * Setting a password over HTTP, which until now only a shell could do.
 *
 * `set-credential` is a CLI subcommand and its own doc comment says why: *"there is no mail
 * channel ... an operator with shell access is the only principal that exists **before the first
 * password does**."* That reason is exactly right about the bootstrap and does not generalise one
 * step past it. Once the first operator can log in they are an authenticated principal carrying a
 * grant, which is a thing that did not exist at install time -- so the argument against a route
 * expires the moment the CLI has been run once, and nothing noticed.
 *
 * What it cost: `--platform-user-routes` mounts **ten** routes that provision a principal, grant it
 * a membership, suspend, reactivate, retire, and list and move memberships inside a tenant -- a
 * complete identity surface -- and the one act that makes any of it usable had no route at all. So
 * onboarding a tenant broke at step 3 of 4: create the tenant over HTTP, create the user over HTTP,
 * then `docker compose exec` into the container, then log in. A console cannot replace a shell while
 * one step still needs one.
 *
 * ## Two routes, and the split is the design
 *
 * These are two different acts wearing one name, and the preferences module's
 * `buildSetHandler(ctx, onBehalf)` shape -- one handler, a boolean -- would be wrong here. There,
 * self and on-behalf are the *same* act on a different subject. Here the authorisations are
 * disjoint:
 *
 * - **An operator setting someone else's password** is authorised by a *grant*, and must not be
 *   asked for the current password, because the operator does not know it.
 * - **A person changing their own** is authorised by *possession of the current one*, and needs no
 *   grant at all -- a deployment that can log in must be able to change the password it logs in
 *   with, which is why the self route takes no flag.
 *
 * The bodies differ, the fences differ, and the failure modes differ. One handler with a boolean
 * would have to branch on it four times.
 *
 * ## An operator may not set their own password here
 *
 * `self_not_permitted` is the four-eyes shape that actually applies to a credential, and unlike a
 * second approver it is checkable from what the request already carries. The operator route skips
 * the current-password proof by design; letting an operator aim it at themselves would let them
 * *replace their own credential without proving they hold it*, so a session stolen from a live
 * browser could lock the real operator out and keep the account. Changing your own password is the
 * other route, which proves possession. Neither route can do the other's job.
 *
 * ## Why the grant is its own
 *
 * `meta.users` has **no `tenant_id`, no RLS and no policies** -- verified against a live catalog,
 * and `credential-store.ts` says so in its own words. So for a write to this table the route's role
 * check is the *entire* authorisation: there is no policy behind it that would refuse a session
 * that got past the handler, which is the belt every tenant-scoped write here has. That is the
 * argument for `--credential-admin-role` rather than reusing `--platform-user-role`: provisioning a
 * principal and taking over its credential are different privileges, and the second has nothing
 * underneath it.
 *
 * ## What never appears
 *
 * No password, no hash and no pepper may reach a response body, a log line or an audit payload.
 * The audit rows carry who, whom, and which act -- `before`/`after` are deliberately absent, since
 * the only thing that changed is the one value that must not be recorded.
 */

/** An operator set another user's password. Platform scope: a credential belongs to the user. */
export const CREDENTIAL_SET_OPERATION = "platform.user_credential_set";

/** A person changed their own. Filed against their tenant, where their own auditor can read it. */
export const CREDENTIAL_CHANGED_OPERATION = "account.credential_changed";

/**
 * A recorded act that was then refused, the shape `REGISTRY_REFUSED_OPERATION` already takes.
 *
 * One operation with the attempted one in the payload rather than a `*_refused` sibling per act,
 * so the failures are directly countable without two more strings.
 */
export const CREDENTIAL_REFUSED_OPERATION = "platform.user_credential_refused";

/**
 * Why a credential write was refused.
 *
 * Deliberately **smaller** than `SET_CREDENTIAL_OUTCOMES`, and the two missing members are the
 * interesting part: `pepper_absent` and `pepper_refused` are unreachable here by construction,
 * because these routes mount on the same `resolveCredentialAuth` result the login does. A
 * deployment with no usable pepper has no login, and a route that cannot be reached without a
 * login cannot be reached without a pepper. The CLI has to carry both because it resolves its own.
 */
export const CREDENTIAL_REFUSALS = [
  "invalid_request",
  "confirm_mismatch",
  "self_not_permitted",
  "user_unknown",
  "not_a_person",
  "no_current_credential",
  "current_password_wrong",
  "account_locked",
  "user_not_active",
  "unrecordable",
] as const;
export type CredentialRefusal = (typeof CREDENTIAL_REFUSALS)[number];

/**
 * The HTTP status each refusal answers with.
 *
 * A total map so an eleventh refusal is a compile error at the one place that decides, rather than a
 * new member inheriting whichever branch an `if`-chain ended on.
 *
 * `current_password_wrong` is **401 and not 403**: the caller is authenticated as themselves and
 * their role is irrelevant, so what failed is a second authentication and not an authorisation.
 * `unrecordable` is 503 for ADR-0334's reason -- a transient inability to satisfy a standing rule
 * is retryable, where a 403 would be a claim about the caller.
 *
 * `account_locked` is **429 and not 401 or 423**. The login answers one body for every refusal, on
 * purpose, because an unauthenticated caller must learn nothing -- but this caller is already
 * authenticated as the account in question, so there is nothing to disclose and the useful answer
 * is the one that says *stop and come back*. 429 is that answer, and unlike 401 it is not one a
 * client should respond to by re-prompting for the password.
 */
export const CREDENTIAL_REFUSAL_STATUS: Readonly<Record<CredentialRefusal, number>> = Object.freeze(
  {
    invalid_request: 400,
    confirm_mismatch: 400,
    self_not_permitted: 403,
    user_unknown: 404,
    not_a_person: 403,
    no_current_credential: 409,
    current_password_wrong: 401,
    account_locked: 429,
    user_not_active: 403,
    unrecordable: 503,
  },
);

/**
 * What a credential write means for a user in each status, which neither route consulted.
 *
 * `findById` has always returned `status` and nothing read it, so a password set for a retired user
 * answered an unqualified `200 credential set` while `verifyLogin` refuses `status !== "active"`
 * outright -- the operator told the credential works, the person told their password is wrong, and
 * nothing in either answer naming the real cause. That is ADR-0337's falsely-true-control direction
 * on a surface built to make an act legible.
 *
 * The split is **terminal versus recoverable**, read off `USER_STATUS_TRANSITIONS` rather than
 * guessed: `deleted` has no outgoing transition, so a password set there can *never* be used and
 * refusing is the honest answer; `suspended` transitions back to `active`, so setting one ahead of a
 * reactivation is a coherent act and the honest answer is to do it and **say what it does not yet
 * buy** (ADR-0322's report-rather-than-refuse rule).
 *
 * `selfMay` is false for every non-active status, and that asymmetry is deliberate: a session minted
 * before a suspension stays valid until it expires (ADR-0358), so a suspended person can still reach
 * this route -- and letting them rotate the credential they were suspended from is the one thing the
 * suspension is for. An operator doing it for them is a decision; them doing it for themselves is a
 * bypass.
 */
export const CREDENTIAL_WRITE_BY_STATUS: Readonly<
  Record<UserStatus, { readonly operatorMay: boolean; readonly selfMay: boolean }>
> = Object.freeze({
  active: { operatorMay: true, selfMay: true },
  suspended: { operatorMay: true, selfMay: false },
  deleted: { operatorMay: false, selfMay: false },
});

/** True when a login would refuse this status outright, so a 200 has to say so. */
function loginBlockedBy(status: UserStatus): boolean {
  return status !== "active";
}

/**
 * The stored status, or null when the row holds a value this binary does not know.
 *
 * Parsed rather than cast, which is ADR-0362's class: `CredentialRecord.status` is a bare `string`
 * because the column's CHECK is the only thing constraining it, so a row written by a later binary
 * reads as a status with no entry in the map above. Null then takes the fail-closed arm rather than
 * indexing the map with a key it does not have and getting `undefined` for `operatorMay`.
 */
function asUserStatus(value: string): UserStatus | null {
  return (USER_STATUSES as readonly string[]).includes(value) ? (value as UserStatus) : null;
}

/**
 * A password is bounded in length and has **no floor**, which is the repo's existing decision
 * stated in `password.ts`: *"No floor on a user's password, deliberately: the floor is on the
 * deployment's pepper."*
 *
 * The ceiling is a work bound and not a strength rule -- `hashPassword` HMACs the password before
 * scrypt stretches it, so the HMAC is linear in its length while scrypt's cost is not. 1024 is far
 * above any real passphrase and far below the request-body cap, so neither a person nor a
 * misconfigured client can make one request cost megabytes of HMAC.
 *
 * Empty is refused rather than hashed. `credentialHash === null` already means *this user has no
 * password*, and an empty string would be a settable credential that reads as one -- the CLI makes
 * the same call, treating unset and empty as one refusal.
 */
export const MAX_PASSWORD_LENGTH = 1024;

const PasswordSchema = z.string().min(1).max(MAX_PASSWORD_LENGTH);

const SetCredentialBodySchema = z
  .object({
    password: PasswordSchema,
    /**
     * The user id, typed a second time. `rekey --confirm-tenant` and ADR-0316's `confirmTenantId`
     * for the same reason: this overwrites a credential, so naming the wrong user locks a real
     * person out *and* hands their account to whoever chose the password. There is no `confirm:
     * true` boolean, because a flag meaning "I meant it" can be sent by a client that never read
     * the id -- which is the thing being confirmed.
     */
    confirmUserId: z.string().uuid(),
  })
  .strict();

const ChangePasswordBodySchema = z
  .object({ currentPassword: PasswordSchema, newPassword: PasswordSchema })
  .strict();

/** What the audit emitter is handed. Carries no password, no hash and no pepper. */
export interface CredentialAuditEvent {
  readonly operation: string;
  /** The tenant the act is *about*: null for an operator write, since a credential is the user's. */
  readonly tenantId: string | null;
  readonly subjectUserId: string;
  readonly principalId: string | null;
  readonly roles: readonly string[];
  readonly detail: Readonly<Record<string, unknown>>;
  readonly at: string;
}

export type CredentialAuditor = (event: CredentialAuditEvent) => Promise<void>;

export interface CredentialRoutesContext {
  readonly store: PostgresCredentialStore;
  /** The same pepper the login verifies with, from the one `resolveCredentialAuth` result. */
  readonly pepper: string;
  readonly principalRoles: (principal: ResolvedPrincipal | null) => PrincipalRoles;
  /**
   * Roles permitted to set another user's password. Fail-closed: empty ⇒ the operator route is not
   * mounted at all, rather than mounted and refusing -- a surface that answers 403 for everyone
   * reads as broken rather than as ungranted.
   */
  readonly adminRoles: ReadonlySet<string>;
  /**
   * Required, not optional. Both acts replace the one credential a person authenticates with, so
   * this is ADR-0313's privileged-write class without exception and the record goes **before** the
   * write.
   */
  readonly audit: CredentialAuditor;
  /**
   * Counts one failed possession proof against the account lockout.
   *
   * **Required**, and that is the fence rather than a style: this increment's own review found the
   * self-service route reading the stored hash and neither the lock nor the counter, so it was an
   * *unmetered* guessing oracle that also ignored a lock the login was honouring -- the slow door
   * bypassed through the fast one. An optional field with a default is how the next wiring site
   * forgets to pass the real one (ADR-0330's rule), and the default that would read as safe here
   * ("no counter") is exactly the defect.
   *
   * The deployment supplies it, so the *policy* stays where the login's is -- one
   * `resolveLoginLockout` result behind both, read twice rather than spelled twice. There is
   * deliberately no `LoginLockoutPolicy` field beside this one: the handler never needs the
   * threshold, because it checks the lock by reading the column the counter wrote, so carrying the
   * numbers here would be a declaration nothing reads.
   */
  readonly onFailedAttempt: (userId: string) => Promise<void>;
  readonly clock?: () => Date;
}

function json(status: number, body: unknown): HandlerOutput {
  return { kind: "json", status, body };
}

function refuse(refusal: CredentialRefusal, detail: string): HandlerOutput {
  return json(CREDENTIAL_REFUSAL_STATUS[refusal], { error: refusal, detail });
}

function rolesOf(ctx: CredentialRoutesContext, principal: ResolvedPrincipal | null): string[] {
  const { primaryRole, secondaryRoles } = ctx.principalRoles(principal);
  return [primaryRole, ...(secondaryRoles ?? [])];
}

function nowIso(ctx: CredentialRoutesContext): string {
  return (ctx.clock ?? ((): Date => new Date()))().toISOString();
}

/**
 * Records the act, and a failure to record refuses it.
 *
 * The same shape and the same reasoning as `platform-users.ts`'s `record`: returned as a
 * `HandlerOutput` rather than thrown so the caller decides the shape, and 503 because an
 * unrecordable privileged write is a transient inability to satisfy a standing rule.
 */
async function record(
  ctx: CredentialRoutesContext,
  event: Omit<CredentialAuditEvent, "at">,
): Promise<HandlerOutput | null> {
  try {
    await ctx.audit({ ...event, at: nowIso(ctx) });
    return null;
  } catch {
    return refuse(
      "unrecordable",
      "a credential cannot be changed while the change cannot be recorded",
    );
  }
}

/** Best effort, for the same reason `recordRefusal` is: nothing changed, so a lost row is not a 503. */
async function recordRefusal(
  ctx: CredentialRoutesContext,
  attempted: Omit<CredentialAuditEvent, "at">,
  refusal: CredentialRefusal,
  output: HandlerOutput,
): Promise<HandlerOutput> {
  try {
    await ctx.audit({
      ...attempted,
      operation: CREDENTIAL_REFUSED_OPERATION,
      detail: { ...attempted.detail, attempted: attempted.operation, refusal },
      at: nowIso(ctx),
    });
  } catch {
    /* nothing was changed; a lost refusal row must not become a 503 */
  }
  return output;
}

// There is deliberately no `input` accessor helper here, and no cast anywhere in this file.
//
// The first draft of this module read `input.pathParams` and `input.body` through
// `as { pathParams?: ... }` casts, and `HandlerInput` carries **`params`** and **`parsedBody`**. So
// every request to both routes would have seen an undefined id and an undefined body and answered
// 400 — and the casts are exactly why `tsc` had nothing to say about it. That is ADR-0362's class
// (a type annotation standing in for a check) committed inside the increment that cites it, so the
// handlers destructure the real fields and a renamed one becomes a compile error.

/**
 * `POST /v1/platform/users/{id}/credential` — an operator sets another user's password.
 *
 * The ordering is the invariant: validate, then refuse self, then confirm the user exists, then
 * record, then write. Nothing is written before the act is recorded, and the existence check comes
 * before the record so the trail does not fill with rows for users who are not there.
 */
export function buildSetUserCredentialHandler(ctx: CredentialRoutesContext): Handler {
  return async ({ principal, params, parsedBody }): Promise<HandlerOutput> => {
    if (principal === null) return json(401, { error: "authentication_required" });
    const roles = rolesOf(ctx, principal);
    if (!roles.some((r) => ctx.adminRoles.has(r))) {
      return json(403, { error: "forbidden", detail: "insufficient role" });
    }

    const userId = params["id"] ?? "";
    if (!z.string().uuid().safeParse(userId).success) {
      return refuse("invalid_request", "the user id in the path must be a uuid");
    }

    const body = SetCredentialBodySchema.safeParse(parsedBody);
    if (!body.success) {
      // The issue paths are named and no value is echoed: one of the two fields is the password.
      const where = body.error.issues.map((i) => i.path.join(".")).join(", ");
      return refuse("invalid_request", `body rejected at: ${where === "" ? "(root)" : where}`);
    }
    if (body.data.confirmUserId.toLowerCase() !== userId.toLowerCase()) {
      return refuse(
        "confirm_mismatch",
        "confirmUserId must repeat the user id in the path; this overwrites a credential, so the" +
          " id is typed twice",
      );
    }

    // Before any store call and before any record. An operator aiming this at themselves is not a
    // write we want a row for -- it is a request that must not be expressible.
    if (principal.principalId.toLowerCase() === userId.toLowerCase()) {
      return refuse(
        "self_not_permitted",
        "this route does not ask for the current password, so it may not be aimed at the caller;" +
          " change your own password at POST /v1/account/password",
      );
    }

    const existing = await ctx.store.findById(userId);
    if (existing === null) {
      return refuse("user_unknown", `no meta.users row with id ${userId}`);
    }
    const status = asUserStatus(existing.status);
    if (status === null || !CREDENTIAL_WRITE_BY_STATUS[status].operatorMay) {
      // `deleted` is terminal -- `USER_STATUS_TRANSITIONS.deleted` is empty -- so nothing can ever
      // reactivate this user and a password set here could never be used by anybody. Refusing is
      // the honest answer where `suspended` gets a 200 that says what it does not yet buy, and the
      // difference is read off the transition map rather than from the status name.
      return refuse(
        "user_not_active",
        `user ${userId} is ${existing.status}, which has no transition back to active, so a` +
          " password set now could never be used",
      );
    }
    const loginBlocked = loginBlockedBy(status);

    const event: Omit<CredentialAuditEvent, "at"> = {
      operation: CREDENTIAL_SET_OPERATION,
      // Null is platform scope (ADR-0331). A credential is a property of the user and not of any
      // one membership, so filing it under a tenant would file it under an arbitrary one.
      tenantId: null,
      subjectUserId: userId,
      principalId: principal.principalId,
      roles,
      // `had_credential` is the one fact worth recording about the previous state: it separates
      // provisioning a first password from replacing a working one, which are different acts to
      // anyone reading the trail. Nothing derived from the password itself is recorded.
      // `status` rides along because a credential set for a suspended user is a different act from
      // one set for an active user, and the trail is where that distinction has to survive.
      detail: { hadCredential: existing.credentialHash !== null, subjectStatus: existing.status },
    };
    const unrecordable = await record(ctx, event);
    if (unrecordable !== null) return unrecordable;

    const encoded = await hashPassword(body.data.password, ctx.pepper);
    const matched = await ctx.store.setCredential(userId, encoded);
    if (!matched) {
      // The row was there a moment ago. Retired between the read and the write, most likely.
      return recordRefusal(
        ctx,
        event,
        "user_unknown",
        refuse("user_unknown", `no meta.users row with id ${userId} when the change landed`),
      );
    }
    // `loginBlocked` is said rather than left for the operator to infer, because the alternative is
    // ADR-0337's falsely-true control: an unqualified "credential set" for a suspended user is a
    // success message for a password the login refuses outright, so the operator believes it works
    // and the person is told their password is wrong. Reported and not refused, on ADR-0322's rule
    // -- setting one ahead of a reactivation is a coherent act whose consequence is a fact to state.
    return json(200, {
      userId,
      credentialSet: true,
      lockCleared: true,
      subjectStatus: existing.status,
      loginBlocked,
      detail: loginBlocked
        ? `credential set and any lock cleared, but this user is ${existing.status}, so logging in` +
          " is refused until they are reactivated"
        : "credential set; any lock on this account was cleared",
    });
  };
}

/**
 * `POST /v1/account/password` — a person changes their own.
 *
 * No role grant: the authorisation is possession of the current password, which is why the subject
 * is never in the path. That is the convention the preferences and read-state routes already set --
 * *"the viewer is always the credential"* -- and here it is load-bearing rather than tidy: a
 * subject parameter on this route would be the operator route without the grant.
 */
export function buildChangeOwnPasswordHandler(ctx: CredentialRoutesContext): Handler {
  return async ({ principal, parsedBody }): Promise<HandlerOutput> => {
    if (principal === null) return json(401, { error: "authentication_required" });

    const body = ChangePasswordBodySchema.safeParse(parsedBody);
    if (!body.success) {
      const where = body.error.issues.map((i) => i.path.join(".")).join(", ");
      return refuse("invalid_request", `body rejected at: ${where === "" ? "(root)" : where}`);
    }

    // A credential belongs to a person, and `principalKind` is the fact that says whether this one
    // is one (ADR-0331). A bare api-key spec resolves as a `service_account` on one shared
    // placeholder id, so admitting it here would let any holder of any such key set the password of
    // the one row that id names -- for every such key at once.
    if (principal.principalKind !== "user") {
      return refuse(
        "not_a_person",
        `a ${principal.principalKind} credential has no password to change`,
      );
    }
    // `principalId` is a non-nullable uuid on the contract, so this is not a null check: a bare
    // api-key spec resolves every such key onto one shared **placeholder** uuid (ADR-0331), which
    // is a well-formed id naming no row. The `principalKind` gate above is what catches that, and
    // `findById` below is what catches a well-formed id whose row is gone.
    const userId = principal.principalId;

    const existing = await ctx.store.findById(userId);
    if (existing === null) {
      // Authenticated as a user with no registry row: the token outlived the record.
      return refuse("user_unknown", "this credential names a user that no longer exists");
    }
    const status = asUserStatus(existing.status);
    if (status === null || !CREDENTIAL_WRITE_BY_STATUS[status].selfMay) {
      // A session minted before a suspension stays valid until it expires (ADR-0358), so a
      // suspended person can still reach this route -- and rotating the credential they were
      // suspended from is the one thing the suspension exists to stop. An operator may still set
      // one for them, which is a decision somebody made; this would be the person routing around
      // it. An unrecognised status takes the same arm, fail-closed.
      return refuse(
        "user_not_active",
        `this account is ${existing.status} and cannot change its own password; an operator sets` +
          " one for a suspended account",
      );
    }
    if (existing.credentialHash === null) {
      // Not `current_password_wrong`: *there is no password* is a different fact from *the one you
      // sent did not match*, and conflating them would tell an api-key or SSO user to try harder at
      // something that cannot succeed. 409, because the remedy is an operator setting a first one.
      return refuse(
        "no_current_credential",
        "this account has no password to change; an operator must set the first one",
      );
    }
    // The lock the login writes is honoured **here too**, through the login's own predicate rather
    // than a second spelling of it. Without this the two doors disagreed: the login refused a
    // locked account and this route went on verifying passwords against it at full speed, so the
    // lockout was bypassable by anyone holding a session -- which is the one credential a stolen
    // browser session already has. Deliberately **not** counted as an attempt, on the login's own
    // stated rule: hammering a locked account must not extend its own lock, or a caller could keep
    // an account locked forever without ever learning a password.
    if (credentialIsLocked(existing, (ctx.clock ?? ((): Date => new Date()))())) {
      return refuse(
        "account_locked",
        "too many failed attempts; this account is locked and the lock lapses on its own",
      );
    }

    const outcome = await verifyPassword(
      body.data.currentPassword,
      existing.credentialHash,
      ctx.pepper,
    );
    if (outcome !== "matched") {
      // Counted, which it was not: an uncounted wrong guess here is an *unmetered* oracle, and the
      // caller is authenticated so the work is cheap to repeat. `mismatched` counts and
      // `unreadable_hash` does not, which is `REFUSAL_COUNTS_AGAINST_LOCKOUT`'s split read one
      // surface over -- `password.ts` states the reason: a corrupt or foreign-format row says
      // nothing about the password, and counting it would lock a person out of an account whose
      // password they typed correctly. The caller gets one body for both.
      if (outcome === "mismatched") {
        try {
          await ctx.onFailedAttempt(userId);
        } catch {
          // Reported by the deployment's own handler and swallowed here, the login's reasoning
          // exactly: the refusal is already decided and raising would turn a correctly-refused
          // attempt into a 503, the one answer that invites a retry. An uncounted attempt is the
          // direction a counter can afford, because nothing has been committed.
        }
      }
      // Recorded too, best-effort. A wrong possession proof against a live account is the one event
      // here an operator reading the trail would want and nothing wrote it -- and `recordRefusal`
      // is best-effort for its own reason: nothing changed, so a lost row must not become a 503.
      return recordRefusal(
        ctx,
        {
          operation: CREDENTIAL_CHANGED_OPERATION,
          tenantId: principal.tenantId ?? null,
          subjectUserId: userId,
          principalId: userId,
          roles: rolesOf(ctx, principal),
          detail: { self: true, verification: outcome },
        },
        "current_password_wrong",
        refuse("current_password_wrong", "the current password did not match"),
      );
    }

    const event: Omit<CredentialAuditEvent, "at"> = {
      operation: CREDENTIAL_CHANGED_OPERATION,
      // Their own tenant, from their own token: this act is about a person inside a tenant, so the
      // tenant's auditor is entitled to read it. The operator route's null is the contrast.
      tenantId: principal.tenantId ?? null,
      subjectUserId: userId,
      principalId: userId,
      roles: rolesOf(ctx, principal),
      detail: { self: true },
    };
    const unrecordable = await record(ctx, event);
    if (unrecordable !== null) return unrecordable;

    const encoded = await hashPassword(body.data.newPassword, ctx.pepper);
    const matched = await ctx.store.setCredential(userId, encoded);
    if (!matched) {
      return recordRefusal(
        ctx,
        event,
        "user_unknown",
        refuse("user_unknown", "this credential names a user that no longer exists"),
      );
    }
    // Deliberately says the sessions are NOT cut off, because they are not: a session token is
    // verified against the JWKS and carries its own expiry, so changing the password cannot revoke
    // one. Saying so is the alternative to a reader assuming a password change logs everyone out.
    return json(200, {
      credentialChanged: true,
      sessionsRevoked: false,
      detail:
        "password changed; existing sessions remain valid until they expire, because a session" +
        " token is verified by signature and not against this row",
    });
  };
}

function route(
  operationId: string,
  method: RouteDefinition["method"],
  segments: ReadonlyArray<string | { param: string }>,
): RouteDefinition {
  const pathSegments: PathSegment[] = segments.map((s) =>
    typeof s === "string"
      ? { kind: "literal", value: s }
      : { kind: "parameter", name: s.param, pattern: null },
  );
  return {
    id: `rt_${operationId.replace(/[^a-z0-9]+/gi, "_")}`,
    operationId,
    method,
    pathSegments,
    apiVersion: "v1",
    isDeprecated: false,
    deprecatedSince: null,
    sunsetAt: null,
    successorOperationId: null,
    requiredScopes: [],
    rateLimitPolicyId: null,
    // No idempotency key, unlike the deletion route. A retried credential set lands the same state
    // it did the first time -- the salt differs, the password does not -- so there is nothing a
    // replay guard would protect.
    idempotencyRequired: false,
    requestSchemaSha256: null,
    responseSchemaSha256: null,
  };
}

/**
 * Both credential routes, to inject via the gateway's `extraRoutes` hook.
 *
 * Gateway routes and **not** interceptors, which is the one place these differ from the login they
 * sit beside: `POST /v1/auth/token` is wrapped in front of the gateway because `authenticate` runs
 * before `match_route` and a login carries no credential. Both of these carry one -- an operator's
 * grant or a person's own session -- so they belong behind exactly the auth stage that would have
 * 401'd the login.
 *
 * The operator route is omitted entirely when no role is granted. The self route is unconditional:
 * a deployment that mounted a login must be able to change the password it logs in with, and
 * putting that behind a second opt-in is a feature with a trap in it.
 */
export function buildCredentialRoutes(
  ctx: CredentialRoutesContext,
): readonly ExtraGatewayRoute[] {
  if (typeof ctx.audit !== "function") {
    throw new Error(
      "credential routes require an auditor: both acts replace the one credential a person " +
        "authenticates with, and such a write must be recordable before it lands",
    );
  }
  if (ctx.pepper.trim() === "") {
    // Unreachable from `node.ts`, which builds these from the same resolved material the login
    // uses. It is a refusal rather than a comment because the alternative is hashing every password
    // under an empty key, which `hashPassword` will do without complaint.
    throw new Error(
      "credential routes require the deployment's pepper: hashing under an empty one would store " +
        "credentials no login could verify",
    );
  }
  const routes: ExtraGatewayRoute[] = [
    {
      route: route("account.credential.change", "POST", ["v1", "account", "password"]),
      handler: buildChangeOwnPasswordHandler(ctx),
    },
  ];
  if (ctx.adminRoles.size > 0) {
    routes.push({
      route: route("platform.users.credential.set", "POST", [
        "v1",
        "platform",
        "users",
        { param: "id" },
        "credential",
      ]),
      handler: buildSetUserCredentialHandler(ctx),
    });
  }
  return routes;
}
