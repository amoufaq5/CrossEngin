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

/**
 * Derived from `UserStatus` rather than written out, because the type this follows is already stale:
 * `TenantCounts` in lib/platform.ts names four statuses against `TENANT_STATUSES`' five, so it has
 * no figure for `pending_deletion` and the tenant console has no tile for it — the one state in
 * which an operator most wants to find a tenant, which is the same drift this page's
 * `STATUS_FILTERS` is derived to avoid. The server's `UserStatusCounts` is this shape exactly, so a
 * fourth user status cannot leave this type asserting something false about the wire.
 */
export type UserCounts = Readonly<Record<UserStatus, number>> & { readonly total: number };

export const ROLE_WARNING_POSITIONS = ["primary", "secondary"] as const;
export type RoleWarningPosition = (typeof ROLE_WARNING_POSITIONS)[number];

/**
 * The two verdicts that surface. `declared` is the server's silent third, and it is deliberately
 * absent here rather than present-and-filtered: a warning list carrying it would make "this role is
 * fine" and "this role grants nothing" two members of one list for a reader to tell apart.
 */
export const ROLE_WARNING_VERDICTS = ["not_declared", "unresolved"] as const;
export type RoleWarningVerdict = (typeof ROLE_WARNING_VERDICTS)[number];

/**
 * One role in one position that the grant accepted and the tenant's manifest does not declare.
 *
 * The two verdicts are **not** two gradings of one fact. `not_declared` is a statement about the
 * role — the manifest was read, this name is not in it, so the grant resolves to nothing at serve
 * time — and it carries `declaredRoles`. `unresolved` is a statement about the deployment: nothing
 * could be read, so it says nothing at all about this role, and `declaredRoles` is `null` because
 * there is no list to show rather than an empty one.
 *
 * `declaredRoles` is a **remedy only where `position` is `primary`**, and it arrives on both. A
 * secondary role reaches no authorization decision whether declared or not, so a renderer that
 * offers the names beside a secondary warning promises something the server's own `detail`
 * deliberately does not — see `RoleWarnings`, which is where that gate lives.
 */
export interface RoleWarning {
  readonly position: RoleWarningPosition;
  readonly role: string;
  readonly verdict: RoleWarningVerdict;
  readonly detail: string;
  readonly declaredRoles: readonly string[] | null;
}

/**
 * What a write's `roleWarnings` came back as. `null` is **not** "none": it is "this response
 * carried no readable answer", which a deployment running a binary from before the fence produces,
 * and which the two call sites render as its own sentence rather than as silence.
 *
 * The server sends `[]` and never an omitted field for exactly this reason, so `null` here means
 * the two ends disagree about the shape — a different fact from a clean grant, and the one a reader
 * must not be shown as a clean grant (ADR-0331).
 */
export type RoleWarnings = ReadonlyArray<RoleWarning> | null;

export interface ProvisionUserResult {
  readonly user: PlatformUser;
  readonly roleWarnings: RoleWarnings;
}

export interface GrantMembershipResult {
  readonly membership: Membership;
  readonly roleWarnings: RoleWarnings;
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

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry: unknown) => typeof entry === "string");
}

/**
 * Built from checked parts rather than asserted with a predicate, so nothing here is an annotation
 * standing in for a parse (ADR-0362). `find` does the membership test and the narrowing in one
 * step, which is what keeps `position` and `verdict` from being a cast over an `includes`.
 */
function readRoleWarning(value: unknown): RoleWarning | null {
  if (value === null || typeof value !== "object") return null;
  const doc = value as Record<string, unknown>;
  const position = ROLE_WARNING_POSITIONS.find((p) => p === doc.position);
  const verdict = ROLE_WARNING_VERDICTS.find((v) => v === doc.verdict);
  if (position === undefined || verdict === undefined) return null;
  const { role, detail } = doc;
  if (typeof role !== "string" || typeof detail !== "string") return null;
  // Absent is refused along with the wrong type: the server sends the key on both verdicts, so a
  // missing one is a shape this reader does not know rather than "no declared roles".
  const declared = doc.declaredRoles;
  const declaredRoles = declared === null ? null : isStringArray(declared) ? declared : undefined;
  if (declaredRoles === undefined) return null;
  // The pairing is refused, not just the type. `not_declared` is only reachable on the server from a
  // catalog it *read*, so it always carries the names it was compared against — and a `null` there
  // is the pair ADR-0331 keeps apart arriving half-and-half, which a renderer can only resolve by
  // treating "nothing was read" as "this manifest declares no role at all": a claim standing in for
  // a gap, in the sentence an operator acts on. Refusing it makes the whole set read as unreadable
  // and say that instead, which is the one honest answer available.
  if (verdict === "not_declared" && declaredRoles === null) return null;
  return { position, verdict, role, detail, declaredRoles };
}

/**
 * The whole list or `null`, and **never a readable prefix**.
 *
 * One unreadable element refuses the set, because the alternative is showing a shorter list under a
 * banner that reads as complete — the operator would believe they had seen every warning. `null`
 * renders as "the answer could not be read", which is the one honest thing to say when part of it
 * cannot be: ADR-0344's rule that a set whose correspondence is broken fails whole rather than
 * standing behind its prefix.
 */
