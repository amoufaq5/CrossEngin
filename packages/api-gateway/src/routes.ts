import { z } from "zod";
import { HTTP_METHODS, type HttpMethod, normalizePathSegments } from "./requests.js";

export const VERSION_NEGOTIATION_STRATEGIES = [
  "header_x_api_version",
  "accept_media_type_version",
  "path_prefix",
  "query_param",
] as const;
export type VersionNegotiationStrategy = (typeof VERSION_NEGOTIATION_STRATEGIES)[number];

export const ROUTE_MATCH_OUTCOMES = [
  "matched",
  "no_route",
  "method_not_allowed",
  "version_not_supported",
  "deprecated_version",
  "sunset_version",
] as const;
export type RouteMatchOutcome = (typeof ROUTE_MATCH_OUTCOMES)[number];

const PathSegmentSchema = z.union([
  z.object({ kind: z.literal("literal"), value: z.string().regex(/^[a-zA-Z0-9._-]+$/) }),
  z.object({
    kind: z.literal("parameter"),
    name: z.string().regex(/^[a-z][a-zA-Z0-9_]*$/),
    pattern: z.string().max(200).nullable(),
  }),
  z.object({ kind: z.literal("wildcard") }),
]);
export type PathSegment = z.infer<typeof PathSegmentSchema>;

export const RouteDefinitionSchema = z
  .object({
    id: z.string().regex(/^rt_[a-z0-9]{8,40}$/),
    operationId: z
      .string()
      .regex(/^[a-z][a-zA-Z0-9._]*$/)
      .max(120),
    method: z.enum(HTTP_METHODS),
    pathSegments: z.array(PathSegmentSchema).min(0).max(20),
    apiVersion: z.string().regex(/^v[0-9]+$/),
    isDeprecated: z.boolean().default(false),
    deprecatedSince: z.string().datetime({ offset: true }).nullable(),
    sunsetAt: z.string().datetime({ offset: true }).nullable(),
    successorOperationId: z.string().max(120).nullable(),
    requiredScopes: z.array(z.string().max(200)).default([]),
    rateLimitPolicyId: z
      .string()
      .regex(/^rlp_[a-z0-9]{8,40}$/)
      .nullable(),
    idempotencyRequired: z.boolean().default(false),
    requestSchemaSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    responseSchemaSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    sourcePack: z
      .string()
      .regex(/^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)*$/)
      .max(120)
      .nullable()
      .default(null),
  })
  .superRefine((r, ctx) => {
    if (r.isDeprecated && r.deprecatedSince === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deprecatedSince"],
        message: "deprecated route requires deprecatedSince",
      });
    }
    if (
      r.sunsetAt !== null &&
      r.deprecatedSince !== null &&
      Date.parse(r.sunsetAt) <= Date.parse(r.deprecatedSince)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sunsetAt"],
        message: "sunsetAt must be after deprecatedSince",
      });
    }
    if (r.sunsetAt !== null && !r.isDeprecated) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sunsetAt"],
        message: "sunsetAt requires isDeprecated=true",
      });
    }
    const wildcardCount = r.pathSegments.filter((s) => s.kind === "wildcard").length;
    if (wildcardCount > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pathSegments"],
        message: "at most one wildcard segment per route",
      });
    }
    const wildcardIndex = r.pathSegments.findIndex((s) => s.kind === "wildcard");
    if (wildcardIndex !== -1 && wildcardIndex !== r.pathSegments.length - 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pathSegments"],
        message: "wildcard segment must be the last segment",
      });
    }
    const paramNames = new Set<string>();
    for (const seg of r.pathSegments) {
      if (seg.kind === "parameter") {
        if (paramNames.has(seg.name)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["pathSegments"],
            message: `duplicate path parameter name: ${seg.name}`,
          });
          return;
        }
        paramNames.add(seg.name);
      }
    }
  });
export type RouteDefinition = z.infer<typeof RouteDefinitionSchema>;

export interface RouteMatchResult {
  readonly outcome: RouteMatchOutcome;
  readonly route: RouteDefinition | null;
  readonly pathParameters: Readonly<Record<string, string>>;
  readonly wildcardSuffix: string | null;
  readonly resolvedVersion: string | null;
}

