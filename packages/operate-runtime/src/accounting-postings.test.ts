import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import { buildIncomingRequest, type HandlerOutput } from "@crossengin/api-gateway-runtime";
import { buildErpCorePack } from "@crossengin/pack-erp-core";
import { describe, expect, it } from "vitest";

import { compileOperateServer, type CompiledOperateServer } from "./compile.js";
import { routeFromSpec } from "./operations.js";
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

interface Harness {
  readonly store: InMemoryEntityStore;
  readonly server: CompiledOperateServer;
  call(opId: string, opts?: { params?: Record<string, string>; body?: Record<string, unknown> }): Promise<HandlerOutput>;
  ok(opId: string, opts?: { params?: Record<string, string>; body?: Record<string, unknown> }): Promise<EntityRecord>;
  balances(): Promise<Map<string, number>>;
  entries(): Promise<readonly EntityRecord[]>;
}

function harness(today = "2026-06-15"): Harness {
  const store = new InMemoryEntityStore();
  const clock = { now: () => new Date(`${today}T12:00:00.000Z`) };
  const server = compileOperateServer(manifest, {
    store,
    clock,
    principalRoles: (p) => ({ primaryRole: p?.grantedScopes[0] ?? "anonymous" }),
  });
  const call: Harness["call"] = async (opId, opts = {}) => {
    const spec =
      server.routeSpecs.find((s) => s.operationId === opId) ??
      ({ ...server.routeSpecs[0]!, operationId: opId, method: "GET" } as (typeof server.routeSpecs)[number]);
    const handler = server.handlers.resolve(opId);
    if (handler === undefined || handler === null) throw new Error(`no handler for ${opId}`);
    const request = buildIncomingRequest({
      id: "req_h13000000001",
      receivedAt: "2026-06-03T12:00:00.000Z",
      method: spec.method,
      path: "/v1/x",
      headers: {},
      host: "api.example.com",
      scheme: "https",
      bodyBytes: null,
      clientIp: "203.0.113.1",
      edgeTrust: "untrusted",
    });
    return handler({
      request,
      route: routeFromSpec(spec),
      principal: principal("erp_admin"),
      params: opts.params ?? {},
      parsedBody: opts.body ?? null,
    });
  };
  const ok: Harness["ok"] = async (opId, opts) => {
    const out = await call(opId, opts);
    if (out.kind !== "json" || out.status >= 300) {
      throw new Error(`${opId} → ${out.kind === "json" ? `${out.status} ${JSON.stringify(out.body)}` : out.kind}`);
    }
    return out.body as EntityRecord;
  };
  const balances: Harness["balances"] = async () => {
    const out = new Map<string, number>();
    for (const line of await store.list(TENANT, "JournalLine")) {
      const acct = String(line["ledger_account_id"]);
      const v = Number(line["debit"] ?? 0) - Number(line["credit"] ?? 0);
      out.set(acct, Math.round(((out.get(acct) ?? 0) + v) * 100) / 100);
    }
    return out;
  };
  const entries: Harness["entries"] = async () => store.list(TENANT, "JournalEntry");
  return { store, server, call, ok, balances, entries };
}

const ACCOUNT = "00000000-0000-4000-8000-0000000000ac";

async function invoice(h: Harness, lines: { net: string; code?: string }[], extra: Record<string, unknown> = {}): Promise<string> {
  let net = 0;
  let tax = 0;
  for (const l of lines) {
    net += Number(l.net);
    if (l.code !== undefined) {
      const code = await h.store.get(TENANT, "TaxCode", l.code);
      if (code !== null && code["kind"] !== "withholding") tax += Math.round(Number(l.net) * Number(code["rate_pct"])) / 100;
    }
  }
  const inv = await h.ok("invoice.create", {
    body: {
      account_id: ACCOUNT,
      currency: "USD",
      subtotal: net.toFixed(2),
      tax_total: tax.toFixed(2),
      total: (net + tax).toFixed(2),
      issue_date: "2026-06-15",
      due_date: "2026-07-15",
      ...extra,
    },
  });
  const id = String(inv["id"]);
  let pos = 1;
  for (const l of lines) {
    await h.ok("invoiceLine.create", {
      body: {
        invoice_id: id,
        position: pos++,
        description: "x",
        quantity: "1",
        unit_price: l.net,
        line_total: l.net,
        ...(l.code !== undefined ? { tax_code_id: l.code } : {}),
      },
    });
  }
  return id;
}

