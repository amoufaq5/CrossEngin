import { z } from "zod";

const TextFieldSchema = z.object({
  kind: z.literal("text"),
  maxLength: z.number().int().positive().optional(),
});

const LongTextFieldSchema = z.object({
  kind: z.literal("long_text"),
});

const IntegerFieldSchema = z
  .object({
    kind: z.literal("integer"),
    min: z.number().int().optional(),
    max: z.number().int().optional(),
  })
  .refine((v) => v.min === undefined || v.max === undefined || v.min <= v.max, {
    message: "integer field: min must be <= max",
  });

const DecimalFieldSchema = z
  .object({
    kind: z.literal("decimal"),
    precision: z.number().int().positive(),
    scale: z.number().int().nonnegative(),
    min: z.number().optional(),
    max: z.number().optional(),
  })
  .refine((v) => v.scale <= v.precision, {
    message: "decimal field: scale must be <= precision",
  })
  .refine((v) => v.min === undefined || v.max === undefined || v.min <= v.max, {
    message: "decimal field: min must be <= max",
  });

const BooleanFieldSchema = z.object({ kind: z.literal("boolean") });
const DateFieldSchema = z.object({ kind: z.literal("date") });
const TimeFieldSchema = z.object({ kind: z.literal("time") });
const DateTimeFieldSchema = z.object({ kind: z.literal("datetime") });
const DurationFieldSchema = z.object({ kind: z.literal("duration") });
const UuidFieldSchema = z.object({ kind: z.literal("uuid") });

const EnumFieldSchema = z
  .object({
    kind: z.literal("enum"),
    values: z.array(z.string().min(1)).min(1),
  })
  .refine((v) => new Set(v.values).size === v.values.length, {
    message: "enum field: values must be unique",
  });

const ReferenceFieldSchema = z.object({
  kind: z.literal("reference"),
  target: z.string().min(1),
});

const JsonFieldSchema = z.object({ kind: z.literal("json") });
const FileFieldSchema = z.object({ kind: z.literal("file") });

const EmailFieldSchema = z.object({ kind: z.literal("email") });
const PhoneFieldSchema = z.object({ kind: z.literal("phone") });
const UrlFieldSchema = z.object({ kind: z.literal("url") });
const CurrencyAmountFieldSchema = z.object({ kind: z.literal("currency_amount") });
const GeoPointFieldSchema = z.object({ kind: z.literal("geo_point") });
const GeoPolygonFieldSchema = z.object({ kind: z.literal("geo_polygon") });
const CountryCodeFieldSchema = z.object({ kind: z.literal("country_code") });
const LanguageCodeFieldSchema = z.object({ kind: z.literal("language_code") });
const TimezoneFieldSchema = z.object({ kind: z.literal("timezone") });

export const PrimitiveFieldTypeSchema = z.union([
  TextFieldSchema,
  LongTextFieldSchema,
  IntegerFieldSchema,
  DecimalFieldSchema,
  BooleanFieldSchema,
  DateFieldSchema,
  TimeFieldSchema,
  DateTimeFieldSchema,
  DurationFieldSchema,
  UuidFieldSchema,
  EnumFieldSchema,
  ReferenceFieldSchema,
  JsonFieldSchema,
  FileFieldSchema,
  EmailFieldSchema,
  PhoneFieldSchema,
  UrlFieldSchema,
  CurrencyAmountFieldSchema,
  GeoPointFieldSchema,
  GeoPolygonFieldSchema,
  CountryCodeFieldSchema,
  LanguageCodeFieldSchema,
  TimezoneFieldSchema,
]);

export type PrimitiveFieldType = z.infer<typeof PrimitiveFieldTypeSchema>;

const ArrayFieldSchema = z.object({
  kind: z.literal("array"),
  element: PrimitiveFieldTypeSchema,
});

export const FieldTypeSchema = z.union([PrimitiveFieldTypeSchema, ArrayFieldSchema]);

export type FieldType = z.infer<typeof FieldTypeSchema>;
