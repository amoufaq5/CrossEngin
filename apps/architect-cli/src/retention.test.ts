import type {
  EffectiveRetentionResolution,
  ExpiringOptOut,
  ExpiringOptOutsInput,
  PostgresTraceRetention,
} from "@crossengin/kernel-pg";
import { describe, expect, it } from "vitest";

import { parseArgs, type ParsedCommand } from "./cli.js";
import type { RunContext } from "./commands.js";
import {
  formatEffectiveResolution,
  formatExpiringTable,
  runRetention,
  type RetentionContext,
} from "./retention.js";

const TENANT_A = "00000000-0000-4000-8000-00000000000A";
const TENANT_B = "00000000-0000-4000-8000-00000000000B";

function buffers(): { ctx: RunContext; out: () => string; err: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    ctx: {
      io: {
        stdout: { write: (chunk: string) => out.push(chunk) },
        stderr: { write: (chunk: string) => err.push(chunk) },
      },
      env: {},
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

function parsed(...argv: string[]): ParsedCommand {
  const result = parseArgs(["node", "crossengin", ...argv]);
  if (!result.ok) throw new Error(result.error.message);
  return result.command;
}

function fakeRetention(opts: {
  results?: readonly ExpiringOptOut[];
  capture?: ExpiringOptOutsInput[];
  throws?: Error;
  effective?: EffectiveRetentionResolution;
  effectiveCapture?: { tenantId: string; tableName: string }[];
}): PostgresTraceRetention {
  return {
    expiringOptOuts: async (input: ExpiringOptOutsInput) => {
      opts.capture?.push(input);
      if (opts.throws !== undefined) throw opts.throws;
      return opts.results ?? [];
    },
    effectiveRetention: async (tenantId: string, tableName: string) => {
      opts.effectiveCapture?.push({ tenantId, tableName });
      if (opts.throws !== undefined) throw opts.throws;
      return (
        opts.effective ?? {
          source: "none",
          retentionDays: null,
          enabled: false,
        }
      );
    },
  } as unknown as PostgresTraceRetention;
}

function makeOptOut(
  overrides: Partial<ExpiringOptOut> = {},
): ExpiringOptOut {
  return {
    tenantId: TENANT_A,
    tableName: "workflow_traces",
    optOutUntil: "2026-06-15T00:00:00.000Z",
    optOutReason: null,
    daysUntilExpiry: 7,
    ...overrides,
  };
}

describe("runRetention — argument parsing", () => {
  it("returns exit 2 when no action is given", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(parsed("retention"), {
      ...ctx,
      retentionOverride: fakeRetention({}),
    });
    expect(code).toBe(2);
    expect(err()).toContain("missing action");
  });

  it("returns exit 2 for an unknown action", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(parsed("retention", "bogus"), {
      ...ctx,
      retentionOverride: fakeRetention({}),
    });
    expect(code).toBe(2);
    expect(err()).toContain("unknown action");
  });

  it("returns exit 1 when no override and PG env is missing", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(parsed("retention", "expiring"), ctx);
    expect(code).toBe(1);
    expect(err()).toContain("PG env vars");
  });
});

