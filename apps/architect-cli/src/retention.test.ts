import type {
  ClearTenantOptOutInput,
  EffectiveRetentionResolution,
  ExpiringOptOut,
  ExpiringOptOutsInput,
  PostgresTraceRetention,
  RetentionPolicyRow,
  SetTenantOptOutInput,
  SetTenantRetentionInput,
  TenantRetentionPolicyRow,
} from "@crossengin/kernel-pg";
import { describe, expect, it } from "vitest";

import { parseArgs, type ParsedCommand } from "./cli.js";
import type { RunContext } from "./commands.js";
import {
  formatEffectiveResolution,
  formatExpiringTable,
  formatPoliciesList,
  formatPolicyChange,
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
  setOptOutResult?: TenantRetentionPolicyRow;
  setOptOutCapture?: SetTenantOptOutInput[];
  clearOptOutResult?: TenantRetentionPolicyRow | null;
  clearOptOutCapture?: ClearTenantOptOutInput[];
  platformPolicies?: readonly RetentionPolicyRow[];
  tenantPolicies?: readonly TenantRetentionPolicyRow[];
  setRetentionResult?: TenantRetentionPolicyRow;
  setRetentionCapture?: SetTenantRetentionInput[];
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
    setTenantOptOut: async (input: SetTenantOptOutInput) => {
      opts.setOptOutCapture?.push(input);
      if (opts.throws !== undefined) throw opts.throws;
      return (
        opts.setOptOutResult ?? {
          tenantId: input.tenantId,
          tableName: input.tableName,
          retentionDays: input.retentionDays ?? 365,
          enabled: false,
          optOut: true,
          optOutReason: input.optOutReason ?? null,
          optOutUntil: input.optOutUntil ?? null,
          lastPrunedAt: null,
        }
      );
    },
    clearTenantOptOut: async (input: ClearTenantOptOutInput) => {
      opts.clearOptOutCapture?.push(input);
      if (opts.throws !== undefined) throw opts.throws;
      return opts.clearOptOutResult === undefined
        ? {
            tenantId: input.tenantId,
            tableName: input.tableName,
            retentionDays: 365,
            enabled: false,
            optOut: false,
            optOutReason: null,
            optOutUntil: null,
            lastPrunedAt: null,
          }
        : opts.clearOptOutResult;
    },
    listPolicies: async () => {
      if (opts.throws !== undefined) throw opts.throws;
      return opts.platformPolicies ?? [];
    },
    listTenantPolicies: async () => {
      if (opts.throws !== undefined) throw opts.throws;
      return opts.tenantPolicies ?? [];
    },
    setTenantRetention: async (input: SetTenantRetentionInput) => {
      opts.setRetentionCapture?.push(input);
      if (opts.throws !== undefined) throw opts.throws;
      return (
        opts.setRetentionResult ?? {
          tenantId: input.tenantId,
          tableName: input.tableName,
          retentionDays: input.retentionDays,
          enabled: input.enabled ?? true,
          optOut: false,
          optOutReason: null,
          optOutUntil: null,
          lastPrunedAt: null,
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

describe("runRetention opt-out", () => {
  it("returns exit 2 when tenant arg is missing", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(parsed("retention", "opt-out"), {
      ...ctx,
      retentionOverride: fakeRetention({}),
    } as RetentionContext);
    expect(code).toBe(2);
    expect(err()).toContain("missing arguments");
  });

  it("returns exit 2 when table arg is missing", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(parsed("retention", "opt-out", TENANT_A), {
      ...ctx,
      retentionOverride: fakeRetention({}),
    } as RetentionContext);
    expect(code).toBe(2);
    expect(err()).toContain("missing arguments");
  });

  it("threads tenantId + tableName + defaults to setTenantOptOut", async () => {
    const { ctx } = buffers();
    const setOptOutCapture: SetTenantOptOutInput[] = [];
    const code = await runRetention(
      parsed("retention", "opt-out", TENANT_A, "workflow_traces"),
      {
        ...ctx,
        retentionOverride: fakeRetention({ setOptOutCapture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(setOptOutCapture[0]).toEqual({
      tenantId: TENANT_A,
      tableName: "workflow_traces",
      retentionDays: undefined,
      optOutUntil: null,
      optOutReason: null,
    });
  });

  it("threads --until + --reason + --retention-days through to adapter", async () => {
    const { ctx } = buffers();
    const setOptOutCapture: SetTenantOptOutInput[] = [];
    const code = await runRetention(
      parsed(
        "retention",
        "opt-out",
        TENANT_A,
        "workflow_traces",
        "--until",
        "2027-01-01T00:00:00.000Z",
        "--reason",
        "legal_hold:case#42",
        "--retention-days",
        "90",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ setOptOutCapture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(setOptOutCapture[0]?.optOutUntil).toBe("2027-01-01T00:00:00.000Z");
    expect(setOptOutCapture[0]?.optOutReason).toBe("legal_hold:case#42");
    expect(setOptOutCapture[0]?.retentionDays).toBe(90);
  });

  it("normalises --until to canonical ISO 8601", async () => {
    const { ctx } = buffers();
    const setOptOutCapture: SetTenantOptOutInput[] = [];
    const code = await runRetention(
      parsed(
        "retention",
        "opt-out",
        TENANT_A,
        "workflow_traces",
        "--until",
        "2027-01-01",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ setOptOutCapture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(setOptOutCapture[0]?.optOutUntil).toMatch(
      /^2027-01-01T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });

  it("returns exit 2 on invalid --until", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "opt-out",
        TENANT_A,
        "workflow_traces",
        "--until",
        "not-a-date",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("invalid --until");
  });

  it("returns exit 2 on empty --reason", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "opt-out",
        TENANT_A,
        "workflow_traces",
        "--reason=",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("invalid --reason length");
  });

  it("returns exit 2 on --reason longer than 256 chars", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "opt-out",
        TENANT_A,
        "workflow_traces",
        "--reason",
        "x".repeat(257),
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("invalid --reason length");
  });

  it("returns exit 2 on non-integer --retention-days", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "opt-out",
        TENANT_A,
        "workflow_traces",
        "--retention-days",
        "abc",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("invalid --retention-days");
  });

  it("returns exit 2 on --retention-days < 1", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "opt-out",
        TENANT_A,
        "workflow_traces",
        "--retention-days",
        "0",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("invalid --retention-days");
  });

  it("human-format prints the post-mutation policy", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "opt-out",
        TENANT_A,
        "workflow_traces",
        "--until",
        "2027-01-01T00:00:00.000Z",
        "--reason",
        "legal_hold:case#42",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain("Tenant opted out");
    expect(out()).toContain("legal_hold:case#42");
    expect(out()).toContain("2027-01-01T00:00:00.000Z");
  });

  it("json-format emits envelope {action, policy}", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "opt-out",
        TENANT_A,
        "workflow_traces",
        "--format=json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsedJson = JSON.parse(out());
    expect(parsedJson.action).toBe("opt-out");
    expect(parsedJson.policy.tenantId).toBe(TENANT_A);
    expect(parsedJson.policy.optOut).toBe(true);
  });

  it("propagates adapter errors as exit 1", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed("retention", "opt-out", TENANT_A, "workflow_traces"),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          throws: new Error("CHECK constraint violated"),
        }),
      } as RetentionContext,
    );
    expect(code).toBe(1);
    expect(err()).toContain("CHECK constraint violated");
  });
});

