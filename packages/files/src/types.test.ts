import { describe, expect, it } from "vitest";
import {
  canTransition,
  FILE_STATUS_TRANSITIONS,
  FILE_STATUSES,
  FileReferenceSchema,
} from "./types.js";

const baseRef = {
  id: "f_1",
  tenantId: "t_1",
  storageKey: "t_t_1/prescriptions/2026/05/f_1.pdf",
  filename: "rx.pdf",
  mimeType: "application/pdf",
  sizeBytes: 12345,
  checksumSha256: "a".repeat(64),
  status: "available" as const,
  uploadedBy: "u_1",
  uploadedAt: "2026-05-13T10:00:00.000Z",
  scannedAt: "2026-05-13T10:00:30.000Z",
  retentionClass: "phi-7y",
  dataClass: "phi" as const,
  fileTypeId: "prescriptionScan",
  region: "eu-central",
};

describe("FileReferenceSchema", () => {
  it("parses a fully populated reference", () => {
    expect(() => FileReferenceSchema.parse(baseRef)).not.toThrow();
  });

  it("applies defaults for nullable + metadata fields", () => {
    const r = FileReferenceSchema.parse({
      ...baseRef,
      status: "uploading",
      scannedAt: null,
    });
    expect(r.metadata).toEqual({});
    expect(r.ocrStatus).toBeNull();
    expect(r.embeddingStatus).toBeNull();
  });

  it("rejects a malformed sha256", () => {
    expect(() => FileReferenceSchema.parse({ ...baseRef, checksumSha256: "tooshort" })).toThrow();
  });

  it("rejects archiveAfter > deleteAfter", () => {
    expect(() =>
      FileReferenceSchema.parse({
        ...baseRef,
        archiveAfter: "2030-01-01T00:00:00.000Z",
        deleteAfter: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow(/archiveAfter must be <= deleteAfter/);
  });

  it("requires scannedAt when status is available", () => {
    expect(() =>
      FileReferenceSchema.parse({ ...baseRef, status: "available", scannedAt: null }),
    ).toThrow(/'available' status must have scannedAt set/);
  });

  it("rejects negative sizeBytes", () => {
    expect(() => FileReferenceSchema.parse({ ...baseRef, sizeBytes: -1 })).toThrow();
  });

  it("FILE_STATUSES has six values", () => {
    expect(FILE_STATUSES).toHaveLength(6);
  });
});

describe("canTransition", () => {
  it("allows uploading → scanning", () => {
    expect(canTransition("uploading", "scanning")).toBe(true);
  });

  it("allows scanning → available + scanning → quarantined", () => {
    expect(canTransition("scanning", "available")).toBe(true);
    expect(canTransition("scanning", "quarantined")).toBe(true);
  });

  it("forbids skipping the scan step", () => {
    expect(canTransition("uploading", "available")).toBe(false);
  });

  it("forbids leaving the deleting state", () => {
    for (const target of FILE_STATUSES) {
      expect(canTransition("deleting", target)).toBe(false);
    }
  });

  it("forbids reviving a quarantined file to available", () => {
    expect(canTransition("quarantined", "available")).toBe(false);
  });

  it("transitions table is exhaustive", () => {
    for (const s of FILE_STATUSES) {
      expect(FILE_STATUS_TRANSITIONS[s]).toBeDefined();
    }
  });
});
