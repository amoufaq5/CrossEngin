import { z } from "zod";
import { RbacGrantSchema } from "@crossengin/auth";
import { ReportScheduleSchema } from "./schedule.js";

const REPORT_ID_REGEX = /^[a-z][a-zA-Z0-9]*$/;
const FIELD_PATH_REGEX = /^[a-z][a-zA-Z0-9_]*(?:\.[a-z][a-zA-Z0-9_]*)*$/;

export const ReportIdSchema = z.string().regex(REPORT_ID_REGEX, {
  message: "report id must be camelCase starting with a lowercase letter",
});

export const FilterOperatorSchema = z.enum([
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
]);
export type FilterOperator = z.infer<typeof FilterOperatorSchema>;

export const FilterValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

const SingleValueOperators = new Set([
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
const ArrayOperators = new Set(["in", "nin"]);
const TupleOperators = new Set(["between"]);
const NoValueOperators = new Set(["is_null", "is_not_null"]);

export const ReportFilterSchema = z
  .object({
    field: z.string().regex(FIELD_PATH_REGEX),
    operator: FilterOperatorSchema,
    value: FilterValueSchema.optional(),
    values: z.array(FilterValueSchema).optional(),
    range: z.tuple([FilterValueSchema, FilterValueSchema]).optional(),
  })
  .superRefine((v, ctx) => {
    if (SingleValueOperators.has(v.operator)) {
      if (v.value === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["value"],
          message: `operator '${v.operator}' requires 'value'`,
        });
      }
    }
    if (ArrayOperators.has(v.operator)) {
      if (v.values === undefined || v.values.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["values"],
          message: `operator '${v.operator}' requires a non-empty 'values' array`,
        });
      }
    }
    if (TupleOperators.has(v.operator)) {
      if (v.range === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["range"],
          message: `operator '${v.operator}' requires 'range' [from, to]`,
        });
      }
    }
    if (NoValueOperators.has(v.operator)) {
      if (v.value !== undefined || v.values !== undefined || v.range !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["operator"],
          message: `operator '${v.operator}' takes no value/values/range`,
        });
      }
    }
  });
export type ReportFilter = z.infer<typeof ReportFilterSchema>;

export const AGGREGATION_KINDS = [
  "count",
  "count_distinct",
  "sum",
  "avg",
  "min",
  "max",
  "median",
  "p95",
] as const;
export type AggregationKind = (typeof AGGREGATION_KINDS)[number];

export const AggregationSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-zA-Z0-9_]*$/, {
      message: "aggregation name must be snake_case or camelCase",
    }),
    kind: z.enum(AGGREGATION_KINDS),
    field: z.string().regex(FIELD_PATH_REGEX).optional(),
    label: z.record(z.string(), z.string()).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kind !== "count" && v.field === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["field"],
        message: `aggregation kind '${v.kind}' requires a 'field'`,
      });
    }
  });
export type Aggregation = z.infer<typeof AggregationSchema>;

export const SortSchema = z.object({
  field: z.string().min(1),
  direction: z.enum(["asc", "desc"]).default("asc"),
});
export type Sort = z.infer<typeof SortSchema>;

export const REPORT_ENGINES = ["postgres", "clickhouse", "auto"] as const;
export type ReportEngine = (typeof REPORT_ENGINES)[number];

export const TIMESERIES_BUCKETS = [
  "minute",
  "hour",
  "day",
  "week",
  "month",
  "quarter",
  "year",
] as const;
export type TimeseriesBucket = (typeof TIMESERIES_BUCKETS)[number];

export const KpiComparisonSchema = z.object({
  period: z.enum(["prev_day", "prev_week", "prev_month", "prev_quarter", "prev_year"]),
  showAsPercent: z.boolean().default(true),
});
export type KpiComparison = z.infer<typeof KpiComparisonSchema>;

export const KpiThresholdSchema = z.object({
  warning: z.number().optional(),
  critical: z.number().optional(),
  direction: z.enum(["higher_is_better", "lower_is_better"]).default("higher_is_better"),
});
export type KpiThreshold = z.infer<typeof KpiThresholdSchema>;

