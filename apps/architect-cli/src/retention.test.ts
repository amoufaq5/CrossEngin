import type {
  ClearTenantOptOutInput,
  DeleteTenantPolicyInput,
  DiffHistoryEntriesInput,
  DiffHistoryEntriesResult,
  DiffHistoryTimelineCrossTableInput,
  DiffHistoryTimelineCrossTableResult,
  DiffHistoryTimelineInput,
  DiffHistoryTimelineNwayInput,
  DiffHistoryTimelineNwayResult,
  DiffHistoryTimelineResult,
  DiffTenantPoliciesInput,
  DiffTenantPoliciesNwayInput,
  DiffTenantPoliciesNwayResult,
  DiffTenantPoliciesResult,
  DiffTenantTablesInput,
  DiffTenantTablesNwayInput,
  DiffTenantTablesNwayResult,
  DiffTenantTablesResult,
  DiffTenantVsPlatformInput,
  DiffTenantVsPlatformResult,
  EffectiveRetentionResolution,
  ExpiringOptOut,
  ExpiringOptOutsInput,
  ListOptOutHistoryInput,
  OptOutHistoryEntry,
  PostgresTraceRetention,
  PreviewRestoreTenantPolicyInput,
  RestoreTenantPolicyInput,
  RestoreTenantPolicyPreview,
  RestoreTenantPolicyResult,
  RetentionPolicyRow,
  RetentionPreviewResult,
  RetentionRunResult,
  SetTenantOptOutInput,
  SetTenantRetentionInput,
  TenantRetentionPolicyRow,
} from "@crossengin/kernel-pg";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseArgs, type ParsedCommand } from "./cli.js";
import type { RunContext } from "./commands.js";
import {
  formatEffectiveBatch,
  formatEffectiveResolution,
  formatExpiringTable,
  formatHistoryList,
  formatPoliciesList,
  formatPolicyChange,
  formatPrunePreview,
  formatPruneRun,
  formatRestorePreview,
  formatTenantDiff,
  formatTenantNwayDiff,
  formatTenantTablesDiff,
  formatTenantTablesNwayDiff,
  formatTimelineCrossTableDiff,
  formatTimelineDiff,
  formatTimelineNwayDiff,
  formatTenantVsPlatformDiff,
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
  effectiveBatchResults?: ReadonlyMap<string, EffectiveRetentionResolution>;
  effectiveBatchCapture?: { tenantId: string; tableName: string }[][];
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
  diffTimelineResult?: DiffHistoryTimelineResult;
  diffTimelineCapture?: DiffHistoryTimelineInput[];
  diffTimelineNwayResult?: DiffHistoryTimelineNwayResult;
  diffTimelineNwayCapture?: DiffHistoryTimelineNwayInput[];
  diffTimelineCrossTableResult?: DiffHistoryTimelineCrossTableResult;
  diffTimelineCrossTableCapture?: DiffHistoryTimelineCrossTableInput[];
  pruneResults?: readonly RetentionRunResult[];
  previewResults?: readonly RetentionPreviewResult[];
  pruneCalled?: { count: number };
  previewCalled?: { count: number };
  previewRestoreResult?: RestoreTenantPolicyPreview;
  previewRestoreCapture?: PreviewRestoreTenantPolicyInput[];
  diffTenantResult?: DiffTenantPoliciesResult;
  diffTenantCapture?: DiffTenantPoliciesInput[];
  diffTenantVsPlatformResult?: DiffTenantVsPlatformResult;
  diffTenantVsPlatformCapture?: DiffTenantVsPlatformInput[];
  diffTenantTablesResult?: DiffTenantTablesResult;
  diffTenantTablesCapture?: DiffTenantTablesInput[];
  diffTenantTablesNwayResult?: DiffTenantTablesNwayResult;
  diffTenantTablesNwayCapture?: DiffTenantTablesNwayInput[];
  diffTenantNwayResult?: DiffTenantPoliciesNwayResult;
  diffTenantNwayCapture?: DiffTenantPoliciesNwayInput[];
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
    effectiveRetentionBatch: async (input: {
      pairs: ReadonlyArray<{ tenantId: string; tableName: string }>;
    }) => {
      opts.effectiveBatchCapture?.push(input.pairs.map((p) => ({ ...p })));
      if (opts.throws !== undefined) throw opts.throws;
      if (opts.effectiveBatchResults !== undefined) {
        return opts.effectiveBatchResults;
      }
      const map = new Map<string, EffectiveRetentionResolution>();
      for (const p of input.pairs) {
        map.set(`${p.tenantId}:${p.tableName}`, {
          source: "none",
          retentionDays: null,
          enabled: false,
        });
      }
      return map;
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
          actorIdA: null,
          actorIdB: null,
          fieldDiffs: [],
        }
      );
    },
    diffHistoryTimeline: async (input: DiffHistoryTimelineInput) => {
      opts.diffTimelineCapture?.push(input);
      if (opts.throws !== undefined) throw opts.throws;
      return (
        opts.diffTimelineResult ?? {
          tenantIdA: input.tenantIdA,
          tenantIdB: input.tenantIdB,
          tableName: input.tableName,
          entries: [],
        }
      );
    },
    diffHistoryTimelineNway: async (input: DiffHistoryTimelineNwayInput) => {
      opts.diffTimelineNwayCapture?.push(input);
      if (opts.throws !== undefined) throw opts.throws;
      return (
        opts.diffTimelineNwayResult ?? {
          tenantIds: input.tenantIds,
          tableName: input.tableName,
          entries: [],
        }
      );
    },
    diffHistoryTimelineCrossTable: async (
      input: DiffHistoryTimelineCrossTableInput,
    ) => {
      opts.diffTimelineCrossTableCapture?.push(input);
      if (opts.throws !== undefined) throw opts.throws;
      return (
        opts.diffTimelineCrossTableResult ?? {
          tenantId: input.tenantId,
          tableNames: input.tableNames,
          entries: [],
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
    previewRestoreTenantPolicy: async (input: PreviewRestoreTenantPolicyInput) => {
      opts.previewRestoreCapture?.push(input);
      if (opts.throws !== undefined) throw opts.throws;
      return (
        opts.previewRestoreResult ?? {
          kind: "would_set_retention",
          tenantId: TENANT_A,
          tableName: "workflow_traces",
          retentionDays: 30,
          enabled: true,
          sourceHistoryId: input.historyId,
        }
      );
    },
    diffTenantPolicies: async (input: DiffTenantPoliciesInput) => {
      opts.diffTenantCapture?.push(input);
      if (opts.throws !== undefined) throw opts.throws;
      return (
        opts.diffTenantResult ?? {
          tenantIdA: input.tenantIdA,
          tenantIdB: input.tenantIdB,
          tableName: input.tableName,
          resolutionA: {
            source: "none",
            retentionDays: null,
            enabled: false,
          },
          resolutionB: {
            source: "none",
            retentionDays: null,
            enabled: false,
          },
          fieldDiffs: [],
        }
      );
    },
    diffTenantVsPlatform: async (input: DiffTenantVsPlatformInput) => {
      opts.diffTenantVsPlatformCapture?.push(input);
      if (opts.throws !== undefined) throw opts.throws;
      return (
        opts.diffTenantVsPlatformResult ?? {
          tenantId: input.tenantId,
          tableName: input.tableName,
          tenantResolution: {
            source: "none",
            retentionDays: null,
            enabled: false,
          },
          platformResolution: {
            source: "none",
            retentionDays: null,
            enabled: false,
          },
          fieldDiffs: [],
        }
      );
    },
    diffTenantTables: async (input: DiffTenantTablesInput) => {
      opts.diffTenantTablesCapture?.push(input);
      if (opts.throws !== undefined) throw opts.throws;
      return (
        opts.diffTenantTablesResult ?? {
          tenantId: input.tenantId,
          tableNameA: input.tableNameA,
          tableNameB: input.tableNameB,
          resolutionA: {
            source: "none",
            retentionDays: null,
            enabled: false,
          },
          resolutionB: {
            source: "none",
            retentionDays: null,
            enabled: false,
          },
          fieldDiffs: [],
        }
      );
    },
    diffTenantTablesNway: async (input: DiffTenantTablesNwayInput) => {
      opts.diffTenantTablesNwayCapture?.push(input);
      if (opts.throws !== undefined) throw opts.throws;
      if (opts.diffTenantTablesNwayResult !== undefined) {
        return opts.diffTenantTablesNwayResult;
      }
      return {
        tenantId: input.tenantId,
        tableNames: input.tableNames,
        resolutions: input.tableNames.map((tableName) => ({
          tableName,
          resolution: {
            source: "none" as const,
            retentionDays: null,
            enabled: false,
          },
        })),
        fieldVariations: [],
      };
    },
    diffTenantPoliciesNway: async (input: DiffTenantPoliciesNwayInput) => {
      opts.diffTenantNwayCapture?.push(input);
      if (opts.throws !== undefined) throw opts.throws;
      if (opts.diffTenantNwayResult !== undefined) {
        return opts.diffTenantNwayResult;
      }
      return {
        tenantIds: input.tenantIds,
        tableName: input.tableName,
        resolutions: input.tenantIds.map((tenantId) => ({
          tenantId,
          resolution: {
            source: "none" as const,
            retentionDays: null,
            enabled: false,
          },
        })),
        fieldVariations: [],
      };
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

describe("runRetention effective-batch (M6.7.zz.tenant.opt-out.cli.effective-batch)", () => {
  async function writePairsFile(content: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "retention-batch-"));
    const path = join(dir, "pairs.json");
    await writeFile(path, content);
    return path;
  }

  it("returns exit 2 when --pairs-file is missing", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(parsed("retention", "effective-batch"), {
      ...ctx,
      retentionOverride: fakeRetention({}),
    } as RetentionContext);
    expect(code).toBe(2);
    expect(err()).toContain("missing --pairs-file");
  });

  it("returns exit 1 when --pairs-file path doesn't exist", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "effective-batch",
        "--pairs-file=/nonexistent/path/pairs.json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(1);
    expect(err()).toContain("failed to read");
  });

  it("returns exit 2 when --pairs-file content is not valid JSON", async () => {
    const path = await writePairsFile("not json at all {");
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed("retention", "effective-batch", `--pairs-file=${path}`),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("not valid JSON");
  });

  it("returns exit 2 when JSON is not an array", async () => {
    const path = await writePairsFile('{"tenantId":"a","tableName":"b"}');
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed("retention", "effective-batch", `--pairs-file=${path}`),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("must be a JSON array");
  });

  it("returns exit 2 when an entry is missing tenantId", async () => {
    const path = await writePairsFile(
      JSON.stringify([{ tableName: "workflow_traces" }]),
    );
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed("retention", "effective-batch", `--pairs-file=${path}`),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("index 0");
    expect(err()).toContain("tenantId");
  });

  it("returns exit 2 when an entry is missing tableName", async () => {
    const path = await writePairsFile(
      JSON.stringify([{ tenantId: TENANT_A }]),
    );
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed("retention", "effective-batch", `--pairs-file=${path}`),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("tableName");
  });

  it("threads pairs to adapter in input order", async () => {
    const path = await writePairsFile(
      JSON.stringify([
        { tenantId: TENANT_A, tableName: "workflow_traces" },
        { tenantId: TENANT_B, tableName: "llm_call_traces" },
      ]),
    );
    const capture: { tenantId: string; tableName: string }[][] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed("retention", "effective-batch", `--pairs-file=${path}`),
      {
        ...ctx,
        retentionOverride: fakeRetention({ effectiveBatchCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture).toHaveLength(1);
    expect(capture[0]).toEqual([
      { tenantId: TENANT_A, tableName: "workflow_traces" },
      { tenantId: TENANT_B, tableName: "llm_call_traces" },
    ]);
  });

  it("empty input array prints 'empty input' message + exit 0", async () => {
    const path = await writePairsFile("[]");
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "effective-batch", `--pairs-file=${path}`),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain("0 pair(s)");
    expect(out()).toContain("(empty input)");
  });

  it("human-format renders one row per input pair preserving order", async () => {
    const path = await writePairsFile(
      JSON.stringify([
        { tenantId: TENANT_A, tableName: "workflow_traces" },
        { tenantId: TENANT_B, tableName: "llm_call_traces" },
      ]),
    );
    const resultMap = new Map<string, EffectiveRetentionResolution>([
      [
        `${TENANT_A}:workflow_traces`,
        {
          source: "tenant",
          retentionDays: 30,
          enabled: true,
          tenantId: TENANT_A,
        },
      ],
      [
        `${TENANT_B}:llm_call_traces`,
        { source: "platform", retentionDays: 90, enabled: true },
      ],
    ]);
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "effective-batch", `--pairs-file=${path}`),
      {
        ...ctx,
        retentionOverride: fakeRetention({ effectiveBatchResults: resultMap }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const output = out();
    expect(output).toContain("Effective retention for 2 pair(s):");
    expect(output).toContain(`${TENANT_A}  workflow_traces`);
    expect(output).toContain("source=tenant");
    expect(output).toContain("retention=30d");
    expect(output).toContain(`${TENANT_B}  llm_call_traces`);
    expect(output).toContain("retention=90d");
    const idxA = output.indexOf(TENANT_A);
    const idxB = output.indexOf(TENANT_B);
    expect(idxA).toBeLessThan(idxB);
  });

  it("JSON envelope shape {action, count, results[]}", async () => {
    const path = await writePairsFile(
      JSON.stringify([
        { tenantId: TENANT_A, tableName: "workflow_traces" },
      ]),
    );
    const resultMap = new Map<string, EffectiveRetentionResolution>([
      [
        `${TENANT_A}:workflow_traces`,
        {
          source: "tenant",
          retentionDays: 30,
          enabled: true,
          tenantId: TENANT_A,
        },
      ],
    ]);
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "effective-batch",
        `--pairs-file=${path}`,
        "--format=json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ effectiveBatchResults: resultMap }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsedOut = JSON.parse(out());
    expect(parsedOut.action).toBe("effective-batch");
    expect(parsedOut.count).toBe(1);
    expect(parsedOut.results).toHaveLength(1);
    expect(parsedOut.results[0]).toEqual({
      tenantId: TENANT_A,
      tableName: "workflow_traces",
      resolution: {
        source: "tenant",
        retentionDays: 30,
        enabled: true,
        tenantId: TENANT_A,
      },
    });
  });

  it("duplicate input pairs appear in output as duplicates (preserves 1:1 input/output)", async () => {
    const path = await writePairsFile(
      JSON.stringify([
        { tenantId: TENANT_A, tableName: "workflow_traces" },
        { tenantId: TENANT_A, tableName: "workflow_traces" },
      ]),
    );
    const resultMap = new Map<string, EffectiveRetentionResolution>([
      [
        `${TENANT_A}:workflow_traces`,
        {
          source: "tenant",
          retentionDays: 30,
          enabled: true,
          tenantId: TENANT_A,
        },
      ],
    ]);
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "effective-batch",
        `--pairs-file=${path}`,
        "--format=json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ effectiveBatchResults: resultMap }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsedOut = JSON.parse(out());
    expect(parsedOut.count).toBe(2);
    expect(parsedOut.results).toHaveLength(2);
  });

  it("adapter errors propagate as exit 1", async () => {
    const path = await writePairsFile(
      JSON.stringify([
        { tenantId: TENANT_A, tableName: "workflow_traces" },
      ]),
    );
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed("retention", "effective-batch", `--pairs-file=${path}`),
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

describe("formatEffectiveBatch", () => {
  it("renders 'empty input' message when results array is empty", () => {
    const out = formatEffectiveBatch([]);
    expect(out).toContain("0 pair(s)");
    expect(out).toContain("(empty input)");
  });

  it("renders count header + per-pair rows with summary lines", () => {
    const out = formatEffectiveBatch([
      {
        tenantId: TENANT_A,
        tableName: "workflow_traces",
        resolution: {
          source: "tenant",
          retentionDays: 30,
          enabled: true,
          tenantId: TENANT_A,
        },
      },
      {
        tenantId: TENANT_B,
        tableName: "llm_call_traces",
        resolution: { source: "platform", retentionDays: 90, enabled: true },
      },
    ]);
    expect(out).toContain("Effective retention for 2 pair(s):");
    expect(out).toContain(`${TENANT_A}  workflow_traces`);
    expect(out).toContain(`${TENANT_B}  llm_call_traces`);
    expect(out).toContain("source=tenant");
    expect(out).toContain("source=platform");
  });

  it("renders tenant_opt_out variant with reason + until inline", () => {
    const out = formatEffectiveBatch([
      {
        tenantId: TENANT_A,
        tableName: "workflow_traces",
        resolution: {
          source: "tenant_opt_out",
          retentionDays: null,
          enabled: false,
          tenantId: TENANT_A,
          optOutReason: "legal_hold:case#42",
          optOutUntil: "2099-01-01T00:00:00.000Z",
        },
      },
    ]);
    expect(out).toContain("source=tenant_opt_out");
    expect(out).toContain("reason=legal_hold:case#42");
    expect(out).toContain("until=2099-01-01T00:00:00.000Z");
  });

  it("renders 'indefinite' for null optOutUntil + '<no reason>' for null optOutReason", () => {
    const out = formatEffectiveBatch([
      {
        tenantId: TENANT_A,
        tableName: "workflow_traces",
        resolution: {
          source: "tenant_opt_out",
          retentionDays: null,
          enabled: false,
          tenantId: TENANT_A,
          optOutReason: null,
          optOutUntil: null,
        },
      },
    ]);
    expect(out).toContain("until=indefinite");
    expect(out).toContain("reason=<no reason>");
  });

  it("renders 'none' variant with '(no policy configured)' annotation", () => {
    const out = formatEffectiveBatch([
      {
        tenantId: TENANT_A,
        tableName: "workflow_traces",
        resolution: { source: "none", retentionDays: null, enabled: false },
      },
    ]);
    expect(out).toContain("source=none");
    expect(out).toContain("(no policy configured)");
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
      eventKinds: undefined,
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
      eventKinds: ["opt_out_set"],
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

  it("returns exit 2 on FIRST invalid --kind occurrence (multi)", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "history",
        "--kind",
        "opt_out_set",
        "--kind",
        "bogus",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("invalid --kind 'bogus'");
  });

  it("threads multi-element eventKinds array when --kind repeated", async () => {
    const { ctx } = buffers();
    const historyCapture: ListOptOutHistoryInput[] = [];
    const code = await runRetention(
      parsed(
        "retention",
        "history",
        "--kind",
        "opt_out_set",
        "--kind",
        "opt_out_cleared",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ historyCapture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(historyCapture[0]?.eventKinds).toEqual([
      "opt_out_set",
      "opt_out_cleared",
    ]);
  });

  it("JSON envelope echoes multi-element eventKinds array when --kind repeated", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "history",
        "--kind",
        "opt_out_set",
        "--kind",
        "policy_deleted",
        "--format=json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ historyEntries: [] }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsedJson = JSON.parse(out());
    expect(parsedJson.eventKinds).toEqual(["opt_out_set", "policy_deleted"]);
  });

  it("JSON envelope eventKinds=null when --kind NOT set", async () => {
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
    expect(parsedJson.eventKinds).toBeNull();
  });

  it("returns exit 2 on invalid --kind-not", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed("retention", "history", "--kind-not", "bogus"),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("invalid --kind-not 'bogus'");
  });

  it("threads eventKindsNot single-element array when --kind-not set once", async () => {
    const { ctx } = buffers();
    const historyCapture: ListOptOutHistoryInput[] = [];
    const code = await runRetention(
      parsed(
        "retention",
        "history",
        "--kind-not",
        "policy_deleted",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ historyCapture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(historyCapture[0]?.eventKindsNot).toEqual(["policy_deleted"]);
  });

  it("threads multi-element eventKindsNot array when --kind-not repeated", async () => {
    const { ctx } = buffers();
    const historyCapture: ListOptOutHistoryInput[] = [];
    const code = await runRetention(
      parsed(
        "retention",
        "history",
        "--kind-not",
        "policy_deleted",
        "--kind-not",
        "retention_set",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ historyCapture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(historyCapture[0]?.eventKindsNot).toEqual([
      "policy_deleted",
      "retention_set",
    ]);
  });

  it("composes --kind + --kind-not threading both independently", async () => {
    const { ctx } = buffers();
    const historyCapture: ListOptOutHistoryInput[] = [];
    const code = await runRetention(
      parsed(
        "retention",
        "history",
        "--kind",
        "opt_out_set",
        "--kind",
        "opt_out_cleared",
        "--kind-not",
        "policy_deleted",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ historyCapture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(historyCapture[0]?.eventKinds).toEqual([
      "opt_out_set",
      "opt_out_cleared",
    ]);
    expect(historyCapture[0]?.eventKindsNot).toEqual(["policy_deleted"]);
  });

  it("JSON envelope echoes eventKindsNot array when --kind-not set", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "history",
        "--kind-not",
        "policy_deleted",
        "--kind-not",
        "retention_set",
        "--format=json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ historyEntries: [] }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsedJson = JSON.parse(out());
    expect(parsedJson.eventKindsNot).toEqual([
      "policy_deleted",
      "retention_set",
    ]);
  });

  it("JSON envelope eventKindsNot=null when --kind-not NOT set", async () => {
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
    expect(parsedJson.eventKindsNot).toBeNull();
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
    expect(parsedJson.eventKinds).toEqual(["opt_out_set"]);
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

describe("runRetention history --with-actor-names (M6.7.zz.tenant.opt-out.history.actor-join)", () => {
  const ACTOR_A = "11111111-1111-4000-8000-111111111111";
  const ACTOR_B = "22222222-2222-4000-8000-222222222222";

  function historyEntry(
    overrides: Partial<OptOutHistoryEntry> = {},
  ): OptOutHistoryEntry {
    return {
      id: "h1",
      tenantId: TENANT_A,
      tableName: "workflow_traces",
      eventKind: "opt_out_set",
      actorId: ACTOR_A,
      occurredAt: "2026-05-21T00:00:00.000Z",
      prevState: null,
      nextState: { opt_out: true },
      attributes: {},
      ...overrides,
    };
  }

  it("threads joinActor=true to adapter when --with-actor-names is set", async () => {
    const capture: ListOptOutHistoryInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed("retention", "history", "--with-actor-names"),
      {
        ...ctx,
        retentionOverride: fakeRetention({ historyCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.joinActor).toBe(true);
  });

  it("omits joinActor from adapter input when --with-actor-names is NOT set (backward compat)", async () => {
    const capture: ListOptOutHistoryInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(parsed("retention", "history"), {
      ...ctx,
      retentionOverride: fakeRetention({ historyCapture: capture }),
    } as RetentionContext);
    expect(code).toBe(0);
    expect(capture[0]?.joinActor).toBeUndefined();
  });

  it("human-format renders display_name (uuid) when actorDisplayName is populated", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "history", "--with-actor-names"),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          historyEntries: [
            historyEntry({
              actorId: ACTOR_A,
              actorDisplayName: "Alice Smith",
              actorEmail: "alice@example.com",
            }),
          ],
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain(`actor=Alice Smith (${ACTOR_A})`);
  });

  it("human-format falls back to email when display_name is null", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "history", "--with-actor-names"),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          historyEntries: [
            historyEntry({
              actorId: ACTOR_B,
              actorDisplayName: null,
              actorEmail: "bob@example.com",
            }),
          ],
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain(`actor=bob@example.com (${ACTOR_B})`);
  });

  it("human-format falls back to raw UUID when both display_name and email are null (orphan FK)", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "history", "--with-actor-names"),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          historyEntries: [
            historyEntry({
              actorId: ACTOR_A,
              actorDisplayName: null,
              actorEmail: null,
            }),
          ],
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain(`actor=${ACTOR_A}`);
    expect(out()).not.toContain(`actor=null`);
    expect(out()).not.toContain(`actor= (`);
  });

  it("human-format renders <system> for null actor_id regardless of --with-actor-names", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "history", "--with-actor-names"),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          historyEntries: [
            historyEntry({
              actorId: null,
              actorDisplayName: null,
              actorEmail: null,
            }),
          ],
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain("actor=<system>");
  });

  it("human-format without --with-actor-names renders raw UUID (no display lookup)", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(parsed("retention", "history"), {
      ...ctx,
      retentionOverride: fakeRetention({
        historyEntries: [historyEntry({ actorId: ACTOR_A })],
      }),
    } as RetentionContext);
    expect(code).toBe(0);
    expect(out()).toContain(`actor=${ACTOR_A}`);
    expect(out()).not.toContain(`actor=${ACTOR_A} (`);
  });

  it("JSON envelope includes actorDisplayName + actorEmail fields when entries carry them", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "history",
        "--with-actor-names",
        "--format=json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          historyEntries: [
            historyEntry({
              actorId: ACTOR_A,
              actorDisplayName: "Alice",
              actorEmail: "alice@example.com",
            }),
          ],
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsedOut = JSON.parse(out());
    expect(parsedOut.entries[0].actorId).toBe(ACTOR_A);
    expect(parsedOut.entries[0].actorDisplayName).toBe("Alice");
    expect(parsedOut.entries[0].actorEmail).toBe("alice@example.com");
  });

  it("composes with other filters (--tenant + --kind + --with-actor-names)", async () => {
    const capture: ListOptOutHistoryInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "history",
        "--tenant",
        TENANT_A,
        "--kind",
        "opt_out_set",
        "--with-actor-names",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ historyCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]).toEqual({
      tenantId: TENANT_A,
      tableName: undefined,
      eventKinds: ["opt_out_set"],
      since: undefined,
      until: undefined,
      limit: 100,
      afterId: undefined,
      joinActor: true,
    });
  });
});

describe("runRetention history --actor-id (M6.7.zz.tenant.opt-out.cli.history.actor-filter + actor-filter.multi)", () => {
  const ACTOR_A = "11111111-1111-4000-8000-111111111111";
  const ACTOR_B = "22222222-2222-4000-8000-222222222222";
  const ACTOR_C = "33333333-3333-4000-8000-333333333333";

  it("threads actorIds as single-element array when --actor-id set once", async () => {
    const capture: ListOptOutHistoryInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed("retention", "history", "--actor-id", ACTOR_A),
      {
        ...ctx,
        retentionOverride: fakeRetention({ historyCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.actorIds).toEqual([ACTOR_A]);
  });

  it("threads multi-element actorIds when --actor-id repeated", async () => {
    const capture: ListOptOutHistoryInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "history",
        "--actor-id",
        ACTOR_A,
        "--actor-id",
        ACTOR_B,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ historyCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.actorIds).toEqual([ACTOR_A, ACTOR_B]);
  });

  it("omits actorIds from adapter input when --actor-id NOT set (backward compat)", async () => {
    const capture: ListOptOutHistoryInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(parsed("retention", "history"), {
      ...ctx,
      retentionOverride: fakeRetention({ historyCapture: capture }),
    } as RetentionContext);
    expect(code).toBe(0);
    expect(capture[0]?.actorIds).toBeUndefined();
  });

  it("composes with other filters (--tenant + multi --actor-id + --kind)", async () => {
    const capture: ListOptOutHistoryInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "history",
        "--tenant",
        TENANT_A,
        "--actor-id",
        ACTOR_A,
        "--actor-id",
        ACTOR_B,
        "--kind",
        "opt_out_set",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ historyCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.tenantId).toBe(TENANT_A);
    expect(capture[0]?.eventKinds).toEqual(["opt_out_set"]);
    expect(capture[0]?.actorIds).toEqual([ACTOR_A, ACTOR_B]);
  });

  it("composes with --with-actor-names (multi actor-id filter + LEFT JOIN names)", async () => {
    const capture: ListOptOutHistoryInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "history",
        "--actor-id",
        ACTOR_A,
        "--actor-id",
        ACTOR_C,
        "--with-actor-names",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ historyCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.actorIds).toEqual([ACTOR_A, ACTOR_C]);
    expect(capture[0]?.joinActor).toBe(true);
  });

  it("JSON envelope echoes actorIds array when --actor-id set once", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "history",
        "--actor-id",
        ACTOR_A,
        "--format=json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsedOut = JSON.parse(out());
    expect(parsedOut.actorIds).toEqual([ACTOR_A]);
  });

  it("JSON envelope echoes multi-element actorIds when --actor-id repeated", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "history",
        "--actor-id",
        ACTOR_A,
        "--actor-id",
        ACTOR_B,
        "--format=json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsedOut = JSON.parse(out());
    expect(parsedOut.actorIds).toEqual([ACTOR_A, ACTOR_B]);
  });

  it("JSON envelope actorIds is null when --actor-id NOT set", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "history", "--format=json"),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsedOut = JSON.parse(out());
    expect(parsedOut.actorIds).toBeNull();
  });

  it("human-format empty-result message preserved when --actor-id has no matches", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "history", "--actor-id", ACTOR_B),
      {
        ...ctx,
        retentionOverride: fakeRetention({ historyEntries: [] }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain("no history entries match");
  });
});

