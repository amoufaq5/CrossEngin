import { describe, expect, it } from "vitest";
import {
  EXPORT_FORMATS,
  EXPORT_STATUSES,
  EXPORT_TRIGGERS,
  TenantDataExportSchema,
  canTransitionExport,
  downloadsRemaining,
  isExportDownloadable,
  shouldPurge,
  type TenantDataExport,
} from "./exports.js";

const SHA = "a".repeat(64);

describe("constants", () => {
  it("EXPORT_FORMATS has 5 entries", () => {
    expect(EXPORT_FORMATS).toContain("json");
    expect(EXPORT_FORMATS).toContain("parquet");
    expect(EXPORT_FORMATS).toContain("sql_dump");
  });

  it("EXPORT_STATUSES has 6 entries", () => {
    expect(EXPORT_STATUSES).toContain("ready_for_download");
    expect(EXPORT_STATUSES).toContain("expired");
  });

  it("EXPORT_TRIGGERS has 5 entries", () => {
    expect(EXPORT_TRIGGERS).toContain("customer_request");
    expect(EXPORT_TRIGGERS).toContain("regulatory_subpoena");
    expect(EXPORT_TRIGGERS).toContain("tenant_migration");
  });
});

describe("canTransitionExport", () => {
  it("queued -> running", () => {
    expect(canTransitionExport("queued", "running")).toBe(true);
  });

  it("running -> ready_for_download", () => {
    expect(canTransitionExport("running", "ready_for_download")).toBe(true);
  });

  it("ready_for_download -> delivered", () => {
    expect(canTransitionExport("ready_for_download", "delivered")).toBe(true);
  });

  it("expired is terminal", () => {
    expect(canTransitionExport("expired", "running")).toBe(false);
  });

  it("queued -> ready_for_download is invalid (must run first)", () => {
    expect(canTransitionExport("queued", "ready_for_download")).toBe(false);
  });
});

describe("TenantDataExportSchema", () => {
  const base: TenantDataExport = {
    id: "exp-1",
    tenantId: "t-1",
    trigger: "customer_request",
    requestedAt: "2026-05-14T10:00:00Z",
    requestedBy: "u-1",
    format: "json",
    includesPiiCategories: true,
    includesPhiCategories: false,
    encryptionKeyFingerprint: SHA,
    status: "ready_for_download",
    startedAt: "2026-05-14T10:01:00Z",
    readyAt: "2026-05-14T10:30:00Z",
    deliveredAt: null,
    failedAt: null,
    sizeBytes: 1_000_000,
    rowCount: 10_000,
    sha256: SHA,
    storageUri: "s3://exports/exp-1.json.enc",
    downloadUrlExpiresAt: "2026-05-21T10:30:00Z",
    downloadCount: 0,
    maxDownloads: 3,
    purgedAt: null,
  };

  it("accepts a valid ready export", () => {
    expect(() => TenantDataExportSchema.parse(base)).not.toThrow();
  });

  it("rejects PHI export with customer_request trigger", () => {
    expect(() => TenantDataExportSchema.parse({ ...base, includesPhiCategories: true })).toThrow(
      /PHI exports cannot use trigger='customer_request'/,
    );
  });

  it("accepts PHI export with regulatory_subpoena trigger", () => {
    expect(() =>
      TenantDataExportSchema.parse({
        ...base,
        includesPhiCategories: true,
        trigger: "regulatory_subpoena",
      }),
    ).not.toThrow();
  });

  it("rejects ready_for_download without sha256", () => {
    expect(() => TenantDataExportSchema.parse({ ...base, sha256: null })).toThrow(/sha256/);
  });

  it("rejects download window < 24h", () => {
    expect(() =>
      TenantDataExportSchema.parse({
        ...base,
        downloadUrlExpiresAt: "2026-05-14T20:00:00Z",
      }),
    ).toThrow(/>= 24h/);
  });

  it("rejects download window > 30 days", () => {
    expect(() =>
      TenantDataExportSchema.parse({
        ...base,
        downloadUrlExpiresAt: "2026-07-30T00:00:00Z",
      }),
    ).toThrow(/<= 720h/);
  });

  it("rejects downloadCount > maxDownloads", () => {
    expect(() =>
      TenantDataExportSchema.parse({
        ...base,
        downloadCount: 5,
      }),
    ).toThrow(/must not exceed maxDownloads/);
  });

  it("rejects expired without purgedAt", () => {
    expect(() =>
      TenantDataExportSchema.parse({
        ...base,
        status: "expired",
      }),
    ).toThrow(/purgedAt/);
  });

  it("rejects failed without failureReason", () => {
    expect(() =>
      TenantDataExportSchema.parse({
        ...base,
        status: "failed",
        failedAt: "2026-05-14T11:00:00Z",
        readyAt: null,
        sizeBytes: null,
        sha256: null,
        storageUri: null,
        downloadUrlExpiresAt: null,
      }),
    ).toThrow(/failureReason/);
  });
});

describe("helpers", () => {
  const base: TenantDataExport = {
    id: "exp-1",
    tenantId: "t-1",
    trigger: "customer_request",
    requestedAt: "2026-05-14T10:00:00Z",
    requestedBy: "u-1",
    format: "json",
    includesPiiCategories: false,
    includesPhiCategories: false,
    encryptionKeyFingerprint: SHA,
    status: "ready_for_download",
    startedAt: "2026-05-14T10:01:00Z",
    readyAt: "2026-05-14T10:30:00Z",
    deliveredAt: null,
    failedAt: null,
    sizeBytes: 1_000,
    rowCount: 10,
    sha256: SHA,
    storageUri: "s3://x",
    downloadUrlExpiresAt: "2026-05-21T10:30:00Z",
    downloadCount: 1,
    maxDownloads: 3,
    purgedAt: null,
  };

  it("isExportDownloadable true within window with downloads remaining", () => {
    expect(isExportDownloadable(base, new Date("2026-05-15T00:00:00Z"))).toBe(true);
  });

  it("isExportDownloadable false after window", () => {
    expect(isExportDownloadable(base, new Date("2026-05-22T00:00:00Z"))).toBe(false);
  });

  it("isExportDownloadable false at max downloads", () => {
    expect(
      isExportDownloadable({ ...base, downloadCount: 3 }, new Date("2026-05-15T00:00:00Z")),
    ).toBe(false);
  });

  it("downloadsRemaining = maxDownloads - downloadCount", () => {
    expect(downloadsRemaining(base)).toBe(2);
    expect(downloadsRemaining({ ...base, downloadCount: 5 })).toBe(0);
  });

  it("shouldPurge true after expiry if not yet purged", () => {
    expect(shouldPurge(base, new Date("2026-05-22T00:00:00Z"))).toBe(true);
  });

  it("shouldPurge false if already purged", () => {
    expect(
      shouldPurge({ ...base, purgedAt: "2026-05-22T01:00:00Z" }, new Date("2026-05-23T00:00:00Z")),
    ).toBe(false);
  });
});
