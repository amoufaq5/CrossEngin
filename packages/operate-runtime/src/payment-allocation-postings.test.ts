import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import { buildIncomingRequest, type HandlerOutput } from "@crossengin/api-gateway-runtime";
import { buildErpCorePack } from "@crossengin/pack-erp-core";
import { describe, expect, it } from "vitest";

import { compileOperateServer } from "./compile.js";
import { moneyUnits } from "./money.js";
import { routeFromSpec } from "./operations.js";
import { InMemorySettingsStore } from "./settings.js";
import { InMemoryEntityStore, type EntityRecord } from "./store.js";
import { declaredSettlementSpec, readAppliedPayments } from "./write-guards.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const ACCOUNT = "00000000-0000-4000-8000-0000000000ac";
const manifest = buildErpCorePack();

type Body = Record<string, unknown>;
type Call = (opId: string, opts?: { params?: Record<string, string>; body?: Body }) => Promise<HandlerOutput>;

function principal(): ResolvedPrincipal {
  return {
    principalId: "00000000-0000-4000-8000-0000000000aa",
    tenantId: TENANT,
    principalKind: "user",
    authScheme: "api_key_header",
    grantedScopes: ["erp_admin"],
    abacAttributes: {},
    mfaProofAgeSeconds: null,
    resolvedAt: "2026-06-03T12:00:00.000Z",
  };
}

function caller(store: InMemoryEntityStore, opts: { unguarded?: boolean; allowUncoveredSettlement?: boolean }): Call {
  const server = compileOperateServer(manifest, {
    store,
    clock: { now: () => new Date("2026-06-15T12:00:00.000Z") },
    settingsStore: new InMemorySettingsStore(),
    principalRoles: (p) => ({ primaryRole: p?.grantedScopes[0] ?? "anonymous" }),
    // The deployment before this guard existed: no guard at all, the effects as they are.
    ...(opts.unguarded === true ? { writeGuards: [] } : {}),
    ...(opts.allowUncoveredSettlement !== undefined ? { allowUncoveredSettlement: opts.allowUncoveredSettlement } : {}),
  });
  return async (opId, o = {}) => {
    const spec = server.routeSpecs.find((s) => s.operationId === opId);
    if (spec === undefined) throw new Error(`no route for ${opId}`);
    const handler = server.handlers.resolve(opId);
    if (handler === undefined || handler === null) throw new Error(`no handler for ${opId}`);
    const request = buildIncomingRequest({
      id: "req_pa0000000001",
      receivedAt: "2026-06-15T12:00:00.000Z",
      method: spec.method,
      path: "/v1/x",
      headers: {},
      host: "api.example.com",
      scheme: "https",
      bodyBytes: null,
      clientIp: "203.0.113.1",
      edgeTrust: "untrusted",
    });
    return handler({ request, route: routeFromSpec(spec), principal: principal(), params: o.params ?? {}, parsedBody: o.body ?? null });
  };
}

interface Harness {
  readonly store: InMemoryEntityStore;
  readonly call: Call;
  /** The same store, served by a deployment with no write guards — how a bad row came to be stored. */
  readonly legacy: Call;
  ok(opId: string, opts?: { params?: Record<string, string>; body?: Body }, via?: Call): Promise<EntityRecord>;
}

function harness(opts: { allowUncoveredSettlement?: boolean } = {}): Harness {
  const store = new InMemoryEntityStore();
  const call = caller(store, opts);
  const legacy = caller(store, { unguarded: true });
  const ok: Harness["ok"] = async (opId, o, via = call) => {
    const out = await via(opId, o);
    if (out.kind !== "json" || out.status >= 300) {
      throw new Error(`${opId} → ${out.kind === "json" ? `${out.status} ${JSON.stringify(out.body)}` : out.kind}`);
    }
    return out.body as EntityRecord;
  };
  return { store, call, legacy, ok };
}

