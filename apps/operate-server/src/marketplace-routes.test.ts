import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import type { Handler, HandlerInput, HandlerOutput } from "@crossengin/api-gateway-runtime";
import type { PackInstallation } from "@crossengin/marketplace";
import type { PostgresPackInstallationStore } from "@crossengin/marketplace-pg";
import { describe, expect, it } from "vitest";

import { buildMarketplaceRoutes } from "./marketplace-routes.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-0000000000aa";

function installed(over: Partial<PackInstallation> = {}): PackInstallation {
  return {
    id: "inst-1",
    tenantId: TENANT,
    packId: "acme.crm.sales",
    installedVersion: "1.0.0",
    pinnedVersion: null,
    status: "installed",
    updatePolicy: "manual",
    config: {},
    permissionGrants: [],
    requestedAt: "2026-06-11T00:00:00.000Z",
    requestedBy: USER,
    installedAt: "2026-06-11T00:05:00.000Z",
    installedBy: USER,
    lastUpdatedAt: "2026-06-11T00:05:00.000Z",
    uninstalledAt: null,
    uninstalledBy: null,
    ...over,
  } as unknown as PackInstallation;
}

/** A structural fake store recording writes; only the 3 methods the routes use. */
function fakeStore(active: PackInstallation | null = null, list: readonly PackInstallation[] = []): {
  store: PostgresPackInstallationStore;
  recorded: PackInstallation[];
} {
  const recorded: PackInstallation[] = [];
  const store = {
    listForTenant: async () => list,
    activeForPack: async () => active,
    record: async (i: PackInstallation) => void recorded.push(i),
  } as unknown as PostgresPackInstallationStore;
  return { store, recorded };
}

const DEPS = { now: () => new Date("2026-06-11T12:00:00.000Z"), newId: () => "11111111-1111-4111-8111-111111111111" };

const PRINCIPAL = { tenantId: TENANT, principalId: USER } as unknown as ResolvedPrincipal;

function input(over: Partial<HandlerInput>): HandlerInput {
  return {
    request: { query: {} },
    principal: PRINCIPAL,
    params: {},
    parsedBody: null,
    ...over,
  } as unknown as HandlerInput;
}

function handlerFor(routes: ReturnType<typeof buildMarketplaceRoutes>, op: string): Handler {
  const r = routes.find((x) => x.operationId === op);
  if (r === undefined) throw new Error(`no route ${op}`);
  return r.handler;
}

describe("buildMarketplaceRoutes", () => {
  it("registers GET/POST/DELETE on /v1/marketplace/installations", () => {
    const routes = buildMarketplaceRoutes(fakeStore().store, DEPS);
    expect(routes.map((r) => `${r.definition.method} ${r.operationId}`).sort()).toEqual([
      "DELETE marketplace.uninstall",
      "GET marketplace.list",
      "POST marketplace.install",
    ]);
  });

  it("list returns 200 with the tenant's installations", async () => {
    const routes = buildMarketplaceRoutes(fakeStore(null, [installed()]).store, DEPS);
    const out = (await handlerFor(routes, "marketplace.list")(input({}))) as Extract<HandlerOutput, { kind: "json" }>;
    expect(out.status).toBe(200);
    expect((out.body as { installations: PackInstallation[] }).installations).toHaveLength(1);
  });

  it("install (201) drives the engine + records an 'installed' record", async () => {
    const fs = fakeStore(null);
    const routes = buildMarketplaceRoutes(fs.store, DEPS);
    const out = (await handlerFor(routes, "marketplace.install")(
      input({ parsedBody: { packId: "acme.crm.sales", version: "2.0.0" } }),
    )) as Extract<HandlerOutput, { kind: "json" }>;
    expect(out.status).toBe(201);
    expect(fs.recorded[0]!.status).toBe("installed");
    expect(fs.recorded[0]!.installedVersion).toBe("2.0.0");
    expect(fs.recorded[0]!.installedBy).toBe(USER);
  });

  it("install (409) when an active install already exists", async () => {
    const routes = buildMarketplaceRoutes(fakeStore(installed()).store, DEPS);
    const out = (await handlerFor(routes, "marketplace.install")(
      input({ parsedBody: { packId: "acme.crm.sales", version: "2.0.0" } }),
    )) as Extract<HandlerOutput, { kind: "json" }>;
    expect(out.status).toBe(409);
  });

  it("install (422) on a missing packId/version", async () => {
    const routes = buildMarketplaceRoutes(fakeStore(null).store, DEPS);
    const out = (await handlerFor(routes, "marketplace.install")(input({ parsedBody: { packId: "acme.crm.sales" } }))) as Extract<HandlerOutput, { kind: "json" }>;
    expect(out.status).toBe(422);
  });

  it("uninstall (200) for an installed pack / (404) otherwise", async () => {
    const ok = buildMarketplaceRoutes(fakeStore(installed()).store, DEPS);
    const out200 = (await handlerFor(ok, "marketplace.uninstall")(input({ params: { packId: "acme.crm.sales" } }))) as Extract<HandlerOutput, { kind: "json" }>;
    expect(out200.status).toBe(200);

    const missing = buildMarketplaceRoutes(fakeStore(null).store, DEPS);
    const out404 = (await handlerFor(missing, "marketplace.uninstall")(input({ params: { packId: "nope.pack.x" } }))) as Extract<HandlerOutput, { kind: "json" }>;
    expect(out404.status).toBe(404);
  });

  it("returns 401 when the principal has no tenant", async () => {
    const routes = buildMarketplaceRoutes(fakeStore().store, DEPS);
    const out = (await handlerFor(routes, "marketplace.list")(input({ principal: null }))) as Extract<HandlerOutput, { kind: "json" }>;
    expect(out.status).toBe(401);
  });
});
