import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import type { Manifest } from "@crossengin/kernel";
import {
  compileOperateServer,
  routeFromSpec,
  InMemoryEntityStore,
  InMemorySettingsStore,
  type EntityRecord,
  type EntityWriteAuditEvent,
} from "@crossengin/operate-runtime";
import { buildErpCorePack } from "@crossengin/pack-erp-core";
import type { JobHandlerContext, JobHandlerProvider, JobHandlerResult } from "@crossengin/workflow-runtime-pg";
import { describe, expect, it } from "vitest";

import {
  buildErpJobProviders,
  depreciationPeriod,
  ERP_JOB_ABSENCES,
  ERP_JOB_HANDLER_IDS,
  erpJobCoverage,
  renderUnits,
  straightLineCharge,
  units,
  type JobAccessResolver,
} from "./erp-job-handlers.js";
import { loadBuiltinPack } from "./manifest-source.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const FIRE = "2026-03-01T01:00:00.000Z";

function harness(opts: { roles?: readonly string[]; manifest?: Manifest; segregationOfDuties?: boolean } = {}) {
  const manifest = opts.manifest ?? buildErpCorePack();
  const store = new InMemoryEntityStore();
  const settings = new InMemorySettingsStore();
  const audited: EntityWriteAuditEvent[] = [];
  const compiled = compileOperateServer(manifest, {
    store,
    settingsStore: settings,
    principalRoles: (p: ResolvedPrincipal | null) => ({
      primaryRole: p?.grantedScopes[0] ?? "anonymous",
      secondaryRoles: p?.grantedScopes.slice(1) ?? [],
    }),
    entityAudit: { record: async (e) => void audited.push(e) },
    clock: { now: () => new Date(FIRE) },
    segregationOfDuties: opts.segregationOfDuties ?? false,
  });
  const coverage = erpJobCoverage(manifest, opts.roles ?? ["erp_admin"], {
    segregationOfDuties: opts.segregationOfDuties ?? false,
  });
  const resolveAccess: JobAccessResolver = async () => ({ kind: "access", access: compiled.systemEntityAccess });
  const providers = buildErpJobProviders({ coverage, resolveAccess, settings, now: () => new Date(FIRE) });
  const seed = (entity: string, record: EntityRecord): Promise<EntityRecord> =>
    store.create(TENANT, entity, { created_at: FIRE, updated_at: FIRE, ...record });
  const run = (jobId: string, extra: Partial<JobHandlerContext> = {}): Promise<JobHandlerResult> => {
    const provider = providers.find((p): p is Extract<JobHandlerProvider, { serves: "job" }> => p.serves === "job" && p.jobId === jobId);
    if (provider === undefined) throw new Error(`no provider for ${jobId}`);
    return provider.handler({
      runId: "run-1",
      tenantId: TENANT,
      jobDefinitionId: jobId,
      jobKind: "scheduled",
      attempts: 1,
      trigger: { kind: "scheduled", cron: "0 1 1 * *", fireAt: FIRE },
      input: {},
      signal: new AbortController().signal,
      ...extra,
    });
  };
  return { manifest, store, settings, audited, compiled, coverage, providers, seed, run };
}

