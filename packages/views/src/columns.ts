import { z } from "zod";
import { FieldPathSchema, LocalizedTextSchema } from "./common.js";

export const COLUMN_RENDER_HINTS = [
  "text",
  "long_text",
  "badge",
  "boolean",
  "currency",
  "date",
  "datetime",
  "relativeTime",
  "duration",
  "enum",
  "reference",
  "tags",
  "file",
  "geo",
  "json",
  "avatar",
  "progress",
  "rating",
  "html",
  "markdown",
  "image",
  "url",
  "email",
  "phone",
  "code",
] as const;
export type ColumnRenderHint = (typeof COLUMN_RENDER_HINTS)[number];

export const COLUMN_ALIGNS = ["start", "center", "end"] as const;
export type ColumnAlign = (typeof COLUMN_ALIGNS)[number];

export const ColumnDefinitionSchema = z
  .object({
    field: FieldPathSchema,
    label: LocalizedTextSchema.optional(),
    render: z.enum(COLUMN_RENDER_HINTS).optional(),
    align: z.enum(COLUMN_ALIGNS).optional(),
    width: z.number().int().min(40).max(2000).optional(),
    sortable: z.boolean().default(true),
    filterable: z.boolean().default(true),
    hidden: z.boolean().default(false),
    sticky: z.enum(["start", "end"]).optional(),
    truncate: z.boolean().default(true),
    tooltip: LocalizedTextSchema.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.hidden && (v.sortable === true || v.filterable === true)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["hidden"],
        message: "hidden columns cannot be sortable or filterable",
      });
    }
  });
export type ColumnDefinition = z.infer<typeof ColumnDefinitionSchema>;

export const ColumnGroupSchema = z.object({
  label: LocalizedTextSchema,
  columns: z.array(ColumnDefinitionSchema).min(1),
});
export type ColumnGroup = z.infer<typeof ColumnGroupSchema>;
