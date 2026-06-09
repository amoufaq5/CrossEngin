import type { Manifest } from "@crossengin/kernel/manifest";
import { listConfigForEntity, manifestRouteSpecs, type TransitionSpec } from "@crossengin/operate-runtime";
import type { Entity, Field, FieldType } from "@crossengin/types/meta-schema";

import {
  type CalendarDefaultView,
  type CalendarModel,
  type CardFieldModel,
  type ColumnModel,
  type DetailModel,
  type DetailSectionModel,
  type EntityNav,
  type FieldModel,
  type FormFieldModel,
  type FormMode,
  type FormModel,
  type FormValidation,
  type KanbanColumnModel,
  type KanbanModel,
  type KanbanTransitionModel,
  type DashboardCellModel,
  type DashboardModel,
  type DashboardWidgetKind,
  type DashboardWidgetModel,
  type MapLayerModel,
  type MapModel,
  type RowActionModel,
  type TableModel,
  type TableSort,
  type WebAppModel,
  type WebFieldType,
} from "./model.js";
import {
  EntityFieldResolver,
  entityFields,
  viewerSatisfiesGrant,
  type CompileOptions,
  type FieldAccess,
  type ViewerContext,
} from "./viewer.js";

/** A manifest view (kernel re-exports the views-package discriminated union as JSON-shaped data). */
interface ViewLike {
  readonly kind: string;
  readonly entity: string;
  readonly label?: Readonly<Record<string, string>>;
  readonly pageSize?: number;
  readonly sort?: ReadonlyArray<{ field: string; direction?: "asc" | "desc" }>;
  readonly columns?: ReadonlyArray<{
    field: string;
    label?: Readonly<Record<string, string>>;
    sortable?: boolean;
    filterable?: boolean;
    hidden?: boolean;
  }>;
  readonly sections?: ReadonlyArray<{
    id: string;
    label?: Readonly<Record<string, string>>;
    fields: readonly string[];
  }>;
  readonly steps?: ReadonlyArray<{
    id: string;
    label?: Readonly<Record<string, string>>;
    fields: ReadonlyArray<{
      field: string;
      required?: boolean;
      readOnly?: boolean;
      hidden?: boolean;
    }>;
  }>;
}

const PASCAL_BOUNDARY = /([a-z0-9])([A-Z])/g;

/** `unit_cost` → `Unit cost`, `mrn` → `Mrn`. A humanized fallback when no label is supplied. */
export function humanize(field: string): string {
  const spaced = field.replace(/_/g, " ").trim();
  return spaced.length === 0 ? field : spaced[0]!.toUpperCase() + spaced.slice(1);
}

/** Picks the English-ish label from a localized text map (first value), else the humanized field. */
function labelOr(
  loc: Readonly<Record<string, string>> | undefined,
  field: string,
): string {
  if (loc !== undefined) {
    const en = loc["en"] ?? Object.values(loc)[0];
    if (en !== undefined && en.length > 0) return en;
  }
  return humanize(field);
}

/** `Product` → `Products` (a nav label; spaces inserted at PascalCase boundaries). */
export function entityTitle(entityName: string): string {
  const spaced = entityName.replace(PASCAL_BOUNDARY, "$1 $2");
  return `${spaced}s`;
}

/** Maps a manifest field type to the web render hint. */
export function webFieldType(type: FieldType): WebFieldType {
  return type.kind as WebFieldType;
}

function entityByName(manifest: Manifest, name: string): Entity | undefined {
  return (manifest.entities ?? []).find((e) => e.name === name);
}

function fieldByName(entity: Entity, name: string): Field | undefined {
  return entity.fields.find((f) => f.name === name);
}

function viewsFor(manifest: Manifest): readonly ViewLike[] {
  return Object.values(manifest.views ?? {}) as readonly ViewLike[];
}

function findView(manifest: Manifest, entity: string, kind: string): ViewLike | undefined {
  return viewsFor(manifest).find((v) => v.kind === kind && v.entity === entity);
}

/** The structural shape of a manifest `kanban` view (the views-package KanbanView as JSON data). */
interface KanbanViewLike {
  readonly kind: "kanban";
  readonly entity: string;
  readonly label?: Readonly<Record<string, string>>;
  readonly stateField: string;
  readonly columns: ReadonlyArray<{
    state: string;
    label?: Readonly<Record<string, string>>;
    color?: string;
    wipLimit?: number;
  }>;
  readonly cardFields: readonly string[];
  readonly allowedTransitions?: readonly string[];
  readonly groupBy?: string;
}

