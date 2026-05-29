import { describe, expect, it } from "vitest";

import type { IoStreams } from "./format.js";
import {
  evaluateAlertOnRow,
  opSymbol,
  parseThresholdAlert,
  parseThresholdAlertFlags,
  renderTrippedAlert,
  type AlertableFieldSpec,
} from "./threshold-alert.js";

function makeIo(): { io: IoStreams; err: () => string } {
  const errChunks: string[] = [];
  return {
    io: {
      stdout: { write: () => undefined },
      stderr: { write: (chunk: string) => errChunks.push(chunk) },
    },
    err: () => errChunks.join(""),
  };
}

describe("parseThresholdAlert (M4.14.t)", () => {
  it("parses '<field>:><value>' numeric alerts", () => {
    const result = parseThresholdAlert("wouldPruneCount:>1000000");
    expect(result.ok).toBe(true);
    expect(result.alert!.field).toBe("wouldPruneCount");
    expect(result.alert!.op).toBe("GT");
    expect(result.alert!.value).toEqual({ kind: "number", value: 1000000 });
  });

  it("parses '>=' operator (longest-match before '>')", () => {
    const result = parseThresholdAlert("totalRowCount:>=500");
    expect(result.ok).toBe(true);
    expect(result.alert!.op).toBe("GTE");
    expect(result.alert!.value).toEqual({ kind: "number", value: 500 });
  });

  it("parses '<=' operator (longest-match before '<')", () => {
    const result = parseThresholdAlert("retentionDays:<=7");
    expect(result.ok).toBe(true);
    expect(result.alert!.op).toBe("LTE");
  });

  it("parses '=' for equality", () => {
    const result = parseThresholdAlert("totalRowCount:=0");
    expect(result.ok).toBe(true);
    expect(result.alert!.op).toBe("EQ");
  });

  it("parses duration values (24h, 7d, 30m, 60s, 1y, 2w)", () => {
    const cases = [
      ["lastPrunedAt:>24h", 24 * 60 * 60 * 1000],
      ["lastPrunedAt:>7d", 7 * 24 * 60 * 60 * 1000],
      ["lastPrunedAt:>30m", 30 * 60 * 1000],
      ["lastPrunedAt:>60s", 60 * 1000],
      ["lastPrunedAt:>1y", 365 * 24 * 60 * 60 * 1000],
      ["lastPrunedAt:>2w", 2 * 7 * 24 * 60 * 60 * 1000],
    ] as const;
    for (const [raw, expectedMs] of cases) {
      const result = parseThresholdAlert(raw);
      expect(result.ok).toBe(true);
      expect(result.alert!.value.kind).toBe("duration");
      if (result.alert!.value.kind === "duration") {
        expect(result.alert!.value.ms).toBe(expectedMs);
      }
    }
  });

  it("parses absolute ISO 8601 timestamps", () => {
    const result = parseThresholdAlert("lastPrunedAt:>2026-01-01T00:00:00Z");
    expect(result.ok).toBe(true);
    expect(result.alert!.value.kind).toBe("timestamp");
  });

  it("rejects missing colon (no field/op separator)", () => {
    const result = parseThresholdAlert("wouldPruneCount>1000");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("missing ':'");
  });

  it("rejects missing operator", () => {
    const result = parseThresholdAlert("wouldPruneCount:1000");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("operator must be one of");
  });

  it("rejects missing value after operator", () => {
    const result = parseThresholdAlert("wouldPruneCount:>");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("missing value");
  });

  it("rejects unparseable value", () => {
    const result = parseThresholdAlert("wouldPruneCount:>abc");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not a number, duration");
  });

  it("rejects unknown duration unit", () => {
    // 'M' (uppercase) isn't a unit — months are 30d. 'x' is gibberish.
    const result = parseThresholdAlert("lastPrunedAt:>5x");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not a number, duration");
  });
});

