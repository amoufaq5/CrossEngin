import { describe, expect, it } from "vitest";
import { extractPathPrefixSlug, extractSubdomain } from "./extract.js";

describe("extractSubdomain", () => {
  it("extracts a single-level subdomain", () => {
    expect(extractSubdomain("acme-pharma.crossengin.io", "crossengin.io")).toBe("acme-pharma");
  });

  it("accepts subdomain with digits", () => {
    expect(extractSubdomain("acme-2026.crossengin.io", "crossengin.io")).toBe("acme-2026");
  });

  it("accepts subdomain that is digits-and-letters only", () => {
    expect(extractSubdomain("tenant42.crossengin.io", "crossengin.io")).toBe("tenant42");
  });

  it("returns null when host equals base domain", () => {
    expect(extractSubdomain("crossengin.io", "crossengin.io")).toBeNull();
  });

  it("returns null when host does not end with base domain", () => {
    expect(extractSubdomain("acme.example.com", "crossengin.io")).toBeNull();
  });

  it("returns null for multi-level subdomain (v1 limitation)", () => {
    expect(extractSubdomain("eu.acme.crossengin.io", "crossengin.io")).toBeNull();
  });

  it("returns null for leading-dot host", () => {
    expect(extractSubdomain(".crossengin.io", "crossengin.io")).toBeNull();
  });

  it("returns null for subdomain with uppercase letters", () => {
    expect(extractSubdomain("Acme.crossengin.io", "crossengin.io")).toBeNull();
  });

  it("returns null for subdomain with leading hyphen", () => {
    expect(extractSubdomain("-acme.crossengin.io", "crossengin.io")).toBeNull();
  });

  it("returns null for subdomain with underscores", () => {
    expect(extractSubdomain("acme_pharma.crossengin.io", "crossengin.io")).toBeNull();
  });
});

describe("extractPathPrefixSlug", () => {
  it("extracts slug from a normal path", () => {
    expect(extractPathPrefixSlug("/t/acme-pharma/dashboard", "/t")).toBe("acme-pharma");
  });

  it("extracts slug when path ends right after slug", () => {
    expect(extractPathPrefixSlug("/t/acme-pharma", "/t")).toBe("acme-pharma");
  });

  it("returns null for path without prefix", () => {
    expect(extractPathPrefixSlug("/dashboard", "/t")).toBeNull();
  });

  it("returns null when prefix matches but no slug follows", () => {
    expect(extractPathPrefixSlug("/t/", "/t")).toBeNull();
  });

  it("returns null when only the prefix is present (no trailing slash)", () => {
    expect(extractPathPrefixSlug("/t", "/t")).toBeNull();
  });

  it("handles prefix supplied with trailing slash", () => {
    expect(extractPathPrefixSlug("/t/acme/x", "/t/")).toBe("acme");
  });

  it("rejects slug with underscores", () => {
    expect(extractPathPrefixSlug("/t/acme_pharma/x", "/t")).toBeNull();
  });

  it("rejects slug with uppercase letters", () => {
    expect(extractPathPrefixSlug("/t/Acme/x", "/t")).toBeNull();
  });

  it("rejects slug with leading hyphen", () => {
    expect(extractPathPrefixSlug("/t/-acme/x", "/t")).toBeNull();
  });

  it("supports nested path prefix", () => {
    expect(extractPathPrefixSlug("/api/t/acme/x", "/api/t")).toBe("acme");
  });
});