async function taxCode(h: Harness, code: string, rate: string, kind: string): Promise<string> {
  return String((await h.ok("taxCode.create", { body: { code, name: code, rate_pct: rate, kind } }))["id"]);
}

async function payment(h: Harness, body: Record<string, unknown>): Promise<string> {
  const p = await h.ok("payment.create", { body: { currency: "USD", ...body } });
  const id = String(p["id"]);
  await h.ok("payment.submit", { params: { id } });
  await h.ok("payment.complete", { params: { id } });
  return id;
}

async function periods(h: Harness, specs: { name: string; start: string; end: string; status?: string }[]): Promise<Map<string, string>> {
  const fy = await h.ok("fiscalYear.create", { body: { code: "FY26", name: "FY26", start_date: "2026-01-01", end_date: "2026-12-31" } });
  const ids = new Map<string, string>();
  let n = 1;
  for (const p of specs) {
    const per = await h.ok("fiscalPeriod.create", {
      body: { fiscal_year_id: fy["id"], period_number: n++, name: p.name, start_date: p.start, end_date: p.end },
    });
    ids.set(p.name, String(per["id"]));
    // A period's status moves only by transition: `close` reaches `closed`, and `lock` only from there.
    if (p.status === "closed" || p.status === "locked") await h.ok("fiscalPeriod.close", { params: { id: String(per["id"]) } });
    if (p.status === "locked") await h.ok("fiscalPeriod.lock", { params: { id: String(per["id"]) } });
  }
  return ids;
}

async function entryByNumberSuffix(h: Harness, suffix: string): Promise<EntityRecord[]> {
  return (await h.entries()).filter((e) => String(e["entry_number"]).endsWith(suffix));
}

async function linesOf(h: Harness, entryId: string): Promise<EntityRecord[]> {
  return (await h.store.list(TENANT, "JournalLine")).filter((l) => l["journal_entry_id"] === entryId);
}

function cents(v: unknown): number {
  return Math.round(Number(v ?? 0) * 100);
}

async function agingAr(h: Harness): Promise<{ totalOpen: number; documents: { number: string; open: number }[] }> {
  const out = await h.call("meta.aging.read");
  if (out.kind !== "json") throw new Error("aging");
  return (out.body as { sections: { ar: { totalOpen: number; documents: { number: string; open: number }[] } } }).sections.ar;
}

describe("a credit note reverses tax per code, as recognition split it", () => {
  it("a full credit on a VAT invoice leaves revenue, tax and AR all at zero", async () => {
    const h = harness();
    const vat = await taxCode(h, "VAT10", "10.000", "vat");
    const inv = await invoice(h, [{ net: "100.00", code: vat }]);
    await h.ok("invoice.send", { params: { id: inv } });
    expect(Object.fromEntries(await h.balances())).toEqual({ accounts_receivable: 110, revenue: -100, tax_payable: -10 });
    await h.ok("invoice.void", { params: { id: inv } });
    expect(Object.fromEntries(await h.balances())).toEqual({ accounts_receivable: 0, revenue: 0, tax_payable: 0 });
    // The recognition entry is marked reversed, so a later manual reverse cannot reverse it twice.
    const [recognition] = await entryByNumberSuffix(h, "-AR");
    expect(recognition?.["state"]).toBe("reversed");
    const again = await h.call("journalEntry.reverse", { params: { id: String(recognition!["id"]) } });
    expect(again.kind === "json" ? again.status : 0).toBe(409);
  });

  it("a partial credit carries tax in proportion, on the GL and on the document", async () => {
    const h = harness();
    const vat = await taxCode(h, "VAT10", "10.000", "vat");
    const inv = await invoice(h, [{ net: "100.00", code: vat }], { credit_amount: "55.00" });
    await h.ok("invoice.send", { params: { id: inv } });
    await h.ok("invoice.void", { params: { id: inv } });
    expect(Object.fromEntries(await h.balances())).toEqual({ accounts_receivable: 55, revenue: -50, tax_payable: -5 });
    const cn = (await h.store.list(TENANT, "Invoice")).find((d) => d["document_type"] === "credit_note")!;
    expect([cn["total"], cn["subtotal"], cn["tax_total"]].map(Number)).toEqual([55, 50, 5]);
    // A part-reversal leaves the recognition entry standing.
    expect((await entryByNumberSuffix(h, "-AR"))[0]?.["state"]).toBe("posted");
    // The void original and its credit note age together: 110 owed, 55 credited.
    const ar = await agingAr(h);
    expect(ar.totalOpen).toBe(55);
  });

  it("a scaled reversal balances exactly and sums to the part asked for", async () => {
    const h = harness();
    const vat = await taxCode(h, "VAT7", "7.500", "vat");
    const gst = await taxCode(h, "GST3", "3.000", "gst");
    const inv = await invoice(
      h,
      [{ net: "13.40", code: vat }, { net: "27.77", code: gst }, { net: "9.99", code: vat }],
      { credit_amount: "33.33" },
    );
    await h.ok("invoice.send", { params: { id: inv } });
    await h.ok("invoice.void", { params: { id: inv } });
    const [cnEntry] = await entryByNumberSuffix(h, "-CN-GL");
    const lines = await linesOf(h, String(cnEntry!["id"]));
    const d = lines.reduce((a, l) => a + cents(l["debit"]), 0);
    const c = lines.reduce((a, l) => a + cents(l["credit"]), 0);
    expect(d).toBe(3333);
    expect(c).toBe(3333);
    expect(lines.reduce((a, l) => a + cents(l["functional_debit"]), 0)).toBe(lines.reduce((a, l) => a + cents(l["functional_credit"]), 0));
  });
});

