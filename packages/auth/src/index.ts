import type { TenantId, UserId } from "@crossengin/types";

export const AUTH_VERSION = "0.0.0";

export interface Principal {
  readonly tenantId: TenantId;
  readonly userId: UserId;
  readonly roles: readonly string[];
}

export interface AuthorizationDecision {
  readonly allowed: boolean;
  readonly reason?: string;
}
