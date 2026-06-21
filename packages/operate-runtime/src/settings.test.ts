import { describe, expect, it } from "vitest";
import type { SequenceDefault } from "@crossengin/types/meta-schema";

import {
  EMPTY_TENANT_SETTINGS,
  InMemorySettingsStore,
  sequenceSpecResolver,
  TenantSettingsSchema,
} from "./settings.js";

describe("TenantSettingsSchema", () => {
  it("accepts a full settings document", () => {
    const parsed = TenantSettingsSchema.parse({
      company: { name: "Acme", country: "US" },
      defaults: { currency: "USD", fiscalYearStartMonth: 1 },
      numbering: { "erp.invoice": { format: "INV-{SEQ:5}", start: 100, resetPeriod: "yearly" } },
    });
    expect(parsed.company?.name).toBe("Acme");
    expect(parsed.numbering?.["erp.invoice"]?.start).toBe(100);
  });

  it("rejects unknown keys and bad values", () => {
    expect(TenantSettingsSchema.safeParse({ bogus: true }).success).toBe(false);
    expect(TenantSettingsSchema.safeParse({ defaults: { currency: "USDX" } }).success).toBe(false);
    expect(TenantSettingsSchema.safeParse({ defaults: { fiscalYearStartMonth: 13 } }).success).toBe(false);
  });

  it("accepts finance, feature, and richer default settings", () => {
    const parsed = TenantSettingsSchema.parse({
      defaults: { dateFormat: "DD/MM/YYYY", numberFormat: "1.234,56", weekStartDay: 1 },
      finance: {
        accountingStandard: "ifrs",
        multiCurrencyEnabled: true,
        pricesIncludeTax: false,
        defaultPaymentTermsDays: 30,
        rounding: "half_even",
        defaultTaxJurisdiction: "AE-VAT",
        arAccountCode: "1100",
        revenueAccountCode: "4000",
        apAccountCode: "2000",
        expenseAccountCode: "5000",
      },
      features: { approvals_inbox: true, beta_reports: false },
    });
    expect(parsed.finance?.accountingStandard).toBe("ifrs");
    expect(parsed.finance?.arAccountCode).toBe("1100");
    expect(parsed.finance?.revenueAccountCode).toBe("4000");
    expect(parsed.features?.approvals_inbox).toBe(true);
    expect(parsed.defaults?.weekStartDay).toBe(1);
  });

  it("rejects invalid finance/feature/default values", () => {
    expect(TenantSettingsSchema.safeParse({ finance: { accountingStandard: "gaap_xx" } }).success).toBe(false);
    expect(TenantSettingsSchema.safeParse({ finance: { defaultPaymentTermsDays: -1 } }).success).toBe(false);
    expect(TenantSettingsSchema.safeParse({ defaults: { dateFormat: "bogus" } }).success).toBe(false);
    expect(TenantSettingsSchema.safeParse({ features: { f1: "yes" } }).success).toBe(false);
  });
});

describe("InMemorySettingsStore", () => {
  it("returns empty settings for an unknown tenant", async () => {
    const store = new InMemorySettingsStore();
    expect(await store.get("t1")).toEqual(EMPTY_TENANT_SETTINGS);
  });

  it("round-trips a put", async () => {
    const store = new InMemorySettingsStore();
    await store.put("t1", { company: { name: "Acme" } });
    expect((await store.get("t1")).company?.name).toBe("Acme");
  });

  it("isolates tenants", async () => {
    const store = new InMemorySettingsStore();
    await store.put("t1", { company: { name: "Acme" } });
    expect(await store.get("t2")).toEqual(EMPTY_TENANT_SETTINGS);
  });
});

describe("sequenceSpecResolver", () => {
  const spec: SequenceDefault = {
    kind: "sequence",
    sequence: "erp.invoice",
    format: "INV-{SEQ:6}",
    resetPeriod: "never",
  };

  it("returns the spec unchanged when there is no override", () => {
    const resolve = sequenceSpecResolver({});
    expect(resolve(spec)).toEqual(spec);
  });

  it("overlays a matching numbering override", () => {
    const resolve = sequenceSpecResolver({
      numbering: { "erp.invoice": { format: "INV/{YYYY}/{SEQ:4}", start: 500, resetPeriod: "yearly" } },
    });
    expect(resolve(spec)).toEqual({
      kind: "sequence",
      sequence: "erp.invoice",
      format: "INV/{YYYY}/{SEQ:4}",
      start: 500,
      resetPeriod: "yearly",
    });
  });

  it("ignores an override for a different sequence", () => {
    const resolve = sequenceSpecResolver({ numbering: { "erp.bill": { format: "B-{SEQ}" } } });
    expect(resolve(spec)).toEqual(spec);
  });
});