describe("runRetention history --actor-id-not (M6.7.zz.tenant.opt-out.cli.history.actor-not + actor-not.multi)", () => {
  const ACTOR_ALICE = "11111111-0000-4000-8000-000000000001";
  const ACTOR_BOB = "22222222-0000-4000-8000-000000000002";
  const ACTOR_CAROL = "33333333-0000-4000-8000-000000000003";

  it("threads actorIdsNot as single-element array when --actor-id-not set once", async () => {
    const capture: ListOptOutHistoryInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed("retention", "history", "--actor-id-not", ACTOR_ALICE),
      {
        ...ctx,
        retentionOverride: fakeRetention({ historyCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.actorIdsNot).toEqual([ACTOR_ALICE]);
  });

  it("threads multi-element actorIdsNot when --actor-id-not repeated", async () => {
    const capture: ListOptOutHistoryInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "history",
        "--actor-id-not",
        ACTOR_ALICE,
        "--actor-id-not",
        ACTOR_BOB,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ historyCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.actorIdsNot).toEqual([ACTOR_ALICE, ACTOR_BOB]);
  });

  it("omits actorIdsNot when --actor-id-not NOT set (backward compat)", async () => {
    const capture: ListOptOutHistoryInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(parsed("retention", "history"), {
      ...ctx,
      retentionOverride: fakeRetention({ historyCapture: capture }),
    } as RetentionContext);
    expect(code).toBe(0);
    expect(capture[0]?.actorIdsNot).toBeUndefined();
  });

  it("composes with --actor-id (positive + negative both threaded independently)", async () => {
    const capture: ListOptOutHistoryInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "history",
        "--actor-id",
        ACTOR_ALICE,
        "--actor-id-not",
        ACTOR_BOB,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ historyCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.actorIds).toEqual([ACTOR_ALICE]);
    expect(capture[0]?.actorIdsNot).toEqual([ACTOR_BOB]);
  });

  it("composes with --tenant + --with-actor-names + multi --actor-id-not", async () => {
    const capture: ListOptOutHistoryInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "history",
        "--tenant",
        TENANT_A,
        "--actor-id-not",
        ACTOR_ALICE,
        "--actor-id-not",
        ACTOR_CAROL,
        "--with-actor-names",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ historyCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.tenantId).toBe(TENANT_A);
    expect(capture[0]?.actorIdsNot).toEqual([ACTOR_ALICE, ACTOR_CAROL]);
    expect(capture[0]?.joinActor).toBe(true);
  });

  it("JSON envelope echoes actorIdsNot array when --actor-id-not set once", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "history",
        "--actor-id-not",
        ACTOR_ALICE,
        "--format",
        "json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ historyResults: [] }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.actorIdsNot).toEqual([ACTOR_ALICE]);
  });

  it("JSON envelope echoes multi-element actorIdsNot when --actor-id-not repeated", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "history",
        "--actor-id-not",
        ACTOR_ALICE,
        "--actor-id-not",
        ACTOR_BOB,
        "--format",
        "json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ historyResults: [] }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.actorIdsNot).toEqual([ACTOR_ALICE, ACTOR_BOB]);
  });

  it("JSON envelope actorIdsNot=null when --actor-id-not NOT set", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "history", "--format", "json"),
      {
        ...ctx,
        retentionOverride: fakeRetention({ historyResults: [] }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.actorIdsNot).toBeNull();
  });
});

describe("runRetention history --system-only / --no-system (M6.7.zz.tenant.opt-out.cli.history.system-only)", () => {
  const ACTOR_ALICE = "11111111-0000-4000-8000-000000000001";

  it("returns exit 2 when --system-only AND --no-system both set", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed("retention", "history", "--system-only", "--no-system"),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain(
      "--system-only and --no-system are mutually exclusive",
    );
  });

  it("threads actorPresence='system_only' when --system-only set", async () => {
    const capture: ListOptOutHistoryInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed("retention", "history", "--system-only"),
      {
        ...ctx,
        retentionOverride: fakeRetention({ historyCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.actorPresence).toBe("system_only");
  });

  it("threads actorPresence='no_system' when --no-system set", async () => {
    const capture: ListOptOutHistoryInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed("retention", "history", "--no-system"),
      {
        ...ctx,
        retentionOverride: fakeRetention({ historyCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.actorPresence).toBe("no_system");
  });

  it("omits actorPresence when neither flag set (backward compat)", async () => {
    const capture: ListOptOutHistoryInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(parsed("retention", "history"), {
      ...ctx,
      retentionOverride: fakeRetention({ historyCapture: capture }),
    } as RetentionContext);
    expect(code).toBe(0);
    expect(capture[0]?.actorPresence).toBeUndefined();
  });

  it("composes with --tenant + --system-only", async () => {
    const capture: ListOptOutHistoryInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "history",
        "--tenant",
        TENANT_A,
        "--system-only",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ historyCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.tenantId).toBe(TENANT_A);
    expect(capture[0]?.actorPresence).toBe("system_only");
  });

  it("composes with --actor-id-not + --no-system (redundant but valid)", async () => {
    const capture: ListOptOutHistoryInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "history",
        "--actor-id-not",
        ACTOR_ALICE,
        "--no-system",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ historyCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.actorIdsNot).toEqual([ACTOR_ALICE]);
    expect(capture[0]?.actorPresence).toBe("no_system");
  });

  it("JSON envelope echoes systemOnly=true + noSystem=false when --system-only set", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "history", "--system-only", "--format", "json"),
      {
        ...ctx,
        retentionOverride: fakeRetention({ historyResults: [] }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.systemOnly).toBe(true);
    expect(parsed_.noSystem).toBe(false);
  });

  it("JSON envelope echoes noSystem=true + systemOnly=false when --no-system set", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "history", "--no-system", "--format", "json"),
      {
        ...ctx,
        retentionOverride: fakeRetention({ historyResults: [] }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.systemOnly).toBe(false);
    expect(parsed_.noSystem).toBe(true);
  });

  it("JSON envelope systemOnly=false + noSystem=false when neither flag set", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "history", "--format", "json"),
      {
        ...ctx,
        retentionOverride: fakeRetention({ historyResults: [] }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.systemOnly).toBe(false);
    expect(parsed_.noSystem).toBe(false);
  });
});

describe("runRetention history --before-id (M6.7.zz.tenant.opt-out.history.before-id)", () => {
  const BEFORE_ID = "70000000-0000-4000-8000-000000000007";
  const AFTER_ID = "50000000-0000-4000-8000-000000000005";
  const FIRST_ID = "ff000000-0000-4000-8000-0000000000ff";
  const LAST_ID = "11000000-0000-4000-8000-000000000011";

  it("threads beforeId to adapter when --before-id set", async () => {
    const capture: ListOptOutHistoryInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed("retention", "history", "--before-id", BEFORE_ID),
      {
        ...ctx,
        retentionOverride: fakeRetention({ historyCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.beforeId).toBe(BEFORE_ID);
  });

  it("omits beforeId when --before-id NOT set (backward compat)", async () => {
    const capture: ListOptOutHistoryInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(parsed("retention", "history"), {
      ...ctx,
      retentionOverride: fakeRetention({ historyCapture: capture }),
    } as RetentionContext);
    expect(code).toBe(0);
    expect(capture[0]?.beforeId).toBeUndefined();
  });

  it("returns exit 2 when --after-id and --before-id are both set (mutually exclusive)", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "history",
        "--after-id",
        AFTER_ID,
        "--before-id",
        BEFORE_ID,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("mutually exclusive");
  });

  it("JSON envelope echoes beforeId field when --before-id set", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "history",
        "--before-id",
        BEFORE_ID,
        "--format",
        "json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ historyEntries: [] }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.beforeId).toBe(BEFORE_ID);
  });

  it("JSON envelope beforeId=null when --before-id NOT set", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "history", "--format", "json"),
      {
        ...ctx,
        retentionOverride: fakeRetention({ historyEntries: [] }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.beforeId).toBeNull();
  });

  it("JSON envelope nextBeforeId is the FIRST entry id when entries.length === limit", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "history",
        "--limit",
        "2",
        "--format",
        "json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          historyEntries: [
            {
              id: FIRST_ID,
              tenantId: "00000000-0000-4000-8000-00000000000A",
              tableName: "workflow_traces",
              eventKind: "opt_out_set",
              actorId: null,
              occurredAt: "2026-06-01T00:00:00.000Z",
              prevState: null,
              nextState: { opt_out: true },
              attributes: {},
            },
            {
              id: LAST_ID,
              tenantId: "00000000-0000-4000-8000-00000000000A",
              tableName: "workflow_traces",
              eventKind: "retention_set",
              actorId: null,
              occurredAt: "2026-01-01T00:00:00.000Z",
              prevState: null,
              nextState: { retention_days: 90 },
              attributes: {},
            },
          ],
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.nextBeforeId).toBe(FIRST_ID);
    expect(parsed_.nextAfterId).toBe(LAST_ID);
  });

  it("JSON envelope nextBeforeId=null when entries.length < limit", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "history", "--format", "json"),
      {
        ...ctx,
        retentionOverride: fakeRetention({ historyEntries: [] }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.nextBeforeId).toBeNull();
  });

  it("human-format prints previous-page hint when entries.length === limit", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "history", "--limit", "1"),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          historyEntries: [
            {
              id: FIRST_ID,
              tenantId: "00000000-0000-4000-8000-00000000000A",
              tableName: "workflow_traces",
              eventKind: "opt_out_set",
              actorId: null,
              occurredAt: "2026-06-01T00:00:00.000Z",
              prevState: null,
              nextState: { opt_out: true },
              attributes: {},
            },
          ],
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain("previous page: crossengin retention history --before-id");
    expect(out()).toContain(FIRST_ID);
  });

  it("human-format omits previous-page hint when entries.length < limit", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "history"),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          historyEntries: [
            {
              id: FIRST_ID,
              tenantId: "00000000-0000-4000-8000-00000000000A",
              tableName: "workflow_traces",
              eventKind: "opt_out_set",
              actorId: null,
              occurredAt: "2026-06-01T00:00:00.000Z",
              prevState: null,
              nextState: { opt_out: true },
              attributes: {},
            },
          ],
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).not.toContain("previous page");
  });

  it("composes with all other filters (--tenant + --table + --kind + --actor-id + --since + --until + --before-id + --limit)", async () => {
    const capture: ListOptOutHistoryInput[] = [];
    const { ctx } = buffers();
    const TENANT = "00000000-0000-4000-8000-00000000000A";
    const ACTOR_A = "11111111-1111-4000-8000-111111111111";
    const code = await runRetention(
      parsed(
        "retention",
        "history",
        "--tenant",
        TENANT,
        "--table",
        "workflow_traces",
        "--kind",
        "opt_out_set",
        "--actor-id",
        ACTOR_A,
        "--since",
        "2026-01-01",
        "--until",
        "2026-06-01",
        "--before-id",
        BEFORE_ID,
        "--limit",
        "50",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ historyCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.tenantId).toBe(TENANT);
    expect(capture[0]?.tableName).toBe("workflow_traces");
    expect(capture[0]?.eventKinds).toEqual(["opt_out_set"]);
    expect(capture[0]?.actorIds).toEqual([ACTOR_A]);
    expect(capture[0]?.beforeId).toBe(BEFORE_ID);
    expect(capture[0]?.limit).toBe(50);
  });
});

describe("runRetention history --range (M6.7.zz.tenant.opt-out.cli.history.range)", () => {
  const AFTER_ID = "50000000-0000-4000-8000-000000000005";
  const BEFORE_ID = "70000000-0000-4000-8000-000000000007";

  it("parses --range <after>..<before> and threads both cursors to adapter", async () => {
    const capture: ListOptOutHistoryInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "history",
        "--range",
        `${AFTER_ID}..${BEFORE_ID}`,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ historyCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.afterId).toBe(AFTER_ID);
    expect(capture[0]?.beforeId).toBe(BEFORE_ID);
  });

  it("returns exit 2 when --range is missing the separator", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed("retention", "history", "--range", AFTER_ID),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("invalid --range");
    expect(err()).toContain("<after-id>..<before-id>");
  });

  it("returns exit 2 when --range has empty after-id half", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed("retention", "history", "--range", `..${BEFORE_ID}`),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("invalid --range");
  });

  it("returns exit 2 when --range has empty before-id half", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed("retention", "history", "--range", `${AFTER_ID}..`),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("invalid --range");
  });

  it("returns exit 2 when --range combined with --after-id", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "history",
        "--range",
        `${AFTER_ID}..${BEFORE_ID}`,
        "--after-id",
        AFTER_ID,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("--range cannot be combined with --after-id or --before-id");
  });

  it("returns exit 2 when --range combined with --before-id", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "history",
        "--range",
        `${AFTER_ID}..${BEFORE_ID}`,
        "--before-id",
        BEFORE_ID,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("--range cannot be combined with");
  });

  it("JSON envelope echoes range field + afterId + beforeId when --range set", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "history",
        "--range",
        `${AFTER_ID}..${BEFORE_ID}`,
        "--format",
        "json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ historyEntries: [] }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.range).toBe(`${AFTER_ID}..${BEFORE_ID}`);
    expect(parsed_.afterId).toBe(AFTER_ID);
    expect(parsed_.beforeId).toBe(BEFORE_ID);
  });

  it("JSON envelope range=null when --range not set", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "history", "--format", "json"),
      {
        ...ctx,
        retentionOverride: fakeRetention({ historyEntries: [] }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.range).toBeNull();
  });

  it("composes with all other filters (--tenant + --kind + --limit + --range)", async () => {
    const capture: ListOptOutHistoryInput[] = [];
    const TENANT = "00000000-0000-4000-8000-00000000000A";
    const ACTOR_A = "11111111-1111-4000-8000-111111111111";
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "history",
        "--tenant",
        TENANT,
        "--table",
        "workflow_traces",
        "--kind",
        "opt_out_set",
        "--actor-id",
        ACTOR_A,
        "--range",
        `${AFTER_ID}..${BEFORE_ID}`,
        "--limit",
        "25",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ historyCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.tenantId).toBe(TENANT);
    expect(capture[0]?.tableName).toBe("workflow_traces");
    expect(capture[0]?.eventKinds).toEqual(["opt_out_set"]);
    expect(capture[0]?.actorIds).toEqual([ACTOR_A]);
    expect(capture[0]?.afterId).toBe(AFTER_ID);
    expect(capture[0]?.beforeId).toBe(BEFORE_ID);
    expect(capture[0]?.limit).toBe(25);
  });

  it("bare --after-id + --before-id (without --range) still mutually exclusive with helpful message pointing at --range", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "history",
        "--after-id",
        AFTER_ID,
        "--before-id",
        BEFORE_ID,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("mutually exclusive");
    expect(err()).toContain("--range");
  });
});

describe("formatActor (M6.7.zz.tenant.opt-out.history.actor-join)", () => {
  const ACTOR = "11111111-1111-4000-8000-111111111111";

  it("renders display_name (uuid) when both display_name and email are present", () => {
    const out = formatHistoryList(
      [
        {
          id: "h1",
          tenantId: TENANT_A,
          tableName: "workflow_traces",
          eventKind: "opt_out_set",
          actorId: ACTOR,
          actorDisplayName: "Alice Smith",
          actorEmail: "alice@example.com",
          occurredAt: "2026-05-21T00:00:00.000Z",
          prevState: null,
          nextState: { opt_out: true },
          attributes: {},
        },
      ],
      100,
      null,
    );
    expect(out).toContain(`actor=Alice Smith (${ACTOR})`);
  });

  it("falls back to email when display_name is null", () => {
    const out = formatHistoryList(
      [
        {
          id: "h1",
          tenantId: TENANT_A,
          tableName: "workflow_traces",
          eventKind: "opt_out_set",
          actorId: ACTOR,
          actorDisplayName: null,
          actorEmail: "alice@example.com",
          occurredAt: "2026-05-21T00:00:00.000Z",
          prevState: null,
          nextState: { opt_out: true },
          attributes: {},
        },
      ],
      100,
      null,
    );
    expect(out).toContain(`actor=alice@example.com (${ACTOR})`);
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

describe("runRetention restore --dry-run (M6.7.zz.tenant.opt-out.cli.restore.dry-run)", () => {
  const HISTORY_ID = "30000000-0000-4000-8000-000000000003";

  it("--dry-run calls previewRestoreTenantPolicy not restoreTenantPolicy", async () => {
    const { ctx } = buffers();
    const previewRestoreCapture: PreviewRestoreTenantPolicyInput[] = [];
    const restoreCapture: RestoreTenantPolicyInput[] = [];
    const code = await runRetention(
      parsed("retention", "restore", HISTORY_ID, "--dry-run"),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          previewRestoreCapture,
          restoreCapture,
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(previewRestoreCapture).toHaveLength(1);
    expect(restoreCapture).toHaveLength(0);
  });

  it("threads historyId to preview adapter", async () => {
    const { ctx } = buffers();
    const previewRestoreCapture: PreviewRestoreTenantPolicyInput[] = [];
    const code = await runRetention(
      parsed("retention", "restore", HISTORY_ID, "--dry-run"),
      {
        ...ctx,
        retentionOverride: fakeRetention({ previewRestoreCapture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(previewRestoreCapture[0]).toEqual({ historyId: HISTORY_ID });
  });

  it("--dry-run ignores --actor flag (preview is read-only — no audit row written)", async () => {
    const { ctx } = buffers();
    const previewRestoreCapture: PreviewRestoreTenantPolicyInput[] = [];
    const code = await runRetention(
      parsed(
        "retention",
        "restore",
        HISTORY_ID,
        "--dry-run",
        "--actor",
        "11111111-1111-4111-8111-111111111111",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ previewRestoreCapture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(previewRestoreCapture[0]).toEqual({ historyId: HISTORY_ID });
  });

  it("human-format renders preview header + source-history + action for would_delete", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "restore", HISTORY_ID, "--dry-run"),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          previewRestoreResult: {
            kind: "would_delete",
            tenantId: TENANT_A,
            tableName: "workflow_traces",
            sourceHistoryId: HISTORY_ID,
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain("Restore preview (no changes applied)");
    expect(out()).toContain(`Source history: ${HISTORY_ID}`);
    expect(out()).toContain(`Tenant:         ${TENANT_A}`);
    expect(out()).toContain("Action:         deleteTenantPolicy");
    expect(out()).toContain("(prev_state was null)");
  });

  it("human-format renders would_set_opt_out with retention + until + reason", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "restore", HISTORY_ID, "--dry-run"),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          previewRestoreResult: {
            kind: "would_set_opt_out",
            tenantId: TENANT_A,
            tableName: "workflow_traces",
            retentionDays: 90,
            optOutUntil: "2027-01-01T00:00:00.000Z",
            optOutReason: "legal_hold:case#42",
            sourceHistoryId: HISTORY_ID,
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain("Action:         setTenantOptOut");
    expect(out()).toContain("retention_days: 90");
    expect(out()).toContain("opt_out_until:  2027-01-01T00:00:00.000Z");
    expect(out()).toContain("opt_out_reason: legal_hold:case#42");
  });

  it("human-format renders 'indefinite' for null optOutUntil + '<no reason>' for null reason", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "restore", HISTORY_ID, "--dry-run"),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          previewRestoreResult: {
            kind: "would_set_opt_out",
            tenantId: TENANT_A,
            tableName: "workflow_traces",
            retentionDays: 365,
            optOutUntil: null,
            optOutReason: null,
            sourceHistoryId: HISTORY_ID,
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain("opt_out_until:  indefinite");
    expect(out()).toContain("opt_out_reason: <no reason>");
  });

  it("human-format renders would_set_retention with retention + enabled", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "restore", HISTORY_ID, "--dry-run"),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          previewRestoreResult: {
            kind: "would_set_retention",
            tenantId: TENANT_A,
            tableName: "workflow_traces",
            retentionDays: 30,
            enabled: true,
            sourceHistoryId: HISTORY_ID,
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain("Action:         setTenantRetention");
    expect(out()).toContain("retention_days: 30");
    expect(out()).toContain("enabled:        yes");
  });

  it("json-format emits envelope {action, dryRun:true, historyId, preview}", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "restore",
        HISTORY_ID,
        "--dry-run",
        "--format=json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          previewRestoreResult: {
            kind: "would_delete",
            tenantId: TENANT_A,
            tableName: "workflow_traces",
            sourceHistoryId: HISTORY_ID,
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsedJson = JSON.parse(out());
    expect(parsedJson.action).toBe("restore");
    expect(parsedJson.dryRun).toBe(true);
    expect(parsedJson.historyId).toBe(HISTORY_ID);
    expect(parsedJson.preview.kind).toBe("would_delete");
  });

  it("json-format live mode (no --dry-run) emits dryRun:false discriminator", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "restore", HISTORY_ID, "--format=json"),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsedJson = JSON.parse(out());
    expect(parsedJson.dryRun).toBe(false);
    expect(parsedJson.result).toBeDefined();
  });

  it("--dry-run propagates preview-adapter errors as exit 1", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed("retention", "restore", HISTORY_ID, "--dry-run"),
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

describe("formatRestorePreview", () => {
  const HISTORY_ID = "30000000-0000-4000-8000-000000000003";

  it("renders would_delete with 'prev_state was null' annotation", () => {
    const out = formatRestorePreview({
      kind: "would_delete",
      tenantId: TENANT_A,
      tableName: "workflow_traces",
      sourceHistoryId: HISTORY_ID,
    });
    expect(out).toContain("deleteTenantPolicy (prev_state was null)");
  });

  it("renders would_set_opt_out with all three fields", () => {
    const out = formatRestorePreview({
      kind: "would_set_opt_out",
      tenantId: TENANT_A,
      tableName: "workflow_traces",
      retentionDays: 90,
      optOutUntil: "2027-01-01T00:00:00.000Z",
      optOutReason: "legal_hold:case#42",
      sourceHistoryId: HISTORY_ID,
    });
    expect(out).toContain("retention_days: 90");
    expect(out).toContain("opt_out_until:  2027-01-01T00:00:00.000Z");
    expect(out).toContain("opt_out_reason: legal_hold:case#42");
  });

  it("renders would_set_retention with enabled:no when disabled", () => {
    const out = formatRestorePreview({
      kind: "would_set_retention",
      tenantId: TENANT_A,
      tableName: "workflow_traces",
      retentionDays: 30,
      enabled: false,
      sourceHistoryId: HISTORY_ID,
    });
    expect(out).toContain("enabled:        no");
  });

  it("includes the source history id in every variant", () => {
    for (const preview of [
      {
        kind: "would_delete" as const,
        tenantId: TENANT_A,
        tableName: "workflow_traces",
        sourceHistoryId: HISTORY_ID,
      },
      {
        kind: "would_set_opt_out" as const,
        tenantId: TENANT_A,
        tableName: "workflow_traces",
        retentionDays: 90,
        optOutUntil: null,
        optOutReason: null,
        sourceHistoryId: HISTORY_ID,
      },
      {
        kind: "would_set_retention" as const,
        tenantId: TENANT_A,
        tableName: "workflow_traces",
        retentionDays: 30,
        enabled: true,
        sourceHistoryId: HISTORY_ID,
      },
    ]) {
      expect(formatRestorePreview(preview)).toContain(
        `Source history: ${HISTORY_ID}`,
      );
    }
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

describe("runRetention diff-history --kind (M6.7.zz.tenant.opt-out.cli.diff-history.kind-filter + .multi)", () => {
  const ID_A = "aa000000-0000-4000-8000-0000000000aa";
  const ID_B = "bb000000-0000-4000-8000-0000000000bb";

  it("returns exit 2 when --kind is invalid value", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--kind",
        "not_a_kind",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("invalid --kind");
    expect(err()).toContain("opt_out_set");
  });

  it("returns exit 2 on FIRST invalid --kind occurrence when multiple flags supplied", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--kind",
        "opt_out_set",
        "--kind",
        "bogus_kind",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("invalid --kind 'bogus_kind'");
  });

  it("threads eventKinds as single-element array when --kind set once", async () => {
    const capture: DiffHistoryEntriesInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--kind",
        "opt_out_set",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.eventKinds).toEqual(["opt_out_set"]);
  });

  it("threads multi-element eventKinds when --kind repeated", async () => {
    const capture: DiffHistoryEntriesInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--kind",
        "opt_out_set",
        "--kind",
        "opt_out_cleared",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.eventKinds).toEqual([
      "opt_out_set",
      "opt_out_cleared",
    ]);
  });

  it("omits eventKinds when --kind NOT set (backward compat)", async () => {
    const capture: DiffHistoryEntriesInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed("retention", "diff-history", ID_A, ID_B),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.eventKinds).toBeUndefined();
  });

  it("adapter mismatch error propagates as exit 1 with new always-list error format", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--kind",
        "opt_out_set",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          throws: new Error(
            "diffHistoryEntries: expected both events to have event_kind in ['opt_out_set'] but A is 'retention_set'",
          ),
        }),
      } as RetentionContext,
    );
    expect(code).toBe(1);
    expect(err()).toContain(
      "expected both events to have event_kind in ['opt_out_set']",
    );
    expect(err()).toContain("A is 'retention_set'");
  });

  it("multi-value adapter error propagates with multi-value list format", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--kind",
        "opt_out_set",
        "--kind",
        "opt_out_cleared",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          throws: new Error(
            "diffHistoryEntries: expected both events to have event_kind in ['opt_out_set', 'opt_out_cleared'] but A is 'policy_deleted'",
          ),
        }),
      } as RetentionContext,
    );
    expect(code).toBe(1);
    expect(err()).toContain(
      "expected both events to have event_kind in ['opt_out_set', 'opt_out_cleared']",
    );
  });

  it("JSON envelope echoes kinds single-element array when --kind set once", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--kind",
        "policy_deleted",
        "--format",
        "json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.action).toBe("diff-history");
    expect(parsed_.kinds).toEqual(["policy_deleted"]);
  });

  it("JSON envelope echoes multi-element kinds array when --kind repeated", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--kind",
        "opt_out_set",
        "--kind",
        "opt_out_cleared",
        "--format",
        "json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.kinds).toEqual(["opt_out_set", "opt_out_cleared"]);
  });

  it("JSON envelope kinds=null when --kind NOT set", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "diff-history", ID_A, ID_B, "--format", "json"),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.kinds).toBeNull();
  });
});