describe("withholding is not owed by the payer", () => {
  it("a payment of the total less withholding settles the invoice", async () => {
    const h = harness();
    const wht = await taxCode(h, "WHT5", "5.000", "withholding");
    const inv = await invoice(h, [{ net: "100.00", code: wht }]);
    await h.ok("invoice.send", { params: { id: inv } });
    expect(Number((await h.store.get(TENANT, "Invoice", inv))?.["withholding_total"])).toBe(5);
    await payment(h, { direction: "inbound", invoice_id: inv, amount: "95.00" });
    expect((await h.store.get(TENANT, "Invoice", inv))?.["state"]).toBe("paid");
    expect((await agingAr(h)).totalOpen).toBe(0);
  });

  it("a payment short of it still leaves the invoice open, and mark_paid is refused for the real remainder", async () => {
    const h = harness();
    const wht = await taxCode(h, "WHT5", "5.000", "withholding");
    const inv = await invoice(h, [{ net: "100.00", code: wht }]);
    await h.ok("invoice.send", { params: { id: inv } });
    await payment(h, { direction: "inbound", invoice_id: inv, amount: "90.00" });
    expect((await h.store.get(TENANT, "Invoice", inv))?.["state"]).toBe("sent");
    const out = await h.call("invoice.mark_paid", { params: { id: inv } });
    expect(out.kind === "json" ? out.status : 0).toBe(422);
    expect(JSON.stringify(out.kind === "json" ? out.body : null)).toContain("5.00 of 95.00");
    expect((await agingAr(h)).totalOpen).toBe(5);
  });

  it("a withholding the caller wrote is not withholding: it reduces nothing owed", async () => {
    // Withholding is read as a server fact only where an effect stamps it. With the stamp absent —
    // here a deployment passing its own effects, equally a manifest declaring no TaxCode — the field
    // is ordinary caller input, and reading it let `mark_paid` through with nothing paid by typing
    // the withholding equal to the total.
    const store = new InMemoryEntityStore();
    const server = compileOperateServer(manifest, {
      store,
      writeEffects: [],
      principalRoles: (p) => ({ primaryRole: p?.grantedScopes[0] ?? "anonymous" }),
    });
    const run = async (opId: string, opts: { params?: Record<string, string>; body?: Record<string, unknown> } = {}) => {
      const spec = server.routeSpecs.find((s) => s.operationId === opId)!;
      const request = buildIncomingRequest({
        id: "req_h13000000002",
        receivedAt: "2026-06-03T12:00:00.000Z",
        method: spec.method,
        path: "/v1/x",
        headers: {},
        host: "api.example.com",
        scheme: "https",
        bodyBytes: null,
        clientIp: "203.0.113.1",
        edgeTrust: "untrusted",
      });
      const out = await server.handlers.resolve(opId)!({
        request,
        route: routeFromSpec(spec),
        principal: principal("erp_admin"),
        params: opts.params ?? {},
        parsedBody: opts.body ?? null,
      });
      return out.kind === "json" ? { status: out.status, body: out.body as Record<string, unknown> } : { status: 0, body: {} };
    };
    const created = await run("invoice.create", {
      body: {
        account_id: ACCOUNT, currency: "USD", subtotal: "100.00", tax_total: "0.00", total: "100.00",
        withholding_total: "100.00", issue_date: "2026-06-15", due_date: "2026-07-15",
      },
    });
    expect(created.status).toBe(201);
    const id = String(created.body["id"]);
    expect((await run("invoice.send", { params: { id } })).status).toBe(200);
    const paid = await run("invoice.mark_paid", { params: { id } });
    expect([paid.status, paid.body["error"]]).toEqual([422, "uncovered_settlement"]);
    // Control: where the stamp exists, the caller cannot write the field at all.
    const h = harness();
    const refused = await h.call("invoice.create", {
      body: { account_id: ACCOUNT, currency: "USD", subtotal: "1.00", total: "1.00", withholding_total: "1.00", issue_date: "2026-06-15", due_date: "2026-07-15" },
    });
    expect(refused.kind === "json" ? refused.status : 0).toBe(422);
  });
});

