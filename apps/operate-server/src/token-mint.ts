import { signEd25519 } from "@crossengin/crypto";

/**
 * Mints the session token `POST /v1/auth/token` hands back.
 *
 * Pure: a clock and the signing material in, a compact JWS out. No SQL, no environment, no
 * network. `credential-auth-env.ts` resolves the key; `credential-store.ts` answers who the user
 * is; this module only turns an answer into bytes.
 *
 * **Nothing in the gateway changed to accept these.** Measured against the committed tree before
 * this module existed: a token carrying `{iss, aud, sub, tenant_id, scope, iat, nbf, exp}`, signed
 * Ed25519 with a kid the JWKS knows, is `authenticated` and drives identity, tenant scoping, RBAC
 * and per-field classification redaction. Three tokens differing only in `scope` returned exactly
 * `erp-core`'s declared read grant on `Employee.work_email` -- present for `erp_admin` and
 * `hr_manager`, absent for `erp_viewer`. So the claim set below is not a new protocol; it is the
 * one the verifier has always read, written down.
 */

/** The claims the gateway's verifier actually consumes. Anything else would be inert. */
export interface SessionTokenClaims {
  readonly iss: string;
  readonly aud: string;
  /**
   * The user's `meta.users.id`, as a UUID.
   *
   * It must be the real row id and not an email or a username: `subjectToUuid` passes a UUID
   * through unchanged and sha256-hashes anything else into a v5-shaped UUID that exists in no
   * table -- which would leave `principalId` pointing at nothing and break every per-person
   * surface keyed on it, including the ABAC attribute lookup against
   * `meta.user_tenant_membership` and `meta.notification_read_states`' foreign key.
   */
  readonly sub: string;
  readonly tenant_id: string;
  /**
   * Space-delimited, read by the authenticate stage into `ctx.authScopes` and then taken as the
   * principal's `grantedScopes`.
   *
   * **The membership's whole role list, primary first** (ADR-0369). It used to be one role, on the
   * true observation that `principalRoles` read `grantedScopes[0]` and dropped the rest -- so the
   * minter stamped one rather than a list that would read as more than it was. Both halves of that
   * are closed now: the reader returns the tail as `secondaryRoles` and this claim carries it.
   *
   * `scp`, the array claim the gateway reads *after* this one, was the alternative and is refused:
   * `scope` wins where both are present, so emitting both leaves the array dead, and emitting
   * `scp` alone yields a token this gateway reads correctly and nothing else does. The delimiter
   * hazard is shared with every externally-issued token and so needs `sessionScope`'s refusal
   * either way.
   */
  readonly scope: string;
  readonly iat: number;
  readonly nbf: number;
  readonly exp: number;
}

/**
 * The roles one session carries, as the membership row holds them.
 *
 * `secondaryRoles` is **required** and `[]` is the claim this membership grants none -- a fact the
 * row really carries, since `secondary_roles` is `TEXT[] NOT NULL`. Optional would let a caller
 * forget the list with the type still valid, which is the shape the increment that introduced this
 * type exists to close (ADR-0330's rule, ADR-0369's defect).
 *
 * Deliberately a named pair and not `readonly string[]` with the primary first: which role is
 * primary is consequential and not merely ordinal. It is the one `UiViewer.primaryRole` shows and
 * the only one an `--api-key key:role:tenant` spec can express.
 *
 * It is **not** the position that decides whether a grant is total, and this increment is what
 * made that false: `resolveEffectiveRoles` visits the primary and then loops the secondaries, so a
 * declared secondary beside an undeclared primary carries that secondary's grants. Measured on
 * resolved `erp-core`: an undeclared primary with `["hr_manager"]` reaches 26 of 255 (entity,
 * operation) pairs, exactly `hr_manager` alone, where the same primary with no secondary reaches
 * 0. `membership-role-fence.ts` carries the qualifier that follows from it.
 */
export interface SessionRoles {
  readonly primaryRole: string;
  readonly secondaryRoles: readonly string[];
}

export interface MintSessionTokenInput {
  readonly issuer: string;
  readonly audience: string;
  readonly userId: string;
  readonly tenantId: string;
  readonly roles: SessionRoles;
  readonly now: Date;
  readonly lifetimeSeconds: number;
  readonly kid: string;
  readonly signingSeedBase64: string;
  readonly publicKeyBase64: string;
}

export interface MintedSessionToken {
  readonly token: string;
  readonly expiresAt: string;
  readonly claims: SessionTokenClaims;
}