describe("runRetention diff-history --actor-id (M6.7.zz.tenant.opt-out.cli.diff-history.actor-filter + .multi)", () => {
  const ID_A = "aa000000-0000-4000-8000-0000000000aa";
  const ID_B = "bb000000-0000-4000-8000-0000000000bb";
  const ACTOR_ALICE = "11111111-0000-4000-8000-000000000001";
  const ACTOR_BOB = "22222222-0000-4000-8000-000000000002";
  const ACTOR_CAROL = "33333333-0000-4000-8000-000000000003";

  it("threads single-element actorIds array when --actor-id set once", async () => {
    const capture: DiffHistoryEntriesInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--actor-id",
        ACTOR_ALICE,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.actorIds).toEqual([ACTOR_ALICE]);
  });

  it("threads multi-element actorIds array when --actor-id repeated", async () => {
    const capture: DiffHistoryEntriesInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--actor-id",
        ACTOR_ALICE,
        "--actor-id",
        ACTOR_BOB,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.actorIds).toEqual([ACTOR_ALICE, ACTOR_BOB]);
  });

  it("omits actorIds when --actor-id NOT set (backward compat)", async () => {
    const capture: DiffHistoryEntriesInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed("retention", "diff-history", ID_A, ID_B),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.actorIds).toBeUndefined();
  });

  it("composes with --kind threading both eventKinds and actorIds", async () => {
    const capture: DiffHistoryEntriesInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--kind",
        "opt_out_set",
        "--actor-id",
        ACTOR_ALICE,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.eventKinds).toEqual(["opt_out_set"]);
    expect(capture[0]?.actorIds).toEqual([ACTOR_ALICE]);
  });

  it("composes with --actor-id-not threading both as independent dimensions", async () => {
    const capture: DiffHistoryEntriesInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--actor-id",
        ACTOR_ALICE,
        "--actor-id-not",
        ACTOR_CAROL,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.actorIds).toEqual([ACTOR_ALICE]);
    expect(capture[0]?.actorIdsNot).toEqual([ACTOR_CAROL]);
  });

  it("adapter mismatch error propagates as exit 1 with multi-value error format", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--actor-id",
        ACTOR_ALICE,
        "--actor-id",
        ACTOR_BOB,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          throws: new Error(
            `diffHistoryEntries: expected both events to have actor_id in ['${ACTOR_ALICE}', '${ACTOR_BOB}'] but A is '${ACTOR_CAROL}'`,
          ),
        }),
      } as RetentionContext,
    );
    expect(code).toBe(1);
    expect(err()).toContain(
      `expected both events to have actor_id in ['${ACTOR_ALICE}', '${ACTOR_BOB}']`,
    );
    expect(err()).toContain(`A is '${ACTOR_CAROL}'`);
  });

  it("JSON envelope echoes single-element actorIds array when --actor-id set once", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--actor-id",
        ACTOR_ALICE,
        "--format",
        "json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.action).toBe("diff-history");
    expect(parsed_.actorIds).toEqual([ACTOR_ALICE]);
  });

  it("JSON envelope echoes multi-element actorIds array when --actor-id repeated", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--actor-id",
        ACTOR_ALICE,
        "--actor-id",
        ACTOR_BOB,
        "--format",
        "json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.actorIds).toEqual([ACTOR_ALICE, ACTOR_BOB]);
  });

  it("JSON envelope actorIds=null when --actor-id NOT set", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "diff-history", ID_A, ID_B, "--format", "json"),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.actorIds).toBeNull();
  });

  it("composes with per-side --actor-id-a threading both global and per-side independently", async () => {
    const capture: DiffHistoryEntriesInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--actor-id",
        ACTOR_ALICE,
        "--actor-id",
        ACTOR_BOB,
        "--actor-id-a",
        ACTOR_ALICE,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.actorIds).toEqual([ACTOR_ALICE, ACTOR_BOB]);
    expect(capture[0]?.actorIdsA).toEqual([ACTOR_ALICE]);
  });
});

describe("runRetention diff-history --with-actor-names (M6.7.zz.tenant.opt-out.cli.diff-history.with-actor-names)", () => {
  const ID_A = "aa000000-0000-4000-8000-0000000000aa";
  const ID_B = "bb000000-0000-4000-8000-0000000000bb";
  const ACTOR_ALICE = "11111111-0000-4000-8000-000000000001";
  const ACTOR_BOB = "22222222-0000-4000-8000-000000000002";

  it("threads joinActor=true to adapter when --with-actor-names is set", async () => {
    const capture: DiffHistoryEntriesInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--with-actor-names",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.joinActor).toBe(true);
  });

  it("omits joinActor when --with-actor-names NOT set (backward compat)", async () => {
    const capture: DiffHistoryEntriesInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed("retention", "diff-history", ID_A, ID_B),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.joinActor).toBeUndefined();
  });

  it("human-format renders 'by Alice Smith (uuid)' suffix for each event when names populated", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--with-actor-names",
      ),
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
            actorIdA: ACTOR_ALICE,
            actorIdB: ACTOR_BOB,
            actorDisplayNameA: "Alice Smith",
            actorDisplayNameB: "Bob Jones",
            actorEmailA: "alice@example.com",
            actorEmailB: "bob@example.com",
            fieldDiffs: [],
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain(`by Alice Smith (${ACTOR_ALICE})`);
    expect(out()).toContain(`by Bob Jones (${ACTOR_BOB})`);
  });

  it("human-format renders <system> for null actor_id with --with-actor-names", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--with-actor-names",
      ),
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
            actorIdA: null,
            actorIdB: ACTOR_BOB,
            actorDisplayNameA: null,
            actorDisplayNameB: "Bob Jones",
            actorEmailA: null,
            actorEmailB: "bob@example.com",
            fieldDiffs: [],
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain("by <system>");
    expect(out()).toContain(`by Bob Jones (${ACTOR_BOB})`);
  });

  it("human-format falls back to email when display_name is null", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--with-actor-names",
      ),
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
            actorIdA: ACTOR_ALICE,
            actorIdB: ACTOR_BOB,
            actorDisplayNameA: null,
            actorDisplayNameB: null,
            actorEmailA: "alice@example.com",
            actorEmailB: null,
            fieldDiffs: [],
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain(`by alice@example.com (${ACTOR_ALICE})`);
    expect(out()).toContain(`by ${ACTOR_BOB}`);
  });

  it("human-format omits 'by ...' suffix when --with-actor-names NOT set", async () => {
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
            actorIdA: ACTOR_ALICE,
            actorIdB: ACTOR_BOB,
            fieldDiffs: [],
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).not.toContain("by Alice");
    expect(out()).not.toContain("by <system>");
    expect(out()).not.toMatch(/\)\s*by\s+/);
  });

  it("JSON envelope echoes withActorNames=true and actor fields when set", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--with-actor-names",
        "--format",
        "json",
      ),
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
            actorIdA: ACTOR_ALICE,
            actorIdB: ACTOR_BOB,
            actorDisplayNameA: "Alice Smith",
            actorDisplayNameB: "Bob Jones",
            actorEmailA: "alice@example.com",
            actorEmailB: "bob@example.com",
            fieldDiffs: [],
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.withActorNames).toBe(true);
    expect(parsed_.result.actorDisplayNameA).toBe("Alice Smith");
    expect(parsed_.result.actorDisplayNameB).toBe("Bob Jones");
  });

  it("JSON envelope withActorNames=false when NOT set", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "diff-history", ID_A, ID_B, "--format", "json"),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.withActorNames).toBe(false);
  });

  it("composes with --actor-id and --kind", async () => {
    const capture: DiffHistoryEntriesInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--kind",
        "opt_out_set",
        "--actor-id",
        ACTOR_ALICE,
        "--with-actor-names",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.eventKinds).toEqual(["opt_out_set"]);
    expect(capture[0]?.actorIds).toEqual([ACTOR_ALICE]);
    expect(capture[0]?.joinActor).toBe(true);
  });
});

describe("runRetention diff-history --actor-id-not (M6.7.zz.tenant.opt-out.cli.diff-history.actor-not + .multi)", () => {
  const ID_A = "aa000000-0000-4000-8000-0000000000aa";
  const ID_B = "bb000000-0000-4000-8000-0000000000bb";
  const ACTOR_ALICE = "11111111-0000-4000-8000-000000000001";
  const ACTOR_BOB = "22222222-0000-4000-8000-000000000002";
  const ACTOR_CAROL = "33333333-0000-4000-8000-000000000003";

  it("threads single-element actorIdsNot array when --actor-id-not set once", async () => {
    const capture: DiffHistoryEntriesInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--actor-id-not",
        ACTOR_ALICE,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.actorIdsNot).toEqual([ACTOR_ALICE]);
  });

  it("threads multi-element actorIdsNot array when --actor-id-not repeated", async () => {
    const capture: DiffHistoryEntriesInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--actor-id-not",
        ACTOR_ALICE,
        "--actor-id-not",
        ACTOR_BOB,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.actorIdsNot).toEqual([ACTOR_ALICE, ACTOR_BOB]);
  });

  it("omits actorIdsNot when --actor-id-not NOT set (backward compat)", async () => {
    const capture: DiffHistoryEntriesInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed("retention", "diff-history", ID_A, ID_B),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.actorIdsNot).toBeUndefined();
  });

  it("composes with --actor-id (both threaded independently)", async () => {
    const capture: DiffHistoryEntriesInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--actor-id",
        ACTOR_ALICE,
        "--actor-id-not",
        ACTOR_BOB,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.actorIds).toEqual([ACTOR_ALICE]);
    expect(capture[0]?.actorIdsNot).toEqual([ACTOR_BOB]);
  });

  it("composes with multi-value --actor-id and multi-value --actor-id-not", async () => {
    const capture: DiffHistoryEntriesInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--actor-id",
        ACTOR_ALICE,
        "--actor-id",
        ACTOR_BOB,
        "--actor-id-not",
        ACTOR_CAROL,
        "--actor-id-not",
        "44444444-0000-4000-8000-000000000004",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.actorIds).toEqual([ACTOR_ALICE, ACTOR_BOB]);
    expect(capture[0]?.actorIdsNot).toEqual([
      ACTOR_CAROL,
      "44444444-0000-4000-8000-000000000004",
    ]);
  });

  it("adapter exclusion error propagates as exit 1 with multi-value error format", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--actor-id-not",
        ACTOR_BOB,
        "--actor-id-not",
        ACTOR_CAROL,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          throws: new Error(
            `diffHistoryEntries: expected neither event to have actor_id in ['${ACTOR_BOB}', '${ACTOR_CAROL}'] but A matches`,
          ),
        }),
      } as RetentionContext,
    );
    expect(code).toBe(1);
    expect(err()).toContain(
      `expected neither event to have actor_id in ['${ACTOR_BOB}', '${ACTOR_CAROL}']`,
    );
    expect(err()).toContain("A matches");
  });

  it("JSON envelope echoes single-element actorIdsNot array when --actor-id-not set once", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--actor-id-not",
        ACTOR_BOB,
        "--format",
        "json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.action).toBe("diff-history");
    expect(parsed_.actorIdsNot).toEqual([ACTOR_BOB]);
  });

  it("JSON envelope echoes multi-element actorIdsNot array when --actor-id-not repeated", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--actor-id-not",
        ACTOR_BOB,
        "--actor-id-not",
        ACTOR_CAROL,
        "--format",
        "json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.actorIdsNot).toEqual([ACTOR_BOB, ACTOR_CAROL]);
  });

  it("JSON envelope actorIdsNot=null when --actor-id-not NOT set", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "diff-history", ID_A, ID_B, "--format", "json"),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.actorIdsNot).toBeNull();
  });
});

describe("runRetention diff-history --kind-not (M6.7.zz.tenant.opt-out.cli.diff-history.kind-not + .multi)", () => {
  const ID_A = "aa000000-0000-4000-8000-0000000000aa";
  const ID_B = "bb000000-0000-4000-8000-0000000000bb";

  it("returns exit 2 when --kind-not is invalid value", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--kind-not",
        "not_a_kind",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("invalid --kind-not");
    expect(err()).toContain("opt_out_set");
  });

  it("returns exit 2 on FIRST invalid --kind-not occurrence when multiple flags supplied", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--kind-not",
        "policy_deleted",
        "--kind-not",
        "bogus_kind",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("invalid --kind-not 'bogus_kind'");
  });

  it("threads eventKindsNot as single-element array when --kind-not set once", async () => {
    const capture: DiffHistoryEntriesInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--kind-not",
        "policy_deleted",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.eventKindsNot).toEqual(["policy_deleted"]);
  });

  it("threads multi-element eventKindsNot when --kind-not repeated", async () => {
    const capture: DiffHistoryEntriesInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--kind-not",
        "policy_deleted",
        "--kind-not",
        "retention_set",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.eventKindsNot).toEqual([
      "policy_deleted",
      "retention_set",
    ]);
  });

  it("omits eventKindsNot when --kind-not NOT set (backward compat)", async () => {
    const capture: DiffHistoryEntriesInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed("retention", "diff-history", ID_A, ID_B),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.eventKindsNot).toBeUndefined();
  });

  it("composes with --kind (both threaded independently, multi-value kind-not)", async () => {
    const capture: DiffHistoryEntriesInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--kind",
        "opt_out_set",
        "--kind-not",
        "policy_deleted",
        "--kind-not",
        "retention_set",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.eventKinds).toEqual(["opt_out_set"]);
    expect(capture[0]?.eventKindsNot).toEqual([
      "policy_deleted",
      "retention_set",
    ]);
  });

  it("adapter exclusion error propagates as exit 1 with multi-value error", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--kind-not",
        "policy_deleted",
        "--kind-not",
        "retention_set",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          throws: new Error(
            "diffHistoryEntries: expected neither event to have event_kind in ['policy_deleted', 'retention_set'] but A matches",
          ),
        }),
      } as RetentionContext,
    );
    expect(code).toBe(1);
    expect(err()).toContain(
      "expected neither event to have event_kind in ['policy_deleted', 'retention_set']",
    );
    expect(err()).toContain("A matches");
  });

  it("JSON envelope echoes kindsNot single-element array when --kind-not set once", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--kind-not",
        "policy_deleted",
        "--format",
        "json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.action).toBe("diff-history");
    expect(parsed_.kindsNot).toEqual(["policy_deleted"]);
  });

  it("JSON envelope echoes multi-element kindsNot when --kind-not repeated", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--kind-not",
        "policy_deleted",
        "--kind-not",
        "retention_set",
        "--format",
        "json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.kindsNot).toEqual(["policy_deleted", "retention_set"]);
  });

  it("JSON envelope kindsNot=null when --kind-not NOT set", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "diff-history", ID_A, ID_B, "--format", "json"),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.kindsNot).toBeNull();
  });
});

describe("runRetention diff-history --system-only / --no-system (M6.7.zz.tenant.opt-out.cli.diff-history.system-only)", () => {
  const ID_A = "aa000000-0000-4000-8000-0000000000aa";
  const ID_B = "bb000000-0000-4000-8000-0000000000bb";
  const ACTOR_ALICE = "11111111-0000-4000-8000-000000000001";

  it("returns exit 2 when --system-only AND --no-system both set", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--system-only",
        "--no-system",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain(
      "--system-only and --no-system are mutually exclusive",
    );
  });

  it("threads actorPresence='system_only' when --system-only set", async () => {
    const capture: DiffHistoryEntriesInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed("retention", "diff-history", ID_A, ID_B, "--system-only"),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.actorPresence).toBe("system_only");
  });

  it("threads actorPresence='no_system' when --no-system set", async () => {
    const capture: DiffHistoryEntriesInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed("retention", "diff-history", ID_A, ID_B, "--no-system"),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.actorPresence).toBe("no_system");
  });

  it("omits actorPresence when neither flag set (backward compat)", async () => {
    const capture: DiffHistoryEntriesInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed("retention", "diff-history", ID_A, ID_B),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.actorPresence).toBeUndefined();
  });

  it("composes with --actor-id-not + --no-system (both threaded independently)", async () => {
    const capture: DiffHistoryEntriesInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--actor-id-not",
        ACTOR_ALICE,
        "--no-system",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.actorIdsNot).toEqual([ACTOR_ALICE]);
    expect(capture[0]?.actorPresence).toBe("no_system");
  });

  it("adapter expectation error propagates as exit 1 with explicit error", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed("retention", "diff-history", ID_A, ID_B, "--system-only"),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          throws: new Error(
            "diffHistoryEntries: expected both events to be system-authored (actor_id IS NULL) but A is '11111111-0000-4000-8000-000000000001'",
          ),
        }),
      } as RetentionContext,
    );
    expect(code).toBe(1);
    expect(err()).toContain(
      "expected both events to be system-authored (actor_id IS NULL)",
    );
    expect(err()).toContain("A is '11111111-0000-4000-8000-000000000001'");
  });

  it("JSON envelope echoes systemOnly=true + noSystem=false when --system-only set", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--system-only",
        "--format=json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.action).toBe("diff-history");
    expect(parsed_.systemOnly).toBe(true);
    expect(parsed_.noSystem).toBe(false);
  });

  it("JSON envelope echoes noSystem=true + systemOnly=false when --no-system set", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--no-system",
        "--format=json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.systemOnly).toBe(false);
    expect(parsed_.noSystem).toBe(true);
  });

  it("JSON envelope both false when neither flag set", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "diff-history", ID_A, ID_B, "--format=json"),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.systemOnly).toBe(false);
    expect(parsed_.noSystem).toBe(false);
  });
});

describe("runRetention diff-history per-side expectations (M6.7.zz.tenant.opt-out.cli.diff-history.per-side + .multi)", () => {
  const ID_A = "aa000000-0000-4000-8000-0000000000aa";
  const ID_B = "bb000000-0000-4000-8000-0000000000bb";
  const ACTOR_ALICE = "11111111-0000-4000-8000-000000000001";
  const ACTOR_BOB = "22222222-0000-4000-8000-000000000002";
  const ACTOR_CAROL = "33333333-0000-4000-8000-000000000003";

  it("--kind-a invalid value exits 2 with valid-values list", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--kind-a",
        "bogus_kind",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("invalid --kind-a 'bogus_kind'");
    expect(err()).toContain("opt_out_set");
  });

  it("--kind-a invalid value exits 2 on FIRST invalid occurrence when multi", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--kind-a",
        "opt_out_set",
        "--kind-a",
        "bogus",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("invalid --kind-a 'bogus'");
  });

  it("--kind-b invalid value exits 2", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--kind-b",
        "not_a_kind",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("invalid --kind-b 'not_a_kind'");
  });

  it("--kind-not-a invalid value exits 2 on FIRST invalid occurrence", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--kind-not-a",
        "policy_deleted",
        "--kind-not-a",
        "bogus",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("invalid --kind-not-a 'bogus'");
  });

  it("--kind-not-b invalid value exits 2", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--kind-not-b",
        "bad_value",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("invalid --kind-not-b 'bad_value'");
  });

  it("threads single-element eventKindsA array when --kind-a set once", async () => {
    const capture: DiffHistoryEntriesInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--kind-a",
        "opt_out_set",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.eventKindsA).toEqual(["opt_out_set"]);
    expect(capture[0]?.eventKindsB).toBeUndefined();
  });

  it("threads multi-element eventKindsA array when --kind-a repeated", async () => {
    const capture: DiffHistoryEntriesInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--kind-a",
        "opt_out_set",
        "--kind-a",
        "opt_out_cleared",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.eventKindsA).toEqual(["opt_out_set", "opt_out_cleared"]);
  });

  it("threads eventKindsB when --kind-b set", async () => {
    const capture: DiffHistoryEntriesInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--kind-b",
        "policy_deleted",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.eventKindsB).toEqual(["policy_deleted"]);
  });

  it("threads multi-element eventKindsNotA when --kind-not-a repeated", async () => {
    const capture: DiffHistoryEntriesInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--kind-not-a",
        "policy_deleted",
        "--kind-not-a",
        "retention_set",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.eventKindsNotA).toEqual([
      "policy_deleted",
      "retention_set",
    ]);
  });

  it("threads eventKindsNotB when --kind-not-b set", async () => {
    const capture: DiffHistoryEntriesInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--kind-not-b",
        "policy_deleted",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.eventKindsNotB).toEqual(["policy_deleted"]);
  });

  it("threads single-element actorIdsA + actorIdsB when set once", async () => {
    const capture: DiffHistoryEntriesInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--actor-id-a",
        ACTOR_ALICE,
        "--actor-id-b",
        ACTOR_BOB,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.actorIdsA).toEqual([ACTOR_ALICE]);
    expect(capture[0]?.actorIdsB).toEqual([ACTOR_BOB]);
  });

  it("threads multi-element actorIdsA when --actor-id-a repeated", async () => {
    const capture: DiffHistoryEntriesInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--actor-id-a",
        ACTOR_ALICE,
        "--actor-id-a",
        ACTOR_BOB,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.actorIdsA).toEqual([ACTOR_ALICE, ACTOR_BOB]);
  });

  it("threads actorIdsNotA + actorIdsNotB independently", async () => {
    const capture: DiffHistoryEntriesInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--actor-id-not-a",
        ACTOR_ALICE,
        "--actor-id-not-b",
        ACTOR_BOB,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.actorIdsNotA).toEqual([ACTOR_ALICE]);
    expect(capture[0]?.actorIdsNotB).toEqual([ACTOR_BOB]);
  });

  it("threads multi-element actorIdsNotA when --actor-id-not-a repeated", async () => {
    const capture: DiffHistoryEntriesInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--actor-id-not-a",
        ACTOR_BOB,
        "--actor-id-not-a",
        ACTOR_CAROL,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.actorIdsNotA).toEqual([ACTOR_BOB, ACTOR_CAROL]);
  });

  it("omits all per-side fields when no per-side flag set (backward compat)", async () => {
    const capture: DiffHistoryEntriesInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed("retention", "diff-history", ID_A, ID_B),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.eventKindsA).toBeUndefined();
    expect(capture[0]?.eventKindsB).toBeUndefined();
    expect(capture[0]?.eventKindsNotA).toBeUndefined();
    expect(capture[0]?.eventKindsNotB).toBeUndefined();
    expect(capture[0]?.actorIdsA).toBeUndefined();
    expect(capture[0]?.actorIdsB).toBeUndefined();
    expect(capture[0]?.actorIdsNotA).toBeUndefined();
    expect(capture[0]?.actorIdsNotB).toBeUndefined();
  });

  it("composes with global --kind + per-side --kind-a (both threaded as arrays)", async () => {
    const capture: DiffHistoryEntriesInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--kind",
        "opt_out_set",
        "--kind-a",
        "opt_out_set",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.eventKinds).toEqual(["opt_out_set"]);
    expect(capture[0]?.eventKindsA).toEqual(["opt_out_set"]);
  });

  it("JSON envelope echoes per-side kindsA + kindsB arrays when set", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--kind-a",
        "opt_out_set",
        "--kind-b",
        "policy_deleted",
        "--format=json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.kindsA).toEqual(["opt_out_set"]);
    expect(parsed_.kindsB).toEqual(["policy_deleted"]);
  });

  it("JSON envelope echoes per-side kindsNotA + kindsNotB arrays when set", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--kind-not-a",
        "policy_deleted",
        "--kind-not-a",
        "retention_set",
        "--kind-not-b",
        "policy_deleted",
        "--format=json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.kindsNotA).toEqual(["policy_deleted", "retention_set"]);
    expect(parsed_.kindsNotB).toEqual(["policy_deleted"]);
  });

  it("JSON envelope echoes per-side actorIdsA + actorIdsB + actorIdsNotA + actorIdsNotB arrays", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--actor-id-a",
        ACTOR_ALICE,
        "--actor-id-not-b",
        ACTOR_BOB,
        "--format=json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.actorIdsA).toEqual([ACTOR_ALICE]);
    expect(parsed_.actorIdsB).toBeNull();
    expect(parsed_.actorIdsNotA).toBeNull();
    expect(parsed_.actorIdsNotB).toEqual([ACTOR_BOB]);
  });

  it("JSON envelope all per-side fields null when none set", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "diff-history", ID_A, ID_B, "--format=json"),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.kindsA).toBeNull();
    expect(parsed_.kindsB).toBeNull();
    expect(parsed_.kindsNotA).toBeNull();
    expect(parsed_.kindsNotB).toBeNull();
    expect(parsed_.actorIdsA).toBeNull();
    expect(parsed_.actorIdsB).toBeNull();
    expect(parsed_.actorIdsNotA).toBeNull();
    expect(parsed_.actorIdsNotB).toBeNull();
  });

  it("adapter per-side error propagates as exit 1 with multi-value list error format", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--kind-a",
        "opt_out_set",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          throws: new Error(
            "diffHistoryEntries: expected event A to have event_kind in ['opt_out_set'] but A is 'policy_deleted'",
          ),
        }),
      } as RetentionContext,
    );
    expect(code).toBe(1);
    expect(err()).toContain(
      "expected event A to have event_kind in ['opt_out_set']",
    );
    expect(err()).toContain("A is 'policy_deleted'");
  });
});

