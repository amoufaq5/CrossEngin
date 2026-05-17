import { describe, expect, it } from "vitest";
import {
  BCP47Schema,
  directionFor,
  IanaTimezoneSchema,
  Iso4217CurrencySchema,
  languageOf,
  LOCALE_REGISTRY,
  localeRecord,
  regionOf,
  RTL_LOCALES,
  SUPPORTED_LOCALES_ROADMAP,
  SUPPORTED_LOCALES_V1,
} from "./locales.js";

describe("BCP47Schema", () => {
  it("accepts language only and language-region", () => {
    expect(() => BCP47Schema.parse("en")).not.toThrow();
    expect(() => BCP47Schema.parse("ar-AE")).not.toThrow();
    expect(() => BCP47Schema.parse("ar-SA")).not.toThrow();
  });

  it("rejects malformed locales", () => {
    expect(() => BCP47Schema.parse("english")).toThrow();
    expect(() => BCP47Schema.parse("en_US")).toThrow();
    expect(() => BCP47Schema.parse("EN")).toThrow();
  });
});

describe("Iso4217CurrencySchema / IanaTimezoneSchema", () => {
  it("accepts 3-letter currencies", () => {
    expect(() => Iso4217CurrencySchema.parse("AED")).not.toThrow();
  });

  it("rejects lowercase currency", () => {
    expect(() => Iso4217CurrencySchema.parse("usd")).toThrow();
  });

  it("accepts UTC and IANA paths", () => {
    expect(() => IanaTimezoneSchema.parse("UTC")).not.toThrow();
    expect(() => IanaTimezoneSchema.parse("Asia/Dubai")).not.toThrow();
  });
});

describe("directionFor", () => {
  it("returns rtl for Arabic, Hebrew, Persian, Urdu", () => {
    expect(directionFor("ar")).toBe("rtl");
    expect(directionFor("ar-AE")).toBe("rtl");
    expect(directionFor("he")).toBe("rtl");
    expect(directionFor("fa")).toBe("rtl");
    expect(directionFor("ur")).toBe("rtl");
  });

  it("returns ltr for English, French, German, Spanish", () => {
    expect(directionFor("en")).toBe("ltr");
    expect(directionFor("fr")).toBe("ltr");
    expect(directionFor("de")).toBe("ltr");
  });
});

describe("languageOf / regionOf", () => {
  it("splits BCP-47 into language + region", () => {
    expect(languageOf("ar-AE")).toBe("ar");
    expect(regionOf("ar-AE")).toBe("AE");
    expect(languageOf("en")).toBe("en");
    expect(regionOf("en")).toBeNull();
  });
});

describe("locale registry constants", () => {
  it("SUPPORTED_LOCALES_V1 ships en + ar + ar-AE", () => {
    expect(SUPPORTED_LOCALES_V1).toEqual(["en", "ar", "ar-AE"]);
  });

  it("SUPPORTED_LOCALES_ROADMAP includes EU + ME languages", () => {
    expect(SUPPORTED_LOCALES_ROADMAP).toContain("fr");
    expect(SUPPORTED_LOCALES_ROADMAP).toContain("de");
    expect(SUPPORTED_LOCALES_ROADMAP).toContain("ar-SA");
  });

  it("LOCALE_REGISTRY has every roadmap locale", () => {
    for (const loc of SUPPORTED_LOCALES_ROADMAP) {
      expect(localeRecord(loc)).not.toBeNull();
    }
  });

  it("localeRecord returns null for an unknown locale", () => {
    expect(localeRecord("zz")).toBeNull();
  });

  it("LOCALE_REGISTRY direction matches RTL_LOCALES membership", () => {
    for (const r of LOCALE_REGISTRY) {
      const lang = languageOf(r.locale);
      if (RTL_LOCALES.has(lang)) {
        expect(r.direction).toBe("rtl");
      } else {
        expect(r.direction).toBe("ltr");
      }
    }
  });
});
