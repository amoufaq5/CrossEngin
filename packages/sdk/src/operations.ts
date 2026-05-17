import { z } from "zod";
import { ApiVersionSchema } from "./versioning.js";
import { ScopeKeySchema, type ScopeKey } from "./scopes.js";

const OPERATION_ID_REGEX = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;
const PATH_REGEX = /^\/(?:[a-zA-Z0-9_\-.]+|:[a-z][a-zA-Z0-9_]*)(?:\/(?:[a-zA-Z0-9_\-.]+|:[a-z][a-zA-Z0-9_]*))*$/;
const Iso8601 = z.string().datetime({ offset: true });

export const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];
export const HttpMethodSchema = z.enum(HTTP_METHODS);

export const OPERATION_CATEGORIES = [
  "tenants",
  "users",
  "manifests",
  "files",
  "search",
  "reporting",
  "billing",
  "webhooks",
  "system",
] as const;
export type OperationCategory = (typeof OPERATION_CATEGORIES)[number];

export const SAFE_METHODS: ReadonlySet<HttpMethod> = new Set(["GET", "HEAD"]);

export const ApiOperationSchema = z
  .object({
    id: z.string().regex(OPERATION_ID_REGEX, {
      message:
        "operation id must be 'resource.action' (e.g., 'tenants.list', 'manifests.apply')",
    }),
    category: z.enum(OPERATION_CATEGORIES),
    method: HttpMethodSchema,
    path: z.string().regex(PATH_REGEX),
    versions: z.array(ApiVersionSchema).min(1),
    summary: z.string().min(1),
    description: z.string().optional(),
    requiredScopes: z.array(ScopeKeySchema).min(1),
    idempotent: z.boolean().default(false),
    supportsIdempotencyKey: z.boolean().default(false),
    successStatus: z.number().int().min(100).max(599).default(200),
    requestBodyRequired: z.boolean().default(false),
    deprecatedAt: Iso8601.nullable().default(null),
    sunsetAt: Iso8601.nullable().default(null),
    replacedBy: z.string().regex(OPERATION_ID_REGEX).optional(),
  })
  .superRefine((v, ctx) => {
    if (SAFE_METHODS.has(v.method)) {
      if (!v.idempotent) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["idempotent"],
          message: `safe method '${v.method}' must be idempotent=true`,
        });
      }
      if (v.requestBodyRequired) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["requestBodyRequired"],
          message: `safe method '${v.method}' must not require a request body`,
        });
      }
    }
    if (v.method === "PUT" || v.method === "DELETE") {
      if (!v.idempotent) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["idempotent"],
          message: `method '${v.method}' must be idempotent=true (RFC 9110)`,
        });
      }
    }
    if (v.method === "POST" && v.idempotent && !v.supportsIdempotencyKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["supportsIdempotencyKey"],
        message:
          "POST operations marked idempotent must supportsIdempotencyKey=true (client provides replay key)",
      });
    }
    if (v.sunsetAt !== null && v.deprecatedAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deprecatedAt"],
        message: "sunsetAt requires deprecatedAt",
      });
    }
    if (v.deprecatedAt !== null && v.sunsetAt !== null) {
      if (
        new Date(v.sunsetAt).getTime() <= new Date(v.deprecatedAt).getTime()
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sunsetAt"],
          message: "sunsetAt must be after deprecatedAt",
        });
      }
    }
    if (v.sunsetAt !== null && v.replacedBy === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["replacedBy"],
        message: "sunset operations must declare replacedBy",
      });
    }
    const seen = new Set<ScopeKey>();
    v.requiredScopes.forEach((s, i) => {
      if (seen.has(s)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["requiredScopes", i],
          message: `duplicate scope '${s}'`,
        });
      }
      seen.add(s);
    });
    const versionsSeen = new Set<string>();
    v.versions.forEach((ver, i) => {
      if (versionsSeen.has(ver)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["versions", i],
          message: `duplicate version '${ver}'`,
        });
      }
      versionsSeen.add(ver);
    });
  });
export type ApiOperation = z.infer<typeof ApiOperationSchema>;

export const ApiOperationSetSchema = z
  .array(ApiOperationSchema)
  .superRefine((entries, ctx) => {
    const ids = new Map<string, number>();
    const routes = new Map<string, number>();
    entries.forEach((e, i) => {
      const prior = ids.get(e.id);
      if (prior !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, "id"],
          message: `duplicate operation id '${e.id}' (already at index ${prior})`,
        });
      }
      ids.set(e.id, i);
      for (const version of e.versions) {
        const routeKey = `${version}|${e.method}|${e.path}`;
        const priorRoute = routes.get(routeKey);
        if (priorRoute !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [i],
            message: `duplicate (version, method, path) '${routeKey}' (already at index ${priorRoute})`,
          });
        }
        routes.set(routeKey, i);
      }
      if (e.replacedBy !== undefined && !ids.has(e.replacedBy)) {
        const future = entries.find((x) => x.id === e.replacedBy);
        if (future === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [i, "replacedBy"],
            message: `replacedBy '${e.replacedBy}' is not declared in the set`,
          });
        }
      }
    });
  });
export type ApiOperationSet = z.infer<typeof ApiOperationSetSchema>;

export function operationsRequiringScope(
  set: ApiOperationSet,
  scope: ScopeKey,
): readonly ApiOperation[] {
  return set.filter((o) => o.requiredScopes.includes(scope));
}

export function operationsByCategory(
  set: ApiOperationSet,
  category: OperationCategory,
): readonly ApiOperation[] {
  return set.filter((o) => o.category === category);
}

export function findOperation(
  set: ApiOperationSet,
  method: HttpMethod,
  path: string,
): ApiOperation | null {
  return (
    set.find((o) => o.method === method && o.path === path) ?? null
  );
}
