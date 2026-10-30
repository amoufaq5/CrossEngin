import { z } from "zod";
import { HTTP_METHODS, type HttpMethod, normalizePathSegments } from "./requests.js";

export const VERSION_NEGOTIATION_STRATEGIES = [
  "header_x_api_version",
  "accept_media_type_version",
  "path_prefix",
  "query_param",
] as const;
export type VersionNegotiationStrategy =
  (typeof VERSION_NEGOTIATION_STRATEGIES)[number];

export const ROUTE_MATCH_OUTCOMES = [
  "matched",
  "no_route",
  "method_not_allowed",
  "version_not_supported",
  "deprecated_version",
  "sunset_version",
] as const;
export type RouteMatchOutcome = (typeof ROUTE_MATCH_OUTCOMES)[number];

const PathSegmentSchema = z
  .union([
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
    rateLimitPolicyId: z.string().regex(/^rlp_[a-z0-9]{8,40}$/).nullable(),
    idempotencyRequired: z.boolean().default(false),
    requestSchemaSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    responseSchemaSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
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

export const negotiateVersion = (
  input: VersionNegotiationInput,
): string => {
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
      if (
        input.pathFirstSegment !== null &&
        /^v[0-9]+$/.test(input.pathFirstSegment)
      ) {
        return input.pathFirstSegment;
      }
      return input.defaultVersion;
    case "query_param":
      if (
        input.queryVersion !== null &&
        /^v[0-9]+$/.test(input.queryVersion)
      ) {
        return input.queryVersion;
      }
      return input.defaultVersion;
  }
};

export const PATH_TEMPLATE_GRAMMARS = ["openapi", "express"] as const;
export type PathTemplateGrammar = (typeof PATH_TEMPLATE_GRAMMARS)[number];

/**
 * Whether each grammar can express each segment kind. A total map over the product rather than two
 * `switch`es, so a fourth `PathSegment` kind is a compile error at both grammars instead of a
 * segment one renderer silently drops — and dropping one does not shorten a path, it **changes
 * which requests it matches**.
 *
 * `openapi: wildcard` is the one `refused`, and it is a shape refusal rather than a wiring one:
 * OpenAPI 3.1's path templating has no multi-segment variable (RFC 6570 reserved expansion is not
 * part of the Paths Object), so `{suffix}` would describe a path matching exactly one segment where
 * the route matches any number. Measured across every pack at both the shipped and the maximal flag
 * set: **zero** routes carry a wildcard, and the only construction site is `compilePathPattern`'s
 * `*` arm — so the refusal has no member today, which is exactly when it is cheapest to be right.
 */
export const PATH_SEGMENT_RENDER: Readonly<
  Record<PathTemplateGrammar, Readonly<Record<PathSegment["kind"], "rendered" | "refused">>>
> = {
  openapi: { literal: "rendered", parameter: "rendered", wildcard: "refused" },
  express: { literal: "rendered", parameter: "rendered", wildcard: "rendered" },
};

export type PathTemplateRender =
  | { readonly template: string; readonly refused: null }
  | { readonly template: null; readonly refused: "wildcard_not_expressible"; readonly at: number };

/**
 * Renders a route's segments back into a path template — the inverse of `compilePathPattern` for
 * the `express` grammar, and the form an OpenAPI Paths Object key takes for `openapi`.
 *
 * It lives here because this module holds both the inverse and `tryMatchSegments`, the only
 * consumer that walks the array rather than compiling it to a `RegExp`; three modules compile a
 * pattern and none rendered one, so a caller wanting a path string had no answer and
 * `RouteDefinition` has no path field (ADR-0355).
 *
 * The render is unambiguous by the schema rather than by convention: a literal's value is
 * `/^[a-zA-Z0-9._-]+$/`, which admits neither brace nor colon, so `{id}` in the output can only
 * have come from a parameter segment and `:id` only from one under the express grammar.
 */
export const renderPathTemplate = (
  segments: readonly PathSegment[],
  grammar: PathTemplateGrammar,
): PathTemplateRender => {
  const parts: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg === undefined) continue;
    if (PATH_SEGMENT_RENDER[grammar][seg.kind] === "refused") {
      return { template: null, refused: "wildcard_not_expressible", at: i };
    }
    if (seg.kind === "literal") {
      parts.push(seg.value);
    } else if (seg.kind === "parameter") {
      parts.push(grammar === "openapi" ? `{${seg.name}}` : `:${seg.name}`);
    } else {
      // `express` is the only grammar that renders a wildcard; `openapi` returned above.
      parts.push("*");
    }
  }
  return { template: `/${parts.join("/")}`, refused: null };
};

