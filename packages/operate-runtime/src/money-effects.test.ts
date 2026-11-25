// End-to-end over the compiled `erp-core` server: ADR-0475's money effects as the routes reach them,
// so the wiring in compile.ts (the overdue re-open, the WHT voided set and credit-note shape, the
// aging `asOf` refusal) is exercised and not only each effect in isolation.
import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import { buildIncomingRequest, type HandlerOutput } from "@crossengin/api-gateway-runtime";
import { buildErpCorePack } from "@crossengin/pack-erp-core";
import { describe, expect, it } from "vitest";

import { compileOperateServer } from "./compile.js";
import { moneyUnits } from "./money.js";
import { routeFromSpec } from "./operations.js";
import { InMemorySettingsStore } from "./settings.js";
import { InMemoryEntityStore, type EntityRecord } from "./store.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const ACCOUNT = "00000000-0000-4000-8000-0000000000ac";
const ACTOR = "00000000-0000-4000-8000-0000000000aa";
const SOMEONE_ELSE = "00000000-0000-4000-8000-0000000000bb";
const manifest = buildErpCorePack();

function principal(): ResolvedPrincipal {
  return {
    principalId: ACTOR,
    tenantId: TENANT,
    principalKind: "user",
    authScheme: "api_key_header",
    grantedScopes: ["erp_admin"],
    abacAttributes: {},
    mfaProofAgeSeconds: null,
    resolvedAt: "2026-06-15T12:00:00.000Z",
  };
}

type Opts = { params?: Record<string, string>; body?: Record<string, unknown>; query?: Record<string, string> };

function harness(opts: { functional?: string } = {}) {
  const store = new InMemoryEntityStore();
  const settingsStore = new InMemorySettingsStore();
  if (opts.functional !== undefined) void settingsStore.put(TENANT, { defaults: { currency: opts.functional } });
  const server = compileOperateServer(manifest, {
    store,
    settingsStore,
    clock: { now: () => new Date("2026-06-15T12:00:00.000Z") },
    principalRoles: (p) => ({ primaryRole: p?.grantedScopes[0] ?? "anonymous" }),
  });
  const call = async (opId: string, o: Opts = {}): Promise<HandlerOutput> => {
    const spec = server.routeSpecs.find((s) => s.operationId === opId);
    const handler = server.handlers.resolve(opId);
    if (handler === undefined || handler === null) throw new Error(`no handler for ${opId}`);
    const request = buildIncomingRequest({
      id: "req_moneyfx000001",
      receivedAt: "2026-06-15T12:00:00.000Z",
      method: spec?.method ?? "GET",
      path: "/v1/x",
      query: o.query ?? {},
      headers: {},
      host: "api.example.com",
      scheme: "https",
      bodyBytes: null,
      clientIp: "203.0.113.1",
      edgeTrust: "untrusted",
    });
    const route = spec === undefined ? routeFromSpec({ ...server.routeSpecs[0]!, operationId: opId, method: "GET" }) : routeFromSpec(spec);
    return handler({ request, route, principal: principal(), params: o.params ?? {}, parsedBody: o.body ?? null });
  };
  const ok = async (opId: string, o?: Opts): Promise<EntityRecord> => {
    const out = await call(opId, o);
    if (out.kind !== "json" || out.status >= 300) {
      throw new Error(`${opId} → ${out.kind === "json" ? `${out.status} ${JSON.stringify(out.body)}` : out.kind}`);
    }
    return out.body as EntityRecord;
  };
  return { store, call, ok };
}

type H = ReturnType<typeof harness>;

async function pay(h: H, body: Record<string, unknown>): Promise<string> {
  const p = await h.ok("payment.create", { body });
  await h.ok("payment.submit", { params: { id: String(p["id"]) } });
  await h.ok("payment.complete", { params: { id: String(p["id"]) } });
  return String(p["id"]);
}

async function sentInvoice(h: H, dueDate: string): Promise<string> {
  const inv = await h.ok("invoice.create", {
    body: { account_id: ACCOUNT, currency: "USD", subtotal: "100.00", tax_total: "0.00", total: "100.00", issue_date: "2026-05-01", due_date: dueDate },
  });
  const id = String(inv["id"]);
  await h.ok("invoice.send", { params: { id } });
  return id;
}

