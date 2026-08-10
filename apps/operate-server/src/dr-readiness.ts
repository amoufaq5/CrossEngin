import { readFile } from "node:fs/promises";

import { z } from "zod";
import {
  BackupRecordSchema,
  DR_TIERS,
  ReplicationLagRecordSchema,
  RunbookSpecSchema,
} from "@crossengin/dr";
import {
  DrReadinessScheduler,
  type DrReadinessInput,
  type DrReadinessReport,
  type IntervalScheduler,
} from "@crossengin/dr-runtime";
import { buildPersistentDrRuntime } from "@crossengin/dr-runtime-pg";
import type { PgConnection } from "@crossengin/kernel-pg";

const ReplicationLagInputSchema = z
  .object({
    record: ReplicationLagRecordSchema,
    tier: z.enum(DR_TIERS),
  })
  .strict();

export const DrReadinessInputConfigSchema = z
  .object({
    runbooks: z.array(RunbookSpecSchema).default([]),
    backups: z.array(BackupRecordSchema).default([]),
    replication: z.array(ReplicationLagInputSchema).default([]),
    maxRunbookDaysSinceReview: z.number().int().positive().optional(),
    maxRunbookDaysSinceTest: z.number().int().positive().optional(),
  })
  .strict();

export const DrReadinessConfigSchema = z
  .object({
    tenantId: z.string().uuid().nullable().default(null),
    intervalMs: z.number().int().positive().default(3_600_000),
    input: DrReadinessInputConfigSchema,
  })
  .strict();
export type DrReadinessConfig = z.infer<typeof DrReadinessConfigSchema>;

export function parseDrReadinessConfig(json: unknown): DrReadinessConfig {
  return DrReadinessConfigSchema.parse(json);
}

export async function loadDrReadinessConfig(path: string): Promise<DrReadinessConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new Error(`--dr-readiness-config: cannot read ${path}: ${errMessage(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`--dr-readiness-config: invalid JSON in ${path}: ${errMessage(err)}`);
  }
  return parseDrReadinessConfig(parsed);
}

export interface DrReadinessLifecycleOptions {
  readonly scheduler?: IntervalScheduler;
  readonly onReport?: (report: DrReadinessReport) => void;
  readonly onError?: (err: unknown) => void;
  readonly failoverLimit?: number;
  readonly drillLimit?: number;
}

export interface DrReadinessLifecycle {
  readonly scheduler: DrReadinessScheduler;
  assessOnce(): Promise<DrReadinessReport>;
}

/**
 * Wires a persistent DR runtime + a readiness scheduler over a live connection:
 * each tick folds the failover + drill executions recorded through the API (read
 * back from Postgres) into the config's declared infra (runbooks / backups /
 * replication), assesses readiness, and persists the snapshot.
 */
export function buildDrReadinessLifecycle(
  conn: PgConnection,
  config: DrReadinessConfig,
  opts: DrReadinessLifecycleOptions = {},
): DrReadinessLifecycle {
  const persistent = buildPersistentDrRuntime(conn, { tenantId: config.tenantId });
  const failoverLimit = opts.failoverLimit ?? 500;
  const drillLimit = opts.drillLimit ?? 500;

  async function assessOnce(): Promise<DrReadinessReport> {
    const [failoverRows, drillRows] = await Promise.all([
      persistent.failoverStore.listRecent(failoverLimit),
      persistent.drillStore.listRecent(drillLimit),
    ]);
    const input: DrReadinessInput = {
      ...config.input,
      failovers: failoverRows.map((row) => row.record),
      drills: drillRows.map((row) => row.record),
    };
    return persistent.assess(input, { tenantId: config.tenantId });
  }

  const scheduler = new DrReadinessScheduler({
    assess: assessOnce,
    intervalMs: config.intervalMs,
    ...(opts.scheduler !== undefined ? { scheduler: opts.scheduler } : {}),
    ...(opts.onReport !== undefined ? { onReport: opts.onReport } : {}),
    ...(opts.onError !== undefined ? { onError: opts.onError } : {}),
  });

  return { scheduler, assessOnce };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