function errorOf(out: HandlerOutput): [number, string] | null {
  return out.kind === "json" ? [out.status, String((out.body as { error?: string }).error)] : null;
}

function u(v: unknown): bigint {
  return moneyUnits(v) ?? 0n;
}

async function balances(h: Harness): Promise<Record<string, bigint>> {
  const out: Record<string, bigint> = {};
  for (const l of await h.store.list(TENANT, "JournalLine")) {
    const a = String(l["ledger_account_id"]);
    out[a] = (out[a] ?? 0n) + u(l["functional_debit"]) - u(l["functional_credit"]);
  }
  return out;
}

async function sentInvoice(h: Harness, total: string): Promise<string> {
  const inv = await h.ok("invoice.create", {
    body: { account_id: ACCOUNT, currency: "USD", subtotal: total, tax_total: "0.00", total, issue_date: "2026-06-05", due_date: "2026-07-15" },
  });
  await h.ok("invoice.send", { params: { id: String(inv["id"]) } });
  return String(inv["id"]);
}

async function approvedBill(h: Harness, total: string): Promise<string> {
  const bill = await h.ok("bill.create", {
    body: { vendor_id: ACCOUNT, bill_date: "2026-06-15", due_date: "2026-07-15", subtotal: total, tax_total: "0.00", total },
  });
  await h.ok("bill.approve", { params: { id: String(bill["id"]) } });
  return String(bill["id"]);
}

/** Create, submit and complete a payment through `via`. */
async function completed(h: Harness, body: Body, via: Call): Promise<string> {
  const p = await h.ok("payment.create", { body: { currency: "USD", ...body } }, via);
  const id = String(p["id"]);
  await h.ok("payment.submit", { params: { id } }, via);
  await h.ok("payment.complete", { params: { id } }, via);
  return id;
}

/** A completed payment written straight to the store: a row no posting ever ran for. */
async function storedCompleted(h: Harness, body: Body): Promise<string> {
  const row = await h.store.create(TENANT, "Payment", {
    payment_number: `PAY-${Math.random().toString(36).slice(2, 8)}`,
    method: "bank_transfer",
    currency: "USD",
    state: "completed",
    ...body,
  });
  return String(row["id"]);
}

async function stateOf(h: Harness, entity: string, id: string): Promise<unknown> {
  return (await h.store.get(TENANT, entity, id))?.["state"];
}

describe("the four bad shapes are refused at create and nothing is stored", () => {
  const shapes: [string, (inv: string, bill: string) => Body, string][] = [
    ["an outbound payment naming an invoice", (inv) => ({ direction: "outbound", invoice_id: inv, amount: "10.00" }), "payment_direction_mismatch"],
    ["an inbound payment naming a bill", (_inv, bill) => ({ direction: "inbound", bill_id: bill, amount: "10.00" }), "payment_direction_mismatch"],
    ["a payment naming both", (inv, bill) => ({ direction: "inbound", invoice_id: inv, bill_id: bill, amount: "10.00" }), "payment_names_several_documents"],
    ["a negative amount", (inv) => ({ direction: "inbound", invoice_id: inv, amount: "-30.00" }), "payment_amount_negative"],
  ];
  for (const [label, body, code] of shapes) {
    it(`${label} → 422 ${code}`, async () => {
      const h = harness();
      const inv = await sentInvoice(h, "100.00");
      const bill = await approvedBill(h, "100.00");
      expect(errorOf(await h.call("payment.create", { body: { currency: "USD", ...body(inv, bill) } }))).toEqual([422, code]);
      expect(await h.store.list(TENANT, "Payment")).toEqual([]);
    });
  }

  it("the two well-formed payments post and settle (non-vacuity)", async () => {
    const h = harness();
    const inv = await sentInvoice(h, "100.00");
    const bill = await approvedBill(h, "80.00");
    await completed(h, { direction: "inbound", invoice_id: inv, amount: "100.00" }, h.call);
    await completed(h, { direction: "outbound", bill_id: bill, amount: "80.00" }, h.call);
    expect(await stateOf(h, "Invoice", inv)).toBe("paid");
    expect(await stateOf(h, "Bill", bill)).toBe("paid");
    const b = await balances(h);
    expect([b["accounts_receivable"], b["accounts_payable"]]).toEqual([0n, 0n]);
  });

  it("the guard is not waived by allowUncoveredSettlement", async () => {
    const h = harness({ allowUncoveredSettlement: true });
    const inv = await sentInvoice(h, "100.00");
    expect(
      errorOf(await h.call("payment.create", { body: { currency: "USD", direction: "outbound", invoice_id: inv, amount: "10.00" } })),
    ).toEqual([422, "payment_direction_mismatch"]);
  });
});

