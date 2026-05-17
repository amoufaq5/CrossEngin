import { describe, expect, it } from "vitest";
import {
  buildStorageKey,
  BUCKET_PER_REGION,
  parseStorageKey,
  SignedUrlRequestSchema,
  SignedUrlResponseSchema,
  STORAGE_REGIONS,
  StorageRegionSchema,
} from "./storage.js";

describe("buildStorageKey", () => {
  const uploadedAt = new Date(Date.UTC(2026, 4, 13));

  it("produces canonical t_<tenant>/<prefix>/YYYY/MM/<id>.<ext>", () => {
    const key = buildStorageKey({
      tenantId: "1",
      prefix: "prescriptions/",
      fileId: "f_1",
      extension: "pdf",
      uploadedAt,
    });
    expect(key).toBe("t_1/prescriptions/2026/05/f_1.pdf");
  });

  it("supports nested prefixes", () => {
    const key = buildStorageKey({
      tenantId: "abc",
      prefix: "qa/batch-records/",
      fileId: "f_2",
      uploadedAt,
    });
    expect(key).toBe("t_abc/qa/batch-records/2026/05/f_2");
  });

  it("handles a leading dot on the extension", () => {
    const key = buildStorageKey({
      tenantId: "1",
      prefix: "x/",
      fileId: "f",
      extension: ".pdf",
      uploadedAt,
    });
    expect(key.endsWith(".pdf")).toBe(true);
  });

  it("rejects bad tenant id", () => {
    expect(() =>
      buildStorageKey({
        tenantId: "tenant/with/slash",
        prefix: "x/",
        fileId: "f",
        uploadedAt,
      }),
    ).toThrow();
  });

  it("rejects bad prefix (missing trailing slash)", () => {
    expect(() =>
      buildStorageKey({
        tenantId: "1",
        prefix: "no-slash",
        fileId: "f",
        uploadedAt,
      }),
    ).toThrow();
  });

  it("rejects uppercase in prefix", () => {
    expect(() =>
      buildStorageKey({
        tenantId: "1",
        prefix: "Upper/",
        fileId: "f",
        uploadedAt,
      }),
    ).toThrow();
  });
});

describe("parseStorageKey", () => {
  it("round-trips with buildStorageKey", () => {
    const uploadedAt = new Date(Date.UTC(2027, 0, 15));
    const key = buildStorageKey({
      tenantId: "abc",
      prefix: "prescriptions/",
      fileId: "f_42",
      extension: "pdf",
      uploadedAt,
    });
    const parsed = parseStorageKey(key);
    expect(parsed).toEqual({
      tenantId: "abc",
      prefix: "prescriptions/",
      year: 2027,
      month: 1,
      fileId: "f_42",
      extension: "pdf",
    });
  });

  it("parses keys with no extension", () => {
    const parsed = parseStorageKey("t_x/x/2026/05/f");
    expect(parsed?.extension).toBeNull();
  });

  it("returns null for malformed keys", () => {
    expect(parseStorageKey("not a key")).toBeNull();
    expect(parseStorageKey("t_x/foo/abcd/05/f.pdf")).toBeNull();
  });
});

describe("BUCKET_PER_REGION", () => {
  it("covers every STORAGE_REGIONS entry", () => {
    for (const r of STORAGE_REGIONS) {
      expect(BUCKET_PER_REGION[r]).toBeDefined();
    }
  });

  it("eu-central → crossengin-files-eu", () => {
    expect(BUCKET_PER_REGION["eu-central"]).toBe("crossengin-files-eu");
  });

  it("StorageRegionSchema rejects unknown regions", () => {
    expect(() => StorageRegionSchema.parse("antarctica")).toThrow();
  });
});

describe("SignedUrlRequestSchema / SignedUrlResponseSchema", () => {
  it("parses an upload request", () => {
    const r = SignedUrlRequestSchema.parse({
      fileId: "f_1",
      operation: "upload",
      expiresIn: "PT15M",
      requestedBy: "u_1",
      requestedAt: "2026-05-13T10:00:00.000Z",
    });
    expect(r.operation).toBe("upload");
  });

  it("rejects unknown operation", () => {
    expect(() =>
      SignedUrlRequestSchema.parse({
        fileId: "f",
        operation: "view",
        expiresIn: "PT5M",
        requestedBy: "u",
        requestedAt: "2026-05-13T10:00:00.000Z",
      }),
    ).toThrow();
  });

  it("parses a response", () => {
    const r = SignedUrlResponseSchema.parse({
      url: "https://r2.example.com/abc?signature=xyz",
      method: "PUT",
      headers: {},
      expiresAt: "2026-05-13T10:15:00.000Z",
      fileId: "f_1",
      operation: "upload",
    });
    expect(r.method).toBe("PUT");
  });
});