/**
 * The anchored regular expression a path parameter's declared pattern becomes in an OpenAPI
 * parameter *schema*, or `null` when the segment declares none.
 *
 * In the schema and deliberately not in the template: OpenAPI path templating carries a name and
 * nothing else, so a pattern rendered into the key would be part of the path's identity and two
 * routes differing only in it would read as two paths. Anchored because `tryMatchSegments` anchors
 * it too (`new RegExp(\`^${p.pattern}$\`)`), so an unanchored copy here would describe a parameter
 * the matcher refuses. Exactly one route in the workspace declares a pattern — `platform.users.get`
 * carrying `UUID_SEGMENT_PATTERN` — and it is load-bearing: it is what separates
 * `GET /v1/platform/users/stats` from `GET /v1/platform/users/{id}` independently of registration
 * order.
 */
export const pathParameterSchemaPattern = (
  segment: Extract<PathSegment, { kind: "parameter" }>,
): string | null => (segment.pattern === null ? null : `^${segment.pattern}$`);

/**
 * The OpenAPI 3.1 Path Item Object field each HTTP method is described by, or `null` for the one
 * method the object has no field for.
 *
 * `CONNECT` is that one: OAS 3.1's Path Item Object declares get/put/post/delete/options/head/
 * patch/trace and nothing else, so a `CONNECT` route is undescribable by shape rather than by
 * omission — a map keyed on the eight would have made it a lookup miss, which reads as a method
 * somebody forgot. Measured: zero `CONNECT` routes exist, and `OPTIONS` is in the enum with no
 * producer either (see `corsPreflightResponse`'s unreachable arm).
 */
export const OPENAPI_PATH_ITEM_FIELD: Readonly<Record<HttpMethod, string | null>> = {
  GET: "get",
  HEAD: "head",
  POST: "post",
  PUT: "put",
  PATCH: "patch",
  DELETE: "delete",
  OPTIONS: "options",
  TRACE: "trace",
  CONNECT: null,
};

/**
 * Route sets that render to one OpenAPI `(path, method)` pair, which the Paths Object cannot hold.
 *
 * Compared on the **anonymised** template — parameter names replaced by a placeholder — because
 * OAS 3.1 states that templated paths with the same hierarchy but different templated names are
 * identical and MUST NOT both exist, so `{id}` and `{dispatchId}` in the same position collide
 * while being distinct `RouteDefinition`s the matcher separates by registration order.
 *
 * Measured zero at both flag sets today (375 routes over 218 distinct templates, 421 over 262) —
 * and reachable from a manifest rather than hypothetical, which is why this is a function over a
 * route set and not a one-off assertion: an entity whose slug lands in a reserved namespace with a
 * transition named after an existing sub-path produces one, and the matcher then serves the entity
 * route while the other stays registered and unreachable.
 */
export const pathTemplateCollisions = (
  routes: readonly RouteDefinition[],
): readonly {
  readonly method: HttpMethod;
  readonly template: string;
  readonly operationIds: readonly string[];
}[] => {
  const byKey = new Map<string, { method: HttpMethod; template: string; ids: string[] }>();
  for (const route of routes) {
    const rendered = renderPathTemplate(route.pathSegments, "openapi");
    if (rendered.template === null) continue;
    const anonymised = rendered.template.replace(/\{[^}]*\}/g, "{}");
    const key = `${route.method} ${anonymised}`;
    const entry = byKey.get(key);
    if (entry === undefined) {
      byKey.set(key, { method: route.method, template: anonymised, ids: [route.operationId] });
    } else {
      entry.ids.push(route.operationId);
    }
  }
  const out: { method: HttpMethod; template: string; operationIds: readonly string[] }[] = [];
  for (const entry of byKey.values()) {
    if (entry.ids.length > 1) {
      out.push({ method: entry.method, template: entry.template, operationIds: entry.ids });
    }
  }
  return out;
};

export const compilePathPattern = (
  template: string,
): readonly PathSegment[] => {
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