async function approvedBill(h: H, dueDate: string, currency = "USD"): Promise<string> {
  const bill = await h.ok("bill.create", {
    body: { vendor_id: ACCOUNT, currency, bill_date: "2026-06-05", due_date: dueDate, subtotal: "100.00", tax_total: "0.00", total: "100.00" },
  });
  const id = String(bill["id"]);
  await h.ok("bill.approve", { params: { id } });
  return id;
}

describe("a refund re-opens a document into the state its due date says (ADR-0475)", () => {
  it("a past-due invoice re-opens overdue, not sent", async () => {
    const h = harness();
    const inv = await sentInvoice(h, "2026-06-10");
    const p = await pay(h, { currency: "USD", direction: "inbound", invoice_id: inv, amount: "100.00" });
    expect((await h.store.get(TENANT, "Invoice", inv))?.["state"]).toBe("paid");
    await h.ok("payment.refund", { params: { id: p } });
    // Before this, `sent` — a document 5 days past due reported as not yet due, until the nightly job.
    expect((await h.store.get(TENANT, "Invoice", inv))?.["state"]).toBe("overdue");
  });

  it("an invoice not yet due re-opens sent — the control", async () => {
    const h = harness();
    const inv = await sentInvoice(h, "2026-07-15");
    const p = await pay(h, { currency: "USD", direction: "inbound", invoice_id: inv, amount: "100.00" });
    await h.ok("payment.refund", { params: { id: p } });
    expect((await h.store.get(TENANT, "Invoice", inv))?.["state"]).toBe("sent");
  });

  it("a past-due bill re-opens overdue, and one not yet due approved", async () => {
    const h = harness();
    const late = await approvedBill(h, "2026-06-01");
    const early = await approvedBill(h, "2026-07-15");
    const pl = await pay(h, { currency: "USD", direction: "outbound", bill_id: late, amount: "100.00" });
    const pe = await pay(h, { currency: "USD", direction: "outbound", bill_id: early, amount: "100.00" });
    await h.ok("payment.refund", { params: { id: pl } });
    await h.ok("payment.refund", { params: { id: pe } });
    expect((await h.store.get(TENANT, "Bill", late))?.["state"]).toBe("overdue");
    expect((await h.store.get(TENANT, "Bill", early))?.["state"]).toBe("approved");
  });

  it("the paid mark and the re-open are attributed to whoever moved the payment", async () => {
    const h = harness();
    const inv = await sentInvoice(h, "2026-07-15");
    // Somebody else touched it last; the settlement is this principal's act, not theirs.
    await h.store.update(TENANT, "Invoice", inv, { updated_by: SOMEONE_ELSE });
    const p = await pay(h, { currency: "USD", direction: "inbound", invoice_id: inv, amount: "100.00" });
    expect((await h.store.get(TENANT, "Invoice", inv))?.["updated_by"]).toBe(ACTOR);
    await h.store.update(TENANT, "Invoice", inv, { updated_by: SOMEONE_ELSE });
    await h.ok("payment.refund", { params: { id: p } });
    expect((await h.store.get(TENANT, "Invoice", inv))?.["updated_by"]).toBe(ACTOR);
  });
});