function readRoleWarnings(doc: Record<string, unknown>): RoleWarnings {
  const raw: unknown = doc.roleWarnings;
  if (!Array.isArray(raw)) return null;
  const warnings: RoleWarning[] = [];
  for (const entry of raw as readonly unknown[]) {
    const warning = readRoleWarning(entry);
    if (warning === null) return null;
    warnings.push(warning);
  }
  return warnings;
}

/**
 * One POST read two ways: the record through the type parameter, as every other helper here does,
 * and `roleWarnings` through a parse.
 *
 * The split is deliberate and is the account page's reason one surface over: a `<T>` cast is
 * tolerable where a missing field renders as a blank, and not where the field decides which of two
 * opposite sentences a reader is shown — here, "this role grants nothing" against nothing at all.
 */
async function postJsonWithRoleWarnings<T>(
  path: string,
  body: unknown,
): Promise<{ readonly body: T; readonly roleWarnings: RoleWarnings }> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) await throwProblem(res);
  const parsed: unknown = await res.json();
  const doc: Record<string, unknown> =
    parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  return { body: doc as T, roleWarnings: readRoleWarnings(doc) };
}

/**
 * `email` is an **exact** match, folded to lower case by the server before it is compared.
 *
 * Exact and not a prefix because the store's `WHERE email = $1` is what `users_email_key` serves.
 * That constraint's index is a default-collation B-tree, which a `LIKE 'x%'` cannot use and an
 * `ILIKE` never can, so a prefix or substring filter would be a sequential scan with a comparison
 * per row — issued from a box somebody types into. A partial address therefore matches nothing at
 * all, which is why the page applies it on submit rather than per keystroke: per keystroke it would
 * answer "no such user" about every address still being typed.
 *
 * Sent only when non-empty, and that guard is **not** what makes an empty one safe: the handler
 * reads every parameter through `suppliedQueryValue`, which maps a zero-length value to
 * `undefined`, so `?email=` is already read as *no filter* rather than as a comparison against the
 * empty address. It is dropped here for the reason `status` and `cursor` are dropped beside it — a
 * parameter carrying nothing is not a filter, and a URL that names one invites the next reader to
 * believe the guard is load-bearing when the server has its own.
 */
export async function listUsers(
  params: { status?: string; email?: string; limit?: number; cursor?: string } = {},
): Promise<UserPage> {
  const p = new URLSearchParams();
  if (params.status && params.status !== "all") p.set("status", params.status);
  if (params.email !== undefined && params.email !== "") p.set("email", params.email);
  if (params.limit !== undefined) p.set("limit", String(params.limit));
  if (params.cursor) p.set("cursor", params.cursor);
  const qs = p.toString();
  const json = await getJson<{
    data?: PlatformUser[];
    page?: { nextCursor?: string | null };
  }>(platformPath(`/users${qs ? `?${qs}` : ""}`));
  return { data: json.data ?? [], nextCursor: json.page?.nextCursor ?? null };
}

/**
 * The per-status census, under its **own** route and its own grant.
 *
 * Deliberately not folded into `platformStats()` beside it: that one is `/v1/platform/stats` over
 * the tenant store under `--platform-admin-role`, so sharing a call would make a user census need
 * the tenant-administration grant. The two are separate reads because they are separately gated.
 */
export async function fetchUserCounts(): Promise<UserCounts> {
  const json = await getJson<{ counts: UserCounts }>(platformPath("/users/stats"));
  return json.counts;
}

export async function getUser(id: string): Promise<PlatformUser> {
  const json = await getJson<{ user: PlatformUser }>(
    platformPath(`/users/${encodeURIComponent(id)}`),
  );
  return json.user;
}

/**
 * `roleWarnings` is read here and not only where a membership is sent, because whether this call
 * *can* produce one is the server's business and not this helper's: the route checks the roles
 * exactly when the body carries a membership, so a provision form that later grows one gets the
 * warnings without this function being touched.
 */
export async function provisionUser(body: ProvisionUserBody): Promise<ProvisionUserResult> {
  const res = await postJsonWithRoleWarnings<{ user: PlatformUser }>(platformPath("/users"), body);
  return { user: res.body.user, roleWarnings: res.roleWarnings };
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
): Promise<GrantMembershipResult> {
  // `body` and not `{...body, tenantId}`: the schema omits that key and is `.strict()`, so sending
  // the tenant twice is a 400 rather than a harmless repetition.
  const res = await postJsonWithRoleWarnings<{ membership: Membership }>(
    platformPath(`/tenants/${encodeURIComponent(tenantId)}/members`),
    body,
  );
  return { membership: res.body.membership, roleWarnings: res.roleWarnings };
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
  /**
   * The status the write saw, as the row held it — a bare `string` and deliberately not
   * `UserStatus`. `CredentialRecord.status` is itself unparsed on the server, because the column's
   * CHECK is the only thing constraining it, so a row written by a later binary arrives here as a
   * status this one has no name for. Typing it narrower would be an annotation standing in for a
   * parse, which is the class the repo keeps finding.
   */
  readonly subjectStatus: string;
  /**
   * Whether a login would still be refused for this user.
   *
   * **On the wire rather than inferred from the row the page already holds**, because the row and
   * the write can disagree: the handler reads `meta.users` again, so a suspension or a retirement
   * landing between this page's load and this submit is a fact only the response carries. Re-deriving
   * it from the stale row is how a console comes to report a working credential for an account the
   * login refuses outright — a success message for a password that cannot be used, which is the
   * falsely-reassuring direction and the one worth spending a field to close.
   */
  readonly loginBlocked: boolean;
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