describe("leaving the state a posting stands in reverses the posting", () => {
  async function approvedBill(h: Harness): Promise<string> {
    const bill = await h.ok("bill.create", {
      body: { vendor_id: ACCOUNT, bill_date: "2026-06-15", due_date: "2026-07-15", subtotal: "200.00", tax_total: "0.00", total: "200.00" },
    });
    return String(bill["id"]);
  }

  it("voiding an approved bill reverses its approval entry", async () => {
    const h = harness();
    const bill = await approvedBill(h);
    await h.ok("bill.approve", { params: { id: bill } });
    expect(Object.fromEntries(await h.balances())).toEqual({ accounts_payable: -200, expense: 200 });
    await h.ok("bill.void", { params: { id: bill } });
    expect(Object.fromEntries(await h.balances())).toEqual({ accounts_payable: 0, expense: 0 });
    expect((await entryByNumberSuffix(h, "-GL"))[0]?.["state"]).toBe("reversed");
    expect((await entryByNumberSuffix(h, "-VOID")).length).toBe(1);
  });

  it("refuses, by name, to guess which of two entries carrying one number to reverse", async () => {
    const h = harness();
    const bill = await approvedBill(h);
    await h.ok("bill.approve", { params: { id: bill } });
    const [gl] = await entryByNumberSuffix(h, "-GL");
    await h.store.create(TENANT, "JournalEntry", { entry_number: gl!["entry_number"], state: "posted", entry_date: "2026-06-15" });
    const out = await h.call("bill.void", { params: { id: bill } });
    expect(out.kind === "json" ? [out.status, (out.body as { error: string }).error] : null).toEqual([409, "posting_ambiguous"]);
    expect((await h.store.get(TENANT, "Bill", bill))?.["state"]).toBe("approved");
  });

  it("voiding a bill that never posted posts nothing", async () => {
    const h = harness();
    const bill = await approvedBill(h);
    await h.ok("bill.void", { params: { id: bill } });
    expect(await h.entries()).toEqual([]);
  });

  it("a refund reverses the settlement and re-opens the invoice it settled", async () => {
    const h = harness();
    const inv = await invoice(h, [{ net: "50.00" }]);
    await h.ok("invoice.send", { params: { id: inv } });
    const pay = await payment(h, { direction: "inbound", invoice_id: inv, amount: "50.00" });
    expect((await h.store.get(TENANT, "Invoice", inv))?.["state"]).toBe("paid");
    await h.ok("payment.refund", { params: { id: pay } });
    expect(Object.fromEntries(await h.balances())).toEqual({ accounts_receivable: 50, revenue: -50, cash: 0 });
    const after = await h.store.get(TENANT, "Invoice", inv);
    expect(after?.["state"]).toBe("sent");
    expect(after?.["paid_at"] ?? null).toBeNull();
    expect((await agingAr(h)).totalOpen).toBe(50);
  });

  it("a refund leaves an invoice settled while another payment still covers it", async () => {
    const h = harness();
    const inv = await invoice(h, [{ net: "50.00" }]);
    await h.ok("invoice.send", { params: { id: inv } });
    const first = await payment(h, { direction: "inbound", invoice_id: inv, amount: "50.00" });
    // A second completed payment against the same (already settled) invoice — an overpayment.
    await payment(h, { direction: "inbound", invoice_id: inv, amount: "50.00" });
    await h.ok("payment.refund", { params: { id: first } });
    expect((await h.store.get(TENANT, "Invoice", inv))?.["state"]).toBe("paid");
  });
});

