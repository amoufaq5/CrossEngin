import { z } from "zod";

export const OIDC_RESPONSE_TYPES = [
  "code",
  "id_token",
  "code id_token",
  "code token id_token",
  "id_token token",
] as const;
export type OidcResponseType = (typeof OIDC_RESPONSE_TYPES)[number];

export const OIDC_GRANT_TYPES = [
  "authorization_code",
  "refresh_token",
  "client_credentials",
  "urn:ietf:params:oauth:grant-type:device_code",
  "urn:ietf:params:oauth:grant-type:token-exchange",
] as const;
export type OidcGrantType = (typeof OIDC_GRANT_TYPES)[number];

export const OIDC_TOKEN_AUTH_METHODS = [
  "client_secret_basic",
  "client_secret_post",
  "client_secret_jwt",
  "private_key_jwt",
  "none",
] as const;
export type OidcTokenAuthMethod = (typeof OIDC_TOKEN_AUTH_METHODS)[number];

export const PKCE_METHODS = ["S256", "plain"] as const;
export type PkceMethod = (typeof PKCE_METHODS)[number];

export const ID_TOKEN_SIGN_ALGORITHMS = [
  "RS256",
  "RS384",
  "RS512",
  "ES256",
  "ES384",
  "EdDSA",
  "HS256",
  "PS256",
] as const;
export type IdTokenSignAlgorithm = (typeof ID_TOKEN_SIGN_ALGORITHMS)[number];

export const WEAK_ID_TOKEN_SIGN_ALGORITHMS: ReadonlySet<string> = new Set(["HS256"]);

export const STANDARD_OIDC_SCOPES = [
  "openid",
  "profile",
  "email",
  "address",
  "phone",
  "offline_access",
] as const;
export type StandardOidcScope = (typeof STANDARD_OIDC_SCOPES)[number];

export const OidcDiscoveryDocSchema = z.object({
  issuer: z.string().url(),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  userinfo_endpoint: z.string().url().optional(),
  jwks_uri: z.string().url(),
  end_session_endpoint: z.string().url().optional(),
  revocation_endpoint: z.string().url().optional(),
  introspection_endpoint: z.string().url().optional(),
  scopes_supported: z.array(z.string()).optional(),
  response_types_supported: z.array(z.string()).min(1),
  grant_types_supported: z.array(z.string()).optional(),
  id_token_signing_alg_values_supported: z.array(z.string()).min(1),
  subject_types_supported: z.array(z.enum(["public", "pairwise"])).min(1),
  claims_supported: z.array(z.string()).optional(),
  code_challenge_methods_supported: z.array(z.enum(PKCE_METHODS)).optional(),
  token_endpoint_auth_methods_supported: z.array(z.enum(OIDC_TOKEN_AUTH_METHODS)).optional(),
});
export type OidcDiscoveryDoc = z.infer<typeof OidcDiscoveryDocSchema>;

export const OidcAuthorizeRequestSchema = z
  .object({
    clientId: z.string().min(1),
    redirectUri: z.string().url(),
    responseType: z.enum(OIDC_RESPONSE_TYPES),
    scope: z.string().min(1),
    state: z.string().min(8).max(512),
    nonce: z.string().min(8).max(512).optional(),
    codeChallenge: z.string().min(43).max(128).optional(),
    codeChallengeMethod: z.enum(PKCE_METHODS).optional(),
    prompt: z.enum(["none", "login", "consent", "select_account"]).optional(),
    loginHint: z.string().max(256).optional(),
    maxAge: z.number().int().min(0).optional(),
    acrValues: z.array(z.string()).optional(),
  })
  .superRefine((r, ctx) => {
    const requiresNonce = r.responseType.includes("id_token") || r.responseType === "code";
    if (requiresNonce && !r.nonce) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nonce"],
        message: "nonce required when response_type includes id_token or code",
      });
    }
    if (r.codeChallenge && !r.codeChallengeMethod) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["codeChallengeMethod"],
        message: "codeChallengeMethod required when codeChallenge is set",
      });
    }
    if (r.codeChallenge && r.codeChallengeMethod === "plain") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["codeChallengeMethod"],
        message: "plain PKCE method is forbidden, use S256",
      });
    }
  });