/** The structural shape of a manifest `calendar` view (the views-package CalendarView as JSON data). */
interface CalendarViewLike {
  readonly kind: "calendar";
  readonly entity: string;
  readonly label?: Readonly<Record<string, string>>;
  readonly startField: string;
  readonly endField?: string;
  readonly titleField: string;
  readonly colorField?: string;
  readonly defaultView?: CalendarDefaultView;
}

/** The structural shape of a manifest `map` view (the views-package MapView as JSON data). */
interface MapViewLike {
  readonly kind: "map";
  readonly entity: string;
  readonly label?: Readonly<Record<string, string>>;
  readonly geoField: string;
  readonly markerColorField?: string;
  readonly markerLabelField?: string;
  readonly defaultZoom?: number;
  readonly layers: ReadonlyArray<{
    id: string;
    label?: Readonly<Record<string, string>>;
    kind: "markers" | "heatmap" | "polygons" | "cluster";
  }>;
  readonly bounds?: { south: number; west: number; north: number; east: number };
}

function findKanbanView(manifest: Manifest, entity: string): KanbanViewLike | undefined {
  const view = viewsFor(manifest).find((v) => v.kind === "kanban" && v.entity === entity);
  return view as unknown as KanbanViewLike | undefined;
}

function findCalendarView(manifest: Manifest, entity: string): CalendarViewLike | undefined {
  const view = viewsFor(manifest).find((v) => v.kind === "calendar" && v.entity === entity);
  return view as unknown as CalendarViewLike | undefined;
}

function findMapView(manifest: Manifest, entity: string): MapViewLike | undefined {
  const view = viewsFor(manifest).find((v) => v.kind === "map" && v.entity === entity);
  return view as unknown as MapViewLike | undefined;
}

/** The structural shape of a manifest `dashboard` view (carrying the dashboardRef). */
interface DashboardViewLike {
  readonly kind: "dashboard";
  readonly entity: string;
  readonly label?: Readonly<Record<string, string>>;
  readonly dashboardRef: string;
}

/** A grid cell's widget (the views/reporting union flattened to the fields the compiler reads). */
interface WidgetLike {
  readonly kind: DashboardWidgetKind;
  readonly report?: string;
  readonly title?: Readonly<Record<string, string>>;
  readonly body?: Readonly<Record<string, string>>;
  readonly label?: Readonly<Record<string, string>>;
}

/** The structural shape of a `DashboardDeclaration` (manifest.dashboards[ref]). */
interface DashboardDeclLike {
  readonly label?: Readonly<Record<string, string>>;
  readonly layout?: "grid" | "stack";
  readonly refreshIntervalSeconds?: number;
  readonly permissions?: { readonly roles: readonly string[] };
  readonly cells: ReadonlyArray<{ x: number; y: number; w: number; h: number; widget: WidgetLike }>;
}

/** The structural shape of a `ReportDeclaration` (only its optional RBAC grant is read here). */
interface ReportLike {
  readonly permissions?: { readonly roles: readonly string[] };
}

function findDashboardView(manifest: Manifest, entity: string): DashboardViewLike | undefined {
  const view = viewsFor(manifest).find((v) => v.kind === "dashboard" && v.entity === entity);
  return view as unknown as DashboardViewLike | undefined;
}

function dashboardsOf(manifest: Manifest): Readonly<Record<string, DashboardDeclLike>> {
  return (manifest as unknown as { dashboards?: Record<string, DashboardDeclLike> }).dashboards ?? {};
}

function reportsOf(manifest: Manifest): Readonly<Record<string, ReportLike>> {
  return (manifest as unknown as { reports?: Record<string, ReportLike> }).reports ?? {};
}

/** Picks the en-ish value from a localized text map (no humanize fallback). */
function localizedText(loc: Readonly<Record<string, string>> | undefined): string {
  if (loc === undefined) return "";
  return loc["en"] ?? Object.values(loc)[0] ?? "";
}

function readableAccess(
  manifest: Manifest,
  entity: Entity,
  viewer: ViewerContext,
  options: CompileOptions,
): ReadonlyMap<string, FieldAccess> {
  const resolver = new EntityFieldResolver(manifest, entity.name, viewer, options);
  return resolver.resolve(entityFields(entity));
}