describe("runRetention diff-history per-side --system-only / --no-system (M6.7.zz.tenant.opt-out.cli.diff-history.per-side.system-only)", () => {
  const ID_A = "aa000000-0000-4000-8000-0000000000aa";
  const ID_B = "bb000000-0000-4000-8000-0000000000bb";
  const ACTOR_ALICE = "11111111-0000-4000-8000-000000000001";

  it("exit 2 when --system-only-a AND --no-system-a both set", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--system-only-a",
        "--no-system-a",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain(
      "--system-only-a and --no-system-a are mutually exclusive",
    );
  });

  it("exit 2 when --system-only-b AND --no-system-b both set", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--system-only-b",
        "--no-system-b",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain(
      "--system-only-b and --no-system-b are mutually exclusive",
    );
  });

  it("--system-only-a + --no-system-b allowed (different sides, asymmetric assertion)", async () => {
    const capture: DiffHistoryEntriesInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--system-only-a",
        "--no-system-b",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.actorPresenceA).toBe("system_only");
    expect(capture[0]?.actorPresenceB).toBe("no_system");
  });

  it("threads actorPresenceA='system_only' when --system-only-a set", async () => {
    const capture: DiffHistoryEntriesInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed("retention", "diff-history", ID_A, ID_B, "--system-only-a"),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.actorPresenceA).toBe("system_only");
    expect(capture[0]?.actorPresenceB).toBeUndefined();
  });

  it("threads actorPresenceA='no_system' when --no-system-a set", async () => {
    const capture: DiffHistoryEntriesInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed("retention", "diff-history", ID_A, ID_B, "--no-system-a"),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.actorPresenceA).toBe("no_system");
  });

  it("threads actorPresenceB='system_only' when --system-only-b set", async () => {
    const capture: DiffHistoryEntriesInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed("retention", "diff-history", ID_A, ID_B, "--system-only-b"),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.actorPresenceB).toBe("system_only");
  });

  it("threads actorPresenceB='no_system' when --no-system-b set", async () => {
    const capture: DiffHistoryEntriesInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed("retention", "diff-history", ID_A, ID_B, "--no-system-b"),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.actorPresenceB).toBe("no_system");
  });

  it("omits per-side actorPresence fields when neither set (backward compat)", async () => {
    const capture: DiffHistoryEntriesInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed("retention", "diff-history", ID_A, ID_B),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.actorPresenceA).toBeUndefined();
    expect(capture[0]?.actorPresenceB).toBeUndefined();
  });

  it("composes with global --system-only + per-side --no-system-a (both threaded; global fires first at adapter)", async () => {
    const capture: DiffHistoryEntriesInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--system-only",
        "--no-system-a",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.actorPresence).toBe("system_only");
    expect(capture[0]?.actorPresenceA).toBe("no_system");
  });

  it("JSON envelope echoes systemOnlyA + noSystemA + systemOnlyB + noSystemB booleans", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--system-only-a",
        "--no-system-b",
        "--format=json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.systemOnlyA).toBe(true);
    expect(parsed_.noSystemA).toBe(false);
    expect(parsed_.systemOnlyB).toBe(false);
    expect(parsed_.noSystemB).toBe(true);
  });

  it("JSON envelope all per-side actor-presence booleans false when none set", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "diff-history", ID_A, ID_B, "--format=json"),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.systemOnlyA).toBe(false);
    expect(parsed_.noSystemA).toBe(false);
    expect(parsed_.systemOnlyB).toBe(false);
    expect(parsed_.noSystemB).toBe(false);
  });

  it("adapter per-side error propagates as exit 1 with per-side error format", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed("retention", "diff-history", ID_A, ID_B, "--system-only-a"),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          throws: new Error(
            `diffHistoryEntries: expected event A to be system-authored (actor_id IS NULL) but A is '${ACTOR_ALICE}'`,
          ),
        }),
      } as RetentionContext,
    );
    expect(code).toBe(1);
    expect(err()).toContain(
      "expected event A to be system-authored",
    );
    expect(err()).toContain(`A is '${ACTOR_ALICE}'`);
  });

  it("intra-side mutual exclusivity check fires BEFORE PG adapter call", async () => {
    const capture: DiffHistoryEntriesInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-history",
        ID_A,
        ID_B,
        "--system-only-a",
        "--no-system-a",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(capture).toHaveLength(0);
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

describe("runRetention diff-timeline (M6.7.zz.tenant.opt-out.cli.diff-timeline)", () => {
  it("returns exit 2 when tenant-a is missing", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(parsed("retention", "diff-timeline"), {
      ...ctx,
      retentionOverride: fakeRetention({}),
    } as RetentionContext);
    expect(code).toBe(2);
    expect(err()).toContain("missing arguments");
  });

  it("returns exit 2 when tenant-b is missing", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed("retention", "diff-timeline", TENANT_A),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("missing arguments");
  });

  it("returns exit 2 when table-name is missing", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed("retention", "diff-timeline", TENANT_A, TENANT_B),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("missing arguments");
  });

  it("returns exit 2 when --since is invalid", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--since",
        "not-a-date",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("invalid --since");
  });

  it("returns exit 2 when --until is invalid", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
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

  it("returns exit 2 when --limit is invalid", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--limit",
        "0",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("invalid --limit");
  });

  it("threads three positional args to adapter with default limit=100", async () => {
    const capture: DiffHistoryTimelineInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffTimelineCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture).toHaveLength(1);
    expect(capture[0]).toEqual({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
      since: undefined,
      until: undefined,
      limit: 100,
    });
  });

  it("threads --since + --until + --limit through to adapter (ISO normalised)", async () => {
    const capture: DiffHistoryTimelineInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--since",
        "2026-01-01",
        "--until",
        "2026-06-01",
        "--limit",
        "50",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffTimelineCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.since).toBe("2026-01-01T00:00:00.000Z");
    expect(capture[0]?.until).toBe("2026-06-01T00:00:00.000Z");
    expect(capture[0]?.limit).toBe(50);
  });

  it("human-format renders 'No history events' when entries empty", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain("Timeline for tenants on workflow_traces");
    expect(out()).toContain(`Tenant A: ${TENANT_A}`);
    expect(out()).toContain(`Tenant B: ${TENANT_B}`);
    expect(out()).toContain(
      "No history events for either tenant on this table.",
    );
  });

  it("human-format renders chronological events with [A] / [B] tags", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTimelineResult: {
            tenantIdA: TENANT_A,
            tenantIdB: TENANT_B,
            tableName: "workflow_traces",
            entries: [
              {
                id: "h1",
                tenantId: TENANT_A,
                tenantSide: "A",
                tableName: "workflow_traces",
                eventKind: "opt_out_set",
                occurredAt: "2026-01-01T00:00:00.000Z",
                prevState: null,
                nextState: {
                  opt_out: true,
                  retention_days: 365,
                  opt_out_reason: "legal-hold",
                },
                attributes: {},
              },
              {
                id: "h2",
                tenantId: TENANT_B,
                tenantSide: "B",
                tableName: "workflow_traces",
                eventKind: "retention_set",
                occurredAt: "2026-01-15T00:00:00.000Z",
                prevState: null,
                nextState: {
                  retention_days: 90,
                  enabled: true,
                  opt_out: false,
                },
                attributes: {},
              },
            ],
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const o = out();
    expect(o).toContain("Events (2):");
    expect(o).toContain("[A] opt_out_set");
    expect(o).toContain("[B] retention_set");
    expect(o).toContain("retention=365");
    expect(o).toContain("opt_out=true");
    expect(o).toContain("reason=legal-hold");
    expect(o).toContain("retention=90");
    expect(o).toContain("enabled=true");
  });

  it("human-format renders '(policy deleted)' for nextState=null", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTimelineResult: {
            tenantIdA: TENANT_A,
            tenantIdB: TENANT_B,
            tableName: "workflow_traces",
            entries: [
              {
                id: "h1",
                tenantId: TENANT_A,
                tenantSide: "A",
                tableName: "workflow_traces",
                eventKind: "policy_deleted",
                occurredAt: "2026-02-01T00:00:00.000Z",
                prevState: { retention_days: 90 },
                nextState: null,
                attributes: {},
              },
            ],
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain("[A] policy_deleted");
    expect(out()).toContain("(policy deleted)");
  });

  it("JSON envelope shape {action, since, until, limit, result}", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--format=json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsedOut = JSON.parse(out());
    expect(parsedOut.action).toBe("diff-timeline");
    expect(parsedOut.since).toBeNull();
    expect(parsedOut.until).toBeNull();
    expect(parsedOut.limit).toBe(100);
    expect(parsedOut.result.tenantIdA).toBe(TENANT_A);
    expect(parsedOut.result.tenantIdB).toBe(TENANT_B);
    expect(parsedOut.result.tableName).toBe("workflow_traces");
    expect(parsedOut.result.entries).toEqual([]);
  });

  it("adapter errors propagate as exit 1", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
      ),
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

  it("threads joinActor=true to adapter when --with-actor-names is set", async () => {
    const capture: DiffHistoryTimelineInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--with-actor-names",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffTimelineCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.joinActor).toBe(true);
  });

  it("omits joinActor when --with-actor-names is NOT set (backward compat)", async () => {
    const capture: DiffHistoryTimelineInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffTimelineCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.joinActor).toBeUndefined();
  });

  it("human-format renders 'Alice Smith (uuid)' when --with-actor-names + actorDisplayName populated", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--with-actor-names",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTimelineResult: {
            tenantIdA: TENANT_A,
            tenantIdB: TENANT_B,
            tableName: "workflow_traces",
            entries: [
              {
                id: "h1",
                tenantId: TENANT_A,
                tenantSide: "A",
                tableName: "workflow_traces",
                eventKind: "opt_out_set",
                actorId: "11111111-1111-1111-1111-111111111111",
                occurredAt: "2026-01-01T00:00:00.000Z",
                prevState: null,
                nextState: { opt_out: true, retention_days: 365 },
                attributes: {},
                actorDisplayName: "Alice Smith",
                actorEmail: "alice@example.com",
              },
            ],
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain(
      "Alice Smith (11111111-1111-1111-1111-111111111111)",
    );
  });

  it("human-format falls back to email when --with-actor-names + display_name null", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--with-actor-names",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTimelineResult: {
            tenantIdA: TENANT_A,
            tenantIdB: TENANT_B,
            tableName: "workflow_traces",
            entries: [
              {
                id: "h1",
                tenantId: TENANT_A,
                tenantSide: "A",
                tableName: "workflow_traces",
                eventKind: "opt_out_set",
                actorId: "11111111-1111-1111-1111-111111111111",
                occurredAt: "2026-01-01T00:00:00.000Z",
                prevState: null,
                nextState: { opt_out: true, retention_days: 365 },
                attributes: {},
                actorDisplayName: null,
                actorEmail: "alice@example.com",
              },
            ],
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain(
      "alice@example.com (11111111-1111-1111-1111-111111111111)",
    );
  });

  it("human-format renders <system> for null actor_id regardless of --with-actor-names", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--with-actor-names",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTimelineResult: {
            tenantIdA: TENANT_A,
            tenantIdB: TENANT_B,
            tableName: "workflow_traces",
            entries: [
              {
                id: "h1",
                tenantId: TENANT_A,
                tenantSide: "A",
                tableName: "workflow_traces",
                eventKind: "policy_deleted",
                actorId: null,
                occurredAt: "2026-01-01T00:00:00.000Z",
                prevState: null,
                nextState: null,
                attributes: {},
                actorDisplayName: null,
                actorEmail: null,
              },
            ],
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain("by <system>");
  });

  it("human-format omits 'by <actor>' suffix when --with-actor-names is NOT set", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTimelineResult: {
            tenantIdA: TENANT_A,
            tenantIdB: TENANT_B,
            tableName: "workflow_traces",
            entries: [
              {
                id: "h1",
                tenantId: TENANT_A,
                tenantSide: "A",
                tableName: "workflow_traces",
                eventKind: "opt_out_set",
                actorId: "11111111-1111-1111-1111-111111111111",
                occurredAt: "2026-01-01T00:00:00.000Z",
                prevState: null,
                nextState: { opt_out: true, retention_days: 365 },
                attributes: {},
              },
            ],
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).not.toContain(" by ");
  });

  it("JSON envelope includes withActorNames + actorDisplayName + actorEmail when --with-actor-names set", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--with-actor-names",
        "--format",
        "json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTimelineResult: {
            tenantIdA: TENANT_A,
            tenantIdB: TENANT_B,
            tableName: "workflow_traces",
            entries: [
              {
                id: "h1",
                tenantId: TENANT_A,
                tenantSide: "A",
                tableName: "workflow_traces",
                eventKind: "opt_out_set",
                actorId: "11111111-1111-1111-1111-111111111111",
                occurredAt: "2026-01-01T00:00:00.000Z",
                prevState: null,
                nextState: { opt_out: true, retention_days: 365 },
                attributes: {},
                actorDisplayName: "Alice Smith",
                actorEmail: "alice@example.com",
              },
            ],
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.withActorNames).toBe(true);
    expect(parsed_.result.entries[0].actorDisplayName).toBe("Alice Smith");
    expect(parsed_.result.entries[0].actorEmail).toBe("alice@example.com");
  });

  it("JSON envelope withActorNames=false when flag NOT set", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--format",
        "json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.withActorNames).toBe(false);
  });
});

describe("runRetention diff-timeline N-way (M6.7.zz.tenant.opt-out.cli.diff-timeline.add-tenant)", () => {
  const TENANT_C = "00000000-0000-4000-8000-00000000000C";
  const TENANT_D = "00000000-0000-4000-8000-00000000000D";

  it("dispatches to N-way path when --add-tenant is present", async () => {
    const capture: DiffHistoryTimelineNwayInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--add-tenant",
        TENANT_C,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffTimelineNwayCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture).toHaveLength(1);
    expect(capture[0]?.tenantIds).toEqual([TENANT_A, TENANT_B, TENANT_C]);
    expect(capture[0]?.tableName).toBe("workflow_traces");
  });

  it("collects multiple --add-tenant flags in argv order [A, B, C, D]", async () => {
    const capture: DiffHistoryTimelineNwayInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--add-tenant",
        TENANT_C,
        "--add-tenant",
        TENANT_D,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffTimelineNwayCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.tenantIds).toEqual([
      TENANT_A,
      TENANT_B,
      TENANT_C,
      TENANT_D,
    ]);
  });

  it("does NOT call diffHistoryTimelineNway when --add-tenant is absent", async () => {
    const pairCapture: DiffHistoryTimelineInput[] = [];
    const nwayCapture: DiffHistoryTimelineNwayInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTimelineCapture: pairCapture,
          diffTimelineNwayCapture: nwayCapture,
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(pairCapture).toHaveLength(1);
    expect(nwayCapture).toHaveLength(0);
  });

  it("threads --with-actor-names + --since + --limit through to N-way adapter", async () => {
    const capture: DiffHistoryTimelineNwayInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--add-tenant",
        TENANT_C,
        "--with-actor-names",
        "--since",
        "2026-01-01",
        "--limit",
        "50",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffTimelineNwayCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.joinActor).toBe(true);
    expect(capture[0]?.since).toBe("2026-01-01T00:00:00.000Z");
    expect(capture[0]?.limit).toBe(50);
  });

  it("human-format renders 'N-way timeline for N tenants on <table>:' header", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--add-tenant",
        TENANT_C,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain("N-way timeline for 3 tenants on workflow_traces");
    expect(out()).toContain(`Tenant A: ${TENANT_A}`);
    expect(out()).toContain(`Tenant B: ${TENANT_B}`);
    expect(out()).toContain(`Tenant C: ${TENANT_C}`);
  });

  it("human-format renders [A]/[B]/[C] tagged events", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--add-tenant",
        TENANT_C,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTimelineNwayResult: {
            tenantIds: [TENANT_A, TENANT_B, TENANT_C],
            tableName: "workflow_traces",
            entries: [
              {
                id: "h1",
                tenantId: TENANT_A,
                tenantLabel: "A",
                tableName: "workflow_traces",
                eventKind: "opt_out_set",
                actorId: null,
                occurredAt: "2026-01-01T00:00:00.000Z",
                prevState: null,
                nextState: { opt_out: true, retention_days: 365 },
                attributes: {},
              },
              {
                id: "h2",
                tenantId: TENANT_B,
                tenantLabel: "B",
                tableName: "workflow_traces",
                eventKind: "retention_set",
                actorId: null,
                occurredAt: "2026-01-15T00:00:00.000Z",
                prevState: null,
                nextState: { opt_out: false, retention_days: 90, enabled: true },
                attributes: {},
              },
              {
                id: "h3",
                tenantId: TENANT_C,
                tenantLabel: "C",
                tableName: "workflow_traces",
                eventKind: "policy_deleted",
                actorId: null,
                occurredAt: "2026-02-01T00:00:00.000Z",
                prevState: { retention_days: 30 },
                nextState: null,
                attributes: {},
              },
            ],
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain("[A] opt_out_set");
    expect(out()).toContain("[B] retention_set");
    expect(out()).toContain("[C] policy_deleted");
    expect(out()).toContain("(policy deleted)");
  });

  it("JSON envelope includes nway:true discriminator + result.tenantIds + entries with tenantLabel", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--add-tenant",
        TENANT_C,
        "--format",
        "json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTimelineNwayResult: {
            tenantIds: [TENANT_A, TENANT_B, TENANT_C],
            tableName: "workflow_traces",
            entries: [
              {
                id: "h1",
                tenantId: TENANT_A,
                tenantLabel: "A",
                tableName: "workflow_traces",
                eventKind: "opt_out_set",
                actorId: null,
                occurredAt: "2026-01-01T00:00:00.000Z",
                prevState: null,
                nextState: { opt_out: true, retention_days: 365 },
                attributes: {},
              },
            ],
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.action).toBe("diff-timeline");
    expect(parsed_.nway).toBe(true);
    expect(parsed_.result.tenantIds).toEqual([TENANT_A, TENANT_B, TENANT_C]);
    expect(parsed_.result.entries[0].tenantLabel).toBe("A");
  });

  it("adapter errors on N-way path propagate as exit 1", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--add-tenant",
        TENANT_C,
      ),
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

describe("formatTimelineNwayDiff", () => {
  const TENANT_C = "00000000-0000-4000-8000-00000000000C";

  it("renders 'No history events for any of these tenants' when entries empty", () => {
    const out = formatTimelineNwayDiff({
      tenantIds: [TENANT_A, TENANT_B, TENANT_C],
      tableName: "workflow_traces",
      entries: [],
    });
    expect(out).toContain("N-way timeline for 3 tenants on workflow_traces");
    expect(out).toContain(`Tenant A: ${TENANT_A}`);
    expect(out).toContain(`Tenant B: ${TENANT_B}`);
    expect(out).toContain(`Tenant C: ${TENANT_C}`);
    expect(out).toContain("No history events for any of these tenants");
  });

  it("renders [A]/[B]/[C] tagged event lines with state summary", () => {
    const out = formatTimelineNwayDiff({
      tenantIds: [TENANT_A, TENANT_B, TENANT_C],
      tableName: "workflow_traces",
      entries: [
        {
          id: "h1",
          tenantId: TENANT_C,
          tenantLabel: "C",
          tableName: "workflow_traces",
          eventKind: "opt_out_set",
          actorId: null,
          occurredAt: "2026-01-01T00:00:00.000Z",
          prevState: null,
          nextState: {
            opt_out: true,
            retention_days: 365,
            opt_out_reason: "legal-hold",
          },
          attributes: {},
        },
      ],
    });
    expect(out).toContain("Events (1):");
    expect(out).toContain("[C] opt_out_set");
    expect(out).toContain("retention=365");
    expect(out).toContain("opt_out=true");
    expect(out).toContain("reason=legal-hold");
  });

  it("renders 'by Alice (uuid)' suffix when withActorNames=true opt", () => {
    const out = formatTimelineNwayDiff(
      {
        tenantIds: [TENANT_A, TENANT_B, TENANT_C],
        tableName: "workflow_traces",
        entries: [
          {
            id: "h1",
            tenantId: TENANT_A,
            tenantLabel: "A",
            tableName: "workflow_traces",
            eventKind: "opt_out_set",
            actorId: "11111111-1111-1111-1111-111111111111",
            occurredAt: "2026-01-01T00:00:00.000Z",
            prevState: null,
            nextState: { opt_out: true, retention_days: 365 },
            attributes: {},
            actorDisplayName: "Alice Smith",
            actorEmail: "alice@example.com",
          },
        ],
      },
      { withActorNames: true },
    );
    expect(out).toContain(
      "by Alice Smith (11111111-1111-1111-1111-111111111111)",
    );
  });
});

describe("runRetention diff-timeline cross-table (M6.7.zz.tenant.opt-out.cli.diff-timeline.cross-table)", () => {
  it("returns exit 2 when --add-table is set without --cross-table", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--add-table",
        "llm_call_traces",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("--add-table requires --cross-table");
  });

  it("returns exit 2 when --cross-table + --add-tenant both set", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        "workflow_traces",
        "llm_call_traces",
        "--cross-table",
        "--add-tenant",
        TENANT_B,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("mutually exclusive");
  });

  it("dispatches to cross-table path with positional <tenant> <table-a> <table-b>", async () => {
    const capture: DiffHistoryTimelineCrossTableInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        "workflow_traces",
        "llm_call_traces",
        "--cross-table",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTimelineCrossTableCapture: capture,
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture).toHaveLength(1);
    expect(capture[0]?.tenantId).toBe(TENANT_A);
    expect(capture[0]?.tableNames).toEqual(["workflow_traces", "llm_call_traces"]);
  });

  it("collects --add-table flags in argv order extending the table list", async () => {
    const capture: DiffHistoryTimelineCrossTableInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        "workflow_traces",
        "llm_call_traces",
        "--cross-table",
        "--add-table",
        "llm_latency_samples",
        "--add-table",
        "tenant_retention_opt_out_history",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTimelineCrossTableCapture: capture,
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.tableNames).toEqual([
      "workflow_traces",
      "llm_call_traces",
      "llm_latency_samples",
      "tenant_retention_opt_out_history",
    ]);
  });

  it("does NOT dispatch to cross-table path when --cross-table absent", async () => {
    const pairCapture: DiffHistoryTimelineInput[] = [];
    const crossCapture: DiffHistoryTimelineCrossTableInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTimelineCapture: pairCapture,
          diffTimelineCrossTableCapture: crossCapture,
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(pairCapture).toHaveLength(1);
    expect(crossCapture).toHaveLength(0);
  });

  it("threads --with-actor-names + --since + --limit through to cross-table adapter", async () => {
    const capture: DiffHistoryTimelineCrossTableInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        "workflow_traces",
        "llm_call_traces",
        "--cross-table",
        "--with-actor-names",
        "--since",
        "2026-01-01",
        "--limit",
        "50",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTimelineCrossTableCapture: capture,
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.joinActor).toBe(true);
    expect(capture[0]?.since).toBe("2026-01-01T00:00:00.000Z");
    expect(capture[0]?.limit).toBe(50);
  });

  it("human-format renders 'Cross-table timeline for tenant ... across N tables:' header", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        "workflow_traces",
        "llm_call_traces",
        "--cross-table",
        "--add-table",
        "llm_latency_samples",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain(
      `Cross-table timeline for tenant ${TENANT_A} across 3 tables`,
    );
    expect(out()).toContain("Table A: workflow_traces");
    expect(out()).toContain("Table B: llm_call_traces");
    expect(out()).toContain("Table C: llm_latency_samples");
  });

  it("human-format renders [A]/[B]/[C] tagged events with tableLabel", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        "workflow_traces",
        "llm_call_traces",
        "--cross-table",
        "--add-table",
        "llm_latency_samples",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTimelineCrossTableResult: {
            tenantId: TENANT_A,
            tableNames: [
              "workflow_traces",
              "llm_call_traces",
              "llm_latency_samples",
            ],
            entries: [
              {
                id: "h1",
                tenantId: TENANT_A,
                tableName: "workflow_traces",
                tableLabel: "A",
                eventKind: "opt_out_set",
                actorId: null,
                occurredAt: "2026-01-01T00:00:00.000Z",
                prevState: null,
                nextState: { opt_out: true, retention_days: 365 },
                attributes: {},
              },
              {
                id: "h2",
                tenantId: TENANT_A,
                tableName: "llm_call_traces",
                tableLabel: "B",
                eventKind: "retention_set",
                actorId: null,
                occurredAt: "2026-01-15T00:00:00.000Z",
                prevState: null,
                nextState: { opt_out: false, retention_days: 90, enabled: true },
                attributes: {},
              },
              {
                id: "h3",
                tenantId: TENANT_A,
                tableName: "llm_latency_samples",
                tableLabel: "C",
                eventKind: "policy_deleted",
                actorId: null,
                occurredAt: "2026-02-01T00:00:00.000Z",
                prevState: { retention_days: 30 },
                nextState: null,
                attributes: {},
              },
            ],
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain("[A] opt_out_set");
    expect(out()).toContain("[B] retention_set");
    expect(out()).toContain("[C] policy_deleted");
    expect(out()).toContain("(policy deleted)");
  });

  it("JSON envelope includes crossTable:true discriminator + result.tableNames + entries with tableLabel", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        "workflow_traces",
        "llm_call_traces",
        "--cross-table",
        "--format",
        "json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTimelineCrossTableResult: {
            tenantId: TENANT_A,
            tableNames: ["workflow_traces", "llm_call_traces"],
            entries: [
              {
                id: "h1",
                tenantId: TENANT_A,
                tableName: "workflow_traces",
                tableLabel: "A",
                eventKind: "opt_out_set",
                actorId: null,
                occurredAt: "2026-01-01T00:00:00.000Z",
                prevState: null,
                nextState: { opt_out: true, retention_days: 365 },
                attributes: {},
              },
            ],
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.action).toBe("diff-timeline");
    expect(parsed_.crossTable).toBe(true);
    expect(parsed_.result.tenantId).toBe(TENANT_A);
    expect(parsed_.result.tableNames).toEqual(["workflow_traces", "llm_call_traces"]);
    expect(parsed_.result.entries[0].tableLabel).toBe("A");
  });

  it("adapter errors on cross-table path propagate as exit 1", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        "workflow_traces",
        "llm_call_traces",
        "--cross-table",
      ),
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

  it("missing positional arg with --cross-table returns exit 2 with cross-table usage hint", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        "workflow_traces",
        "--cross-table",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("missing arguments");
    expect(err()).toContain("--cross-table");
  });
});