describe("erpJobCoverage", () => {
  it("serves the five erp-core jobs whose work the shipped entities express, and names why for the other nine", () => {
    const { coverage } = harness();
    expect([...coverage.handled].sort()).toEqual([...ERP_JOB_HANDLER_IDS]);
    expect(coverage.handled).toHaveLength(5);
    expect(coverage.declined.map((d) => d.jobId).sort()).toEqual(Object.keys(ERP_JOB_ABSENCES).sort());
    expect(coverage.declined).toHaveLength(9);
    for (const d of coverage.declined) expect(d.reason.length).toBeGreaterThan(20);
  });

  it("says where a served handler does less than its declaration promises", () => {
    const { coverage } = harness();
    expect(coverage.partial.map((p) => p.jobId).sort()).toEqual([
      "erp-core-depreciation-run",
      "erp-core-overdue-invoice-reminder",
      "erp-core-work-order-completion",
    ]);
    expect(coverage.partial.find((p) => p.jobId === "erp-core-overdue-invoice-reminder")?.reason).toMatch(/NOT sent/);
  });

  it("serves nothing when the actor role is not one the manifest declares, and says so per job", () => {
    const { coverage, providers } = harness({ roles: ["ghost_role"] });
    expect(coverage.handled).toEqual([]);
    expect(providers).toHaveLength(0);
    const roleRefusals = coverage.declined.filter((d) => /--job-actor-role/.test(d.reason));
    expect(roleRefusals).toHaveLength(5);
  });

  it("declines a handler by name when a pack replaces the entity it needs", async () => {
    const construction = await loadBuiltinPack("erp-construction");
    const coverage = erpJobCoverage(construction, ["erp_admin"], { segregationOfDuties: false });
    const wo = coverage.declined.find((d) => d.jobId === "erp-core-work-order-completion");
    expect(wo?.reason).toMatch(/WorkOrder\.(completed_quantity|bom_id)/);
    expect(coverage.handled).not.toContain("erp-core-work-order-completion");
  });
});

describe("erpJobCoverage under --segregation-of-duties", () => {
  it("declines the job that would fire an approve-class transition itself, drafting nothing", () => {
    const { coverage, providers } = harness({ segregationOfDuties: true });
    expect(coverage.handled).not.toContain("erp-core-depreciation-run");
    expect(providers.map((p) => (p.serves === "job" ? p.jobId : ""))).not.toContain("erp-core-depreciation-run");
    const declined = coverage.declined.find((d) => d.jobId === "erp-core-depreciation-run");
    expect(declined?.reason).toMatch(/--segregation-of-duties refuses JournalEntry\.post/);
  });

  it("serves the jobs whose output a person approves, and says that a person cannot approve it", () => {
    const { coverage } = harness({ segregationOfDuties: true });
    expect([...coverage.handled].sort()).toEqual([
      "erp-core-inventory-reorder",
      "erp-core-overdue-invoice-reminder",
      "erp-core-sales-order-to-invoice",
      "erp-core-work-order-completion",
    ]);
    const reorder = coverage.partial.find((p) => p.jobId === "erp-core-inventory-reorder");
    expect(reorder?.reason).toMatch(/PurchaseOrder\.approve refuses them for every person/);
    const invoice = coverage.partial.find((p) => p.jobId === "erp-core-sales-order-to-invoice");
    expect(invoice?.reason).toMatch(/Invoice\.mark_paid/);
    // Off, neither sentence is said: the rule it describes is not in force.
    const off = harness().coverage;
    expect(off.handled).toContain("erp-core-depreciation-run");
    expect(off.partial.map((p) => p.reason).join(" ")).not.toMatch(/segregation-of-duties/);
  });

  it("is right that a person cannot approve what a job drafted: the reorder PO cannot be approved", async () => {
    // The sentence above is a claim about the maker-checker rule, so it is pinned against the rule
    // rather than restated: a person holding every grant, firing `approve` on a job-drafted PO.
    const h = harness({ segregationOfDuties: true });
    const item = await h.seed("Item", { sku: "SKU-1", name: "Bolt", item_type: "stock", unit_of_measure: "each", tracking: "none", currency: "USD", status: "active", reorder_point: "10.000", reorder_quantity: "50.000" });
    const old = await h.seed("PurchaseOrder", { po_number: "PO-OLD", vendor_id: "v1", state: "closed", order_date: "2025-12-01", currency: "EUR", subtotal: "0", tax_total: "0", total: "0" });
    await h.seed("PurchaseOrderLine", { purchase_order_id: old["id"], item_id: item["id"], quantity: "1.000", unit_price: "2.5000", received_quantity: "1.000", line_total: "2.50" });
    expect(await h.run("erp-core-inventory-reorder")).toMatchObject({ status: "completed" });
    const draft = (await h.store.listPage(TENANT, "PurchaseOrder", { filters: [{ field: "state", value: "draft" }], sort: [], limit: 10, cursor: null })).records[0]!;
    const person = h.compiled.systemEntityAccess.forTenant(TENANT, { roles: ["erp_admin"], origin: { kind: "job", jobId: "x", runId: "y" } });
    expect(await person.transition("PurchaseOrder", draft["id"] as string, "submit")).toMatchObject({ kind: "written" });
    const spec = h.compiled.routeSpecs.find((s) => s.entity === "PurchaseOrder" && s.transition?.name === "approve")!;
    const out = await h.compiled.handlers.resolve(spec.operationId)!({
      request: { id: "r", receivedAt: FIRE, method: "POST", path: "/", query: {}, headers: {}, host: "h", scheme: "http", bodyBytes: 0, bodySha256: null, clientIp: "127.0.0.1", forwardedFor: [], forwardedProto: null, forwardedHost: null, userAgent: null, tlsVersion: null, tlsCipher: null, clientCertSha256: null, correlationId: null, traceparent: null, tenantHint: null, edgeRegion: null },
      route: routeFromSpec(spec),
      principal: { principalId: "22222222-2222-4222-8222-222222222222", tenantId: TENANT, principalKind: "user", authScheme: "bearer_jwt", grantedScopes: ["erp_admin"], mfaProofAgeSeconds: null, resolvedAt: FIRE },
      params: { id: draft["id"] as string },
      parsedBody: null,
    });
    expect(out.status).toBe(422);
    expect(out.kind === "json" ? (out.body as { error?: string }).error : null).toBe("maker_checker_unverifiable");
  });
});

