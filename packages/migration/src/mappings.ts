import { z } from "zod";
import { InferredTypeSchema, type InferredType } from "./schemas.js";

const TARGET_FIELD_REGEX = /^[a-z][a-z0-9_]*$/;
const ENTITY_REGEX = /^[a-z][a-z0-9_]*$/;
const MAPPING_ID_REGEX = /^[a-z][a-z0-9-]*$/;

export const TRANSFORM_KINDS = [
  "identity",
  "trim",
  "lowercase",
  "uppercase",
  "date_parse",
  "datetime_parse",
  "number_parse",
  "boolean_parse",
  "split",
  "concat",
  "lookup",
  "default_if_null",
  "regex_extract",
  "redact",
] as const;
export type TransformKind = (typeof TRANSFORM_KINDS)[number];
export const TransformKindSchema = z.enum(TRANSFORM_KINDS);

export const FieldTransformSchema = z
  .object({
    kind: TransformKindSchema,
    pattern: z.string().min(1).optional(),
    delimiter: z.string().min(1).optional(),
    inputFormat: z.string().min(1).optional(),
    outputFormat: z.string().min(1).optional(),
    defaultValue: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
    lookupTable: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    sourceFields: z.array(z.string().min(1)).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "regex_extract" && v.pattern === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pattern"],
        message: "regex_extract requires pattern",
      });
    }
    if (v.kind === "split" && v.delimiter === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["delimiter"],
        message: "split requires delimiter",
      });
    }
    if (v.kind === "concat" && (v.sourceFields === undefined || v.sourceFields.length < 2)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourceFields"],
        message: "concat requires at least two sourceFields",
      });
    }
    if (v.kind === "lookup" && v.lookupTable === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lookupTable"],
        message: "lookup requires lookupTable",
      });
    }
    if (v.kind === "date_parse" && v.inputFormat === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["inputFormat"],
        message: "date_parse requires inputFormat",
      });
    }
    if (v.kind === "default_if_null" && v.defaultValue === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultValue"],
        message: "default_if_null requires defaultValue",
      });
    }
    if (v.pattern !== undefined && v.kind === "regex_extract") {
      try {
        new RegExp(v.pattern);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["pattern"],
          message: "pattern must be a valid JavaScript regex",
        });
      }
    }
  });
export type FieldTransform = z.infer<typeof FieldTransformSchema>;

export const FieldMappingSchema = z
  .object({
    sourceField: z.string().min(1),
    targetField: z.string().regex(TARGET_FIELD_REGEX),
    targetType: InferredTypeSchema,
    targetNullable: z.boolean().default(true),
    transforms: z.array(FieldTransformSchema).default([]),
    required: z.boolean().default(false),
    skipIfNull: z.boolean().default(false),
    notes: z.string().min(1).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.required && v.targetNullable) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetNullable"],
        message: "required=true implies targetNullable=false",
      });
    }
    if (v.skipIfNull && v.required) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["skipIfNull"],
        message: "skipIfNull cannot be combined with required (contradictory semantics)",
      });
    }
  });
export type FieldMapping = z.infer<typeof FieldMappingSchema>;

export const EntityMappingSchema = z
  .object({
    id: z.string().regex(MAPPING_ID_REGEX),
    sourceEntity: z.string().min(1),
    targetEntity: z.string().regex(ENTITY_REGEX),
    fields: z.array(FieldMappingSchema).min(1),
    skipUnmappedSourceFields: z.boolean().default(true),
    idempotencyKeyFields: z.array(z.string().regex(TARGET_FIELD_REGEX)).min(1),
    upsertMode: z.enum(["insert_only", "upsert", "update_only"]).default("upsert"),
  })
  .superRefine((v, ctx) => {
    const sources = new Set<string>();
    const targets = new Set<string>();
    v.fields.forEach((f, i) => {
      if (sources.has(f.sourceField)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["fields", i, "sourceField"],
          message: `source field '${f.sourceField}' mapped more than once`,
        });
      }
      sources.add(f.sourceField);
      if (targets.has(f.targetField)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["fields", i, "targetField"],
          message: `target field '${f.targetField}' is the destination of more than one mapping`,
        });
      }
      targets.add(f.targetField);
    });
    v.idempotencyKeyFields.forEach((k, i) => {
      if (!targets.has(k)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["idempotencyKeyFields", i],
          message: `idempotency key '${k}' is not a declared target field`,
        });
      }
    });
    const idKeySet = new Set<string>();
    v.idempotencyKeyFields.forEach((k, i) => {
      if (idKeySet.has(k)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["idempotencyKeyFields", i],
          message: `duplicate idempotency key '${k}'`,
        });
      }
      idKeySet.add(k);
    });
  });
export type EntityMapping = z.infer<typeof EntityMappingSchema>;

export interface TypeCoercionResult {
  readonly compatible: boolean;
  readonly reason?: string;
}

const LOSSLESS_COERCIONS: Readonly<Record<InferredType, ReadonlyArray<InferredType>>> = Object.freeze({
  string: ["string"],
  integer: ["integer", "decimal", "string"],
  decimal: ["decimal", "string"],
  boolean: ["boolean", "integer", "string"],
  date: ["date", "datetime", "string"],
  datetime: ["datetime", "string"],
  uuid: ["uuid", "string"],
  email: ["email", "string"],
  url: ["url", "string"],
  phone: ["phone", "string"],
  json: ["json", "string"],
  binary: ["binary"],
  unknown: ["string", "json"],
});

export function isTypeCoercionAllowed(
  source: InferredType,
  target: InferredType,
): TypeCoercionResult {
  const allowed = LOSSLESS_COERCIONS[source] ?? [];
  if (allowed.includes(target)) {
    return { compatible: true };
  }
  return {
    compatible: false,
    reason: `cannot losslessly coerce '${source}' to '${target}'`,
  };
}
