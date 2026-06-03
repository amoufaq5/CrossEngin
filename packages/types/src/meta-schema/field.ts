import { z } from "zod";
import { FieldTypeSchema } from "./field-types.js";

export const IndexHintSchema = z.union([
  z.boolean(),
  z.object({
    kind: z.enum(["btree", "gin", "gist"]),
  }),
]);

export type IndexHint = z.infer<typeof IndexHintSchema>;

export const UniqueHintSchema = z.union([
  z.boolean(),
  z.object({
    scope: z.array(z.string().min(1)).min(1),
  }),
]);

export type UniqueHint = z.infer<typeof UniqueHintSchema>;

export const ValidationRuleSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("regex"),
    pattern: z.string().min(1),
    message: z.string().optional(),
  }),
  z.object({
    kind: z.literal("custom"),
    expression: z.string().min(1),
    message: z.string().optional(),
  }),
]);

export type ValidationRule = z.infer<typeof ValidationRuleSchema>;

export const DefaultValueSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("literal"),
    value: z.unknown(),
  }),
  z.object({
    kind: z.literal("expression"),
    expression: z.string().min(1),
  }),
]);

export type DefaultValue = z.infer<typeof DefaultValueSchema>;

export const DATA_CLASSIFICATIONS = [
  "public",
  "internal",
  "commercial_sensitive",
  "pii",
  "phi",
  "regulated",
] as const;
export type DataClassification = (typeof DATA_CLASSIFICATIONS)[number];

export const DataClassificationSchema = z.enum(DATA_CLASSIFICATIONS);

export const SENSITIVE_DATA_CLASSIFICATIONS: ReadonlySet<DataClassification> = new Set([
  "commercial_sensitive",
  "pii",
  "phi",
  "regulated",
]);

export const AUDIT_REQUIRED_DATA_CLASSIFICATIONS: ReadonlySet<DataClassification> = new Set([
  "phi",
  "regulated",
]);

export function isSensitiveDataClass(c: DataClassification): boolean {
  return SENSITIVE_DATA_CLASSIFICATIONS.has(c);
}

export function requiresAuditTrail(c: DataClassification): boolean {
  return AUDIT_REQUIRED_DATA_CLASSIFICATIONS.has(c);
}

const FIELD_NAME_REGEX = /^[a-z][a-z0-9_]*$/;

export const FieldSchema = z.object({
  name: z.string().min(1).regex(FIELD_NAME_REGEX, {
    message: "field name must be snake_case starting with a lowercase letter",
  }),
  type: FieldTypeSchema,
  required: z.boolean().optional(),
  default: DefaultValueSchema.optional(),
  indexed: IndexHintSchema.optional(),
  unique: UniqueHintSchema.optional(),
  validations: z.array(ValidationRuleSchema).optional(),
  classification: DataClassificationSchema.optional(),
});

export type Field = z.infer<typeof FieldSchema>;

export function fieldClassification(field: Field): DataClassification | undefined {
  return field.classification;
}

export function isFieldSensitive(field: Field): boolean {
  return field.classification !== undefined && isSensitiveDataClass(field.classification);
}