export type OidcAuthorizeRequest = z.infer<typeof OidcAuthorizeRequestSchema>;

export const OidcTokenResponseSchema = z.object({
  accessToken: z.string().min(1),
  tokenType: z.enum(["Bearer", "DPoP"]),
  expiresIn: z.number().int().min(1),
  idToken: z.string().min(1).optional(),
  refreshToken: z.string().min(1).optional(),
  scope: z.string().optional(),
});
export type OidcTokenResponse = z.infer<typeof OidcTokenResponseSchema>;

export const OidcIdTokenClaimsSchema = z
  .object({
    iss: z.string().min(1),
    sub: z.string().min(1),
    aud: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
    exp: z.number().int(),
    iat: z.number().int(),
    nonce: z.string().optional(),
    auth_time: z.number().int().optional(),
    azp: z.string().optional(),
    nbf: z.number().int().optional(),
    acr: z.string().optional(),
    amr: z.array(z.string()).optional(),
  })
  .passthrough();
export type OidcIdTokenClaims = z.infer<typeof OidcIdTokenClaimsSchema>;

export const isWeakIdTokenSignAlgorithm = (algorithm: string): boolean =>
  WEAK_ID_TOKEN_SIGN_ALGORITHMS.has(algorithm);

export const isPublicClient = (config: {
  isPublicClient: boolean;
  clientSecretSha256: string | null;
}): boolean => config.isPublicClient && config.clientSecretSha256 === null;

export const isValidRedirectUri = (uri: string, allowed: readonly string[]): boolean =>
  allowed.includes(uri);

export interface IdTokenValidationOptions {
  readonly expectedIssuer: string;
  readonly expectedAudience: string;
  readonly expectedNonce?: string;
  readonly now: Date;
  readonly clockSkewSeconds?: number;
  readonly maxAuthAgeSeconds?: number;
}

export interface IdTokenValidationFailure {
  readonly ok: false;
  readonly reason: string;
}

export interface IdTokenValidationSuccess {
  readonly ok: true;
}

export type IdTokenValidationResult = IdTokenValidationSuccess | IdTokenValidationFailure;

export const validateIdTokenClaims = (
  claims: OidcIdTokenClaims,
  options: IdTokenValidationOptions,
): IdTokenValidationResult => {
  const skew = (options.clockSkewSeconds ?? 60) * 1000;
  const nowMs = options.now.getTime();
  if (claims.iss !== options.expectedIssuer) {
    return { ok: false, reason: "issuer_mismatch" };
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(options.expectedAudience)) {
    return { ok: false, reason: "audience_mismatch" };
  }
  if (claims.exp * 1000 + skew <= nowMs) {
    return { ok: false, reason: "id_token_expired" };
  }
  if (claims.iat * 1000 - skew > nowMs) {
    return { ok: false, reason: "id_token_iat_in_future" };
  }
  if (claims.nbf !== undefined && claims.nbf * 1000 - skew > nowMs) {
    return { ok: false, reason: "id_token_not_yet_valid" };
  }
  if (options.expectedNonce !== undefined && claims.nonce !== options.expectedNonce) {
    return { ok: false, reason: "nonce_mismatch" };
  }
  if (
    options.maxAuthAgeSeconds !== undefined &&
    claims.auth_time !== undefined &&
    (nowMs - claims.auth_time * 1000) / 1000 > options.maxAuthAgeSeconds
  ) {
    return { ok: false, reason: "auth_age_exceeded" };
  }
  return { ok: true };
};

export const parseScopeString = (scope: string): readonly string[] =>
  scope.split(/\s+/).filter((s) => s.length > 0);

export const containsOpenidScope = (scope: string): boolean =>
  parseScopeString(scope).includes("openid");