describe("runRetention diff-timeline --actor-id (M6.7.zz.tenant.opt-out.cli.diff-timeline.actor-filter + .multi-actor)", () => {
  const ACTOR_A = "11111111-1111-1111-1111-111111111111";
  const ACTOR_B = "22222222-2222-2222-2222-222222222222";

  it("pair-wise: threads actorIds as single-element array to adapter when --actor-id set once", async () => {
    const capture: DiffHistoryTimelineInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--actor-id",
        ACTOR_A,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffTimelineCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.actorIds).toEqual([ACTOR_A]);
  });

  it("pair-wise: --actor-id repeated builds multi-actor array (OR semantic)", async () => {
    const capture: DiffHistoryTimelineInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--actor-id",
        ACTOR_A,
        "--actor-id",
        ACTOR_B,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffTimelineCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.actorIds).toEqual([ACTOR_A, ACTOR_B]);
  });

  it("pair-wise: omits actorIds when --actor-id NOT set (backward compat)", async () => {
    const capture: DiffHistoryTimelineInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffTimelineCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.actorIds).toBeUndefined();
  });

  it("N-way: threads actorIds alongside --add-tenant (single + multi-actor)", async () => {
    const TENANT_C = "00000000-0000-4000-8000-00000000000C";
    const capture: DiffHistoryTimelineNwayInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--add-tenant",
        TENANT_C,
        "--actor-id",
        ACTOR_A,
        "--actor-id",
        ACTOR_B,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffTimelineNwayCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.actorIds).toEqual([ACTOR_A, ACTOR_B]);
    expect(capture[0]?.tenantIds).toEqual([TENANT_A, TENANT_B, TENANT_C]);
  });

  it("cross-table: threads actorIds alongside --cross-table (multi-actor)", async () => {
    const capture: DiffHistoryTimelineCrossTableInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        "workflow_traces",
        "llm_call_traces",
        "--cross-table",
        "--actor-id",
        ACTOR_A,
        "--actor-id",
        ACTOR_B,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTimelineCrossTableCapture: capture,
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.actorIds).toEqual([ACTOR_A, ACTOR_B]);
  });

  it("composes with --with-actor-names + --since + --limit", async () => {
    const capture: DiffHistoryTimelineInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--actor-id",
        ACTOR_A,
        "--with-actor-names",
        "--since",
        "2026-01-01",
        "--limit",
        "50",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffTimelineCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.actorIds).toEqual([ACTOR_A]);
    expect(capture[0]?.joinActor).toBe(true);
    expect(capture[0]?.since).toBe("2026-01-01T00:00:00.000Z");
    expect(capture[0]?.limit).toBe(50);
  });

  it("JSON envelope echoes actorIds field when --actor-id set (pair-wise, single)", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--actor-id",
        ACTOR_A,
        "--format",
        "json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.actorIds).toEqual([ACTOR_A]);
  });

  it("JSON envelope echoes actorIds array when --actor-id repeated (multi-actor)", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--actor-id",
        ACTOR_A,
        "--actor-id",
        ACTOR_B,
        "--format",
        "json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.actorIds).toEqual([ACTOR_A, ACTOR_B]);
  });

  it("JSON envelope actorIds=null when --actor-id NOT set", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--format",
        "json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.actorIds).toBeNull();
  });

  it("JSON envelope echoes actorIds on N-way path", async () => {
    const TENANT_C = "00000000-0000-4000-8000-00000000000C";
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--add-tenant",
        TENANT_C,
        "--actor-id",
        ACTOR_A,
        "--actor-id",
        ACTOR_B,
        "--format",
        "json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.nway).toBe(true);
    expect(parsed_.actorIds).toEqual([ACTOR_A, ACTOR_B]);
  });

  it("JSON envelope echoes actorIds on cross-table path", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        "workflow_traces",
        "llm_call_traces",
        "--cross-table",
        "--actor-id",
        ACTOR_A,
        "--actor-id",
        ACTOR_B,
        "--format",
        "json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.crossTable).toBe(true);
    expect(parsed_.actorIds).toEqual([ACTOR_A, ACTOR_B]);
  });
});

describe("runRetention diff-timeline --actor-id-not (M6.7.zz.tenant.opt-out.cli.diff-timeline.actor-not)", () => {
  const TENANT_A_ANN = "00000000-0000-4000-8000-000000000a01";
  const TENANT_B_ANN = "00000000-0000-4000-8000-000000000a02";
  const TENANT_C_ANN = "00000000-0000-4000-8000-000000000a03";
  const ACTOR_X = "11111111-1111-4000-8000-111111111111";
  const ACTOR_Y = "22222222-2222-4000-8000-222222222222";

  it("pair-wise: threads single actorIdsNot to adapter when --actor-id-not set", async () => {
    const capture: DiffHistoryTimelineInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A_ANN,
        TENANT_B_ANN,
        "workflow_traces",
        "--actor-id-not",
        ACTOR_X,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffTimelineCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.actorIdsNot).toEqual([ACTOR_X]);
  });

  it("pair-wise: threads multi actorIdsNot when --actor-id-not repeated", async () => {
    const capture: DiffHistoryTimelineInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A_ANN,
        TENANT_B_ANN,
        "workflow_traces",
        "--actor-id-not",
        ACTOR_X,
        "--actor-id-not",
        ACTOR_Y,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffTimelineCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.actorIdsNot).toEqual([ACTOR_X, ACTOR_Y]);
  });

  it("pair-wise: omits actorIdsNot when --actor-id-not NOT set (backward compat)", async () => {
    const capture: DiffHistoryTimelineInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A_ANN,
        TENANT_B_ANN,
        "workflow_traces",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffTimelineCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.actorIdsNot).toBeUndefined();
  });

  it("N-way: threads actorIdsNot alongside --add-tenant", async () => {
    const capture: DiffHistoryTimelineNwayInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A_ANN,
        TENANT_B_ANN,
        "workflow_traces",
        "--add-tenant",
        TENANT_C_ANN,
        "--actor-id-not",
        ACTOR_X,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffTimelineNwayCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.actorIdsNot).toEqual([ACTOR_X]);
  });

  it("cross-table: threads actorIdsNot alongside --cross-table", async () => {
    const capture: DiffHistoryTimelineCrossTableInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A_ANN,
        "workflow_traces",
        "llm_call_traces",
        "--cross-table",
        "--actor-id-not",
        ACTOR_X,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTimelineCrossTableCapture: capture,
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.actorIdsNot).toEqual([ACTOR_X]);
  });

  it("composes with --actor-id (positive + negative both threaded)", async () => {
    const capture: DiffHistoryTimelineInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A_ANN,
        TENANT_B_ANN,
        "workflow_traces",
        "--actor-id",
        ACTOR_X,
        "--actor-id-not",
        ACTOR_Y,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffTimelineCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.actorIds).toEqual([ACTOR_X]);
    expect(capture[0]?.actorIdsNot).toEqual([ACTOR_Y]);
  });

  it("pair-wise: JSON envelope echoes actorIdsNot when set", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A_ANN,
        TENANT_B_ANN,
        "workflow_traces",
        "--actor-id-not",
        ACTOR_X,
        "--format",
        "json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.actorIdsNot).toEqual([ACTOR_X]);
  });

  it("N-way: JSON envelope echoes actorIdsNot", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A_ANN,
        TENANT_B_ANN,
        "workflow_traces",
        "--add-tenant",
        TENANT_C_ANN,
        "--actor-id-not",
        ACTOR_X,
        "--actor-id-not",
        ACTOR_Y,
        "--format",
        "json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.nway).toBe(true);
    expect(parsed_.actorIdsNot).toEqual([ACTOR_X, ACTOR_Y]);
  });

  it("cross-table: JSON envelope echoes actorIdsNot", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A_ANN,
        "workflow_traces",
        "llm_call_traces",
        "--cross-table",
        "--actor-id-not",
        ACTOR_X,
        "--format",
        "json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.crossTable).toBe(true);
    expect(parsed_.actorIdsNot).toEqual([ACTOR_X]);
  });

  it("pair-wise: JSON envelope actorIdsNot=null when NOT set", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A_ANN,
        TENANT_B_ANN,
        "workflow_traces",
        "--format",
        "json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.actorIdsNot).toBeNull();
  });
});

describe("runRetention diff-timeline --system-only / --no-system (M6.7.zz.tenant.opt-out.cli.diff-timeline.system-only)", () => {
  const TENANT_A = "00000000-0000-4000-8000-00000000000A";
  const TENANT_B = "00000000-0000-4000-8000-00000000000B";
  const TENANT_C = "00000000-0000-4000-8000-00000000000C";
  const ACTOR_ALICE = "11111111-0000-4000-8000-000000000001";

  it("returns exit 2 when --system-only AND --no-system both set", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--system-only",
        "--no-system",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain(
      "--system-only and --no-system are mutually exclusive",
    );
  });

  it("pair-wise: threads actorPresence='system_only' when --system-only set", async () => {
    const capture: DiffHistoryTimelineInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--system-only",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffTimelineCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.actorPresence).toBe("system_only");
  });

  it("pair-wise: threads actorPresence='no_system' when --no-system set", async () => {
    const capture: DiffHistoryTimelineInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--no-system",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffTimelineCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.actorPresence).toBe("no_system");
  });

  it("pair-wise: omits actorPresence when neither flag set (backward compat)", async () => {
    const capture: DiffHistoryTimelineInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffTimelineCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.actorPresence).toBeUndefined();
  });

  it("N-way: threads actorPresence alongside --add-tenant", async () => {
    const capture: DiffHistoryTimelineNwayInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--add-tenant",
        TENANT_C,
        "--system-only",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTimelineNwayCapture: capture,
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.tenantIds).toEqual([TENANT_A, TENANT_B, TENANT_C]);
    expect(capture[0]?.actorPresence).toBe("system_only");
  });

  it("cross-table: threads actorPresence alongside --cross-table", async () => {
    const capture: DiffHistoryTimelineCrossTableInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        "workflow_traces",
        "llm_call_traces",
        "--cross-table",
        "--no-system",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTimelineCrossTableCapture: capture,
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.tenantId).toBe(TENANT_A);
    expect(capture[0]?.actorPresence).toBe("no_system");
  });

  it("pair-wise: composes with --actor-id-not + --no-system", async () => {
    const capture: DiffHistoryTimelineInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--actor-id-not",
        ACTOR_ALICE,
        "--no-system",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffTimelineCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.actorIdsNot).toEqual([ACTOR_ALICE]);
    expect(capture[0]?.actorPresence).toBe("no_system");
  });

  it("pair-wise: JSON envelope echoes systemOnly + noSystem when --system-only set", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--system-only",
        "--format=json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.action).toBe("diff-timeline");
    expect(parsed_.systemOnly).toBe(true);
    expect(parsed_.noSystem).toBe(false);
  });

  it("N-way: JSON envelope echoes systemOnly + noSystem when --no-system set", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--add-tenant",
        TENANT_C,
        "--no-system",
        "--format=json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.nway).toBe(true);
    expect(parsed_.systemOnly).toBe(false);
    expect(parsed_.noSystem).toBe(true);
  });

  it("cross-table: JSON envelope echoes systemOnly + noSystem when --system-only set", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        "workflow_traces",
        "llm_call_traces",
        "--cross-table",
        "--system-only",
        "--format=json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.crossTable).toBe(true);
    expect(parsed_.systemOnly).toBe(true);
    expect(parsed_.noSystem).toBe(false);
  });
});

describe("runRetention diff-timeline --kind (M6.7.zz.tenant.opt-out.cli.diff-timeline.kind-filter + .multi-kind)", () => {
  it("returns exit 2 when --kind is invalid value", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--kind",
        "bogus_kind",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("invalid --kind");
    expect(err()).toContain("opt_out_set");
  });

  it("returns exit 2 when any of multiple --kind values is invalid", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--kind",
        "opt_out_set",
        "--kind",
        "bogus_kind",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("invalid --kind 'bogus_kind'");
  });

  it("pair-wise: threads eventKinds as single-element array to adapter when --kind set once", async () => {
    const capture: DiffHistoryTimelineInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--kind",
        "opt_out_set",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffTimelineCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.eventKinds).toEqual(["opt_out_set"]);
  });

  it("pair-wise: --kind repeated builds multi-kind array (OR semantic)", async () => {
    const capture: DiffHistoryTimelineInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--kind",
        "opt_out_set",
        "--kind",
        "opt_out_cleared",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffTimelineCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.eventKinds).toEqual([
      "opt_out_set",
      "opt_out_cleared",
    ]);
  });

  it("pair-wise: omits eventKinds when --kind NOT set (backward compat)", async () => {
    const capture: DiffHistoryTimelineInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffTimelineCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.eventKinds).toBeUndefined();
  });

  it("N-way: threads eventKinds alongside --add-tenant (multi-kind)", async () => {
    const TENANT_C = "00000000-0000-4000-8000-00000000000C";
    const capture: DiffHistoryTimelineNwayInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--add-tenant",
        TENANT_C,
        "--kind",
        "policy_deleted",
        "--kind",
        "retention_set",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffTimelineNwayCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.eventKinds).toEqual([
      "policy_deleted",
      "retention_set",
    ]);
  });

  it("cross-table: threads eventKinds alongside --cross-table (multi-kind)", async () => {
    const capture: DiffHistoryTimelineCrossTableInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        "workflow_traces",
        "llm_call_traces",
        "--cross-table",
        "--kind",
        "retention_set",
        "--kind",
        "policy_deleted",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTimelineCrossTableCapture: capture,
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.eventKinds).toEqual([
      "retention_set",
      "policy_deleted",
    ]);
  });

  it("composes with --actor-id + --with-actor-names + --since (multi-actor + multi-kind)", async () => {
    const ACTOR_A = "11111111-1111-1111-1111-111111111111";
    const ACTOR_B = "22222222-2222-2222-2222-222222222222";
    const capture: DiffHistoryTimelineInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--actor-id",
        ACTOR_A,
        "--actor-id",
        ACTOR_B,
        "--kind",
        "opt_out_set",
        "--kind",
        "opt_out_cleared",
        "--with-actor-names",
        "--since",
        "2026-01-01",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffTimelineCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.actorIds).toEqual([ACTOR_A, ACTOR_B]);
    expect(capture[0]?.eventKinds).toEqual([
      "opt_out_set",
      "opt_out_cleared",
    ]);
    expect(capture[0]?.joinActor).toBe(true);
    expect(capture[0]?.since).toBe("2026-01-01T00:00:00.000Z");
  });

  it("JSON envelope echoes kinds field when --kind set (pair-wise, single)", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--kind",
        "opt_out_set",
        "--format",
        "json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.kinds).toEqual(["opt_out_set"]);
  });

  it("JSON envelope echoes kinds array when --kind repeated (multi-kind)", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--kind",
        "opt_out_set",
        "--kind",
        "opt_out_cleared",
        "--format",
        "json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.kinds).toEqual(["opt_out_set", "opt_out_cleared"]);
  });

  it("JSON envelope kinds=null when --kind NOT set", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--format",
        "json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.kinds).toBeNull();
  });

  it("JSON envelope echoes kinds on N-way path", async () => {
    const TENANT_C = "00000000-0000-4000-8000-00000000000C";
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--add-tenant",
        TENANT_C,
        "--kind",
        "policy_deleted",
        "--kind",
        "retention_set",
        "--format",
        "json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.nway).toBe(true);
    expect(parsed_.kinds).toEqual(["policy_deleted", "retention_set"]);
  });

  it("JSON envelope echoes kinds on cross-table path", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        "workflow_traces",
        "llm_call_traces",
        "--cross-table",
        "--kind",
        "retention_set",
        "--kind",
        "policy_deleted",
        "--format",
        "json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.crossTable).toBe(true);
    expect(parsed_.kinds).toEqual(["retention_set", "policy_deleted"]);
  });
});

describe("runRetention diff-timeline --kind-not (M6.7.zz.tenant.opt-out.cli.diff-timeline.kind-not.multi)", () => {
  const TENANT_A = "00000000-0000-4000-8000-00000000000A";
  const TENANT_B = "00000000-0000-4000-8000-00000000000B";

  it("returns exit 2 on invalid --kind-not value", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--kind-not",
        "bogus",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("invalid --kind-not 'bogus'");
  });

  it("returns exit 2 on FIRST invalid --kind-not occurrence", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--kind-not",
        "opt_out_set",
        "--kind-not",
        "bad",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("invalid --kind-not 'bad'");
  });

  it("pair-wise: threads single-element eventKindsNot array", async () => {
    const capture: DiffHistoryTimelineInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--kind-not",
        "policy_deleted",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffTimelineCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.eventKindsNot).toEqual(["policy_deleted"]);
  });

  it("pair-wise: threads multi-element eventKindsNot array when --kind-not repeated", async () => {
    const capture: DiffHistoryTimelineInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--kind-not",
        "policy_deleted",
        "--kind-not",
        "retention_set",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffTimelineCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.eventKindsNot).toEqual([
      "policy_deleted",
      "retention_set",
    ]);
  });

  it("pair-wise: composes --kind + --kind-not threading both independently", async () => {
    const capture: DiffHistoryTimelineInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--kind",
        "opt_out_set",
        "--kind-not",
        "policy_deleted",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffTimelineCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.eventKinds).toEqual(["opt_out_set"]);
    expect(capture[0]?.eventKindsNot).toEqual(["policy_deleted"]);
  });

  it("N-way: threads eventKindsNot via --add-tenant dispatch", async () => {
    const capture: DiffHistoryTimelineNwayInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--add-tenant",
        "00000000-0000-4000-8000-00000000000C",
        "--kind-not",
        "policy_deleted",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffTimelineNwayCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.eventKindsNot).toEqual(["policy_deleted"]);
  });

  it("cross-table: threads eventKindsNot via --cross-table dispatch", async () => {
    const capture: DiffHistoryTimelineCrossTableInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        "workflow_traces",
        "tenant_opt_outs",
        "--cross-table",
        "--kind-not",
        "policy_deleted",
        "--kind-not",
        "retention_set",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTimelineCrossTableCapture: capture,
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.eventKindsNot).toEqual([
      "policy_deleted",
      "retention_set",
    ]);
  });

  it("JSON envelope echoes kindsNot array (pair-wise)", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--kind-not",
        "policy_deleted",
        "--kind-not",
        "retention_set",
        "--format=json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.kindsNot).toEqual(["policy_deleted", "retention_set"]);
  });

  it("JSON envelope kindsNot=null when --kind-not not set", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--format=json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.kindsNot).toBeNull();
  });
});

describe("runRetention diff-timeline --after-id (M6.7.zz.tenant.opt-out.cli.diff-timeline.cursor)", () => {
  const AFTER_ID = "50000000-0000-4000-8000-000000000005";

  it("pair-wise: threads afterId to adapter when --after-id set", async () => {
    const capture: DiffHistoryTimelineInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--after-id",
        AFTER_ID,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffTimelineCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.afterId).toBe(AFTER_ID);
  });

  it("pair-wise: omits afterId when --after-id NOT set (backward compat)", async () => {
    const capture: DiffHistoryTimelineInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffTimelineCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.afterId).toBeUndefined();
  });

  it("N-way: threads afterId alongside --add-tenant", async () => {
    const TENANT_C = "00000000-0000-4000-8000-00000000000C";
    const capture: DiffHistoryTimelineNwayInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--add-tenant",
        TENANT_C,
        "--after-id",
        AFTER_ID,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffTimelineNwayCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.afterId).toBe(AFTER_ID);
  });

  it("cross-table: threads afterId alongside --cross-table", async () => {
    const capture: DiffHistoryTimelineCrossTableInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        "workflow_traces",
        "llm_call_traces",
        "--cross-table",
        "--after-id",
        AFTER_ID,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTimelineCrossTableCapture: capture,
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.afterId).toBe(AFTER_ID);
  });

  it("JSON envelope echoes afterId field when --after-id set (pair-wise)", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--after-id",
        AFTER_ID,
        "--format",
        "json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.afterId).toBe(AFTER_ID);
  });

  it("JSON envelope afterId=null when --after-id NOT set", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--format",
        "json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.afterId).toBeNull();
  });

  it("JSON envelope nextAfterId is the last entry id when entries.length === limit (pair-wise)", async () => {
    const { ctx, out } = buffers();
    const LAST_ID = "60000000-0000-4000-8000-000000000006";
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--limit",
        "2",
        "--format",
        "json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTimelineResult: {
            tenantIdA: TENANT_A,
            tenantIdB: TENANT_B,
            tableName: "workflow_traces",
            entries: [
              {
                id: "first",
                tenantId: TENANT_A,
                tenantSide: "A",
                tableName: "workflow_traces",
                eventKind: "opt_out_set",
                actorId: null,
                occurredAt: "2026-01-01T00:00:00.000Z",
                prevState: null,
                nextState: { opt_out: true, retention_days: 365 },
                attributes: {},
              },
              {
                id: LAST_ID,
                tenantId: TENANT_B,
                tenantSide: "B",
                tableName: "workflow_traces",
                eventKind: "retention_set",
                actorId: null,
                occurredAt: "2026-01-15T00:00:00.000Z",
                prevState: null,
                nextState: { opt_out: false, retention_days: 90, enabled: true },
                attributes: {},
              },
            ],
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.nextAfterId).toBe(LAST_ID);
  });

  it("JSON envelope nextAfterId is null when entries.length < limit", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--format",
        "json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.nextAfterId).toBeNull();
  });

  it("human-format prints next-page hint when entries.length === limit", async () => {
    const { ctx, out } = buffers();
    const LAST_ID = "60000000-0000-4000-8000-000000000006";
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--limit",
        "1",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTimelineResult: {
            tenantIdA: TENANT_A,
            tenantIdB: TENANT_B,
            tableName: "workflow_traces",
            entries: [
              {
                id: LAST_ID,
                tenantId: TENANT_A,
                tenantSide: "A",
                tableName: "workflow_traces",
                eventKind: "opt_out_set",
                actorId: null,
                occurredAt: "2026-01-01T00:00:00.000Z",
                prevState: null,
                nextState: { opt_out: true, retention_days: 365 },
                attributes: {},
              },
            ],
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain("Page full");
    expect(out()).toContain(`--after-id ${LAST_ID}`);
  });

  it("human-format omits next-page hint when entries.length < limit", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).not.toContain("Page full");
  });

  it("N-way: JSON envelope echoes afterId + nextAfterId on N-way path", async () => {
    const TENANT_C = "00000000-0000-4000-8000-00000000000C";
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--add-tenant",
        TENANT_C,
        "--after-id",
        AFTER_ID,
        "--format",
        "json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.nway).toBe(true);
    expect(parsed_.afterId).toBe(AFTER_ID);
    expect(parsed_.nextAfterId).toBeNull();
  });

  it("cross-table: JSON envelope echoes afterId + nextAfterId on cross-table path", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        "workflow_traces",
        "llm_call_traces",
        "--cross-table",
        "--after-id",
        AFTER_ID,
        "--format",
        "json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.crossTable).toBe(true);
    expect(parsed_.afterId).toBe(AFTER_ID);
    expect(parsed_.nextAfterId).toBeNull();
  });
});