/**
 * How far before `iat` the token is declared valid.
 *
 * The gateway's `clockSkewSeconds` is fixed at 30 and `buildOperateGateway` does not forward it,
 * so no flag can move it. A replica whose clock sits 31 s ahead of the gateway's would answer
 * `not_yet_valid_token` for a token it had just minted, and the symptom -- a login that succeeds
 * and whose token is immediately refused -- names neither clock. 60 s is what the repository's own
 * JWT fixture already uses, and it costs nothing: a token valid one minute early is not a weaker
 * token, where one valid one minute late is an outage.
 */
export const TOKEN_NOT_BEFORE_SKEW_SECONDS = 60;

/** Floor and ceiling for `--session-token-ttl`. */
export const MIN_SESSION_TOKEN_SECONDS = 60;
export const MAX_SESSION_TOKEN_SECONDS = 86_400;
export const DEFAULT_SESSION_TOKEN_SECONDS = 3_600;

const B64URL = (bytes: Buffer): string =>
  bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const B64URL_JSON = (value: unknown): string => B64URL(Buffer.from(JSON.stringify(value), "utf8"));

/**
 * The `scope` claim's one delimiter, the same single space the gateway splits on
 * (`runtime.ts`: `scope.split(" ").filter((s) => s.length > 0)`).
 *
 * A constant so the join has one spelling and a test can pin it against the gateway's reader. It
 * is **not** what the refusal below is derived from, and a comment here used to claim it was: the
 * fence is `/\s/`, which references this constant nowhere, so changing this would change the join
 * and leave the fence covering a different character — exactly the failure that claim said the
 * constant prevented. The fence is a deliberate superset of the delimiter instead; see
 * `roleNameHasNoWhitespace`.
 */
export const SCOPE_DELIMITER = " ";

const ROLE_NAME_WHITESPACE_RE = /\s/;

/**
 * Whether a role name is free of the character the claim is delimited by.
 *
 * Deliberately **narrower** than `roleNameIsScopeSafe` and exported separately, because a zod
 * field already answers emptiness with `.min(1)` and a refinement beside it must not answer it
 * again: measured on this deployment's zod (3.25.76), a failing `.min(1)` marks the result *dirty*
 * rather than aborting it, so the refinement still runs and `""` comes back carrying **both**
 * `too_small` and a message saying the name "may not contain whitespace" — about a value that
 * contains none. A comment here used to assert that could not happen. It is the class this module
 * is full of, in a string, so the two halves of the rule are two functions and each reader takes
 * the one it needs.
 *
 * The set is `/\s/` and the delimiter is one character, U+0020, so this is a **conservative
 * superset** and not a derivation of the delimiter: measured against the gateway's real reader
 * (`scope.split(" ").filter((s) => s.length > 0)`), U+0020 is the only character that breaks the
 * round trip, and a tab, NBSP, U+3000 or a BOM would survive it and are refused anyway. Refusing a
 * name that would have worked is the safe direction and the cost is nil — 0 of the 130 role names
 * declared across the seven packs contains whitespace of any kind.
 */
export function roleNameHasNoWhitespace(role: string): boolean {
  return !ROLE_NAME_WHITESPACE_RE.test(role);
}

/**
 * Whether a role name survives a round trip through the `scope` claim at all.
 *
 * The total form: non-empty **and** free of whitespace, because an empty name is dropped by the
 * gateway's `.filter((s) => s.length > 0)` and so would promote the next role to the position it
 * vacated. `sessionScope` wants this one, having no `.min(1)` in front of it;
 * `platform-users.ts`'s field schema wants the narrow half above.
 *
 * One rule, composed, with two messages — because the readers differ: a 400 names the consequence
 * for the operator typing the grant, and `sessionScope`'s throw names the stored role for the
 * operator reading a log. Before this convergence the *rule* was spelled twice, which is the shape
 * that eventually disagrees.
 */
export function roleNameIsScopeSafe(role: string): boolean {
  return role.length > 0 && roleNameHasNoWhitespace(role);
}

/**
 * The membership's roles as one `scope` claim: primary first, de-duplicated, secondary order
 * preserved.
 *
 * De-duplicated because a membership may legitimately name its primary in `secondary_roles` and
 * every downstream reader already treats the list as a set (`resolveEffectiveRoles` visits a `Set`,
 * `UiViewer.roles` de-dupes, the platform gates are `.some`). The duplicate would change no
 * answer; it would only make the token say the same thing twice.
 *
 * **Throws on a role name carrying whitespace, and that is the fence rather than a validation
 * nicety.** `RoleNameSchema` is `z.string().min(1)` and `ManifestSchema.roles` is keyed by
 * `z.string()`, so `"hr manager"` is a legal role name -- and the claim is space-delimited, so it
 * would arrive as `["hr", "manager"]`: two roles, neither declared, in place of the one that was
 * granted. Silently dropping or mangling it is exactly the class ADR-0369 closes, one layer down,
 * so the only honest answers are to refuse or to change the vehicle, and the vehicle is the claim
 * the verifier reads.
 *
 * It throws where `platform-users.ts` answers 400, and the split is ADR-0348's: the grant is a
 * property of the request and is refused where the operator can act on it, while this is the
 * backstop for a row stored before that fence existed. A throw here surfaces as a failed login for
 * that one user with the role named in the log, which is narrower than refusing the row on read --
 * that would make the membership unreadable and take every surface keyed on it down with it.
 *
 * `--api-key key:role:tenant` is unaffected and deliberately so: it sets `grantedScopes:
 * [spec.role]` with no split, so a role name with a space is legitimately holdable by an api-key
 * and a refusal in the kernel would refuse a configuration that works.
 */
