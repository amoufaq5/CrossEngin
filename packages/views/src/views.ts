import { z } from "zod";
import {
  FieldPathSchema,
  IconNameSchema,
  LocalizedTextSchema,
  PermissionRefSchema,
  ViewFilterSchema,
  ViewSortSchema,
} from "./common.js";
import { ColumnDefinitionSchema, ColumnGroupSchema } from "./columns.js";

export const VIEW_KINDS = [
  "list",
  "record",
  "form",
  "kanban",
  "calendar",
  "map",
  "dashboard",
  "pivot",
] as const;
export type ViewKind = (typeof VIEW_KINDS)[number];

const RowActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("openRecord"),
    view: z.string().min(1),
  }),
  z.object({
    kind: z.literal("openForm"),
    view: z.string().min(1),
  }),
  z.object({
    kind: z.literal("workflow"),
    name: z.string().min(1),
  }),
  z.object({
    kind: z.literal("link"),
    href: z.string().min(1),
    label: LocalizedTextSchema,
  }),
]);

const BulkActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("workflow"),
    name: z.string().min(1),
    label: LocalizedTextSchema,
    confirm: z.boolean().default(true),
  }),
  z.object({
    kind: z.literal("export"),
    label: LocalizedTextSchema,
    formats: z
      .array(z.enum(["csv", "xlsx", "json"]))
      .min(1)
      .default(["csv"]),
  }),
  z.object({
    kind: z.literal("delete"),
    label: LocalizedTextSchema,
    confirm: z.literal(true).default(true),
  }),
]);

const BaseViewSchema = z.object({
  entity: z.string().min(1),
  label: LocalizedTextSchema.optional(),
  description: LocalizedTextSchema.optional(),
  icon: IconNameSchema.optional(),
  permissions: PermissionRefSchema.default("inherit"),
});

export const ListViewSchema = BaseViewSchema.extend({
  kind: z.literal("list"),
  filters: z.array(ViewFilterSchema).default([]),
  sort: z.array(ViewSortSchema).default([]),
  columns: z.array(ColumnDefinitionSchema).min(1),
  columnGroups: z.array(ColumnGroupSchema).optional(),
  pageSize: z.number().int().min(5).max(500).default(50),
  rowAction: RowActionSchema.optional(),
  bulkActions: z.array(BulkActionSchema).default([]),
  exportFormats: z.array(z.enum(["csv", "xlsx", "json"])).default([]),
});
export type ListView = z.infer<typeof ListViewSchema>;

export const RECORD_SECTION_LAYOUTS = ["single_column", "two_column", "tabs"] as const;
export type RecordSectionLayout = (typeof RECORD_SECTION_LAYOUTS)[number];

const RecordSectionSchema = z.object({
  id: z.string().min(1),
  label: LocalizedTextSchema,
  layout: z.enum(RECORD_SECTION_LAYOUTS).default("single_column"),
  fields: z.array(FieldPathSchema).min(1),
  collapsed: z.boolean().default(false),
});

const RelatedListSchema = z.object({
  id: z.string().min(1),
  label: LocalizedTextSchema,
  relation: z.string().min(1),
  view: z.string().min(1),
  emptyState: LocalizedTextSchema.optional(),
});

export const RecordViewSchema = BaseViewSchema.extend({
  kind: z.literal("record"),
  sections: z.array(RecordSectionSchema).min(1),
  related: z.array(RelatedListSchema).default([]),
  primaryActions: z
    .array(
      z.object({
        kind: z.enum(["workflow", "link", "openForm"]),
        target: z.string().min(1),
        label: LocalizedTextSchema,
      }),
    )
    .default([]),
});
export type RecordView = z.infer<typeof RecordViewSchema>;

const FormFieldSchema = z.object({
  field: FieldPathSchema,
  required: z.boolean().optional(),
  readOnly: z.boolean().optional(),
  hidden: z.boolean().optional(),
  helpText: LocalizedTextSchema.optional(),
  placeholder: LocalizedTextSchema.optional(),
  widget: z.string().min(1).optional(),
});

const FormStepSchema = z
  .object({
    id: z.string().min(1),
    label: LocalizedTextSchema,
    fields: z.array(FormFieldSchema).min(1),
  })
  .superRefine((v, ctx) => {
    const fieldNames = new Set<string>();
    v.fields.forEach((f, i) => {
      if (fieldNames.has(f.field)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["fields", i, "field"],
          message: `duplicate field '${f.field}' within step '${v.id}'`,
        });
      }
      fieldNames.add(f.field);
    });
  });

export const FormViewSchema = BaseViewSchema.extend({
  kind: z.literal("form"),
  mode: z.enum(["create", "edit", "intake"]).default("edit"),
  steps: z.array(FormStepSchema).min(1),
  submitLabel: LocalizedTextSchema.optional(),
  cancelLabel: LocalizedTextSchema.optional(),
  autosave: z.boolean().default(false),
});
export type FormView = z.infer<typeof FormViewSchema>;