describe("runRetention diff-timeline --before-id (M6.7.zz.tenant.opt-out.cli.diff-timeline.before-id)", () => {
  const BEFORE_ID = "80000000-0000-4000-8000-000000000008";
  const AFTER_ID = "50000000-0000-4000-8000-000000000005";
  const FIRST_ID = "10000000-0000-4000-8000-000000000001";
  const LAST_ID = "ff000000-0000-4000-8000-0000000000ff";

  it("pair-wise: threads beforeId to adapter when --before-id set", async () => {
    const capture: DiffHistoryTimelineInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--before-id",
        BEFORE_ID,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffTimelineCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.beforeId).toBe(BEFORE_ID);
  });

  it("pair-wise: omits beforeId when --before-id NOT set (backward compat)", async () => {
    const capture: DiffHistoryTimelineInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffTimelineCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.beforeId).toBeUndefined();
  });

  it("returns exit 2 when --after-id and --before-id are both set (mutually exclusive)", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--after-id",
        AFTER_ID,
        "--before-id",
        BEFORE_ID,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("mutually exclusive");
  });

  it("N-way: threads beforeId alongside --add-tenant", async () => {
    const TENANT_C = "00000000-0000-4000-8000-00000000000C";
    const capture: DiffHistoryTimelineNwayInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--add-tenant",
        TENANT_C,
        "--before-id",
        BEFORE_ID,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffTimelineNwayCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.beforeId).toBe(BEFORE_ID);
  });

  it("cross-table: threads beforeId alongside --cross-table", async () => {
    const capture: DiffHistoryTimelineCrossTableInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        "workflow_traces",
        "llm_call_traces",
        "--cross-table",
        "--before-id",
        BEFORE_ID,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTimelineCrossTableCapture: capture,
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.beforeId).toBe(BEFORE_ID);
  });

  it("JSON envelope echoes beforeId field when --before-id set (pair-wise)", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--before-id",
        BEFORE_ID,
        "--format",
        "json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.beforeId).toBe(BEFORE_ID);
  });

  it("JSON envelope beforeId=null when --before-id NOT set", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--format",
        "json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.beforeId).toBeNull();
  });

  it("JSON envelope nextBeforeId is the FIRST entry id when entries.length === limit (pair-wise, ASC: oldest first)", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--limit",
        "2",
        "--format",
        "json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTimelineResult: {
            tenantIdA: TENANT_A,
            tenantIdB: TENANT_B,
            tableName: "workflow_traces",
            entries: [
              {
                id: FIRST_ID,
                tenantId: TENANT_A,
                tenantSide: "A",
                tableName: "workflow_traces",
                eventKind: "opt_out_set",
                actorId: null,
                occurredAt: "2026-01-01T00:00:00.000Z",
                prevState: null,
                nextState: { opt_out: true, retention_days: 365 },
                attributes: {},
              },
              {
                id: LAST_ID,
                tenantId: TENANT_B,
                tenantSide: "B",
                tableName: "workflow_traces",
                eventKind: "retention_set",
                actorId: null,
                occurredAt: "2026-06-01T00:00:00.000Z",
                prevState: null,
                nextState: { retention_days: 90, opt_out: false, enabled: true },
                attributes: {},
              },
            ],
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.nextBeforeId).toBe(FIRST_ID);
    expect(parsed_.nextAfterId).toBe(LAST_ID);
  });

  it("JSON envelope nextBeforeId=null when entries.length < limit", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--format",
        "json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.nextBeforeId).toBeNull();
  });

  it("human-format prints previous-page hint when entries.length === limit", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--limit",
        "1",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTimelineResult: {
            tenantIdA: TENANT_A,
            tenantIdB: TENANT_B,
            tableName: "workflow_traces",
            entries: [
              {
                id: FIRST_ID,
                tenantId: TENANT_A,
                tenantSide: "A",
                tableName: "workflow_traces",
                eventKind: "opt_out_set",
                actorId: null,
                occurredAt: "2026-01-01T00:00:00.000Z",
                prevState: null,
                nextState: { opt_out: true },
                attributes: {},
              },
            ],
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain("previous page: crossengin retention diff-timeline --before-id");
    expect(out()).toContain(FIRST_ID);
  });

  it("N-way: JSON envelope echoes beforeId + nextBeforeId on N-way path", async () => {
    const TENANT_C = "00000000-0000-4000-8000-00000000000C";
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--add-tenant",
        TENANT_C,
        "--before-id",
        BEFORE_ID,
        "--format",
        "json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.nway).toBe(true);
    expect(parsed_.beforeId).toBe(BEFORE_ID);
    expect(parsed_.nextBeforeId).toBeNull();
  });

  it("cross-table: JSON envelope echoes beforeId + nextBeforeId on cross-table path", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        "workflow_traces",
        "llm_call_traces",
        "--cross-table",
        "--before-id",
        BEFORE_ID,
        "--format",
        "json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.crossTable).toBe(true);
    expect(parsed_.beforeId).toBe(BEFORE_ID);
    expect(parsed_.nextBeforeId).toBeNull();
  });
});