export function sessionScope(roles: SessionRoles): string {
  const deduped = dedupedSessionRoles(roles);
  return [deduped.primaryRole, ...deduped.secondaryRoles].join(SCOPE_DELIMITER);
}

/**
 * The role list as the claim will carry it: primary first, de-duplicated, secondary order
 * preserved — and the same refusal, because the de-duplication and the fence are one pass over
 * one list.
 *
 * Exported so the login's 200 body can report **what was signed** rather than what the row held.
 * The two diverge in exactly one case and it was live on the first pass: a membership naming its
 * primary in `secondary_roles` has that duplicate removed from the claim, so echoing the row gave
 * a body claiming a secondary role the token does not carry. A field added so the body would not
 * *understate* the session must not be allowed to *misstate* it, and the only way to be sure is
 * for both to read one function.
 */
export function dedupedSessionRoles(roles: SessionRoles): SessionRoles {
  const ordered: string[] = [];
  for (const role of [roles.primaryRole, ...roles.secondaryRoles]) {
    if (!roleNameIsScopeSafe(role)) {
      throw new Error(
        `role name ${JSON.stringify(role)} cannot be carried by a session: the token's scope` +
          " claim is space-delimited, so a name that is empty or contains whitespace is read as a" +
          " different set of roles than was granted",
      );
    }
    if (!ordered.includes(role)) ordered.push(role);
  }
  // `ordered[0]` is `roles.primaryRole`: the loop pushes it first and the refusal above has
  // already established it is non-empty, so the fallback is unreachable rather than a default.
  return { primaryRole: ordered[0] ?? roles.primaryRole, secondaryRoles: ordered.slice(1) };
}

/**
 * The compact JWS. `EdDSA` with a `kid`, which is the only algorithm the verifier accepts and the
 * only one `@crossengin/crypto` signs with.
 *
 * `signEd25519` returns standard base64 and a JWS signature is base64url, so the third segment is
 * re-encoded. Measured: the verifier would accept *either*, because its base64url-to-standard step
 * is a no-op on standard base64 -- so this conversion is for the spec and for any other consumer,
 * not to make our own gateway work. Worth knowing before someone "simplifies" it on the evidence
 * that both pass here.
 *
 * The signature covers `${headerB64}.${payloadB64}` as the literal segment substrings the token
 * carries, so the bytes signed must be the bytes transmitted. That is why `signingInput` is built
 * once and both signed and emitted, rather than the claims being serialized twice.
 */
export function mintSessionToken(input: MintSessionTokenInput): MintedSessionToken {
  if (
    !Number.isInteger(input.lifetimeSeconds) ||
    input.lifetimeSeconds < MIN_SESSION_TOKEN_SECONDS ||
    input.lifetimeSeconds > MAX_SESSION_TOKEN_SECONDS
  ) {
    throw new Error(
      `session token lifetime must be an integer between ${MIN_SESSION_TOKEN_SECONDS.toString()}` +
        ` and ${MAX_SESSION_TOKEN_SECONDS.toString()} seconds, got ${String(input.lifetimeSeconds)}`,
    );
  }
  const iat = Math.floor(input.now.getTime() / 1000);
  const claims: SessionTokenClaims = {
    iss: input.issuer,
    aud: input.audience,
    sub: input.userId,
    tenant_id: input.tenantId,
    scope: sessionScope(input.roles),
    iat,
    nbf: iat - TOKEN_NOT_BEFORE_SKEW_SECONDS,
    exp: iat + input.lifetimeSeconds,
  };
  const header = { alg: "EdDSA", typ: "JWT", kid: input.kid };
  const signingInput = `${B64URL_JSON(header)}.${B64URL_JSON(claims)}`;
  const signature = signEd25519(input.signingSeedBase64, input.publicKeyBase64, signingInput);
  return {
    token: `${signingInput}.${B64URL(Buffer.from(signature, "base64"))}`,
    expiresAt: new Date(claims.exp * 1000).toISOString(),
    claims,
  };
}
