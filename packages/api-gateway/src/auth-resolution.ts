import { z } from "zod";

export const AUTH_SCHEMES = [
  "bearer_jwt",
  "bearer_opaque",
  "api_key_header",
  "api_key_query",
  "basic",
  "mtls",
  "hmac_signature",
  "anonymous",
] as const;
export type AuthScheme = (typeof AUTH_SCHEMES)[number];

export const STRONG_AUTH_SCHEMES: ReadonlySet<AuthScheme> = new Set([
  "bearer_jwt",
  "mtls",
  "hmac_signature",
]);

export const SCHEMES_REQUIRING_HTTPS: ReadonlySet<AuthScheme> = new Set([
  "bearer_jwt",
  "bearer_opaque",
  "api_key_header",
  "api_key_query",
  "basic",
  "hmac_signature",
]);

export const AUTH_OUTCOMES = [
  "anonymous",
  "authenticated",
  "credential_malformed",
  "credential_not_found",
  "invalid_signature",
  "expired_token",
  "not_yet_valid_token",
  "audience_mismatch",
  "issuer_mismatch",
  "tenant_mismatch",
  "principal_not_found",
  "principal_disabled",
  "principal_locked",
  "scope_insufficient",
  "mfa_required",
  "weak_tls_rejected",
] as const;
export type AuthOutcome = (typeof AUTH_OUTCOMES)[number];

export const AUTH_SUCCESS_OUTCOMES: ReadonlySet<AuthOutcome> = new Set([
  "anonymous",
  "authenticated",
]);

export const ParsedAuthCredentialSchema = z
  .object({
    scheme: z.enum(AUTH_SCHEMES),
    presentedAt: z.string().datetime({ offset: true }),
    tokenSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    apiKeyPrefix: z
      .string()
      .regex(/^ce_(live|test)_[A-Za-z0-9]{8}$/)
      .nullable(),
    apiKeySecretSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    basicUsername: z.string().max(200).nullable(),
    basicPasswordSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    clientCertSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    hmacKeyId: z.string().max(120).nullable(),
    hmacSignatureSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    hmacSignedAt: z.string().datetime({ offset: true }).nullable(),
    jwtIssuer: z.string().max(500).nullable(),
    jwtAudience: z.array(z.string().max(500)).default([]),
    jwtSubject: z.string().max(500).nullable(),
    jwtExpiresAt: z.string().datetime({ offset: true }).nullable(),
    jwtNotBefore: z.string().datetime({ offset: true }).nullable(),
    jwtScope: z.array(z.string().max(200)).default([]),
  })
  .superRefine((c, ctx) => {
    if (c.scheme === "bearer_jwt" && c.tokenSha256 === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tokenSha256"],
        message: "bearer_jwt requires tokenSha256",
      });
    }
    if (c.scheme === "api_key_header" || c.scheme === "api_key_query") {
      if (c.apiKeyPrefix === null || c.apiKeySecretSha256 === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["apiKeyPrefix"],
          message: "api_key schemes require apiKeyPrefix + apiKeySecretSha256",
        });
      }
    }
    if (c.scheme === "basic") {
      if (c.basicUsername === null || c.basicPasswordSha256 === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["basicUsername"],
          message:
            "basic auth requires basicUsername + basicPasswordSha256",
        });
      }
    }
    if (c.scheme === "mtls" && c.clientCertSha256 === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["clientCertSha256"],
        message: "mtls requires clientCertSha256",
      });
    }
    if (c.scheme === "hmac_signature") {
      if (
        c.hmacKeyId === null ||
        c.hmacSignatureSha256 === null ||
        c.hmacSignedAt === null
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["hmacSignatureSha256"],
          message:
            "hmac_signature requires hmacKeyId + hmacSignatureSha256 + hmacSignedAt",
        });
      }
    }
  });
export type ParsedAuthCredential = z.infer<typeof ParsedAuthCredentialSchema>;