export const matchRoute = (
  routes: readonly RouteDefinition[],
  method: HttpMethod,
  path: string,
  apiVersion: string,
  now: Date,
): RouteMatchResult => {
  const segments = normalizePathSegments(path);
  const pathMatches: RouteDefinition[] = [];
  for (const r of routes) {
    if (r.apiVersion !== apiVersion) continue;
    const m = tryMatchSegments(r.pathSegments, segments);
    if (m !== null) {
      if (r.method === method) {
        if (r.sunsetAt !== null && now.getTime() >= Date.parse(r.sunsetAt)) {
          return {
            outcome: "sunset_version",
            route: r,
            pathParameters: m.params,
            wildcardSuffix: m.wildcardSuffix,
            resolvedVersion: r.apiVersion,
          };
        }
        if (r.isDeprecated) {
          return {
            outcome: "deprecated_version",
            route: r,
            pathParameters: m.params,
            wildcardSuffix: m.wildcardSuffix,
            resolvedVersion: r.apiVersion,
          };
        }
        return {
          outcome: "matched",
          route: r,
          pathParameters: m.params,
          wildcardSuffix: m.wildcardSuffix,
          resolvedVersion: r.apiVersion,
        };
      }
      pathMatches.push(r);
    }
  }
  if (pathMatches.length > 0) {
    return {
      outcome: "method_not_allowed",
      route: null,
      pathParameters: {},
      wildcardSuffix: null,
      resolvedVersion: apiVersion,
    };
  }
  const anyVersionMatch = routes.some((r) => {
    if (r.method !== method) return false;
    return tryMatchSegments(r.pathSegments, segments) !== null;
  });
  if (anyVersionMatch) {
    return {
      outcome: "version_not_supported",
      route: null,
      pathParameters: {},
      wildcardSuffix: null,
      resolvedVersion: null,
    };
  }
  return {
    outcome: "no_route",
    route: null,
    pathParameters: {},
    wildcardSuffix: null,
    resolvedVersion: null,
  };
};

interface SegmentMatch {
  readonly params: Record<string, string>;
  readonly wildcardSuffix: string | null;
}

const tryMatchSegments = (
  pattern: readonly PathSegment[],
  segments: readonly string[],
): SegmentMatch | null => {
  const params: Record<string, string> = {};
  let i = 0;
  for (; i < pattern.length; i++) {
    const p = pattern[i];
    if (p === undefined) return null;
    if (p.kind === "wildcard") {
      const remaining = segments.slice(i);
      return {
        params,
        wildcardSuffix: remaining.length === 0 ? "" : remaining.join("/"),
      };
    }
    const s = segments[i];
    if (s === undefined) return null;
    if (p.kind === "literal") {
      if (p.value !== s) return null;
      continue;
    }
    if (p.kind === "parameter") {
      if (p.pattern !== null && !new RegExp(`^${p.pattern}$`).test(s)) {
        return null;
      }
      params[p.name] = s;
    }
  }
  if (i !== segments.length) return null;
  return { params, wildcardSuffix: null };
};

export interface VersionNegotiationInput {
  readonly strategy: VersionNegotiationStrategy;
  readonly header: string | null;
  readonly acceptHeader: string | null;
  readonly pathFirstSegment: string | null;
  readonly queryVersion: string | null;
  readonly defaultVersion: string;
}

export const negotiateVersion = (input: VersionNegotiationInput): string => {
  switch (input.strategy) {
    case "header_x_api_version":
      if (input.header !== null && /^v[0-9]+$/.test(input.header)) {
        return input.header;
      }
      return input.defaultVersion;
    case "accept_media_type_version": {
      if (input.acceptHeader === null) return input.defaultVersion;
      const match = /version=(v[0-9]+)/.exec(input.acceptHeader);
      return match?.[1] ?? input.defaultVersion;
    }
    case "path_prefix":
      if (input.pathFirstSegment !== null && /^v[0-9]+$/.test(input.pathFirstSegment)) {
        return input.pathFirstSegment;
      }
      return input.defaultVersion;
    case "query_param":
      if (input.queryVersion !== null && /^v[0-9]+$/.test(input.queryVersion)) {
        return input.queryVersion;
      }
      return input.defaultVersion;
  }
};

export const compilePathPattern = (template: string): readonly PathSegment[] => {
  const segments = normalizePathSegments(template);
  return segments.map<PathSegment>((s) => {
    if (s === "*") return { kind: "wildcard" };
    if (s.startsWith(":")) {
      const colonIdx = s.indexOf("(");
      if (colonIdx === -1) {
        return { kind: "parameter", name: s.slice(1), pattern: null };
      }
      const closeIdx = s.lastIndexOf(")");
      const name = s.slice(1, colonIdx);
      const pattern = s.slice(colonIdx + 1, closeIdx);
      return { kind: "parameter", name, pattern };
    }
    return { kind: "literal", value: s };
  });
};
