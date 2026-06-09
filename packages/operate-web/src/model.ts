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

/** A display field on a kanban card or a calendar event (no value — pure layout intent). */
export const CardFieldModelSchema = z.object({
  field: z.string().min(1),
  label: z.string().min(1),
  type: WebFieldTypeSchema,
});
export type CardFieldModel = z.infer<typeof CardFieldModelSchema>;

export const KanbanColumnModelSchema = z.object({
  state: z.string().min(1),
  label: z.string().min(1),
  color: z.string().min(1).optional(),
  wipLimit: z.number().int().positive().optional(),
});
export type KanbanColumnModel = z.infer<typeof KanbanColumnModelSchema>;

/**
 * A workflow transition a card may fire by being dragged between columns —
 * resolved from the entity's `entityLifecycle` + RBAC-gated for the viewer.
 * `fromStates` is the set of states the transition is valid from; `toState` the
 * column it lands in.
 */
export const KanbanTransitionModelSchema = z.object({
  name: z.string().min(1),
  toState: z.string().min(1),
  fromStates: z.array(z.string().min(1)),
});
export type KanbanTransitionModel = z.infer<typeof KanbanTransitionModelSchema>;

export const KanbanModelSchema = z.object({
  entity: z.string().min(1),
  title: z.string().min(1),
  /** The enum/status field whose value places a card in a column. */
  stateField: z.string().min(1),
  columns: z.array(KanbanColumnModelSchema).min(1),
  /** The fields shown on each card — redaction-filtered for the viewer. */
  cardFields: z.array(CardFieldModelSchema),
  /** A workflow-transition allow-list a frontend may offer on drag (raw names from the view). */
  allowedTransitions: z.array(z.string().min(1)),
  /** Resolved + RBAC-gated transitions (name + from/to states) the viewer may fire by dragging a card. */
  transitions: z.array(KanbanTransitionModelSchema),
  /** An optional secondary grouping field (omitted when the viewer can't read it). */
  groupBy: z.string().min(1).optional(),
});
export type KanbanModel = z.infer<typeof KanbanModelSchema>;

export const CALENDAR_DEFAULT_VIEWS = ["day", "week", "month", "agenda"] as const;
export type CalendarDefaultView = (typeof CALENDAR_DEFAULT_VIEWS)[number];

export const CalendarModelSchema = z.object({
  entity: z.string().min(1),
  title: z.string().min(1),
  /** The field carrying an event's start instant. */
  startField: z.string().min(1),
  /** The field carrying an event's end instant (omitted when unreadable / absent). */
  endField: z.string().min(1).optional(),
  /** The field rendered as the event's label. */
  titleField: z.string().min(1),
  /** A field whose value drives event color (omitted when unreadable / absent). */
  colorField: z.string().min(1).optional(),
  defaultView: z.enum(CALENDAR_DEFAULT_VIEWS),
});
export type CalendarModel = z.infer<typeof CalendarModelSchema>;

export const MAP_LAYER_KINDS = ["markers", "heatmap", "polygons", "cluster"] as const;
export type MapLayerKind = (typeof MAP_LAYER_KINDS)[number];

export const MapLayerModelSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(MAP_LAYER_KINDS),
});
export type MapLayerModel = z.infer<typeof MapLayerModelSchema>;

export const MapBoundsModelSchema = z.object({
  south: z.number(),
  west: z.number(),
  north: z.number(),
  east: z.number(),
});
export type MapBoundsModel = z.infer<typeof MapBoundsModelSchema>;

export const MapModelSchema = z.object({
  entity: z.string().min(1),
  title: z.string().min(1),
  /** The geo field whose value places a marker. */
  geoField: z.string().min(1),
  /** A field whose value drives marker color (omitted when unreadable / absent). */
  markerColorField: z.string().min(1).optional(),
  /** A field whose value labels a marker (omitted when unreadable / absent). */
  markerLabelField: z.string().min(1).optional(),
  defaultZoom: z.number().int().min(1).max(20),
  layers: z.array(MapLayerModelSchema).min(1),
  bounds: MapBoundsModelSchema.optional(),
});
export type MapModel = z.infer<typeof MapModelSchema>;

export const DASHBOARD_WIDGET_KINDS = [
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
export type DashboardWidgetKind = (typeof DASHBOARD_WIDGET_KINDS)[number];

/** A compiled dashboard widget — the layout descriptor (report execution is out of scope). */
export const DashboardWidgetModelSchema = z.object({
  kind: z.enum(DASHBOARD_WIDGET_KINDS),
  /** The report id a report-backed widget reads (absent for markdown / divider). */
  report: z.string().min(1).optional(),
  /** A widget title (humanized localized label). */
  title: z.string().min(1).optional(),
  /** Markdown body (markdown widgets only). */
  body: z.string().optional(),
  /** Divider label (divider widgets only). */
  label: z.string().min(1).optional(),
});
export type DashboardWidgetModel = z.infer<typeof DashboardWidgetModelSchema>;

export const DashboardCellModelSchema = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  w: z.number().int().positive(),
  h: z.number().int().positive(),
  widget: DashboardWidgetModelSchema,
});
export type DashboardCellModel = z.infer<typeof DashboardCellModelSchema>;

export const DASHBOARD_LAYOUTS = ["grid", "stack"] as const;
export type DashboardLayout = (typeof DASHBOARD_LAYOUTS)[number];

export const DashboardModelSchema = z.object({
  entity: z.string().min(1),
  title: z.string().min(1),
  layout: z.enum(DASHBOARD_LAYOUTS),
  refreshIntervalSeconds: z.number().int().positive(),
  /** The grid cells the viewer may see — a report-backed widget the viewer can't access is dropped. */
  cells: z.array(DashboardCellModelSchema),
});
export type DashboardModel = z.infer<typeof DashboardModelSchema>;

export const EntityNavSchema = z.object({
  entity: z.string().min(1),
  label: z.string().min(1),
  /** Path to the entity's list/table surface, e.g. `/ui/Product`. */
  path: z.string().min(1),
  /** The view kinds available for the entity, derived from the manifest + fallbacks. */
  views: z.array(z.enum(["table", "detail", "form", "kanban", "calendar", "map", "dashboard"])),
});
export type EntityNav = z.infer<typeof EntityNavSchema>;

export const WebAppModelSchema = z.object({
  title: z.string().min(1),
  nav: z.array(EntityNavSchema),
});
export type WebAppModel = z.infer<typeof WebAppModelSchema>;