describe("a bad row stored before the guard existed", () => {
  it("is refunded, which restores the ledger and reopens the documents", async () => {
    const h = harness();
    const inv = await sentInvoice(h, "100.00");
    const bill = await approvedBill(h, "100.00");
    // The pre-upgrade deployment completed it: AR received 100 through the AR side, and both
    // documents were left paid.
    const pay = await completed(h, { direction: "inbound", invoice_id: inv, bill_id: bill, amount: "100.00" }, h.legacy);
    await h.store.update(TENANT, "Bill", bill, { state: "paid" });
    expect(await stateOf(h, "Bill", bill)).toBe("paid");
    const before = await balances(h);

    await h.ok("payment.refund", { params: { id: pay } });
    expect(await stateOf(h, "Payment", pay)).toBe("refunded");
    const after = await balances(h);
    // The settlement is reversed: AR is back to the invoice's 100 and the cash is gone.
    expect(after["accounts_receivable"]).toBe(10000n);
    expect(after["cash"] ?? 0n).toBe(0n);
    expect(after["accounts_receivable"]! - before["accounts_receivable"]!).toBe(10000n);
    expect(await stateOf(h, "Invoice", inv)).toBe("sent");
    expect(await stateOf(h, "Bill", bill)).toBe("approved");
  });

  it("a write to it answers payment_locked, before the allocation guard is asked", async () => {
    const h = harness();
    const inv = await sentInvoice(h, "100.00");
    const bill = await approvedBill(h, "100.00");
    const pay = await completed(h, { direction: "outbound", invoice_id: inv, bill_id: bill, amount: "100.00" }, h.legacy);
    expect(errorOf(await h.call("payment.update", { params: { id: pay }, body: { amount: "60.00" } }))).toEqual([
      422,
      "payment_locked",
    ]);
  });

  it("a bad pending row is refused at completion, and completes once corrected", async () => {
    const h = harness();
    const inv = await sentInvoice(h, "100.00");
    const bill = await approvedBill(h, "100.00");
    const p = await h.ok("payment.create", {
      body: { currency: "USD", direction: "inbound", invoice_id: inv, bill_id: bill, amount: "100.00" },
    }, h.legacy);
    const id = String(p["id"]);
    await h.ok("payment.submit", { params: { id } }, h.legacy);
    const refused = await h.call("payment.complete", { params: { id } });
    expect(errorOf(refused)).toEqual([422, "payment_names_several_documents"]);
    expect(String((refused as { body: { detail?: string } }).body.detail)).toMatch(/before completing it$/);
    expect(await stateOf(h, "Payment", id)).toBe("pending");
    expect(await h.store.list(TENANT, "JournalEntry")).toHaveLength(2);

    await h.ok("payment.update", { params: { id }, body: { bill_id: null } });
    await h.ok("payment.complete", { params: { id } });
    expect(await stateOf(h, "Invoice", inv)).toBe("paid");
    expect(await stateOf(h, "Bill", bill)).toBe("approved");
  });
});