describe("evaluateAlertOnRow (M4.14.t)", () => {
  const asOfMs = Date.parse("2026-05-29T12:00:00.000Z");

  it("returns tripped alert when numeric value exceeds GT threshold", () => {
    const alert = parseThresholdAlert("wouldPruneCount:>1000").alert!;
    const hit = evaluateAlertOnRow(alert, "workflow_traces", 1500, "number", asOfMs);
    expect(hit).not.toBeNull();
    expect(hit!.tableName).toBe("workflow_traces");
    expect(hit!.actual).toBe(1500);
  });

  it("returns null when numeric value does NOT exceed GT threshold", () => {
    const alert = parseThresholdAlert("wouldPruneCount:>1000").alert!;
    expect(evaluateAlertOnRow(alert, "workflow_traces", 500, "number", asOfMs)).toBeNull();
    expect(evaluateAlertOnRow(alert, "workflow_traces", 1000, "number", asOfMs)).toBeNull();
  });

  it("GTE matches equality", () => {
    const alert = parseThresholdAlert("wouldPruneCount:>=1000").alert!;
    expect(evaluateAlertOnRow(alert, "t", 1000, "number", asOfMs)).not.toBeNull();
    expect(evaluateAlertOnRow(alert, "t", 999, "number", asOfMs)).toBeNull();
  });

  it("LT and LTE work symmetrically", () => {
    const alertLt = parseThresholdAlert("totalRowCount:<100").alert!;
    expect(evaluateAlertOnRow(alertLt, "t", 50, "number", asOfMs)).not.toBeNull();
    expect(evaluateAlertOnRow(alertLt, "t", 100, "number", asOfMs)).toBeNull();
    const alertLte = parseThresholdAlert("totalRowCount:<=100").alert!;
    expect(evaluateAlertOnRow(alertLte, "t", 100, "number", asOfMs)).not.toBeNull();
  });

  it("EQ matches only exact equality", () => {
    const alert = parseThresholdAlert("wouldPruneCount:=0").alert!;
    expect(evaluateAlertOnRow(alert, "t", 0, "number", asOfMs)).not.toBeNull();
    expect(evaluateAlertOnRow(alert, "t", 1, "number", asOfMs)).toBeNull();
  });

  it("skips evaluation when numeric field is null", () => {
    const alert = parseThresholdAlert("retentionDays:>30").alert!;
    expect(evaluateAlertOnRow(alert, "t", null, "number_nullable", asOfMs)).toBeNull();
  });

  it("trips duration alert when timestamp is older than threshold (lastPrunedAt:>24h)", () => {
    const alert = parseThresholdAlert("lastPrunedAt:>24h").alert!;
    // 48 hours before asOf — older than 24h, should trip.
    const oldTimestamp = new Date(asOfMs - 48 * 60 * 60 * 1000).toISOString();
    const hit = evaluateAlertOnRow(alert, "t", oldTimestamp, "timestamp_nullable", asOfMs);
    expect(hit).not.toBeNull();
    expect(hit!.actual).toBe(oldTimestamp);
    expect(hit!.ageMs).toBeCloseTo(48 * 60 * 60 * 1000, -1);
  });

  it("does NOT trip duration alert when timestamp is newer than threshold", () => {
    const alert = parseThresholdAlert("lastPrunedAt:>24h").alert!;
    // 1 hour before asOf — within 24h, should NOT trip.
    const recentTimestamp = new Date(asOfMs - 60 * 60 * 1000).toISOString();
    expect(
      evaluateAlertOnRow(alert, "t", recentTimestamp, "timestamp_nullable", asOfMs),
    ).toBeNull();
  });

  it("trips on null timestamp for GT/GTE duration (null = infinitely old)", () => {
    const alertGt = parseThresholdAlert("lastPrunedAt:>24h").alert!;
    const hitGt = evaluateAlertOnRow(alertGt, "t", null, "timestamp_nullable", asOfMs);
    expect(hitGt).not.toBeNull();
    expect(hitGt!.actual).toBeNull();

    const alertGte = parseThresholdAlert("lastPrunedAt:>=24h").alert!;
    expect(evaluateAlertOnRow(alertGte, "t", null, "timestamp_nullable", asOfMs)).not.toBeNull();
  });

  it("does NOT trip on null timestamp for LT/LTE/EQ (null has no comparable age)", () => {
    for (const raw of ["lastPrunedAt:<24h", "lastPrunedAt:<=24h"]) {
      const alert = parseThresholdAlert(raw).alert!;
      expect(evaluateAlertOnRow(alert, "t", null, "timestamp_nullable", asOfMs)).toBeNull();
    }
  });

  it("absolute ISO 8601 timestamps compare against the field value", () => {
    const alert = parseThresholdAlert("lastPrunedAt:<2026-05-29T00:00:00.000Z").alert!;
    const fieldValue = "2026-05-28T00:00:00.000Z"; // before the threshold
    expect(evaluateAlertOnRow(alert, "t", fieldValue, "timestamp_nullable", asOfMs)).not.toBeNull();
  });
});