export interface AuthResolutionInput {
  readonly credential: ParsedAuthCredential;
  readonly schemeAllowed: boolean;
  readonly tlsAcceptable: boolean;
  readonly now: Date;
  readonly expectedIssuer: string | null;
  readonly expectedAudience: string | null;
  readonly clockSkewSeconds: number;
  readonly hmacSignatureMaxAgeSeconds: number;
}

export interface AuthResolutionResult {
  readonly outcome: AuthOutcome;
  readonly reason: string;
}

export const resolveAuth = (
  input: AuthResolutionInput,
): AuthResolutionResult => {
  if (!input.tlsAcceptable) {
    return {
      outcome: "weak_tls_rejected",
      reason: "tls_below_acceptable_floor",
    };
  }
  if (!input.schemeAllowed) {
    return {
      outcome: "credential_malformed",
      reason: `scheme_${input.credential.scheme}_not_allowed`,
    };
  }
  if (input.credential.scheme === "anonymous") {
    return { outcome: "anonymous", reason: "no_credential_presented" };
  }
  const nowMs = input.now.getTime();
  const skewMs = input.clockSkewSeconds * 1000;
  if (input.credential.scheme === "bearer_jwt") {
    if (input.credential.jwtExpiresAt !== null) {
      const expMs = Date.parse(input.credential.jwtExpiresAt);
      if (expMs + skewMs <= nowMs) {
        return { outcome: "expired_token", reason: "jwt_exp_passed" };
      }
    }
    if (input.credential.jwtNotBefore !== null) {
      const nbfMs = Date.parse(input.credential.jwtNotBefore);
      if (nbfMs - skewMs > nowMs) {
        return {
          outcome: "not_yet_valid_token",
          reason: "jwt_nbf_in_future",
        };
      }
    }
    if (
      input.expectedIssuer !== null &&
      input.credential.jwtIssuer !== input.expectedIssuer
    ) {
      return { outcome: "issuer_mismatch", reason: "jwt_iss_mismatch" };
    }
    if (
      input.expectedAudience !== null &&
      !input.credential.jwtAudience.includes(input.expectedAudience)
    ) {
      return {
        outcome: "audience_mismatch",
        reason: "jwt_aud_does_not_include_expected",
      };
    }
  }
  if (input.credential.scheme === "hmac_signature") {
    if (input.credential.hmacSignedAt !== null) {
      const signedMs = Date.parse(input.credential.hmacSignedAt);
      const ageMs = nowMs - signedMs;
      if (ageMs > input.hmacSignatureMaxAgeSeconds * 1000) {
        return {
          outcome: "expired_token",
          reason: "hmac_signature_too_old",
        };
      }
      if (ageMs < -skewMs) {
        return {
          outcome: "not_yet_valid_token",
          reason: "hmac_signed_in_future_beyond_skew",
        };
      }
    }
  }
  return { outcome: "authenticated", reason: "credential_valid" };
};

export interface ResolvedPrincipal {
  readonly principalId: string;
  readonly tenantId: string | null;
  readonly principalKind: "user" | "service_account" | "ai_architect" | "system";
  readonly authScheme: AuthScheme;
  readonly grantedScopes: readonly string[];
  readonly mfaProofAgeSeconds: number | null;
  readonly resolvedAt: string;
}

export const ResolvedPrincipalSchema = z.object({
  principalId: z.string().uuid(),
  tenantId: z.string().uuid().nullable(),
  principalKind: z.enum([
    "user",
    "service_account",
    "ai_architect",
    "system",
  ]),
  authScheme: z.enum(AUTH_SCHEMES),
  grantedScopes: z.array(z.string().max(200)),
  mfaProofAgeSeconds: z.number().int().min(0).nullable(),
  resolvedAt: z.string().datetime({ offset: true }),
});

export const isStrongAuthScheme = (scheme: AuthScheme): boolean =>
  STRONG_AUTH_SCHEMES.has(scheme);

export const schemeRequiresHttps = (scheme: AuthScheme): boolean =>
  SCHEMES_REQUIRING_HTTPS.has(scheme);

export const isAuthSuccess = (outcome: AuthOutcome): boolean =>
  AUTH_SUCCESS_OUTCOMES.has(outcome);