describe("decimal helpers", () => {
  it("rounds half away from zero at the requested scale and renders padded", () => {
    expect(units("10.005", 2)).toBe(1001n);
    expect(units("10", 3)).toBe(10000n);
    expect(units(null, 2)).toBeNull();
    expect(units("abc", 2)).toBeNull();
    expect(renderUnits(5n, 2)).toBe("0.05");
    expect(renderUnits(-1250n, 2)).toBe("-12.50");
  });
});

describe("straight-line depreciation", () => {
  it("charges from the first full month for exactly the asset's life, summing to the depreciable amount", () => {
    const base = { acquisitionDate: "2026-01-15", cost: 100_000n, salvage: 0n, lifeMonths: 3 };
    const charges = [2, 3, 4, 5].map((month) => straightLineCharge({ ...base, year: 2026, month }));
    expect(charges).toEqual([33_333n, 33_333n, 33_334n, null]);
    expect(straightLineCharge({ ...base, year: 2026, month: 1 })).toBeNull();
  });

  it("never charges more than is left, and nothing once salvage is reached", () => {
    expect(straightLineCharge({ acquisitionDate: "2025-12-01", cost: 7n, salvage: 0n, lifeMonths: 4, year: 2026, month: 4 })).toBe(1n);
    expect(straightLineCharge({ acquisitionDate: "2025-12-01", cost: 500n, salvage: 500n, lifeMonths: 4, year: 2026, month: 1 })).toBeNull();
  });

  it("depreciates the month before the run, ending on that month's last day", () => {
    expect(depreciationPeriod(new Date("2026-03-01T01:00:00Z"))).toMatchObject({ key: "2026-02", endDate: "2026-02-28" });
    expect(depreciationPeriod(new Date("2026-01-01T01:00:00Z"))).toMatchObject({ key: "2025-12", endDate: "2025-12-31" });
  });
});

