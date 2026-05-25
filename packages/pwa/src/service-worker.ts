import { z } from "zod";

export const CACHE_STRATEGIES = [
  "cache_first",
  "network_first",
  "stale_while_revalidate",
  "network_only",
  "cache_only",
] as const;
export type CacheStrategy = (typeof CACHE_STRATEGIES)[number];

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

const ROUTE_ID_REGEX = /^[a-z][a-z0-9_-]*$/;

export const ServiceWorkerRouteSchema = z
  .object({
    id: z.string().regex(ROUTE_ID_REGEX),
    method: z.enum(HTTP_METHODS).default("GET"),
    urlPattern: z.string().min(1),
    strategy: z.enum(CACHE_STRATEGIES),
    cacheName: z.string().min(1).optional(),
    maxAgeSeconds: z.number().int().positive().optional(),
    maxEntries: z.number().int().positive().max(10_000).optional(),
    networkTimeoutMs: z.number().int().min(100).max(30_000).optional(),
    background_sync_queue: z.string().min(1).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.method !== "GET" && v.method !== "HEAD") {
      if (v.strategy !== "network_only") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["strategy"],
          message: `mutating method '${v.method}' must use 'network_only' (use background_sync_queue for offline writes)`,
        });
      }
    }
    if (
      v.background_sync_queue !== undefined &&
      v.method !== "POST" &&
      v.method !== "PUT" &&
      v.method !== "PATCH" &&
      v.method !== "DELETE"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["background_sync_queue"],
        message: "background_sync_queue is only valid for mutating methods",
      });
    }
    if (
      v.strategy === "network_only" &&
      (v.maxAgeSeconds !== undefined || v.maxEntries !== undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["strategy"],
        message: "network_only cannot declare maxAgeSeconds or maxEntries",
      });
    }
  });
export type ServiceWorkerRoute = z.infer<typeof ServiceWorkerRouteSchema>;

export const ServiceWorkerConfigSchema = z
  .object({
    scope: z.string().min(1).default("/"),
    appShellPaths: z.array(z.string().min(1)).default(["/", "/manifest.webmanifest"]),
    routes: z.array(ServiceWorkerRouteSchema).min(1),
    offlineFallbackPath: z.string().min(1).default("/offline"),
    precacheRevisionStrategy: z.enum(["content-hash", "build-id"]).default("content-hash"),
  })
  .superRefine((v, ctx) => {
    if (!v.scope.endsWith("/")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scope"],
        message: "scope must end with '/'",
      });
    }
    const ids = new Set<string>();
    v.routes.forEach((r, i) => {
      if (ids.has(r.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["routes", i, "id"],
          message: `duplicate route id '${r.id}'`,
        });
      }
      ids.add(r.id);
    });
  });
export type ServiceWorkerConfig = z.infer<typeof ServiceWorkerConfigSchema>;

export const DEFAULT_ROUTE_PRESETS: ReadonlyArray<ServiceWorkerRoute> = Object.freeze([
  ServiceWorkerRouteSchema.parse({
    id: "app-shell",
    urlPattern: "^/$",
    strategy: "stale_while_revalidate",
    cacheName: "shell-v1",
  }),
  ServiceWorkerRouteSchema.parse({
    id: "static-assets",
    urlPattern: "^/_next/static/.*",
    strategy: "cache_first",
    cacheName: "static-v1",
    maxAgeSeconds: 60 * 60 * 24 * 30,
    maxEntries: 1_000,
  }),
  ServiceWorkerRouteSchema.parse({
    id: "api-reads",
    urlPattern: "^/api/v1/.*",
    strategy: "network_first",
    cacheName: "api-reads-v1",
    networkTimeoutMs: 3_000,
    maxAgeSeconds: 60 * 5,
  }),
  ServiceWorkerRouteSchema.parse({
    id: "api-writes",
    method: "POST",
    urlPattern: "^/api/v1/.*",
    strategy: "network_only",
    background_sync_queue: "outbox",
  }),
  ServiceWorkerRouteSchema.parse({
    id: "auth",
    urlPattern: "^/api/auth/.*",
    strategy: "network_only",
  }),
  ServiceWorkerRouteSchema.parse({
    id: "file-downloads",
    urlPattern: "^https://[a-z0-9-]+\\.r2\\.cloudflarestorage\\.com/.*",
    strategy: "network_only",
  }),
]);

export function routeFor(
  config: ServiceWorkerConfig,
  url: string,
  method: HttpMethod = "GET",
): ServiceWorkerRoute | null {
  for (const route of config.routes) {
    if (route.method !== method) continue;
    if (new RegExp(route.urlPattern).test(url)) return route;
  }
  return null;
}