describe("runRetention opt-in", () => {
  it("returns exit 2 when tenant arg is missing", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(parsed("retention", "opt-in"), {
      ...ctx,
      retentionOverride: fakeRetention({}),
    } as RetentionContext);
    expect(code).toBe(2);
    expect(err()).toContain("missing arguments");
  });

  it("returns exit 2 when table arg is missing", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(parsed("retention", "opt-in", TENANT_A), {
      ...ctx,
      retentionOverride: fakeRetention({}),
    } as RetentionContext);
    expect(code).toBe(2);
    expect(err()).toContain("missing arguments");
  });

  it("threads tenantId + tableName to clearTenantOptOut", async () => {
    const { ctx } = buffers();
    const clearOptOutCapture: ClearTenantOptOutInput[] = [];
    const code = await runRetention(
      parsed("retention", "opt-in", TENANT_A, "workflow_traces"),
      {
        ...ctx,
        retentionOverride: fakeRetention({ clearOptOutCapture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(clearOptOutCapture[0]).toEqual({
      tenantId: TENANT_A,
      tableName: "workflow_traces",
    });
  });

  it("human-format prints idempotent no-op when no policy is found", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "opt-in", TENANT_A, "workflow_traces"),
      {
        ...ctx,
        retentionOverride: fakeRetention({ clearOptOutResult: null }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain("idempotent no-op");
  });

  it("human-format prints the policy when a row was updated", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "opt-in", TENANT_A, "workflow_traces"),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          clearOptOutResult: {
            tenantId: TENANT_A,
            tableName: "workflow_traces",
            retentionDays: 90,
            enabled: false,
            optOut: false,
            optOutReason: "legal_hold:case#42",
            optOutUntil: null,
            lastPrunedAt: null,
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain("Tenant opted in");
    expect(out()).toContain("legal_hold:case#42");
  });

  it("json-format emits envelope {action, policy=null} on idempotent no-op", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "opt-in",
        TENANT_A,
        "workflow_traces",
        "--format=json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ clearOptOutResult: null }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsedJson = JSON.parse(out());
    expect(parsedJson.action).toBe("opt-in");
    expect(parsedJson.policy).toBeNull();
  });

  it("propagates adapter errors as exit 1", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed("retention", "opt-in", TENANT_A, "workflow_traces"),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          throws: new Error("PG connection refused"),
        }),
      } as RetentionContext,
    );
    expect(code).toBe(1);
    expect(err()).toContain("PG connection refused");
  });
});

