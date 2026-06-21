import { describe, expect, it } from "vitest";

import { bucketFor, computeAging, daysBetween } from "./aging.js";

describe("daysBetween", () => {
  it("counts whole UTC days, signed", () => {
    expect(daysBetween("2026-03-31", "2026-03-01")).toBe(30);
    expect(daysBetween("2026-03-01", "2026-03-31")).toBe(-30);
    expect(daysBetween("2026-03-01", "2026-03-01")).toBe(0);
  });
});

describe("bucketFor", () => {
  it("maps days overdue to the right bucket", () => {
    expect(bucketFor(0)).toBe("current");
    expect(bucketFor(-5)).toBe("current");
    expect(bucketFor(15)).toBe("1-30");
    expect(bucketFor(45)).toBe("31-60");
    expect(bucketFor(75)).toBe("61-90");
    expect(bucketFor(120)).toBe("90+");
  });
});

describe("computeAging", () => {
  const asOf = "2026-04-15";
  const docs = [
    { id: "i1", invoice_number: "INV-1", total: 100, due_date: "2026-04-30", currency: "USD" }, // not due → current
    { id: "i2", invoice_number: "INV-2", total: 200, due_date: "2026-04-01", currency: "USD" }, // 14 overdue → 1-30
    { id: "i3", invoice_number: "INV-3", total: 50, due_date: "2026-01-01", currency: "USD" }, // 104 overdue → 90+
    { id: "i4", invoice_number: "INV-4", total: 80, due_date: "2026-04-01", currency: "USD" }, // fully paid → excluded
  ];
  const applied = new Map([["i2", 50], ["i4", 80]]); // i2 partially paid, i4 fully paid

  it("computes open balances, buckets, and totals, excluding settled docs", () => {
    const r = computeAging({ documents: docs, appliedByDocument: applied, asOf, numberField: "invoice_number" });
    expect(r.documents.map((d) => d.id)).toEqual(["i3", "i2", "i1"]); // sorted by daysOverdue desc
    const i2 = r.documents.find((d) => d.id === "i2")!;
    expect(i2.open).toBe(150); // 200 - 50
    expect(i2.bucket).toBe("1-30");
    expect(r.totalsByBucket.current).toBe(100);
    expect(r.totalsByBucket["1-30"]).toBe(150);
    expect(r.totalsByBucket["90+"]).toBe(50);
    expect(r.totalOpen).toBe(300); // 100 + 150 + 50
    expect(r.documents.find((d) => d.id === "i4")).toBeUndefined();
    expect(r.currency).toBe("USD");
  });

  it("treats a document with no due date as current", () => {
    const r = computeAging({ documents: [{ id: "x", total: 10, currency: "USD" }], appliedByDocument: new Map(), asOf, numberField: "id" });
    expect(r.documents[0]?.bucket).toBe("current");
    expect(r.documents[0]?.daysOverdue).toBe(0);
  });

  it("reports a mixed-currency report with null currency", () => {
    const r = computeAging({
      documents: [
        { id: "a", total: 10, currency: "USD", due_date: "2026-04-01" },
        { id: "b", total: 10, currency: "EUR", due_date: "2026-04-01" },
      ],
      appliedByDocument: new Map(),
      asOf,
      numberField: "id",
    });
    expect(r.currency).toBeNull();
    expect(r.totalOpen).toBe(20);
  });
});
