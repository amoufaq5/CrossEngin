import { z } from "zod";
import { RegionSchema } from "@crossengin/residency";

const Iso8601 = z.string().datetime({ offset: true });
const LsnRegex = /^[0-9A-F]+\/[0-9A-F]+$/;

export const PostgresLsnSchema = z.string().regex(LsnRegex, {
  message: "Postgres LSN must look like 'XXXX/XXXX' (hex)",
});

export const CDC_PIPELINE_STATUSES = [
  "running",
  "paused",
  "lagging",
  "broken",
  "snapshot",
] as const;
export type CdcPipelineStatus = (typeof CDC_PIPELINE_STATUSES)[number];

export const CdcCheckpointSchema = z
  .object({
    region: RegionSchema,
    replicationSlot: z.string().regex(/^[a-z][a-z0-9_]*$/),
    status: z.enum(CDC_PIPELINE_STATUSES),
    lastCommittedLsn: PostgresLsnSchema,
    lastShippedLsn: PostgresLsnSchema,
    lagBytes: z.number().int().nonnegative(),
    lagSeconds: z.number().nonnegative(),
    updatedAt: Iso8601,
    lastErrorMessage: z.string().min(1).nullable().default(null),
  })
  .superRefine((v, ctx) => {
    if (compareLsn(v.lastShippedLsn, v.lastCommittedLsn) > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lastShippedLsn"],
        message: "lastShippedLsn cannot be ahead of lastCommittedLsn",
      });
    }
  });
export type CdcCheckpoint = z.infer<typeof CdcCheckpointSchema>;

export function compareLsn(a: string, b: string): number {
  const [aHi, aLo] = a.split("/");
  const [bHi, bLo] = b.split("/");
  if (aHi === undefined || aLo === undefined || bHi === undefined || bLo === undefined) {
    throw new Error(`invalid LSN comparison: '${a}' vs '${b}'`);
  }
  const aHiN = Number.parseInt(aHi, 16);
  const bHiN = Number.parseInt(bHi, 16);
  if (aHiN !== bHiN) return aHiN < bHiN ? -1 : 1;
  const aLoN = Number.parseInt(aLo, 16);
  const bLoN = Number.parseInt(bLo, 16);
  if (aLoN === bLoN) return 0;
  return aLoN < bLoN ? -1 : 1;
}

export const CDC_LAG_SEVERITIES = ["ok", "warn", "critical"] as const;
export type CdcLagSeverity = (typeof CDC_LAG_SEVERITIES)[number];

export interface CdcLagThresholds {
  readonly warnSeconds: number;
  readonly criticalSeconds: number;
}

export const DEFAULT_CDC_LAG_THRESHOLDS: CdcLagThresholds = Object.freeze({
  warnSeconds: 60,
  criticalSeconds: 300,
});

export function lagSeverity(
  checkpoint: CdcCheckpoint,
  thresholds: CdcLagThresholds = DEFAULT_CDC_LAG_THRESHOLDS,
): CdcLagSeverity {
  if (checkpoint.lagSeconds >= thresholds.criticalSeconds) return "critical";
  if (checkpoint.lagSeconds >= thresholds.warnSeconds) return "warn";
  return "ok";
}
