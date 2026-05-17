import { describe, expect, it } from "vitest";
import {
  FAMILIES,
  FAMILY_DEFAULT_BRAND_COLORS,
  FAMILY_DEFAULT_VOICE,
  resolveTheme,
  ThemeOverlaySchema,
} from "./theme.js";

describe("ThemeOverlaySchema", () => {
  it("parses brandColor + accentColor as hex", () => {
    const t = ThemeOverlaySchema.parse({
      brandColor: "#1e6f3f",
      accentColor: "#a8c39a",
    });
    expect(t.brandColor).toBe("#1e6f3f");
  });

  it("accepts #RGB shorthand and #RRGGBBAA forms", () => {
    expect(() => ThemeOverlaySchema.parse({ brandColor: "#abc" })).not.toThrow();
    expect(() =>
      ThemeOverlaySchema.parse({ brandColor: "#11223380" }),
    ).not.toThrow();
  });

  it("rejects non-hex brand colors", () => {
    expect(() => ThemeOverlaySchema.parse({ brandColor: "green" })).toThrow();
  });

  it("rejects identical brand + accent colors", () => {
    expect(() =>
      ThemeOverlaySchema.parse({ brandColor: "#abc", accentColor: "#abc" }),
    ).toThrow(/brandColor and accentColor must differ/);
  });

  it("accepts a dark-mode subtheme", () => {
    expect(() =>
      ThemeOverlaySchema.parse({
        brandColor: "#1e6f3f",
        darkMode: { brandColor: "#a8c39a" },
      }),
    ).not.toThrow();
  });
});

describe("FAMILY_DEFAULT_BRAND_COLORS", () => {
  it("declares a brand color for every family", () => {
    for (const f of FAMILIES) {
      expect(FAMILY_DEFAULT_BRAND_COLORS[f]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("FAMILY_DEFAULT_VOICE maps each family to a voice", () => {
    for (const f of FAMILIES) {
      expect(FAMILY_DEFAULT_VOICE[f]).toBeDefined();
    }
  });
});

describe("resolveTheme", () => {
  it("returns base when no overlays", () => {
    const t = resolveTheme({ brandColor: "#000000" });
    expect(t.brandColor).toBe("#000000");
  });

  it("layers later overlays over earlier (last wins)", () => {
    const t = resolveTheme(
      { brandColor: "#aaaaaa", accentColor: "#cccccc" },
      { brandColor: "#bbbbbb" },
    );
    expect(t.brandColor).toBe("#bbbbbb");
    expect(t.accentColor).toBe("#cccccc");
  });

  it("ignores undefined fields in overlays", () => {
    const t = resolveTheme({ brandColor: "#000000" }, { accentColor: undefined });
    expect(t.brandColor).toBe("#000000");
  });
});
