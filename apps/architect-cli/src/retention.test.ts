import type {
  ClearTenantOptOutInput,
  DeleteTenantPolicyInput,
  DiffHistoryEntriesInput,
  DiffHistoryEntriesResult,
  EffectiveRetentionResolution,
  ExpiringOptOut,
  ExpiringOptOutsInput,
  ListOptOutHistoryInput,
  OptOutHistoryEntry,
  PostgresTraceRetention,
  RestoreTenantPolicyInput,
  RestoreTenantPolicyResult,
  RetentionPolicyRow,
  RetentionPreviewResult,
  RetentionRunResult,
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
  formatPrunePreview,
  formatPruneRun,
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
  deleteResult?: boolean;
  deleteCapture?: DeleteTenantPolicyInput[];
  historyEntries?: readonly OptOutHistoryEntry[];
  historyCapture?: ListOptOutHistoryInput[];
  restoreResult?: RestoreTenantPolicyResult;
  restoreCapture?: RestoreTenantPolicyInput[];
  diffResult?: DiffHistoryEntriesResult;
  diffCapture?: DiffHistoryEntriesInput[];
  pruneResults?: readonly RetentionRunResult[];
  previewResults?: readonly RetentionPreviewResult[];
  pruneCalled?: { count: number };
  previewCalled?: { count: number };
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
    deleteTenantPolicy: async (input: DeleteTenantPolicyInput) => {
      opts.deleteCapture?.push(input);
      if (opts.throws !== undefined) throw opts.throws;
      return opts.deleteResult ?? true;
    },
    listOptOutHistory: async (input: ListOptOutHistoryInput = {}) => {
      opts.historyCapture?.push(input);
      if (opts.throws !== undefined) throw opts.throws;
      return opts.historyEntries ?? [];
    },
    restoreTenantPolicy: async (input: RestoreTenantPolicyInput) => {
      opts.restoreCapture?.push(input);
      if (opts.throws !== undefined) throw opts.throws;
      return (
        opts.restoreResult ?? {
          kind: "restored",
          policy: {
            tenantId: TENANT_A,
            tableName: "workflow_traces",
            retentionDays: 30,
            enabled: true,
            optOut: false,
            optOutReason: null,
            optOutUntil: null,
            lastPrunedAt: null,
          },
        }
      );
    },
    diffHistoryEntries: async (input: DiffHistoryEntriesInput) => {
      opts.diffCapture?.push(input);
      if (opts.throws !== undefined) throw opts.throws;
      return (
        opts.diffResult ?? {
          idA: input.idA,
          idB: input.idB,
          tenantId: TENANT_A,
          tableName: "workflow_traces",
          occurredAtA: "2026-05-20T12:00:00.000Z",
          occurredAtB: "2026-05-21T12:00:00.000Z",
          eventKindA: "opt_out_set",
          eventKindB: "retention_set",
          fieldDiffs: [],
        }
      );
    },
    prune: async () => {
      if (opts.pruneCalled !== undefined) opts.pruneCalled.count += 1;
      if (opts.throws !== undefined) throw opts.throws;
      return opts.pruneResults ?? [];
    },
    previewPrune: async () => {
      if (opts.previewCalled !== undefined) opts.previewCalled.count += 1;
      if (opts.throws !== undefined) throw opts.throws;
      return opts.previewResults ?? [];
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
      actorId: null,
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
      actorId: null,
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
      actorId: null,
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

describe("runRetention delete", () => {
  it("returns exit 2 when tenant arg is missing", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(parsed("retention", "delete"), {
      ...ctx,
      retentionOverride: fakeRetention({}),
    } as RetentionContext);
    expect(code).toBe(2);
    expect(err()).toContain("missing arguments");
  });

  it("returns exit 2 when table arg is missing", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed("retention", "delete", TENANT_A),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("missing arguments");
  });

  it("threads tenantId + tableName to adapter", async () => {
    const { ctx } = buffers();
    const deleteCapture: DeleteTenantPolicyInput[] = [];
    const code = await runRetention(
      parsed("retention", "delete", TENANT_A, "workflow_traces"),
      {
        ...ctx,
        retentionOverride: fakeRetention({ deleteCapture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(deleteCapture[0]).toEqual({
      tenantId: TENANT_A,
      tableName: "workflow_traces",
      actorId: null,
    });
  });

  it("human-format prints 'deleted per-tenant policy' when row removed", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "delete", TENANT_A, "workflow_traces"),
      {
        ...ctx,
        retentionOverride: fakeRetention({ deleteResult: true }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain("deleted per-tenant policy");
    expect(out()).toContain(TENANT_A);
    expect(out()).toContain("workflow_traces");
  });

  it("human-format prints 'idempotent no-op' when no row matched", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "delete", TENANT_A, "workflow_traces"),
      {
        ...ctx,
        retentionOverride: fakeRetention({ deleteResult: false }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain("idempotent no-op");
    expect(out()).toContain("no per-tenant policy");
  });

  it("json-format emits envelope {action, deleted, tenantId, tableName} when row removed", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "delete",
        TENANT_A,
        "workflow_traces",
        "--format=json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ deleteResult: true }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsedJson = JSON.parse(out());
    expect(parsedJson.action).toBe("delete");
    expect(parsedJson.deleted).toBe(true);
    expect(parsedJson.tenantId).toBe(TENANT_A);
    expect(parsedJson.tableName).toBe("workflow_traces");
  });

  it("json-format emits envelope with deleted=false on no-op", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "delete",
        TENANT_A,
        "workflow_traces",
        "--format=json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ deleteResult: false }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsedJson = JSON.parse(out());
    expect(parsedJson.action).toBe("delete");
    expect(parsedJson.deleted).toBe(false);
    expect(parsedJson.tenantId).toBe(TENANT_A);
    expect(parsedJson.tableName).toBe("workflow_traces");
  });

  it("returns exit 0 on idempotent no-op (re-runnable)", async () => {
    const { ctx } = buffers();
    const code = await runRetention(
      parsed("retention", "delete", TENANT_A, "workflow_traces"),
      {
        ...ctx,
        retentionOverride: fakeRetention({ deleteResult: false }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
  });

  it("propagates adapter errors as exit 1", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed("retention", "delete", TENANT_A, "workflow_traces"),
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

describe("runRetention history (M6.7.zz.tenant.opt-out.history)", () => {
  const ACTOR = "11111111-1111-4111-8111-111111111111";

  function entry(
    overrides: Partial<OptOutHistoryEntry> = {},
  ): OptOutHistoryEntry {
    return {
      id: "10000000-0000-4000-8000-000000000001",
      tenantId: TENANT_A,
      tableName: "workflow_traces",
      eventKind: "opt_out_set",
      actorId: null,
      occurredAt: "2026-05-20T12:00:00.000Z",
      prevState: null,
      nextState: { opt_out: true, retention_days: 365 },
      attributes: {},
      ...overrides,
    };
  }

  it("returns entries with no filters when run plain", async () => {
    const { ctx } = buffers();
    const historyCapture: ListOptOutHistoryInput[] = [];
    const code = await runRetention(parsed("retention", "history"), {
      ...ctx,
      retentionOverride: fakeRetention({
        historyEntries: [entry()],
        historyCapture,
      }),
    } as RetentionContext);
    expect(code).toBe(0);
    expect(historyCapture[0]).toEqual({
      tenantId: undefined,
      tableName: undefined,
      eventKind: undefined,
      since: undefined,
      until: undefined,
      limit: 100,
      afterId: undefined,
    });
  });

  it("threads --tenant + --table + --kind + --limit through to adapter", async () => {
    const { ctx } = buffers();
    const historyCapture: ListOptOutHistoryInput[] = [];
    const code = await runRetention(
      parsed(
        "retention",
        "history",
        "--tenant",
        TENANT_A,
        "--table",
        "workflow_traces",
        "--kind",
        "opt_out_set",
        "--limit",
        "50",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ historyCapture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(historyCapture[0]).toEqual({
      tenantId: TENANT_A,
      tableName: "workflow_traces",
      eventKind: "opt_out_set",
      since: undefined,
      until: undefined,
      afterId: undefined,
      limit: 50,
    });
  });

  it("normalises --since and --until to canonical ISO 8601", async () => {
    const { ctx } = buffers();
    const historyCapture: ListOptOutHistoryInput[] = [];
    const code = await runRetention(
      parsed(
        "retention",
        "history",
        "--since",
        "2026-05-01",
        "--until",
        "2026-05-31",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ historyCapture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(historyCapture[0]?.since).toMatch(
      /^2026-05-01T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(historyCapture[0]?.until).toMatch(
      /^2026-05-31T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });

  it("returns exit 2 on invalid --kind", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed("retention", "history", "--kind", "bogus"),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("invalid --kind");
  });

  it("returns exit 2 on invalid --since", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed("retention", "history", "--since", "not-a-date"),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("invalid --since");
  });

  it("returns exit 2 on invalid --until", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed("retention", "history", "--until", "not-a-date"),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("invalid --until");
  });

  it("returns exit 2 on non-integer --limit", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed("retention", "history", "--limit", "abc"),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("invalid --limit");
  });

  it("returns exit 2 on --limit < 1", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed("retention", "history", "--limit", "0"),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("invalid --limit");
  });

  it("human-format empty result prints clear message", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(parsed("retention", "history"), {
      ...ctx,
      retentionOverride: fakeRetention({ historyEntries: [] }),
    } as RetentionContext);
    expect(code).toBe(0);
    expect(out()).toContain("no history entries");
  });

  it("human-format renders table with event_kind + tenant + table + actor", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(parsed("retention", "history"), {
      ...ctx,
      retentionOverride: fakeRetention({
        historyEntries: [
          entry({
            eventKind: "policy_deleted",
            actorId: ACTOR,
          }),
        ],
      }),
    } as RetentionContext);
    expect(code).toBe(0);
    expect(out()).toContain("policy_deleted");
    expect(out()).toContain(TENANT_A);
    expect(out()).toContain("workflow_traces");
    expect(out()).toContain(ACTOR);
  });

  it("renders '<system>' for null actorId", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(parsed("retention", "history"), {
      ...ctx,
      retentionOverride: fakeRetention({
        historyEntries: [entry({ actorId: null })],
      }),
    } as RetentionContext);
    expect(code).toBe(0);
    expect(out()).toContain("<system>");
  });

  it("json-format emits envelope with filters + count + entries", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "history",
        "--tenant",
        TENANT_A,
        "--kind",
        "opt_out_set",
        "--limit",
        "10",
        "--format=json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          historyEntries: [entry(), entry()],
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsedJson = JSON.parse(out());
    expect(parsedJson.tenantFilter).toBe(TENANT_A);
    expect(parsedJson.eventKind).toBe("opt_out_set");
    expect(parsedJson.limit).toBe(10);
    expect(parsedJson.count).toBe(2);
    expect(parsedJson.entries).toHaveLength(2);
  });

  it("propagates adapter errors as exit 1", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(parsed("retention", "history"), {
      ...ctx,
      retentionOverride: fakeRetention({
        throws: new Error("PG connection refused"),
      }),
    } as RetentionContext);
    expect(code).toBe(1);
    expect(err()).toContain("PG connection refused");
  });

  it("threads --after-id through to adapter (cursor pagination)", async () => {
    const { ctx } = buffers();
    const historyCapture: ListOptOutHistoryInput[] = [];
    const AFTER_ID = "50000000-0000-4000-8000-000000000005";
    const code = await runRetention(
      parsed("retention", "history", "--after-id", AFTER_ID),
      {
        ...ctx,
        retentionOverride: fakeRetention({ historyCapture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(historyCapture[0]?.afterId).toBe(AFTER_ID);
  });

  it("human-format prints next-page hint when results.length === limit", async () => {
    const { ctx, out } = buffers();
    const LAST_ID = "60000000-0000-4000-8000-000000000099";
    const code = await runRetention(
      parsed("retention", "history", "--limit", "2"),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          historyEntries: [
            entry({ id: "60000000-0000-4000-8000-000000000001" }),
            entry({ id: LAST_ID }),
          ],
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain(`--after-id ${LAST_ID}`);
    expect(out()).toContain("next page");
  });

  it("human-format omits next-page hint when results.length < limit", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "history", "--limit", "100"),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          historyEntries: [entry()],
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).not.toContain("next page");
    expect(out()).not.toContain("--after-id");
  });

  it("json-format emits afterId + nextAfterId fields", async () => {
    const { ctx, out } = buffers();
    const AFTER_ID = "50000000-0000-4000-8000-000000000005";
    const LAST_ID = "60000000-0000-4000-8000-000000000099";
    const code = await runRetention(
      parsed(
        "retention",
        "history",
        "--after-id",
        AFTER_ID,
        "--limit",
        "2",
        "--format=json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          historyEntries: [
            entry({ id: "60000000-0000-4000-8000-000000000001" }),
            entry({ id: LAST_ID }),
          ],
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsedJson = JSON.parse(out());
    expect(parsedJson.afterId).toBe(AFTER_ID);
    expect(parsedJson.nextAfterId).toBe(LAST_ID);
  });

  it("json-format nextAfterId is null when results.length < limit (no more pages)", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "history", "--limit", "100", "--format=json"),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          historyEntries: [entry()],
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsedJson = JSON.parse(out());
    expect(parsedJson.nextAfterId).toBeNull();
  });

  it("json-format afterId is null when --after-id is not provided", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "history", "--format=json"),
      {
        ...ctx,
        retentionOverride: fakeRetention({ historyEntries: [] }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsedJson = JSON.parse(out());
    expect(parsedJson.afterId).toBeNull();
    expect(parsedJson.nextAfterId).toBeNull();
  });
});

describe("runRetention --actor threading (M6.7.zz.tenant.opt-out.history)", () => {
  const ACTOR = "11111111-1111-4111-8111-111111111111";

  it("opt-out threads --actor to setTenantOptOut", async () => {
    const { ctx } = buffers();
    const setOptOutCapture: SetTenantOptOutInput[] = [];
    const code = await runRetention(
      parsed(
        "retention",
        "opt-out",
        TENANT_A,
        "workflow_traces",
        "--actor",
        ACTOR,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ setOptOutCapture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(setOptOutCapture[0]?.actorId).toBe(ACTOR);
  });

  it("opt-in threads --actor to clearTenantOptOut", async () => {
    const { ctx } = buffers();
    const clearOptOutCapture: ClearTenantOptOutInput[] = [];
    const code = await runRetention(
      parsed(
        "retention",
        "opt-in",
        TENANT_A,
        "workflow_traces",
        "--actor",
        ACTOR,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ clearOptOutCapture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(clearOptOutCapture[0]?.actorId).toBe(ACTOR);
  });

  it("set threads --actor to setTenantRetention", async () => {
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
        "--actor",
        ACTOR,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ setRetentionCapture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(setRetentionCapture[0]?.actorId).toBe(ACTOR);
  });

  it("delete threads --actor to deleteTenantPolicy", async () => {
    const { ctx } = buffers();
    const deleteCapture: DeleteTenantPolicyInput[] = [];
    const code = await runRetention(
      parsed(
        "retention",
        "delete",
        TENANT_A,
        "workflow_traces",
        "--actor",
        ACTOR,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ deleteCapture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(deleteCapture[0]?.actorId).toBe(ACTOR);
  });

  it("opt-out omitting --actor passes null to adapter", async () => {
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
    expect(setOptOutCapture[0]?.actorId).toBeNull();
  });
});

describe("runRetention restore (M6.7.zz.tenant.opt-out.cli.restore)", () => {
  const HISTORY_ID = "30000000-0000-4000-8000-000000000003";
  const ACTOR = "11111111-1111-4111-8111-111111111111";

  it("returns exit 2 when history-id arg is missing", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(parsed("retention", "restore"), {
      ...ctx,
      retentionOverride: fakeRetention({}),
    } as RetentionContext);
    expect(code).toBe(2);
    expect(err()).toContain("missing argument");
  });

  it("threads historyId to adapter (default actorId null)", async () => {
    const { ctx } = buffers();
    const restoreCapture: RestoreTenantPolicyInput[] = [];
    const code = await runRetention(
      parsed("retention", "restore", HISTORY_ID),
      {
        ...ctx,
        retentionOverride: fakeRetention({ restoreCapture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(restoreCapture[0]).toEqual({
      historyId: HISTORY_ID,
      actorId: null,
    });
  });

  it("threads --actor to adapter", async () => {
    const { ctx } = buffers();
    const restoreCapture: RestoreTenantPolicyInput[] = [];
    const code = await runRetention(
      parsed("retention", "restore", HISTORY_ID, "--actor", ACTOR),
      {
        ...ctx,
        retentionOverride: fakeRetention({ restoreCapture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(restoreCapture[0]?.actorId).toBe(ACTOR);
  });

  it("human-format prints 'restored' policy when kind=restored", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "restore", HISTORY_ID),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          restoreResult: {
            kind: "restored",
            policy: {
              tenantId: TENANT_A,
              tableName: "workflow_traces",
              retentionDays: 90,
              enabled: false,
              optOut: true,
              optOutReason: "legal_hold:case#42",
              optOutUntil: "2027-01-01T00:00:00.000Z",
              lastPrunedAt: null,
            },
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain("Tenant restored");
    expect(out()).toContain("90 day(s)");
    expect(out()).toContain("legal_hold:case#42");
  });

  it("human-format prints 'restored from <id>: policy deleted' when kind=deleted", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "restore", HISTORY_ID),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          restoreResult: {
            kind: "deleted",
            tenantId: TENANT_A,
            tableName: "workflow_traces",
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain(`restored from ${HISTORY_ID}`);
    expect(out()).toContain("policy deleted");
    expect(out()).toContain("(prev_state was null)");
    expect(out()).toContain(TENANT_A);
  });

  it("json-format emits envelope with action + historyId + result (restored)", async () => {
    const { ctx, out } = buffers();
    const restored: RestoreTenantPolicyResult = {
      kind: "restored",
      policy: {
        tenantId: TENANT_A,
        tableName: "workflow_traces",
        retentionDays: 30,
        enabled: true,
        optOut: false,
        optOutReason: null,
        optOutUntil: null,
        lastPrunedAt: null,
      },
    };
    const code = await runRetention(
      parsed("retention", "restore", HISTORY_ID, "--format=json"),
      {
        ...ctx,
        retentionOverride: fakeRetention({ restoreResult: restored }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsedJson = JSON.parse(out());
    expect(parsedJson.action).toBe("restore");
    expect(parsedJson.historyId).toBe(HISTORY_ID);
    expect(parsedJson.result).toEqual(restored);
  });

  it("json-format emits envelope with kind=deleted variant", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "restore", HISTORY_ID, "--format=json"),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          restoreResult: {
            kind: "deleted",
            tenantId: TENANT_A,
            tableName: "workflow_traces",
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsedJson = JSON.parse(out());
    expect(parsedJson.result.kind).toBe("deleted");
    expect(parsedJson.result.tenantId).toBe(TENANT_A);
  });

  it("propagates adapter errors as exit 1", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed("retention", "restore", HISTORY_ID),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          throws: new Error("history id 'xxx' not found"),
        }),
      } as RetentionContext,
    );
    expect(code).toBe(1);
    expect(err()).toContain("not found");
  });
});

describe("runRetention diff-history (M6.7.zz.tenant.opt-out.cli.diff-history)", () => {
  const ID_A = "40000000-0000-4000-8000-000000000001";
  const ID_B = "40000000-0000-4000-8000-000000000002";

  it("returns exit 2 when idA arg is missing", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(parsed("retention", "diff-history"), {
      ...ctx,
      retentionOverride: fakeRetention({}),
    } as RetentionContext);
    expect(code).toBe(2);
    expect(err()).toContain("missing arguments");
  });

  it("returns exit 2 when idB arg is missing", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed("retention", "diff-history", ID_A),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("missing arguments");
  });

  it("threads idA + idB to adapter", async () => {
    const { ctx } = buffers();
    const diffCapture: DiffHistoryEntriesInput[] = [];
    const code = await runRetention(
      parsed("retention", "diff-history", ID_A, ID_B),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffCapture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(diffCapture[0]).toEqual({ idA: ID_A, idB: ID_B });
  });

  it("human-format renders 'No differences' when fieldDiffs is empty", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "diff-history", ID_A, ID_B),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffResult: {
            idA: ID_A,
            idB: ID_B,
            tenantId: TENANT_A,
            tableName: "workflow_traces",
            occurredAtA: "2026-05-20T12:00:00.000Z",
            occurredAtB: "2026-05-21T12:00:00.000Z",
            eventKindA: "opt_out_set",
            eventKindB: "opt_out_set",
            fieldDiffs: [],
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain("No differences");
  });

  it("human-format renders metadata + field-by-field diff", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "diff-history", ID_A, ID_B),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffResult: {
            idA: ID_A,
            idB: ID_B,
            tenantId: TENANT_A,
            tableName: "workflow_traces",
            occurredAtA: "2026-05-20T12:00:00.000Z",
            occurredAtB: "2026-05-21T12:00:00.000Z",
            eventKindA: "opt_out_set",
            eventKindB: "retention_set",
            fieldDiffs: [
              { field: "opt_out", valueA: true, valueB: false },
              { field: "retention_days", valueA: 365, valueB: 30 },
            ],
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain("Diff between history events");
    expect(out()).toContain(`A: ${ID_A}`);
    expect(out()).toContain(`B: ${ID_B}`);
    expect(out()).toContain(`Tenant: ${TENANT_A}`);
    expect(out()).toContain("Table:  workflow_traces");
    expect(out()).toContain("opt_out");
    expect(out()).toContain("true  →  false");
    expect(out()).toContain("retention_days");
    expect(out()).toContain("365  →  30");
    expect(out()).toContain("Field changes (2)");
  });

  it("human-format renders 'absent' for undefined values (e.g., DELETE event)", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "diff-history", ID_A, ID_B),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffResult: {
            idA: ID_A,
            idB: ID_B,
            tenantId: TENANT_A,
            tableName: "workflow_traces",
            occurredAtA: "2026-05-20T12:00:00.000Z",
            occurredAtB: "2026-05-21T12:00:00.000Z",
            eventKindA: "policy_deleted",
            eventKindB: "opt_out_set",
            fieldDiffs: [
              { field: "opt_out", valueA: undefined, valueB: true },
            ],
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain("absent  →  true");
  });

  it("json-format emits envelope with action + result", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "diff-history", ID_A, ID_B, "--format=json"),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffResult: {
            idA: ID_A,
            idB: ID_B,
            tenantId: TENANT_A,
            tableName: "workflow_traces",
            occurredAtA: "2026-05-20T12:00:00.000Z",
            occurredAtB: "2026-05-21T12:00:00.000Z",
            eventKindA: "opt_out_set",
            eventKindB: "retention_set",
            fieldDiffs: [{ field: "opt_out", valueA: true, valueB: false }],
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsedJson = JSON.parse(out());
    expect(parsedJson.action).toBe("diff-history");
    expect(parsedJson.result.idA).toBe(ID_A);
    expect(parsedJson.result.idB).toBe(ID_B);
    expect(parsedJson.result.fieldDiffs).toHaveLength(1);
  });

  it("propagates adapter errors as exit 1", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed("retention", "diff-history", ID_A, ID_B),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          throws: new Error("history id(s) not found: xxx"),
        }),
      } as RetentionContext,
    );
    expect(code).toBe(1);
    expect(err()).toContain("not found");
  });
});

describe("runRetention prune (M6.7.zz.tenant.opt-out.cli.prune)", () => {
  it("default (no flag) calls prune (not previewPrune)", async () => {
    const { ctx } = buffers();
    const pruneCalled = { count: 0 };
    const previewCalled = { count: 0 };
    const code = await runRetention(parsed("retention", "prune"), {
      ...ctx,
      retentionOverride: fakeRetention({ pruneCalled, previewCalled }),
    } as RetentionContext);
    expect(code).toBe(0);
    expect(pruneCalled.count).toBe(1);
    expect(previewCalled.count).toBe(0);
  });

  it("--dry-run calls previewPrune (not prune)", async () => {
    const { ctx } = buffers();
    const pruneCalled = { count: 0 };
    const previewCalled = { count: 0 };
    const code = await runRetention(
      parsed("retention", "prune", "--dry-run"),
      {
        ...ctx,
        retentionOverride: fakeRetention({ pruneCalled, previewCalled }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(previewCalled.count).toBe(1);
    expect(pruneCalled.count).toBe(0);
  });

  it("human-format empty result prints 'no retention policies configured'", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(parsed("retention", "prune"), {
      ...ctx,
      retentionOverride: fakeRetention({ pruneResults: [] }),
    } as RetentionContext);
    expect(code).toBe(0);
    expect(out()).toContain("no retention policies configured");
  });

  it("human-format --dry-run empty result adds (dry-run) suffix", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "prune", "--dry-run"),
      {
        ...ctx,
        retentionOverride: fakeRetention({ previewResults: [] }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain("(dry-run)");
  });

  it("human-format renders pruned + skipped rows with summary line", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(parsed("retention", "prune"), {
      ...ctx,
      retentionOverride: fakeRetention({
        pruneResults: [
          {
            tableName: "workflow_traces",
            tenantId: TENANT_A,
            status: "pruned",
            retentionDays: 30,
            deletedCount: 42,
            cutoffMs: Date.parse("2026-04-21T00:00:00.000Z"),
          },
          {
            tableName: "workflow_traces",
            status: "pruned",
            retentionDays: 90,
            deletedCount: 1000,
            cutoffMs: Date.parse("2026-02-20T00:00:00.000Z"),
          },
          {
            tableName: "llm_call_traces",
            tenantId: TENANT_A,
            status: "skipped_disabled",
            retentionDays: 180,
            deletedCount: 0,
            cutoffMs: null,
          },
        ],
      }),
    } as RetentionContext);
    expect(code).toBe(0);
    expect(out()).toContain("Retention prune results (3 entries)");
    expect(out()).toContain("pruned");
    expect(out()).toContain("deleted=42");
    expect(out()).toContain("deleted=1000");
    expect(out()).toContain("tenant=" + TENANT_A);
    expect(out()).toContain("(platform)");
    expect(out()).toContain("skipped_disabled");
    expect(out()).toContain(
      "Summary: 2 pruned (1042 rows), 1 skipped (1 skipped_disabled)",
    );
  });

  it("human-format --dry-run renders 'would prune' summary verb + 'would_delete=' count label", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "prune", "--dry-run"),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          previewResults: [
            {
              tableName: "workflow_traces",
              tenantId: TENANT_A,
              status: "previewed",
              retentionDays: 30,
              wouldDeleteCount: 42,
              cutoffMs: Date.parse("2026-04-21T00:00:00.000Z"),
            },
          ],
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain("Retention prune dry-run results (1 entries)");
    expect(out()).toContain("would_delete=42");
    expect(out()).toContain("Summary: 1 would prune (42 rows)");
  });

  it("human-format renders opt-out skip with reason + until", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(parsed("retention", "prune"), {
      ...ctx,
      retentionOverride: fakeRetention({
        pruneResults: [
          {
            tableName: "workflow_traces",
            tenantId: TENANT_A,
            status: "skipped_opt_out",
            retentionDays: 365,
            deletedCount: 0,
            cutoffMs: null,
            optOutReason: "legal_hold:case#42",
            optOutUntil: "2027-01-01T00:00:00.000Z",
          },
        ],
      }),
    } as RetentionContext);
    expect(code).toBe(0);
    expect(out()).toContain("skipped_opt_out");
    expect(out()).toContain("reason=legal_hold:case#42");
    expect(out()).toContain("until=2027-01-01T00:00:00.000Z");
  });

  it("human-format renders skipped_opt_out_expired with (EXPIRED) marker", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(parsed("retention", "prune"), {
      ...ctx,
      retentionOverride: fakeRetention({
        pruneResults: [
          {
            tableName: "workflow_traces",
            tenantId: TENANT_A,
            status: "skipped_opt_out_expired",
            retentionDays: 365,
            deletedCount: 0,
            cutoffMs: null,
            optOutReason: "legal_hold:case#42",
            optOutUntil: "2025-01-01T00:00:00.000Z",
          },
        ],
      }),
    } as RetentionContext);
    expect(code).toBe(0);
    expect(out()).toContain("skipped_opt_out_expired");
    expect(out()).toContain("(EXPIRED)");
  });

  it("json-format emits envelope {action, dryRun:false, results}", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "prune", "--format=json"),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          pruneResults: [
            {
              tableName: "workflow_traces",
              status: "pruned",
              retentionDays: 90,
              deletedCount: 100,
              cutoffMs: 1_700_000_000_000,
            },
          ],
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsedJson = JSON.parse(out());
    expect(parsedJson.action).toBe("prune");
    expect(parsedJson.dryRun).toBe(false);
    expect(parsedJson.results).toHaveLength(1);
    expect(parsedJson.results[0].status).toBe("pruned");
    expect(parsedJson.results[0].deletedCount).toBe(100);
  });

  it("json-format --dry-run emits envelope with dryRun:true", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "prune", "--dry-run", "--format=json"),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          previewResults: [
            {
              tableName: "workflow_traces",
              status: "previewed",
              retentionDays: 90,
              wouldDeleteCount: 50,
              cutoffMs: 1_700_000_000_000,
            },
          ],
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsedJson = JSON.parse(out());
    expect(parsedJson.dryRun).toBe(true);
    expect(parsedJson.results[0].status).toBe("previewed");
    expect(parsedJson.results[0].wouldDeleteCount).toBe(50);
  });

  it("propagates adapter errors as exit 1", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(parsed("retention", "prune"), {
      ...ctx,
      retentionOverride: fakeRetention({
        throws: new Error("PG connection refused"),
      }),
    } as RetentionContext);
    expect(code).toBe(1);
    expect(err()).toContain("PG connection refused");
  });
});

