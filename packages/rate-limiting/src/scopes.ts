import { z } from "zod";

export const SCOPE_KINDS = [
  "per_tenant",
  "per_principal",
  "per_api_key",
  "per_ip",
  "per_route",
  "per_oauth_client",
  "per_tenant_route",
  "per_tenant_principal",
  "global",
  "composite",
] as const;
export type ScopeKind = (typeof SCOPE_KINDS)[number];

export const SCOPES_REQUIRING_TENANT: ReadonlySet<ScopeKind> = new Set([
  "per_tenant",
  "per_tenant_route",
  "per_tenant_principal",
]);

export const SCOPES_REQUIRING_PRINCIPAL: ReadonlySet<ScopeKind> = new Set([
  "per_principal",
  "per_tenant_principal",
]);

export const SCOPES_REQUIRING_ROUTE: ReadonlySet<ScopeKind> = new Set([
  "per_route",
  "per_tenant_route",
]);

export const ScopeSpecSchema = z
  .object({
    kind: z.enum(SCOPE_KINDS),
    routePattern: z.string().max(200).nullable(),
    componentScopes: z.array(z.enum(SCOPE_KINDS)).max(8).default([]),
    bucketSalt: z.string().max(80).optional(),
  })
  .superRefine((s, ctx) => {
    if (s.kind === "composite") {
      if (s.componentScopes.length < 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["componentScopes"],
          message: "composite scope requires at least 2 componentScopes",
        });
      }
      if (s.componentScopes.includes("composite")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["componentScopes"],
          message: "composite scope cannot nest composite scopes",
        });
      }
      const unique = new Set(s.componentScopes);
      if (unique.size !== s.componentScopes.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["componentScopes"],
          message: "composite scope component kinds must be unique",
        });
      }
    }
    if (SCOPES_REQUIRING_ROUTE.has(s.kind) && s.routePattern === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["routePattern"],
        message: `${s.kind} scope requires routePattern`,
      });
    }
  });
export type ScopeSpec = z.infer<typeof ScopeSpecSchema>;

export interface RateLimitKeyInputs {
  readonly tenantId: string | null;
  readonly principalId: string | null;
  readonly apiKeyPrefix: string | null;
  readonly ipAddress: string | null;
  readonly route: string | null;
  readonly oauthClientId: string | null;
}

export const computeRateLimitKey = (spec: ScopeSpec, inputs: RateLimitKeyInputs): string | null => {
  const parts: string[] = [];
  const kinds: readonly ScopeKind[] =
    spec.kind === "composite" ? spec.componentScopes : [spec.kind];
  for (const k of kinds) {
    const piece = singleScopeKeyPart(k, inputs, spec.routePattern);
    if (piece === null) return null;
    parts.push(piece);
  }
  if (spec.bucketSalt !== undefined) parts.push(`salt:${spec.bucketSalt}`);
  return parts.join("|");
};

const singleScopeKeyPart = (
  kind: ScopeKind,
  inputs: RateLimitKeyInputs,
  routePattern: string | null,
): string | null => {
  switch (kind) {
    case "per_tenant":
      return inputs.tenantId === null ? null : `tenant:${inputs.tenantId}`;
    case "per_principal":
      return inputs.principalId === null ? null : `principal:${inputs.principalId}`;
    case "per_api_key":
      return inputs.apiKeyPrefix === null ? null : `apikey:${inputs.apiKeyPrefix}`;
    case "per_ip":
      return inputs.ipAddress === null ? null : `ip:${inputs.ipAddress}`;
    case "per_route":
      return routePattern === null ? null : `route:${routePattern}`;
    case "per_oauth_client":
      return inputs.oauthClientId === null ? null : `oauth:${inputs.oauthClientId}`;
    case "per_tenant_route":
      if (inputs.tenantId === null || routePattern === null) return null;
      return `tenant:${inputs.tenantId}|route:${routePattern}`;
    case "per_tenant_principal":
      if (inputs.tenantId === null || inputs.principalId === null) return null;
      return `tenant:${inputs.tenantId}|principal:${inputs.principalId}`;
    case "global":
      return "global";
    case "composite":
      return null;
  }
};

export const requiredInputsFor = (
  spec: ScopeSpec,
): readonly ("tenantId" | "principalId" | "route")[] => {
  const required = new Set<"tenantId" | "principalId" | "route">();
  const kinds: readonly ScopeKind[] =
    spec.kind === "composite" ? spec.componentScopes : [spec.kind];
  for (const k of kinds) {
    if (SCOPES_REQUIRING_TENANT.has(k)) required.add("tenantId");
    if (SCOPES_REQUIRING_PRINCIPAL.has(k)) required.add("principalId");
    if (SCOPES_REQUIRING_ROUTE.has(k)) required.add("route");
  }
  return Array.from(required);
};

export const matchesRoutePattern = (pattern: string, route: string): boolean => {
  if (pattern === route) return true;
  if (pattern === "*") return true;
  if (pattern.endsWith("/*")) {
    const prefix = pattern.slice(0, -2);
    return route === prefix || route.startsWith(`${prefix}/`);
  }
  const wildcardSegments = pattern.split("/");
  const routeSegments = route.split("/");
  if (wildcardSegments.length !== routeSegments.length) return false;
  for (let i = 0; i < wildcardSegments.length; i++) {
    const p = wildcardSegments[i];
    const r = routeSegments[i];
    if (p === undefined || r === undefined) return false;
    if (p === "*") continue;
    if (p.startsWith(":")) continue;
    if (p !== r) return false;
  }
  return true;
};
