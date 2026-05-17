import { describe, expect, it } from "vitest";
import {
  directionForConfigLocale,
  isRtlLocale,
  resolveSupportedLocales,
  TenantI18nConfigSchema,
} from "./tenant-config.js";

describe("TenantI18nConfigSchema", () => {
  it("applies defaults for top-level fields", () => {
    const c = TenantI18nConfigSchema.parse({
      translations: { en: { hello: "Hello" } },
    });
    expect(c.defaultLocale).toBe("en");
    expect(c.currency).toBe("USD");
    expect(c.timezone).toBe("UTC");
    expect(c.firstDayOfWeek).toBe(1);
    expect(c.weekendDays).toEqual([0, 6]);
  });

  it("parses the ADR-0022 prescription example", () => {
    const c = TenantI18nConfigSchema.parse({
      defaultLocale: "en",
      supportedLocales: ["en", "ar", "ar-AE"],
      currency: "AED",
      alternativeCurrencies: ["USD", "EUR"],
      timezone: "Asia/Dubai",
      firstDayOfWeek: 6,
      weekendDays: [5, 6],
      translations: {
        en: {
          "actions.verify": "Verify",
          "validations.quantity.range": "Quantity must be between {min} and {max}",
        },
        ar: {
          "actions.verify": "تحقق",
          "validations.quantity.range": "يجب أن تكون الكمية بين {min} و {max}",
        },
        "ar-AE": {
          "actions.verify": "تحقق",
          "validations.quantity.range": "يجب أن تكون الكمية بين {min} و {max}",
        },
      },
    });
    expect(c.timezone).toBe("Asia/Dubai");
    expect(c.weekendDays).toEqual([5, 6]);
  });

  it("rejects defaultLocale not in supportedLocales", () => {
    expect(() =>
      TenantI18nConfigSchema.parse({
        defaultLocale: "fr",
        supportedLocales: ["en", "ar"],
        translations: { en: { hello: "Hello" }, ar: { hello: "مرحبا" } },
      }),
    ).toThrow(/must appear in supportedLocales/);
  });

  it("rejects translations missing the default locale", () => {
    expect(() =>
      TenantI18nConfigSchema.parse({
        defaultLocale: "en",
        translations: { ar: { hello: "مرحبا" } },
      }),
    ).toThrow(/must include the default locale 'en'/);
  });

  it("rejects supportedLocale missing a translation bundle", () => {
    expect(() =>
      TenantI18nConfigSchema.parse({
        defaultLocale: "en",
        supportedLocales: ["en", "fr"],
        translations: { en: { hello: "Hello" } },
      }),
    ).toThrow(/has no translation bundle/);
  });

  it("rejects duplicate weekend days", () => {
    expect(() =>
      TenantI18nConfigSchema.parse({
        translations: { en: { hello: "Hello" } },
        weekendDays: [5, 5],
      }),
    ).toThrow(/must not contain duplicates/);
  });
});

describe("resolveSupportedLocales", () => {
  it("returns supportedLocales when explicit", () => {
    const c = TenantI18nConfigSchema.parse({
      supportedLocales: ["en", "ar"],
      translations: { en: { x: "X" }, ar: { x: "س" } },
    });
    expect(resolveSupportedLocales(c)).toEqual(["en", "ar"]);
  });

  it("falls back to translation keys when supportedLocales is empty", () => {
    const c = TenantI18nConfigSchema.parse({
      translations: { en: { hello: "Hi" } },
    });
    expect(resolveSupportedLocales(c)).toEqual(["en"]);
  });
});

describe("isRtlLocale / directionForConfigLocale", () => {
  const c = TenantI18nConfigSchema.parse({
    translations: { en: { hello: "Hello" }, ar: { hello: "مرحبا" } },
  });

  it("falls back to default RTL set when rtlLocales not declared", () => {
    expect(isRtlLocale(c, "ar")).toBe(true);
    expect(isRtlLocale(c, "en")).toBe(false);
  });

  it("honors explicit rtlLocales when declared", () => {
    const cWithRtl = TenantI18nConfigSchema.parse({
      rtlLocales: ["en"],
      translations: { en: { hello: "Hi" }, ar: { hello: "مرحبا" } },
    });
    expect(isRtlLocale(cWithRtl, "en")).toBe(true);
    expect(isRtlLocale(cWithRtl, "ar")).toBe(false);
  });

  it("directionForConfigLocale returns ltr or rtl", () => {
    expect(directionForConfigLocale(c, "ar")).toBe("rtl");
    expect(directionForConfigLocale(c, "en")).toBe("ltr");
  });
});