describe("a stored negative row counts nothing", () => {
  it("−30 then +100: the invoice is covered and mark_paid succeeds", async () => {
    const h = harness();
    const inv = await sentInvoice(h, "100.00");
    await storedCompleted(h, { direction: "inbound", invoice_id: inv, amount: "-30.00" });
    await storedCompleted(h, { direction: "inbound", invoice_id: inv, amount: "100.00" });
    await h.ok("invoice.mark_paid", { params: { id: inv } });
    expect(await stateOf(h, "Invoice", inv)).toBe("paid");
  });

  it("−30 then a completed +100: the application settles the invoice", async () => {
    const h = harness();
    const inv = await sentInvoice(h, "100.00");
    await storedCompleted(h, { direction: "inbound", invoice_id: inv, amount: "-30.00" });
    await completed(h, { direction: "inbound", invoice_id: inv, amount: "100.00" }, h.call);
    expect(await stateOf(h, "Invoice", inv)).toBe("paid");
    expect((await balances(h))["accounts_receivable"]).toBe(0n);
  });

  it("+50 and −50 on a bill: the void is refused, because 50 is still applied", async () => {
    const h = harness();
    const bill = await approvedBill(h, "200.00");
    await completed(h, { direction: "outbound", bill_id: bill, amount: "50.00" }, h.call);
    await storedCompleted(h, { direction: "outbound", bill_id: bill, amount: "-50.00" });
    expect(errorOf(await h.call("bill.void", { params: { id: bill } }))).toEqual([409, "document_partly_settled"]);
    expect((await balances(h))["accounts_payable"]).toBe(-15000n);
  });
});

describe("the fold counts exactly what the settlement posting cleared", () => {
  it("each control account's settlement movement is its document bucket plus its unapplied rows", async () => {
    const h = harness();
    const invoices = [await sentInvoice(h, "500.00"), await sentInvoice(h, "500.00")];
    const bills = [await approvedBill(h, "500.00"), await approvedBill(h, "500.00")];
    const refs: Body[] = [
      {},
      { invoice_id: invoices[0] },
      { invoice_id: invoices[1] },
      { bill_id: bills[0] },
      { bill_id: bills[1] },
      { invoice_id: invoices[0], bill_id: bills[1] },
    ];
    let n = 0;
    for (const direction of ["inbound", "outbound"]) {
      for (const ref of refs) {
        n += 1;
        await completed(h, { direction, amount: `${n}.25`, ...ref }, h.legacy);
      }
    }
    // Rows the posting skips, which the fold must skip too.
    await storedCompleted(h, { direction: "inbound", invoice_id: invoices[0], amount: "-7.00" });
    await storedCompleted(h, { direction: "outbound", bill_id: bills[0], amount: "0.00" });

    const lines = await h.store.list(TENANT, "JournalLine");
    const movement = (description: string, side: "debit" | "credit"): bigint =>
      lines.filter((l) => l["description"] === description).reduce((s, l) => s + u(l[side]), 0n);
    const arCleared = movement("Settlement — accounts receivable", "credit");
    const apCleared = movement("Settlement — accounts payable", "debit");

    const read = await readAppliedPayments(h.store, TENANT, [declaredSettlementSpec("Invoice"), declaredSettlementSpec("Bill")], {
      ceiling: 1000,
    });
    const bucket = (i: number): bigint => [...read.applied[i]!.values()].reduce((s, v) => s + u(v.toFixed(2)), 0n);
    const payments = await h.store.list(TENANT, "Payment");
    const unapplied = (direction: string, refField: string): bigint =>
      payments
        .filter((p) => p["state"] === "completed" && p["direction"] === direction && typeof p[refField] !== "string")
        .reduce((s, p) => s + (u(p["amount"]) > 0n ? u(p["amount"]) : 0n), 0n);

    expect(read.complete).toBe(true);
    expect(arCleared).toBeGreaterThan(0n);
    expect(apCleared).toBeGreaterThan(0n);
    expect(arCleared).toBe(bucket(0) + unapplied("inbound", "invoice_id"));
    expect(apCleared).toBe(bucket(1) + unapplied("outbound", "bill_id"));
  });
});
