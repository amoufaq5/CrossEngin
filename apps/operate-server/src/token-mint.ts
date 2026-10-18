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
 * A constant rather than a literal in the join, because the refusal below and the join must be
 * about the same character: a fence against a delimiter spelled separately from the delimiter is a
 * fence against a different one.
 */
export const SCOPE_DELIMITER = " ";

const ROLE_NAME_WHITESPACE_RE = /\s/;

/**
 * Whether a role name survives a round trip through the `scope` claim.
 *
 * It lives here, beside the delimiter it is about, and `platform-users.ts` imports it for its
 * grant-time refusal — **one predicate, two messages**. The messages differ because the readers
 * do: a 400 names the consequence for the operator typing the grant, and `sessionScope`'s throw
 * names the stored role for the operator reading a log. The *rule* may not differ, and before this
 * convergence it was spelled twice, which is the shape that eventually disagrees.
 */
export function roleNameIsScopeSafe(role: string): boolean {
  return role.length > 0 && !ROLE_NAME_WHITESPACE_RE.test(role);
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
  return ordered.join(SCOPE_DELIMITER);
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
