import { z } from "zod";

const MIGRATION_ID_REGEX = /^\d{4}_[a-z][a-z0-9_]*$/;
const SHA256_REGEX = /^[0-9a-f]{64}$/;
const Iso8601 = z.string().datetime({ offset: true });

export const MIGRATION_STATUSES = [
  "pending",
  "applied",
  "failed",
  "rolled_forward",
] as const;
export type MigrationStatus = (typeof MIGRATION_STATUSES)[number];

export const MIGRATION_KINDS = [
  "schema_add_column",
  "schema_add_table",
  "schema_add_index",
  "schema_rename",
  "data_backfill",
  "constraint_add",
  "constraint_drop",
  "extension_create",
  "rls_policy",
  "trigger_or_function",
  "compensating",
] as const;
export type MigrationKind = (typeof MIGRATION_KINDS)[number];

const DESTRUCTIVE_KINDS: ReadonlySet<MigrationKind> = new Set([
  "schema_rename",
  "constraint_drop",
]);

export const MigrationDeclarationSchema = z
  .object({
    id: z.string().regex(MIGRATION_ID_REGEX, {
      message: "migration id must be 'NNNN_snake_case' (e.g., '0042_add_residency_column')",
    }),
    kind: z.enum(MIGRATION_KINDS),
    description: z.string().min(1),
    sqlPath: z.string().min(1),
    sqlSha256: z.string().regex(SHA256_REGEX),
    forwardCompatibleWith: z.array(z.string().min(1)).min(1),
    forwardOnly: z.literal(true).default(true),
    isDestructive: z.boolean().default(false),
    appliesBeforeAppVersion: z.string().min(1).optional(),
    requiresMaintenanceWindow: z.boolean().default(false),
    estimatedDurationSeconds: z.number().int().min(0).optional(),
    locksTables: z.array(z.string().min(1)).default([]),
  })
  .superRefine((v, ctx) => {
    if (DESTRUCTIVE_KINDS.has(v.kind) && !v.isDestructive) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["isDestructive"],
        message: `kind '${v.kind}' is destructive; isDestructive must be true`,
      });
    }
    if (v.isDestructive && v.forwardCompatibleWith.length < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["forwardCompatibleWith"],
        message:
          "destructive migrations must declare forwardCompatibleWith for both prior + new app versions (≥ 2 entries)",
      });
    }
    if (v.locksTables.length > 0 && !v.requiresMaintenanceWindow && v.estimatedDurationSeconds !== undefined && v.estimatedDurationSeconds > 5) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requiresMaintenanceWindow"],
        message: `migration locks tables for ${v.estimatedDurationSeconds}s; set requiresMaintenanceWindow=true for locks > 5s`,
      });
    }
  });
export type MigrationDeclaration = z.infer<typeof MigrationDeclarationSchema>;

export const MigrationSequenceSchema = z
  .array(MigrationDeclarationSchema)
  .superRefine((entries, ctx) => {
    const ids = new Set<string>();
    let prevSequence = -1;
    entries.forEach((m, i) => {
      if (ids.has(m.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, "id"],
          message: `duplicate migration id '${m.id}'`,
        });
      }
      ids.add(m.id);
      const seqMatch = m.id.match(/^(\d{4})_/);
      if (seqMatch !== null && seqMatch[1] !== undefined) {
        const seq = Number.parseInt(seqMatch[1], 10);
        if (seq <= prevSequence) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [i, "id"],
            message: `migration sequence '${m.id}' is not strictly greater than prior '${prevSequence.toString().padStart(4, "0")}'`,
          });
        }
        prevSequence = seq;
      }
    });
  });
export type MigrationSequence = z.infer<typeof MigrationSequenceSchema>;

export const MigrationApplicationRecordSchema = z
  .object({
    migrationId: z.string().regex(MIGRATION_ID_REGEX),
    appliedAt: Iso8601,
    appliedBy: z.string().min(1),
    durationMs: z.number().int().nonnegative(),
    status: z.enum(MIGRATION_STATUSES),
    appVersionAtApply: z.string().min(1),
    environment: z.string().min(1),
    sqlSha256: z.string().regex(SHA256_REGEX),
    errorMessage: z.string().min(1).optional(),
    compensatingMigrationId: z.string().regex(MIGRATION_ID_REGEX).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.status === "failed" && v.errorMessage === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["errorMessage"],
        message: "failed migrations must declare errorMessage",
      });
    }
    if (v.status === "rolled_forward" && v.compensatingMigrationId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["compensatingMigrationId"],
        message: "rolled_forward migrations must reference the compensating migration that corrected them",
      });
    }
  });
export type MigrationApplicationRecord = z.infer<typeof MigrationApplicationRecordSchema>;

export function nextSequenceNumber(sequence: MigrationSequence): number {
  let max = 0;
  for (const migration of sequence) {
    const match = migration.id.match(/^(\d{4})_/);
    if (match !== null && match[1] !== undefined) {
      const seq = Number.parseInt(match[1], 10);
      if (seq > max) max = seq;
    }
  }
  return max + 1;
}

export function isDestructive(migration: MigrationDeclaration): boolean {
  return migration.isDestructive || DESTRUCTIVE_KINDS.has(migration.kind);
}

export function pendingMigrations(
  sequence: MigrationSequence,
  applied: readonly string[],
): readonly MigrationDeclaration[] {
  const appliedSet = new Set(applied);
  return sequence.filter((m) => !appliedSet.has(m.id));
}