describe("runRetention diff-timeline --range (M6.7.zz.tenant.opt-out.cli.diff-timeline.range)", () => {
  const AFTER_ID = "50000000-0000-4000-8000-000000000005";
  const BEFORE_ID = "70000000-0000-4000-8000-000000000007";

  it("pair-wise: parses --range and threads both cursors to adapter", async () => {
    const capture: DiffHistoryTimelineInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--range",
        `${AFTER_ID}..${BEFORE_ID}`,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffTimelineCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.afterId).toBe(AFTER_ID);
    expect(capture[0]?.beforeId).toBe(BEFORE_ID);
  });

  it("N-way: parses --range and threads both cursors alongside --add-tenant", async () => {
    const TENANT_C = "00000000-0000-4000-8000-00000000000C";
    const capture: DiffHistoryTimelineNwayInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--add-tenant",
        TENANT_C,
        "--range",
        `${AFTER_ID}..${BEFORE_ID}`,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffTimelineNwayCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.afterId).toBe(AFTER_ID);
    expect(capture[0]?.beforeId).toBe(BEFORE_ID);
  });

  it("cross-table: parses --range and threads both cursors alongside --cross-table", async () => {
    const capture: DiffHistoryTimelineCrossTableInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        "workflow_traces",
        "llm_call_traces",
        "--cross-table",
        "--range",
        `${AFTER_ID}..${BEFORE_ID}`,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTimelineCrossTableCapture: capture,
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.afterId).toBe(AFTER_ID);
    expect(capture[0]?.beforeId).toBe(BEFORE_ID);
  });

  it("returns exit 2 when --range is missing the separator", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--range",
        AFTER_ID,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("invalid --range");
    expect(err()).toContain("<after-id>..<before-id>");
  });

  it("returns exit 2 when --range has empty after-id half", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--range",
        `..${BEFORE_ID}`,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("invalid --range");
  });

  it("returns exit 2 when --range has empty before-id half", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--range",
        `${AFTER_ID}..`,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("invalid --range");
  });

  it("returns exit 2 when --range combined with --after-id", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--range",
        `${AFTER_ID}..${BEFORE_ID}`,
        "--after-id",
        AFTER_ID,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain(
      "--range cannot be combined with --after-id or --before-id",
    );
  });

  it("returns exit 2 when --range combined with --before-id", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--range",
        `${AFTER_ID}..${BEFORE_ID}`,
        "--before-id",
        BEFORE_ID,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("--range cannot be combined with");
  });

  it("bare --after-id + --before-id without --range error message points at --range", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--after-id",
        AFTER_ID,
        "--before-id",
        BEFORE_ID,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("mutually exclusive");
    expect(err()).toContain("--range");
  });

  it("pair-wise: JSON envelope echoes range field + afterId + beforeId when --range set", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--range",
        `${AFTER_ID}..${BEFORE_ID}`,
        "--format",
        "json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.range).toBe(`${AFTER_ID}..${BEFORE_ID}`);
    expect(parsed_.afterId).toBe(AFTER_ID);
    expect(parsed_.beforeId).toBe(BEFORE_ID);
  });

  it("pair-wise: JSON envelope range=null when --range NOT set", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--format",
        "json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.range).toBeNull();
  });

  it("N-way: JSON envelope echoes range field on N-way path", async () => {
    const TENANT_C = "00000000-0000-4000-8000-00000000000C";
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--add-tenant",
        TENANT_C,
        "--range",
        `${AFTER_ID}..${BEFORE_ID}`,
        "--format",
        "json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.nway).toBe(true);
    expect(parsed_.range).toBe(`${AFTER_ID}..${BEFORE_ID}`);
    expect(parsed_.afterId).toBe(AFTER_ID);
    expect(parsed_.beforeId).toBe(BEFORE_ID);
  });

  it("cross-table: JSON envelope echoes range field on cross-table path", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        "workflow_traces",
        "llm_call_traces",
        "--cross-table",
        "--range",
        `${AFTER_ID}..${BEFORE_ID}`,
        "--format",
        "json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsed_ = JSON.parse(out());
    expect(parsed_.crossTable).toBe(true);
    expect(parsed_.range).toBe(`${AFTER_ID}..${BEFORE_ID}`);
    expect(parsed_.afterId).toBe(AFTER_ID);
    expect(parsed_.beforeId).toBe(BEFORE_ID);
  });

  it("composes with --actor-id + --kind + --with-actor-names + --since", async () => {
    const ACTOR_A = "11111111-1111-1111-1111-111111111111";
    const capture: DiffHistoryTimelineInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff-timeline",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--actor-id",
        ACTOR_A,
        "--kind",
        "opt_out_set",
        "--with-actor-names",
        "--since",
        "2026-01-01",
        "--range",
        `${AFTER_ID}..${BEFORE_ID}`,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffTimelineCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.actorIds).toEqual([ACTOR_A]);
    expect(capture[0]?.eventKinds).toEqual(["opt_out_set"]);
    expect(capture[0]?.joinActor).toBe(true);
    expect(capture[0]?.afterId).toBe(AFTER_ID);
    expect(capture[0]?.beforeId).toBe(BEFORE_ID);
    expect(capture[0]?.since).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("formatTimelineCrossTableDiff", () => {
  it("renders 'No history events for this tenant' when entries empty", () => {
    const out = formatTimelineCrossTableDiff({
      tenantId: TENANT_A,
      tableNames: ["workflow_traces", "llm_call_traces"],
      entries: [],
    });
    expect(out).toContain(
      `Cross-table timeline for tenant ${TENANT_A} across 2 tables`,
    );
    expect(out).toContain("Table A: workflow_traces");
    expect(out).toContain("Table B: llm_call_traces");
    expect(out).toContain(
      "No history events for this tenant on any of these tables.",
    );
  });

  it("renders [A]/[B]/[C] tagged event lines with state summary", () => {
    const out = formatTimelineCrossTableDiff({
      tenantId: TENANT_A,
      tableNames: ["workflow_traces", "llm_call_traces", "llm_latency_samples"],
      entries: [
        {
          id: "h1",
          tenantId: TENANT_A,
          tableName: "llm_latency_samples",
          tableLabel: "C",
          eventKind: "opt_out_set",
          actorId: null,
          occurredAt: "2026-01-01T00:00:00.000Z",
          prevState: null,
          nextState: {
            opt_out: true,
            retention_days: 365,
            opt_out_reason: "legal-hold",
          },
          attributes: {},
        },
      ],
    });
    expect(out).toContain("Events (1):");
    expect(out).toContain("[C] opt_out_set");
    expect(out).toContain("retention=365");
    expect(out).toContain("reason=legal-hold");
  });

  it("renders 'by Alice Smith (uuid)' suffix when withActorNames=true opt", () => {
    const out = formatTimelineCrossTableDiff(
      {
        tenantId: TENANT_A,
        tableNames: ["workflow_traces", "llm_call_traces"],
        entries: [
          {
            id: "h1",
            tenantId: TENANT_A,
            tableName: "workflow_traces",
            tableLabel: "A",
            eventKind: "opt_out_set",
            actorId: "11111111-1111-1111-1111-111111111111",
            occurredAt: "2026-01-01T00:00:00.000Z",
            prevState: null,
            nextState: { opt_out: true, retention_days: 365 },
            attributes: {},
            actorDisplayName: "Alice Smith",
            actorEmail: "alice@example.com",
          },
        ],
      },
      { withActorNames: true },
    );
    expect(out).toContain(
      "by Alice Smith (11111111-1111-1111-1111-111111111111)",
    );
  });
});

describe("formatTimelineDiff", () => {
  it("renders 'No history events' header when entries empty", () => {
    const out = formatTimelineDiff({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
      entries: [],
    });
    expect(out).toContain("Timeline for tenants on workflow_traces");
    expect(out).toContain(`Tenant A: ${TENANT_A}`);
    expect(out).toContain(`Tenant B: ${TENANT_B}`);
    expect(out).toContain("No history events for either tenant on this table.");
  });

  it("renders Events (N) header + tagged per-event lines with state summary", () => {
    const out = formatTimelineDiff({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
      entries: [
        {
          id: "h1",
          tenantId: TENANT_A,
          tenantSide: "A",
          tableName: "workflow_traces",
          eventKind: "opt_out_set",
          occurredAt: "2026-01-01T00:00:00.000Z",
          prevState: null,
          nextState: {
            opt_out: true,
            retention_days: 365,
            opt_out_reason: "legal-hold",
          },
          attributes: {},
        },
      ],
    });
    expect(out).toContain("Events (1):");
    expect(out).toContain("[A] opt_out_set");
    expect(out).toContain("retention=365");
    expect(out).toContain("opt_out=true");
    expect(out).toContain("reason=legal-hold");
  });

  it("renders '(policy deleted)' for entries with nextState=null", () => {
    const out = formatTimelineDiff({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
      entries: [
        {
          id: "h1",
          tenantId: TENANT_B,
          tenantSide: "B",
          tableName: "workflow_traces",
          eventKind: "policy_deleted",
          occurredAt: "2026-02-01T00:00:00.000Z",
          prevState: { retention_days: 90 },
          nextState: null,
          attributes: {},
        },
      ],
    });
    expect(out).toContain("[B] policy_deleted");
    expect(out).toContain("(policy deleted)");
  });

  it("renders multiple events in input (chronological) order with [A]/[B] tags interleaved", () => {
    const out = formatTimelineDiff({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
      entries: [
        {
          id: "h1",
          tenantId: TENANT_A,
          tenantSide: "A",
          tableName: "workflow_traces",
          eventKind: "opt_out_set",
          occurredAt: "2026-01-01T00:00:00.000Z",
          prevState: null,
          nextState: { opt_out: true, retention_days: 365 },
          attributes: {},
        },
        {
          id: "h2",
          tenantId: TENANT_B,
          tenantSide: "B",
          tableName: "workflow_traces",
          eventKind: "retention_set",
          occurredAt: "2026-01-15T00:00:00.000Z",
          prevState: null,
          nextState: { retention_days: 90, enabled: true, opt_out: false },
          attributes: {},
        },
        {
          id: "h3",
          tenantId: TENANT_A,
          tenantSide: "A",
          tableName: "workflow_traces",
          eventKind: "opt_out_cleared",
          occurredAt: "2026-02-01T00:00:00.000Z",
          prevState: { opt_out: true },
          nextState: { opt_out: false, retention_days: 365, enabled: false },
          attributes: {},
        },
      ],
    });
    const idx1 = out.indexOf("[A] opt_out_set");
    const idx2 = out.indexOf("[B] retention_set");
    const idx3 = out.indexOf("[A] opt_out_cleared");
    expect(idx1).toBeLessThan(idx2);
    expect(idx2).toBeLessThan(idx3);
  });

  it("renders 'by <actor-name> (uuid)' suffix when withActorNames opt is true", () => {
    const out = formatTimelineDiff(
      {
        tenantIdA: TENANT_A,
        tenantIdB: TENANT_B,
        tableName: "workflow_traces",
        entries: [
          {
            id: "h1",
            tenantId: TENANT_A,
            tenantSide: "A",
            tableName: "workflow_traces",
            eventKind: "opt_out_set",
            actorId: "11111111-1111-1111-1111-111111111111",
            occurredAt: "2026-01-01T00:00:00.000Z",
            prevState: null,
            nextState: { opt_out: true, retention_days: 365 },
            attributes: {},
            actorDisplayName: "Alice Smith",
            actorEmail: "alice@example.com",
          },
        ],
      },
      { withActorNames: true },
    );
    expect(out).toContain(
      "by Alice Smith (11111111-1111-1111-1111-111111111111)",
    );
  });

  it("renders 'by <system>' when actorId is null + withActorNames=true", () => {
    const out = formatTimelineDiff(
      {
        tenantIdA: TENANT_A,
        tenantIdB: TENANT_B,
        tableName: "workflow_traces",
        entries: [
          {
            id: "h1",
            tenantId: TENANT_A,
            tenantSide: "A",
            tableName: "workflow_traces",
            eventKind: "policy_deleted",
            actorId: null,
            occurredAt: "2026-01-01T00:00:00.000Z",
            prevState: null,
            nextState: null,
            attributes: {},
            actorDisplayName: null,
            actorEmail: null,
          },
        ],
      },
      { withActorNames: true },
    );
    expect(out).toContain("by <system>");
  });

  it("omits 'by' suffix when withActorNames opt is not set (default false)", () => {
    const out = formatTimelineDiff({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
      entries: [
        {
          id: "h1",
          tenantId: TENANT_A,
          tenantSide: "A",
          tableName: "workflow_traces",
          eventKind: "opt_out_set",
          actorId: "11111111-1111-1111-1111-111111111111",
          occurredAt: "2026-01-01T00:00:00.000Z",
          prevState: null,
          nextState: { opt_out: true, retention_days: 365 },
          attributes: {},
        },
      ],
    });
    expect(out).not.toContain("by ");
  });
});

describe("runRetention diff (M6.7.zz.tenant.opt-out.cli.diff)", () => {
  it("returns exit 2 when tenantA arg is missing", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(parsed("retention", "diff"), {
      ...ctx,
      retentionOverride: fakeRetention({}),
    } as RetentionContext);
    expect(code).toBe(2);
    expect(err()).toContain("missing arguments");
  });

  it("returns exit 2 when tenantB arg is missing", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed("retention", "diff", TENANT_A),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("missing arguments");
  });

  it("returns exit 2 when table arg is missing", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed("retention", "diff", TENANT_A, TENANT_B),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("missing arguments");
  });

  it("threads three args to adapter", async () => {
    const { ctx } = buffers();
    const diffTenantCapture: DiffTenantPoliciesInput[] = [];
    const code = await runRetention(
      parsed("retention", "diff", TENANT_A, TENANT_B, "workflow_traces"),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffTenantCapture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(diffTenantCapture[0]).toEqual({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
    });
  });

  it("human-format renders 'No differences' when fieldDiffs is empty", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "diff", TENANT_A, TENANT_B, "workflow_traces"),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTenantResult: {
            tenantIdA: TENANT_A,
            tenantIdB: TENANT_B,
            tableName: "workflow_traces",
            resolutionA: {
              source: "platform",
              retentionDays: 90,
              enabled: true,
            },
            resolutionB: {
              source: "platform",
              retentionDays: 90,
              enabled: true,
            },
            fieldDiffs: [],
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain("No differences");
    expect(out()).toContain("same effective retention policy");
  });

  it("human-format renders metadata + per-tenant resolutions + field-by-field diff", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "diff", TENANT_A, TENANT_B, "workflow_traces"),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTenantResult: {
            tenantIdA: TENANT_A,
            tenantIdB: TENANT_B,
            tableName: "workflow_traces",
            resolutionA: {
              source: "tenant",
              retentionDays: 30,
              enabled: true,
              tenantId: TENANT_A,
            },
            resolutionB: {
              source: "platform",
              retentionDays: 90,
              enabled: true,
            },
            fieldDiffs: [
              { field: "retention_days", valueA: 30, valueB: 90 },
              { field: "source", valueA: "tenant", valueB: "platform" },
            ],
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain("Diff between tenant policies");
    expect(out()).toContain("table: workflow_traces");
    expect(out()).toContain(`Tenant A: ${TENANT_A}`);
    expect(out()).toContain(`Tenant B: ${TENANT_B}`);
    expect(out()).toContain("source=tenant");
    expect(out()).toContain("source=platform");
    expect(out()).toContain("Field changes (2)");
    expect(out()).toContain('"30"  →  "90"'.replace(/"/g, "")); // values rendered as JSON
  });

  it("human-format renders tenant_opt_out resolution with reason + until", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed("retention", "diff", TENANT_A, TENANT_B, "workflow_traces"),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTenantResult: {
            tenantIdA: TENANT_A,
            tenantIdB: TENANT_B,
            tableName: "workflow_traces",
            resolutionA: {
              source: "tenant_opt_out",
              retentionDays: null,
              enabled: false,
              tenantId: TENANT_A,
              optOutReason: "legal_hold:case#42",
              optOutUntil: "2027-01-01T00:00:00.000Z",
            },
            resolutionB: {
              source: "none",
              retentionDays: null,
              enabled: false,
            },
            fieldDiffs: [
              { field: "source", valueA: "tenant_opt_out", valueB: "none" },
            ],
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain("source=tenant_opt_out");
    expect(out()).toContain("reason=legal_hold:case#42");
    expect(out()).toContain("until=2027-01-01T00:00:00.000Z");
    expect(out()).toContain("source=none");
    expect(out()).toContain("(no policy configured)");
  });

  it("json-format emits envelope {action, result} with full structure", async () => {
    const { ctx, out } = buffers();
    const resolutionA: EffectiveRetentionResolution = {
      source: "tenant",
      retentionDays: 30,
      enabled: true,
      tenantId: TENANT_A,
    };
    const resolutionB: EffectiveRetentionResolution = {
      source: "platform",
      retentionDays: 90,
      enabled: true,
    };
    const code = await runRetention(
      parsed(
        "retention",
        "diff",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--format=json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTenantResult: {
            tenantIdA: TENANT_A,
            tenantIdB: TENANT_B,
            tableName: "workflow_traces",
            resolutionA,
            resolutionB,
            fieldDiffs: [
              { field: "source", valueA: "tenant", valueB: "platform" },
            ],
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsedJson = JSON.parse(out());
    expect(parsedJson.action).toBe("diff");
    expect(parsedJson.result.tenantIdA).toBe(TENANT_A);
    expect(parsedJson.result.tenantIdB).toBe(TENANT_B);
    expect(parsedJson.result.tableName).toBe("workflow_traces");
    expect(parsedJson.result.resolutionA).toEqual(resolutionA);
    expect(parsedJson.result.resolutionB).toEqual(resolutionB);
    expect(parsedJson.result.fieldDiffs).toHaveLength(1);
  });

  it("propagates adapter errors as exit 1", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed("retention", "diff", TENANT_A, TENANT_B, "workflow_traces"),
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

describe("runRetention diff --vs-platform (M6.7.zz.tenant.opt-out.cli.diff.vs-platform)", () => {
  it("returns exit 2 when tenant arg is missing", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed("retention", "diff", "--vs-platform"),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("missing arguments");
    expect(err()).toContain("--vs-platform");
  });

  it("returns exit 2 when table arg is missing", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed("retention", "diff", TENANT_A, "--vs-platform"),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("missing arguments");
  });

  it("calls diffTenantVsPlatform NOT diffTenantPolicies", async () => {
    const { ctx } = buffers();
    const diffTenantCapture: DiffTenantPoliciesInput[] = [];
    const diffTenantVsPlatformCapture: DiffTenantVsPlatformInput[] = [];
    const code = await runRetention(
      parsed(
        "retention",
        "diff",
        TENANT_A,
        "workflow_traces",
        "--vs-platform",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTenantCapture,
          diffTenantVsPlatformCapture,
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(diffTenantCapture).toHaveLength(0);
    expect(diffTenantVsPlatformCapture).toHaveLength(1);
    expect(diffTenantVsPlatformCapture[0]).toEqual({
      tenantId: TENANT_A,
      tableName: "workflow_traces",
    });
  });

  it("human-format renders 'No differences' message when fieldDiffs empty", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff",
        TENANT_A,
        "workflow_traces",
        "--vs-platform",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTenantVsPlatformResult: {
            tenantId: TENANT_A,
            tableName: "workflow_traces",
            tenantResolution: {
              source: "platform",
              retentionDays: 90,
              enabled: true,
            },
            platformResolution: {
              source: "platform",
              retentionDays: 90,
              enabled: true,
            },
            fieldDiffs: [],
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain(
      "Diff between tenant and platform default (table: workflow_traces)",
    );
    expect(out()).toContain(
      "No differences — tenant has the same effective retention policy as the platform default.",
    );
  });

  it("human-format renders 'Field changes' for non-empty diff", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff",
        TENANT_A,
        "workflow_traces",
        "--vs-platform",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTenantVsPlatformResult: {
            tenantId: TENANT_A,
            tableName: "workflow_traces",
            tenantResolution: {
              source: "tenant",
              retentionDays: 30,
              enabled: true,
              tenantId: TENANT_A,
            },
            platformResolution: {
              source: "platform",
              retentionDays: 90,
              enabled: true,
            },
            fieldDiffs: [
              { field: "retention_days", valueA: 30, valueB: 90 },
              { field: "source", valueA: "tenant", valueB: "platform" },
            ],
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain("Field changes (2):");
    expect(out()).toContain("retention_days");
    expect(out()).toContain("30  →  90");
    expect(out()).toContain('"tenant"  →  "platform"');
  });

  it("JSON envelope includes vsPlatform:true discriminator + result", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff",
        TENANT_A,
        "workflow_traces",
        "--vs-platform",
        "--format=json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTenantVsPlatformResult: {
            tenantId: TENANT_A,
            tableName: "workflow_traces",
            tenantResolution: {
              source: "tenant",
              retentionDays: 30,
              enabled: true,
              tenantId: TENANT_A,
            },
            platformResolution: {
              source: "platform",
              retentionDays: 90,
              enabled: true,
            },
            fieldDiffs: [],
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsedOut = JSON.parse(out());
    expect(parsedOut.action).toBe("diff");
    expect(parsedOut.vsPlatform).toBe(true);
    expect(parsedOut.result.tenantId).toBe(TENANT_A);
    expect(parsedOut.result.platformResolution.source).toBe("platform");
  });

  it("propagates adapter errors as exit 1", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff",
        TENANT_A,
        "workflow_traces",
        "--vs-platform",
      ),
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

describe("runRetention diff --cross-table (M6.7.zz.tenant.opt-out.cli.diff.cross-table)", () => {
  it("returns exit 2 when tenant arg is missing", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed("retention", "diff", "--cross-table"),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("missing arguments");
    expect(err()).toContain("--cross-table");
  });

  it("returns exit 2 when table-a arg is missing", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed("retention", "diff", TENANT_A, "--cross-table"),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("missing arguments");
  });

  it("returns exit 2 when table-b arg is missing", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed("retention", "diff", TENANT_A, "workflow_traces", "--cross-table"),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("missing arguments");
  });

  it("returns exit 2 when --vs-platform and --cross-table are both set", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff",
        TENANT_A,
        "workflow_traces",
        "llm_call_traces",
        "--cross-table",
        "--vs-platform",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("mutually exclusive");
  });

  it("calls diffTenantTables NOT diffTenantPolicies or diffTenantVsPlatform", async () => {
    const { ctx } = buffers();
    const diffTenantCapture: DiffTenantPoliciesInput[] = [];
    const diffTenantVsPlatformCapture: DiffTenantVsPlatformInput[] = [];
    const diffTenantTablesCapture: DiffTenantTablesInput[] = [];
    const code = await runRetention(
      parsed(
        "retention",
        "diff",
        TENANT_A,
        "workflow_traces",
        "llm_call_traces",
        "--cross-table",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTenantCapture,
          diffTenantVsPlatformCapture,
          diffTenantTablesCapture,
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(diffTenantCapture).toHaveLength(0);
    expect(diffTenantVsPlatformCapture).toHaveLength(0);
    expect(diffTenantTablesCapture).toHaveLength(1);
    expect(diffTenantTablesCapture[0]).toEqual({
      tenantId: TENANT_A,
      tableNameA: "workflow_traces",
      tableNameB: "llm_call_traces",
    });
  });

  it("human-format renders 'No differences' message when fieldDiffs empty", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff",
        TENANT_A,
        "workflow_traces",
        "llm_call_traces",
        "--cross-table",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTenantTablesResult: {
            tenantId: TENANT_A,
            tableNameA: "workflow_traces",
            tableNameB: "llm_call_traces",
            resolutionA: {
              source: "platform",
              retentionDays: 90,
              enabled: true,
            },
            resolutionB: {
              source: "platform",
              retentionDays: 90,
              enabled: true,
            },
            fieldDiffs: [],
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain(`Diff between tables for tenant ${TENANT_A}`);
    expect(out()).toContain(
      "No differences — both tables resolve to the same effective retention policy for this tenant.",
    );
  });

  it("human-format renders metadata + per-table resolutions + 'Field changes'", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff",
        TENANT_A,
        "workflow_traces",
        "llm_call_traces",
        "--cross-table",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTenantTablesResult: {
            tenantId: TENANT_A,
            tableNameA: "workflow_traces",
            tableNameB: "llm_call_traces",
            resolutionA: {
              source: "tenant",
              retentionDays: 30,
              enabled: true,
              tenantId: TENANT_A,
            },
            resolutionB: {
              source: "platform",
              retentionDays: 365,
              enabled: true,
            },
            fieldDiffs: [
              { field: "retention_days", valueA: 30, valueB: 365 },
              { field: "source", valueA: "tenant", valueB: "platform" },
            ],
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain("Table A: workflow_traces");
    expect(out()).toContain("Table B: llm_call_traces");
    expect(out()).toContain("source=tenant");
    expect(out()).toContain("source=platform");
    expect(out()).toContain("Field changes (2):");
    expect(out()).toContain("30  →  365");
  });

  it("JSON envelope includes crossTable:true discriminator + result", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff",
        TENANT_A,
        "workflow_traces",
        "llm_call_traces",
        "--cross-table",
        "--format=json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTenantTablesResult: {
            tenantId: TENANT_A,
            tableNameA: "workflow_traces",
            tableNameB: "llm_call_traces",
            resolutionA: {
              source: "tenant",
              retentionDays: 30,
              enabled: true,
              tenantId: TENANT_A,
            },
            resolutionB: {
              source: "platform",
              retentionDays: 90,
              enabled: true,
            },
            fieldDiffs: [],
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsedOut = JSON.parse(out());
    expect(parsedOut.action).toBe("diff");
    expect(parsedOut.crossTable).toBe(true);
    expect(parsedOut.result.tenantId).toBe(TENANT_A);
    expect(parsedOut.result.tableNameA).toBe("workflow_traces");
    expect(parsedOut.result.tableNameB).toBe("llm_call_traces");
  });

  it("propagates adapter errors as exit 1", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff",
        TENANT_A,
        "workflow_traces",
        "llm_call_traces",
        "--cross-table",
      ),
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

describe("runRetention diff --add-tenant (M6.7.zz.tenant.opt-out.cli.diff.add-tenant)", () => {
  const TENANT_C = "00000000-0000-4000-8000-00000000000C";
  const TENANT_D = "00000000-0000-4000-8000-00000000000D";

  it("returns exit 2 when --add-tenant + --vs-platform are both set", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff",
        TENANT_A,
        "workflow_traces",
        "--vs-platform",
        "--add-tenant",
        TENANT_C,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("mutually exclusive");
  });

  it("returns exit 2 when --add-tenant + --cross-table are both set", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff",
        TENANT_A,
        "workflow_traces",
        "llm_call_traces",
        "--cross-table",
        "--add-tenant",
        TENANT_C,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("mutually exclusive");
  });

  it("returns exit 2 when missing required positional args", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed("retention", "diff", TENANT_A, "--add-tenant", TENANT_C),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("missing arguments");
    expect(err()).toContain("--add-tenant");
  });

  it("calls diffTenantPoliciesNway with [a, b, c] from positionals + 1 --add-tenant", async () => {
    const capture: DiffTenantPoliciesNwayInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--add-tenant",
        TENANT_C,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffTenantNwayCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture).toHaveLength(1);
    expect(capture[0]).toEqual({
      tenantIds: [TENANT_A, TENANT_B, TENANT_C],
      tableName: "workflow_traces",
    });
  });

  it("collects multiple --add-tenant flags in order", async () => {
    const capture: DiffTenantPoliciesNwayInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--add-tenant",
        TENANT_C,
        "--add-tenant",
        TENANT_D,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffTenantNwayCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.tenantIds).toEqual([
      TENANT_A,
      TENANT_B,
      TENANT_C,
      TENANT_D,
    ]);
  });

  it("human-format renders 'No differences' message when fieldVariations empty", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--add-tenant",
        TENANT_C,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTenantNwayResult: {
            tenantIds: [TENANT_A, TENANT_B, TENANT_C],
            tableName: "workflow_traces",
            resolutions: [
              {
                tenantId: TENANT_A,
                resolution: {
                  source: "platform",
                  retentionDays: 90,
                  enabled: true,
                },
              },
              {
                tenantId: TENANT_B,
                resolution: {
                  source: "platform",
                  retentionDays: 90,
                  enabled: true,
                },
              },
              {
                tenantId: TENANT_C,
                resolution: {
                  source: "platform",
                  retentionDays: 90,
                  enabled: true,
                },
              },
            ],
            fieldVariations: [],
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain("N-way diff between 3 tenants");
    expect(out()).toContain(
      "No differences — all 3 tenants have the same effective retention policy.",
    );
  });

  it("human-format renders per-field variations with tenant attribution", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--add-tenant",
        TENANT_C,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTenantNwayResult: {
            tenantIds: [TENANT_A, TENANT_B, TENANT_C],
            tableName: "workflow_traces",
            resolutions: [
              {
                tenantId: TENANT_A,
                resolution: {
                  source: "tenant",
                  retentionDays: 30,
                  enabled: true,
                  tenantId: TENANT_A,
                },
              },
              {
                tenantId: TENANT_B,
                resolution: {
                  source: "platform",
                  retentionDays: 90,
                  enabled: true,
                },
              },
              {
                tenantId: TENANT_C,
                resolution: {
                  source: "platform",
                  retentionDays: 90,
                  enabled: true,
                },
              },
            ],
            fieldVariations: [
              {
                field: "retention_days",
                distinctValues: [
                  { value: 30, labels: [TENANT_A] },
                  { value: 90, labels: [TENANT_B, TENANT_C] },
                ],
              },
              {
                field: "source",
                distinctValues: [
                  { value: "tenant", labels: [TENANT_A] },
                  { value: "platform", labels: [TENANT_B, TENANT_C] },
                ],
              },
            ],
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain("Field variations (2):");
    expect(out()).toContain(`Tenant A: ${TENANT_A}`);
    expect(out()).toContain(`Tenant B: ${TENANT_B}`);
    expect(out()).toContain(`Tenant C: ${TENANT_C}`);
    expect(out()).toContain("30 (A) | 90 (B, C)");
    expect(out()).toContain('"tenant" (A) | "platform" (B, C)');
  });

  it("JSON envelope includes nway:true discriminator + result", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--add-tenant",
        TENANT_C,
        "--format=json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsedOut = JSON.parse(out());
    expect(parsedOut.action).toBe("diff");
    expect(parsedOut.nway).toBe(true);
    expect(parsedOut.result.tenantIds).toEqual([TENANT_A, TENANT_B, TENANT_C]);
    expect(parsedOut.result.resolutions).toHaveLength(3);
  });

  it("--exit-on-divergence + non-empty fieldVariations returns exit 3", async () => {
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--add-tenant",
        TENANT_C,
        "--exit-on-divergence",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTenantNwayResult: {
            tenantIds: [TENANT_A, TENANT_B, TENANT_C],
            tableName: "workflow_traces",
            resolutions: [
              {
                tenantId: TENANT_A,
                resolution: {
                  source: "tenant",
                  retentionDays: 30,
                  enabled: true,
                  tenantId: TENANT_A,
                },
              },
              {
                tenantId: TENANT_B,
                resolution: {
                  source: "platform",
                  retentionDays: 90,
                  enabled: true,
                },
              },
              {
                tenantId: TENANT_C,
                resolution: {
                  source: "platform",
                  retentionDays: 90,
                  enabled: true,
                },
              },
            ],
            fieldVariations: [
              {
                field: "source",
                distinctValues: [
                  { value: "tenant", labels: [TENANT_A] },
                  { value: "platform", labels: [TENANT_B, TENANT_C] },
                ],
              },
            ],
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(3);
  });

  it("adapter errors propagate as exit 1", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--add-tenant",
        TENANT_C,
      ),
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

describe("runRetention diff --cross-table --add-table (M6.7.zz.tenant.opt-out.cli.diff.add-table)", () => {
  it("returns exit 2 when --add-table is set without --cross-table", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff",
        TENANT_A,
        "workflow_traces",
        "llm_call_traces",
        "--add-table",
        "tenant_retention_opt_out_history",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("--add-table requires --cross-table");
  });

  it("returns exit 2 when --add-table + --add-tenant + --cross-table are all set", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff",
        TENANT_A,
        "workflow_traces",
        "llm_call_traces",
        "--cross-table",
        "--add-table",
        "tenant_retention_opt_out_history",
        "--add-tenant",
        TENANT_B,
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("mutually exclusive");
  });

  it("returns exit 2 when missing required positional args", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff",
        TENANT_A,
        "--cross-table",
        "--add-table",
        "tenant_retention_opt_out_history",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("missing arguments");
  });

  it("calls diffTenantTablesNway with [table-a, table-b, table-c] from positionals + 1 --add-table", async () => {
    const capture: DiffTenantTablesNwayInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff",
        TENANT_A,
        "workflow_traces",
        "llm_call_traces",
        "--cross-table",
        "--add-table",
        "tenant_retention_opt_out_history",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTenantTablesNwayCapture: capture,
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture).toHaveLength(1);
    expect(capture[0]).toEqual({
      tenantId: TENANT_A,
      tableNames: [
        "workflow_traces",
        "llm_call_traces",
        "tenant_retention_opt_out_history",
      ],
    });
  });

  it("collects multiple --add-table flags in order", async () => {
    const capture: DiffTenantTablesNwayInput[] = [];
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff",
        TENANT_A,
        "workflow_traces",
        "llm_call_traces",
        "--cross-table",
        "--add-table",
        "tenant_retention_opt_out_history",
        "--add-table",
        "llm_latency_samples",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTenantTablesNwayCapture: capture,
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(capture[0]?.tableNames).toEqual([
      "workflow_traces",
      "llm_call_traces",
      "tenant_retention_opt_out_history",
      "llm_latency_samples",
    ]);
  });

  it("human-format renders 'No differences' when fieldVariations empty", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff",
        TENANT_A,
        "workflow_traces",
        "llm_call_traces",
        "--cross-table",
        "--add-table",
        "tenant_retention_opt_out_history",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTenantTablesNwayResult: {
            tenantId: TENANT_A,
            tableNames: [
              "workflow_traces",
              "llm_call_traces",
              "tenant_retention_opt_out_history",
            ],
            resolutions: [
              {
                tableName: "workflow_traces",
                resolution: {
                  source: "platform",
                  retentionDays: 90,
                  enabled: true,
                },
              },
              {
                tableName: "llm_call_traces",
                resolution: {
                  source: "platform",
                  retentionDays: 90,
                  enabled: true,
                },
              },
              {
                tableName: "tenant_retention_opt_out_history",
                resolution: {
                  source: "platform",
                  retentionDays: 90,
                  enabled: true,
                },
              },
            ],
            fieldVariations: [],
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain("N-way diff across 3 tables for tenant");
    expect(out()).toContain(
      "No differences — all 3 tables resolve to the same effective retention policy for this tenant.",
    );
  });

  it("human-format renders per-field variations with table labels", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff",
        TENANT_A,
        "workflow_traces",
        "llm_call_traces",
        "--cross-table",
        "--add-table",
        "tenant_retention_opt_out_history",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTenantTablesNwayResult: {
            tenantId: TENANT_A,
            tableNames: [
              "workflow_traces",
              "llm_call_traces",
              "tenant_retention_opt_out_history",
            ],
            resolutions: [
              {
                tableName: "workflow_traces",
                resolution: {
                  source: "tenant",
                  retentionDays: 30,
                  enabled: true,
                  tenantId: TENANT_A,
                },
              },
              {
                tableName: "llm_call_traces",
                resolution: {
                  source: "platform",
                  retentionDays: 90,
                  enabled: true,
                },
              },
              {
                tableName: "tenant_retention_opt_out_history",
                resolution: {
                  source: "platform",
                  retentionDays: 90,
                  enabled: true,
                },
              },
            ],
            fieldVariations: [
              {
                field: "retention_days",
                distinctValues: [
                  { value: 30, labels: ["workflow_traces"] },
                  {
                    value: 90,
                    labels: ["llm_call_traces", "tenant_retention_opt_out_history"],
                  },
                ],
              },
              {
                field: "source",
                distinctValues: [
                  { value: "tenant", labels: ["workflow_traces"] },
                  {
                    value: "platform",
                    labels: ["llm_call_traces", "tenant_retention_opt_out_history"],
                  },
                ],
              },
            ],
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain("Field variations (2):");
    expect(out()).toContain("Table A: workflow_traces");
    expect(out()).toContain("Table B: llm_call_traces");
    expect(out()).toContain("Table C: tenant_retention_opt_out_history");
    expect(out()).toContain("30 (A) | 90 (B, C)");
    expect(out()).toContain('"tenant" (A) | "platform" (B, C)');
  });

  it("JSON envelope includes both nway:true + crossTable:true discriminators", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff",
        TENANT_A,
        "workflow_traces",
        "llm_call_traces",
        "--cross-table",
        "--add-table",
        "tenant_retention_opt_out_history",
        "--format=json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    const parsedOut = JSON.parse(out());
    expect(parsedOut.action).toBe("diff");
    expect(parsedOut.nway).toBe(true);
    expect(parsedOut.crossTable).toBe(true);
    expect(parsedOut.result.tableNames).toEqual([
      "workflow_traces",
      "llm_call_traces",
      "tenant_retention_opt_out_history",
    ]);
    expect(parsedOut.result.resolutions).toHaveLength(3);
  });

  it("--exit-on-divergence + non-empty fieldVariations returns exit 3", async () => {
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff",
        TENANT_A,
        "workflow_traces",
        "llm_call_traces",
        "--cross-table",
        "--add-table",
        "tenant_retention_opt_out_history",
        "--exit-on-divergence",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTenantTablesNwayResult: {
            tenantId: TENANT_A,
            tableNames: [
              "workflow_traces",
              "llm_call_traces",
              "tenant_retention_opt_out_history",
            ],
            resolutions: [
              {
                tableName: "workflow_traces",
                resolution: {
                  source: "tenant",
                  retentionDays: 30,
                  enabled: true,
                  tenantId: TENANT_A,
                },
              },
              {
                tableName: "llm_call_traces",
                resolution: {
                  source: "platform",
                  retentionDays: 90,
                  enabled: true,
                },
              },
              {
                tableName: "tenant_retention_opt_out_history",
                resolution: {
                  source: "platform",
                  retentionDays: 90,
                  enabled: true,
                },
              },
            ],
            fieldVariations: [
              {
                field: "source",
                distinctValues: [
                  { value: "tenant", labels: ["workflow_traces"] },
                  {
                    value: "platform",
                    labels: ["llm_call_traces", "tenant_retention_opt_out_history"],
                  },
                ],
              },
            ],
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(3);
  });

  it("adapter errors propagate as exit 1", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff",
        TENANT_A,
        "workflow_traces",
        "llm_call_traces",
        "--cross-table",
        "--add-table",
        "tenant_retention_opt_out_history",
      ),
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

describe("formatTenantTablesNwayDiff", () => {
  it("renders 'No differences' message when fieldVariations empty", () => {
    const out = formatTenantTablesNwayDiff({
      tenantId: TENANT_A,
      tableNames: [
        "workflow_traces",
        "llm_call_traces",
        "tenant_retention_opt_out_history",
      ],
      resolutions: [
        {
          tableName: "workflow_traces",
          resolution: { source: "platform", retentionDays: 90, enabled: true },
        },
        {
          tableName: "llm_call_traces",
          resolution: { source: "platform", retentionDays: 90, enabled: true },
        },
        {
          tableName: "tenant_retention_opt_out_history",
          resolution: { source: "platform", retentionDays: 90, enabled: true },
        },
      ],
      fieldVariations: [],
    });
    expect(out).toContain("N-way diff across 3 tables for tenant");
    expect(out).toContain("No differences — all 3 tables");
  });

  it("renders A/B/C labels in table rows + variation lines", () => {
    const out = formatTenantTablesNwayDiff({
      tenantId: TENANT_A,
      tableNames: [
        "workflow_traces",
        "llm_call_traces",
        "llm_latency_samples",
      ],
      resolutions: [
        {
          tableName: "workflow_traces",
          resolution: {
            source: "tenant",
            retentionDays: 30,
            enabled: true,
            tenantId: TENANT_A,
          },
        },
        {
          tableName: "llm_call_traces",
          resolution: { source: "platform", retentionDays: 90, enabled: true },
        },
        {
          tableName: "llm_latency_samples",
          resolution: { source: "none", retentionDays: null, enabled: false },
        },
      ],
      fieldVariations: [
        {
          field: "source",
          distinctValues: [
            { value: "tenant", labels: ["workflow_traces"] },
            { value: "platform", labels: ["llm_call_traces"] },
            { value: "none", labels: ["llm_latency_samples"] },
          ],
        },
      ],
    });
    expect(out).toContain("Table A: workflow_traces");
    expect(out).toContain("Table B: llm_call_traces");
    expect(out).toContain("Table C: llm_latency_samples");
    expect(out).toContain('"tenant" (A) | "platform" (B) | "none" (C)');
  });

  it("renders 'absent' for undefined values in variation groups", () => {
    const out = formatTenantTablesNwayDiff({
      tenantId: TENANT_A,
      tableNames: ["workflow_traces", "llm_call_traces"],
      resolutions: [
        {
          tableName: "workflow_traces",
          resolution: { source: "platform", retentionDays: 90, enabled: true },
        },
        {
          tableName: "llm_call_traces",
          resolution: {
            source: "tenant_opt_out",
            retentionDays: null,
            enabled: false,
            tenantId: TENANT_A,
            optOutReason: "legal",
            optOutUntil: null,
          },
        },
      ],
      fieldVariations: [
        {
          field: "opt_out_reason",
          distinctValues: [
            { value: undefined, labels: ["workflow_traces"] },
            { value: "legal", labels: ["llm_call_traces"] },
          ],
        },
      ],
    });
    expect(out).toContain("absent (A)");
    expect(out).toContain('"legal" (B)');
  });
});

describe("formatTenantNwayDiff", () => {
  const TENANT_C2 = "00000000-0000-4000-8000-00000000000C";

  it("renders 'No differences' message when fieldVariations empty", () => {
    const out = formatTenantNwayDiff({
      tenantIds: [TENANT_A, TENANT_B, TENANT_C2],
      tableName: "workflow_traces",
      resolutions: [
        {
          tenantId: TENANT_A,
          resolution: { source: "platform", retentionDays: 90, enabled: true },
        },
        {
          tenantId: TENANT_B,
          resolution: { source: "platform", retentionDays: 90, enabled: true },
        },
        {
          tenantId: TENANT_C2,
          resolution: { source: "platform", retentionDays: 90, enabled: true },
        },
      ],
      fieldVariations: [],
    });
    expect(out).toContain("N-way diff between 3 tenants");
    expect(out).toContain("No differences — all 3 tenants");
  });

  it("renders A/B/C labels in tenant rows + variation lines", () => {
    const out = formatTenantNwayDiff({
      tenantIds: [TENANT_A, TENANT_B, TENANT_C2],
      tableName: "workflow_traces",
      resolutions: [
        {
          tenantId: TENANT_A,
          resolution: {
            source: "tenant",
            retentionDays: 30,
            enabled: true,
            tenantId: TENANT_A,
          },
        },
        {
          tenantId: TENANT_B,
          resolution: { source: "platform", retentionDays: 90, enabled: true },
        },
        {
          tenantId: TENANT_C2,
          resolution: { source: "none", retentionDays: null, enabled: false },
        },
      ],
      fieldVariations: [
        {
          field: "source",
          distinctValues: [
            { value: "tenant", labels: [TENANT_A] },
            { value: "platform", labels: [TENANT_B] },
            { value: "none", labels: [TENANT_C2] },
          ],
        },
      ],
    });
    expect(out).toContain("Tenant A:");
    expect(out).toContain("Tenant B:");
    expect(out).toContain("Tenant C:");
    expect(out).toContain('"tenant" (A) | "platform" (B) | "none" (C)');
  });

  it("renders 'absent' for undefined values in variation groups", () => {
    const out = formatTenantNwayDiff({
      tenantIds: [TENANT_A, TENANT_B],
      tableName: "workflow_traces",
      resolutions: [
        {
          tenantId: TENANT_A,
          resolution: { source: "platform", retentionDays: 90, enabled: true },
        },
        {
          tenantId: TENANT_B,
          resolution: {
            source: "tenant_opt_out",
            retentionDays: null,
            enabled: false,
            tenantId: TENANT_B,
            optOutReason: "legal",
            optOutUntil: null,
          },
        },
      ],
      fieldVariations: [
        {
          field: "opt_out_reason",
          distinctValues: [
            { value: undefined, labels: [TENANT_A] },
            { value: "legal", labels: [TENANT_B] },
          ],
        },
      ],
    });
    expect(out).toContain("absent (A)");
    expect(out).toContain('"legal" (B)');
  });
});

describe("runRetention diff --exit-on-divergence (M6.7.zz.tenant.opt-out.cli.diff.exit-on-divergence)", () => {
  it("cross-tenant: exit 0 when fieldDiffs empty and --exit-on-divergence set", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--exit-on-divergence",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTenantResult: {
            tenantIdA: TENANT_A,
            tenantIdB: TENANT_B,
            tableName: "workflow_traces",
            resolutionA: {
              source: "platform",
              retentionDays: 90,
              enabled: true,
            },
            resolutionB: {
              source: "platform",
              retentionDays: 90,
              enabled: true,
            },
            fieldDiffs: [],
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
    expect(out()).toContain("No differences");
  });

  it("cross-tenant: exit 3 when fieldDiffs non-empty and --exit-on-divergence set", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--exit-on-divergence",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTenantResult: {
            tenantIdA: TENANT_A,
            tenantIdB: TENANT_B,
            tableName: "workflow_traces",
            resolutionA: {
              source: "tenant",
              retentionDays: 30,
              enabled: true,
              tenantId: TENANT_A,
            },
            resolutionB: {
              source: "platform",
              retentionDays: 90,
              enabled: true,
            },
            fieldDiffs: [
              { field: "retention_days", valueA: 30, valueB: 90 },
            ],
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(3);
    expect(out()).toContain("Field changes (1):");
  });

  it("cross-tenant: exit 0 when fieldDiffs non-empty but flag NOT set (backward compat)", async () => {
    const { ctx } = buffers();
    const code = await runRetention(
      parsed("retention", "diff", TENANT_A, TENANT_B, "workflow_traces"),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTenantResult: {
            tenantIdA: TENANT_A,
            tenantIdB: TENANT_B,
            tableName: "workflow_traces",
            resolutionA: {
              source: "tenant",
              retentionDays: 30,
              enabled: true,
              tenantId: TENANT_A,
            },
            resolutionB: {
              source: "platform",
              retentionDays: 90,
              enabled: true,
            },
            fieldDiffs: [
              { field: "retention_days", valueA: 30, valueB: 90 },
            ],
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
  });

  it("cross-tenant: output still emitted on exit 3 (JSON mode)", async () => {
    const { ctx, out } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--exit-on-divergence",
        "--format=json",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTenantResult: {
            tenantIdA: TENANT_A,
            tenantIdB: TENANT_B,
            tableName: "workflow_traces",
            resolutionA: {
              source: "tenant",
              retentionDays: 30,
              enabled: true,
              tenantId: TENANT_A,
            },
            resolutionB: {
              source: "platform",
              retentionDays: 90,
              enabled: true,
            },
            fieldDiffs: [
              { field: "retention_days", valueA: 30, valueB: 90 },
            ],
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(3);
    const parsedOut = JSON.parse(out());
    expect(parsedOut.action).toBe("diff");
    expect(parsedOut.result.fieldDiffs).toHaveLength(1);
  });

  it("--vs-platform: exit 3 on non-empty fieldDiffs with flag", async () => {
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff",
        TENANT_A,
        "workflow_traces",
        "--vs-platform",
        "--exit-on-divergence",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTenantVsPlatformResult: {
            tenantId: TENANT_A,
            tableName: "workflow_traces",
            tenantResolution: {
              source: "tenant",
              retentionDays: 30,
              enabled: true,
              tenantId: TENANT_A,
            },
            platformResolution: {
              source: "platform",
              retentionDays: 90,
              enabled: true,
            },
            fieldDiffs: [
              { field: "retention_days", valueA: 30, valueB: 90 },
            ],
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(3);
  });

  it("--vs-platform: exit 0 on empty fieldDiffs with flag", async () => {
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff",
        TENANT_A,
        "workflow_traces",
        "--vs-platform",
        "--exit-on-divergence",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTenantVsPlatformResult: {
            tenantId: TENANT_A,
            tableName: "workflow_traces",
            tenantResolution: {
              source: "platform",
              retentionDays: 90,
              enabled: true,
            },
            platformResolution: {
              source: "platform",
              retentionDays: 90,
              enabled: true,
            },
            fieldDiffs: [],
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
  });

  it("--cross-table: exit 3 on non-empty fieldDiffs with flag", async () => {
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff",
        TENANT_A,
        "workflow_traces",
        "llm_call_traces",
        "--cross-table",
        "--exit-on-divergence",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTenantTablesResult: {
            tenantId: TENANT_A,
            tableNameA: "workflow_traces",
            tableNameB: "llm_call_traces",
            resolutionA: {
              source: "tenant",
              retentionDays: 30,
              enabled: true,
              tenantId: TENANT_A,
            },
            resolutionB: {
              source: "platform",
              retentionDays: 90,
              enabled: true,
            },
            fieldDiffs: [
              { field: "retention_days", valueA: 30, valueB: 90 },
            ],
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(3);
  });

  it("--cross-table: exit 0 on empty fieldDiffs with flag", async () => {
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff",
        TENANT_A,
        "workflow_traces",
        "llm_call_traces",
        "--cross-table",
        "--exit-on-divergence",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTenantTablesResult: {
            tenantId: TENANT_A,
            tableNameA: "workflow_traces",
            tableNameB: "llm_call_traces",
            resolutionA: {
              source: "platform",
              retentionDays: 90,
              enabled: true,
            },
            resolutionB: {
              source: "platform",
              retentionDays: 90,
              enabled: true,
            },
            fieldDiffs: [],
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
  });

  it("runtime errors (exit 1) take precedence over --exit-on-divergence", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--exit-on-divergence",
      ),
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

describe("runRetention diff --threshold (M6.7.zz.tenant.opt-out.cli.diff.threshold)", () => {
  const TENANT_C = "00000000-0000-4000-8000-00000000000C";

  function makeDiffResult(
    fieldDiffsLen: number,
  ): DiffTenantPoliciesResult {
    const fieldDiffs = Array.from({ length: fieldDiffsLen }, (_, i) => ({
      field: `field_${i}`,
      valueA: i,
      valueB: i + 100,
    }));
    return {
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
      resolutionA: {
        source: "tenant",
        retentionDays: 30,
        enabled: true,
        tenantId: TENANT_A,
      },
      resolutionB: {
        source: "platform",
        retentionDays: 90,
        enabled: true,
      },
      fieldDiffs,
    };
  }

  it("returns exit 2 when --threshold is set without --exit-on-divergence", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--threshold",
        "2",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("--threshold requires --exit-on-divergence");
  });

  it("returns exit 2 when --threshold value is 0", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--exit-on-divergence",
        "--threshold",
        "0",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("--threshold must be a positive integer");
  });

  it("returns exit 2 when --threshold value is negative", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--exit-on-divergence",
        "--threshold=-1",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("--threshold must be a positive integer");
  });

  it("returns exit 2 when --threshold value is non-integer (1.5)", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--exit-on-divergence",
        "--threshold",
        "1.5",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("--threshold must be a positive integer");
  });

  it("returns exit 2 when --threshold value is non-numeric", async () => {
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--exit-on-divergence",
        "--threshold",
        "abc",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({}),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("--threshold must be a positive integer");
  });

  it("--threshold 1 behaves like default --exit-on-divergence (exit 3 on any diff)", async () => {
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--exit-on-divergence",
        "--threshold",
        "1",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTenantResult: makeDiffResult(1),
        }),
      } as RetentionContext,
    );
    expect(code).toBe(3);
  });

  it("--threshold 2 + fieldDiffs=1 → exit 0 (below threshold)", async () => {
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--exit-on-divergence",
        "--threshold",
        "2",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTenantResult: makeDiffResult(1),
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
  });

  it("--threshold 2 + fieldDiffs=2 → exit 3 (at threshold)", async () => {
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--exit-on-divergence",
        "--threshold",
        "2",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTenantResult: makeDiffResult(2),
        }),
      } as RetentionContext,
    );
    expect(code).toBe(3);
  });

  it("--threshold 2 + fieldDiffs=3 → exit 3 (above threshold)", async () => {
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--exit-on-divergence",
        "--threshold",
        "2",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTenantResult: makeDiffResult(3),
        }),
      } as RetentionContext,
    );
    expect(code).toBe(3);
  });

  it("--threshold 5 + fieldDiffs=0 → exit 0 (no drift at all)", async () => {
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--exit-on-divergence",
        "--threshold",
        "5",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTenantResult: makeDiffResult(0),
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
  });

  it("--threshold integrates with --vs-platform variant", async () => {
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff",
        TENANT_A,
        "workflow_traces",
        "--vs-platform",
        "--exit-on-divergence",
        "--threshold",
        "3",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTenantVsPlatformResult: {
            tenantId: TENANT_A,
            tableName: "workflow_traces",
            tenantResolution: {
              source: "tenant",
              retentionDays: 30,
              enabled: true,
              tenantId: TENANT_A,
            },
            platformResolution: {
              source: "platform",
              retentionDays: 90,
              enabled: true,
            },
            fieldDiffs: [
              { field: "f1", valueA: 1, valueB: 2 },
              { field: "f2", valueA: 1, valueB: 2 },
            ],
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
  });

  it("--threshold integrates with --cross-table variant", async () => {
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff",
        TENANT_A,
        "workflow_traces",
        "llm_call_traces",
        "--cross-table",
        "--exit-on-divergence",
        "--threshold",
        "2",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTenantTablesResult: {
            tenantId: TENANT_A,
            tableNameA: "workflow_traces",
            tableNameB: "llm_call_traces",
            resolutionA: {
              source: "tenant",
              retentionDays: 30,
              enabled: true,
              tenantId: TENANT_A,
            },
            resolutionB: {
              source: "platform",
              retentionDays: 90,
              enabled: true,
            },
            fieldDiffs: [
              { field: "f1", valueA: 1, valueB: 2 },
              { field: "f2", valueA: 1, valueB: 2 },
            ],
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(3);
  });

  it("--threshold integrates with --add-tenant N-way variant", async () => {
    const { ctx } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--add-tenant",
        TENANT_C,
        "--exit-on-divergence",
        "--threshold",
        "3",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({
          diffTenantNwayResult: {
            tenantIds: [TENANT_A, TENANT_B, TENANT_C],
            tableName: "workflow_traces",
            resolutions: [
              {
                tenantId: TENANT_A,
                resolution: {
                  source: "tenant",
                  retentionDays: 30,
                  enabled: true,
                  tenantId: TENANT_A,
                },
              },
              {
                tenantId: TENANT_B,
                resolution: {
                  source: "platform",
                  retentionDays: 90,
                  enabled: true,
                },
              },
              {
                tenantId: TENANT_C,
                resolution: {
                  source: "platform",
                  retentionDays: 90,
                  enabled: true,
                },
              },
            ],
            fieldVariations: [
              {
                field: "source",
                distinctValues: [
                  { value: "tenant", labels: [TENANT_A] },
                  { value: "platform", labels: [TENANT_B, TENANT_C] },
                ],
              },
              {
                field: "retention_days",
                distinctValues: [
                  { value: 30, labels: [TENANT_A] },
                  { value: 90, labels: [TENANT_B, TENANT_C] },
                ],
              },
            ],
          },
        }),
      } as RetentionContext,
    );
    expect(code).toBe(0);
  });

  it("validation happens BEFORE PG adapter call (no PG queries on invalid --threshold)", async () => {
    const capture: DiffTenantPoliciesInput[] = [];
    const { ctx, err } = buffers();
    const code = await runRetention(
      parsed(
        "retention",
        "diff",
        TENANT_A,
        TENANT_B,
        "workflow_traces",
        "--exit-on-divergence",
        "--threshold",
        "0",
      ),
      {
        ...ctx,
        retentionOverride: fakeRetention({ diffTenantCapture: capture }),
      } as RetentionContext,
    );
    expect(code).toBe(2);
    expect(err()).toContain("positive integer");
    expect(capture).toHaveLength(0);
  });
});