/**
 * Compiles an entity's `TableModel` for a viewer. Columns come from the entity's
 * `ListView` when present, else from `listConfigForEntity` (so the table still
 * works without an explicit view). A column the viewer can't read is dropped, so
 * the model never advertises a hidden field.
 */
export function compileTableModel(
  manifest: Manifest,
  entityName: string,
  viewer: ViewerContext,
  options: CompileOptions = {},
): TableModel {
  const entity = entityByName(manifest, entityName);
  if (entity === undefined) throw new Error(`unknown entity '${entityName}'`);
  const access = readableAccess(manifest, entity, viewer, options);
  const view = findView(manifest, entityName, "list");
  const config = listConfigForEntity(manifest, entityName);

  const columnFields = view?.columns?.filter((c) => c.hidden !== true).map((c) => c.field) ??
    entity.fields.map((f) => f.name);

  const columns: ColumnModel[] = [];
  for (const fieldName of columnFields) {
    if (access.get(fieldName)?.read === false) continue;
    const field = fieldByName(entity, fieldName);
    if (field === undefined) continue;
    const viewCol = view?.columns?.find((c) => c.field === fieldName);
    columns.push({
      field: fieldName,
      label: labelOr(viewCol?.label, fieldName),
      type: webFieldType(field.type),
      sortable: viewCol !== undefined ? viewCol.sortable !== false : config.sortableFields.includes(fieldName),
      filterable: viewCol !== undefined ? viewCol.filterable !== false : config.filterableFields.includes(fieldName),
    });
  }

  const defaultSort: TableSort[] = config.defaultSort.map((s) => ({ field: s.field, direction: s.direction }));

  return {
    entity: entityName,
    title: labelOr(view?.label, entityTitle(entityName)),
    columns,
    defaultSort,
    pageSize: config.defaultLimit,
    rowActions: tableRowActions(manifest, entityName),
  };
}

function tableRowActions(manifest: Manifest, entityName: string): RowActionModel[] {
  const detail = findView(manifest, entityName, "record");
  const actions: RowActionModel[] = [];
  if (detail !== undefined) {
    actions.push({ kind: "openRecord", view: `${entityName}.detail` });
  }
  return actions;
}

/**
 * Compiles an entity's `DetailModel` for a viewer (optionally bound to a record's
 * values). Sections come from the entity's `RecordView`; without one, every
 * readable field falls into a single "Details" section. Redacted fields are
 * omitted from every section.
 */
export function compileDetailModel(
  manifest: Manifest,
  entityName: string,
  viewer: ViewerContext,
  record?: Readonly<Record<string, unknown>>,
  options: CompileOptions = {},
): DetailModel {
  const entity = entityByName(manifest, entityName);
  if (entity === undefined) throw new Error(`unknown entity '${entityName}'`);
  const access = readableAccess(manifest, entity, viewer, options);
  const view = findView(manifest, entityName, "record");

  const toField = (fieldName: string): FieldModel | null => {
    if (access.get(fieldName)?.read === false) return null;
    const field = fieldByName(entity, fieldName);
    if (field === undefined) return null;
    const base: FieldModel = {
      field: fieldName,
      label: humanize(fieldName),
      type: webFieldType(field.type),
    };
    return record !== undefined && fieldName in record ? { ...base, value: record[fieldName] } : base;
  };

  const sections: DetailSectionModel[] = [];
  if (view?.sections !== undefined && view.sections.length > 0) {
    for (const section of view.sections) {
      const fields = section.fields.map(toField).filter((f): f is FieldModel => f !== null);
      if (fields.length > 0) {
        sections.push({ title: labelOr(section.label, section.id), fields });
      }
    }
  } else {
    const fields = entity.fields
      .map((f) => toField(f.name))
      .filter((f): f is FieldModel => f !== null);
    sections.push({ title: "Details", fields });
  }

  return {
    entity: entityName,
    title: labelOr(view?.label, entityName),
    sections,
  };
}

