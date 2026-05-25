import { z } from "zod";

export const PROTOCOLS = ["saml", "oidc"] as const;
export type Protocol = (typeof PROTOCOLS)[number];

export const IDP_VENDORS = [
  "okta",
  "auth0",
  "azure_ad",
  "google_workspace",
  "jumpcloud",
  "onelogin",
  "ping_federate",
  "adfs",
  "keycloak",
  "custom",
] as const;
export type IdpVendor = (typeof IDP_VENDORS)[number];

export const PROVIDER_STATUSES = ["draft", "testing", "active", "suspended", "archived"] as const;
export type ProviderStatus = (typeof PROVIDER_STATUSES)[number];

export const PROVIDER_TRANSITIONS: Readonly<Record<ProviderStatus, readonly ProviderStatus[]>> = {
  draft: ["testing", "archived"],
  testing: ["draft", "active", "archived"],
  active: ["suspended", "archived"],
  suspended: ["active", "archived"],
  archived: [],
};

export const canTransitionProvider = (from: ProviderStatus, to: ProviderStatus): boolean =>
  PROVIDER_TRANSITIONS[from].includes(to);

export const TEST_OUTCOMES = [
  "untested",
  "metadata_ok",
  "metadata_failed",
  "round_trip_ok",
  "round_trip_failed",
] as const;
export type TestOutcome = (typeof TEST_OUTCOMES)[number];

export const SsoProviderBaseSchema = z.object({
  id: z.string().regex(/^sso_[a-z0-9]{8,32}$/),
  tenantId: z.string().uuid().nullable(),
  vendor: z.enum(IDP_VENDORS),
  label: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  status: z.enum(PROVIDER_STATUSES),
  allowWeakSignatures: z.boolean().default(false),
  enabled: z.boolean(),
  createdAt: z.string().datetime({ offset: true }),
  createdBy: z.string().uuid(),
  updatedAt: z.string().datetime({ offset: true }),
  lastTestedAt: z.string().datetime({ offset: true }).nullable().optional(),
  lastTestOutcome: z.enum(TEST_OUTCOMES).default("untested"),
});

export const SamlProviderConfigSchema = z.object({
  protocol: z.literal("saml"),
  idpEntityId: z.string().min(1),
  idpSsoUrl: z.string().url(),
  idpSloUrl: z.string().url().optional(),
  idpSigningCertificateSha256: z.string().regex(/^[0-9a-f]{64}$/),
  spEntityId: z.string().min(1),
  spAcsUrl: z.string().url(),
  spSloUrl: z.string().url().optional(),
  signatureAlgorithm: z.string(),
  digestAlgorithm: z.string(),
  allowedNameIdFormats: z.array(z.string()).min(1),
  preferredBinding: z.string(),
  wantAssertionsSigned: z.boolean().default(true),
  wantResponseSigned: z.boolean().default(true),
  encryptAssertions: z.boolean().default(false),
  audienceUri: z.string().min(1),
  defaultRelayState: z.string().max(500).optional(),
  clockSkewSeconds: z.number().int().min(0).max(600).default(60),
});
export type SamlProviderConfig = z.infer<typeof SamlProviderConfigSchema>;

export const OidcProviderConfigSchema = z.object({
  protocol: z.literal("oidc"),
  issuer: z.string().url(),
  discoveryUri: z.string().url().optional(),
  authorizationEndpoint: z.string().url(),
  tokenEndpoint: z.string().url(),
  userinfoEndpoint: z.string().url().optional(),
  jwksUri: z.string().url(),
  endSessionEndpoint: z.string().url().optional(),
  clientId: z.string().min(1),
  clientSecretSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  isPublicClient: z.boolean().default(false),
  scopes: z.array(z.string().min(1)).min(1),
  responseTypes: z.array(z.string()).min(1),
  grantTypes: z.array(z.string()).min(1),
  tokenAuthMethod: z.string(),
  pkceMethod: z.enum(["S256", "plain"]),
  redirectUris: z.array(z.string().url()).min(1),
  postLogoutRedirectUris: z.array(z.string().url()).default([]),
  idTokenSignAlg: z.string(),
  idTokenLifetimeSec: z.number().int().min(60).max(86400).default(3600),
  refreshTokenLifetimeSec: z.number().int().min(60).max(2592000).default(2592000),
  audience: z.string().optional(),
  clockSkewSeconds: z.number().int().min(0).max(600).default(60),
});
export type OidcProviderConfig = z.infer<typeof OidcProviderConfigSchema>;

export const SsoProviderConfigSchema = z.discriminatedUnion("protocol", [
  SamlProviderConfigSchema,
  OidcProviderConfigSchema,
]);
export type SsoProviderConfig = z.infer<typeof SsoProviderConfigSchema>;

export const SsoProviderSchema = SsoProviderBaseSchema.extend({
  config: SsoProviderConfigSchema,
}).superRefine((p, ctx) => {
  if (p.config.protocol === "oidc" && p.config.isPublicClient && p.config.pkceMethod !== "S256") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["config", "pkceMethod"],
      message: "public OIDC client requires PKCE S256",
    });
  }
  if (
    p.config.protocol === "oidc" &&
    !p.config.isPublicClient &&
    p.config.clientSecretSha256 === null
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["config", "clientSecretSha256"],
      message: "confidential OIDC client requires clientSecretSha256",
    });
  }
  if (p.status === "active" && !p.enabled) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["enabled"],
      message: "active provider must be enabled",
    });
  }
});
export type SsoProvider = z.infer<typeof SsoProviderSchema>;

export const isTenantScopedProvider = (p: SsoProvider): boolean => p.tenantId !== null;

export const requiresMandatoryRetest = (p: SsoProvider, now: Date, thresholdDays = 90): boolean => {
  if (p.lastTestedAt === null || p.lastTestedAt === undefined) return true;
  const last = Date.parse(p.lastTestedAt);
  const elapsed = now.getTime() - last;
  return elapsed > thresholdDays * 86400_000;
};
