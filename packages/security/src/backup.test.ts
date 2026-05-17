import { describe, expect, it } from "vitest";
import {
  BackupPolicySchema,
  checkPolicyConsistency,
  durationToSeconds,
} from "./backup.js";

describe("BackupPolicySchema", () => {
  it("parses a PITR + pg-dump + R2 cold tier policy", () => {
    const p = BackupPolicySchema.parse({
      surface: "supabase-postgres",
      rpo: "60s",
      rto: "4h",
      targets: [
        { kind: "supabase-pitr", windowDays: 7 },
        {
          kind: "pg-dump",
          cadence: "daily",
          destination: "r2",
          pathTemplate: "cold-backup/<tenant_id>/<yyyy-mm-dd>/",
        },
        { kind: "r2-cold", hotRetention: "90d", coldRetention: "7y" },
      ],
    });
    expect(p.drDrillCadence).toBe("quarterly");
  });

  it("rejects duplicate target kinds", () => {
    expect(() =>
      BackupPolicySchema.parse({
        surface: "x",
        rpo: "1m",
        rto: "1h",
        targets: [
          { kind: "supabase-pitr", windowDays: 7 },
          { kind: "supabase-pitr", windowDays: 30 },
        ],
      }),
    ).toThrow(/duplicate backup target kind/);
  });

  it("rejects malformed duration", () => {
    expect(() =>
      BackupPolicySchema.parse({
        surface: "x",
        rpo: "one minute",
        rto: "4h",
        targets: [{ kind: "supabase-pitr", windowDays: 7 }],
      }),
    ).toThrow();
  });

  it("supports a logical-replica target with lag budget", () => {
    expect(() =>
      BackupPolicySchema.parse({
        surface: "supabase-postgres",
        rpo: "1m",
        rto: "1h",
        targets: [{ kind: "logical-replica", region: "ap-southeast-1", lagBudget: "30s" }],
      }),
    ).not.toThrow();
  });
});

describe("durationToSeconds", () => {
  it("converts each unit", () => {
    expect(durationToSeconds("60s")).toBe(60);
    expect(durationToSeconds("5m")).toBe(300);
    expect(durationToSeconds("2h")).toBe(7200);
    expect(durationToSeconds("1d")).toBe(86_400);
    expect(durationToSeconds("1w")).toBe(604_800);
    expect(durationToSeconds("1y")).toBe(31_536_000);
  });
});

describe("checkPolicyConsistency", () => {
  it("flags PITR window shorter than RPO", () => {
    const p = BackupPolicySchema.parse({
      surface: "x",
      rpo: "10d",
      rto: "30d",
      targets: [{ kind: "supabase-pitr", windowDays: 7 }],
    });
    const issues = checkPolicyConsistency(p);
    expect(issues.some((i) => i.includes("supabase-pitr"))).toBe(true);
  });

  it("flags logical-replica lag larger than RPO", () => {
    const p = BackupPolicySchema.parse({
      surface: "x",
      rpo: "30s",
      rto: "1h",
      targets: [{ kind: "logical-replica", region: "ap", lagBudget: "5m" }],
    });
    const issues = checkPolicyConsistency(p);
    expect(issues.some((i) => i.includes("logical-replica"))).toBe(true);
  });

  it("returns no issues for a consistent policy", () => {
    const p = BackupPolicySchema.parse({
      surface: "x",
      rpo: "1m",
      rto: "4h",
      targets: [{ kind: "supabase-pitr", windowDays: 7 }],
    });
    expect(checkPolicyConsistency(p)).toEqual([]);
  });
});
