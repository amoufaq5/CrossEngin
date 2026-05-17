import type { TenantId } from "@crossengin/types";
import { extractPathPrefixSlug, extractSubdomain } from "./extract.js";
import type {
  ResolvedTenant,
  TenantDirectory,
  TenantResolutionRequest,
  TenantResolutionSource,
  TenantResolver,
  TenantResolverConfig,
} from "./types.js";
import { ConflictingTenantSourcesError, TenantNotResolvedError } from "./types.js";

interface UrlResolution {
  tenantId: TenantId;
  source: Exclude<TenantResolutionSource, "session">;
}

async function resolveFromUrl(
  url: URL,
  directory: TenantDirectory,
  baseDomain: string | undefined,
  pathPrefix: string | undefined,
): Promise<UrlResolution | null> {
  if (baseDomain !== undefined) {
    const subdomain = extractSubdomain(url.hostname, baseDomain);
    if (subdomain !== null) {
      const tenantId = await directory.getBySlug(subdomain);
      if (tenantId !== null) {
        return { tenantId, source: "subdomain" };
      }
    }
  }

  if (pathPrefix !== undefined) {
    const slug = extractPathPrefixSlug(url.pathname, pathPrefix);
    if (slug !== null) {
      const tenantId = await directory.getBySlug(slug);
      if (tenantId !== null) {
        return { tenantId, source: "path_prefix" };
      }
    }
  }

  return null;
}

export function createTenantResolver(config: TenantResolverConfig): TenantResolver {
  return {
    async resolve(request: TenantResolutionRequest): Promise<ResolvedTenant> {
      const fromUrl = await resolveFromUrl(
        request.url,
        config.directory,
        config.baseDomain,
        config.pathPrefix,
      );

      if (fromUrl !== null) {
        if (
          request.sessionTenantId !== undefined &&
          request.sessionTenantId !== fromUrl.tenantId
        ) {
          throw new ConflictingTenantSourcesError(fromUrl.tenantId, request.sessionTenantId);
        }
        return { tenantId: fromUrl.tenantId, source: fromUrl.source };
      }

      if (request.sessionTenantId !== undefined) {
        return { tenantId: request.sessionTenantId, source: "session" };
      }

      throw new TenantNotResolvedError();
    },
  };
}