describe("formatPolicyChange", () => {
  function policy(
    overrides: Partial<TenantRetentionPolicyRow> = {},
  ): TenantRetentionPolicyRow {
    return {
      tenantId: TENANT_A,
      tableName: "workflow_traces",
      retentionDays: 365,
      enabled: false,
      optOut: true,
      optOutReason: null,
      optOutUntil: null,
      lastPrunedAt: null,
      ...overrides,
    };
  }

  it("includes the action verb in the header", () => {
    const out = formatPolicyChange("opted out", policy());
    expect(out).toMatch(/^Tenant opted out:/);
  });

  it("includes tenantId + tableName in the header", () => {
    const out = formatPolicyChange("opted out", policy());
    expect(out).toContain(TENANT_A);
    expect(out).toContain("workflow_traces");
  });

  it("renders 'indefinite' for opt-out with null until", () => {
    const out = formatPolicyChange("opted out", policy({ optOutUntil: null }));
    expect(out).toContain("Until:      indefinite");
  });

  it("renders the ISO timestamp for opt-out with explicit until", () => {
    const out = formatPolicyChange(
      "opted out",
      policy({ optOutUntil: "2027-01-01T00:00:00.000Z" }),
    );
    expect(out).toContain("Until:      2027-01-01T00:00:00.000Z");
  });

  it("omits the Until line on opt-in with null until", () => {
    const out = formatPolicyChange(
      "opted in",
      policy({ optOut: false, optOutUntil: null }),
    );
    expect(out).not.toContain("Until:");
  });

  it("renders the reason when set", () => {
    const out = formatPolicyChange(
      "opted out",
      policy({ optOutReason: "legal_hold:case#42" }),
    );
    expect(out).toContain("Reason:     legal_hold:case#42");
  });

  it("omits the Reason line when null", () => {
    const out = formatPolicyChange("opted out", policy({ optOutReason: null }));
    expect(out).not.toContain("Reason:");
  });
});

