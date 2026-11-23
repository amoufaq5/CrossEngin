import { STARTER_CHART_VERSION, type StarterChartReport } from "@crossengin/operate-runtime";
import { describe, expect, it } from "vitest";

import type { TenantRecord, TenantStatus } from "./platform-tenants.js";
import {
  STARTER_CHART_PROVISIONED_OPERATION,
  buildStarterChartRoutes,
  type StarterChartProvisioningEvent,
  type StarterChartRoutesContext,
} from "./starter-chart-routes.js";

const TENANT = "22222222-2222-4222-8222-222222222222";
const OPERATOR = "99999999-9999-4999-8999-999999999999";
const PROVISIONING = "55555555-5555-4555-8555-555555555555";
const AT = "2026-11-23T10:00:00.000Z";

const REPORT: StarterChartReport = {
  outcome: "complete",
  version: STARTER_CHART_VERSION,
  created: ["1000"],
  existing: ["1100"],
  refused: [],
  settingsFilled: ["cashAccountCode"],
  settingsSkipped: [],
  settingsDangling: [],
};

const ACTING_ROLES = ["erp_admin"] as const;

function tenant(status: TenantStatus = "active"): TenantRecord {
  return {
    id: TENANT,
    slug: "acme",
    name: "Acme Ltd",
    status,
    tier: "small",
    region: "eu",
    schemaName: "t_acme",
    searchLocale: "simple",
    createdAt: AT,
    updatedAt: AT,
  };
}

interface Harness {
  readonly ctx: StarterChartRoutesContext;
  readonly acts: string[];
  readonly records: StarterChartProvisioningEvent[];
  readonly provisions: { tenantId: string; provisioningId: string; principalId: string }[];
}

function harness(opts: {
  roles?: readonly string[];
  tenant?: TenantRecord | null;
  recordThrows?: boolean;
  provisionThrows?: unknown;
} = {}): Harness {
  const h: Harness = { ctx: undefined as unknown as StarterChartRoutesContext, acts: [], records: [], provisions: [] };
  const ctx: StarterChartRoutesContext = {
    tenants: {
      getById: async (id) => {
        h.acts.push(`get:${id}`);
        return opts.tenant === undefined ? tenant() : opts.tenant;
      },
    },
    principalRoles: () => {
      const roles = opts.roles ?? ["erp_viewer", "platform_admin"];
      return { primaryRole: roles[0] ?? "anonymous", secondaryRoles: roles.slice(1) };
    },
    adminRoles: new Set(["platform_admin"]),
    actingRoles: ACTING_ROLES,
    provision: async (tenantId, by) => {
      h.acts.push("provision");
      h.provisions.push({ tenantId, ...by });
      if (opts.provisionThrows !== undefined) throw opts.provisionThrows;
      return REPORT;
    },
    record: async (event) => {
      h.acts.push("record");
      if (opts.recordThrows === true) throw new Error("audit down");
      h.records.push(event);
    },
    newProvisioningId: () => PROVISIONING,
    clock: () => new Date(AT),
  };
  (h as { ctx: StarterChartRoutesContext }).ctx = ctx;
  return h;
}

type Out = { status: number; body: unknown };

function call(h: Harness, input: { principal?: unknown; id?: string; body?: unknown } = {}): Promise<Out> {
  const [route] = buildStarterChartRoutes(h.ctx);
  if (route === undefined) throw new Error("no route");
  const handler = route.handler as unknown as (input: Record<string, unknown>) => Promise<Out>;
  return handler({
    principal: input.principal === undefined ? { principalId: OPERATOR } : input.principal,
    params: { id: input.id ?? TENANT },
    request: {},
    parsedBody: "body" in input ? input.body : {},
  });
}

describe("buildStarterChartRoutes", () => {
  it("declares one POST route under the tenant's path", () => {
    const routes = buildStarterChartRoutes(harness().ctx);
    expect(routes).toHaveLength(1);
    const route = routes[0]?.route;
    expect(route?.operationId).toBe("platform.tenants.starter_chart");
    expect(route?.method).toBe("POST");
    expect(route?.pathSegments.map((s) => (s.kind === "literal" ? s.value : s.kind === "parameter" ? `{${s.name}}` : "*"))).toEqual([
      "v1",
      "platform",
      "tenants",
      "{id}",
      "starter-chart",
    ]);
  });

  it("names the audit operation", () => {
    expect(STARTER_CHART_PROVISIONED_OPERATION).toBe("platform.starter_chart_provisioned");
  });
});

