import { describe, expect, it } from "vitest";
import { negotiateAcceptLanguage, resolveLocale } from "./resolution.js";

describe("resolveLocale", () => {
  const supported = ["en", "ar", "ar-AE"] as const;

  it("picks userPreference when it is supported", () => {
    const r = resolveLocale({
      userPreference: "ar-AE",
      tenantDefault: "en",
      supportedLocales: supported,
    });
    expect(r).toEqual({ locale: "ar-AE", source: "user_preference" });
  });

  it("language-matches userPreference when the exact region isn't supported", () => {
    const r = resolveLocale({
      userPreference: "ar-SA",
      tenantDefault: "en",
      supportedLocales: supported,
    });
    expect(r.locale).toMatch(/^ar(-AE)?$/);
    expect(r.source).toBe("user_preference");
  });

  it("falls through to tenantDefault when no user preference", () => {
    const r = resolveLocale({ tenantDefault: "ar", supportedLocales: supported });
    expect(r).toEqual({ locale: "ar", source: "tenant_default" });
  });

  it("negotiates Accept-Language when nothing earlier matches", () => {
    const r = resolveLocale({
      acceptLanguage: "ar-AE,en;q=0.5",
      supportedLocales: supported,
    });
    expect(r).toEqual({ locale: "ar-AE", source: "accept_language" });
  });

  it("falls back to 'en' when nothing matches", () => {
    const r = resolveLocale({
      acceptLanguage: "ja-JP",
      supportedLocales: supported,
    });
    expect(r).toEqual({ locale: "en", source: "fallback" });
  });

  it("uses an explicit fallback when supplied", () => {
    const r = resolveLocale({
      supportedLocales: supported,
      fallback: "ar",
    });
    expect(r).toEqual({ locale: "ar", source: "fallback" });
  });
});

describe("negotiateAcceptLanguage", () => {
  const supported = ["en", "ar", "ar-AE", "fr"] as const;

  it("prefers higher-q entries", () => {
    expect(negotiateAcceptLanguage("fr;q=0.5, en;q=0.9, ar;q=0.1", supported)).toBe("en");
  });

  it("returns null when nothing matches", () => {
    expect(negotiateAcceptLanguage("zh-CN, ja-JP", supported)).toBeNull();
  });

  it("language-matches when exact-region isn't supported", () => {
    expect(negotiateAcceptLanguage("ar-SA", supported)).toMatch(/^ar(-AE)?$/);
  });

  it("ignores '*' tokens", () => {
    expect(negotiateAcceptLanguage("*", supported)).toBeNull();
  });
});