describe("runRetention list-policies", () => {
  function platformPolicy(
    overrides: Partial<RetentionPolicyRow> = {},
  ): RetentionPolicyRow {
    return {
      tableName: "workflow_traces",
      retentionDays: 90,
      enabled: true,
      lastPrunedAt: null,
      ...overrides,
    };
  }

  function tenantPolicy(
    overrides: Partial<TenantRetentionPolicyRow> = {},
  ): TenantRetentionPolicyRow {
    return {
      tenantId: TENANT_A,
      tableName: "workflow_traces",
      retentionDays: 365,
      enabled: false,
      optOut: true,
      optOutReason: null,
      optOutUntil: null,
      lastPrunedAt: null,
      ...overrides,
    };
  }

  it("returns both platform + tenant sections with no filters", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "list-policies"),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          platformPolicies: [platformPolicy()],
          tenantPolicies: [tenantPolicy()],
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain("Platform defaults");
    expect(out()).toContain("Per-tenant policies");
  });

  it("--tenant scopes per-tenant section but not platform section", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "list-policies", "--tenant", TENANT_A),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          platformPolicies: [platformPolicy()],
          tenantPolicies: [
            tenantPolicy({ tenantId: TENANT_A }),
            tenantPolicy({ tenantId: TENANT_B }),
          ],
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain("Per-tenant policies (1 total)");
    expect(out()).toContain("Platform defaults (1 total)");
    expect(out()).toContain(TENANT_A);
    expect(out()).not.toContain(TENANT_B);
  });

  it("--table scopes both platform + per-tenant sections", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "list-policies", "--table", "workflow_traces"),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          platformPolicies: [
            platformPolicy({ tableName: "workflow_traces" }),
            platformPolicy({ tableName: "llm_call_traces" }),
          ],
          tenantPolicies: [
            tenantPolicy({ tableName: "workflow_traces" }),
            tenantPolicy({ tableName: "llm_call_traces" }),
          ],
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain("Platform defaults (1 total)");
    expect(out()).toContain("Per-tenant policies (1 total)");
    expect(out()).not.toContain("llm_call_traces");
  });

  it("--tenant + --table apply both filters", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "list-policies",
        "--tenant",
        TENANT_A,
        "--table",
        "workflow_traces",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          platformPolicies: [
            platformPolicy({ tableName: "workflow_traces" }),
            platformPolicy({ tableName: "llm_call_traces" }),
          ],
          tenantPolicies: [
            tenantPolicy({
              tenantId: TENANT_A,
              tableName: "workflow_traces",
            }),
            tenantPolicy({
              tenantId: TENANT_B,
              tableName: "workflow_traces",
            }),
            tenantPolicy({
              tenantId: TENANT_A,
              tableName: "llm_call_traces",
            }),
          ],
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain("Platform defaults (1 total)");
    expect(out()).toContain("Per-tenant policies (1 total)");
    expect(out()).toContain(TENANT_A);
    expect(out()).not.toContain(TENANT_B);
    expect(out()).not.toContain("llm_call_traces");
  });

  it("empty platform section renders '(none configured)'", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(parsed("retention", "list-policies"), {
      ...ctx,
      retentionOverride: fakeRetention({
        platformPolicies: [],
        tenantPolicies: [tenantPolicy()],
      }),
    } as RetentionContext);
    expect(code).toBe(0);
    expect(out()).toContain("Platform defaults (0 total)");
    expect(out()).toMatch(/Platform defaults \(0 total\):\s*\n  \(none configured\)/);
  });

  it("empty per-tenant section renders '(none configured)'", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(parsed("retention", "list-policies"), {
      ...ctx,
      retentionOverride: fakeRetention({
        platformPolicies: [platformPolicy()],
        tenantPolicies: [],
      }),
    } as RetentionContext);
    expect(code).toBe(0);
    expect(out()).toContain("Per-tenant policies (0 total)");
    expect(out()).toMatch(/Per-tenant policies \(0 total\):\s*\n  \(none configured\)/);
  });

  it("renders the filter suffix when --tenant or --table is set", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "list-policies",
        "--tenant",
        TENANT_A,
        "--table",
        "workflow_traces",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          platformPolicies: [platformPolicy()],
          tenantPolicies: [tenantPolicy()],
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain(`filtered: tenant=${TENANT_A}, table=workflow_traces`);
  });

  it("json-format emits structured envelope with all sections + filters", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "list-policies", "--format=json"),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          platformPolicies: [platformPolicy()],
          tenantPolicies: [tenantPolicy()],
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsedJson = JSON.parse(out());
    expect(parsedJson.tenantFilter).toBeNull();
    expect(parsedJson.tableFilter).toBeNull();
    expect(parsedJson.platform).toHaveLength(1);
    expect(parsedJson.tenantPolicies).toHaveLength(1);
  });

  it("json-format reflects --tenant + --table filter values", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "list-policies",
        "--tenant",
        TENANT_A,
        "--table",
        "workflow_traces",
        "--format=json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          platformPolicies: [],
          tenantPolicies: [],
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsedJson = JSON.parse(out());
    expect(parsedJson.tenantFilter).toBe(TENANT_A);
    expect(parsedJson.tableFilter).toBe("workflow_traces");
  });

  it("propagates adapter errors as exit 1", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(parsed("retention", "list-policies"), {
      ...ctx,
      retentionOverride: fakeRetention({
        throws: new Error("PG connection refused"),
      }),
    } as RetentionContext);
    expect(code).toBe(1);
    expect(err()).toContain("PG connection refused");
  });
});