describe("the period-close revaluation of a bill (ADR-0441 Q5)", () => {
  async function closeJune(h: H): Promise<EntityRecord[]> {
    const fy = await h.ok("fiscalYear.create", { body: { code: "FY26", name: "FY26", start_date: "2026-01-01", end_date: "2026-12-31" } });
    const per = await h.ok("fiscalPeriod.create", {
      body: { fiscal_year_id: fy["id"], period_number: 6, name: "2026-06", start_date: "2026-06-01", end_date: "2026-06-30" },
    });
    await h.ok("fiscalPeriod.close", { params: { id: String(per["id"]) } });
    const reval = (await h.store.list(TENANT, "JournalEntry")).find((e) => e["entry_number"] === "2026-06-FXREVAL");
    return reval === undefined ? [] : (await h.store.list(TENANT, "JournalLine")).filter((l) => l["journal_entry_id"] === reval["id"]);
  }

  async function eurRates(h: H): Promise<void> {
    const usd = await h.ok("currency.create", { body: { code: "USD", name: "US Dollar", decimal_places: 2 } });
    const eur = await h.ok("currency.create", { body: { code: "EUR", name: "Euro", decimal_places: 2 } });
    for (const [date, rate] of [["2026-06-01", "1.1000000000"], ["2026-06-30", "1.2000000000"]] as const) {
      await h.ok("exchangeRate.create", { body: { from_currency_id: eur["id"], to_currency_id: usd["id"], rate_date: date, rate } });
    }
  }

  const net = (l: EntityRecord): bigint => (moneyUnits(l["functional_debit"]) ?? 0n) - (moneyUnits(l["functional_credit"]) ?? 0n);

  it("revalues an open EUR bill on its whole payable — the control", async () => {
    const h = harness({ functional: "USD" });
    await eurRates(h);
    await approvedBill(h, "2026-07-15", "EUR");
    const lines = await closeJune(h);
    // EUR 100 carried at 110.00 and owed at 120.00: a loss of 10.00 on the payable.
    expect(lines.map((l) => [l["ledger_account_id"], net(l)]).sort()).toEqual(
      [["accounts_payable", -1000n], ["unrealized_fx_gain_loss", 1000n]].sort(),
    );
  });

  it("revalues nothing for a EUR bill that was voided, whose payable the void reversed", async () => {
    const h = harness({ functional: "USD" });
    await eurRates(h);
    const bill = await approvedBill(h, "2026-07-15", "EUR");
    await h.ok("bill.void", { params: { id: bill } });
    expect(await closeJune(h)).toEqual([]);
  });
});

describe("the WHT reconciliation as the compiled server wires it (ADR-0475)", () => {
  // Stored directly: the report reads stamped figures, and the wiring under test is which states and
  // which credit-note shape compile.ts hands it, read off the pack rather than written as literals.
  async function seed(h: H, state: string, creditNote: boolean): Promise<void> {
    const inv = await h.store.create(TENANT, "Invoice", {
      account_id: ACCOUNT, currency: "USD", subtotal: "100.00", tax_total: "0.00", total: "100.00",
      issue_date: "2026-06-05", due_date: "2026-07-15", state, withholding_total: "5.00",
    });
    if (creditNote) {
      await h.store.create(TENANT, "Invoice", {
        account_id: ACCOUNT, currency: "USD", subtotal: "100.00", tax_total: "0.00", total: "100.00",
        issue_date: "2026-06-06", due_date: "2026-07-15", state: "sent", withholding_total: "5.00",
        document_type: "credit_note", credit_note_of: String(inv["id"]),
      });
    }
  }

  async function withheld(h: H): Promise<number> {
    const out = await h.call("meta.whtReconciliation.read");
    if (out.kind !== "json" || out.status !== 200) throw new Error(`wht → ${JSON.stringify(out)}`);
    return (out.body as { totals: { withheld: number } }).totals.withheld;
  }

  it("does not count a voided invoice the void credited in full", async () => {
    const h = harness();
    await seed(h, "void", true);
    expect(await withheld(h)).toBe(0);
  });

  it("does not count a voided invoice no credit note names, which withheld nothing", async () => {
    // The voided set is what decides this one — the netting has no credit note to net against.
    const h = harness();
    await seed(h, "void", false);
    expect(await withheld(h)).toBe(0);
  });

  it("counts the same invoice while it stands — the control", async () => {
    const h = harness();
    await seed(h, "sent", false);
    expect(await withheld(h)).toBe(5);
  });
});

describe("aging asOf through the compiled route (ADR-0475)", () => {
  it("refuses a past date and serves today", async () => {
    const h = harness();
    const past = await h.call("meta.aging.read", { query: { asOf: "2026-06-14" } });
    expect(past).toMatchObject({ status: 400, body: { error: "as_of_not_served" } });
    const today = await h.call("meta.aging.read", { query: { asOf: "2026-06-15" } });
    expect(today).toMatchObject({ status: 200 });
  });
});