function fieldValidations(field: Field): FormValidation[] {
  const out: FormValidation[] = [];
  if (field.required === true) out.push({ kind: "required" });
  if (field.type.kind === "enum") out.push({ kind: "enum", values: [...field.type.values] });
  if (field.type.kind === "integer" || field.type.kind === "decimal") {
    if (field.type.min !== undefined) out.push({ kind: "min", value: field.type.min });
    if (field.type.max !== undefined) out.push({ kind: "max", value: field.type.max });
  }
  for (const rule of field.validations ?? []) {
    if (rule.kind === "regex") out.push({ kind: "regex", pattern: rule.pattern });
  }
  return out;
}

/**
 * Compiles an entity's `FormModel` for a viewer + mode. Fields come from the
 * entity's `FormView` when present, else from every writable field. A field the
 * viewer can't read is dropped; a readable-but-not-writable field is included
 * but marked `readOnly` (so the form shows it without letting the viewer change
 * it).
 */
export function compileFormModel(
  manifest: Manifest,
  entityName: string,
  viewer: ViewerContext,
  mode: FormMode,
  options: CompileOptions = {},
): FormModel {
  const entity = entityByName(manifest, entityName);
  if (entity === undefined) throw new Error(`unknown entity '${entityName}'`);
  const access = readableAccess(manifest, entity, viewer, options);
  const view = findView(manifest, entityName, "form");

  const viewFields = view?.steps?.flatMap((s) => s.fields.filter((f) => f.hidden !== true)) ?? [];
  const formFieldNames = viewFields.length > 0 ? viewFields.map((f) => f.field) : entity.fields.map((f) => f.name);

  const fields: FormFieldModel[] = [];
  for (const fieldName of formFieldNames) {
    const a = access.get(fieldName);
    if (a?.read === false) continue;
    const field = fieldByName(entity, fieldName);
    if (field === undefined) continue;
    const viewField = viewFields.find((f) => f.field === fieldName);
    fields.push({
      field: fieldName,
      label: humanize(fieldName),
      type: webFieldType(field.type),
      required: viewField?.required ?? field.required === true,
      readOnly: viewField?.readOnly === true || a?.write === false,
      validations: fieldValidations(field),
    });
  }

  return {
    entity: entityName,
    mode,
    title: labelOr(view?.label, `${mode === "create" ? "New" : "Edit"} ${entityName}`),
    fields,
  };
}

function cardFieldModels(
  entity: Entity,
  fieldNames: readonly string[],
  access: ReadonlyMap<string, FieldAccess>,
): CardFieldModel[] {
  const out: CardFieldModel[] = [];
  for (const fieldName of fieldNames) {
    if (access.get(fieldName)?.read === false) continue;
    const field = fieldByName(entity, fieldName);
    if (field === undefined) continue;
    out.push({ field: fieldName, label: humanize(fieldName), type: webFieldType(field.type) });
  }
  return out;
}

/**
 * Compiles an entity's `KanbanModel` for a viewer, or `null` when the entity has
 * no `kanban` view (there is no sensible fallback — a board needs a declared
 * state field). Redaction-aware: a card field the viewer can't read is dropped,
 * an unreadable `groupBy` is omitted, and — fail-closed — if the *state field
 * itself* is unreadable the whole board is withheld (returns `null`), since the
 * grouping axis would otherwise leak which column each record sits in.
 */
export function compileKanbanModel(
  manifest: Manifest,
  entityName: string,
  viewer: ViewerContext,
  options: CompileOptions = {},
): KanbanModel | null {
  const entity = entityByName(manifest, entityName);
  if (entity === undefined) throw new Error(`unknown entity '${entityName}'`);
  const view = findKanbanView(manifest, entityName);
  if (view === undefined) return null;
  const access = readableAccess(manifest, entity, viewer, options);
  if (access.get(view.stateField)?.read === false) return null;

  const columns: KanbanColumnModel[] = view.columns.map((c) => ({
    state: c.state,
    label: labelOr(c.label, c.state),
    ...(c.color !== undefined ? { color: c.color } : {}),
    ...(c.wipLimit !== undefined ? { wipLimit: c.wipLimit } : {}),
  }));

  const cardFields = cardFieldModels(entity, view.cardFields, access);
  const groupByReadable = view.groupBy !== undefined && access.get(view.groupBy)?.read !== false;
  const allowedTransitions = [...(view.allowedTransitions ?? [])];
  const transitions = resolveKanbanTransitions(manifest, entity, viewer, allowedTransitions, options);

  return {
    entity: entityName,
    title: labelOr(view.label, entityTitle(entityName)),
    stateField: view.stateField,
    columns,
    cardFields,
    allowedTransitions,
    transitions,
    ...(groupByReadable ? { groupBy: view.groupBy! } : {}),
  };
}

