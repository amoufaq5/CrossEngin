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
});

export type Field = z.infer<typeof FieldSchema>;