describe("runRetention expiring", () => {
  it("uses default withinDays=30 + includeExpired=false when no flags", async () => {
    const { ctx } = buffers();
    const capture: ExpiringOptOutsInput[] = [];
    const code = await runRetention(parsed("retention", "expiring"), {
      ...ctx,
      retentionOverride: fakeRetention({ capture }),
    } as RetentionContext);
    expect(code).toBe(0);
    expect(capture[0]).toEqual({ withinDays: 30, includeExpired: false });
  });

  it("threads --within-days through to expiringOptOuts", async () => {
    const { ctx } = buffers();
    const capture: ExpiringOptOutsInput[] = [];
    const code = await runRetention(
      parsed("retention", "expiring", "--within-days", "7"),
      {
        ...ctx,
        retentionOverride: fakeRetention({ capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.withinDays).toBe(7);
  });

  it("threads --include-expired through to expiringOptOuts", async () => {
    const { ctx } = buffers();
    const capture: ExpiringOptOutsInput[] = [];
    const code = await runRetention(
      parsed("retention", "expiring", "--include-expired"),
      {
        ...ctx,
        retentionOverride: fakeRetention({ capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.includeExpired).toBe(true);
  });

  it("returns exit 2 with clear error on negative --within-days", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed("retention", "expiring", "--within-days", "-5"),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("invalid --within-days");
  });

  it("returns exit 2 on non-numeric --within-days", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed("retention", "expiring", "--within-days", "soon"),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("invalid --within-days");
  });

  it("human-format empty result prints success message", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(parsed("retention", "expiring"), {
      ...ctx,
      retentionOverride: fakeRetention({ results: [] }),
    } as RetentionContext);
    expect(code).toBe(0);
    expect(out()).toContain("no opt-outs expiring");
    expect(out()).toContain("30 day");
  });

  it("human-format empty result with --include-expired uses 'expired or expiring' wording", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "expiring", "--include-expired"),
      {
        ...ctx,
        retentionOverride: fakeRetention({ results: [] }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain("expired or expiring");
  });

  it("human-format renders a table when results are present", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(parsed("retention", "expiring"), {
      ...ctx,
      retentionOverride: fakeRetention({
        results: [
          makeOptOut({ daysUntilExpiry: 5, optOutReason: "legal_hold:case#42" }),
          makeOptOut({
            tenantId: TENANT_B,
            tableName: "llm_call_traces",
            daysUntilExpiry: 25,
          }),
        ],
      }),
    } as RetentionContext);
    expect(code).toBe(0);
    expect(out()).toContain("2 total");
    expect(out()).toContain("legal_hold:case#42");
    expect(out()).toContain(TENANT_A);
    expect(out()).toContain(TENANT_B);
    expect(out()).toContain("workflow_traces");
    expect(out()).toContain("llm_call_traces");
  });

  it("json-format emits structured output with results array", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "expiring", "--format=json"),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          results: [makeOptOut({ daysUntilExpiry: 5 })],
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsedJson = JSON.parse(out());
    expect(parsedJson.withinDays).toBe(30);
    expect(parsedJson.includeExpired).toBe(false);
    expect(parsedJson.count).toBe(1);
    expect(parsedJson.results).toHaveLength(1);
    expect(parsedJson.results[0].tenantId).toBe(TENANT_A);
  });

  it("json-format includes withinDays + includeExpired flags in output", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "expiring",
        "--within-days",
        "7",
        "--include-expired",
        "--format=json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ results: [] }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsedJson = JSON.parse(out());
    expect(parsedJson.withinDays).toBe(7);
    expect(parsedJson.includeExpired).toBe(true);
    expect(parsedJson.count).toBe(0);
    expect(parsedJson.results).toEqual([]);
  });

  it("propagates resolver errors as exit 1", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(parsed("retention", "expiring"), {
      ...ctx,
      retentionOverride: fakeRetention({
        throws: new Error("connection refused"),
      }),
    } as RetentionContext);
    expect(code).toBe(1);
    expect(err()).toContain("connection refused");
  });
});

describe("formatExpiringTable", () => {
  it("renders positive daysUntilExpiry as 'Nd'", () => {
    const out = formatExpiringTable(
      [makeOptOut({ daysUntilExpiry: 5.7 })],
      30,
      false,
    );
    expect(out).toContain("5.7d");
  });

  it("renders negative daysUntilExpiry as 'EXPIRED Nd ago'", () => {
    const out = formatExpiringTable(
      [makeOptOut({ daysUntilExpiry: -3.2 })],
      30,
      true,
    );
    expect(out).toContain("EXPIRED 3.2d ago");
  });

  it("renders <no reason> when optOutReason is null", () => {
    const out = formatExpiringTable(
      [makeOptOut({ optOutReason: null })],
      30,
      false,
    );
    expect(out).toContain("<no reason>");
  });

  it("renders the actual reason when set", () => {
    const out = formatExpiringTable(
      [makeOptOut({ optOutReason: "vip_contract:tenant-xyz" })],
      30,
      false,
    );
    expect(out).toContain("vip_contract:tenant-xyz");
  });

  it("uses 'expired or expiring' header when includeExpired=true", () => {
    const out = formatExpiringTable(
      [makeOptOut()],
      30,
      true,
    );
    expect(out).toContain("expired or expiring");
  });

  it("uses 'expiring' header when includeExpired=false", () => {
    const out = formatExpiringTable(
      [makeOptOut()],
      30,
      false,
    );
    expect(out).toMatch(/^Opt-outs expiring within 30 day/);
  });
});