describe("a posting dated into a locked period is refused", () => {
  it("an effect posting into a closed period refuses the whole write", async () => {
    const h = harness();
    await periods(h, [{ name: "2026-06", start: "2026-06-01", end: "2026-06-30", status: "closed" }]);
    const inv = await invoice(h, [{ net: "10.00" }]);
    const out = await h.call("invoice.send", { params: { id: inv } });
    expect(out.kind === "json" ? [out.status, (out.body as { error: string }).error] : null).toEqual([422, "period_locked"]);
    expect((await h.store.get(TENANT, "Invoice", inv))?.["state"]).toBe("draft");
    expect(await h.entries()).toEqual([]);
  });

  it("an effect posting into an open period is stamped with it", async () => {
    const h = harness();
    const ids = await periods(h, [{ name: "2026-06", start: "2026-06-01", end: "2026-06-30" }]);
    const inv = await invoice(h, [{ net: "10.00" }]);
    await h.ok("invoice.send", { params: { id: inv } });
    expect((await h.entries())[0]?.["fiscal_period_id"]).toBe(ids.get("2026-06"));
  });

  it("a manual entry dated into a closed period is refused even when it names no period", async () => {
    const h = harness();
    await periods(h, [{ name: "2026-05", start: "2026-05-01", end: "2026-05-31", status: "closed" }]);
    const post = async (date: string): Promise<HandlerOutput> => {
      const je = await h.ok("journalEntry.create", { body: { entry_number: `M-${date}`, entry_date: date, source: "manual" } });
      for (const [debit, credit] of [["10.00", "0.00"], ["0.00", "10.00"]]) {
        await h.ok("journalLine.create", {
          body: { journal_entry_id: je["id"], ledger_account_id: ACCOUNT, currency: "USD", debit, credit, functional_debit: debit, functional_credit: credit },
        });
      }
      return h.call("journalEntry.post", { params: { id: String(je["id"]) } });
    };
    const out = await post("2026-05-20");
    expect(out.kind === "json" ? [out.status, (out.body as { error: string }).error] : null).toEqual([422, "period_locked"]);
    const control = await post("2026-06-02");
    expect(control.kind === "json" ? control.status : 0).toBe(200);
  });

  it("an adjusting entry naming the open adjustment period posts after the ordinary period closes", async () => {
    // Period 13 shares its dates with period 12, and posting year-end adjustments into it after 12
    // is closed is what it exists for. Resolved by date alone the entry fell in the closed period 12
    // and was refused — a working year-end close the date rule broke.
    const h = harness("2027-01-10");
    const fy = await h.ok("fiscalYear.create", { body: { code: "FY26", name: "FY26", start_date: "2026-01-01", end_date: "2026-12-31" } });
    const p12 = await h.ok("fiscalPeriod.create", {
      body: { fiscal_year_id: fy["id"], period_number: 12, name: "2026-12", start_date: "2026-12-01", end_date: "2026-12-31" },
    });
    const p13 = await h.ok("fiscalPeriod.create", {
      body: { fiscal_year_id: fy["id"], period_number: 13, name: "2026-ADJ", start_date: "2026-12-31", end_date: "2026-12-31", is_adjustment: true },
    });
    await h.ok("fiscalPeriod.close", { params: { id: String(p12["id"]) } });
    const post = async (number: string, date: string, period: unknown): Promise<HandlerOutput> => {
      const je = await h.ok("journalEntry.create", {
        body: { entry_number: number, entry_date: date, source: "manual", ...(period !== undefined ? { fiscal_period_id: period } : {}) },
      });
      for (const [debit, credit] of [["10.00", "0.00"], ["0.00", "10.00"]]) {
        await h.ok("journalLine.create", {
          body: { journal_entry_id: je["id"], ledger_account_id: ACCOUNT, currency: "USD", debit, credit, functional_debit: debit, functional_credit: credit },
        });
      }
      return h.call("journalEntry.post", { params: { id: String(je["id"]) } });
    };
    const status = (out: HandlerOutput): number => (out.kind === "json" ? out.status : 0);
    expect(status(await post("ADJ-1", "2026-12-31", p13["id"]))).toBe(200);
    // Controls: naming nothing, and naming the adjustment period for a date it does not cover.
    expect(status(await post("ADJ-2", "2026-12-31", undefined))).toBe(422);
    expect(status(await post("ADJ-3", "2026-12-15", p13["id"]))).toBe(422);
    // And a closed adjustment period refuses on its own status.
    await h.ok("fiscalPeriod.close", { params: { id: String(p13["id"]) } });
    expect(status(await post("ADJ-4", "2026-12-31", p13["id"]))).toBe(422);
  });

  it("a calendar with no dates gets no date rule, rather than a filter the typed store refuses", async () => {
    // A tenant's own manifest may declare `FiscalPeriod` without `start_date`/`end_date`. The typed
    // store refuses a filter on a column it does not have, so resolving by date there refused every
    // posting the deployment made. The wrapper stands in for that store's refusal.
    const stripped = {
      ...manifest,
      entities: (manifest.entities ?? []).map((e) =>
        e.name === "FiscalPeriod" ? { ...e, fields: e.fields.filter((f) => f.name !== "start_date" && f.name !== "end_date") } : e,
      ),
    };
    const store = new InMemoryEntityStore();
    const listPage = store.listPage.bind(store);
    store.listPage = async (tenant, entity, query) => {
      if (entity === "FiscalPeriod" && (query.filters ?? []).some((f) => f.field === "start_date" || f.field === "end_date")) {
        throw new Error("filter on a column this entity does not have");
      }
      return listPage(tenant, entity, query);
    };
    const server = compileOperateServer(stripped, { store, principalRoles: (p) => ({ primaryRole: p?.grantedScopes[0] ?? "anonymous" }) });
    const run = async (opId: string, params: Record<string, string>, body: Record<string, unknown> | null) => {
      const spec = server.routeSpecs.find((s) => s.operationId === opId)!;
      const request = buildIncomingRequest({
        id: "req_h13000000003", receivedAt: "2026-06-03T12:00:00.000Z", method: spec.method, path: "/v1/x", headers: {},
        host: "api.example.com", scheme: "https", bodyBytes: null, clientIp: "203.0.113.1", edgeTrust: "untrusted",
      });
      const out = await server.handlers.resolve(opId)!({ request, route: routeFromSpec(spec), principal: principal("erp_admin"), params, parsedBody: body });
      return out.kind === "json" ? { status: out.status, body: out.body as Record<string, unknown> } : { status: 0, body: {} };
    };
    const inv = await run("invoice.create", {}, {
      account_id: ACCOUNT, currency: "USD", subtotal: "10.00", tax_total: "0.00", total: "10.00", issue_date: "2026-06-15", due_date: "2026-07-15",
    });
    expect((await run("invoice.send", { id: String(inv.body["id"]) }, null)).status).toBe(200);
  });

  it("a reversal goes into today's period, not its original's", async () => {
    const h = harness();
    const ids = await periods(h, [
      { name: "2026-05", start: "2026-05-01", end: "2026-05-31" },
      { name: "2026-06", start: "2026-06-01", end: "2026-06-30" },
    ]);
    const bill = await h.ok("bill.create", {
      body: { vendor_id: ACCOUNT, bill_date: "2026-06-15", due_date: "2026-07-15", subtotal: "20.00", tax_total: "0.00", total: "20.00" },
    });
    await h.ok("bill.approve", { params: { id: String(bill["id"]) } });
    await h.ok("bill.void", { params: { id: String(bill["id"]) } });
    const [rev] = await entryByNumberSuffix(h, "-VOID");
    expect(rev?.["fiscal_period_id"]).toBe(ids.get("2026-06"));
  });
});