describe("overdue invoice handler", () => {
  it("moves a past-due sent invoice to overdue through the transition, and leaves the rest", async () => {
    const h = harness();
    const late = await h.seed("Invoice", { account_id: "a1", invoice_number: "INV-1", state: "sent", currency: "USD", issue_date: "2026-01-01", due_date: "2026-02-01", subtotal: "10.00", tax_total: "0.00", total: "10.00", document_type: "invoice" });
    const notYet = await h.seed("Invoice", { account_id: "a1", invoice_number: "INV-2", state: "sent", currency: "USD", issue_date: "2026-01-01", due_date: "2026-03-05", subtotal: "10.00", tax_total: "0.00", total: "10.00", document_type: "invoice" });
    const draft = await h.seed("Invoice", { account_id: "a1", invoice_number: "INV-3", state: "draft", currency: "USD", issue_date: "2026-01-01", due_date: "2026-02-01", subtotal: "10.00", tax_total: "0.00", total: "10.00", document_type: "invoice" });
    const result = await h.run("erp-core-overdue-invoice-reminder");
    expect(result).toEqual({ status: "completed", output: { marked_overdue: 1, examined: 1 } });
    expect((await h.store.get(TENANT, "Invoice", late["id"] as string))?.["state"]).toBe("overdue");
    expect((await h.store.get(TENANT, "Invoice", notYet["id"] as string))?.["state"]).toBe("sent");
    expect((await h.store.get(TENANT, "Invoice", draft["id"] as string))?.["state"]).toBe("draft");
    const row = h.audited.find((e) => e.action === "transition");
    expect(row).toMatchObject({ actorUserId: null, origin: { kind: "job", jobId: "erp-core-overdue-invoice-reminder", runId: "run-1" } });
    expect(await h.run("erp-core-overdue-invoice-reminder")).toEqual({ status: "completed", output: { examined: 0 } });
  });

  it("is refused by the manifest's grants when the actor role lacks the transition, and fails naming it", async () => {
    const h = harness({ roles: ["erp_viewer"] });
    expect(h.coverage.handled).toContain("erp-core-overdue-invoice-reminder");
    await h.seed("Invoice", { account_id: "a1", invoice_number: "INV-1", state: "sent", currency: "USD", issue_date: "2026-01-01", due_date: "2026-02-01", subtotal: "1.00", tax_total: "0.00", total: "1.00", document_type: "invoice" });
    const result = await h.run("erp-core-overdue-invoice-reminder");
    expect(result).toMatchObject({ status: "failed", retryable: false, error: { code: "writes_refused" } });
    expect((result as { error: { message: string } }).error.message).toMatch(/mark_overdue 403 forbidden/);
  });

  it("stops at a cancellation rather than finishing the sweep", async () => {
    const h = harness();
    await h.seed("Invoice", { account_id: "a1", invoice_number: "INV-1", state: "sent", currency: "USD", issue_date: "2026-01-01", due_date: "2026-02-01", subtotal: "1.00", tax_total: "0.00", total: "1.00", document_type: "invoice" });
    const ac = new AbortController();
    ac.abort();
    expect(await h.run("erp-core-overdue-invoice-reminder", { signal: ac.signal })).toMatchObject({ status: "failed", error: { code: "cancelled" } });
  });
});

