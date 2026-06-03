import type { RouteDefinition, IncomingRequest } from "@crossengin/api-gateway";
import type { RoleDefinition } from "@crossengin/auth";
import { describe, expect, it } from "vitest";
import { buildIncomingRequest } from "./adapters.js";
import { HandlerRegistry } from "./dispatcher.js";
import { MapRedactionRegistry, type ResponseRedactionSpec } from "./redaction.js";
import { GatewayRuntime } from "./runtime.js";
import {
  InMemoryIdempotencyStore,
  InMemoryPrincipalResolver,
  InMemoryRateLimitChecker,
  InMemoryRouteRegistry,
} from "./stores.js";

const ROLES: ReadonlyMap<string, RoleDefinition> = new Map([
  ["clinician", { name: "clinician" }],
  ["front_desk", { name: "front_desk" }],
]);

function publicRoute(): RouteDefinition {
  return {
    id: "rt_patients001",
    operationId: "patients.list",
    method: "GET",
    pathSegments: [
      { kind: "literal", value: "v1" },
      { kind: "literal", value: "patients" },
    ],
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
  };
}

function getRequest(): IncomingRequest {
  return buildIncomingRequest({
    id: "req_patients00001",
    receivedAt: "2026-06-03T12:00:00.000Z",
    method: "GET",
    path: "/v1/patients",
    headers: {},
    host: "api.example.com",
    scheme: "https",
    bodyBytes: null,
    clientIp: "203.0.113.7",
  });
}

const PATIENT_BODY = {
  data: [
    { id: "p1", mrn: "MRN-001", given_name: "Ada", status: "active" },
    { id: "p2", mrn: "MRN-002", given_name: "Linus", status: "inactive" },
  ],
  cursor: "next",
};

function specForRole(role: string): ResponseRedactionSpec {
  return {
    classifiedFields: [
      { name: "mrn", classification: "phi" },
      { name: "given_name", classification: "pii" },
      { name: "status" },
    ],
    roles: ROLES,
    rolesForPrincipal: () => ({ primaryRole: role }),
    policy: { privilegedRoles: ["clinician"] },
  };
}

function buildRuntime(role: string): GatewayRuntime {
  const routes = new InMemoryRouteRegistry().register(publicRoute());
  const handlers = new HandlerRegistry().register("patients.list", () => ({
    kind: "json",
    status: 200,
    body: PATIENT_BODY,
  }));
  return new GatewayRuntime({
    routes,
    handlers,
    principalResolver: new InMemoryPrincipalResolver(),
    idempotencyStore: new InMemoryIdempotencyStore(),
    rateLimitChecker: new InMemoryRateLimitChecker({ limit: 100 }),
    clock: { now: () => new Date("2026-06-03T12:00:00.000Z") },
    redactionRegistry: new MapRedactionRegistry().register("patients.list", specForRole(role)),
  });
}

function parseBody(bytes: Uint8Array | null): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(bytes ?? new Uint8Array())) as Record<string, unknown>;
}

describe("GatewayRuntime — response redaction by classification", () => {
  it("strips PHI/PII fields for a non-privileged principal", async () => {
    const { response, execution } = await buildRuntime("front_desk").handleRequest(getRequest());
    expect(response.status).toBe(200);
    const body = parseBody(response.bodyBytes);
    const rows = body["data"] as Array<Record<string, unknown>>;
    expect(rows[0]).toEqual({ id: "p1", status: "active" });
    expect(rows[1]).toEqual({ id: "p2", status: "inactive" });
    expect(body["cursor"]).toBe("next");
    const transform = execution.stages.find((s) => s.stage === "transform_response");
    expect(transform?.reason).toBe("redacted_2_fields");
  });

  it("returns the full record for a privileged principal", async () => {
    const { response } = await buildRuntime("clinician").handleRequest(getRequest());
    const body = parseBody(response.bodyBytes);
    const rows = body["data"] as Array<Record<string, unknown>>;
    expect(rows[0]).toEqual({ id: "p1", mrn: "MRN-001", given_name: "Ada", status: "active" });
  });

  it("recomputes content-length after redaction", async () => {
    const { response } = await buildRuntime("front_desk").handleRequest(getRequest());
    const actual = (response.bodyBytes ?? new Uint8Array()).byteLength;
    expect(Number(response.headers["content-length"])).toBe(actual);
  });

  it("leaves responses untouched when no registry is configured", async () => {
    const routes = new InMemoryRouteRegistry().register(publicRoute());
    const handlers = new HandlerRegistry().register("patients.list", () => ({
      kind: "json",
      status: 200,
      body: PATIENT_BODY,
    }));
    const runtime = new GatewayRuntime({
      routes,
      handlers,
      principalResolver: new InMemoryPrincipalResolver(),
      idempotencyStore: new InMemoryIdempotencyStore(),
      rateLimitChecker: new InMemoryRateLimitChecker({ limit: 100 }),
      clock: { now: () => new Date("2026-06-03T12:00:00.000Z") },
    });
    const { response } = await runtime.handleRequest(getRequest());
    const rows = parseBody(response.bodyBytes)["data"] as Array<Record<string, unknown>>;
    expect(rows[0]).toHaveProperty("mrn");
  });
});
