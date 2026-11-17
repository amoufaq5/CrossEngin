import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import { buildIncomingRequest, type HandlerOutput } from "@crossengin/api-gateway-runtime";
import { buildErpCorePack } from "@crossengin/pack-erp-core";
import { describe, expect, it } from "vitest";

import { compileOperateServer } from "./compile.js";
import {
  extendedCents,
  formatInventoryAccounting,
  inventoryPolicyFrom,
  inventoryPostsToLedger,
  inventoryShape,
  movementDelta,
  STRICT_INVENTORY_POLICY,
  toUnits,
} from "./inventory.js";
import { routeFromSpec } from "./operations.js";
import { InMemorySettingsStore, type TenantSettings } from "./settings.js";
import { InMemoryEntityStore, type EntityRecord } from "./store.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const manifest = buildErpCorePack();

function principal(role: string): ResolvedPrincipal {
  return {
    principalId: "00000000-0000-4000-8000-0000000000aa",
    tenantId: TENANT,
    principalKind: "user",
    authScheme: "api_key_header",
    grantedScopes: [role],
    abacAttributes: {},
    mfaProofAgeSeconds: null,
    resolvedAt: "2026-06-03T12:00:00.000Z",
  };
}

type Opts = { params?: Record<string, string>; body?: Record<string, unknown> };