describe("depreciation handler", () => {
  async function asset(h: ReturnType<typeof harness>, over: EntityRecord = {}) {
    return h.seed("FixedAsset", { asset_tag: "FA-1", name: "Lathe", category: "equipment", acquisition_date: "2026-01-15", acquisition_cost: "1200.00", depreciation_method: "straight_line", useful_life_months: 12, salvage_value: "0.00", state: "in_service", ...over });
  }

  it("refuses, posting nothing, until the tenant names both depreciation accounts", async () => {
    const h = harness();
    await asset(h);
    const result = await h.run("erp-core-depreciation-run");
    expect(result).toMatchObject({ status: "failed", retryable: false, error: { code: "depreciation_accounts_unconfigured" } });
    expect((await h.store.listPage(TENANT, "JournalEntry", { filters: [], sort: [], limit: 10, cursor: null })).records).toHaveLength(0);
  });

  it("posts one balanced entry per asset through the double-entry guard, once per period", async () => {
    const h = harness();
    await asset(h);
    await asset(h, { asset_tag: "FA-2", depreciation_method: "declining_balance" });
    const dr = await h.seed("LedgerAccount", { account_code: "6100", name: "Depreciation expense", account_type: "expense" });
    const cr = await h.seed("LedgerAccount", { account_code: "1590", name: "Accumulated depreciation", account_type: "asset" });
    await h.settings.put(TENANT, { finance: { depreciationExpenseAccountCode: "6100", accumulatedDepreciationAccountCode: "1590" } });
    const result = await h.run("erp-core-depreciation-run");
    expect(result).toEqual({ status: "completed", output: { method_unsupported_declining_balance: 1, charges_due: 1, posted: 1 } });
    const entries = (await h.store.listPage(TENANT, "JournalEntry", { filters: [], sort: [], limit: 10, cursor: null })).records;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ state: "posted", source: "depreciation", entry_date: "2026-02-28" });
    const lines = (await h.store.listPage(TENANT, "JournalLine", { filters: [], sort: [], limit: 10, cursor: null })).records;
    expect(lines.map((l) => [l["ledger_account_id"], l["debit"], l["credit"]]).sort()).toEqual(
      [
        [cr["id"], "0.00", "100.00"],
        [dr["id"], "100.00", "0.00"],
      ].sort(),
    );
    expect(await h.run("erp-core-depreciation-run")).toEqual({
      status: "completed",
      output: { method_unsupported_declining_balance: 1, charges_due: 1, already_posted: 1 },
    });
  });

  it("finishes a draft a previous attempt left half-written rather than opening a second entry", async () => {
    const h = harness();
    const a = await asset(h);
    const dr = await h.seed("LedgerAccount", { account_code: "6100", name: "Dep", account_type: "expense" });
    await h.seed("LedgerAccount", { account_code: "1590", name: "Acc", account_type: "asset" });
    await h.settings.put(TENANT, { finance: { depreciationExpenseAccountCode: "6100", accumulatedDepreciationAccountCode: "1590" } });
    const je = await h.seed("JournalEntry", { entry_number: "JE-1", entry_date: "2026-02-28", source: "depreciation", state: "draft", memo: `x [depreciation:${a["id"] as string}:2026-02]` });
    await h.seed("JournalLine", { journal_entry_id: je["id"], ledger_account_id: dr["id"], debit: "100.00", credit: "0.00", currency: "USD", fx_rate: "1", functional_debit: "0", functional_credit: "0" });
    expect(await h.run("erp-core-depreciation-run")).toEqual({ status: "completed", output: { charges_due: 1, posted: 1 } });
    expect((await h.store.listPage(TENANT, "JournalEntry", { filters: [], sort: [], limit: 10, cursor: null })).records).toHaveLength(1);
    expect((await h.store.listPage(TENANT, "JournalLine", { filters: [], sort: [], limit: 10, cursor: null })).records).toHaveLength(2);
  });
});

describe("inventory reorder handler", () => {
  it("drafts a purchase order from the last supplier for an item below its reorder point, once", async () => {
    const h = harness();
    const item = await h.seed("Item", { sku: "SKU-1", name: "Bolt", item_type: "stock", unit_of_measure: "each", tracking: "none", currency: "USD", status: "active", reorder_point: "10.000", reorder_quantity: "50.000" });
    await h.seed("Item", { sku: "SKU-2", name: "Nut", item_type: "stock", unit_of_measure: "each", tracking: "none", currency: "USD", status: "active", reorder_point: "10.000" });
    await h.seed("StockLevel", { item_id: item["id"], warehouse_id: "w1", quantity_on_hand: "3.000", quantity_reserved: "0.000", quantity_incoming: "0.000" });
    const old = await h.seed("PurchaseOrder", { po_number: "PO-OLD", vendor_id: "v1", state: "closed", order_date: "2025-12-01", currency: "EUR", subtotal: "0", tax_total: "0", total: "0" });
    await h.seed("PurchaseOrderLine", { purchase_order_id: old["id"], item_id: item["id"], quantity: "100.000", unit_price: "2.5000", received_quantity: "100.000", line_total: "250.00" });
    const result = await h.run("erp-core-inventory-reorder");
    expect(result).toEqual({
      status: "completed",
      output: { items_with_reorder_point: 2, below_reorder_point: 2, no_supplier_history: 1, purchase_orders_drafted: 1, lines_drafted: 1 },
    });
    const drafts = (await h.store.listPage(TENANT, "PurchaseOrder", { filters: [{ field: "state", value: "draft" }], sort: [], limit: 10, cursor: null })).records;
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ vendor_id: "v1", currency: "EUR", total: "125.00" });
    const line = (await h.store.listPage(TENANT, "PurchaseOrderLine", { filters: [{ field: "purchase_order_id", value: drafts[0]!["id"] as string }], sort: [], limit: 10, cursor: null })).records[0];
    expect(line).toMatchObject({ quantity: "50.000", unit_price: "2.5000", line_total: "125.00" });
    const again = await h.run("erp-core-inventory-reorder");
    expect(again).toMatchObject({ status: "completed", output: { already_on_order: 1, no_supplier_history: 1 } });
  });
});