describe("formatTenantTablesDiff", () => {
  it("renders 'No differences' message when fieldDiffs is empty", () => {
    const out = formatTenantTablesDiff({
      tenantId: TENANT_A,
      tableNameA: "workflow_traces",
      tableNameB: "llm_call_traces",
      resolutionA: { source: "platform", retentionDays: 90, enabled: true },
      resolutionB: { source: "platform", retentionDays: 90, enabled: true },
      fieldDiffs: [],
    });
    expect(out).toContain(`Diff between tables for tenant ${TENANT_A}`);
    expect(out).toContain(
      "No differences — both tables resolve to the same effective retention policy for this tenant.",
    );
  });

  it("renders Table A + Table B headers with per-table summary lines", () => {
    const out = formatTenantTablesDiff({
      tenantId: TENANT_A,
      tableNameA: "workflow_traces",
      tableNameB: "llm_call_traces",
      resolutionA: {
        source: "tenant",
        retentionDays: 30,
        enabled: true,
        tenantId: TENANT_A,
      },
      resolutionB: {
        source: "platform",
        retentionDays: 90,
        enabled: true,
      },
      fieldDiffs: [{ field: "retention_days", valueA: 30, valueB: 90 }],
    });
    expect(out).toContain("Table A: workflow_traces");
    expect(out).toContain("Table B: llm_call_traces");
    expect(out).toContain("source=tenant");
    expect(out).toContain("retention=30d");
    expect(out).toContain("retention=90d");
    expect(out).toContain("Field changes (1):");
  });

  it("renders tenant_opt_out variant inline with reason+until", () => {
    const out = formatTenantTablesDiff({
      tenantId: TENANT_A,
      tableNameA: "workflow_traces",
      tableNameB: "llm_call_traces",
      resolutionA: {
        source: "tenant_opt_out",
        retentionDays: null,
        enabled: false,
        tenantId: TENANT_A,
        optOutReason: "legal_hold",
        optOutUntil: "2099-01-01T00:00:00.000Z",
      },
      resolutionB: {
        source: "tenant",
        retentionDays: 30,
        enabled: true,
        tenantId: TENANT_A,
      },
      fieldDiffs: [{ field: "opt_out", valueA: true, valueB: false }],
    });
    expect(out).toContain("source=tenant_opt_out");
    expect(out).toContain("reason=legal_hold");
    expect(out).toContain("until=2099-01-01T00:00:00.000Z");
  });

  it("renders source=none with '(no policy configured)' annotation", () => {
    const out = formatTenantTablesDiff({
      tenantId: TENANT_A,
      tableNameA: "workflow_traces",
      tableNameB: "llm_call_traces",
      resolutionA: { source: "tenant", retentionDays: 30, enabled: true, tenantId: TENANT_A },
      resolutionB: { source: "none", retentionDays: null, enabled: false },
      fieldDiffs: [{ field: "source", valueA: "tenant", valueB: "none" }],
    });
    expect(out).toContain("source=none");
    expect(out).toContain("(no policy configured)");
  });
});

describe("formatTenantVsPlatformDiff", () => {
  const TENANT = "00000000-0000-4000-8000-00000000000C";

  it("renders 'No differences' message when fieldDiffs is empty", () => {
    const out = formatTenantVsPlatformDiff({
      tenantId: TENANT,
      tableName: "workflow_traces",
      tenantResolution: {
        source: "platform",
        retentionDays: 90,
        enabled: true,
      },
      platformResolution: {
        source: "platform",
        retentionDays: 90,
        enabled: true,
      },
      fieldDiffs: [],
    });
    expect(out).toContain("table: workflow_traces");
    expect(out).toContain(
      "No differences — tenant has the same effective retention policy as the platform default.",
    );
  });

  it("renders tenant row with tenantId + summary line", () => {
    const out = formatTenantVsPlatformDiff({
      tenantId: TENANT,
      tableName: "workflow_traces",
      tenantResolution: {
        source: "tenant",
        retentionDays: 30,
        enabled: true,
        tenantId: TENANT,
      },
      platformResolution: {
        source: "platform",
        retentionDays: 90,
        enabled: true,
      },
      fieldDiffs: [{ field: "retention_days", valueA: 30, valueB: 90 }],
    });
    expect(out).toContain(`Tenant:   ${TENANT}`);
    expect(out).toContain("source=tenant");
    expect(out).toContain("retention=30d");
    expect(out).toContain("Platform:");
    expect(out).toContain("source=platform");
    expect(out).toContain("retention=90d");
    expect(out).toContain("Field changes (1):");
  });

  it("renders tenant_opt_out with reason + until inline", () => {
    const out = formatTenantVsPlatformDiff({
      tenantId: TENANT,
      tableName: "workflow_traces",
      tenantResolution: {
        source: "tenant_opt_out",
        retentionDays: null,
        enabled: false,
        tenantId: TENANT,
        optOutReason: "legal_hold:case#42",
        optOutUntil: "2099-01-01T00:00:00.000Z",
      },
      platformResolution: {
        source: "platform",
        retentionDays: 90,
        enabled: true,
      },
      fieldDiffs: [{ field: "opt_out", valueA: true, valueB: false }],
    });
    expect(out).toContain("source=tenant_opt_out");
    expect(out).toContain("reason=legal_hold:case#42");
    expect(out).toContain("until=2099-01-01T00:00:00.000Z");
  });

  it("renders platform=none variant when no platform default configured", () => {
    const out = formatTenantVsPlatformDiff({
      tenantId: TENANT,
      tableName: "workflow_traces",
      tenantResolution: {
        source: "tenant",
        retentionDays: 30,
        enabled: true,
        tenantId: TENANT,
      },
      platformResolution: {
        source: "none",
        retentionDays: null,
        enabled: false,
      },
      fieldDiffs: [{ field: "source", valueA: "tenant", valueB: "none" }],
    });
    expect(out).toContain("Platform:");
    expect(out).toContain("source=none");
    expect(out).toContain("(no policy configured)");
  });
});

describe("formatTenantDiff", () => {
  it("renders 'No differences' message when fieldDiffs is empty", () => {
    const out = formatTenantDiff({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
      resolutionA: { source: "platform", retentionDays: 90, enabled: true },
      resolutionB: { source: "platform", retentionDays: 90, enabled: true },
      fieldDiffs: [],
    });
    expect(out).toContain("No differences");
  });

  it("renders 'Field changes (N):' header with count when diffs present", () => {
    const out = formatTenantDiff({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
      resolutionA: {
        source: "tenant",
        retentionDays: 30,
        enabled: true,
        tenantId: TENANT_A,
      },
      resolutionB: {
        source: "platform",
        retentionDays: 90,
        enabled: true,
      },
      fieldDiffs: [
        { field: "retention_days", valueA: 30, valueB: 90 },
        { field: "source", valueA: "tenant", valueB: "platform" },
      ],
    });
    expect(out).toContain("Field changes (2):");
  });

  it("summarizes tenant variant inline as 'source=tenant retention=Nd enabled=yes'", () => {
    const out = formatTenantDiff({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
      resolutionA: {
        source: "tenant",
        retentionDays: 30,
        enabled: true,
        tenantId: TENANT_A,
      },
      resolutionB: {
        source: "none",
        retentionDays: null,
        enabled: false,
      },
      fieldDiffs: [],
    });
    expect(out).toContain("source=tenant");
    expect(out).toContain("retention=30d");
    expect(out).toContain("enabled=yes");
  });

  it("summarizes tenant_opt_out variant inline with reason + until", () => {
    const out = formatTenantDiff({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
      resolutionA: {
        source: "tenant_opt_out",
        retentionDays: null,
        enabled: false,
        tenantId: TENANT_A,
        optOutReason: "legal_hold:case#42",
        optOutUntil: "2027-01-01T00:00:00.000Z",
      },
      resolutionB: {
        source: "none",
        retentionDays: null,
        enabled: false,
      },
      fieldDiffs: [],
    });
    expect(out).toContain("source=tenant_opt_out");
    expect(out).toContain("reason=legal_hold:case#42");
    expect(out).toContain("until=2027-01-01T00:00:00.000Z");
  });

  it("renders 'indefinite' for null optOutUntil + '<no reason>' for null reason", () => {
    const out = formatTenantDiff({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
      resolutionA: {
        source: "tenant_opt_out",
        retentionDays: null,
        enabled: false,
        tenantId: TENANT_A,
        optOutReason: null,
        optOutUntil: null,
      },
      resolutionB: {
        source: "none",
        retentionDays: null,
        enabled: false,
      },
      fieldDiffs: [],
    });
    expect(out).toContain("reason=<no reason>");
    expect(out).toContain("until=indefinite");
  });

  it("summarizes platform variant inline as 'source=platform retention=Nd enabled=yes|no'", () => {
    const out = formatTenantDiff({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
      resolutionA: {
        source: "platform",
        retentionDays: 90,
        enabled: false,
      },
      resolutionB: {
        source: "platform",
        retentionDays: 90,
        enabled: true,
      },
      fieldDiffs: [{ field: "enabled", valueA: false, valueB: true }],
    });
    expect(out).toContain("source=platform");
    expect(out).toContain("enabled=no");
    expect(out).toContain("enabled=yes");
  });

  it("summarizes none variant inline as 'source=none (no policy configured)'", () => {
    const out = formatTenantDiff({
      tenantIdA: TENANT_A,
      tenantIdB: TENANT_B,
      tableName: "workflow_traces",
      resolutionA: { source: "none", retentionDays: null, enabled: false },
      resolutionB: { source: "none", retentionDays: null, enabled: false },
      fieldDiffs: [],
    });
    expect(out).toContain("source=none");
    expect(out).toContain("(no policy configured)");
  });
});

describe("retention --attributes flag (M6.7.zz.tenant.opt-out.cli.history.attributes)", () => {
  describe("opt-out", () => {
    it("threads attributes to setTenantOptOut adapter when --attributes is set", async () => {
      const capture: SetTenantOptOutInput[] = [];
      const { ctx } = buffers();
      const code = await runRetention(
        parsed(
          "retention",
          "opt-out",
          TENANT_A,
          "workflow_traces",
          "--attributes",
          '{"ticket":"INC-2026-001","source":"cli"}',
        ),
        {
          ...ctx,
          retentionOverride: fakeRetention({ setOptOutCapture: capture }),
        } as RetentionContext,
      );
      expect(code).toBe(0);
      expect(capture[0]?.attributes).toEqual({
        ticket: "INC-2026-001",
        source: "cli",
      });
    });

    it("omits attributes from adapter input when --attributes is NOT set (backward compat)", async () => {
      const capture: SetTenantOptOutInput[] = [];
      const { ctx } = buffers();
      const code = await runRetention(
        parsed("retention", "opt-out", TENANT_A, "workflow_traces"),
        {
          ...ctx,
          retentionOverride: fakeRetention({ setOptOutCapture: capture }),
        } as RetentionContext,
      );
      expect(code).toBe(0);
      expect(capture[0]?.attributes).toBeUndefined();
    });

    it("returns exit 2 when --attributes is invalid JSON", async () => {
      const { ctx, err } = buffers();
      const code = await runRetention(
        parsed(
          "retention",
          "opt-out",
          TENANT_A,
          "workflow_traces",
          "--attributes",
          "{not json",
        ),
        {
          ...ctx,
          retentionOverride: fakeRetention({}),
        } as RetentionContext,
      );
      expect(code).toBe(2);
      expect(err()).toContain("not valid JSON");
    });

    it("returns exit 2 when --attributes is a JSON array (not object)", async () => {
      const { ctx, err } = buffers();
      const code = await runRetention(
        parsed(
          "retention",
          "opt-out",
          TENANT_A,
          "workflow_traces",
          "--attributes",
          '["a","b"]',
        ),
        {
          ...ctx,
          retentionOverride: fakeRetention({}),
        } as RetentionContext,
      );
      expect(code).toBe(2);
      expect(err()).toContain("must be a JSON object");
    });

    it("returns exit 2 when --attributes is a JSON primitive", async () => {
      const { ctx, err } = buffers();
      const code = await runRetention(
        parsed(
          "retention",
          "opt-out",
          TENANT_A,
          "workflow_traces",
          "--attributes",
          '"a string"',
        ),
        {
          ...ctx,
          retentionOverride: fakeRetention({}),
        } as RetentionContext,
      );
      expect(code).toBe(2);
      expect(err()).toContain("must be a JSON object");
    });

    it("returns exit 2 when --attributes is null", async () => {
      const { ctx, err } = buffers();
      const code = await runRetention(
        parsed(
          "retention",
          "opt-out",
          TENANT_A,
          "workflow_traces",
          "--attributes",
          "null",
        ),
        {
          ...ctx,
          retentionOverride: fakeRetention({}),
        } as RetentionContext,
      );
      expect(code).toBe(2);
      expect(err()).toContain("must be a JSON object");
    });

    it("validates --attributes BEFORE PG adapter call", async () => {
      const capture: SetTenantOptOutInput[] = [];
      const { ctx } = buffers();
      const code = await runRetention(
        parsed(
          "retention",
          "opt-out",
          TENANT_A,
          "workflow_traces",
          "--attributes",
          "{not json",
        ),
        {
          ...ctx,
          retentionOverride: fakeRetention({ setOptOutCapture: capture }),
        } as RetentionContext,
      );
      expect(code).toBe(2);
      expect(capture).toHaveLength(0);
    });

    it("accepts empty object {} as --attributes value", async () => {
      const capture: SetTenantOptOutInput[] = [];
      const { ctx } = buffers();
      const code = await runRetention(
        parsed(
          "retention",
          "opt-out",
          TENANT_A,
          "workflow_traces",
          "--attributes",
          "{}",
        ),
        {
          ...ctx,
          retentionOverride: fakeRetention({ setOptOutCapture: capture }),
        } as RetentionContext,
      );
      expect(code).toBe(0);
      expect(capture[0]?.attributes).toEqual({});
    });

    it("accepts nested JSON object as --attributes value", async () => {
      const capture: SetTenantOptOutInput[] = [];
      const { ctx } = buffers();
      const code = await runRetention(
        parsed(
          "retention",
          "opt-out",
          TENANT_A,
          "workflow_traces",
          "--attributes",
          '{"approval":{"reviewer":"alice","ticket":"INC-001"},"automated":false}',
        ),
        {
          ...ctx,
          retentionOverride: fakeRetention({ setOptOutCapture: capture }),
        } as RetentionContext,
      );
      expect(code).toBe(0);
      expect(capture[0]?.attributes).toEqual({
        approval: { reviewer: "alice", ticket: "INC-001" },
        automated: false,
      });
    });
  });

  describe("opt-in", () => {
    it("threads attributes to clearTenantOptOut adapter when --attributes is set", async () => {
      const capture: ClearTenantOptOutInput[] = [];
      const { ctx } = buffers();
      const code = await runRetention(
        parsed(
          "retention",
          "opt-in",
          TENANT_A,
          "workflow_traces",
          "--attributes",
          '{"reason":"hold-lifted","ticket":"INC-002"}',
        ),
        {
          ...ctx,
          retentionOverride: fakeRetention({ clearOptOutCapture: capture }),
        } as RetentionContext,
      );
      expect(code).toBe(0);
      expect(capture[0]?.attributes).toEqual({
        reason: "hold-lifted",
        ticket: "INC-002",
      });
    });

    it("returns exit 2 when --attributes is invalid JSON for opt-in", async () => {
      const { ctx, err } = buffers();
      const code = await runRetention(
        parsed(
          "retention",
          "opt-in",
          TENANT_A,
          "workflow_traces",
          "--attributes",
          "not-json",
        ),
        {
          ...ctx,
          retentionOverride: fakeRetention({}),
        } as RetentionContext,
      );
      expect(code).toBe(2);
      expect(err()).toContain("retention opt-in:");
      expect(err()).toContain("not valid JSON");
    });
  });

  describe("set", () => {
    it("threads attributes to setTenantRetention adapter when --attributes is set", async () => {
      const capture: SetTenantRetentionInput[] = [];
      const { ctx } = buffers();
      const code = await runRetention(
        parsed(
          "retention",
          "set",
          TENANT_A,
          "workflow_traces",
          "--days",
          "30",
          "--attributes",
          '{"tier_change":"free->pro"}',
        ),
        {
          ...ctx,
          retentionOverride: fakeRetention({ setRetentionCapture: capture }),
        } as RetentionContext,
      );
      expect(code).toBe(0);
      expect(capture[0]?.attributes).toEqual({ tier_change: "free->pro" });
    });

    it("returns exit 2 when --attributes is non-object for set", async () => {
      const { ctx, err } = buffers();
      const code = await runRetention(
        parsed(
          "retention",
          "set",
          TENANT_A,
          "workflow_traces",
          "--days",
          "30",
          "--attributes",
          "42",
        ),
        {
          ...ctx,
          retentionOverride: fakeRetention({}),
        } as RetentionContext,
      );
      expect(code).toBe(2);
      expect(err()).toContain("retention set:");
      expect(err()).toContain("must be a JSON object");
    });
  });

  describe("delete", () => {
    it("threads attributes to deleteTenantPolicy adapter when --attributes is set", async () => {
      const capture: DeleteTenantPolicyInput[] = [];
      const { ctx } = buffers();
      const code = await runRetention(
        parsed(
          "retention",
          "delete",
          TENANT_A,
          "workflow_traces",
          "--attributes",
          '{"context":"offboarding","ticket":"OFF-2026-005"}',
        ),
        {
          ...ctx,
          retentionOverride: fakeRetention({ deleteCapture: capture }),
        } as RetentionContext,
      );
      expect(code).toBe(0);
      expect(capture[0]?.attributes).toEqual({
        context: "offboarding",
        ticket: "OFF-2026-005",
      });
    });

    it("returns exit 2 when --attributes is invalid JSON for delete", async () => {
      const { ctx, err } = buffers();
      const code = await runRetention(
        parsed(
          "retention",
          "delete",
          TENANT_A,
          "workflow_traces",
          "--attributes",
          "{trailing comma,}",
        ),
        {
          ...ctx,
          retentionOverride: fakeRetention({}),
        } as RetentionContext,
      );
      expect(code).toBe(2);
      expect(err()).toContain("retention delete:");
    });
  });

  describe("restore", () => {
    const HISTORY_ID = "00000000-0000-7000-8000-000000000001";

    it("threads attributes to restoreTenantPolicy adapter when --attributes is set", async () => {
      const capture: RestoreTenantPolicyInput[] = [];
      const { ctx } = buffers();
      const code = await runRetention(
        parsed(
          "retention",
          "restore",
          HISTORY_ID,
          "--attributes",
          '{"undo_reason":"accidental","ticket":"INC-003"}',
        ),
        {
          ...ctx,
          retentionOverride: fakeRetention({ restoreCapture: capture }),
        } as RetentionContext,
      );
      expect(code).toBe(0);
      expect(capture[0]?.attributes).toEqual({
        undo_reason: "accidental",
        ticket: "INC-003",
      });
    });

    it("returns exit 2 when --attributes is invalid JSON for restore", async () => {
      const { ctx, err } = buffers();
      const code = await runRetention(
        parsed(
          "retention",
          "restore",
          HISTORY_ID,
          "--attributes",
          '"a string"',
        ),
        {
          ...ctx,
          retentionOverride: fakeRetention({}),
        } as RetentionContext,
      );
      expect(code).toBe(2);
      expect(err()).toContain("retention restore:");
      expect(err()).toContain("must be a JSON object");
    });
  });
});
