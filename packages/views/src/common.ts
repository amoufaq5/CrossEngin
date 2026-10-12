import { z } from "zod";

export const VIEW_ID_REGEX = /^[a-z][a-zA-Z0-9]*$/;
export const FIELD_PATH_REGEX = /^[a-z][a-zA-Z0-9_]*(?:\.[a-z][a-zA-Z0-9_]*)*$/;
export const I18N_KEY_REGEX = /^[a-z]{2,3}(?:-[A-Z]{2})?$/;

export const ViewIdSchema = z.string().regex(VIEW_ID_REGEX, {
  message: "view id must be camelCase starting with a lowercase letter",
});

export const FieldPathSchema = z.string().regex(FIELD_PATH_REGEX, {
  message: "field path must be lowercase.dot.path",
});

export const LocalizedTextSchema = z.record(z.string().regex(I18N_KEY_REGEX), z.string().min(1));
export type LocalizedText = z.infer<typeof LocalizedTextSchema>;

export const ICON_NAME_REGEX = /^[A-Z][A-Za-z0-9]*$/;
export const IconNameSchema = z.string().regex(ICON_NAME_REGEX, {
  message: "icon must be PascalCase (Lucide icon name)",
});

export const FilterValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const FILTER_OPERATORS = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "nin",
  "between",
  "contains",
  "starts_with",
  "ends_with",
  "is_null",
  "is_not_null",
] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

export const SINGLE_VALUE_OPERATORS = new Set<FilterOperator>([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "starts_with",
  "ends_with",
]);
export const ARRAY_OPERATORS = new Set<FilterOperator>(["in", "nin"]);
export const TUPLE_OPERATORS = new Set<FilterOperator>(["between"]);
export const NO_VALUE_OPERATORS = new Set<FilterOperator>(["is_null", "is_not_null"]);

export const ViewFilterSchema = z
  .object({
    field: FieldPathSchema,
    operator: z.enum(FILTER_OPERATORS),
    value: FilterValueSchema.optional(),
    values: z.array(FilterValueSchema).optional(),
    range: z.tuple([FilterValueSchema, FilterValueSchema]).optional(),
  })
  .superRefine((v, ctx) => {
    if (SINGLE_VALUE_OPERATORS.has(v.operator) && v.value === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["value"],
        message: `operator '${v.operator}' requires 'value'`,
      });
    }
    if (ARRAY_OPERATORS.has(v.operator) && (v.values === undefined || v.values.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["values"],
        message: `operator '${v.operator}' requires a non-empty 'values' array`,
      });
    }
    if (TUPLE_OPERATORS.has(v.operator) && v.range === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["range"],
        message: `operator '${v.operator}' requires 'range' [from, to]`,
      });
    }
    if (
      NO_VALUE_OPERATORS.has(v.operator) &&
      (v.value !== undefined || v.values !== undefined || v.range !== undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["operator"],
        message: `operator '${v.operator}' takes no value/values/range`,
      });
    }
  });
export type ViewFilter = z.infer<typeof ViewFilterSchema>;

export const ViewSortSchema = z.object({
  field: FieldPathSchema,
  direction: z.enum(["asc", "desc"]).default("asc"),
});
export type ViewSort = z.infer<typeof ViewSortSchema>;

export const PERMISSION_INHERIT = "inherit" as const;

/**
 * Which roles a view is presented to: `"inherit"` (the entity's own grants decide) or an explicit
 * role list.
 *
 * It carries **no `abac` key**, and that absence is deliberate. An ABAC obligation is an
 * authorization qualifier that something has to *discharge*, and the only surface that discharges
 * one is the entity grant path — `surveyAbacObligations` walks `manifest.permissions` and nothing
 * else, which is what the boot refusal for an undischargeable obligation is built from. A key here
 * would therefore be an obligation no deployment could discharge *and* no boot check could see: a
 * manifest declaring one would be approved by a reviewer, hashed into `manifestHash`, and served
 * with its qualifier silently removed. That is the exact defect the boot refusal exists to prevent,
 * at the one position the refusal cannot reach.
 *
 * Deleting it rather than surveying it is the proportionate answer because the measured count of
 * views declaring one, across all seven packs, is **zero** — so nothing is taken away — and because
 * a view's permission declaration is served by nothing at all today (`listConfigForEntity` is the
 * only serve-time reader of `manifest.views` and reads `columns`, `sort` and `pageSize`). Modelling
 * an obligation on an unserved surface would be a trap for a manifest author rather than a
 * capability. The `roles` half stays: it is validated against `manifest.roles`, it says something
 * coherent about presentation, and a boot survey now reports that this deployment does not read it.
 */
export const PermissionRefSchema = z.union([
  z.literal(PERMISSION_INHERIT),
  z.object({
    roles: z.array(z.string().min(1)).min(1),
  }),
]);
export type PermissionRef = z.infer<typeof PermissionRefSchema>;