describe("sales order to invoice handler", () => {
  async function order(h: ReturnType<typeof harness>, lines: readonly [string, string][], tax = "0.00") {
    const so = await h.seed("SalesOrder", { so_number: "SO-1", account_id: "acc1", state: "fulfilled", order_date: "2026-02-10", currency: "USD", subtotal: "0", tax_total: tax, total: "0" });
    for (const [quantity, fulfilled] of lines) {
      await h.seed("SalesOrderLine", { sales_order_id: so["id"], description: "Widget", quantity, fulfilled_quantity: fulfilled, unit_price: "10.0000", line_total: "0" });
    }
    return so;
  }

  it("invoices the fulfilled quantities and advances the order to invoiced", async () => {
    const h = harness();
    await h.settings.put(TENANT, { finance: { defaultPaymentTermsDays: 30 } });
    const so = await order(h, [["3.000", "3.000"], ["2.000", "2.000"]], "5.00");
    const result = await h.run("erp-core-sales-order-to-invoice", { jobKind: "event", input: { id: so["id"] } });
    expect(result).toEqual({ status: "completed", output: { invoices_created: 1, lines_created: 2, sales_order_invoiced: 1 } });
    const inv = (await h.store.listPage(TENANT, "Invoice", { filters: [], sort: [], limit: 10, cursor: null })).records[0];
    expect(inv).toMatchObject({ state: "draft", subtotal: "50.00", tax_total: "5.00", total: "55.00", due_date: "2026-03-31" });
    expect((await h.store.get(TENANT, "SalesOrder", so["id"] as string))?.["state"]).toBe("invoiced");
    const again = await h.run("erp-core-sales-order-to-invoice", { jobKind: "event", input: { id: so["id"] } });
    expect(again).toEqual({ status: "completed", output: { already_invoiced: 1 } });
  });

  it("refuses to bill a quantity nobody recorded as delivered", async () => {
    const h = harness();
    const so = await order(h, [["3.000", "0.000"]]);
    expect(await h.run("erp-core-sales-order-to-invoice", { input: { id: so["id"] } })).toMatchObject({ status: "failed", retryable: false, error: { code: "nothing_fulfilled" } });
  });

  it("refuses to apportion header tax across a partial delivery", async () => {
    const h = harness();
    const so = await order(h, [["3.000", "1.000"]], "3.00");
    expect(await h.run("erp-core-sales-order-to-invoice", { input: { id: so["id"] } })).toMatchObject({ status: "failed", error: { code: "partial_fulfilment_tax_unallocable" } });
  });

  it("fails naming the refusal when the tenant has no payment terms to give the invoice a due date", async () => {
    const h = harness();
    const so = await order(h, [["1.000", "1.000"]]);
    const result = await h.run("erp-core-sales-order-to-invoice", { input: { id: so["id"] } });
    expect(result).toMatchObject({ status: "failed", retryable: false, error: { code: "writes_refused" } });
    expect((await h.store.get(TENANT, "SalesOrder", so["id"] as string))?.["state"]).toBe("fulfilled");
  });
});

