import { describe, expect, it } from "vitest";
import { manifestForTheme, WebAppManifestSchema } from "./manifest.js";

const goodIcons = [
  { src: "/icons/192.png", sizes: "192x192", type: "image/png", purpose: "any" as const },
  { src: "/icons/512.png", sizes: "512x512", type: "image/png", purpose: "maskable" as const },
];

const baseManifest = {
  name: "CrossEngin",
  short_name: "CrossEng",
  description: "Tenant operations platform",
  theme_color: "#1e6f3f",
  background_color: "#ffffff",
  icons: goodIcons,
};

describe("WebAppManifestSchema", () => {
  it("parses a typical CrossEngin PWA manifest", () => {
    const m = WebAppManifestSchema.parse(baseManifest);
    expect(m.display).toBe("standalone");
    expect(m.scope).toBe("/");
  });

  it("requires icons at 192x192 and 512x512", () => {
    expect(() =>
      WebAppManifestSchema.parse({
        ...baseManifest,
        icons: [{ src: "/icons/64.png", sizes: "64x64", type: "image/png", purpose: "any" }],
      }),
    ).toThrow(/must include an icon at '192x192'/);
  });

  it("accepts an 'any' SVG icon as covering all required sizes", () => {
    expect(() =>
      WebAppManifestSchema.parse({
        ...baseManifest,
        icons: [{ src: "/icons/app.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
      }),
    ).not.toThrow();
  });

  it("rejects 'any' on a non-SVG icon", () => {
    expect(() =>
      WebAppManifestSchema.parse({
        ...baseManifest,
        icons: [{ src: "/icons/app.png", sizes: "any", type: "image/png", purpose: "any" }],
      }),
    ).toThrow(/'any' is only valid for SVG/);
  });

  it("rejects scope without trailing slash", () => {
    expect(() =>
      WebAppManifestSchema.parse({ ...baseManifest, scope: "/app" }),
    ).toThrow(/scope must end with '\//);
  });

  it("rejects start_url outside scope", () => {
    expect(() =>
      WebAppManifestSchema.parse({
        ...baseManifest,
        scope: "/app/",
        start_url: "/dashboard",
      }),
    ).toThrow(/must be within scope/);
  });

  it("rejects prefer_related_applications=true without related_applications", () => {
    expect(() =>
      WebAppManifestSchema.parse({
        ...baseManifest,
        prefer_related_applications: true,
      }),
    ).toThrow(/requires at least one related_applications/);
  });

  it("rejects non-hex theme color", () => {
    expect(() =>
      WebAppManifestSchema.parse({ ...baseManifest, theme_color: "green" }),
    ).toThrow();
  });
});

describe("manifestForTheme", () => {
  it("produces a valid manifest from minimal input", () => {
    const m = manifestForTheme({
      name: "CrossEngin",
      themeColor: "#1e6f3f",
      backgroundColor: "#ffffff",
      lang: "en",
      dir: "ltr",
      icons: goodIcons,
    });
    expect(m.theme_color).toBe("#1e6f3f");
    expect(m.lang).toBe("en");
  });

  it("supports RTL Arabic", () => {
    const m = manifestForTheme({
      name: "كروس إنجن",
      themeColor: "#1e6f3f",
      backgroundColor: "#ffffff",
      lang: "ar",
      dir: "rtl",
      icons: goodIcons,
    });
    expect(m.dir).toBe("rtl");
    expect(m.lang).toBe("ar");
  });
});