function harness(settings: TenantSettings = {}, opts: { transactional?: boolean } = {}) {
  const store = new InMemoryEntityStore();
  // A store with no transaction, on which a write effect's refusal rolls nothing back — so an
  // effect that writes before it has validated leaves a partial document behind.
  if (opts.transactional === false) Object.defineProperty(store, "withTransaction", { value: undefined });
  const settingsStore = new InMemorySettingsStore();
  void settingsStore.put(TENANT, settings);
  const clock = { now: () => new Date("2026-06-15T12:00:00.000Z") };
  const server = compileOperateServer(manifest, {
    store,
    clock,
    settingsStore,
    principalRoles: (p) => ({ primaryRole: p?.grantedScopes[0] ?? "anonymous" }),
  });
  const call = async (opId: string, opts: Opts = {}): Promise<HandlerOutput> => {
    const spec = server.routeSpecs.find((s) => s.operationId === opId);
    if (spec === undefined) throw new Error(`no route ${opId}`);
    const handler = server.handlers.resolve(opId);
    if (handler === undefined || handler === null) throw new Error(`no handler for ${opId}`);
    return handler({
      request: buildIncomingRequest({
        id: "req_inv000000001",
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
      principal: principal("erp_admin"),
      params: opts.params ?? {},
      parsedBody: opts.body ?? null,
    });
  };
  const ok = async (opId: string, opts?: Opts): Promise<EntityRecord> => {
    const out = await call(opId, opts);
    if (out.kind !== "json" || out.status >= 300) {
      throw new Error(`${opId} → ${out.kind === "json" ? `${out.status} ${JSON.stringify(out.body)}` : out.kind}`);
    }
    return out.body as EntityRecord;
  };
  const refused = async (opId: string, opts?: Opts): Promise<{ status: number; error: string }> => {
    const out = await call(opId, opts);
    if (out.kind !== "json" || out.status < 400) throw new Error(`${opId} was not refused`);
    return { status: out.status, error: String((out.body as Record<string, unknown>)["error"]) };
  };
  /** Net debit − credit per ledger account, in cents, over every posted line. */
  const balances = async (): Promise<Record<string, number>> => {
    const out: Record<string, number> = {};
    for (const line of await store.list(TENANT, "JournalLine")) {
      const acct = String(line["ledger_account_id"]);
      out[acct] = (out[acct] ?? 0) + Math.round(Number(line["debit"] ?? 0) * 100) - Math.round(Number(line["credit"] ?? 0) * 100);
    }
    for (const k of Object.keys(out)) if (out[k] === 0) delete out[k];
    return out;
  };
  const onHand = async (itemId: string, warehouseId: string): Promise<string | null> => {
    const levels = (await store.list(TENANT, "StockLevel")).filter((l) => l["item_id"] === itemId && l["warehouse_id"] === warehouseId);
    if (levels.length > 1) throw new Error("two levels");
    return levels[0] === undefined ? null : String(levels[0]["quantity_on_hand"]);
  };
  return { store, call, ok, refused, balances, onHand };
}

type H = ReturnType<typeof harness>;

async function setup(h: H, opts: { std?: string | null; itemType?: string } = {}) {
  const item = await h.ok("item.create", {
    body: {
      sku: "SKU-1",
      name: "Widget",
      item_type: opts.itemType ?? "stock",
      ...(opts.std === null ? {} : { standard_cost: opts.std ?? "10.0000" }),
    },
  });
  const wh = await h.ok("warehouse.create", { body: { code: "WH1", name: "Main" } });
  const vendor = await h.ok("vendor.create", { body: { vendor_code: "V1", name: "Acme" } });
  return { itemId: String(item["id"]), whId: String(wh["id"]), vendorId: String(vendor["id"]) };
}

async function purchaseOrder(h: H, s: { itemId: string; vendorId: string }, qty: string, price: string, approve = true) {
  const po = await h.ok("purchaseOrder.create", { body: { vendor_id: s.vendorId, order_date: "2026-06-01" } });
  const poId = String(po["id"]);
  const line = await h.ok("purchaseOrderLine.create", {
    body: { purchase_order_id: poId, item_id: s.itemId, quantity: qty, unit_price: price },
  });
  if (approve) {
    await h.ok("purchaseOrder.submit", { params: { id: poId } });
    await h.ok("purchaseOrder.approve", { params: { id: poId } });
  }
  return { poId, lineId: String(line["id"]) };
}

async function receive(h: H, poId: string, whId: string): Promise<string> {
  const gr = await h.ok("goodsReceipt.create", {
    body: { purchase_order_id: poId, warehouse_id: whId, received_date: "2026-06-15", status: "posted" },
  });
  return String(gr["id"]);
}

async function ship(h: H, s: { itemId: string; whId: string }, qty: string): Promise<{ soLineId: string; shipmentId: string }> {
  const so = await h.ok("salesOrder.create", {
    body: { account_id: "00000000-0000-4000-8000-0000000000ac", order_date: "2026-06-15" },
  });
  const soId = String(so["id"]);
  const line = await h.ok("salesOrderLine.create", {
    body: { sales_order_id: soId, item_id: s.itemId, description: "w", quantity: qty, unit_price: "20.0000" },
  });
  const sh = await h.ok("shipment.create", { body: { sales_order_id: soId, warehouse_id: s.whId } });
  const shipmentId = String(sh["id"]);
  for (const t of ["pick", "pack"]) await h.ok(`shipment.${t}`, { params: { id: shipmentId } });
  return { soLineId: String(line["id"]), shipmentId };
}

async function bill(h: H, vendorId: string, poId: string | null, lines: { poLineId: string | null; qty: string; price: string; itemId?: string }[]) {
  let total = 0;
  for (const l of lines) total += Number(l.qty) * Number(l.price);
  const b = await h.ok("bill.create", {
    body: {
      vendor_id: vendorId,
      ...(poId !== null ? { purchase_order_id: poId } : {}),
      bill_date: "2026-06-15",
      due_date: "2026-07-15",
      subtotal: total.toFixed(2),
      total: total.toFixed(2),
    },
  });
  const billId = String(b["id"]);
  for (const l of lines) {
    await h.ok("billLine.create", {
      body: {
        bill_id: billId,
        description: "x",
        quantity: l.qty,
        unit_price: l.price,
        amount: (Number(l.qty) * Number(l.price)).toFixed(2),
        ...(l.itemId !== undefined ? { item_id: l.itemId } : {}),
        ...(l.poLineId !== null ? { purchase_order_line_id: l.poLineId } : {}),
      },
    });
  }
  return billId;
}

describe("exact arithmetic", () => {
  it("rounds to the scale half away from zero, for both signs", () => {
    expect(toUnits("1.2345", 3)).toBe(1235n);
    expect(toUnits("-1.2345", 3)).toBe(-1235n);
    expect(toUnits(2, 3)).toBe(2000n);
    expect(toUnits("x", 3)).toBeNull();
    expect(toUnits(null, 3)).toBeNull();
  });

  it("extends a standard cost by a quantity in exact cents", () => {
    // 10.0050 × 3.333 = 33.3466665 → 33.35
    expect(extendedCents(100050n, 3333n, 4)).toBe(3335n);
    expect(extendedCents(100050n, -3333n, 4)).toBe(-3335n);
  });

  it("reads a movement's direction from its type and an adjustment's from its sign", () => {
    expect(movementDelta({ movement_type: "receipt", quantity: "2" })).toBe(2000n);
    expect(movementDelta({ movement_type: "issue", quantity: "2" })).toBe(-2000n);
    expect(movementDelta({ movement_type: "issue", quantity: "-2" })).toBeNull();
    expect(movementDelta({ movement_type: "adjustment", quantity: "-1.5" })).toBe(-1500n);
    expect(movementDelta({ movement_type: "adjustment", quantity: "0" })).toBeNull();
    expect(movementDelta({ movement_type: "teleport", quantity: "1" })).toBeNull();
  });

  it("reads an absent policy as the strict one", () => {
    expect(inventoryPolicyFrom(undefined)).toEqual(STRICT_INVENTORY_POLICY);
    expect(inventoryPolicyFrom({ allowNegativeStock: true }).allowNegativeStock).toBe(true);
  });
});

describe("inventoryShape", () => {
  it("wires every group on erp-core", () => {
    expect(inventoryShape(manifest)).toEqual({ ledger: true, goodsReceipt: true, shipment: true, billMatch: true });
  });

  it("says what it does at boot, and names the settings that relax its refusals", () => {
    expect(inventoryPostsToLedger(manifest)).toBe(true);
    const line = formatInventoryAccounting(inventoryShape(manifest), inventoryPostsToLedger(manifest));
    expect(line).toContain("Dr COGS / Cr inventory");
    expect(line).toContain("inventory.allowNegativeStock");
    expect(formatInventoryAccounting({ ledger: false, goodsReceipt: false, shipment: false, billMatch: false }, true)).toContain("off");
    // Without a ledger no document posting is wired, so the line must not claim receipts move stock.
    const noLedger = { ...manifest, entities: (manifest.entities ?? []).filter((e) => e.name !== "JournalLine") };
    expect(inventoryPostsToLedger(noLedger)).toBe(false);
    const bare = formatInventoryAccounting(inventoryShape(noLedger), inventoryPostsToLedger(noLedger));
    expect(bare).toContain("goods receipts and shipments move no stock");
    expect(bare).not.toContain("Dr COGS");
  });

  it("wires nothing that would read a field the manifest lacks", () => {
    const entities = (manifest.entities ?? []).map((e) =>
      e.name === "Item" ? { ...e, fields: e.fields.filter((f) => f.name !== "standard_cost") } : e,
    );
    expect(inventoryShape({ ...manifest, entities })).toEqual({
      ledger: false,
      goodsReceipt: false,
      shipment: false,
      billMatch: false,
    });
    const noMatch = (manifest.entities ?? []).map((e) =>
      e.name === "BillLine" ? { ...e, fields: e.fields.filter((f) => f.name !== "purchase_order_line_id") } : e,
    );
    expect(inventoryShape({ ...manifest, entities: noMatch }).billMatch).toBe(false);
  });
});

describe("a goods receipt receives stock and posts it at standard", () => {
  it("moves the level, the order line, and posts Dr inventory / Cr GRNI with the price variance", async () => {
    const h = harness();
    const s = await setup(h);
    const po = await purchaseOrder(h, s, "5", "12.0000");
    await receive(h, po.poId, s.whId);
    expect(await h.onHand(s.itemId, s.whId)).toBe("5.000");
    expect(String((await h.store.get(TENANT, "PurchaseOrderLine", po.lineId))?.["received_quantity"])).toBe("5.000");
    const movements = await h.store.list(TENANT, "StockMovement");
    expect(movements.map((m) => [m["movement_type"], m["quantity"]])).toEqual([["receipt", "5.000"]]);
    expect(await h.balances()).toEqual({ inventory: 5000, goods_received_not_invoiced: -6000, inventory_variance: 1000 });
  });

  it("posts a favourable variance as a credit", async () => {
    const h = harness();
    const s = await setup(h);
    const po = await purchaseOrder(h, s, "2", "9.5000");
    await receive(h, po.poId, s.whId);
    expect(await h.balances()).toEqual({ inventory: 2000, goods_received_not_invoiced: -1900, inventory_variance: -100 });
  });

  it("refuses an order that is not approved, and writes nothing", async () => {
    const h = harness();
    const s = await setup(h);
    const po = await purchaseOrder(h, s, "5", "12.0000", false);
    const r = await h.refused("goodsReceipt.create", {
      body: { purchase_order_id: po.poId, warehouse_id: s.whId, received_date: "2026-06-15", status: "posted" },
    });
    expect(r).toEqual({ status: 422, error: "goods_receipt_order_not_open" });
    expect(await h.store.list(TENANT, "StockMovement")).toEqual([]);
    expect(await h.store.list(TENANT, "JournalEntry")).toEqual([]);
  });

  it("refuses a stocked item with no standard cost before writing anything", async () => {
    const h = harness();
    const s = await setup(h, { std: null });
    const po = await purchaseOrder(h, s, "5", "12.0000");
    const r = await h.refused("goodsReceipt.create", {
      body: { purchase_order_id: po.poId, warehouse_id: s.whId, received_date: "2026-06-15", status: "posted" },
    });
    expect(r).toEqual({ status: 422, error: "standard_cost_unset" });
    expect(await h.store.list(TENANT, "StockLevel")).toEqual([]);
  });

  it("does not receive a service line", async () => {
    const h = harness();
    const s = await setup(h, { itemType: "service" });
    const po = await purchaseOrder(h, s, "5", "12.0000");
    await receive(h, po.poId, s.whId);
    expect(await h.store.list(TENANT, "StockMovement")).toEqual([]);
    expect(Number((await h.store.get(TENANT, "PurchaseOrderLine", po.lineId))?.["received_quantity"])).toBe(0);
    expect(await h.balances()).toEqual({});
  });

  it("receives only what is still outstanding, so a second receipt receives nothing", async () => {
    const h = harness();
    const s = await setup(h);
    const po = await purchaseOrder(h, s, "5", "10.0000");
    await receive(h, po.poId, s.whId);
    await receive(h, po.poId, s.whId);
    expect(await h.onHand(s.itemId, s.whId)).toBe("5.000");
    expect((await h.store.list(TENANT, "JournalEntry")).length).toBe(1);
  });

  it("is locked once posted: only cancellation, and a cancelled one is final", async () => {
    const h = harness();
    const s = await setup(h);
    const po = await purchaseOrder(h, s, "5", "12.0000");
    const grId = await receive(h, po.poId, s.whId);
    expect(await h.refused("goodsReceipt.update", { params: { id: grId }, body: { status: "draft" } })).toEqual({
      status: 422,
      error: "goods_receipt_locked",
    });
    expect(await h.refused("goodsReceipt.update", { params: { id: grId }, body: { notes: "x" } })).toEqual({
      status: 422,
      error: "goods_receipt_locked",
    });
    await h.ok("goodsReceipt.update", { params: { id: grId }, body: { status: "cancelled" } });
    expect(await h.refused("goodsReceipt.update", { params: { id: grId }, body: { status: "posted" } })).toEqual({
      status: 422,
      error: "goods_receipt_locked",
    });
  });

  it("cancelled, takes back the stock and the order line and reverses the entry", async () => {
    const h = harness();
    const s = await setup(h);
    const po = await purchaseOrder(h, s, "5", "12.0000");
    const grId = await receive(h, po.poId, s.whId);
    await h.ok("goodsReceipt.update", { params: { id: grId }, body: { status: "cancelled" } });
    expect(await h.onHand(s.itemId, s.whId)).toBe("0.000");
    expect(String((await h.store.get(TENANT, "PurchaseOrderLine", po.lineId))?.["received_quantity"])).toBe("0.000");
    expect(await h.balances()).toEqual({});
  });

  it("refuses cancellation once the received quantity has been billed", async () => {
    const h = harness();
    const s = await setup(h);
    const po = await purchaseOrder(h, s, "5", "12.0000");
    const grId = await receive(h, po.poId, s.whId);
    const b = await bill(h, s.vendorId, po.poId, [{ poLineId: po.lineId, qty: "5", price: "12.0000" }]);
    await h.ok("bill.approve", { params: { id: b } });
    expect(await h.refused("goodsReceipt.update", { params: { id: grId }, body: { status: "cancelled" } })).toEqual({
      status: 409,
      error: "goods_receipt_billed",
    });
  });
});

describe("a shipment issues stock and posts COGS at standard", () => {
  it("moves the level, the order line, and posts Dr COGS / Cr inventory", async () => {
    const h = harness();
    const s = await setup(h);
    const po = await purchaseOrder(h, s, "5", "10.0000");
    await receive(h, po.poId, s.whId);
    const out = await ship(h, s, "3");
    await h.ok("shipment.ship", { params: { id: out.shipmentId } });
    expect(await h.onHand(s.itemId, s.whId)).toBe("2.000");
    expect(String((await h.store.get(TENANT, "SalesOrderLine", out.soLineId))?.["fulfilled_quantity"])).toBe("3.000");
    expect(await h.balances()).toEqual({ inventory: 2000, goods_received_not_invoiced: -5000, cost_of_goods_sold: 3000 });
  });

  it("refuses to take stock below zero, and writes nothing", async () => {
    const h = harness();
    const s = await setup(h);
    const out = await ship(h, s, "3");
    expect(await h.refused("shipment.ship", { params: { id: out.shipmentId } })).toEqual({
      status: 422,
      error: "stock_insufficient",
    });
    expect((await h.store.get(TENANT, "Shipment", out.shipmentId))?.["state"]).toBe("packed");
    expect(await h.store.list(TENANT, "StockMovement")).toEqual([]);
  });

  it("counts two lines of one item against the stock together", async () => {
    const h = harness();
    const s = await setup(h);
    const po = await purchaseOrder(h, s, "4", "10.0000");
    await receive(h, po.poId, s.whId);
    const out = await ship(h, s, "3");
    const soId = String((await h.store.get(TENANT, "SalesOrderLine", out.soLineId))?.["sales_order_id"]);
    await h.ok("salesOrderLine.create", {
      body: { sales_order_id: soId, item_id: s.itemId, description: "w2", quantity: "2", unit_price: "20.0000" },
    });
    expect((await h.refused("shipment.ship", { params: { id: out.shipmentId } })).error).toBe("stock_insufficient");
  });

  it("refuses before writing anything, so a store with no transaction is left whole", async () => {
    const h = harness({}, { transactional: false });
    const s = await setup(h);
    const po = await purchaseOrder(h, s, "4", "10.0000");
    await receive(h, po.poId, s.whId);
    const out = await ship(h, s, "3");
    const soId = String((await h.store.get(TENANT, "SalesOrderLine", out.soLineId))?.["sales_order_id"]);
    await h.ok("salesOrderLine.create", {
      body: { sales_order_id: soId, item_id: s.itemId, description: "w2", quantity: "2", unit_price: "20.0000" },
    });
    expect((await h.refused("shipment.ship", { params: { id: out.shipmentId } })).error).toBe("stock_insufficient");
    expect(Number((await h.store.get(TENANT, "SalesOrderLine", out.soLineId))?.["fulfilled_quantity"])).toBe(0);
    expect(await h.onHand(s.itemId, s.whId)).toBe("4.000");
    expect((await h.store.list(TENANT, "StockMovement")).length).toBe(1);
  });

  it("takes stock negative when the tenant declares it allowed", async () => {
    const h = harness({ inventory: { allowNegativeStock: true } });
    const s = await setup(h);
    const out = await ship(h, s, "3");
    await h.ok("shipment.ship", { params: { id: out.shipmentId } });
    expect(await h.onHand(s.itemId, s.whId)).toBe("-3.000");
    expect(await h.balances()).toEqual({ inventory: -3000, cost_of_goods_sold: 3000 });
  });

  it("ships nothing for a line with no item, and posts nothing", async () => {
    const h = harness();
    const so = await h.ok("salesOrder.create", { body: { account_id: "00000000-0000-4000-8000-0000000000ac", order_date: "2026-06-15" } });
    await h.ok("salesOrderLine.create", { body: { sales_order_id: so["id"], description: "consulting", quantity: "1", unit_price: "5.0000" } });
    const sh = await h.ok("shipment.create", { body: { sales_order_id: so["id"] } });
    for (const t of ["pick", "pack", "ship"]) await h.ok(`shipment.${t}`, { params: { id: String(sh["id"]) } });
    expect(await h.store.list(TENANT, "StockMovement")).toEqual([]);
    expect(await h.balances()).toEqual({});
  });
});

describe("direct movements and level edits", () => {
  it("a direct adjustment moves the level and posts at standard against the variance account", async () => {
    const h = harness();
    const s = await setup(h);
    await h.ok("stockMovement.create", {
      body: { item_id: s.itemId, warehouse_id: s.whId, movement_type: "adjustment", quantity: "2", occurred_at: "2026-06-15T12:00:00.000Z" },
    });
    expect(await h.onHand(s.itemId, s.whId)).toBe("2.000");
    expect(await h.balances()).toEqual({ inventory: 2000, inventory_variance: -2000 });
  });

  it("refuses a direct issue below zero and a directional movement with a non-positive quantity", async () => {
    const h = harness();
    const s = await setup(h);
    const base = { item_id: s.itemId, warehouse_id: s.whId, occurred_at: "2026-06-15T12:00:00.000Z" };
    expect((await h.refused("stockMovement.create", { body: { ...base, movement_type: "issue", quantity: "1" } })).error).toBe(
      "stock_insufficient",
    );
    expect((await h.refused("stockMovement.create", { body: { ...base, movement_type: "issue", quantity: "-1" } })).error).toBe(
      "stock_movement_quantity_invalid",
    );
  });

  it("the movement ledger is append-only", async () => {
    const h = harness();
    const s = await setup(h);
    const m = await h.ok("stockMovement.create", {
      body: { item_id: s.itemId, warehouse_id: s.whId, movement_type: "receipt", quantity: "1", occurred_at: "2026-06-15T12:00:00.000Z" },
    });
    const id = String(m["id"]);
    expect((await h.refused("stockMovement.update", { params: { id }, body: { quantity: "9" } })).error).toBe("stock_movement_immutable");
    expect((await h.refused("stockMovement.delete", { params: { id } })).error).toBe("stock_movement_immutable");
  });

  it("a level set by hand records an adjustment movement and posts it", async () => {
    const h = harness();
    const s = await setup(h);
    const level = await h.ok("stockLevel.create", { body: { item_id: s.itemId, warehouse_id: s.whId, quantity_on_hand: "5" } });
    await h.ok("stockLevel.update", { params: { id: String(level["id"]) }, body: { quantity_on_hand: "8" } });
    const adjustments = (await h.store.list(TENANT, "StockMovement")).map((m) => [m["movement_type"], m["quantity"]]);
    expect(adjustments).toEqual([
      ["adjustment", "5.000"],
      ["adjustment", "3.000"],
    ]);
    expect(await h.balances()).toEqual({ inventory: 8000, inventory_variance: -8000 });
    expect(
      (await h.refused("stockLevel.update", { params: { id: String(level["id"]) }, body: { warehouse_id: "elsewhere" } })).error,
    ).toBe("stock_level_key_immutable");
  });

  it("a changed standard cost revalues what is on hand", async () => {
    const h = harness();
    const s = await setup(h);
    const po = await purchaseOrder(h, s, "5", "10.0000");
    await receive(h, po.poId, s.whId);
    await h.ok("item.update", { params: { id: s.itemId }, body: { standard_cost: "12.5000" } });
    expect(await h.balances()).toEqual({ inventory: 6250, goods_received_not_invoiced: -5000, inventory_variance: -1250 });
  });
});

describe("the inventory account stays equal to on-hand × standard", () => {
  it("through receipts, a shipment, adjustments, a revaluation and a cancellation", async () => {
    const h = harness();
    const s = await setup(h, { std: "3.3333" });
    const po1 = await purchaseOrder(h, s, "7", "3.1000");
    await receive(h, po1.poId, s.whId);
    const po2 = await purchaseOrder(h, s, "4.5", "3.9000");
    const gr2 = await receive(h, po2.poId, s.whId);
    const out = await ship(h, s, "2.25");
    await h.ok("shipment.ship", { params: { id: out.shipmentId } });
    await h.ok("stockMovement.create", {
      body: { item_id: s.itemId, warehouse_id: s.whId, movement_type: "adjustment", quantity: "-0.5", occurred_at: "2026-06-15T12:00:00.000Z" },
    });
    await h.ok("item.update", { params: { id: s.itemId }, body: { standard_cost: "4.0000" } });
    await h.ok("goodsReceipt.update", { params: { id: gr2 }, body: { status: "cancelled" } });
    const qty = Number(await h.onHand(s.itemId, s.whId));
    expect(qty).toBe(4.25);
    // Every posting rounds per movement, so the tie-out holds to one cent per movement at most.
    const movements = (await h.store.list(TENANT, "StockMovement")).length;
    expect(Math.abs((await h.balances())["inventory"]! - Math.round(qty * 4 * 100))).toBeLessThanOrEqual(movements);
    // Every entry balances exactly.
    for (const e of await h.store.list(TENANT, "JournalEntry")) {
      const lines = (await h.store.list(TENANT, "JournalLine")).filter((l) => l["journal_entry_id"] === e["id"]);
      const d = lines.reduce((a, l) => a + Math.round(Number(l["debit"]) * 100), 0);
      const c = lines.reduce((a, l) => a + Math.round(Number(l["credit"]) * 100), 0);
      expect(d, String(e["entry_number"])).toBe(c);
    }
  });
});

describe("three-way match on bill approval", () => {
  async function received(h: H, qty = "5", price = "12.0000") {
    const s = await setup(h);
    const po = await purchaseOrder(h, s, qty, price);
    await receive(h, po.poId, s.whId);
    return { s, po };
  }

  it("a matched bill approves and clears GRNI, leaving expense with the variance only", async () => {
    const h = harness();
    const { s, po } = await received(h);
    const b = await bill(h, s.vendorId, po.poId, [{ poLineId: po.lineId, qty: "5", price: "12.0000" }]);
    await h.ok("bill.approve", { params: { id: b } });
    expect(await h.balances()).toEqual({ inventory: 5000, inventory_variance: 1000, accounts_payable: -6000 });
  });

  it("refuses a price outside the tolerance, and admits it inside", async () => {
    const strict = harness();
    const a = await received(strict);
    const b1 = await bill(strict, a.s.vendorId, a.po.poId, [{ poLineId: a.po.lineId, qty: "5", price: "13.0000" }]);
    expect(await strict.refused("bill.approve", { params: { id: b1 } })).toEqual({ status: 422, error: "match_price_variance" });
    expect((await strict.store.get(TENANT, "Bill", b1))?.["state"]).toBe("draft");

    const tolerant = harness({ inventory: { matchPriceTolerancePct: 10 } });
    const t = await received(tolerant);
    const b2 = await bill(tolerant, t.s.vendorId, t.po.poId, [{ poLineId: t.po.lineId, qty: "5", price: "13.0000" }]);
    await tolerant.ok("bill.approve", { params: { id: b2 } });
    // GRNI clears at the order price; the 5.00 bill-over-order difference stays in expense.
    expect(await tolerant.balances()).toEqual({ inventory: 5000, inventory_variance: 1000, expense: 500, accounts_payable: -6500 });
  });

  it("refuses billing more than was received, counting every standing bill", async () => {
    const h = harness();
    const { s, po } = await received(h, "5");
    const over = await bill(h, s.vendorId, po.poId, [{ poLineId: po.lineId, qty: "6", price: "12.0000" }]);
    expect((await h.refused("bill.approve", { params: { id: over } })).error).toBe("match_quantity_exceeds_received");
    const first = await bill(h, s.vendorId, po.poId, [{ poLineId: po.lineId, qty: "4", price: "12.0000" }]);
    await h.ok("bill.approve", { params: { id: first } });
    const second = await bill(h, s.vendorId, po.poId, [{ poLineId: po.lineId, qty: "2", price: "12.0000" }]);
    expect((await h.refused("bill.approve", { params: { id: second } })).error).toBe("match_quantity_exceeds_received");
    // A voided bill no longer stands, so the remainder can be billed.
    await h.ok("bill.void", { params: { id: first } });
    await h.ok("bill.approve", { params: { id: second } });
  });

  it("refuses a line matched to another order, or a different item", async () => {
    const h = harness();
    const { s, po } = await received(h);
    const other = await purchaseOrder(h, s, "1", "12.0000");
    const b = await bill(h, s.vendorId, other.poId, [{ poLineId: po.lineId, qty: "1", price: "12.0000" }]);
    expect((await h.refused("bill.approve", { params: { id: b } })).error).toBe("match_order_mismatch");
    const otherItem = await h.ok("item.create", { body: { sku: "SKU-2", name: "Gadget", standard_cost: "1.0000" } });
    const b2 = await bill(h, s.vendorId, po.poId, [
      { poLineId: po.lineId, qty: "1", price: "12.0000", itemId: String(otherItem["id"]) },
    ]);
    expect((await h.refused("bill.approve", { params: { id: b2 } })).error).toBe("match_item_mismatch");
  });

  it("a bill line naming no order line is not matched", async () => {
    const h = harness();
    const s = await setup(h);
    const b = await bill(h, s.vendorId, null, [{ poLineId: null, qty: "1", price: "99.0000" }]);
    await h.ok("bill.approve", { params: { id: b } });
    expect(await h.balances()).toEqual({ expense: 9900, accounts_payable: -9900 });
  });

  it("a service line is matched against what was ordered", async () => {
    const h = harness();
    const s = await setup(h, { itemType: "service" });
    const po = await purchaseOrder(h, s, "3", "50.0000");
    const over = await bill(h, s.vendorId, po.poId, [{ poLineId: po.lineId, qty: "4", price: "50.0000" }]);
    expect((await h.refused("bill.approve", { params: { id: over } })).error).toBe("match_quantity_exceeds_ordered");
    const fine = await bill(h, s.vendorId, po.poId, [{ poLineId: po.lineId, qty: "3", price: "50.0000" }]);
    await h.ok("bill.approve", { params: { id: fine } });
    expect(await h.balances()).toEqual({ expense: 15000, accounts_payable: -15000 });
  });

  it("voiding a matched bill reverses its GRNI clearing with its recognition", async () => {
    const h = harness();
    const { s, po } = await received(h);
    const b = await bill(h, s.vendorId, po.poId, [{ poLineId: po.lineId, qty: "5", price: "12.0000" }]);
    await h.ok("bill.approve", { params: { id: b } });
    await h.ok("bill.void", { params: { id: b } });
    expect(await h.balances()).toEqual({ inventory: 5000, goods_received_not_invoiced: -6000, inventory_variance: 1000 });
  });
});

describe("a received order cannot be billed around its receipt", () => {
  it("refuses a bill line for a received item that names no order line, which would count the goods twice", async () => {
    const h = harness();
    const s = await setup(h);
    const po = await purchaseOrder(h, s, "5", "12.0000");
    await receive(h, po.poId, s.whId);
    const unlinked = await bill(h, s.vendorId, po.poId, [{ poLineId: null, qty: "5", price: "12.0000", itemId: s.itemId }]);
    expect(await h.refused("bill.approve", { params: { id: unlinked } })).toEqual({ status: 422, error: "match_order_line_unset" });
    expect((await h.store.get(TENANT, "Bill", unlinked))?.["state"]).toBe("draft");
    // The same line naming its order line approves and clears what the receipt credited.
    const linked = await bill(h, s.vendorId, po.poId, [{ poLineId: po.lineId, qty: "5", price: "12.0000", itemId: s.itemId }]);
    await h.ok("bill.approve", { params: { id: linked } });
    expect(await h.balances()).toEqual({ inventory: 5000, inventory_variance: 1000, accounts_payable: -6000 });
  });

  it("does not refuse where no receipt credited anything: unreceived, or received and cancelled", async () => {
    const h = harness();
    const s = await setup(h);
    const open = await purchaseOrder(h, s, "5", "12.0000");
    const b1 = await bill(h, s.vendorId, open.poId, [{ poLineId: null, qty: "5", price: "12.0000", itemId: s.itemId }]);
    await h.ok("bill.approve", { params: { id: b1 } });

    const cancelled = await purchaseOrder(h, s, "2", "12.0000");
    const gr = await receive(h, cancelled.poId, s.whId);
    await h.ok("goodsReceipt.update", { params: { id: gr }, body: { status: "cancelled" } });
    const b2 = await bill(h, s.vendorId, cancelled.poId, [{ poLineId: null, qty: "2", price: "12.0000", itemId: s.itemId }]);
    await h.ok("bill.approve", { params: { id: b2 } });
  });
});

describe("what a client may not write", () => {
  it("refuses a hand-written received_quantity, which would let a bill match goods no receipt moved", async () => {
    const h = harness();
    const s = await setup(h);
    const po = await h.ok("purchaseOrder.create", { body: { vendor_id: s.vendorId, order_date: "2026-06-01" } });
    const body = { purchase_order_id: String(po["id"]), item_id: s.itemId, quantity: "5", unit_price: "12.0000" };
    expect(await h.refused("purchaseOrderLine.create", { body: { ...body, received_quantity: "5" } })).toEqual({
      status: 422,
      error: "field_server_owned",
    });
    const line = await h.ok("purchaseOrderLine.create", { body });
    expect(
      await h.refused("purchaseOrderLine.update", { params: { id: String(line["id"]) }, body: { received_quantity: "5" } }),
    ).toEqual({ status: 422, error: "field_server_owned" });
  });

  it("refuses a second stock level for one item in one warehouse, which would make every movement ambiguous", async () => {
    const h = harness();
    const s = await setup(h);
    await h.ok("stockLevel.create", { body: { item_id: s.itemId, warehouse_id: s.whId, quantity_on_hand: "1" } });
    expect(
      await h.refused("stockLevel.create", { body: { item_id: s.itemId, warehouse_id: s.whId, quantity_on_hand: "1" } }),
    ).toEqual({ status: 409, error: "stock_level_exists" });
    expect(await h.onHand(s.itemId, s.whId)).toBe("1.000");
    const other = await h.ok("warehouse.create", { body: { code: "WH2", name: "Second" } });
    await h.ok("stockLevel.create", { body: { item_id: s.itemId, warehouse_id: String(other["id"]), quantity_on_hand: "1" } });
  });
});

describe("a stock level stored before the decimal wire type", () => {
  it("still moves: its quantity is compared as a figure, not as the text it was written in", async () => {
    const h = harness();
    const s = await setup(h);
    // Written beneath the decorator, as a document stored before ADR-0332 holds it.
    await h.store.create(TENANT, "StockLevel", { item_id: s.itemId, warehouse_id: s.whId, quantity_on_hand: 5, quantity_reserved: 0, quantity_incoming: 0 });
    await h.ok("stockMovement.create", {
      body: { item_id: s.itemId, warehouse_id: s.whId, movement_type: "issue", quantity: "1", occurred_at: "2026-06-15T12:00:00.000Z" },
    });
    expect(await h.onHand(s.itemId, s.whId)).toBe("4.000");
  });
});
