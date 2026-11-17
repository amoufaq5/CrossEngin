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

interface Harness {
  readonly store: InMemoryEntityStore;
  readonly settings: InMemorySettingsStore;
  readonly allocator: InMemorySequenceAllocator;
  readonly server: CompiledOperateServer;
  call(opId: string, opts?: { params?: Record<string, string>; body?: Record<string, unknown> }): Promise<{ status: number; body: Record<string, unknown> }>;
}

function harness(): Harness {
  const store = new InMemoryEntityStore();
  const settings = new InMemorySettingsStore();
  const allocator = new InMemorySequenceAllocator();
  const server = compileOperateServer(manifest, {
    store,
    settingsStore: settings,
    allocator,
    clock: { now: () => new Date("2026-06-15T12:00:00.000Z") },
    principalRoles: (p: ResolvedPrincipal | null) => ({ primaryRole: p?.grantedScopes[0] ?? "anonymous" }),
  });
  const call: Harness["call"] = async (opId, opts = {}) => {
    const spec = server.routeSpecs.find((s) => s.operationId === opId);
    if (spec === undefined) throw new Error(`no route ${opId}`);
    const out: HandlerOutput = await server.handlers.resolve(opId)!({
      request: buildIncomingRequest({
        id: "req_h15000000001",
        receivedAt: "2026-06-15T12:00:00.000Z",
        method: spec.method,
        path: "/v1/x",
        headers: {},
        host: "api.example.com",
        scheme: "https",
        bodyBytes: null,
        clientIp: "203.0.113.1",
        edgeTrust: "untrusted",
      }),
      route: routeFromSpec(spec),
      principal: {
        principalId: "00000000-0000-4000-8000-0000000000aa",
        tenantId: TENANT,
        principalKind: "user",
        authScheme: "api_key_header",
        grantedScopes: ["erp_admin"],
        mfaProofAgeSeconds: null,
        resolvedAt: "2026-06-15T12:00:00.000Z",
      },
      params: opts.params ?? {},
      parsedBody: opts.body ?? null,
    });
    if (out.kind !== "json") throw new Error(`expected json from ${opId}`);
    return { status: out.status, body: out.body as Record<string, unknown> };
  };
  return { store, settings, allocator, server, call };
}

const INVOICE = { account_id: "acc1", currency: "USD", issue_date: "2026-06-15", due_date: "2026-07-15" };

describe("a create refused before it is written spends no document number", () => {
  it("keeps invoice numbers contiguous across a validation, a guard and an id-conflict refusal", async () => {
    const h = harness();
    const numbers: unknown[] = [];
    numbers.push((await h.call("invoice.create", { body: INVOICE })).body["invoice_number"]);
    expect((await h.call("invoice.create", { body: { ...INVOICE, due_date: 5 } })).status).toBe(422);
    // The lifecycle guard refuses a create that is not in the initial state.
    const guarded = await h.call("invoice.create", { body: { ...INVOICE, state: "sent" } });
    expect(guarded.body["error"]).toBe("lifecycle_state_not_initial");
    numbers.push((await h.call("invoice.create", { body: { ...INVOICE, id: "inv_fixed" } })).body["invoice_number"]);
    expect((await h.call("invoice.create", { body: { ...INVOICE, id: "inv_fixed" } })).body["error"]).toBe("id_conflict");
    numbers.push((await h.call("invoice.create", { body: INVOICE })).body["invoice_number"]);
    expect(numbers).toEqual(["INV-2026-00001", "INV-2026-00002", "INV-2026-00003"]);
    expect(h.allocator.peek(TENANT, "erp.invoice", "2026")).toBe(3);
  });

  it("still answers a refused create the same way when it carries its own number", async () => {
    const h = harness();
    const refused = await h.call("invoice.create", { body: { ...INVOICE, invoice_number: "LEGACY-1", state: "sent" } });
    expect(refused.body["error"]).toBe("lifecycle_state_not_initial");
    expect(h.allocator.peek(TENANT, "erp.invoice", "2026")).toBeNull();
  });
});

describe("tax determination through the compiled server", () => {
  async function seed(h: Harness, jurisdiction: string | undefined) {
    if (jurisdiction !== undefined) await h.settings.put(TENANT, { finance: { defaultTaxJurisdiction: jurisdiction } });
    const j = await h.store.create(TENANT, "TaxJurisdiction", { code: "UK", name: "UK", country: "GB", is_active: true });
    await h.store.create(TENANT, "TaxCode", { id: "vat", code: "VAT", name: "VAT", rate_pct: 15, kind: "vat", is_active: true });
    await h.store.create(TENANT, "TaxRule", {
      jurisdiction_id: j.id,
      tax_code_id: "vat",
      name: "UK standard",
      applies_to: "sales",
      rate_category: "standard",
      rate_pct: 20,
      effective_from: "2011-01-04",
    });
    const inv = await h.call("invoice.create", { body: { ...INVOICE, subtotal: 100, tax_total: 20, total: 120 } });
    const id = String(inv.body["id"]);
    await h.store.create(TENANT, "InvoiceLine", { invoice_id: id, line_total: 100, tax_rate_pct: 0, tax_code_id: null });
    return id;
  }

  it("posts the uncoded line at the jurisdiction's standard rule rate, balanced", async () => {
    const h = harness();
    const id = await seed(h, "UK");
    expect((await h.call("invoice.send", { params: { id } })).status).toBe(200);
    const lines = await h.store.list(TENANT, "JournalLine");
    expect(lines.find((l) => String(l["description"]).includes("(VAT)"))?.["credit"]).toBe("20.00");
    const cents = (k: string) => lines.reduce((s, l) => s + Math.round(Number(l[k] ?? 0) * 100), 0);
    expect(cents("debit")).toBe(cents("credit"));
  });

  it("refuses the send with 409 for a jurisdiction the tenant does not have, and leaves the invoice a draft", async () => {
    const h = harness();
    const id = await seed(h, "XX");
    const out = await h.call("invoice.send", { params: { id } });
    expect(out.status).toBe(409);
    expect(out.body["error"]).toBe("tax_jurisdiction_unresolved");
    expect((await h.store.get(TENANT, "Invoice", id))?.["state"]).toBe("draft");
    expect(await h.store.list(TENANT, "JournalEntry")).toHaveLength(0);
  });

  it("leaves a tenant that declares no jurisdiction exactly as it was", async () => {
    const h = harness();
    const id = await seed(h, undefined);
    expect((await h.call("invoice.send", { params: { id } })).status).toBe(200);
    // No code on the line and no determination: the line split (100 + 0) does not reconcile with the
    // total, so the header's own split stands — revenue 100 and one aggregate tax line at 20 — and no
    // per-code line exists.
    const lines = await h.store.list(TENANT, "JournalLine");
    expect(lines.some((l) => String(l["description"]).includes("(VAT)"))).toBe(false);
    expect(lines.find((l) => l["description"] === "Invoice — tax payable")?.["credit"]).toBe("20.00");
    expect(lines.find((l) => l["description"] === "Invoice — revenue")?.["credit"]).toBe("100.00");
  });
});
