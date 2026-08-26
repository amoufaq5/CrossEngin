import { z } from "zod";
import {
  FieldPathSchema,
  IconNameSchema,
  LocalizedTextSchema,
  PERMISSION_INHERIT,
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
    formats: z.array(z.enum(["csv", "xlsx", "json"])).min(1).default(["csv"]),
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

/** One place in a view declaration that names a field of the view's entity. */
export interface ViewFieldRef {
  /** The declared path, which may be dotted (`account.name`) to traverse a reference. */
  readonly path: string;
  /** Where in the declaration it appeared, e.g. `columns[3].field` — for the error message. */
  readonly where: string;
}

/**
 * Every field path a view names, across all eight kinds. Callers resolve these against the
 * entity; a dotted path traverses a reference, so only the first segment names a field of
 * *this* entity.
 */
export function viewReferencedFields(view: ViewDeclaration): readonly ViewFieldRef[] {
  const refs: ViewFieldRef[] = [];
  const push = (path: string | undefined, where: string): void => {
    if (path !== undefined) refs.push({ path, where });
  };

  // Every array is read through `?? []`: `validateManifest` runs against hand-built manifests
  // too, where a schema default like `filters: []` has never been applied.
  switch (view.kind) {
    case "list":
      (view.filters ?? []).forEach((f, i) => push(f.field, `filters[${i}].field`));
      (view.sort ?? []).forEach((s, i) => push(s.field, `sort[${i}].field`));
      (view.columns ?? []).forEach((c, i) => push(c.field, `columns[${i}].field`));
      (view.columnGroups ?? []).forEach((g, i) =>
        (g.columns ?? []).forEach((c, j) =>
          push(c.field, `columnGroups[${i}].columns[${j}].field`),
        ),
      );
      break;
    case "record":
      (view.sections ?? []).forEach((s, i) =>
        (s.fields ?? []).forEach((f, j) => push(f, `sections[${i}].fields[${j}]`)),
      );
      break;
    case "form":
      (view.steps ?? []).forEach((s, i) =>
        (s.fields ?? []).forEach((f, j) => push(f.field, `steps[${i}].fields[${j}].field`)),
      );
      break;
    case "kanban":
      push(view.stateField, "stateField");
      (view.cardFields ?? []).forEach((f, i) => push(f, `cardFields[${i}]`));
      push(view.groupBy, "groupBy");
      break;
    case "calendar":
      push(view.startField, "startField");
      push(view.endField, "endField");
      push(view.titleField, "titleField");
      push(view.colorField, "colorField");
      (view.filters ?? []).forEach((f, i) => push(f.field, `filters[${i}].field`));
      break;
    case "map":
      push(view.geoField, "geoField");
      push(view.markerColorField, "markerColorField");
      push(view.markerLabelField, "markerLabelField");
      (view.layers ?? []).forEach((l, i) =>
        (l.filters ?? []).forEach((f, j) => push(f.field, `layers[${i}].filters[${j}].field`)),
      );
      break;
    // A dashboard or pivot view delegates entirely to the dashboard/report it names, and
    // declares no field of its own.
    case "dashboard":
    case "pivot":
      break;
  }

  return refs;
}

/**
 * Workflow *state* names a view pins itself to. Only kanban does: each column is one state
 * of the entity's lifecycle. Distinct from `viewReferencedWorkflows`, which returns
 * transition names.
 */
export function viewReferencedStates(view: ViewDeclaration): readonly string[] {
  if (view.kind !== "kanban") return [];
  return (view.columns ?? []).map((c) => c.state);
}

/**
 * Role names a view's own permission override grants. Empty when it inherits the entity's
 * permissions — which is also the answer for an unparsed view, where the `"inherit"` default
 * has not been applied yet.
 */
export function viewReferencedRoles(view: ViewDeclaration): readonly string[] {
  const permissions: ViewDeclaration["permissions"] | undefined = view.permissions;
  if (permissions === undefined || permissions === PERMISSION_INHERIT) return [];
  return [...(permissions.roles ?? [])];
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