export const KanbanViewSchema = BaseViewSchema.extend({
  kind: z.literal("kanban"),
  stateField: FieldPathSchema,
  columns: z
    .array(
      z.object({
        state: z.string().min(1),
        label: LocalizedTextSchema,
        color: z.string().min(1).optional(),
        wipLimit: z.number().int().positive().optional(),
      }),
    )
    .min(1),
  cardFields: z.array(FieldPathSchema).min(1),
  allowedTransitions: z.array(z.string().min(1)).default([]),
  groupBy: FieldPathSchema.optional(),
});
export type KanbanView = z.infer<typeof KanbanViewSchema>;

export const CALENDAR_DEFAULT_VIEWS = ["day", "week", "month", "agenda"] as const;
export type CalendarDefaultView = (typeof CALENDAR_DEFAULT_VIEWS)[number];

export const CalendarViewSchema = BaseViewSchema.extend({
  kind: z.literal("calendar"),
  startField: FieldPathSchema,
  endField: FieldPathSchema.optional(),
  titleField: FieldPathSchema,
  colorField: FieldPathSchema.optional(),
  defaultView: z.enum(CALENDAR_DEFAULT_VIEWS).default("week"),
  workingHours: z
    .object({
      startHour: z.number().int().min(0).max(23),
      endHour: z.number().int().min(1).max(24),
      weekdays: z.array(z.number().int().min(0).max(6)).default([0, 1, 2, 3, 4, 5, 6]),
    })
    .optional(),
  filters: z.array(ViewFilterSchema).default([]),
});
export type CalendarView = z.infer<typeof CalendarViewSchema>;

export const MapViewSchema = BaseViewSchema.extend({
  kind: z.literal("map"),
  geoField: FieldPathSchema,
  markerColorField: FieldPathSchema.optional(),
  markerLabelField: FieldPathSchema.optional(),
  defaultZoom: z.number().int().min(1).max(20).default(10),
  layers: z
    .array(
      z.object({
        id: z.string().min(1),
        label: LocalizedTextSchema,
        kind: z.enum(["markers", "heatmap", "polygons", "cluster"]),
        filters: z.array(ViewFilterSchema).default([]),
      }),
    )
    .min(1),
  bounds: z
    .object({
      south: z.number().min(-90).max(90),
      west: z.number().min(-180).max(180),
      north: z.number().min(-90).max(90),
      east: z.number().min(-180).max(180),
    })
    .optional(),
});
export type MapView = z.infer<typeof MapViewSchema>;

export const DashboardViewSchema = BaseViewSchema.extend({
  kind: z.literal("dashboard"),
  dashboardRef: z.string().min(1),
});
export type DashboardView = z.infer<typeof DashboardViewSchema>;

export const PivotViewSchema = BaseViewSchema.extend({
  kind: z.literal("pivot"),
  reportRef: z.string().min(1),
  allowReshape: z.boolean().default(true),
});
export type PivotView = z.infer<typeof PivotViewSchema>;

export const ViewDeclarationSchema = z.discriminatedUnion("kind", [
  ListViewSchema,
  RecordViewSchema,
  FormViewSchema,
  KanbanViewSchema,
  CalendarViewSchema,
  MapViewSchema,
  DashboardViewSchema,
  PivotViewSchema,
]);
export type ViewDeclaration = z.infer<typeof ViewDeclarationSchema>;

export function viewReferencedReports(view: ViewDeclaration): readonly string[] {
  if (view.kind === "pivot") return [view.reportRef];
  return [];
}

export function viewReferencedDashboards(view: ViewDeclaration): readonly string[] {
  if (view.kind === "dashboard") return [view.dashboardRef];
  return [];
}

export function viewReferencedViews(view: ViewDeclaration): readonly string[] {
  const refs: string[] = [];
  if (view.kind === "list") {
    if (view.rowAction !== undefined && "view" in view.rowAction) {
      refs.push(view.rowAction.view);
    }
  }
  if (view.kind === "record") {
    for (const r of view.related ?? []) refs.push(r.view);
  }
  return refs;
}

export function viewReferencedWorkflows(view: ViewDeclaration): readonly string[] {
  const refs: string[] = [];
  if (view.kind === "list") {
    if (view.rowAction?.kind === "workflow") refs.push(view.rowAction.name);
    for (const action of view.bulkActions ?? []) {
      if (action.kind === "workflow") refs.push(action.name);
    }
  }
  if (view.kind === "record") {
    for (const p of view.primaryActions ?? []) {
      if (p.kind === "workflow") refs.push(p.target);
    }
  }
  if (view.kind === "kanban") {
    refs.push(...(view.allowedTransitions ?? []));
  }
  return refs;
}
