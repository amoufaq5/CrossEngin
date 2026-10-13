// The identity half of the platform console: users, their memberships inside a tenant, and the
// password an operator sets for them. Every request goes to this Next app's /api proxy, which turns
// the caller's session cookie into the API's bearer token — so the browser never holds a readable
// credential (ADR-0358).
//
// `PlatformError` and `throwProblem` are imported from lib/platform.ts rather than restated: these
// routes answer the same RFC 9457 `{error, detail}` documents through the same proxy, and the
// 401-redirect inside `throwProblem` is the half a second copy would forget.

import { PlatformError, throwProblem } from "@/lib/platform";

/**
 * `deleted` is terminal and `suspended` is not, which the detail page's buttons read off
 * `USER_STATUS_TRANSITIONS` below rather than deciding for themselves. Nothing deletes the row —
 * 97 catalogued columns reference `meta.users` — so `deleted` is how a spent identity is said
 * without lying about the row still being there.
 */
export const USER_STATUSES = ["active", "suspended", "deleted"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/** Mirrors the server's map, so a button is offered exactly when the transition is legal. */
export const USER_STATUS_TRANSITIONS: Readonly<Record<UserStatus, readonly UserStatus[]>> =
  Object.freeze({
    active: ["suspended", "deleted"],
    suspended: ["active", "deleted"],
    deleted: [],
  });

export const MEMBERSHIP_STATUSES = ["active", "invited", "revoked"] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

export const MEMBERSHIP_STATUS_TRANSITIONS: Readonly<
  Record<MembershipStatus, readonly MembershipStatus[]>
> = Object.freeze({
  invited: ["active", "revoked"],
  active: ["revoked"],
  revoked: ["active"],
});

export interface PlatformUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly phoneE164: string | null;
  readonly status: UserStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastLoginAt: string | null;
}

export interface Membership {
  readonly id: string;
  readonly userId: string;
  readonly tenantId: string;
  readonly primaryRole: string;
  readonly secondaryRoles: ReadonlyArray<string>;
  readonly status: MembershipStatus;
  readonly abacAttributes: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UserPage {
  readonly data: ReadonlyArray<PlatformUser>;
  readonly nextCursor: string | null;
}

export interface MembershipPage {
  readonly data: ReadonlyArray<Membership>;
  readonly nextCursor: string | null;
}

/**
 * `id` is optional and accepting it is the point of the registry, not a convenience: the ids that
 * need a row are ones the deployment has *already* committed to, in an
 * `--api-key key:role:tenant:principal` spec or an access-reviews `createdBy`. A server-minted id
 * could not satisfy either.
 */
export interface ProvisionUserBody {
  /** Nested, because the server's body is `{user, membership?}` and it is parsed `.strict()`. */
  readonly user: {
    readonly id?: string;
    readonly email: string;
    readonly displayName?: string;
    readonly phoneE164?: string;
  };
  /**
   * Optional, and when present it carries its own `tenantId` — *not* the caller's: a platform
   * operator provisions into tenants they are not a member of, so taking it from the credential
   * would file the grant under the wrong one.
   */
  readonly membership?: {
    readonly tenantId: string;
    readonly primaryRole: string;
    readonly secondaryRoles?: ReadonlyArray<string>;
    readonly status: MembershipStatus;
  };
}

/**
 * No `tenantId`. The server's grant body is `GrantMembershipInputSchema.omit({tenantId: true})`
 * parsed **`.strict()`**, so including it is not merely redundant — it is a 400. The tenant comes
 * from the path, which is where a scoped write's scope has to come from.
 */
export interface GrantMembershipBody {
  readonly userId: string;
  readonly primaryRole: string;
  readonly secondaryRoles?: ReadonlyArray<string>;
  /** No default: `invited` promises access and `active` grants it, and only `active` is notified. */
  readonly status: MembershipStatus;
}

export { PlatformError };

function platformPath(suffix: string): string {
  return `/api/v1/platform${suffix}`;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  if (!res.ok) await throwProblem(res);
  return (await res.json()) as T;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) await throwProblem(res);
  return (await res.json()) as T;
}

/**
 * There is deliberately **no `email` parameter**, and its absence is the point.
 *
 * `buildListUsersHandler` reads exactly `status`, `limit` and `cursor`, and `PostgresUserStore.list`
 * builds its `WHERE` from `status` alone — so a client sending `?email=` would get *every* user
 * back under a 200 indistinguishable from a filtered one. That is ADR-0359's class precisely: a
 * surface whose drop changes **which rows come back**, answered with the rows the caller asked to
 * exclude. Offering it here and letting the server drop it would be worse than not offering it, so
 * the list pages and an operator reaches a known user by id.
 *
 * Giving it a real email filter is a store change, a handler change and a row for
 * `pg-column-coverage` — a capability rather than part of this console's spine, and named as a
 * follow-up rather than faked.
 */