describe("formatPruneRun / formatPrunePreview", () => {
  it("formatPruneRun renders header + result lines + summary", () => {
    const out = formatPruneRun([
      {
        tableName: "workflow_traces",
        status: "pruned",
        retentionDays: 90,
        deletedCount: 100,
        cutoffMs: Date.parse("2026-02-20T00:00:00.000Z"),
      },
    ]);
    expect(out).toContain("Retention prune results (1 entries)");
    expect(out).toContain("pruned");
    expect(out).toContain("deleted=100");
    expect(out).toContain("retention=90d");
    expect(out).toContain("cutoff=2026-02-20T00:00:00.000Z");
    expect(out).toContain("Summary: 1 pruned (100 rows)");
  });

  it("formatPrunePreview uses 'would prune' verb + 'would_delete=' count label", () => {
    const out = formatPrunePreview([
      {
        tableName: "workflow_traces",
        status: "previewed",
        retentionDays: 90,
        wouldDeleteCount: 50,
        cutoffMs: Date.parse("2026-02-20T00:00:00.000Z"),
      },
    ]);
    expect(out).toContain("Retention prune dry-run results (1 entries)");
    expect(out).toContain("would_delete=50");
    expect(out).toContain("Summary: 1 would prune (50 rows)");
  });

  it("renders (platform) for results without tenantId", () => {
    const out = formatPruneRun([
      {
        tableName: "workflow_traces",
        status: "pruned",
        retentionDays: 90,
        deletedCount: 100,
        cutoffMs: 1_700_000_000_000,
      },
    ]);
    expect(out).toContain("(platform)");
  });

  it("summary line shows multiple skip categories sorted alphabetically", () => {
    const out = formatPruneRun([
      {
        tableName: "workflow_traces",
        tenantId: TENANT_A,
        status: "skipped_opt_out",
        retentionDays: 90,
        deletedCount: 0,
        cutoffMs: null,
      },
      {
        tableName: "llm_call_traces",
        tenantId: TENANT_A,
        status: "skipped_disabled",
        retentionDays: 30,
        deletedCount: 0,
        cutoffMs: null,
      },
      {
        tableName: "workflow_traces",
        tenantId: TENANT_B,
        status: "skipped_opt_out_expired",
        retentionDays: 90,
        deletedCount: 0,
        cutoffMs: null,
      },
    ]);
    expect(out).toMatch(
      /Summary: 0 pruned \(0 rows\), 3 skipped \(1 skipped_disabled, 1 skipped_opt_out, 1 skipped_opt_out_expired\)/,
    );
  });
});
