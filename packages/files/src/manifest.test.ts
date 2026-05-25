import { describe, expect, it } from "vitest";
import { durationToSeconds, FileTypeDeclarationSchema, sizeToBytes } from "./manifest.js";

const baseDecl = {
  allowedMimeTypes: ["application/pdf", "image/jpeg"],
  maxSize: "20MB" as const,
  storage: { bucket: "crossengin-files-eu", prefix: "prescriptions/" },
  dataClass: "phi" as const,
};

describe("FileTypeDeclarationSchema", () => {
  it("parses a minimal declaration with defaults", () => {
    const d = FileTypeDeclarationSchema.parse(baseDecl);
    expect(d.virusScan).toBe(true);
    expect(d.ocr.enabled).toBe(false);
    expect(d.embedding.enabled).toBe(false);
    expect(d.lifecycle).toHaveLength(1);
    expect(d.signedUrl.defaultExpiry).toBe("PT15M");
  });

  it("parses a full HIPAA-style declaration", () => {
    const d = FileTypeDeclarationSchema.parse({
      ...baseDecl,
      label: { en: "Prescription Scan", ar: "وصفة طبية" },
      ocr: { enabled: true, language: "eng+ara" },
      embedding: { enabled: true, scope: "tenant" },
      retention: { minYears: 7, compliancePackOverride: "21-cfr-part-11" },
      lifecycle: [
        { phase: "hot", durationDays: 180 },
        { phase: "archive", tier: "infrequent" },
        { phase: "cold", durationDays: 1825 },
        { phase: "delete" },
      ],
      signedUrl: { defaultExpiry: "PT5M", maxExpiry: "PT1H" },
    });
    expect(d.ocr.language).toBe("eng+ara");
    expect(d.lifecycle).toHaveLength(4);
  });

  it("rejects an invalid mime type", () => {
    expect(() =>
      FileTypeDeclarationSchema.parse({
        ...baseDecl,
        allowedMimeTypes: ["not-a-mime"],
      }),
    ).toThrow();
  });

  it("rejects an invalid size shape", () => {
    expect(() => FileTypeDeclarationSchema.parse({ ...baseDecl, maxSize: "huge" })).toThrow();
  });

  it("rejects defaultExpiry > maxExpiry", () => {
    expect(() =>
      FileTypeDeclarationSchema.parse({
        ...baseDecl,
        signedUrl: { defaultExpiry: "P1D", maxExpiry: "PT5M" },
      }),
    ).toThrow(/defaultExpiry must be <= maxExpiry/);
  });

  it("rejects embedding without ocr", () => {
    expect(() =>
      FileTypeDeclarationSchema.parse({
        ...baseDecl,
        ocr: { enabled: false },
        embedding: { enabled: true },
      }),
    ).toThrow(/embedding requires ocr.enabled=true/);
  });

  it("rejects duplicate lifecycle phases", () => {
    expect(() =>
      FileTypeDeclarationSchema.parse({
        ...baseDecl,
        lifecycle: [
          { phase: "hot", durationDays: 180 },
          { phase: "hot", durationDays: 90 },
        ],
      }),
    ).toThrow(/duplicate lifecycle phase/);
  });

  it("rejects out-of-order lifecycle phases", () => {
    expect(() =>
      FileTypeDeclarationSchema.parse({
        ...baseDecl,
        lifecycle: [
          { phase: "archive", tier: "infrequent" },
          { phase: "hot", durationDays: 180 },
        ],
      }),
    ).toThrow(/lifecycle phases must be declared in order/);
  });

  it("rejects generated-only file types that still claim virusScan", () => {
    expect(() =>
      FileTypeDeclarationSchema.parse({
        ...baseDecl,
        dataClass: "internal",
        generatedOnly: true,
        virusScan: true,
      }),
    ).toThrow(/generated-only file types skip virus scan/);
  });

  it("accepts generated-only with virusScan=false", () => {
    expect(() =>
      FileTypeDeclarationSchema.parse({
        ...baseDecl,
        dataClass: "internal",
        generatedOnly: true,
        virusScan: false,
      }),
    ).not.toThrow();
  });

  it("rejects an unknown OCR language code", () => {
    expect(() =>
      FileTypeDeclarationSchema.parse({
        ...baseDecl,
        ocr: { enabled: true, language: "english" },
      }),
    ).toThrow();
  });
});

describe("sizeToBytes", () => {
  it("converts each unit", () => {
    expect(sizeToBytes("100B")).toBe(100);
    expect(sizeToBytes("1KB")).toBe(1024);
    expect(sizeToBytes("20MB")).toBe(20 * 1024 * 1024);
    expect(sizeToBytes("2GB")).toBe(2 * 1024 * 1024 * 1024);
  });

  it("supports decimal sizes", () => {
    expect(sizeToBytes("1.5MB")).toBe(Math.round(1.5 * 1024 * 1024));
  });
});

describe("durationToSeconds", () => {
  it("converts ISO 8601 durations", () => {
    expect(durationToSeconds("PT15M")).toBe(15 * 60);
    expect(durationToSeconds("PT1H")).toBe(3600);
    expect(durationToSeconds("P1D")).toBe(86_400);
  });
});
