import { describe, expect, it } from "vitest";
import { computeTax, rateFor, STATUTORY_TAX_RATES, TaxAddressSchema } from "./tax.js";

const aeAddress = TaxAddressSchema.parse({
  line1: "Sheikh Zayed Rd",
  city: "Dubai",
  country: "AE",
});

const deAddress = TaxAddressSchema.parse({
  line1: "Friedrichstr 1",
  city: "Berlin",
  country: "DE",
});

const usAddress = TaxAddressSchema.parse({
  line1: "1 Market St",
  city: "San Francisco",
  region: "CA",
  country: "US",
});

describe("TaxAddressSchema", () => {
  it("accepts a minimal address", () => {
    expect(() =>
      TaxAddressSchema.parse({ line1: "x", city: "x", country: "AE" }),
    ).not.toThrow();
  });

  it("rejects malformed country code", () => {
    expect(() =>
      TaxAddressSchema.parse({ line1: "x", city: "x", country: "uae" }),
    ).toThrow();
  });
});

describe("rateFor", () => {
  it("returns AE VAT 5%", () => {
    const r = rateFor(aeAddress);
    expect(r.ratePercent).toBe(5);
    expect(r.kind).toBe("vat");
  });

  it("returns SA VAT 15%", () => {
    const r = rateFor(TaxAddressSchema.parse({ line1: "x", city: "Riyadh", country: "SA" }));
    expect(r.ratePercent).toBe(15);
  });

  it("returns no tax for KW and QA", () => {
    const kw = rateFor(TaxAddressSchema.parse({ line1: "x", city: "Kuwait City", country: "KW" }));
    expect(kw.kind).toBe("none");
    const qa = rateFor(TaxAddressSchema.parse({ line1: "x", city: "Doha", country: "QA" }));
    expect(qa.kind).toBe("none");
  });

  it("EU member states allow reverse-charge B2B", () => {
    expect(rateFor(deAddress).reverseChargeEligible).toBe(true);
  });

  it("falls back to a country entry when region isn't matched", () => {
    expect(rateFor(usAddress).country).toBe("US");
  });
});

describe("computeTax", () => {
  it("computes UAE VAT 5% on a B2B sale (no reverse charge for UAE)", () => {
    const r = computeTax({ subtotalCents: 10_000, address: aeAddress, isB2b: true });
    expect(r.taxCents).toBe(500);
    expect(r.totalCents).toBe(10_500);
    expect(r.reverseCharged).toBe(false);
  });

  it("applies reverse charge for EU B2B with a valid VAT id", () => {
    const r = computeTax({
      subtotalCents: 10_000,
      address: deAddress,
      isB2b: true,
      hasValidVatId: true,
    });
    expect(r.taxCents).toBe(0);
    expect(r.reverseCharged).toBe(true);
  });

  it("charges full VAT for EU B2C", () => {
    const r = computeTax({ subtotalCents: 10_000, address: deAddress, isB2b: false });
    expect(r.taxCents).toBe(1900);
    expect(r.reverseCharged).toBe(false);
  });

  it("rejects negative subtotal", () => {
    expect(() => computeTax({ subtotalCents: -1, address: aeAddress, isB2b: false })).toThrow();
  });

  it("STATUTORY_TAX_RATES covers UAE + GCC + EU + GB + TR + US", () => {
    const countries = new Set(STATUTORY_TAX_RATES.map((r) => r.country));
    expect(countries.has("AE")).toBe(true);
    expect(countries.has("SA")).toBe(true);
    expect(countries.has("DE")).toBe(true);
    expect(countries.has("GB")).toBe(true);
    expect(countries.has("US")).toBe(true);
  });
});
