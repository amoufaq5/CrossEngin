import type { TenantId } from "@crossengin/types";

export type TenantResolutionSource = "subdomain" | "path_prefix" | "session";

export interface TenantResolutionRequest {
  readonly url: URL;
  readonly sessionTenantId?: TenantId;
}

export interface ResolvedTenant {
  readonly tenantId: TenantId;
  readonly source: TenantResolutionSource;
}

export interface TenantDirectory {
  getBySlug(slug: string): Promise<TenantId | null>;
}

export interface TenantResolverConfig {
  readonly directory: TenantDirectory;
  readonly baseDomain?: string;
  readonly pathPrefix?: string;
}

export interface TenantResolver {
  resolve(request: TenantResolutionRequest): Promise<ResolvedTenant>;
}

export class TenantNotResolvedError extends Error {
  override readonly name = "TenantNotResolvedError";
  constructor(message?: string) {
    super(message ?? "no tenant could be resolved from session, subdomain, or path prefix");
  }
}

export class ConflictingTenantSourcesError extends Error {
  override readonly name = "ConflictingTenantSourcesError";
  readonly urlTenantId: TenantId;
  readonly sessionTenantId: TenantId;
  constructor(urlTenantId: TenantId, sessionTenantId: TenantId) {
    super(
      `URL tenant (${String(urlTenantId)}) does not match session tenant (${String(sessionTenantId)})`,
    );
    this.urlTenantId = urlTenantId;
    this.sessionTenantId = sessionTenantId;
  }
}
