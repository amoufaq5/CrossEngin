import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import { buildIncomingRequest, type HandlerOutput } from "@crossengin/api-gateway-runtime";
import { buildErpCorePack } from "@crossengin/pack-erp-core";
import { describe, expect, it } from "vitest";

import { compileOperateServer, type CompiledOperateServer } from "./compile.js";
import { routeFromSpec } from "./operations.js";
import { InMemorySequenceAllocator } from "./sequences.js";
import { InMemorySettingsStore } from "./settings.js";
import { InMemoryEntityStore } from "./store.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const manifest = buildErpCorePack();

const principalRoles = (p: ResolvedPrincipal | null) => ({ primaryRole: p?.grantedScopes[0] ?? "anonymous" });

function principal(role: string | null): ResolvedPrincipal | null {
  if (role === null) return null;
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

function build(now = new Date("2026-03-07T10:00:00Z")): {
  server: CompiledOperateServer;
  settings: InMemorySettingsStore;
} {
  const settings = new InMemorySettingsStore();
  const server = compileOperateServer(manifest, {
    store: new InMemoryEntityStore(),
    principalRoles,
    allocator: new InMemorySequenceAllocator(),
    settingsStore: settings,
    adminRoles: ["erp_admin"],
    clock: { now: () => now },
  });
  return { server, settings };
}

async function invoke(
  server: CompiledOperateServer,
  opId: string,
  opts: { role: string | null; params?: Record<string, string>; body?: Record<string, unknown> },
): Promise<HandlerOutput> {
  const spec = server.routeSpecs.find((s) => s.operationId === opId);
  const route = spec !== undefined ? routeFromSpec(spec) : { method: "POST" as const };
  const handler = server.handlers.resolve(opId);
  if (handler === undefined) throw new Error(`no handler for ${opId}`);
  const request = buildIncomingRequest({
    id: "req_op000000001",
    receivedAt: "2026-06-03T12:00:00.000Z",
    method: (route as { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" }).method,
    path: "/v1/x",
    headers: {},
    host: "api.example.com",
    scheme: "https",
    bodyBytes: null,
    clientIp: "203.0.113.1",
  });
  return handler({
    request,
    route: route as never,
    principal: principal(opts.role),
    params: opts.params ?? {},
    parsedBody: opts.body ?? null,
  });
}

function bodyOf(out: HandlerOutput): Record<string, unknown> {
  if (out.kind !== "json") throw new Error("expected json output");
  return out.body as Record<string, unknown>;
}

describe("auto-numbering through the create handler", () => {
  it("assigns a formatted, monotonic invoice number", async () => {
    const { server } = build();
    const a = bodyOf(
      await invoke(server, "invoice.create", {
        role: "erp_admin",
        body: { account_id: "acc1", currency: "USD", issue_date: "2026-03-07", due_date: "2026-04-06" },
      }),
    );
    const b = bodyOf(
      await invoke(server, "invoice.create", {
        role: "erp_admin",
        body: { account_id: "acc1", currency: "USD", issue_date: "2026-03-07", due_date: "2026-04-06" },
      }),
    );
    expect(a["invoice_number"]).toBe("INV-2026-00001");
    expect(b["invoice_number"]).toBe("INV-2026-00002");
  });

  it("preserves a caller-supplied number", async () => {
    const { server } = build();
    const a = bodyOf(
      await invoke(server, "invoice.create", {
        role: "erp_admin",
        body: { invoice_number: "LEGACY-9", account_id: "acc1", currency: "USD", issue_date: "2026-03-07", due_date: "2026-04-06" },
      }),
    );
    expect(a["invoice_number"]).toBe("LEGACY-9");
  });

  it("applies an admin numbering override from settings", async () => {
    const { server, settings } = build();
    await settings.put(TENANT, { numbering: { "erp.invoice": { format: "AR/{SEQ:4}", resetPeriod: "never" } } });
    const a = bodyOf(
      await invoke(server, "invoice.create", {
        role: "erp_admin",
        body: { account_id: "acc1", currency: "USD", issue_date: "2026-03-07", due_date: "2026-04-06" },
      }),
    );
    expect(a["invoice_number"]).toBe("AR/0001");
  });
});

describe("admin settings endpoints", () => {
  it("reads and writes settings for an admin", async () => {
    const { server } = build();
    expect(bodyOf(await invoke(server, "admin.settings.read", { role: "erp_admin" }))).toEqual({});
    const put = await invoke(server, "admin.settings.update", {
      role: "erp_admin",
      body: { company: { name: "Acme Corp" } },
    });
    expect(put.status).toBe(200);
    expect(bodyOf(await invoke(server, "admin.settings.read", { role: "erp_admin" })).company).toEqual({ name: "Acme Corp" });
  });

  it("forbids a non-admin role", async () => {
    const { server } = build();
    expect((await invoke(server, "admin.settings.read", { role: "erp_viewer" })).status).toBe(403);
    expect((await invoke(server, "admin.settings.update", { role: "erp_viewer", body: {} })).status).toBe(403);
  });

  it("401s an anonymous caller", async () => {
    const { server } = build();
    expect((await invoke(server, "admin.settings.read", { role: null })).status).toBe(401);
  });

  it("rejects an invalid settings document", async () => {
    const { server } = build();
    const out = await invoke(server, "admin.settings.update", { role: "erp_admin", body: { bogus: true } });
    expect(out.status).toBe(400);
  });
});