const BaseReportSchema = z.object({
  label: z.record(z.string(), z.string()).optional(),
  description: z.string().optional(),
  entity: z.string().min(1),
  filters: z.array(ReportFilterSchema).default([]),
  permissions: RbacGrantSchema.optional(),
  abac: z.string().min(1).optional(),
  engine: z.enum(REPORT_ENGINES).default("auto"),
  materialize: z.boolean().default(false),
  cacheTtlSeconds: z.number().int().min(0).max(3600).default(60),
  compliancePack: z.string().min(1).optional(),
  schedule: ReportScheduleSchema.optional(),
});

export const TabularReportSchema = BaseReportSchema.extend({
  kind: z.literal("tabular"),
  columns: z.array(z.string().regex(FIELD_PATH_REGEX)).default([]),
  groupBy: z.array(z.string().regex(FIELD_PATH_REGEX)).default([]),
  aggregations: z.array(AggregationSchema).default([]),
  sort: z.array(SortSchema).default([]),
  limit: z.number().int().positive().max(10_000).default(100),
});

export const PivotReportSchema = BaseReportSchema.extend({
  kind: z.literal("pivot"),
  rows: z.array(z.string().regex(FIELD_PATH_REGEX)).min(1),
  columns: z.array(z.string().regex(FIELD_PATH_REGEX)).min(1),
  measures: z.array(AggregationSchema).min(1),
});

export const TimeseriesReportSchema = BaseReportSchema.extend({
  kind: z.literal("timeseries"),
  timeField: z.string().regex(FIELD_PATH_REGEX),
  bucket: z.enum(TIMESERIES_BUCKETS),
  series: z.array(AggregationSchema).min(1),
  groupBy: z.array(z.string().regex(FIELD_PATH_REGEX)).default([]),
});

export const KpiReportSchema = BaseReportSchema.extend({
  kind: z.literal("kpi"),
  measure: AggregationSchema,
  comparison: KpiComparisonSchema.optional(),
  sparkline: z
    .object({
      timeField: z.string().regex(FIELD_PATH_REGEX),
      bucket: z.enum(TIMESERIES_BUCKETS),
      points: z.number().int().min(2).max(180).default(30),
    })
    .optional(),
  threshold: KpiThresholdSchema.optional(),
});

export const FunnelReportSchema = BaseReportSchema.extend({
  kind: z.literal("funnel"),
  steps: z
    .array(
      z.object({
        name: z.string().min(1),
        filter: ReportFilterSchema,
      }),
    )
    .min(2),
  timeWindow: z.string().regex(/^P\d+[DWMY]$/).default("P30D"),
});

export const CohortReportSchema = BaseReportSchema.extend({
  kind: z.literal("cohort"),
  cohortField: z.string().regex(FIELD_PATH_REGEX),
  cohortBucket: z.enum(TIMESERIES_BUCKETS).default("month"),
  retentionEvent: ReportFilterSchema,
  retentionBuckets: z.number().int().min(1).max(36).default(12),
});

export const CustomReportSchema = BaseReportSchema.extend({
  kind: z.literal("custom"),
  curatedBy: z.string().min(1),
  sqlTemplate: z.string().min(1),
  parameters: z
    .array(
      z.object({
        name: z.string().regex(/^[a-z][a-z0-9_]*$/),
        type: z.enum(["string", "integer", "boolean", "date", "datetime"]),
        required: z.boolean().default(false),
      }),
    )
    .default([]),
});

export const ReportDeclarationSchema = z.discriminatedUnion("kind", [
  TabularReportSchema,
  PivotReportSchema,
  TimeseriesReportSchema,
  KpiReportSchema,
  FunnelReportSchema,
  CohortReportSchema,
  CustomReportSchema,
]);
export type ReportDeclaration = z.infer<typeof ReportDeclarationSchema>;

export const REPORT_KINDS = [
  "tabular",
  "pivot",
  "timeseries",
  "kpi",
  "funnel",
  "cohort",
  "custom",
] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