describe("formatPoliciesList", () => {
  it("renders 'opt-out=no' for per-tenant policies without opt-out", () => {
    const out = formatPoliciesList(
      [],
      [
        {
          tenantId: TENANT_A,
          tableName: "workflow_traces",
          retentionDays: 90,
          enabled: true,
          optOut: false,
          optOutReason: null,
          optOutUntil: null,
          lastPrunedAt: null,
        },
      ],
      { tenantFilter: null, tableFilter: null },
    );
    expect(out).toContain("opt-out=no");
  });

  it("renders 'opt-out=yes' with until + reason for active opt-outs", () => {
    const out = formatPoliciesList(
      [],
      [
        {
          tenantId: TENANT_A,
          tableName: "workflow_traces",
          retentionDays: 365,
          enabled: false,
          optOut: true,
          optOutReason: "legal_hold:case#42",
          optOutUntil: "2027-01-01T00:00:00.000Z",
          lastPrunedAt: null,
        },
      ],
      { tenantFilter: null, tableFilter: null },
    );
    expect(out).toContain(
      "opt-out=yes (until 2027-01-01T00:00:00.000Z, reason: legal_hold:case#42)",
    );
  });

  it("renders 'opt-out=yes (until indefinite ...)' for null optOutUntil", () => {
    const out = formatPoliciesList(
      [],
      [
        {
          tenantId: TENANT_A,
          tableName: "workflow_traces",
          retentionDays: 365,
          enabled: false,
          optOut: true,
          optOutReason: "legal_hold:case#42",
          optOutUntil: null,
          lastPrunedAt: null,
        },
      ],
      { tenantFilter: null, tableFilter: null },
    );
    expect(out).toContain("until indefinite");
  });

  it("renders '<no reason>' for null optOutReason", () => {
    const out = formatPoliciesList(
      [],
      [
        {
          tenantId: TENANT_A,
          tableName: "workflow_traces",
          retentionDays: 365,
          enabled: false,
          optOut: true,
          optOutReason: null,
          optOutUntil: "2027-01-01T00:00:00.000Z",
          lastPrunedAt: null,
        },
      ],
      { tenantFilter: null, tableFilter: null },
    );
    expect(out).toContain("reason: <no reason>");
  });

  it("renders 'enabled' / 'disabled' for platform policies based on the flag", () => {
    const out = formatPoliciesList(
      [
        {
          tableName: "workflow_traces",
          retentionDays: 90,
          enabled: true,
          lastPrunedAt: null,
        },
        {
          tableName: "llm_call_traces",
          retentionDays: 180,
          enabled: false,
          lastPrunedAt: null,
        },
      ],
      [],
      { tenantFilter: null, tableFilter: null },
    );
    expect(out).toContain("workflow_traces");
    expect(out).toContain("enabled");
    expect(out).toContain("llm_call_traces");
    expect(out).toContain("disabled");
  });

  it("renders 'last pruned <iso>' when lastPrunedAt is set, 'never' otherwise", () => {
    const out = formatPoliciesList(
      [
        {
          tableName: "workflow_traces",
          retentionDays: 90,
          enabled: true,
          lastPrunedAt: "2026-05-20T10:00:00.000Z",
        },
        {
          tableName: "llm_call_traces",
          retentionDays: 180,
          enabled: true,
          lastPrunedAt: null,
        },
      ],
      [],
      { tenantFilter: null, tableFilter: null },
    );
    expect(out).toContain("last pruned 2026-05-20T10:00:00.000Z");
    expect(out).toContain("last pruned never");
  });

  it("omits the filter suffix when both filters are null", () => {
    const out = formatPoliciesList(
      [],
      [],
      { tenantFilter: null, tableFilter: null },
    );
    expect(out).not.toContain("filtered:");
  });
});

