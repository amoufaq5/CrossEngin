import type { Principal } from "@crossengin/auth";
import type { AccessReviewCampaign, PrincipalUnderReview } from "@crossengin/access-reviews";
import type { LiveGrant } from "@crossengin/access-reviews-runtime";

import { subjectToUuid, type ApiKeySpec } from "./principals.js";

/** A tenant's live grants + the principals that hold them, as the review scheduler sees them. */
export interface LiveGrantSnapshot {
  readonly grants: readonly LiveGrant[];
  readonly principals: readonly PrincipalUnderReview[];
}

/** The seam the access-review scheduler pulls from each tick (config-backed or live). */
export interface LiveGrantSource {
  grantsForCampaign(campaign: AccessReviewCampaign): Promise<LiveGrantSnapshot>;
}

/** A fixed snapshot — the original config `grants`/`principals` behaviour, behind the seam. */
export class StaticLiveGrantSource implements LiveGrantSource {
  constructor(private readonly snapshot: LiveGrantSnapshot) {}

  grantsForCampaign(): Promise<LiveGrantSnapshot> {
    return Promise.resolve(this.snapshot);
  }
}

const EPOCH = "1970-01-01T00:00:00.000Z";

const PRINCIPAL_KIND_TO_TYPE: Readonly<
  Record<Principal["kind"], PrincipalUnderReview["principalType"]>
> = {
  user: "user",
  ai_architect: "ai_architect",
  system: "system",
};

export interface PrincipalMappingOptions {
  /** Grant timestamp to stamp — the auth model tracks no grant time, so it defaults to the epoch. */
  readonly grantedAt?: string;
  readonly displayLabel?: (principal: Principal) => string;
}

/**
 * Maps one auth `Principal` to a review subject + one role-grant per role it
 * holds (primary + secondary, de-duplicated). A principal with no `userId`
 * (a system/service credential with no user identity) yields nothing — a review
 * item needs a uuid principal.
 */
export function principalToLiveGrants(
  principal: Principal,
  opts: PrincipalMappingOptions = {},
): LiveGrantSnapshot {
  if (principal.userId === null) return { grants: [], principals: [] };
  const principalId: string = principal.userId;
  const grantedAt = opts.grantedAt ?? EPOCH;
  const subject: PrincipalUnderReview = {
    principalId,
    principalType: PRINCIPAL_KIND_TO_TYPE[principal.kind],
    displayLabel: opts.displayLabel?.(principal) ?? `${principal.primaryRole} (${principalId})`,
    tenantId: principal.tenantId,
    isExternal: false,
    managerUserId: null,
    mfaStatus: principal.mfaProofAgeSeconds !== null ? "any_strong" : "none",
    lastLoginAt: null,
  };
  const roles = [...new Set<string>([principal.primaryRole, ...principal.secondaryRoles])];
  const grants: LiveGrant[] = roles.map((role) => ({
    principalId,
    kind: "role",
    grantId: `${principalId}:${role}`,
    resourceLabel: role,
    attributes: {},
    grantedAt,
    grantedBy: null,
    lastUsedAt: null,
  }));
  return { grants, principals: [subject] };
}

export function principalsToLiveGrants(
  principals: readonly Principal[],
  opts: PrincipalMappingOptions = {},
): LiveGrantSnapshot {
  const grants: LiveGrant[] = [];
  const principalsOut: PrincipalUnderReview[] = [];
  for (const principal of principals) {
    const snapshot = principalToLiveGrants(principal, opts);
    grants.push(...snapshot.grants);
    principalsOut.push(...snapshot.principals);
  }
  return { grants, principals: principalsOut };
}

/** Yields the auth principals in scope for a tenant's review. */
export interface AuthPrincipalProvider {
  listPrincipals(tenantId: string): Promise<readonly Principal[]> | readonly Principal[];
}

/** A live source: pulls the campaign tenant's auth principals + maps them to role-grants. */
export class AuthLiveGrantSource implements LiveGrantSource {
  constructor(
    private readonly provider: AuthPrincipalProvider,
    private readonly opts: PrincipalMappingOptions = {},
  ) {}

  async grantsForCampaign(campaign: AccessReviewCampaign): Promise<LiveGrantSnapshot> {
    const principals = await this.provider.listPrincipals(campaign.tenantId);
    return principalsToLiveGrants(principals, this.opts);
  }
}

/**
 * The running server's own configured API-key principals as an auth-principal
 * provider — so a review campaign reviews the actual role assignments the
 * instance is serving with. Each key becomes a `user` principal (stable uuid
 * from the key), grouped by tenant.
 */
export function apiKeyPrincipalProvider(apiKeys: readonly ApiKeySpec[]): AuthPrincipalProvider {
  const byTenant = new Map<string, Principal[]>();
  for (const spec of apiKeys) {
    const list = byTenant.get(spec.tenantId) ?? [];
    list.push({
      kind: "user",
      tenantId: spec.tenantId as Principal["tenantId"],
      userId: subjectToUuid(spec.key) as Principal["userId"],
      primaryRole: spec.role,
      secondaryRoles: [],
      abacAttributes: {},
      mfaProofAgeSeconds: null,
    });
    byTenant.set(spec.tenantId, list);
  }
  return {
    listPrincipals(tenantId: string): readonly Principal[] {
      return byTenant.get(tenantId) ?? [];
    },
  };
}
