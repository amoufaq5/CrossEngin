import { describe, expect, it } from "vitest";
import {
  checkBundleConsistency,
  DEFAULT_RENDERER_MISSING_STRATEGY,
  DEFAULT_VALIDATION_MISSING_STRATEGY,
  lookupTranslation,
  mergeBundles,
  TranslationBundleSchema,
} from "./bundle.js";

describe("TranslationBundleSchema", () => {
  it("accepts a consistent bundle", () => {
    expect(() =>
      TranslationBundleSchema.parse({
        en: { hello: "Hello", bye: "Goodbye" },
        ar: { hello: "مرحبا", bye: "وداعا" },
      }),
    ).not.toThrow();
  });

  it("rejects a locale missing a key present in the reference", () => {
    expect(() =>
      TranslationBundleSchema.parse({
        en: { hello: "Hello", bye: "Goodbye" },
        ar: { hello: "مرحبا" },
      }),
    ).toThrow(/missing key 'bye'/);
  });

  it("rejects an invalid ICU message", () => {
    expect(() => TranslationBundleSchema.parse({ en: { hello: "Hello {" } })).toThrow();
  });

  it("rejects a translation key with uppercase", () => {
    expect(() => TranslationBundleSchema.parse({ en: { Hello: "Hi" } })).toThrow();
  });
});

describe("lookupTranslation", () => {
  const bundle = TranslationBundleSchema.parse({
    en: { hello: "Hello", bye: "Goodbye" },
    ar: { hello: "مرحبا", bye: "وداعا" },
  });

  it("returns exact match when present", () => {
    const r = lookupTranslation({ bundle, locale: "ar", key: "hello" });
    expect(r.message).toBe("مرحبا");
    expect(r.fallback).toBe(false);
  });

  it("falls back to default locale under fallback_default strategy", () => {
    const small = TranslationBundleSchema.parse({
      en: { greeting: "Hello", goodbye: "Goodbye" },
      fr: { greeting: "Bonjour", goodbye: "Au revoir" },
    });
    const r = lookupTranslation({
      bundle: small,
      locale: "ar",
      key: "greeting",
      options: { ...DEFAULT_RENDERER_MISSING_STRATEGY, strategy: "fallback_default" },
    });
    expect(r.message).toBe("Hello");
    expect(r.fallback).toBe(true);
    expect(r.resolvedLocale).toBe("en");
  });

  it("returns marker under show_marker strategy", () => {
    const r = lookupTranslation({
      bundle,
      locale: "fr",
      key: "missing.key",
      options: DEFAULT_VALIDATION_MISSING_STRATEGY,
    });
    expect(r.message).toContain("missing.key");
  });

  it("throws under throw strategy", () => {
    expect(() =>
      lookupTranslation({
        bundle,
        locale: "fr",
        key: "missing.key",
        options: { strategy: "throw", defaultLocale: "en" },
      }),
    ).toThrow(/missing translation/);
  });

  it("returns the key under show_key strategy", () => {
    const r = lookupTranslation({
      bundle,
      locale: "fr",
      key: "missing.key",
      options: { strategy: "show_key", defaultLocale: "en" },
    });
    expect(r.message).toBe("missing.key");
  });
});

describe("checkBundleConsistency", () => {
  it("flags placeholder differences", () => {
    const bundle = TranslationBundleSchema.parse({
      en: { greet: "Hello {name}" },
      ar: { greet: "مرحبا {patient}" },
    });
    const issues = checkBundleConsistency(bundle, "en");
    expect(issues).toHaveLength(1);
    if (issues[0] !== undefined) {
      expect(issues[0].locale).toBe("ar");
      expect(issues[0].missing).toContain("name");
      expect(issues[0].extra).toContain("patient");
    }
  });

  it("returns no issues when placeholders match", () => {
    const bundle = TranslationBundleSchema.parse({
      en: { greet: "Hello {name}" },
      ar: { greet: "مرحبا {name}" },
    });
    expect(checkBundleConsistency(bundle, "en")).toEqual([]);
  });
});

describe("mergeBundles", () => {
  it("merges per-locale + per-key with overlay-wins", () => {
    const base = { en: { hello: "Hello", bye: "Goodbye" } };
    const overlay = { en: { hello: "Hi" }, ar: { hello: "مرحبا" } };
    const merged = mergeBundles(base, overlay);
    expect(merged.en?.hello).toBe("Hi");
    expect(merged.en?.bye).toBe("Goodbye");
    expect(merged.ar?.hello).toBe("مرحبا");
  });
});
