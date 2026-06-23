import { describe, expect, it } from "vitest";

import { computeWhtReconciliation } from "./wht-reconciliation.js";

describe("computeWhtReconciliation", () => {
  const invoices = [
    { id: "i1", invoice_number: "INV-1", currency: "USD", withholding_total: 100 },
    { id: "i2", invoice_number: "INV-2", currency: "USD", withholding_total: 50 },
    { id: "i3", invoice_number: "INV-3", currency: "EUR", withholding_total: 30 },
    { id: "i4", invoice_number: "INV-4", currency: "USD", withholding_total: 0 }, // excluded
    { id: "i5", invoice_number: "INV-5", currency: "USD" }, // no withholding → excluded
  ];

  it("classifies certified / partial / uncertified and sums totals", () => {
    const certified = new Map([
      ["i1", 100], // fully certified
      ["i2", 20], // partial
      // i3 → uncertified
    ]);
    const r = computeWhtReconciliation({ invoices, certifiedByInvoice: certified });
    expect(r.totals).toEqual({ withheld: 180, certified: 120, uncertified: 60 });
    const byId = new Map(r.rows.map((row) => [row.invoiceId, row]));
    expect(byId.get("i1")).toMatchObject({ withheld: 100, certified: 100, gap: 0, status: "certified" });
    expect(byId.get("i2")).toMatchObject({ withheld: 50, certified: 20, gap: 30, status: "partial" });
    expect(byId.get("i3")).toMatchObject({ withheld: 30, certified: 0, gap: 30, status: "uncertified" });
  });

  it("excludes invoices with no positive withholding", () => {
    const r = computeWhtReconciliation({ invoices, certifiedByInvoice: new Map() });
    expect(r.rows.map((row) => row.invoiceId).sort()).toEqual(["i1", "i2", "i3"]);
  });

  it("orders rows by the largest open gap first", () => {
    const r = computeWhtReconciliation({ invoices, certifiedByInvoice: new Map([["i1", 100]]) });
    // i2 (gap 50) and i3 (gap 30) outrank the certified i1 (gap 0).
    expect(r.rows.map((row) => row.invoiceId)).toEqual(["i2", "i3", "i1"]);
  });

  it("treats over-certification as fully certified (no negative gap surfaced as open)", () => {
    const r = computeWhtReconciliation({
      invoices: [{ id: "x", invoice_number: "INV-X", currency: "USD", withholding_total: 40 }],
      certifiedByInvoice: new Map([["x", 50]]),
    });
    expect(r.rows[0]).toMatchObject({ gap: -10, status: "certified" });
    expect(r.totals).toEqual({ withheld: 40, certified: 50, uncertified: -10 });
  });
});
