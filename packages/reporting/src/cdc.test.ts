import { describe, expect, it } from "vitest";
import {
  CdcCheckpointSchema,
  compareLsn,
  DEFAULT_CDC_LAG_THRESHOLDS,
  lagSeverity,
  PostgresLsnSchema,
} from "./cdc.js";

const now = "2026-05-13T10:00:00.000Z";

describe("PostgresLsnSchema", () => {
  it("accepts hex-formatted LSNs", () => {
    expect(() => PostgresLsnSchema.parse("0/1AB23CDE")).not.toThrow();
    expect(() => PostgresLsnSchema.parse("FFFF/FFFF")).not.toThrow();
  });

  it("rejects malformed LSNs", () => {
    expect(() => PostgresLsnSchema.parse("notanlsn")).toThrow();
    expect(() => PostgresLsnSchema.parse("0/")).toThrow();
  });
});

describe("compareLsn", () => {
  it("orders by high segment first", () => {
    expect(compareLsn("0/100", "1/100")).toBeLessThan(0);
    expect(compareLsn("2/0", "1/FFFF")).toBeGreaterThan(0);
  });

  it("orders by low segment when high matches", () => {
    expect(compareLsn("1/100", "1/200")).toBeLessThan(0);
    expect(compareLsn("1/300", "1/200")).toBeGreaterThan(0);
  });

  it("returns 0 for equal LSNs", () => {
    expect(compareLsn("ABC/123", "ABC/123")).toBe(0);
  });
});

describe("CdcCheckpointSchema", () => {
  const base = {
    region: "eu-central" as const,
    replicationSlot: "cdc_main",
    status: "running" as const,
    lastCommittedLsn: "1/200",
    lastShippedLsn: "1/100",
    lagBytes: 256,
    lagSeconds: 0.5,
    updatedAt: now,
  };

  it("parses a healthy checkpoint", () => {
    expect(() => CdcCheckpointSchema.parse(base)).not.toThrow();
  });

  it("rejects shipped ahead of committed", () => {
    expect(() =>
      CdcCheckpointSchema.parse({
        ...base,
        lastShippedLsn: "2/0",
        lastCommittedLsn: "1/FFFF",
      }),
    ).toThrow(/cannot be ahead of/);
  });

  it("rejects negative lagBytes", () => {
    expect(() => CdcCheckpointSchema.parse({ ...base, lagBytes: -1 })).toThrow();
  });

  it("permits a snapshot-in-progress status", () => {
    expect(() =>
      CdcCheckpointSchema.parse({ ...base, status: "snapshot" }),
    ).not.toThrow();
  });
});

describe("lagSeverity", () => {
  const base = {
    region: "eu-central" as const,
    replicationSlot: "cdc_main",
    status: "running" as const,
    lastCommittedLsn: "1/200",
    lastShippedLsn: "1/100",
    lagBytes: 0,
    lagSeconds: 0,
    updatedAt: now,
    lastErrorMessage: null,
  };

  it("returns 'ok' under the warn threshold", () => {
    const checkpoint = CdcCheckpointSchema.parse({ ...base, lagSeconds: 30 });
    expect(lagSeverity(checkpoint)).toBe("ok");
  });

  it("returns 'warn' at the warn threshold", () => {
    const checkpoint = CdcCheckpointSchema.parse({ ...base, lagSeconds: 60 });
    expect(lagSeverity(checkpoint)).toBe("warn");
  });

  it("returns 'critical' at the critical threshold", () => {
    const checkpoint = CdcCheckpointSchema.parse({ ...base, lagSeconds: 600 });
    expect(lagSeverity(checkpoint)).toBe("critical");
  });

  it("respects custom thresholds", () => {
    const checkpoint = CdcCheckpointSchema.parse({ ...base, lagSeconds: 10 });
    expect(lagSeverity(checkpoint, { warnSeconds: 5, criticalSeconds: 100 })).toBe("warn");
  });

  it("DEFAULT_CDC_LAG_THRESHOLDS warns at 60s, crit at 300s", () => {
    expect(DEFAULT_CDC_LAG_THRESHOLDS.warnSeconds).toBe(60);
    expect(DEFAULT_CDC_LAG_THRESHOLDS.criticalSeconds).toBe(300);
  });
});