describe("the starter-chart route", () => {
  it("401s with no principal and touches nothing", async () => {
    const h = harness();
    const out = await call(h, { principal: null });
    expect(out.status).toBe(401);
    expect(out.body).toEqual({ error: "authentication_required" });
    expect(h.acts).toEqual([]);
  });

  it("403s without the platform-admin grant, before reading the tenant", async () => {
    const h = harness({ roles: ["erp_admin", "user_admin"] });
    const out = await call(h);
    expect(out.status).toBe(403);
    expect(out.body).toEqual({ error: "forbidden", detail: "insufficient role" });
    expect(h.acts).toEqual([]);
  });

  it("accepts the grant as a secondary role", async () => {
    const out = await call(harness({ roles: ["erp_viewer", "platform_admin"] }));
    expect(out.status).toBe(200);
  });

  it.each([[{ currency: "EUR" }], [{ starterChart: true }], [[]], ["x"]])(
    "400s a body %j that is not empty, recording nothing",
    async (body) => {
      const h = harness();
      const out = await call(h, { body });
      expect(out.status).toBe(400);
      expect(out.body).toEqual({ error: "invalid_request", detail: "this route takes no options" });
      expect(h.acts).toEqual([]);
    },
  );

  it("treats an absent body as empty", async () => {
    const out = await call(harness(), { body: undefined });
    expect(out.status).toBe(200);
  });

  it("404s an unknown tenant, naming the id it looked for", async () => {
    const h = harness({ tenant: null });
    const out = await call(h, { id: "nope" });
    expect(out.status).toBe(404);
    expect(out.body).toEqual({ error: "tenant_not_found", detail: "nope" });
    expect(h.acts).toEqual(["get:nope"]);
  });

  it.each<[TenantStatus]>([["suspended"], ["archived"], ["pending_deletion"], ["deleted"]])(
    "409s a %s tenant and records nothing",
    async (status) => {
      const h = harness({ tenant: tenant(status) });
      const out = await call(h);
      expect(out.status).toBe(409);
      expect(out.body).toMatchObject({ error: "tenant_not_active" });
      expect((out.body as { detail: string }).detail).toContain(status);
      expect(h.records).toEqual([]);
      expect(h.provisions).toEqual([]);
    },
  );

  it("records the act before provisioning, with one provisioning id on both", async () => {
    const h = harness({ roles: ["platform_admin", "user_admin"] });
    const out = await call(h);
    expect(out.status).toBe(200);
    expect(h.acts).toEqual([`get:${TENANT}`, "record", "provision"]);
    expect(h.records).toEqual([
      {
        tenantId: TENANT,
        provisioningId: PROVISIONING,
        principalId: OPERATOR,
        roles: ["platform_admin", "user_admin"],
        actingRoles: ["erp_admin"],
        chartVersion: STARTER_CHART_VERSION,
        at: AT,
      },
    ]);
    expect(h.provisions).toEqual([{ tenantId: TENANT, provisioningId: PROVISIONING, principalId: OPERATOR }]);
  });

  it("answers the report with the tenant and the provisioning id", async () => {
    const out = await call(harness());
    expect(out.body).toEqual({ tenantId: TENANT, provisioningId: PROVISIONING, starterChart: REPORT });
  });

  it("is 503 and provisions nothing when the act cannot be recorded", async () => {
    const h = harness({ recordThrows: true });
    const out = await call(h);
    expect(out.status).toBe(503);
    expect(out.body).toMatchObject({ error: "audit_unavailable" });
    expect(h.provisions).toEqual([]);
    expect(h.acts).not.toContain("provision");
  });

  it("is 500 naming the error and the provisioning id, and never the error's message", async () => {
    const err = new Error("relation meta.users leaked secret-value at 10.0.0.5");
    err.name = "TenantGatewayUnavailable";
    const out = await call(harness({ provisionThrows: err }));
    expect(out.status).toBe(500);
    expect(out.body).toMatchObject({ error: "starter_chart_failed", provisioningId: PROVISIONING });
    const text = JSON.stringify(out.body);
    expect(text).toContain("TenantGatewayUnavailable");
    expect(text).not.toContain("secret-value");
    expect(text).not.toContain("10.0.0.5");
  });

  it("does not promise that a plain rerun helps: the cause has to be fixed first", async () => {
    const err = new Error("details");
    err.name = "SettingsRowUnreadable";
    const out = await call(harness({ provisionThrows: err }));
    const detail = (out.body as { detail: string }).detail;
    expect(detail).toMatch(/^SettingsRowUnreadable;/);
    expect(detail).toContain("once the cause is fixed");
    expect(detail).toContain("accounts already created are kept");
    expect(detail).not.toContain("details");
  });

  it("records the roles the accounts are written as, apart from the operator's own", async () => {
    const h = harness({ roles: ["platform_admin"] });
    const ctx: StarterChartRoutesContext = { ...h.ctx, actingRoles: ["erp_admin", "controller"] };
    const route = buildStarterChartRoutes(ctx)[0];
    const handler = route?.handler as unknown as (input: Record<string, unknown>) => Promise<Out>;
    await handler({ principal: { principalId: OPERATOR }, params: { id: TENANT }, request: {}, parsedBody: {} });
    expect(h.records[0]?.roles).toEqual(["platform_admin"]);
    expect(h.records[0]?.actingRoles).toEqual(["erp_admin", "controller"]);
    expect(h.records[0]?.chartVersion).toBe(STARTER_CHART_VERSION);
  });

  it("is 500 with an unknown error for a thrown non-Error", async () => {
    const out = await call(harness({ provisionThrows: "boom" }));
    expect(out.status).toBe(500);
    expect((out.body as { detail: string }).detail).toMatch(/^unknown;/);
  });

  it("mints a fresh provisioning id per call", async () => {
    let n = 0;
    const h = harness();
    const ctx: StarterChartRoutesContext = { ...h.ctx, newProvisioningId: () => `p-${(++n).toString()}` };
    const route = buildStarterChartRoutes(ctx)[0];
    const handler = route?.handler as unknown as (input: Record<string, unknown>) => Promise<Out>;
    const input = { principal: { principalId: OPERATOR }, params: { id: TENANT }, request: {}, parsedBody: {} };
    const a = await handler(input);
    const b = await handler(input);
    expect((a.body as { provisioningId: string }).provisioningId).toBe("p-1");
    expect((b.body as { provisioningId: string }).provisioningId).toBe("p-2");
  });
});
