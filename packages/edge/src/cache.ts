import { z } from "zod";

const POLICY_ID_REGEX = /^[a-z][a-z0-9-]*$/;
const HEADER_NAME_REGEX = /^[A-Za-z][A-Za-z0-9-]*$/;
const PATH_PATTERN_REGEX = /^\/[A-Za-z0-9_\-/.:*[\]{}]*$/;

export const CACHE_KINDS = [
  "edge_cdn",
  "isr",
  "api_response",
  "image_cdn",
  "static_asset",
] as const;
export type CacheKind = (typeof CACHE_KINDS)[number];
export const CacheKindSchema = z.enum(CACHE_KINDS);

export const CACHE_KEY_STRATEGIES = [
  "path_only",
  "path_query",
  "path_query_vary_headers",
  "request_hash",
] as const;
export type CacheKeyStrategy = (typeof CACHE_KEY_STRATEGIES)[number];
export const CacheKeyStrategySchema = z.enum(CACHE_KEY_STRATEGIES);

export const CACHE_CONTROLS = ["public", "private", "no_store"] as const;
export type CacheControl = (typeof CACHE_CONTROLS)[number];

export const CachePolicySchema = z
  .object({
    id: z.string().regex(POLICY_ID_REGEX),
    kind: CacheKindSchema,
    pathPattern: z.string().regex(PATH_PATTERN_REGEX),
    ttlSeconds: z.number().int().nonnegative(),
    staleWhileRevalidateSeconds: z.number().int().nonnegative().default(0),
    keyStrategy: CacheKeyStrategySchema,
    varyHeaders: z.array(z.string().regex(HEADER_NAME_REGEX)).default([]),
    bypassHeaders: z.array(z.string().regex(HEADER_NAME_REGEX)).default([]),
    cacheControl: z.enum(CACHE_CONTROLS).default("public"),
    purgeOnDeploy: z.boolean().default(false),
    bypassAuthenticated: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    if (v.cacheControl === "no_store" && v.ttlSeconds > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ttlSeconds"],
        message: "cacheControl='no_store' requires ttlSeconds=0",
      });
    }
    if (v.cacheControl === "private" && v.kind === "edge_cdn") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cacheControl"],
        message: "edge_cdn caches must use cacheControl='public' (private goes to no edge cache)",
      });
    }
    if (v.keyStrategy === "path_query_vary_headers" && v.varyHeaders.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["varyHeaders"],
        message: "keyStrategy='path_query_vary_headers' requires at least one varyHeader",
      });
    }
    if (v.kind === "isr" && v.ttlSeconds < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ttlSeconds"],
        message: "isr caches require ttlSeconds >= 1",
      });
    }
    const seen = new Set<string>();
    v.varyHeaders.forEach((h, i) => {
      const lower = h.toLowerCase();
      if (seen.has(lower)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["varyHeaders", i],
          message: `duplicate vary header '${h}' (case-insensitive)`,
        });
      }
      seen.add(lower);
    });
    const bypassSeen = new Set<string>();
    v.bypassHeaders.forEach((h, i) => {
      const lower = h.toLowerCase();
      if (bypassSeen.has(lower)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["bypassHeaders", i],
          message: `duplicate bypass header '${h}' (case-insensitive)`,
        });
      }
      bypassSeen.add(lower);
    });
  });
export type CachePolicy = z.infer<typeof CachePolicySchema>;

export const CachePolicySetSchema = z.array(CachePolicySchema).superRefine((policies, ctx) => {
  const ids = new Set<string>();
  policies.forEach((p, i) => {
    if (ids.has(p.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [i, "id"],
        message: `duplicate cache policy id '${p.id}'`,
      });
    }
    ids.add(p.id);
  });
});
export type CachePolicySet = z.infer<typeof CachePolicySetSchema>;

export interface CacheRequest {
  readonly path: string;
  readonly method: string;
  readonly query?: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
}

export function shouldCache(policy: CachePolicy, request: CacheRequest): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  if (policy.cacheControl === "no_store") return false;
  if (policy.bypassAuthenticated && request.headers.authorization !== undefined) {
    return false;
  }
  for (const header of policy.bypassHeaders) {
    if (request.headers[header.toLowerCase()] !== undefined) return false;
  }
  return true;
}

export function cacheKeyFor(policy: CachePolicy, request: CacheRequest): string {
  const base =
    policy.keyStrategy === "path_only" ? request.path : `${request.path}?${request.query ?? ""}`;
  if (policy.keyStrategy === "path_query_vary_headers") {
    const headers = policy.varyHeaders
      .map((h) => `${h.toLowerCase()}=${request.headers[h.toLowerCase()] ?? ""}`)
      .join("&");
    return `${base}|${headers}`;
  }
  if (policy.keyStrategy === "request_hash") {
    const headers = Object.keys(request.headers)
      .sort()
      .map((h) => `${h}=${request.headers[h] ?? ""}`)
      .join("&");
    return `${request.method}:${base}|${headers}`;
  }
  return base;
}

export function totalCachableSeconds(policy: CachePolicy): number {
  return policy.ttlSeconds + policy.staleWhileRevalidateSeconds;
}
