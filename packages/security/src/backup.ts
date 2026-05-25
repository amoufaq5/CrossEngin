import { z } from "zod";

const DURATION_REGEX = /^(\d+)(s|m|h|d|w|y)$/;

export const BackupDurationSchema = z.string().regex(DURATION_REGEX, {
  message: "duration must be '<n><s|m|h|d|w|y>' (e.g., '60s', '7d', '7y')",
});
export type BackupDuration = z.infer<typeof BackupDurationSchema>;

export const BACKUP_KINDS = [
  "supabase-pitr",
  "pg-dump",
  "r2-cold",
  "logical-replica",
  "physical-replica",
] as const;
export type BackupKind = (typeof BACKUP_KINDS)[number];

export const BackupTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("supabase-pitr"),
    windowDays: z.number().int().min(1).max(35),
  }),
  z.object({
    kind: z.literal("pg-dump"),
    cadence: z.enum(["hourly", "daily", "weekly"]),
    destination: z.literal("r2"),
    pathTemplate: z.string().min(1),
  }),
  z.object({
    kind: z.literal("r2-cold"),
    hotRetention: BackupDurationSchema,
    coldRetention: BackupDurationSchema,
    encryption: z.enum(["aes-256-gcm", "aes-256-gcm-byok"]).default("aes-256-gcm"),
  }),
  z.object({
    kind: z.literal("logical-replica"),
    region: z.string().min(1),
    lagBudget: BackupDurationSchema,
  }),
  z.object({
    kind: z.literal("physical-replica"),
    region: z.string().min(1),
    syncMode: z.enum(["async", "sync", "quorum"]),
  }),
]);
export type BackupTarget = z.infer<typeof BackupTargetSchema>;

export const BackupPolicySchema = z
  .object({
    surface: z.string().min(1),
    rpo: BackupDurationSchema,
    rto: BackupDurationSchema,
    targets: z.array(BackupTargetSchema).min(1),
    drDrillCadence: z.enum(["monthly", "quarterly", "yearly"]).default("quarterly"),
  })
  .superRefine((v, ctx) => {
    const kinds = new Set<BackupKind>();
    v.targets.forEach((t, i) => {
      if (kinds.has(t.kind)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["targets", i, "kind"],
          message: `duplicate backup target kind '${t.kind}'`,
        });
      }
      kinds.add(t.kind);
    });
  });
export type BackupPolicy = z.infer<typeof BackupPolicySchema>;

export function durationToSeconds(duration: BackupDuration): number {
  const match = duration.match(DURATION_REGEX);
  if (!match) throw new Error(`invalid duration: ${duration}`);
  const n = Number(match[1]);
  switch (match[2]) {
    case "s":
      return n;
    case "m":
      return n * 60;
    case "h":
      return n * 3_600;
    case "d":
      return n * 86_400;
    case "w":
      return n * 604_800;
    case "y":
      return n * 31_536_000;
    default:
      throw new Error(`unreachable: ${match[2]}`);
  }
}

export function checkPolicyConsistency(policy: BackupPolicy): readonly string[] {
  const issues: string[] = [];
  const rpoSec = durationToSeconds(policy.rpo);
  const rtoSec = durationToSeconds(policy.rto);
  if (rtoSec < rpoSec) {
    issues.push(`RTO (${policy.rto}) is shorter than RPO (${policy.rpo}); unusual but allowed`);
  }
  for (const target of policy.targets) {
    if (target.kind === "supabase-pitr" && target.windowDays * 86_400 < rpoSec) {
      issues.push(
        `supabase-pitr window (${target.windowDays}d) shorter than required RPO (${policy.rpo})`,
      );
    }
    if (target.kind === "logical-replica") {
      const lagSec = durationToSeconds(target.lagBudget);
      if (lagSec > rpoSec) {
        issues.push(`logical-replica lagBudget (${target.lagBudget}) exceeds RPO (${policy.rpo})`);
      }
    }
  }
  return issues;
}
