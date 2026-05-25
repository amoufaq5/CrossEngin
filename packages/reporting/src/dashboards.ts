import { z } from "zod";
import { RbacGrantSchema } from "@crossengin/auth";

const DASHBOARD_ID_REGEX = /^[a-z][a-zA-Z0-9]*$/;

export const DashboardIdSchema = z.string().regex(DASHBOARD_ID_REGEX, {
  message: "dashboard id must be camelCase starting with a lowercase letter",
});

export const WIDGET_KINDS = [
  "kpi",
  "tabular",
  "pivot",
  "timeseries",
  "funnel",
  "cohort",
  "list",
  "markdown",
  "divider",
] as const;
export type WidgetKind = (typeof WIDGET_KINDS)[number];

export const WidgetReportRefSchema = z.object({
  kind: z.enum(WIDGET_KINDS).exclude(["markdown", "divider"]),
  report: z.string().min(1),
  title: z.record(z.string(), z.string()).optional(),
});
export type WidgetReportRef = z.infer<typeof WidgetReportRefSchema>;

export const WidgetMarkdownSchema = z.object({
  kind: z.literal("markdown"),
  body: z.record(z.string(), z.string()),
});
export type WidgetMarkdown = z.infer<typeof WidgetMarkdownSchema>;

export const WidgetDividerSchema = z.object({
  kind: z.literal("divider"),
  label: z.record(z.string(), z.string()).optional(),
});
export type WidgetDivider = z.infer<typeof WidgetDividerSchema>;

export const DashboardWidgetSchema = z.union([
  WidgetReportRefSchema,
  WidgetMarkdownSchema,
  WidgetDividerSchema,
]);
export type DashboardWidget = z.infer<typeof DashboardWidgetSchema>;

export const GRID_COLUMNS = 12;
export const GRID_MAX_ROW = 200;

export const GridCellSchema = z
  .object({
    x: z
      .number()
      .int()
      .min(0)
      .max(GRID_COLUMNS - 1),
    y: z.number().int().min(0).max(GRID_MAX_ROW),
    w: z.number().int().min(1).max(GRID_COLUMNS),
    h: z.number().int().min(1).max(GRID_MAX_ROW),
    widget: DashboardWidgetSchema,
  })
  .superRefine((v, ctx) => {
    if (v.x + v.w > GRID_COLUMNS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["w"],
        message: `cell width ${v.w} starting at x=${v.x} overflows the 12-column grid`,
      });
    }
  });
export type GridCell = z.infer<typeof GridCellSchema>;

export const DASHBOARD_LAYOUTS = ["grid", "stack"] as const;
export type DashboardLayout = (typeof DASHBOARD_LAYOUTS)[number];

export const DashboardDeclarationSchema = z
  .object({
    label: z.record(z.string(), z.string()).optional(),
    description: z.string().optional(),
    layout: z.enum(DASHBOARD_LAYOUTS).default("grid"),
    cells: z.array(GridCellSchema).min(1),
    permissions: RbacGrantSchema.optional(),
    refreshIntervalSeconds: z.number().int().min(15).max(3600).default(60),
  })
  .superRefine((v, ctx) => {
    const positions = new Set<string>();
    v.cells.forEach((cell, ci) => {
      for (let dy = 0; dy < cell.h; dy++) {
        for (let dx = 0; dx < cell.w; dx++) {
          const key = `${cell.x + dx},${cell.y + dy}`;
          if (positions.has(key)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["cells", ci],
              message: `cell overlaps another at (${cell.x + dx}, ${cell.y + dy})`,
            });
            return;
          }
          positions.add(key);
        }
      }
    });
  });
export type DashboardDeclaration = z.infer<typeof DashboardDeclarationSchema>;

export function widgetReferencedReports(dashboard: DashboardDeclaration): readonly string[] {
  const ids: string[] = [];
  for (const cell of dashboard.cells) {
    const widget = cell.widget;
    if ("report" in widget) {
      ids.push(widget.report);
    }
  }
  return ids;
}
