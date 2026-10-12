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
   * `principalRoles` reads `grantedScopes[0]` and `secondaryRoles` is populated by nothing
   * anywhere, so a session holds exactly **one** manifest role however many scopes travel here.
   * The minter therefore stamps one, read from the membership, rather than a list that would read
   * as more than it is.
   */
  readonly scope: string;
  readonly iat: number;
  readonly nbf: number;
  readonly exp: number;
}

export interface MintSessionTokenInput {
  readonly issuer: string;
  readonly audience: string;
  readonly userId: string;
  readonly tenantId: string;
  readonly role: string;
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
    scope: input.role,
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