describe("the unrealized FX revaluation reverses itself and posts once per period", () => {
  async function fxSetup(h: Harness): Promise<{ periodId: string; rateId: string }> {
    const usd = await h.ok("currency.create", { body: { code: "USD", name: "US Dollar", decimal_places: 2 } });
    const eur = await h.ok("currency.create", { body: { code: "EUR", name: "Euro", decimal_places: 2 } });
    await h.ok("exchangeRate.create", { body: { from_currency_id: eur["id"], to_currency_id: usd["id"], rate_date: "2026-06-01", rate: "1.1000000000" } });
    const end = await h.ok("exchangeRate.create", { body: { from_currency_id: eur["id"], to_currency_id: usd["id"], rate_date: "2026-06-30", rate: "1.2000000000" } });
    const inv = await invoice(h, [{ net: "100.00" }], { currency: "EUR", issue_date: "2026-06-05" });
    await h.ok("invoice.send", { params: { id: inv } });
    const ids = await periods(h, [{ name: "2026-06", start: "2026-06-01", end: "2026-06-30" }]);
    return { periodId: ids.get("2026-06")!, rateId: String(end["id"]) };
  }

  async function unrealizedIn(h: Harness, fromDate: string, toDate: string): Promise<number> {
    const entries = (await h.entries()).filter((e) => String(e["entry_date"]) >= fromDate && String(e["entry_date"]) <= toDate);
    let total = 0;
    for (const e of entries) {
      for (const l of await linesOf(h, String(e["id"]))) {
        // Functional amounts: a revaluation moves what a foreign balance is worth in the base currency
        // and no transaction amount (ADR-0429's open question, closed with H-11).
        if (l["ledger_account_id"] === "unrealized_fx_gain_loss") {
          total += cents(l["functional_debit"]) - cents(l["functional_credit"]);
        }
      }
    }
    return total / 100;
  }

  it("a close posts the revaluation and its reversal on the next period's first day", async () => {
    const h = harness();
    const { periodId } = await fxSetup(h);
    await h.ok("fiscalPeriod.close", { params: { id: periodId } });
    expect((await h.entries()).map((e) => [e["entry_number"], e["entry_date"]]).filter(([n]) => String(n).includes("FX"))).toEqual([
      ["2026-06-FXREVAL", "2026-06-30"],
      ["2026-06-FXREVALR", "2026-07-01"],
    ]);
    expect(await unrealizedIn(h, "2026-06-01", "2026-06-30")).toBe(-10);
    expect(await unrealizedIn(h, "2026-07-01", "2026-07-31")).toBe(10);
  });

  it("reopening and re-closing revalues the period once", async () => {
    const h = harness();
    const { periodId } = await fxSetup(h);
    for (const op of ["fiscalPeriod.close", "fiscalPeriod.reopen", "fiscalPeriod.close"]) {
      await h.ok(op, { params: { id: periodId } });
    }
    expect((await h.entries()).filter((e) => String(e["entry_number"]).includes("FXREVAL")).length).toBe(2);
    expect(await unrealizedIn(h, "2026-06-01", "2026-06-30")).toBe(-10);
  });

  it("a re-close after the rate moved posts only the difference, and reverses it", async () => {
    const h = harness();
    const { periodId, rateId } = await fxSetup(h);
    await h.ok("fiscalPeriod.close", { params: { id: periodId } });
    await h.ok("fiscalPeriod.reopen", { params: { id: periodId } });
    await h.store.update(TENANT, "ExchangeRate", rateId, { rate: "1.3000000000" });
    await h.ok("fiscalPeriod.close", { params: { id: periodId } });
    expect((await entryByNumberSuffix(h, "-FXREVAL2")).length).toBe(1);
    expect(await unrealizedIn(h, "2026-06-01", "2026-06-30")).toBe(-20);
    expect(await unrealizedIn(h, "2026-07-01", "2026-07-31")).toBe(20);
  });

  it("a close whose reversal would fall into a closed next period is refused, and the period stays open", async () => {
    const h = harness();
    const { periodId } = await fxSetup(h);
    await periods(h, [{ name: "2026-07", start: "2026-07-01", end: "2026-07-31", status: "closed" }]);
    const out = await h.call("fiscalPeriod.close", { params: { id: periodId } });
    expect(out.kind === "json" ? [out.status, (out.body as { error: string }).error] : null).toEqual([422, "period_locked"]);
    expect((await h.store.get(TENANT, "FiscalPeriod", periodId))?.["status"]).toBe("open");
    expect((await h.entries()).filter((e) => String(e["entry_number"]).startsWith("2026-06-FXREVAL"))).toEqual([]);
  });

  it("refuses before writing anything, not only once the close rolls back", async () => {
    // The assertion above holds on any transactional store whatever the effect's order. This one
    // watches the writes, so it holds only if the reversal's period is resolved before the first.
    const h = harness();
    const { periodId } = await fxSetup(h);
    await periods(h, [{ name: "2026-07", start: "2026-07-01", end: "2026-07-31", status: "closed" }]);
    const written: string[] = [];
    const create = h.store.create.bind(h.store);
    h.store.create = async (tenant, entity, record) => {
      if (entity === "JournalEntry") written.push(String(record["entry_number"]));
      return create(tenant, entity, record);
    };
    const out = await h.call("fiscalPeriod.close", { params: { id: periodId } });
    expect(out.kind === "json" ? out.status : 0).toBe(422);
    expect(written).toEqual([]);
  });
});

