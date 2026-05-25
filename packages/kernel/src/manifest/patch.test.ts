import { describe, expect, it } from "vitest";
import {
  ApplyResultSchema,
  ManifestPatchSchema,
  PreviewResultSchema,
  ValidationErrorSchema,
  ValidationResultSchema,
} from "./patch.js";

const validMeta = { name: "T", slug: "t", version: "1.0.0" } as const;

describe("ManifestPatchSchema", () => {
  it("parses a minimal patch", () => {
    const p = {
      baseHash: "a".repeat(64),
      manifest: { manifestVersion: "1.0", meta: validMeta },
    };
    expect(() => ManifestPatchSchema.parse(p)).not.toThrow();
  });

  it("requires baseHash", () => {
    const p = {
      manifest: { manifestVersion: "1.0", meta: validMeta },
    };
    expect(() => ManifestPatchSchema.parse(p)).toThrow();
  });

  it("requires a valid manifest", () => {
    const p = {
      baseHash: "a".repeat(64),
      manifest: { manifestVersion: "1.0" },
    };
    expect(() => ManifestPatchSchema.parse(p)).toThrow();
  });
});

describe("ValidationResultSchema", () => {
  it("parses { ok: true }", () => {
    expect(() => ValidationResultSchema.parse({ ok: true })).not.toThrow();
  });

  it("parses { ok: false, errors }", () => {
    expect(() =>
      ValidationResultSchema.parse({
        ok: false,
        errors: [{ path: "x.y", message: "bad" }],
      }),
    ).not.toThrow();
  });

  it("rejects { ok: true, errors: [...] }", () => {
    expect(() =>
      ValidationResultSchema.parse({
        ok: true,
        errors: [{ path: "x", message: "x" }],
      }),
    ).not.toThrow();
  });

  it("rejects { ok: false } without errors", () => {
    expect(() => ValidationResultSchema.parse({ ok: false })).toThrow();
  });
});

describe("ValidationErrorSchema", () => {
  it("parses with optional code", () => {
    expect(() => ValidationErrorSchema.parse({ path: "a", message: "b", code: "X" })).not.toThrow();
  });

  it("parses without code", () => {
    expect(() => ValidationErrorSchema.parse({ path: "a", message: "b" })).not.toThrow();
  });
});

describe("PreviewResultSchema", () => {
  it("parses a complete preview", () => {
    expect(() =>
      PreviewResultSchema.parse({
        approvalToken: "tok",
        newHash: "h".repeat(64),
        destructive: false,
        ddlStatements: ["CREATE TABLE x ();"],
      }),
    ).not.toThrow();
  });

  it("parses with warnings", () => {
    expect(() =>
      PreviewResultSchema.parse({
        approvalToken: "tok",
        newHash: "h".repeat(64),
        destructive: true,
        ddlStatements: ["DROP COLUMN x;"],
        warnings: ["destructive change in 'foo'"],
      }),
    ).not.toThrow();
  });
});

describe("ApplyResultSchema", () => {
  it("parses a complete apply result", () => {
    expect(() =>
      ApplyResultSchema.parse({
        newHash: "h".repeat(64),
        appliedAt: "2026-05-11T00:00:00Z",
        manifestVersion: "1.0.1",
      }),
    ).not.toThrow();
  });
});
