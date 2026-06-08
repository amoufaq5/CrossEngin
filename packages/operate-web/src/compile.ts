import type { Manifest } from "@crossengin/kernel/manifest";
import { listConfigForEntity } from "@crossengin/operate-runtime";
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
  type RowActionModel,
  type TableModel,
  type TableSort,
  type WebAppModel,
  type WebFieldType,
} from "./model.js";
import {
  EntityFieldResolver,
  entityFields,
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

function findKanbanView(manifest: Manifest, entity: string): KanbanViewLike | undefined {
  const view = viewsFor(manifest).find((v) => v.kind === "kanban" && v.entity === entity);
  return view as unknown as KanbanViewLike | undefined;
}

function findCalendarView(manifest: Manifest, entity: string): CalendarViewLike | undefined {
  const view = viewsFor(manifest).find((v) => v.kind === "calendar" && v.entity === entity);
  return view as unknown as CalendarViewLike | undefined;
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

  return {
    entity: entityName,
    title: labelOr(view.label, entityTitle(entityName)),
    stateField: view.stateField,
    columns,
    cardFields,
    allowedTransitions: [...(view.allowedTransitions ?? [])],
    ...(groupByReadable ? { groupBy: view.groupBy! } : {}),
  };
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
 * Compiles the top-level `WebAppModel` for a viewer: the app title + one
 * `EntityNav` per manifest entity (with its table path + available view kinds).
 * The `table`/`detail`/`form` surfaces always exist (via fallbacks); `kanban` /
 * `calendar` appear only when the entity declares such a view *and* it compiles
 * for this viewer (so a board withheld for redaction never shows in the nav).
 * Entities are listed in manifest order.
 */
export function compileWebApp(manifest: Manifest, viewer: ViewerContext): WebAppModel {
  const nav: EntityNav[] = [];
  for (const entity of manifest.entities ?? []) {
    const views: Array<"table" | "detail" | "form" | "kanban" | "calendar"> = ["table", "detail", "form"];
    if (compileKanbanModel(manifest, entity.name, viewer) !== null) views.push("kanban");
    if (compileCalendarModel(manifest, entity.name, viewer) !== null) views.push("calendar");
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