export async function listUsers(
  params: { status?: string; limit?: number; cursor?: string } = {},
): Promise<UserPage> {
  const p = new URLSearchParams();
  if (params.status && params.status !== "all") p.set("status", params.status);
  if (params.limit !== undefined) p.set("limit", String(params.limit));
  if (params.cursor) p.set("cursor", params.cursor);
  const qs = p.toString();
  const json = await getJson<{
    data?: PlatformUser[];
    page?: { nextCursor?: string | null };
  }>(platformPath(`/users${qs ? `?${qs}` : ""}`));
  return { data: json.data ?? [], nextCursor: json.page?.nextCursor ?? null };
}

export async function getUser(id: string): Promise<PlatformUser> {
  const json = await getJson<{ user: PlatformUser }>(
    platformPath(`/users/${encodeURIComponent(id)}`),
  );
  return json.user;
}

export async function provisionUser(body: ProvisionUserBody): Promise<PlatformUser> {
  const json = await postJson<{ user: PlatformUser }>(platformPath("/users"), body);
  return json.user;
}

export type UserAction = "suspend" | "reactivate" | "retire";

/** Which action reaches which status, so a page can ask the transition map before offering one. */
export const USER_ACTION_TARGET: Readonly<Record<UserAction, UserStatus>> = Object.freeze({
  suspend: "suspended",
  reactivate: "active",
  retire: "deleted",
});

export async function setUserStatus(id: string, action: UserAction): Promise<PlatformUser> {
  const json = await postJson<{ user: PlatformUser }>(
    platformPath(`/users/${encodeURIComponent(id)}/${action}`),
    {},
  );
  return json.user;
}

export async function listMembers(
  tenantId: string,
  params: { status?: string; limit?: number; cursor?: string } = {},
): Promise<MembershipPage> {
  const p = new URLSearchParams();
  if (params.status && params.status !== "all") p.set("status", params.status);
  if (params.limit !== undefined) p.set("limit", String(params.limit));
  if (params.cursor) p.set("cursor", params.cursor);
  const qs = p.toString();
  const json = await getJson<{
    data?: Membership[];
    page?: { nextCursor?: string | null };
  }>(platformPath(`/tenants/${encodeURIComponent(tenantId)}/members${qs ? `?${qs}` : ""}`));
  return { data: json.data ?? [], nextCursor: json.page?.nextCursor ?? null };
}

/**
 * The tenant comes from the path and never the body, which is the server's shape and worth keeping
 * here: there is deliberately **no** "which tenants does this user belong to" route, because that
 * read has no scope to name and would be owner-dependent by construction — correct as the table's
 * owner and empty as a non-owner. So memberships are always reached from the tenant side, which is
 * why they live on the tenant page and not on the user page.
 */
export async function grantMembership(
  tenantId: string,
  body: GrantMembershipBody,
): Promise<Membership> {
  // `body` and not `{...body, tenantId}`: the schema omits that key and is `.strict()`, so sending
  // the tenant twice is a 400 rather than a harmless repetition.
  const json = await postJson<{ membership: Membership }>(
    platformPath(`/tenants/${encodeURIComponent(tenantId)}/members`),
    body,
  );
  return json.membership;
}

export type MembershipAction = "activate" | "revoke";

export const MEMBERSHIP_ACTION_TARGET: Readonly<Record<MembershipAction, MembershipStatus>> =
  Object.freeze({ activate: "active", revoke: "revoked" });

export async function setMembershipStatus(
  tenantId: string,
  userId: string,
  action: MembershipAction,
): Promise<Membership> {
  const json = await postJson<{ membership: Membership }>(
    platformPath(
      `/tenants/${encodeURIComponent(tenantId)}/members/${encodeURIComponent(userId)}/${action}`,
    ),
    {},
  );
  return json.membership;
}

export interface CredentialSetResult {
  readonly userId: string;
  readonly credentialSet: boolean;
  readonly lockCleared: boolean;
  readonly detail: string;
}

/**
 * An operator sets another user's password — the route that did not exist before this console, and
 * the reason onboarding needed a shell.
 *
 * `confirmUserId` repeats the id the path already carries, because this overwrites a credential:
 * naming the wrong user locks a real person out *and* hands their account to whoever chose the
 * password. The server refuses a mismatch by name, so a page must make an operator supply it
 * rather than filling it in from the same variable — which would confirm nothing.
 *
 * It **cannot be aimed at the caller** (403 `self_not_permitted`): this route skips the
 * current-password proof, so using it on yourself would replace your own credential without
 * proving you hold it. `changeOwnPassword` is the other route.
 */
export async function setUserCredential(
  userId: string,
  password: string,
  confirmUserId: string,
): Promise<CredentialSetResult> {
  return postJson<CredentialSetResult>(
    platformPath(`/users/${encodeURIComponent(userId)}/credential`),
    { password, confirmUserId },
  );
}

export interface PasswordChangeResult {
  readonly credentialChanged: boolean;
  /** Always false, and said rather than omitted — see the route's own comment. */
  readonly sessionsRevoked: boolean;
  readonly detail: string;
}

/**
 * A person changes their own password. No grant and no subject: the authorisation is possession of
 * the current one, so the route takes no user id at all.
 */
export async function changeOwnPassword(
  currentPassword: string,
  newPassword: string,
): Promise<PasswordChangeResult> {
  return postJson<PasswordChangeResult>("/api/v1/account/password", {
    currentPassword,
    newPassword,
  });
}
