import { z } from "zod";

export const SCOPE_KINDS = [
  "all_users_with_role",
  "specific_principals",
  "all_tenant_admins",
  "custom_predicate",
  "mfa_status_in",
  "last_login_older_than",
  "external_users_only",
  "service_accounts_only",
] as const;
export type ScopeKind = (typeof SCOPE_KINDS)[number];

export const PRINCIPAL_TYPES = [
  "user",
  "service_account",
  "ai_architect",
  "system",
  "external_partner",
] as const;
export type PrincipalType = (typeof PRINCIPAL_TYPES)[number];

export const GRANT_KINDS = [
  "role",
  "permission",
  "resource_access",
  "tenant_membership",
  "field_permission",
  "api_key_scope",
  "marketplace_pack_grant",
] as const;
export type GrantKind = (typeof GRANT_KINDS)[number];

const AllUsersWithRoleScopeSchema = z.object({
  kind: z.literal("all_users_with_role"),
  roleSlug: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  includeInherited: z.boolean().default(true),
});

const SpecificPrincipalsScopeSchema = z.object({
  kind: z.literal("specific_principals"),
  principalIds: z.array(z.string().uuid()).min(1).max(10_000),
});

const AllTenantAdminsScopeSchema = z.object({
  kind: z.literal("all_tenant_admins"),
  includePlatformAdmins: z.boolean().default(false),
});

const CustomPredicateScopeSchema = z.object({
  kind: z.literal("custom_predicate"),
  predicate: z.string().min(1).max(2000),
  description: z.string().max(500),
});

const MfaStatusInScopeSchema = z.object({
  kind: z.literal("mfa_status_in"),
  statuses: z
    .array(z.enum(["none", "totp_only", "weak_only_sms", "webauthn", "any_strong"]))
    .min(1),
});

const LastLoginOlderThanScopeSchema = z.object({
  kind: z.literal("last_login_older_than"),
  thresholdDays: z.number().int().min(1).max(3650),
});

const ExternalUsersOnlyScopeSchema = z.object({
  kind: z.literal("external_users_only"),
  externalDomainsExcluded: z.array(z.string()).default([]),
});

const ServiceAccountsOnlyScopeSchema = z.object({
  kind: z.literal("service_accounts_only"),
  includeSystemAccounts: z.boolean().default(false),
});

export const CampaignScopeSchema = z.discriminatedUnion("kind", [
  AllUsersWithRoleScopeSchema,
  SpecificPrincipalsScopeSchema,
  AllTenantAdminsScopeSchema,
  CustomPredicateScopeSchema,
  MfaStatusInScopeSchema,
  LastLoginOlderThanScopeSchema,
  ExternalUsersOnlyScopeSchema,
  ServiceAccountsOnlyScopeSchema,
]);
export type CampaignScope = z.infer<typeof CampaignScopeSchema>;

export const PrincipalUnderReviewSchema = z.object({
  principalId: z.string().uuid(),
  principalType: z.enum(PRINCIPAL_TYPES),
  displayLabel: z.string().min(1).max(200),
  tenantId: z.string().uuid().nullable(),
  isExternal: z.boolean(),
  managerUserId: z.string().uuid().nullable(),
  mfaStatus: z.enum(["none", "totp_only", "weak_only_sms", "webauthn", "any_strong"]),
  lastLoginAt: z.string().datetime({ offset: true }).nullable(),
});
export type PrincipalUnderReview = z.infer<typeof PrincipalUnderReviewSchema>;

export const ReviewGrantSchema = z.object({
  kind: z.enum(GRANT_KINDS),
  grantId: z.string().min(1).max(200),
  resourceLabel: z.string().min(1).max(200),
  attributes: z.record(z.string(), z.string()).default({}),
  grantedAt: z.string().datetime({ offset: true }),
  grantedBy: z.string().uuid().nullable(),
  lastUsedAt: z.string().datetime({ offset: true }).nullable(),
});
export type ReviewGrant = z.infer<typeof ReviewGrantSchema>;

export const principalMatchesScope = (
  scope: CampaignScope,
  principal: PrincipalUnderReview,
  now: Date,
): boolean => {
  switch (scope.kind) {
    case "all_users_with_role":
      return principal.principalType === "user";
    case "specific_principals":
      return scope.principalIds.includes(principal.principalId);
    case "all_tenant_admins":
      return (
        principal.principalType === "user" &&
        (!scope.includePlatformAdmins || principal.tenantId === null)
      );
    case "custom_predicate":
      return true;
    case "mfa_status_in":
      return scope.statuses.includes(principal.mfaStatus);
    case "last_login_older_than": {
      if (principal.lastLoginAt === null) return true;
      const threshold = scope.thresholdDays * 86_400_000;
      return now.getTime() - Date.parse(principal.lastLoginAt) > threshold;
    }
    case "external_users_only":
      return (
        principal.isExternal &&
        !scope.externalDomainsExcluded.some((d) => principal.displayLabel.endsWith(`@${d}`))
      );
    case "service_accounts_only":
      return (
        principal.principalType === "service_account" ||
        (scope.includeSystemAccounts && principal.principalType === "system")
      );
  }
};

export const isHighRiskPrincipal = (
  principal: PrincipalUnderReview,
  now: Date,
  staleLoginDays = 90,
): boolean => {
  if (principal.mfaStatus === "none") return true;
  if (principal.mfaStatus === "weak_only_sms") return true;
  if (principal.lastLoginAt === null) return true;
  const elapsed = now.getTime() - Date.parse(principal.lastLoginAt);
  return elapsed > staleLoginDays * 86_400_000;
};