/** The entity's `entityLifecycle` transition specs (via the canonical operate-runtime route specs). */
function entityTransitionSpecs(manifest: Manifest, entityName: string): readonly TransitionSpec[] {
  const out: TransitionSpec[] = [];
  for (const spec of manifestRouteSpecs(manifest)) {
    if (spec.entity === entityName && spec.action === "transition" && spec.transition !== undefined) {
      out.push(spec.transition);
    }
  }
  return out;
}

/**
 * Resolves a kanban view's `allowedTransitions` (names) against the entity's
 * lifecycle, RBAC-gated for the viewer: only a transition the viewer may fire
 * (its per-transition grant) AND whose `toState` matches a declared column lands
 * in the model, so the board only offers a drag the server would authorize.
 */
function resolveKanbanTransitions(
  manifest: Manifest,
  entity: Entity,
  viewer: ViewerContext,
  allowedTransitions: readonly string[],
  options: CompileOptions,
): KanbanTransitionModel[] {
  if (allowedTransitions.length === 0) return [];
  const allowed = new Set(allowedTransitions);
  const resolver = new EntityFieldResolver(manifest, entity.name, viewer, options);
  const out: KanbanTransitionModel[] = [];
  for (const spec of entityTransitionSpecs(manifest, entity.name)) {
    if (!allowed.has(spec.name)) continue;
    if (!resolver.canTransition(spec.name).allowed) continue;
    out.push({ name: spec.name, toState: spec.toState, fromStates: [...spec.fromStates] });
  }
  return out;
}

/**
 * Compiles an entity's `CalendarModel` for a viewer, or `null` when the entity
 * has no `calendar` view (a calendar needs a declared start + title field).
 * Redaction-aware: an unreadable `endField` / `colorField` is omitted, and —
 * fail-closed — if the `startField` or `titleField` is unreadable the calendar
 * is withheld (returns `null`).
 */
export function compileCalendarModel(
  manifest: Manifest,
  entityName: string,
  viewer: ViewerContext,
  options: CompileOptions = {},
): CalendarModel | null {
  const entity = entityByName(manifest, entityName);
  if (entity === undefined) throw new Error(`unknown entity '${entityName}'`);
  const view = findCalendarView(manifest, entityName);
  if (view === undefined) return null;
  const access = readableAccess(manifest, entity, viewer, options);
  if (access.get(view.startField)?.read === false) return null;
  if (access.get(view.titleField)?.read === false) return null;

  const endReadable = view.endField !== undefined && access.get(view.endField)?.read !== false;
  const colorReadable = view.colorField !== undefined && access.get(view.colorField)?.read !== false;

  return {
    entity: entityName,
    title: labelOr(view.label, entityTitle(entityName)),
    startField: view.startField,
    ...(endReadable ? { endField: view.endField! } : {}),
    titleField: view.titleField,
    ...(colorReadable ? { colorField: view.colorField! } : {}),
    defaultView: view.defaultView ?? "week",
  };
}

/**
 * Compiles an entity's `MapModel` for a viewer, or `null` when the entity has no
 * `map` view (no fallback — a map needs a declared geo field). Redaction-aware +
 * fail-closed: if the `geoField` is unreadable the whole map is withheld (`null`,
 * since the marker *position* would leak), an unreadable `markerColorField` /
 * `markerLabelField` is omitted, and `defaultZoom` / `layers` / `bounds` are
 * carried through (layer labels humanized).
 */
export function compileMapModel(
  manifest: Manifest,
  entityName: string,
  viewer: ViewerContext,
  options: CompileOptions = {},
): MapModel | null {
  const entity = entityByName(manifest, entityName);
  if (entity === undefined) throw new Error(`unknown entity '${entityName}'`);
  const view = findMapView(manifest, entityName);
  if (view === undefined) return null;
  const access = readableAccess(manifest, entity, viewer, options);
  if (access.get(view.geoField)?.read === false) return null;

  const colorReadable = view.markerColorField !== undefined && access.get(view.markerColorField)?.read !== false;
  const labelReadable = view.markerLabelField !== undefined && access.get(view.markerLabelField)?.read !== false;
  const layers: MapLayerModel[] = view.layers.map((l) => ({
    id: l.id,
    label: labelOr(l.label, l.id),
    kind: l.kind,
  }));

  return {
    entity: entityName,
    title: labelOr(view.label, entityTitle(entityName)),
    geoField: view.geoField,
    ...(colorReadable ? { markerColorField: view.markerColorField! } : {}),
    ...(labelReadable ? { markerLabelField: view.markerLabelField! } : {}),
    defaultZoom: view.defaultZoom ?? 10,
    layers,
    ...(view.bounds !== undefined ? { bounds: view.bounds } : {}),
  };
}