describe("work order completion handler", () => {
  // The movements this handler writes go through the entity routes, so since H-14 they move each
  // StockLevel and are refused below zero — the items must exist and the component must be in stock.
  async function stocked(h: ReturnType<typeof harness>, steelOnHand: string | null) {
    await h.seed("Item", { id: "steel", sku: "STEEL", name: "Steel", item_type: "stock", standard_cost: "2.0000" });
    await h.seed("Item", { id: "fg", sku: "FG", name: "Finished good", item_type: "stock", standard_cost: "9.0000" });
    if (steelOnHand !== null) await h.seed("StockLevel", { item_id: "steel", warehouse_id: "w1", quantity_on_hand: steelOnHand });
  }
  const onHand = async (h: ReturnType<typeof harness>, item: string): Promise<string | undefined> =>
    (await h.store.listPage(TENANT, "StockLevel", { filters: [{ field: "item_id", value: item }], sort: [], limit: 10, cursor: null }))
      .records.map((l) => String(l["quantity_on_hand"]))[0];

  it("issues each component per the BOM with scrap and receives the finished good, once", async () => {
    const h = harness();
    await stocked(h, "20.000");
    const bom = await h.seed("BillOfMaterials", { bom_code: "B1", item_id: "fg", version: "1", output_quantity: "1.000", status: "active" });
    await h.seed("BomLine", { bom_id: bom["id"], component_item_id: "steel", quantity: "2.0000", scrap_pct: "10.00" });
    const wo = await h.seed("WorkOrder", { wo_number: "WO-1", item_id: "fg", bom_id: bom["id"], warehouse_id: "w1", quantity: "5.000", completed_quantity: "5.000", state: "completed" });
    const result = await h.run("erp-core-work-order-completion", { input: { id: wo["id"] } });
    expect(result).toEqual({ status: "completed", output: { issue_movements: 1, receipt_movements: 1 } });
    const moves = (await h.store.listPage(TENANT, "StockMovement", { filters: [], sort: [], limit: 10, cursor: null })).records;
    expect(moves.map((m) => [m["movement_type"], m["item_id"], m["quantity"], m["reference"]]).sort()).toEqual([
      ["issue", "steel", "11.000", `WO:${wo["id"] as string}`],
      ["receipt", "fg", "5.000", `WO:${wo["id"] as string}`],
    ]);
    expect(await onHand(h, "steel")).toBe("9.000");
    expect(await onHand(h, "fg")).toBe("5.000");
    expect(await h.run("erp-core-work-order-completion", { input: { id: wo["id"] } })).toEqual({ status: "completed", output: { already_moved: 2 } });
    expect(await onHand(h, "steel")).toBe("9.000");
  });

  it("refuses to consume a component that is not in stock, and leaves the level where it was", async () => {
    const h = harness();
    await stocked(h, "3.000");
    const bom = await h.seed("BillOfMaterials", { bom_code: "B1", item_id: "fg", version: "1", output_quantity: "1.000", status: "active" });
    await h.seed("BomLine", { bom_id: bom["id"], component_item_id: "steel", quantity: "2.0000", scrap_pct: "0.00" });
    const wo = await h.seed("WorkOrder", { wo_number: "WO-1", item_id: "fg", bom_id: bom["id"], warehouse_id: "w1", quantity: "5.000", completed_quantity: "5.000", state: "completed" });
    const r = await h.run("erp-core-work-order-completion", { input: { id: wo["id"] } });
    expect(r).toMatchObject({ status: "failed", retryable: false, error: { code: "writes_refused" } });
    expect(JSON.stringify(r)).toContain("StockMovement issue|steel 422 stock_insufficient");
    expect(await onHand(h, "steel")).toBe("3.000");
    // Nothing was consumed, so nothing is produced: the finished good is not received either.
    expect(await onHand(h, "fg")).toBeUndefined();
    expect(JSON.stringify(r)).toContain("receipt_withheld");
    // Once the component is in stock, a later run writes both.
    await h.store.update(TENANT, "StockLevel", (await h.store.listPage(TENANT, "StockLevel", { filters: [{ field: "item_id", value: "steel" }], sort: [], limit: 1, cursor: null })).records[0]?.["id"] as string, { quantity_on_hand: "10.000" });
    expect(await h.run("erp-core-work-order-completion", { input: { id: wo["id"] } })).toEqual({
      status: "completed",
      output: { issue_movements: 1, receipt_movements: 1 },
    });
    expect(await onHand(h, "steel")).toBe("0.000");
    expect(await onHand(h, "fg")).toBe("5.000");
  });

  it("issues a component named on two BOM lines as one movement, so a retry cannot skip the second", async () => {
    const h = harness();
    await stocked(h, "12.000");
    const bom = await h.seed("BillOfMaterials", { bom_code: "B1", item_id: "fg", version: "1", output_quantity: "1.000", status: "active" });
    await h.seed("BomLine", { bom_id: bom["id"], component_item_id: "steel", quantity: "2.0000", scrap_pct: "0.00" });
    await h.seed("BomLine", { bom_id: bom["id"], component_item_id: "steel", quantity: "1.0000", scrap_pct: "0.00" });
    const wo = await h.seed("WorkOrder", { wo_number: "WO-1", item_id: "fg", bom_id: bom["id"], warehouse_id: "w1", quantity: "4.000", completed_quantity: "4.000", state: "completed" });
    // A previous attempt wrote the receipt only; the issue must still be written, in full.
    await h.seed("StockMovement", { item_id: "fg", warehouse_id: "w1", movement_type: "receipt", quantity: "4.000", reference: `WO:${wo["id"] as string}`, occurred_at: FIRE });
    expect(await h.run("erp-core-work-order-completion", { input: { id: wo["id"] } })).toEqual({
      status: "completed",
      output: { issue_movements: 1, already_moved: 1 },
    });
    const issues = (await h.store.listPage(TENANT, "StockMovement", { filters: [{ field: "movement_type", value: "issue" }], sort: [], limit: 10, cursor: null })).records;
    expect(issues.map((m) => [m["item_id"], m["quantity"]])).toEqual([["steel", "12.000"]]);
  });

  it("refuses a work order that names no bill of materials rather than choosing one", async () => {
    const h = harness();
    const wo = await h.seed("WorkOrder", { wo_number: "WO-1", item_id: "fg", warehouse_id: "w1", quantity: "5.000", completed_quantity: "5.000", state: "completed" });
    expect(await h.run("erp-core-work-order-completion", { input: { id: wo["id"] } })).toMatchObject({ status: "failed", error: { code: "work_order_has_no_bom" } });
  });
});

