const SLUG_REGEX = /^[a-z0-9][a-z0-9-]*$/;

export function extractSubdomain(host: string, baseDomain: string): string | null {
  if (host === baseDomain) return null;
  const suffix = "." + baseDomain;
  if (!host.endsWith(suffix)) return null;
  const sub = host.slice(0, host.length - suffix.length);
  if (sub.length === 0) return null;
  if (sub.includes(".")) return null;
  if (!SLUG_REGEX.test(sub)) return null;
  return sub;
}

export function extractPathPrefixSlug(pathname: string, pathPrefix: string): string | null {
  const normalized = pathPrefix.endsWith("/") ? pathPrefix : pathPrefix + "/";
  if (!pathname.startsWith(normalized)) return null;
  const rest = pathname.slice(normalized.length);
  const end = rest.indexOf("/");
  const slug = end === -1 ? rest : rest.slice(0, end);
  if (slug.length === 0) return null;
  if (!SLUG_REGEX.test(slug)) return null;
  return slug;
}