/**
 * Compiles an entity's `DashboardModel` for a viewer, or `null` when the entity
 * declares no `dashboard` view / the referenced dashboard is missing (no
 * fallback). Redaction is grant-based + fail-closed: a dashboard whose
 * `permissions` the viewer doesn't satisfy is withheld entirely (`null`), and a
 * report-backed widget whose report's `permissions` the viewer lacks is dropped
 * from the cell list (markdown / divider widgets always render). The model is the
 * grid *layout* + widget descriptors; report-data execution is out of scope, so
 * no entity rows are fetched here.
 */
export function compileDashboardModel(
  manifest: Manifest,
  entityName: string,
  viewer: ViewerContext,
): DashboardModel | null {
  const entity = entityByName(manifest, entityName);
  if (entity === undefined) throw new Error(`unknown entity '${entityName}'`);
  const view = findDashboardView(manifest, entityName);
  if (view === undefined) return null;
  const dash = dashboardsOf(manifest)[view.dashboardRef];
  if (dash === undefined) return null;
  if (!viewerSatisfiesGrant(manifest, viewer, dash.permissions)) return null;

  const reports = reportsOf(manifest);
  const cells: DashboardCellModel[] = [];
  for (const cell of dash.cells) {
    const w = cell.widget;
    if (w.report !== undefined) {
      const report = reports[w.report];
      if (report !== undefined && !viewerSatisfiesGrant(manifest, viewer, report.permissions)) {
        continue; // the viewer can't see this report — drop the widget
      }
    }
    const widget: DashboardWidgetModel = {
      kind: w.kind,
      ...(w.report !== undefined ? { report: w.report } : {}),
      ...(w.title !== undefined ? { title: localizedText(w.title) || w.kind } : {}),
      ...(w.body !== undefined ? { body: localizedText(w.body) } : {}),
      ...(w.label !== undefined ? { label: localizedText(w.label) || w.kind } : {}),
    };
    cells.push({ x: cell.x, y: cell.y, w: cell.w, h: cell.h, widget });
  }

  return {
    entity: entityName,
    title: labelOr(view.label ?? dash.label, entityTitle(entityName)),
    layout: dash.layout ?? "grid",
    refreshIntervalSeconds: dash.refreshIntervalSeconds ?? 60,
    cells,
  };
}

/**
 * Compiles the top-level `WebAppModel` for a viewer: the app title + one
 * `EntityNav` per manifest entity (with its table path + available view kinds).
 * The `table`/`detail`/`form` surfaces always exist (via fallbacks); `kanban` /
 * `calendar` / `map` appear only when the entity declares such a view *and* it
 * compiles for this viewer (so a view withheld for redaction never shows in the
 * nav). Entities are listed in manifest order.
 */
export function compileWebApp(manifest: Manifest, viewer: ViewerContext): WebAppModel {
  const nav: EntityNav[] = [];
  for (const entity of manifest.entities ?? []) {
    const views: Array<"table" | "detail" | "form" | "kanban" | "calendar" | "map" | "dashboard"> = ["table", "detail", "form"];
    if (compileKanbanModel(manifest, entity.name, viewer) !== null) views.push("kanban");
    if (compileCalendarModel(manifest, entity.name, viewer) !== null) views.push("calendar");
    if (compileMapModel(manifest, entity.name, viewer) !== null) views.push("map");
    if (compileDashboardModel(manifest, entity.name, viewer) !== null) views.push("dashboard");
    nav.push({
      entity: entity.name,
      label: labelOr(findView(manifest, entity.name, "list")?.label, entityTitle(entity.name)),
      path: `/ui/${entity.name}`,
      views,
    });
  }
  return {
    title: manifest.meta.name,
    nav,
  };
}
