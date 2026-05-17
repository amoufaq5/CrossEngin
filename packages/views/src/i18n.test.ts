import { describe, expect, it } from "vitest";
import {
  BCP47Schema,
  directionFor,
  formatCurrency,
  formatNumber,
  I18nBundleSchema,
  I18nContextSchema,
  IanaTimezoneSchema,
  Iso4217CurrencySchema,
} from "./i18n.js";

describe("BCP47Schema", () => {
  it("accepts language-only and language-region", () => {
    expect(() => BCP47Schema.parse("en")).not.toThrow();
    expect(() => BCP47Schema.parse("ar")).not.toThrow();
    expect(() => BCP47Schema.parse("en-US")).not.toThrow();
    expect(() => BCP47Schema.parse("ar-AE")).not.toThrow();
  });

  it("rejects malformed locales", () => {
    expect(() => BCP47Schema.parse("english")).toThrow();
    expect(() => BCP47Schema.parse("en_US")).toThrow();
  });
});

describe("Iso4217CurrencySchema / IanaTimezoneSchema", () => {
  it("accepts 3-letter currencies", () => {
    expect(() => Iso4217CurrencySchema.parse("AED")).not.toThrow();
    expect(() => Iso4217CurrencySchema.parse("USD")).not.toThrow();
  });

  it("rejects malformed currencies", () => {
    expect(() => Iso4217CurrencySchema.parse("usd")).toThrow();
    expect(() => Iso4217CurrencySchema.parse("dollar")).toThrow();
  });

  it("accepts UTC and IANA zones", () => {
    expect(() => IanaTimezoneSchema.parse("UTC")).not.toThrow();
    expect(() => IanaTimezoneSchema.parse("Asia/Dubai")).not.toThrow();
    expect(() => IanaTimezoneSchema.parse("America/New_York")).not.toThrow();
  });
});

describe("I18nContextSchema", () => {
  it("parses a minimal Arabic RTL context", () => {
    const c = I18nContextSchema.parse({
      locale: "ar",
      direction: "rtl",
      currency: "AED",
      timezone: "Asia/Dubai",
    });
    expect(c.firstDayOfWeek).toBe(1);
    expect(c.dateFormat).toBe("locale");
  });

  it("rejects firstDayOfWeek out of [0,6]", () => {
    expect(() =>
      I18nContextSchema.parse({
        locale: "en",
        direction: "ltr",
        currency: "USD",
        timezone: "UTC",
        firstDayOfWeek: 7,
      }),
    ).toThrow();
  });
});

describe("directionFor", () => {
  it("returns rtl for Arabic, Hebrew, Persian", () => {
    expect(directionFor("ar")).toBe("rtl");
    expect(directionFor("he")).toBe("rtl");
    expect(directionFor("fa-IR")).toBe("rtl");
  });

  it("returns ltr for English, French, Spanish", () => {
    expect(directionFor("en")).toBe("ltr");
    expect(directionFor("fr")).toBe("ltr");
    expect(directionFor("es-MX")).toBe("ltr");
  });
});

describe("I18nBundleSchema", () => {
  it("accepts a bundle with consistent keys across locales", () => {
    expect(() =>
      I18nBundleSchema.parse({
        en: { hello: "Hello", bye: "Goodbye" },
        ar: { hello: "مرحبا", bye: "وداعا" },
      }),
    ).not.toThrow();
  });

  it("rejects a locale missing a key present in another", () => {
    expect(() =>
      I18nBundleSchema.parse({
        en: { hello: "Hello", bye: "Goodbye" },
        ar: { hello: "مرحبا" },
      }),
    ).toThrow(/missing key 'bye'/);
  });
});

describe("formatNumber / formatCurrency", () => {
  it("formats numbers via Intl", () => {
    const formatted = formatNumber(1234.5, { locale: "en-US", minimumFractionDigits: 1 });
    expect(formatted).toMatch(/1,234\.5/);
  });

  it("formats currency using the I18nContext currency", () => {
    const ctx = I18nContextSchema.parse({
      locale: "en-US",
      direction: "ltr",
      currency: "USD",
      timezone: "UTC",
    });
    const formatted = formatCurrency(99.5, ctx);
    expect(formatted).toContain("$");
    expect(formatted).toContain("99.5");
  });
});
