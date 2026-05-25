import type { RouteDefinition } from "@crossengin/api-gateway";
import { HandlerRegistry, type Handler } from "@crossengin/api-gateway-runtime";

export type GatewayMode = "in_memory" | "postgres";

export interface BuiltinHandlersInput {
  readonly mode: GatewayMode;
  readonly startedAt: Date;
  readonly clock?: () => Date;
}

export interface BuiltinHandlersResult {
  readonly handlers: HandlerRegistry;
  readonly routes: readonly RouteDefinition[];
}

const PING_ROUTE: RouteDefinition = {
  id: "rt_builtinping1",
  operationId: "platform.ping",
  method: "GET",
  pathSegments: [{ kind: "literal", value: "__ping" }],
  apiVersion: "v1",
  isDeprecated: false,
  deprecatedSince: null,
  sunsetAt: null,
  successorOperationId: null,
  requiredScopes: [],
  rateLimitPolicyId: null,
  idempotencyRequired: false,
  requestSchemaSha256: null,
  responseSchemaSha256: null,
  sourcePack: null,
};

const HEALTH_ROUTE: RouteDefinition = {
  id: "rt_builtinhealth1",
  operationId: "platform.health",
  method: "GET",
  pathSegments: [{ kind: "literal", value: "__health" }],
  apiVersion: "v1",
  isDeprecated: false,
  deprecatedSince: null,
  sunsetAt: null,
  successorOperationId: null,
  requiredScopes: [],
  rateLimitPolicyId: null,
  idempotencyRequired: false,
  requestSchemaSha256: null,
  responseSchemaSha256: null,
  sourcePack: null,
};

export const BUILTIN_ROUTES: readonly RouteDefinition[] = [PING_ROUTE, HEALTH_ROUTE];

export function buildPingHandler(input: BuiltinHandlersInput): Handler {
  const clock = input.clock ?? (() => new Date());
  return () => ({
    kind: "json",
    status: 200,
    body: { status: "ok", at: clock().toISOString() },
  });
}

export function buildHealthHandler(input: BuiltinHandlersInput): Handler {
  const clock = input.clock ?? (() => new Date());
  return () => {
    const now = clock();
    const uptimeSeconds = Math.floor((now.getTime() - input.startedAt.getTime()) / 1000);
    return {
      kind: "json",
      status: 200,
      body: {
        status: "ok",
        mode: input.mode,
        startedAt: input.startedAt.toISOString(),
        uptimeSeconds,
      },
    };
  };
}

export function buildDefaultGatewayHandlers(input: BuiltinHandlersInput): BuiltinHandlersResult {
  const handlers = new HandlerRegistry()
    .register(PING_ROUTE.operationId, buildPingHandler(input))
    .register(HEALTH_ROUTE.operationId, buildHealthHandler(input));
  return { handlers, routes: BUILTIN_ROUTES };
}
