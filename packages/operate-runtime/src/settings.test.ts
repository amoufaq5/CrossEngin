import { describe, expect, it } from "vitest";
import type { SequenceDefault } from "@crossengin/types/meta-schema";

import {
  EMPTY_TENANT_SETTINGS,
  FINANCE_ACCOUNT_CODE_KEYS,
  financeAccountCodeIsSet,
  financeAccountCodesOf,
  FinanceSettingsSchema,
  InMemorySettingsStore,
  mergeUnsetFinanceAccountCodes,
  functionalCurrencyOf,
  sequenceSpecResolver,
  TAX_REMITTANCE_POSTING_MODES,
  taxRemittancePostingMode,
  TenantSettingsSchema,
  type FinanceAccountCodeKey,
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
        cashAccountCode: "1000",
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

  it("accepts the two depreciation account codes and bounds them like every other code", () => {
    const parsed = TenantSettingsSchema.parse({
      finance: { depreciationExpenseAccountCode: "6100", accumulatedDepreciationAccountCode: "1590" },
    });
    expect(parsed.finance?.depreciationExpenseAccountCode).toBe("6100");
    expect(parsed.finance?.accumulatedDepreciationAccountCode).toBe("1590");
    expect(
      TenantSettingsSchema.safeParse({ finance: { depreciationExpenseAccountCode: "x".repeat(33) } }).success,
    ).toBe(false);
  });

  it("accepts an optional auditSampling policy and stays valid without one", () => {
    const withSampling = TenantSettingsSchema.parse({
      auditSampling: { outcomes: ["deny", "error"], operations: ["product.list"], sampleRate: 0.25 },
    });
    expect(withSampling.auditSampling?.sampleRate).toBe(0.25);
    expect(withSampling.auditSampling?.outcomes).toEqual(["deny", "error"]);

    const withoutSampling = TenantSettingsSchema.parse({ company: { name: "Acme" } });
    expect(withoutSampling.auditSampling).toBeUndefined();
  });

  it("rejects an invalid auditSampling policy", () => {
    expect(TenantSettingsSchema.safeParse({ auditSampling: { sampleRate: 2 } }).success).toBe(false);
    expect(TenantSettingsSchema.safeParse({ auditSampling: { bogus: true } }).success).toBe(false);
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

describe("NotificationSettingsSchema", () => {
  it("accepts a full quiet-hours + digest policy", () => {
    const parsed = TenantSettingsSchema.parse({
      notifications: {
        quietHours: {
          startTime: "22:00",
          endTime: "07:00",
          timezone: "Asia/Dubai",
          behavior: "batch_until_morning",
          bypassCategories: ["security_alert"],
        },
        digest: { frequency: "hourly", maxItems: 25 },
      },
    });
    expect(parsed.notifications?.quietHours?.behavior).toBe("batch_until_morning");
    expect(parsed.notifications?.digest?.maxItems).toBe(25);
  });

  it("accepts an absent notifications section", () => {
    expect(TenantSettingsSchema.parse({}).notifications).toBeUndefined();
  });

  it("rejects a malformed time, an unknown behavior, and an unknown key", () => {
    const base = { startTime: "22:00", endTime: "07:00", timezone: "UTC", behavior: "deliver_anyway" };
    expect(
      TenantSettingsSchema.safeParse({ notifications: { quietHours: { ...base, startTime: "25:00" } } }).success,
    ).toBe(false);
    expect(
      TenantSettingsSchema.safeParse({ notifications: { quietHours: { ...base, behavior: "nap" } } }).success,
    ).toBe(false);
    expect(
      TenantSettingsSchema.safeParse({ notifications: { quietHours: { ...base, bogus: 1 } } }).success,
    ).toBe(false);
  });

  it("rejects an out-of-range digest maxItems and an unknown frequency", () => {
    expect(TenantSettingsSchema.safeParse({ notifications: { digest: { maxItems: 0 } } }).success).toBe(false);
    expect(TenantSettingsSchema.safeParse({ notifications: { digest: { maxItems: 1001 } } }).success).toBe(false);
    expect(TenantSettingsSchema.safeParse({ notifications: { digest: { frequency: "yearly" } } }).success).toBe(false);
  });
});

describe("FINANCE_ACCOUNT_CODE_KEYS", () => {
  it("is exactly the finance settings ending AccountCode, read off the schema's shape", () => {
    const shapeKeys = Object.keys(FinanceSettingsSchema.shape);
    expect([...FINANCE_ACCOUNT_CODE_KEYS].sort()).toEqual(shapeKeys.filter((k) => k.endsWith("AccountCode")).sort());
    expect(FINANCE_ACCOUNT_CODE_KEYS).toHaveLength(18);
    expect(new Set(FINANCE_ACCOUNT_CODE_KEYS).size).toBe(18);
  });

  it("includes the withholding-tax-payable code", () => {
    expect(FINANCE_ACCOUNT_CODE_KEYS).toContain("whtPayableAccountCode");
  });

  it("leaves out the finance settings that name no account", () => {
    for (const key of ["accountingStandard", "rounding", "defaultTaxJurisdiction", "defaultPaymentTermsDays"]) {
      expect(FINANCE_ACCOUNT_CODE_KEYS).not.toContain(key);
    }
  });

  it("names only keys that accept a 32-character account code and refuse a 33-character one", () => {
    for (const key of FINANCE_ACCOUNT_CODE_KEYS) {
      expect(FinanceSettingsSchema.safeParse({ [key]: "x".repeat(32) }).success).toBe(true);
      expect(FinanceSettingsSchema.safeParse({ [key]: "x".repeat(33) }).success).toBe(false);
    }
  });
});

describe("financeAccountCodeIsSet", () => {
  it("is true only for a string with something other than whitespace", () => {
    expect(financeAccountCodeIsSet("1100")).toBe(true);
    expect(financeAccountCodeIsSet(" AR ")).toBe(true);
    expect(financeAccountCodeIsSet("")).toBe(false);
    expect(financeAccountCodeIsSet("   ")).toBe(false);
    expect(financeAccountCodeIsSet("\t\n")).toBe(false);
    expect(financeAccountCodeIsSet(undefined)).toBe(false);
    expect(financeAccountCodeIsSet(null)).toBe(false);
    expect(financeAccountCodeIsSet(1100)).toBe(false);
  });
});

describe("financeAccountCodesOf", () => {
  it("returns the set account codes and omits blank ones and other finance settings", () => {
    const settings = TenantSettingsSchema.parse({
      finance: { arAccountCode: "1100", apAccountCode: "", cashAccountCode: "  ", rounding: "half_even" },
    });
    expect(financeAccountCodesOf(settings)).toEqual({ arAccountCode: "1100" });
  });

  it("is empty for a document with no finance section", () => {
    expect(financeAccountCodesOf(EMPTY_TENANT_SETTINGS)).toEqual({});
    expect(financeAccountCodesOf(TenantSettingsSchema.parse({ company: { name: "Acme" } }))).toEqual({});
  });
});

describe("mergeUnsetFinanceAccountCodes", () => {
  it("fills only the keys that are unset and says which", () => {
    const settings = TenantSettingsSchema.parse({ finance: { arAccountCode: "AR-1", rounding: "half_even" } });
    const out = mergeUnsetFinanceAccountCodes(settings, { arAccountCode: "1100", apAccountCode: "2000" });
    expect(out.filled).toEqual(["apAccountCode"]);
    expect(out.settings.finance).toEqual({ arAccountCode: "AR-1", rounding: "half_even", apAccountCode: "2000" });
  });

  it("answers every code in effect afterwards: the admin's and the filled ones", () => {
    const settings = TenantSettingsSchema.parse({ finance: { arAccountCode: "AR-1", taxPayableAccountCode: "" } });
    const out = mergeUnsetFinanceAccountCodes(settings, { arAccountCode: "1100", apAccountCode: "2000" });
    expect(out.inEffect).toEqual({ arAccountCode: "AR-1", apAccountCode: "2000" });
  });

  it("answers what is in effect even when it fills nothing", () => {
    const settings = TenantSettingsSchema.parse({ finance: { arAccountCode: "AR-1" } });
    expect(mergeUnsetFinanceAccountCodes(settings, {}).inEffect).toEqual({ arAccountCode: "AR-1" });
    expect(mergeUnsetFinanceAccountCodes(EMPTY_TENANT_SETTINGS, {}).inEffect).toEqual({});
  });

  it.each(["", "   "])("treats a blank stored code (%j) as unset and fills it", (blank) => {
    const settings = TenantSettingsSchema.parse({ finance: { arAccountCode: blank } });
    const out = mergeUnsetFinanceAccountCodes(settings, { arAccountCode: "1100" });
    expect(out.filled).toEqual(["arAccountCode"]);
    expect(out.settings.finance?.arAccountCode).toBe("1100");
    expect(out.inEffect).toEqual({ arAccountCode: "1100" });
  });

  it("keeps every other section of the document", () => {
    const settings = TenantSettingsSchema.parse({ company: { name: "Acme" }, defaults: { currency: "EUR" } });
    const out = mergeUnsetFinanceAccountCodes(settings, { cashAccountCode: "1000" });
    expect(out.settings.company?.name).toBe("Acme");
    expect(out.settings.defaults?.currency).toBe("EUR");
    expect(out.settings.finance?.cashAccountCode).toBe("1000");
  });

  it("returns the same object when nothing was filled", () => {
    const settings = TenantSettingsSchema.parse({ finance: { arAccountCode: "AR-1" } });
    const out = mergeUnsetFinanceAccountCodes(settings, { arAccountCode: "1100" });
    expect(out.filled).toEqual([]);
    expect(out.settings).toBe(settings);
    expect(mergeUnsetFinanceAccountCodes(EMPTY_TENANT_SETTINGS, {}).settings).toBe(EMPTY_TENANT_SETTINGS);
  });

  it("returns a document the settings contract accepts", () => {
    const codes = Object.fromEntries(FINANCE_ACCOUNT_CODE_KEYS.map((k, i) => [k, String(1000 + i)]));
    const out = mergeUnsetFinanceAccountCodes(EMPTY_TENANT_SETTINGS, codes);
    expect(out.filled).toHaveLength(18);
    expect(Object.keys(out.inEffect)).toHaveLength(18);
    expect(TenantSettingsSchema.safeParse(out.settings).success).toBe(true);
  });

  it("ignores an undefined code and a key that is not an account-code setting", () => {
    const codes = {
      arAccountCode: undefined,
      rounding: "half_up",
      notASetting: "9999",
    } as unknown as Partial<Record<FinanceAccountCodeKey, string>>;
    const out = mergeUnsetFinanceAccountCodes(EMPTY_TENANT_SETTINGS, codes);
    expect(out.filled).toEqual([]);
    expect(out.settings).toBe(EMPTY_TENANT_SETTINGS);
  });

  it("refuses a code the contract does not accept rather than storing it", () => {
    expect(() => mergeUnsetFinanceAccountCodes(EMPTY_TENANT_SETTINGS, { arAccountCode: "x".repeat(33) })).toThrow();
  });

  it("does not mutate the document it was given", () => {
    const settings = TenantSettingsSchema.parse({ finance: { rounding: "half_even" } });
    mergeUnsetFinanceAccountCodes(settings, { arAccountCode: "1100" });
    expect(settings.finance).toEqual({ rounding: "half_even" });
  });
});

describe("InMemorySettingsStore.fillUnsetFinanceAccountCodes", () => {
  it("fills unset keys on an untouched tenant, stores them and answers what is in effect", async () => {
    const store = new InMemorySettingsStore();
    expect(await store.fillUnsetFinanceAccountCodes("t1", { arAccountCode: "1100" })).toEqual({
      filled: ["arAccountCode"],
      inEffect: { arAccountCode: "1100" },
    });
    expect((await store.get("t1")).finance?.arAccountCode).toBe("1100");
  });

  it("never replaces a code already set, and reports it as in effect", async () => {
    const store = new InMemorySettingsStore();
    await store.put("t1", { finance: { arAccountCode: "AR-1" } });
    expect(await store.fillUnsetFinanceAccountCodes("t1", { arAccountCode: "1100" })).toEqual({
      filled: [],
      inEffect: { arAccountCode: "AR-1" },
    });
    expect((await store.get("t1")).finance?.arAccountCode).toBe("AR-1");
  });

  it("fills over a blank stored code", async () => {
    const store = new InMemorySettingsStore();
    await store.put("t1", { finance: { arAccountCode: "  " } });
    const out = await store.fillUnsetFinanceAccountCodes("t1", { arAccountCode: "1100" });
    expect(out.filled).toEqual(["arAccountCode"]);
    expect((await store.get("t1")).finance?.arAccountCode).toBe("1100");
  });

  it("writes nothing for a tenant when nothing is filled, and isolates tenants", async () => {
    const store = new InMemorySettingsStore();
    expect(await store.fillUnsetFinanceAccountCodes("t1", {})).toEqual({ filled: [], inEffect: {} });
    expect(await store.get("t1")).toEqual(EMPTY_TENANT_SETTINGS);
    await store.fillUnsetFinanceAccountCodes("t1", { apAccountCode: "2000" });
    expect(await store.get("t2")).toEqual(EMPTY_TENANT_SETTINGS);
  });
});

describe("the tax remittance posting mode", () => {
  it("is one of two modes, read from finance settings, and absent means manual_journal", () => {
    expect(TAX_REMITTANCE_POSTING_MODES).toEqual(["manual_journal", "on_mark_paid"]);
    expect(taxRemittancePostingMode(undefined)).toBe("manual_journal");
    expect(taxRemittancePostingMode({})).toBe("manual_journal");
    expect(taxRemittancePostingMode({ taxRemittancePosting: "manual_journal" })).toBe("manual_journal");
    expect(taxRemittancePostingMode({ taxRemittancePosting: "on_mark_paid" })).toBe("on_mark_paid");
  });

  it("is accepted by the schema and refused out of the enum", () => {
    expect(FinanceSettingsSchema.safeParse({ taxRemittancePosting: "on_mark_paid" }).success).toBe(true);
    expect(FinanceSettingsSchema.safeParse({ taxRemittancePosting: "always" }).success).toBe(false);
  });

  it("is not an account-code setting, so the starter chart need name no account for it", () => {
    expect(FINANCE_ACCOUNT_CODE_KEYS).not.toContain("taxRemittancePosting");
  });

  it("reads the functional currency from defaults, upper-cased, blank as none", () => {
    expect(functionalCurrencyOf({ defaults: { currency: "usd" } })).toBe("USD");
    expect(functionalCurrencyOf({ defaults: { currency: "   " } })).toBeNull();
    expect(functionalCurrencyOf(EMPTY_TENANT_SETTINGS)).toBeNull();
  });
});

describe("mergeUnsetFinanceAccountCodes and the remittance posting mode", () => {
  const withCurrency = TenantSettingsSchema.parse({ defaults: { currency: "USD" } });

  it("fills a requested mode where it is unset and the tenant declares a currency", () => {
    const out = mergeUnsetFinanceAccountCodes(withCurrency, { cashAccountCode: "1000", taxRemittancePosting: "on_mark_paid" });
    expect(out.filled).toEqual(["cashAccountCode", "taxRemittancePosting"]);
    expect(out.settings.finance?.taxRemittancePosting).toBe("on_mark_paid");
    // The mode is not an account code, so it never appears among the codes in effect.
    expect(out.inEffect).toEqual({ cashAccountCode: "1000" });
  });

  it("fills the mode alone, so a store writes the row for it when every code is already set", () => {
    const out = mergeUnsetFinanceAccountCodes(withCurrency, { taxRemittancePosting: "on_mark_paid" });
    expect(out.filled).toEqual(["taxRemittancePosting"]);
    expect(out.settings).not.toBe(withCurrency);
  });

  it("never replaces a mode an admin chose", () => {
    const settings = TenantSettingsSchema.parse({ defaults: { currency: "USD" }, finance: { taxRemittancePosting: "manual_journal" } });
    const out = mergeUnsetFinanceAccountCodes(settings, { taxRemittancePosting: "on_mark_paid" });
    expect(out.filled).toEqual([]);
    expect(out.settings).toBe(settings);
  });

  it("leaves the mode unset for a tenant with no currency", () => {
    const out = mergeUnsetFinanceAccountCodes(EMPTY_TENANT_SETTINGS, { taxRemittancePosting: "on_mark_paid" });
    expect(out.filled).toEqual([]);
    expect(out.settings.finance?.taxRemittancePosting).toBeUndefined();
  });

  it("writes nothing about the mode when none is requested", () => {
    const out = mergeUnsetFinanceAccountCodes(withCurrency, { cashAccountCode: "1000" });
    expect(out.settings.finance?.taxRemittancePosting).toBeUndefined();
  });

  it("stores a filled mode through the in-memory filler", async () => {
    const store = new InMemorySettingsStore();
    await store.put("t1", { defaults: { currency: "EUR" }, finance: { cashAccountCode: "1000" } });
    const out = await store.fillUnsetFinanceAccountCodes("t1", { cashAccountCode: "9", taxRemittancePosting: "on_mark_paid" });
    expect(out).toEqual({ filled: ["taxRemittancePosting"], inEffect: { cashAccountCode: "1000" } });
    expect((await store.get("t1")).finance).toEqual({ cashAccountCode: "1000", taxRemittancePosting: "on_mark_paid" });
  });
});