describe("parseThresholdAlertFlags (M4.14.t)", () => {
  const FIELDS: ReadonlyArray<AlertableFieldSpec> = [
    { name: "totalRowCount", type: "number" },
    { name: "lastPrunedAt", type: "timestamp_nullable" },
  ];

  it("returns empty array when no flags provided", () => {
    const { io } = makeIo();
    const result = parseThresholdAlertFlags([], FIELDS, io, "x");
    expect(result).toEqual([]);
  });

  it("parses multiple valid alerts", () => {
    const { io } = makeIo();
    const result = parseThresholdAlertFlags(
      ["totalRowCount:>1000", "lastPrunedAt:>24h"],
      FIELDS,
      io,
      "x",
    );
    expect(Array.isArray(result)).toBe(true);
    if (Array.isArray(result)) expect(result.length).toBe(2);
  });

  it("returns exit 2 + error on invalid syntax", () => {
    const { io, err } = makeIo();
    const result = parseThresholdAlertFlags(["totalRowCount>1000"], FIELDS, io, "x");
    expect(result).toBe(2);
    expect(err()).toContain("invalid threshold alert");
  });

  it("returns exit 2 + error on unknown field", () => {
    const { io, err } = makeIo();
    const result = parseThresholdAlertFlags(["unknownField:>10"], FIELDS, io, "x");
    expect(result).toBe(2);
    expect(err()).toContain("unknown field");
    expect(err()).toContain("totalRowCount");
    expect(err()).toContain("lastPrunedAt");
  });

  it("returns exit 2 when numeric op is applied to a timestamp field with non-duration value", () => {
    const { io, err } = makeIo();
    // duration is valid for timestamp; pass a plain number to a timestamp field — should reject
    const result = parseThresholdAlertFlags(["lastPrunedAt:>500"], FIELDS, io, "x");
    expect(result).toBe(2);
    expect(err()).toContain("must be a duration");
  });

  it("returns exit 2 when duration is applied to a numeric field", () => {
    const { io, err } = makeIo();
    const result = parseThresholdAlertFlags(["totalRowCount:>24h"], FIELDS, io, "x");
    expect(result).toBe(2);
    expect(err()).toContain("must be a number");
  });
});

describe("renderTrippedAlert + opSymbol (M4.14.t)", () => {
  it("renders numeric alert with locale-formatted actual value", () => {
    const alert = parseThresholdAlert("wouldPruneCount:>1000000").alert!;
    const hit = evaluateAlertOnRow(alert, "workflow_traces", 1500000, "number", 0)!;
    const line = renderTrippedAlert(hit);
    expect(line).toContain("workflow_traces");
    expect(line).toContain("wouldPruneCount=1,500,000");
    expect(line).toContain('"wouldPruneCount:>1000000"');
  });

  it("renders timestamp alert with age suffix (auto-units: days for >=1d, hours for <1d)", () => {
    const asOfMs = Date.parse("2026-05-29T12:00:00.000Z");
    const alert = parseThresholdAlert("lastPrunedAt:>24h").alert!;
    // 48 hours = 2 days; formatter switches to days at 1d+.
    const fieldValue2d = new Date(asOfMs - 48 * 60 * 60 * 1000).toISOString();
    const hit2d = evaluateAlertOnRow(alert, "t", fieldValue2d, "timestamp_nullable", asOfMs)!;
    expect(renderTrippedAlert(hit2d)).toContain("age 2.0d");
    // 6 hours stays in hours.
    const fieldValue6h = new Date(asOfMs - 6 * 60 * 60 * 1000).toISOString();
    const alertSubDay = parseThresholdAlert("lastPrunedAt:>1h").alert!;
    const hit6h = evaluateAlertOnRow(alertSubDay, "t", fieldValue6h, "timestamp_nullable", asOfMs)!;
    expect(renderTrippedAlert(hit6h)).toContain("age 6.0h");
  });

  it("renders null actual as 'null (never set)'", () => {
    const asOfMs = Date.parse("2026-05-29T12:00:00.000Z");
    const alert = parseThresholdAlert("lastPrunedAt:>24h").alert!;
    const hit = evaluateAlertOnRow(alert, "t", null, "timestamp_nullable", asOfMs)!;
    const line = renderTrippedAlert(hit);
    expect(line).toContain("lastPrunedAt=null (never set)");
  });

  it("opSymbol maps every operator", () => {
    expect(opSymbol("GT")).toBe(">");
    expect(opSymbol("GTE")).toBe(">=");
    expect(opSymbol("LT")).toBe("<");
    expect(opSymbol("LTE")).toBe("<=");
    expect(opSymbol("EQ")).toBe("=");
  });
});
