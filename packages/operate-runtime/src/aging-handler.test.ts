import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import { buildIncomingRequest, type HandlerOutput } from "@crossengin/api-gateway-runtime";
import type { RoleName } from "@crossengin/auth";
import { beforeEach, describe, expect, it } from "vitest";

import { buildAgingHandler, type AgingSpec } from "./aging-handler.js";
import { InMemoryEntityStore } from "./store.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

const principalRoles = (p: ResolvedPrincipal | null) => ({
  primaryRole: p?.grantedScopes[0] ?? "anonymous",
});

function principal(role: string): ResolvedPrincipal {
  return {
    principalId: "00000000-0000-4000-8000-0000000000aa",
    tenantId: TENANT,
    principalKind: "user",
    authScheme: "api_key_header",
    grantedScopes: [role],
    mfaProofAgeSeconds: null,
    resolvedAt: "2026-06-03T12:00:00.000Z",
  };
}

const sections: Record<string, AgingSpec> = {
  ar: { entity: "Invoice", openStates: ["sent", "overdue"], paymentRefField: "invoice_id", numberField: "invoice_number" },
};

const clock = { now: () => new Date("2026-06-21T00:00:00.000Z") };

function buildHandler(store: InMemoryEntityStore) {
  return buildAgingHandler({
    store,
    principalRoles,
    viewerRoles: new Set<RoleName>(["erp_admin" as RoleName]),
    sections,
    clock,
  });
}

function invoke(handler: ReturnType<typeof buildHandler>, query?: Record<string, string>): Promise<HandlerOutput> {
  const request = buildIncomingRequest({
    id: "req_aging00000001",
    receivedAt: "2026-06-21T12:00:00.000Z",
    method: "GET",
    path: "/v1/meta/aging",
    headers: {},
    host: "api.example.com",
    scheme: "https",
    bodyBytes: null,
    clientIp: "203.0.113.1",
    ...(query !== undefined ? { query } : {}),
  });
  return handler({
    request,
    route: {} as never,
    principal: principal("erp_admin"),
    params: {},
    parsedBody: null,
  });
}

function bodyOf(out: HandlerOutput): { asOf: string } {
  if (out.kind !== "json") throw new Error("expected json");
  return out.body as { asOf: string };
}

describe("buildAgingHandler — ?asOf", () => {
  let store: InMemoryEntityStore;
  beforeEach(async () => {
    store = new InMemoryEntityStore();
    await store.create(TENANT, "Invoice", {
      invoice_number: "INV-1",
      state: "sent",
      total: 100,
      currency: "USD",
      due_date: "2026-05-01",
    });
  });

  it("uses the clock when ?asOf is absent", async () => {
    const out = await invoke(buildHandler(store));
    expect(bodyOf(out).asOf).toBe("2026-06-21");
  });

  it("honors a valid ?asOf (historical snapshot)", async () => {
    const out = await invoke(buildHandler(store), { asOf: "2026-04-15" });
    expect(bodyOf(out).asOf).toBe("2026-04-15");
  });

  it("ignores a malformed ?asOf and falls back to the clock", async () => {
    const out = await invoke(buildHandler(store), { asOf: "not-a-date" });
    expect(bodyOf(out).asOf).toBe("2026-06-21");
  });

  it("ignores an out-of-shape ?asOf (year only) and falls back to the clock", async () => {
    const out = await invoke(buildHandler(store), { asOf: "2026" });
    expect(bodyOf(out).asOf).toBe("2026-06-21");
  });
});