describe("a closed fiscal period reopens only by its named transition", () => {
  const errorOf = (out: HandlerOutput): [number, string] =>
    out.kind === "json" ? [out.status, (out.body as { error: string }).error] : [0, ""];

  it("refuses PATCHing a closed period open, and reopens it through `reopen`", async () => {
    const h = harness();
    const ids = await periods(h, [{ name: "2026-06", start: "2026-06-01", end: "2026-06-30", status: "closed" }]);
    const id = ids.get("2026-06")!;
    expect(errorOf(await h.call("fiscalPeriod.update", { params: { id }, body: { status: "open" } }))).toEqual([
      422,
      "lifecycle_state_not_writable",
    ]);
    expect((await h.store.get(TENANT, "FiscalPeriod", id))?.["status"]).toBe("closed");
    await h.ok("fiscalPeriod.reopen", { params: { id } });
    expect((await h.store.get(TENANT, "FiscalPeriod", id))?.["status"]).toBe("open");
  });

  it("refuses moving a closed period's dates, which would reopen its postings by another name", async () => {
    const h = harness();
    const ids = await periods(h, [{ name: "2026-06", start: "2026-06-01", end: "2026-06-30", status: "closed" }]);
    const id = ids.get("2026-06")!;
    const out = await h.call("fiscalPeriod.update", { params: { id }, body: { end_date: "2026-06-15" } });
    expect(errorOf(out)).toEqual([422, "fiscal_period_locked"]);
    expect(out.kind === "json" ? String((out.body as { detail: string }).detail) : "").toContain("reopen it instead");
    expect(errorOf(await h.call("fiscalPeriod.delete", { params: { id } }))).toEqual([422, "fiscal_period_locked"]);
    // An open period is still an ordinary record.
    await h.ok("fiscalPeriod.reopen", { params: { id } });
    await h.ok("fiscalPeriod.update", { params: { id }, body: { end_date: "2026-06-29" } });
  });

  it("lets nothing leave a locked period", async () => {
    const h = harness();
    const ids = await periods(h, [{ name: "2026-06", start: "2026-06-01", end: "2026-06-30", status: "locked" }]);
    const id = ids.get("2026-06")!;
    expect(errorOf(await h.call("fiscalPeriod.reopen", { params: { id } }))[0]).toBe(409);
    expect(errorOf(await h.call("fiscalPeriod.update", { params: { id }, body: { name: "x" } }))).toEqual([
      422,
      "fiscal_period_locked",
    ]);
    expect((await h.store.get(TENANT, "FiscalPeriod", id))?.["status"]).toBe("locked");
  });

  it("refuses creating a period already closed", async () => {
    const h = harness();
    const fy = await h.ok("fiscalYear.create", { body: { code: "FY27", name: "FY27", start_date: "2027-01-01", end_date: "2027-12-31" } });
    const out = await h.call("fiscalPeriod.create", {
      body: { fiscal_year_id: fy["id"], period_number: 1, name: "2027-01", start_date: "2027-01-01", end_date: "2027-01-31", status: "closed" },
    });
    expect(errorOf(out)).toEqual([422, "lifecycle_state_not_initial"]);
  });
});

describe("credit notes in aging", () => {
  it("a full credit nets its original to nothing, and an unpaired credit note is a negative balance", async () => {
    const h = harness();
    const inv = await invoice(h, [{ net: "80.00" }]);
    await h.ok("invoice.send", { params: { id: inv } });
    await h.ok("invoice.void", { params: { id: inv } });
    expect((await agingAr(h)).totalOpen).toBe(0);
    // A credit note whose original is not void (here, hand-written) stands as a credit.
    await h.store.create(TENANT, "Invoice", {
      account_id: ACCOUNT, currency: "USD", subtotal: 30, tax_total: 0, total: 30, state: "sent",
      document_type: "credit_note", invoice_number: "CN-X", issue_date: "2026-06-15", due_date: "2026-06-15",
    });
    const ar = await agingAr(h);
    expect(ar.totalOpen).toBe(-30);
    expect(ar.documents.map((d) => [d.number, d.open])).toEqual([["CN-X", -30]]);
  });
});