describe("runRetention effective", () => {
  it("returns exit 2 when tenant arg is missing", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(parsed("retention", "effective"), {
      ...ctx,
      retentionOverride: fakeRetention({}),
    } as RetentionContext);
    expect(code).toBe(2);
    expect(err()).toContain("missing arguments");
  });

  it("returns exit 2 when table arg is missing", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed("retention", "effective", TENANT_A),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("missing arguments");
  });

  it("threads tenantId + tableName through to effectiveRetention", async () => {
    const { ctx } = buffers();
    const effectiveCapture: { tenantId: string; tableName: string }[] = [];
    const code = await runRetention(
      parsed("retention", "effective", TENANT_A, "workflow_traces"),
      {
        ...ctx,
        retentionOverride: fakeRetention({ effectiveCapture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(effectiveCapture[0]).toEqual({
      tenantId: TENANT_A,
      tableName: "workflow_traces",
    });
  });

  it("human-format renders source='tenant' with retention days + enabled", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "effective", TENANT_A, "workflow_traces"),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          effective: {
            source: "tenant",
            retentionDays: 30,
            enabled: true,
            tenantId: TENANT_A,
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain("Tenant override");
    expect(out()).toContain("30 day(s)");
    expect(out()).toContain(TENANT_A);
    expect(out()).toContain("workflow_traces");
  });

  it("human-format renders source='tenant_opt_out' with reason + until", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "effective", TENANT_A, "workflow_traces"),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          effective: {
            source: "tenant_opt_out",
            retentionDays: null,
            enabled: false,
            tenantId: TENANT_A,
            optOutReason: "legal_hold:case#42",
            optOutUntil: "2027-01-01T00:00:00.000Z",
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain("Tenant opt-out");
    expect(out()).toContain("legal_hold:case#42");
    expect(out()).toContain("2027-01-01T00:00:00.000Z");
  });

  it("human-format renders source='tenant_opt_out' with 'indefinite' when optOutUntil is null", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "effective", TENANT_A, "workflow_traces"),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          effective: {
            source: "tenant_opt_out",
            retentionDays: null,
            enabled: false,
            tenantId: TENANT_A,
            optOutReason: null,
            optOutUntil: null,
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain("indefinite");
    expect(out()).toContain("<no reason>");
  });

  it("human-format renders source='platform' with enabled flag", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "effective", TENANT_A, "workflow_traces"),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          effective: {
            source: "platform",
            retentionDays: 90,
            enabled: true,
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain("Platform default");
    expect(out()).toContain("90 day(s)");
    expect(out()).toContain("Enabled:    yes");
  });

  it("human-format renders source='platform' with Enabled:no when disabled", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "effective", TENANT_A, "workflow_traces"),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          effective: {
            source: "platform",
            retentionDays: 90,
            enabled: false,
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain("Enabled:    no");
  });

  it("human-format renders source='none' with clear message", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "effective", TENANT_A, "workflow_traces"),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          effective: {
            source: "none",
            retentionDays: null,
            enabled: false,
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain("No policy configured");
  });

  it("json-format emits structured output with the full resolution", async () => {
    const { ctx, out } = buffers();
    const resolution: EffectiveRetentionResolution = {
      source: "tenant_opt_out",
      retentionDays: null,
      enabled: false,
      tenantId: TENANT_A,
      optOutReason: "legal_hold:case#42",
      optOutUntil: "2027-01-01T00:00:00.000Z",
    };
    const code = await runRetention(
      parsed(
        "retention",
        "effective",
        TENANT_A,
        "workflow_traces",
        "--format=json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ effective: resolution }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsedJson = JSON.parse(out());
    expect(parsedJson.tenantId).toBe(TENANT_A);
    expect(parsedJson.tableName).toBe("workflow_traces");
    expect(parsedJson.resolution).toEqual(resolution);
  });

  it("propagates resolver errors as exit 1", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed("retention", "effective", TENANT_A, "workflow_traces"),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          throws: new Error("connection refused"),
        }),
      } as RetentionContext,
    );
    expect(code).toBe(1);
    expect(err()).toContain("connection refused");
  });
});

describe("formatEffectiveResolution", () => {
  it("source='tenant' includes the tenant id from the resolution (not the query)", () => {
    const out = formatEffectiveResolution(
      {
        source: "tenant",
        retentionDays: 60,
        enabled: true,
        tenantId: TENANT_A,
      },
      "different-tenant-arg",
      "workflow_traces",
    );
    expect(out).toContain(TENANT_A);
  });

  it("source='platform' includes the queried tenant id (resolution doesn't carry one)", () => {
    const out = formatEffectiveResolution(
      { source: "platform", retentionDays: 90, enabled: true },
      TENANT_A,
      "workflow_traces",
    );
    expect(out).toContain(TENANT_A);
  });

  it("source='none' includes the queried tenant id", () => {
    const out = formatEffectiveResolution(
      { source: "none", retentionDays: null, enabled: false },
      TENANT_A,
      "workflow_traces",
    );
    expect(out).toContain(TENANT_A);
    expect(out).toContain("No policy configured");
  });

  it("source='tenant_opt_out' renders indefinite for null optOutUntil", () => {
    const out = formatEffectiveResolution(
      {
        source: "tenant_opt_out",
        retentionDays: null,
        enabled: false,
        tenantId: TENANT_A,
        optOutReason: "legal_hold:case#42",
        optOutUntil: null,
      },
      TENANT_A,
      "workflow_traces",
    );
    expect(out).toContain("indefinite");
  });

  it("source='tenant_opt_out' renders <no reason> for null optOutReason", () => {
    const out = formatEffectiveResolution(
      {
        source: "tenant_opt_out",
        retentionDays: null,
        enabled: false,
        tenantId: TENANT_A,
        optOutReason: null,
        optOutUntil: "2027-01-01T00:00:00.000Z",
      },
      TENANT_A,
      "workflow_traces",
    );
    expect(out).toContain("<no reason>");
  });
});
