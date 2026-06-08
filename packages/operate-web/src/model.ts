import { z } from "zod";

/**
 * The serializable view-model descriptors `operate-web` compiles a resolved
 * manifest into. Every shape is pure data (no functions / class instances) so a
 * model can be JSON-serialized and handed to any frontend framework. The
 * compiler is framework-neutral on purpose — it ships render *intent*, not DOM.
 */

/** A render hint mirroring the manifest field type, so a frontend can pick a widget. */
export const WEB_FIELD_TYPES = [
  "text",
  "long_text",
  "integer",
  "decimal",
  "boolean",
  "date",
  "time",
  "datetime",
  "duration",
  "uuid",
  "enum",
  "reference",
  "json",
  "file",
  "email",
  "phone",
  "url",
  "currency_amount",
  "geo_point",
  "geo_polygon",
  "country_code",
  "language_code",
  "timezone",
  "array",
] as const;
export type WebFieldType = (typeof WEB_FIELD_TYPES)[number];

export const WebFieldTypeSchema = z.enum(WEB_FIELD_TYPES);

export const ColumnModelSchema = z.object({
  field: z.string().min(1),
  label: z.string().min(1),
  type: WebFieldTypeSchema,
  sortable: z.boolean(),
  filterable: z.boolean(),
});
export type ColumnModel = z.infer<typeof ColumnModelSchema>;

export const TableSortSchema = z.object({
  field: z.string().min(1),
  direction: z.enum(["asc", "desc"]),
});
export type TableSort = z.infer<typeof TableSortSchema>;

export const RowActionModelSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("openRecord"), view: z.string().min(1) }),
  z.object({ kind: z.literal("openForm"), view: z.string().min(1) }),
  z.object({ kind: z.literal("transition"), name: z.string().min(1), label: z.string().min(1) }),
]);
export type RowActionModel = z.infer<typeof RowActionModelSchema>;

export const TableModelSchema = z.object({
  entity: z.string().min(1),
  title: z.string().min(1),
  columns: z.array(ColumnModelSchema),
  defaultSort: z.array(TableSortSchema),
  pageSize: z.number().int().positive(),
  rowActions: z.array(RowActionModelSchema),
});
export type TableModel = z.infer<typeof TableModelSchema>;

export const FieldModelSchema = z.object({
  field: z.string().min(1),
  label: z.string().min(1),
  type: WebFieldTypeSchema,
  /** Present only when the model carries a concrete record's value (detail). */
  value: z.unknown().optional(),
});
export type FieldModel = z.infer<typeof FieldModelSchema>;

export const DetailSectionModelSchema = z.object({
  title: z.string().min(1),
  fields: z.array(FieldModelSchema),
});
export type DetailSectionModel = z.infer<typeof DetailSectionModelSchema>;

export const DetailModelSchema = z.object({
  entity: z.string().min(1),
  title: z.string().min(1),
  sections: z.array(DetailSectionModelSchema),
});
export type DetailModel = z.infer<typeof DetailModelSchema>;

export const FormValidationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("required") }),
  z.object({ kind: z.literal("regex"), pattern: z.string().min(1) }),
  z.object({ kind: z.literal("min"), value: z.number() }),
  z.object({ kind: z.literal("max"), value: z.number() }),
  z.object({ kind: z.literal("enum"), values: z.array(z.string().min(1)) }),
]);
export type FormValidation = z.infer<typeof FormValidationSchema>;

export const FormFieldModelSchema = z.object({
  field: z.string().min(1),
  label: z.string().min(1),
  type: WebFieldTypeSchema,
  required: z.boolean(),
  readOnly: z.boolean(),
  validations: z.array(FormValidationSchema),
});
export type FormFieldModel = z.infer<typeof FormFieldModelSchema>;

export const FORM_MODES = ["create", "edit"] as const;
export type FormMode = (typeof FORM_MODES)[number];

export const FormModelSchema = z.object({
  entity: z.string().min(1),
  mode: z.enum(FORM_MODES),
  title: z.string().min(1),
  fields: z.array(FormFieldModelSchema),
});
export type FormModel = z.infer<typeof FormModelSchema>;

export const EntityNavSchema = z.object({
  entity: z.string().min(1),
  label: z.string().min(1),
  /** Path to the entity's list/table surface, e.g. `/ui/Product`. */
  path: z.string().min(1),
  /** The view kinds available for the entity, derived from the manifest + fallbacks. */
  views: z.array(z.enum(["table", "detail", "form"])),
});
export type EntityNav = z.infer<typeof EntityNavSchema>;

export const WebAppModelSchema = z.object({
  title: z.string().min(1),
  nav: z.array(EntityNavSchema),
});
export type WebAppModel = z.infer<typeof WebAppModelSchema>;
