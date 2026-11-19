import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import { buildIncomingRequest, type HandlerOutput } from "@crossengin/api-gateway-runtime";
import { buildErpCorePack } from "@crossengin/pack-erp-core";
import { describe, expect, it } from "vitest";

import { compileOperateServer } from "./compile.js";
import { multiplyDecimal, parseDecimal } from "./decimal.js";
import { moneyUnits, unitsToDecimal } from "./money.js";
import { routeFromSpec } from "./operations.js";
import { InMemorySettingsStore } from "./settings.js";
import { InMemoryEntityStore, type EntityRecord } from "./store.js";
import { withinOneUnitAtScale } from "./decimal.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const ACCOUNT = "00000000-0000-4000-8000-0000000000ac";
const manifest = buildErpCorePack();

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

interface Harness {
  readonly store: InMemoryEntityStore;
  call(opId: string, opts?: { params?: Record<string, string>; body?: Record<string, unknown> }): Promise<HandlerOutput>;
  ok(opId: string, opts?: { params?: Record<string, string>; body?: Record<string, unknown> }): Promise<EntityRecord>;
}

function harness(opts: { functional?: string } = {}): Harness {
  const store = new InMemoryEntityStore();
  const clock = { now: () => new Date("2026-06-15T12:00:00.000Z") };
  const settingsStore = new InMemorySettingsStore();
  if (opts.functional !== undefined) void settingsStore.put(TENANT, { defaults: { currency: opts.functional } });
  const server = compileOperateServer(manifest, {
    store,
    clock,
    settingsStore,
    principalRoles: (p) => ({ primaryRole: p?.grantedScopes[0] ?? "anonymous" }),
  });
  const call: Harness["call"] = async (opId, o = {}) => {
    const spec =
      server.routeSpecs.find((s) => s.operationId === opId) ??
      ({ ...server.routeSpecs[0]!, operationId: opId, method: "GET" } as (typeof server.routeSpecs)[number]);
    const handler = server.handlers.resolve(opId);
    if (handler === undefined || handler === null) throw new Error(`no handler for ${opId}`);
    const request = buildIncomingRequest({
      id: "req_h11000000001",
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
  const ok: Harness["ok"] = async (opId, o) => {
    const out = await call(opId, o);
    if (out.kind !== "json" || out.status >= 300) {
      throw new Error(`${opId} → ${out.kind === "json" ? `${out.status} ${JSON.stringify(out.body)}` : out.kind}`);
    }
    return out.body as EntityRecord;
  };
  return { store, call, ok };
}

function errorOf(out: HandlerOutput): [number, string] | null {
  return out.kind === "json" ? [out.status, String((out.body as { error?: string }).error)] : null;
}

/** Units of a field, exactly. */
function u(v: unknown): bigint {
  return moneyUnits(v) ?? 0n;
}

/**
 * The invariants every posted entry must hold, checked over the whole journal: debits equal credits
 * per currency and over the functional amounts, and every line that moves a transaction amount states
 * its functional amount as that amount at its own rate (to a cent).
 */
async function assertLedgerSound(h: Harness): Promise<void> {
  const lines = await h.store.list(TENANT, "JournalLine");
  const byEntry = new Map<string, EntityRecord[]>();
  for (const l of lines) {
    const k = String(l["journal_entry_id"]);
    byEntry.set(k, [...(byEntry.get(k) ?? []), l]);
  }
  for (const [entry, ls] of byEntry) {
    const perCurrency = new Map<string, bigint>();
    let functional = 0n;
    for (const l of ls) {
      const cur = String(l["currency"]);
      perCurrency.set(cur, (perCurrency.get(cur) ?? 0n) + u(l["debit"]) - u(l["credit"]));
      functional += u(l["functional_debit"]) - u(l["functional_credit"]);
      const rate = parseDecimal(l["fx_rate"] ?? 1)!;
      for (const [amount, fn] of [["debit", "functional_debit"], ["credit", "functional_credit"]] as const) {
        if (u(l["debit"]) === 0n && u(l["credit"]) === 0n) continue; // a functional-only adjustment
        const exact = multiplyDecimal(unitsToDecimal(u(l[amount])), rate);
        expect(withinOneUnitAtScale(unitsToDecimal(u(l[fn])), exact, 2), `${entry} ${amount}@${String(l["fx_rate"])}`).toBe(true);
      }
    }
    for (const [cur, net] of perCurrency) expect(net, `${entry} in ${cur}`).toBe(0n);
    expect(functional, `${entry} functional`).toBe(0n);
  }
}

/** Functional balance per ledger account, in units. */
async function functionalBalances(h: Harness): Promise<Record<string, bigint>> {
  const out: Record<string, bigint> = {};
  for (const l of await h.store.list(TENANT, "JournalLine")) {
    const a = String(l["ledger_account_id"]);
    out[a] = (out[a] ?? 0n) + u(l["functional_debit"]) - u(l["functional_credit"]);
  }
  return out;
}

/** Transaction balance per ledger account in one currency, in units. */
async function balancesIn(h: Harness, currency: string): Promise<Record<string, bigint>> {
  const out: Record<string, bigint> = {};
  for (const l of await h.store.list(TENANT, "JournalLine")) {
    if (l["currency"] !== currency) continue;
    const a = String(l["ledger_account_id"]);
    out[a] = (out[a] ?? 0n) + u(l["debit"]) - u(l["credit"]);
  }
  return out;
}

async function rates(h: Harness, entries: { date: string; rate: string }[]): Promise<void> {
  const usd = await h.ok("currency.create", { body: { code: "USD", name: "US Dollar", decimal_places: 2 } });
  const eur = await h.ok("currency.create", { body: { code: "EUR", name: "Euro", decimal_places: 2 } });
  for (const e of entries) {
    await h.ok("exchangeRate.create", { body: { from_currency_id: eur["id"], to_currency_id: usd["id"], rate_date: e.date, rate: e.rate } });
  }
}

async function invoice(h: Harness, total: string, extra: Record<string, unknown> = {}): Promise<string> {
  const inv = await h.ok("invoice.create", {
    body: { account_id: ACCOUNT, currency: "USD", subtotal: total, tax_total: "0.00", total, issue_date: "2026-06-05", due_date: "2026-07-15", ...extra },
  });
  return String(inv["id"]);
}

async function entryNumbered(h: Harness, number: string): Promise<EntityRecord | undefined> {
  return (await h.store.list(TENANT, "JournalEntry")).find((e) => e["entry_number"] === number);
}

/** The posting a document made, by the suffix its effect numbers it with (the harness allocates no numbers). */
async function postingOf(h: Harness, docId: string, suffix: string): Promise<EntityRecord | undefined> {
  return (await h.store.list(TENANT, "JournalEntry")).find((e) => e["entry_number"] === `${docId}${suffix}`);
}

async function agingArOpen(h: Harness): Promise<number> {
  const out = await h.call("meta.aging.read");
  if (out.kind !== "json") throw new Error("aging");
  return (out.body as { sections: { ar: { totalOpen: number } } }).sections.ar.totalOpen;
}


async function closeJune(h: Harness): Promise<EntityRecord[]> {
  const fy = await h.ok("fiscalYear.create", { body: { code: "FY26", name: "FY26", start_date: "2026-01-01", end_date: "2026-12-31" } });
  const per = await h.ok("fiscalPeriod.create", { body: { fiscal_year_id: fy["id"], period_number: 6, name: "2026-06", start_date: "2026-06-01", end_date: "2026-06-30" } });
  await h.ok("fiscalPeriod.close", { params: { id: String(per["id"]) } });
  const reval = await entryNumbered(h, "2026-06-FXREVAL");
  return reval === undefined ? [] : (await h.store.list(TENANT, "JournalLine")).filter((l) => l["journal_entry_id"] === reval["id"]);
}

describe("a foreign-currency document posts its functional amounts at its booking rate", () => {
  it("recognition carries the rate and the functional amounts, which balance", async () => {
    const h = harness();
    await rates(h, [{ date: "2026-06-01", rate: "1.1000000000" }]);
    const inv = await invoice(h, "100.00", { currency: "EUR" });
    await h.ok("invoice.send", { params: { id: inv } });
    const entry = await postingOf(h, inv, "-AR");
    const lines = (await h.store.list(TENANT, "JournalLine")).filter((l) => l["journal_entry_id"] === entry!["id"]);
    expect(lines.map((l) => [l["currency"], String(l["fx_rate"])])).toEqual([
      ["EUR", "1.1000000000"],
      ["EUR", "1.1000000000"],
    ]);
    expect(await functionalBalances(h)).toEqual({ accounts_receivable: 11000n, revenue: -11000n });
    expect(await balancesIn(h, "EUR")).toEqual({ accounts_receivable: 10000n, revenue: -10000n });
    await assertLedgerSound(h);
  });

  it("three lines at a rate whose roundings do not balance are balanced at a cent each", async () => {
    const h = harness();
    await rates(h, [{ date: "2026-06-01", rate: "1.5000000000" }]);
    const vat = String((await h.ok("taxCode.create", { body: { code: "Z", name: "Z", rate_pct: "0.000", kind: "vat" } }))["id"]);
    const inv = await invoice(h, "99.99", { currency: "EUR" });
    for (const pos of [1, 2, 3]) {
      await h.ok("invoiceLine.create", {
        body: { invoice_id: inv, position: pos, description: "x", quantity: "1", unit_price: "33.33", line_total: "33.33", tax_code_id: vat },
      });
    }
    await h.ok("invoice.send", { params: { id: inv } });
    await assertLedgerSound(h);
  });

  it("refuses by name when the tenant declared its functional currency and no rate exists", async () => {
    const h = harness({ functional: "USD" });
    await rates(h, []);
    const inv = await invoice(h, "100.00", { currency: "EUR" });
    expect(errorOf(await h.call("invoice.send", { params: { id: inv } }))).toEqual([409, "exchange_rate_unresolved"]);
    expect((await h.store.get(TENANT, "Invoice", inv))?.["state"]).toBe("draft");
    expect(await h.store.list(TENANT, "JournalEntry")).toEqual([]);
  });

  it("with no functional currency declared and no rate, a document's own currency is taken at face value", async () => {
    // The deployment has not said what its base currency is, so a tenant invoicing only in EUR is
    // posting in its functional currency — refusing it would refuse a correct posting.
    const h = harness();
    const inv = await invoice(h, "100.00", { currency: "EUR" });
    await h.ok("invoice.send", { params: { id: inv } });
    expect(await functionalBalances(h)).toEqual({ accounts_receivable: 10000n, revenue: -10000n });
    await assertLedgerSound(h);
  });

  it("a settlement clears the receivable at its booking rate and books the realized difference functional-only", async () => {
    const h = harness();
    await rates(h, [{ date: "2026-06-01", rate: "1.1000000000" }]);
    const inv = await invoice(h, "100.00", { currency: "EUR" });
    await h.ok("invoice.send", { params: { id: inv } });
    const p = await h.ok("payment.create", { body: { currency: "EUR", direction: "inbound", invoice_id: inv, amount: "100.00", cash_amount: "120.00" } });
    await h.ok("payment.submit", { params: { id: String(p["id"]) } });
    await h.ok("payment.complete", { params: { id: String(p["id"]) } });
    expect(await functionalBalances(h)).toEqual({ accounts_receivable: 0n, revenue: -11000n, cash: 12000n, fx_gain_loss: -1000n });
    expect(await balancesIn(h, "EUR")).toEqual({ accounts_receivable: 0n, revenue: -10000n, cash: 10000n, fx_gain_loss: 0n });
    await assertLedgerSound(h);
  });

  it("the period-close revaluation moves functional amounts only", async () => {
    const h = harness();
    await rates(h, [
      { date: "2026-06-01", rate: "1.1000000000" },
      { date: "2026-06-30", rate: "1.2000000000" },
    ]);
    const inv = await invoice(h, "100.00", { currency: "EUR" });
    await h.ok("invoice.send", { params: { id: inv } });
    const fy = await h.ok("fiscalYear.create", { body: { code: "FY26", name: "FY26", start_date: "2026-01-01", end_date: "2026-12-31" } });
    const per = await h.ok("fiscalPeriod.create", { body: { fiscal_year_id: fy["id"], period_number: 6, name: "2026-06", start_date: "2026-06-01", end_date: "2026-06-30" } });
    await h.ok("fiscalPeriod.close", { params: { id: String(per["id"]) } });
    const reval = await entryNumbered(h, "2026-06-FXREVAL");
    const lines = (await h.store.list(TENANT, "JournalLine")).filter((l) => l["journal_entry_id"] === reval!["id"]);
    expect(lines.map((l) => [u(l["debit"]), u(l["credit"]), u(l["functional_debit"]) - u(l["functional_credit"])]).sort()).toEqual(
      [[0n, 0n, 1000n], [0n, 0n, -1000n]].sort(),
    );
    // Revalued and reversed on the next day: the receivable's functional balance is its booking value again.
    expect((await functionalBalances(h))["accounts_receivable"]).toBe(11000n);
    await assertLedgerSound(h);
  });

  it("a credit note is revalued with the document it credits, so a full void revalues nothing", async () => {
    const h = harness();
    await rates(h, [
      { date: "2026-06-01", rate: "1.1000000000" },
      { date: "2026-06-30", rate: "1.2000000000" },
    ]);
    const inv = await invoice(h, "100.00", { currency: "EUR" });
    await h.ok("invoice.send", { params: { id: inv } });
    await h.ok("invoice.void", { params: { id: inv } });
    expect((await functionalBalances(h))["accounts_receivable"]).toBe(0n);
    // The ledger carries no receivable, so the close has nothing to revalue.
    expect(await closeJune(h)).toEqual([]);
  });

  it("an API credit note reduces the balance the close revalues", async () => {
    const h = harness();
    await rates(h, [
      { date: "2026-06-01", rate: "1.1000000000" },
      { date: "2026-06-30", rate: "1.2000000000" },
    ]);
    const inv = await invoice(h, "100.00", { currency: "EUR" });
    await h.ok("invoice.send", { params: { id: inv } });
    const cn = await invoice(h, "40.00", { currency: "EUR", document_type: "credit_note", credit_note_of: inv });
    await h.ok("invoice.send", { params: { id: cn } });
    expect(await balancesIn(h, "EUR")).toEqual({ accounts_receivable: 6000n, revenue: -6000n });
    // EUR 60 open, carried at 66.00 and worth 72.00: a gain of 6.00 — not 14.00, which revalued the
    // credit note as a second receivable.
    const lines = await closeJune(h);
    expect(lines.map((l) => [l["ledger_account_id"], u(l["functional_debit"]) - u(l["functional_credit"])]).sort()).toEqual(
      [["accounts_receivable", 600n], ["unrealized_fx_gain_loss", -600n]].sort(),
    );
    await assertLedgerSound(h);
  });

  it("a WHT certificate reclasses at the rate its invoice was booked at, not the rate on its own date", async () => {
    const h = harness();
    await rates(h, [
      { date: "2026-06-01", rate: "1.1000000000" },
      { date: "2026-06-10", rate: "1.3000000000" },
    ]);
    const inv = await invoice(h, "100.00", { currency: "EUR", issue_date: "2026-06-05" });
    await h.ok("invoice.send", { params: { id: inv } });
    const cert = await h.ok("whtCertificate.create", {
      body: { amount: "5.00", currency: "EUR", issue_date: "2026-06-15", invoice_id: inv },
    });
    await h.ok("whtCertificate.update", { params: { id: String(cert["id"]) }, body: { state: "confirmed" } });
    const balances = await functionalBalances(h);
    expect([balances["wht_receivable"], balances["income_tax_recoverable"]]).toEqual([-550n, 550n]);
    await assertLedgerSound(h);
  });

  it("instalments clear exactly what was booked, so a paid invoice leaves no receivable", async () => {
    const h = harness();
    await rates(h, [{ date: "2026-06-01", rate: "1.0731000000" }]);
    const inv = await invoice(h, "100.01", { currency: "EUR" });
    await h.ok("invoice.send", { params: { id: inv } });
    for (const amount of ["33.33", "33.33", "33.35"]) {
      const p = await h.ok("payment.create", { body: { currency: "EUR", direction: "inbound", invoice_id: inv, amount } });
      await h.ok("payment.submit", { params: { id: String(p["id"]) } });
      await h.ok("payment.complete", { params: { id: String(p["id"]) } });
    }
    expect((await h.store.get(TENANT, "Invoice", inv))?.["state"]).toBe("paid");
    // Each instalment converted alone clears 35.77 + 35.77 + 35.79 = 107.33 from 107.32 booked.
    expect((await functionalBalances(h))["accounts_receivable"]).toBe(0n);
    expect((await balancesIn(h, "EUR"))["accounts_receivable"]).toBe(0n);
    await assertLedgerSound(h);
  });
});

describe("a credit note created through the API posts, and voiding one reverses it", () => {
  async function apiCreditNote(h: Harness, of: string, total: string): Promise<string> {
    return invoice(h, total, { document_type: "credit_note", credit_note_of: of });
  }

  it("sending it reverses the sale for its amount, so the GL agrees with aging", async () => {
    const h = harness();
    const inv = await invoice(h, "110.00");
    await h.ok("invoice.send", { params: { id: inv } });
    const cn = await apiCreditNote(h, inv, "55.00");
    await h.ok("invoice.send", { params: { id: cn } });
    expect(await functionalBalances(h)).toEqual({ accounts_receivable: 5500n, revenue: -5500n });
    expect(await agingArOpen(h)).toBe(55);
    await assertLedgerSound(h);
  });

  it("voiding it reverses its posting, and the receivable is owed again", async () => {
    const h = harness();
    const inv = await invoice(h, "110.00");
    await h.ok("invoice.send", { params: { id: inv } });
    const cn = await apiCreditNote(h, inv, "55.00");
    await h.ok("invoice.send", { params: { id: cn } });
    await h.ok("invoice.void", { params: { id: cn } });
    expect((await functionalBalances(h))["accounts_receivable"]).toBe(11000n);
    expect(await agingArOpen(h)).toBe(110);
    await assertLedgerSound(h);
  });

  it("refuses to void the credit note a void issued, which would need the invoice un-voided", async () => {
    const h = harness();
    const inv = await invoice(h, "80.00");
    await h.ok("invoice.send", { params: { id: inv } });
    await h.ok("invoice.void", { params: { id: inv } });
    const cn = (await h.store.list(TENANT, "Invoice")).find((d) => d["document_type"] === "credit_note")!;
    expect(errorOf(await h.call("invoice.void", { params: { id: String(cn["id"]) } }))).toEqual([409, "credit_note_issued_by_void"]);
    expect((await h.store.get(TENANT, "Invoice", String(cn["id"])))?.["state"]).toBe("sent");
  });
});

describe("reversals reverse what stands, once", () => {
  it("a manual reverse after a partial credit reverses only the remainder", async () => {
    const h = harness();
    const inv = await invoice(h, "110.00", { credit_amount: "50.00" });
    await h.ok("invoice.send", { params: { id: inv } });
    await h.ok("invoice.void", { params: { id: inv } });
    const ar = await postingOf(h, inv, "-AR");
    await h.ok("journalEntry.reverse", { params: { id: String(ar!["id"]) } });
    expect(await functionalBalances(h)).toEqual({ accounts_receivable: 0n, revenue: 0n });
    await assertLedgerSound(h);
  });

  it("refuses to reverse a credit's posting once the entry it partly reversed is reversed", async () => {
    const h = harness();
    const inv = await invoice(h, "110.00", { credit_amount: "50.00" });
    await h.ok("invoice.send", { params: { id: inv } });
    await h.ok("invoice.void", { params: { id: inv } });
    await h.ok("journalEntry.reverse", { params: { id: String((await postingOf(h, inv, "-AR"))!["id"]) } });
    const credit = (await postingOf(h, inv, "-CN-GL"))!;
    expect(errorOf(await h.call("journalEntry.reverse", { params: { id: String(credit["id"]) } }))).toEqual([
      409,
      "reversal_source_already_reversed",
    ]);
    expect((await h.store.get(TENANT, "JournalEntry", String(credit["id"])))?.["state"]).toBe("posted");
    expect(await functionalBalances(h)).toEqual({ accounts_receivable: 0n, revenue: 0n });
  });

  it("refuses to reverse a full credit's posting, which would put the receivable back on a void invoice", async () => {
    const h = harness();
    const inv = await invoice(h, "80.00");
    await h.ok("invoice.send", { params: { id: inv } });
    await h.ok("invoice.void", { params: { id: inv } });
    const credit = (await postingOf(h, inv, "-CN-GL"))!;
    expect(errorOf(await h.call("journalEntry.reverse", { params: { id: String(credit["id"]) } }))).toEqual([
      409,
      "reversal_source_already_reversed",
    ]);
    // The control: an ordinary posted entry still reverses.
    const other = await invoice(h, "30.00");
    await h.ok("invoice.send", { params: { id: other } });
    await h.ok("journalEntry.reverse", { params: { id: String((await postingOf(h, other, "-AR"))!["id"]) } });
    expect(await functionalBalances(h)).toEqual({ accounts_receivable: 0n, revenue: 0n });
  });

  it("refuses to void a bill payments have been applied to, which would leave a debit on payables", async () => {
    const h = harness();
    const bill = await h.ok("bill.create", {
      body: { vendor_id: ACCOUNT, bill_date: "2026-06-15", due_date: "2026-07-15", subtotal: "200.00", tax_total: "0.00", total: "200.00" },
    });
    const id = String(bill["id"]);
    await h.ok("bill.approve", { params: { id } });
    const p = await h.ok("payment.create", { body: { currency: "USD", direction: "outbound", bill_id: id, amount: "50.00" } });
    await h.ok("payment.submit", { params: { id: String(p["id"]) } });
    await h.ok("payment.complete", { params: { id: String(p["id"]) } });
    expect(errorOf(await h.call("bill.void", { params: { id } }))).toEqual([409, "document_partly_settled"]);
    expect((await h.store.get(TENANT, "Bill", id))?.["state"]).toBe("approved");
    // Refunded, the bill is unpaid again and voids cleanly.
    await h.ok("payment.refund", { params: { id: String(p["id"]) } });
    await h.ok("bill.void", { params: { id } });
    expect((await functionalBalances(h))["accounts_payable"]).toBe(0n);
    await assertLedgerSound(h);
  });

  it("voiding a confirmed WHT certificate reverses its clearing", async () => {
    const h = harness();
    const cert = await h.ok("whtCertificate.create", { body: { amount: "5.00", currency: "USD", issue_date: "2026-06-15" } });
    const id = String(cert["id"]);
    await h.ok("whtCertificate.update", { params: { id }, body: { state: "confirmed" } });
    expect((await functionalBalances(h))["wht_receivable"]).toBe(-500n);
    await h.ok("whtCertificate.update", { params: { id }, body: { state: "void" } });
    expect(await functionalBalances(h)).toEqual({ income_tax_recoverable: 0n, wht_receivable: 0n });
    await assertLedgerSound(h);
  });
});

describe("H-11: a currency finer than the ledger is refused, not rounded", () => {
  it("refuses a three-decimal currency by name, and admits two and zero", async () => {
    const h = harness();
    const out = await h.call("currency.create", { body: { code: "KWD", name: "Kuwaiti dinar", decimal_places: 3 } });
    expect(errorOf(out)).toEqual([422, "currency_precision_unsupported"]);
    expect(await h.store.listPage(TENANT, "Currency", { filters: [], sort: [], limit: 10, cursor: null })).toMatchObject({ records: [] });
    await h.ok("currency.create", { body: { code: "USD", name: "US dollar", decimal_places: 2 } });
    await h.ok("currency.create", { body: { code: "JPY", name: "Yen", decimal_places: 0 } });
  });

  it("refuses three decimal places spelled as a string, which the document store keeps as one", async () => {
    const h = harness();
    expect(errorOf(await h.call("currency.create", { body: { code: "KWD", name: "K", decimal_places: "3" } }))).toEqual([
      422,
      "currency_precision_unsupported",
    ]);
    await h.ok("currency.create", { body: { code: "EUR", name: "Euro", decimal_places: "2" } });
  });

  it("refuses raising an existing currency past the ledger's scale", async () => {
    const h = harness();
    const c = await h.ok("currency.create", { body: { code: "BHD", name: "Bahraini dinar", decimal_places: 2 } });
    const out = await h.call("currency.update", { params: { id: String(c.id) }, body: { decimal_places: 3 } });
    expect(errorOf(out)).toEqual([422, "currency_precision_unsupported"]);
    await h.ok("currency.update", { params: { id: String(c.id) }, body: { name: "Dinar" } });
  });
});