describe("access resolution", () => {
  it("fails, carrying the resolver's retryability, when the tenant's gateway cannot be resolved", async () => {
    const h = harness();
    const providers = buildErpJobProviders({
      coverage: h.coverage,
      resolveAccess: async () => ({ kind: "unavailable", reason: "tenant gateway refused: lineage_cycle", retryable: false }),
      settings: h.settings,
    });
    const p = providers.find((x) => x.serves === "job" && x.jobId === "erp-core-overdue-invoice-reminder");
    const r = await (p as Extract<JobHandlerProvider, { serves: "job" }>).handler({
      runId: "r",
      tenantId: TENANT,
      jobDefinitionId: "erp-core-overdue-invoice-reminder",
      jobKind: "scheduled",
      attempts: 1,
      trigger: null,
      input: null,
      signal: new AbortController().signal,
    });
    expect(r).toMatchObject({ status: "failed", retryable: false, error: { code: "tenant_gateway_unavailable" } });
    const transient = buildErpJobProviders({
      coverage: h.coverage,
      resolveAccess: async () => ({ kind: "unavailable", reason: "tenant gateway refused: unknown", retryable: true }),
      settings: h.settings,
    }).find((x) => x.serves === "job" && x.jobId === "erp-core-overdue-invoice-reminder") as Extract<JobHandlerProvider, { serves: "job" }>;
    const r2 = await transient.handler({
      runId: "r",
      tenantId: TENANT,
      jobDefinitionId: "erp-core-overdue-invoice-reminder",
      jobKind: "scheduled",
      attempts: 1,
      trigger: null,
      input: null,
      signal: new AbortController().signal,
    });
    expect(r2).toMatchObject({ status: "failed", retryable: true, error: { code: "tenant_gateway_unavailable" } });
  });
});
