import { z } from "zod";

const COLUMN_NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENTITY_NAME_REGEX = /^[a-z][a-z0-9_]*$/;

export const INFERRED_TYPES = [
  "string",
  "integer",
  "decimal",
  "boolean",
  "date",
  "datetime",
  "uuid",
  "email",
  "url",
  "phone",
  "json",
  "binary",
  "unknown",
] as const;
export type InferredType = (typeof INFERRED_TYPES)[number];
export const InferredTypeSchema = z.enum(INFERRED_TYPES);

export const SEMANTIC_HINTS = [
  "primary_key_candidate",
  "foreign_key_candidate",
  "tenant_discriminator",
  "pii_email",
  "pii_phone",
  "pii_name",
  "phi",
  "monetary",
  "geo_lat_long",
  "timestamp",
  "soft_delete_flag",
  "external_id",
] as const;
export type SemanticHint = (typeof SEMANTIC_HINTS)[number];
export const SemanticHintSchema = z.enum(SEMANTIC_HINTS);

export const InferredColumnSchema = z
  .object({
    name: z.string().regex(COLUMN_NAME_REGEX, {
      message: "column name must be an identifier (letter/_ then letters/digits/_)",
    }),
    sourceName: z.string().min(1),
    type: InferredTypeSchema,
    nullable: z.boolean(),
    nonNullSamples: z.number().int().nonnegative(),
    nullSamples: z.number().int().nonnegative(),
    distinctSamples: z.number().int().nonnegative(),
    minLength: z.number().int().nonnegative().optional(),
    maxLength: z.number().int().nonnegative().optional(),
    minValue: z.union([z.number(), z.string()]).optional(),
    maxValue: z.union([z.number(), z.string()]).optional(),
    confidence: z.number().min(0).max(1),
    semanticHints: z.array(SemanticHintSchema).default([]),
    examples: z
      .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .max(5)
      .default([]),
  })
  .superRefine((v, ctx) => {
    if (v.minLength !== undefined && v.maxLength !== undefined && v.minLength > v.maxLength) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["minLength"],
        message: "minLength cannot exceed maxLength",
      });
    }
    if (v.distinctSamples > v.nonNullSamples + v.nullSamples) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["distinctSamples"],
        message: "distinctSamples cannot exceed total samples (nonNull + null)",
      });
    }
    if (v.type === "unknown" && v.confidence > 0.5) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["confidence"],
        message: "type='unknown' must have confidence <= 0.5",
      });
    }
    if (v.semanticHints.includes("primary_key_candidate")) {
      const totalSamples = v.nonNullSamples + v.nullSamples;
      if (v.nullSamples > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["semanticHints"],
          message: "primary_key_candidate columns must have nullSamples=0",
        });
      }
      if (totalSamples > 0 && v.distinctSamples !== totalSamples) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["semanticHints"],
          message:
            "primary_key_candidate columns must have distinctSamples=total samples (no duplicates)",
        });
      }
    }
    const hintsSeen = new Set<SemanticHint>();
    v.semanticHints.forEach((h, i) => {
      if (hintsSeen.has(h)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["semanticHints", i],
          message: `duplicate hint '${h}'`,
        });
      }
      hintsSeen.add(h);
    });
  });
export type InferredColumn = z.infer<typeof InferredColumnSchema>;

export const InferredSchemaSchema = z
  .object({
    entityName: z.string().regex(ENTITY_NAME_REGEX),
    sourceEntityLabel: z.string().min(1),
    columns: z.array(InferredColumnSchema).min(1),
    rowSampleCount: z.number().int().min(1),
    totalRowEstimate: z.number().int().nonnegative().optional(),
    primaryKeyCandidates: z.array(z.string().regex(COLUMN_NAME_REGEX)).default([]),
    overallConfidence: z.number().min(0).max(1),
  })
  .superRefine((v, ctx) => {
    const names = new Set<string>();
    v.columns.forEach((c, i) => {
      if (names.has(c.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["columns", i, "name"],
          message: `duplicate column name '${c.name}'`,
        });
      }
      names.add(c.name);
    });
    const columnNames = new Set(v.columns.map((c) => c.name));
    v.primaryKeyCandidates.forEach((pk, i) => {
      if (!columnNames.has(pk)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["primaryKeyCandidates", i],
          message: `primary key candidate '${pk}' is not a declared column`,
        });
      }
    });
    const pkSet = new Set<string>();
    v.primaryKeyCandidates.forEach((pk, i) => {
      if (pkSet.has(pk)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["primaryKeyCandidates", i],
          message: `duplicate primary key candidate '${pk}'`,
        });
      }
      pkSet.add(pk);
    });
  });
export type InferredSchema = z.infer<typeof InferredSchemaSchema>;

export interface RowSample {
  readonly [columnName: string]: string | number | boolean | null | undefined;
}

const INTEGER_REGEX = /^-?\d+$/;
const DECIMAL_REGEX = /^-?\d+\.\d+$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_REGEX = /^https?:\/\/\S+$/;
const PHONE_REGEX = /^\+?[\d\s\-()]{7,}$/;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?/;

export function inferTypeFromSample(value: unknown): InferredType {
  if (value === null || value === undefined) return "unknown";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") {
    return Number.isInteger(value) ? "integer" : "decimal";
  }
  if (typeof value !== "string") return "unknown";
  const s = value.trim();
  if (s.length === 0) return "unknown";
  if (s === "true" || s === "false") return "boolean";
  if (INTEGER_REGEX.test(s)) return "integer";
  if (DECIMAL_REGEX.test(s)) return "decimal";
  if (UUID_REGEX.test(s)) return "uuid";
  if (EMAIL_REGEX.test(s)) return "email";
  if (URL_REGEX.test(s)) return "url";
  if (DATETIME_REGEX.test(s)) return "datetime";
  if (DATE_REGEX.test(s)) return "date";
  if (PHONE_REGEX.test(s) && /\d{4}/.test(s)) return "phone";
  return "string";
}

export function consolidateTypes(types: readonly InferredType[]): InferredType {
  const counts = new Map<InferredType, number>();
  for (const t of types) {
    if (t === "unknown") continue;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  if (counts.size === 0) return "unknown";
  if (counts.size === 1) {
    return [...counts.keys()][0] ?? "unknown";
  }
  if (counts.has("decimal") && counts.has("integer")) {
    const others = [...counts.keys()].filter((k) => k !== "decimal" && k !== "integer");
    if (others.length === 0) return "decimal";
  }
  if (counts.has("datetime") && counts.has("date")) {
    const others = [...counts.keys()].filter((k) => k !== "datetime" && k !== "date");
    if (others.length === 0) return "datetime";
  }
  return "string";
}

export function columnConfidence(
  consolidatedType: InferredType,
  samples: readonly InferredType[],
): number {
  if (samples.length === 0) return 0;
  if (consolidatedType === "unknown") return 0;
  const matching = samples.filter(
    (t) =>
      t === consolidatedType ||
      (consolidatedType === "decimal" && t === "integer") ||
      (consolidatedType === "datetime" && t === "date") ||
      (consolidatedType === "string" && t !== "unknown"),
  ).length;
  return Math.round((matching / samples.length) * 100) / 100;
}