describe("runRetention set", () => {
  it("returns exit 2 when tenant arg is missing", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(parsed("retention", "set"), {
      ...ctx,
      retentionOverride: fakeRetention({}),
    } as RetentionContext);
    expect(code).toBe(2);
    expect(err()).toContain("missing arguments");
  });

  it("returns exit 2 when table arg is missing", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(parsed("retention", "set", TENANT_A), {
      ...ctx,
      retentionOverride: fakeRetention({}),
    } as RetentionContext);
    expect(code).toBe(2);
    expect(err()).toContain("missing arguments");
  });

  it("returns exit 2 when --days flag is missing", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed("retention", "set", TENANT_A, "workflow_traces"),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("missing --days flag");
  });

  it("threads tenantId + tableName + days + default enabled=true to adapter", async () => {
    const { ctx } = buffers();
    const setRetentionCapture: SetTenantRetentionInput[] = [];
    const code = await runRetention(
      parsed(
        "retention",
        "set",
        TENANT_A,
        "workflow_traces",
        "--days",
        "30",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ setRetentionCapture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(setRetentionCapture[0]).toEqual({
      tenantId: TENANT_A,
      tableName: "workflow_traces",
      retentionDays: 30,
      enabled: true,
    });
  });

  it("threads --enabled=false to adapter", async () => {
    const { ctx } = buffers();
    const setRetentionCapture: SetTenantRetentionInput[] = [];
    const code = await runRetention(
      parsed(
        "retention",
        "set",
        TENANT_A,
        "workflow_traces",
        "--days",
        "30",
        "--enabled",
        "false",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ setRetentionCapture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(setRetentionCapture[0]?.enabled).toBe(false);
  });

  it("threads --enabled=true explicitly to adapter", async () => {
    const { ctx } = buffers();
    const setRetentionCapture: SetTenantRetentionInput[] = [];
    await runRetention(
      parsed(
        "retention",
        "set",
        TENANT_A,
        "workflow_traces",
        "--days",
        "30",
        "--enabled",
        "true",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ setRetentionCapture }),
      } as RetentionContext,
    );
    expect(setRetentionCapture[0]?.enabled).toBe(true);
  });

  it("returns exit 2 on invalid --enabled", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "set",
        TENANT_A,
        "workflow_traces",
        "--days",
        "30",
        "--enabled",
        "yes",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("invalid --enabled");
  });

  it("returns exit 2 on non-integer --days", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "set",
        TENANT_A,
        "workflow_traces",
        "--days",
        "abc",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("invalid --days");
  });

  it("returns exit 2 on --days < 1", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "set",
        TENANT_A,
        "workflow_traces",
        "--days",
        "0",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("invalid --days");
  });

  it("human-format prints the post-mutation policy with action verb", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "set",
        TENANT_A,
        "workflow_traces",
        "--days",
        "30",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain("Tenant retention set:");
    expect(out()).toContain("30 day(s)");
    expect(out()).toContain("Opt-out:    no");
  });

  it("json-format emits envelope {action: 'set', policy}", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "set",
        TENANT_A,
        "workflow_traces",
        "--days",
        "30",
        "--format=json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsedJson = JSON.parse(out());
    expect(parsedJson.action).toBe("set");
    expect(parsedJson.policy.tenantId).toBe(TENANT_A);
    expect(parsedJson.policy.retentionDays).toBe(30);
    expect(parsedJson.policy.optOut).toBe(false);
  });

  it("propagates adapter errors as exit 1", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "set",
        TENANT_A,
        "workflow_traces",
        "--days",
        "30",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          throws: new Error("FK constraint violated"),
        }),
      } as RetentionContext,
    );
    expect(code).toBe(1);
    expect(err()).toContain("FK constraint violated");
  });
});
