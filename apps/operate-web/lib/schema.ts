"use client";

import { useEffect, useState } from "react";

export type UiInputType =
  | "text"
  | "textarea"
  | "email"
  | "number"
  | "boolean"
  | "date"
  | "datetime"
  | "select"
  | "reference";

export interface UiFieldSchema {
  readonly name: string;
  readonly label: string;
  readonly input: UiInputType;
  readonly required: boolean;
  readonly enumValues?: readonly string[];
  readonly referenceTarget?: string;
  readonly classification?: string;
  readonly unique?: boolean;
  readonly readOnly?: boolean;
}

export interface UiTransitionSchema {
  readonly name: string;
  readonly label: string;
  readonly operationId: string;
  readonly stateField: string;
  readonly from: readonly string[];
  readonly to: string;
  readonly roles: readonly string[];
}

export interface UiEntityAccess {
  readonly list: readonly string[];
  readonly read: readonly string[];
  readonly create: readonly string[];
  readonly update: readonly string[];
  readonly delete: readonly string[];
}

export interface UiEntitySchema {
  readonly name: string;
  readonly slug: string;
  readonly label: string;
  readonly singular: string;
  readonly module: string;
  readonly access: UiEntityAccess;
  readonly fields: readonly UiFieldSchema[];
  readonly listColumns: readonly string[];
  readonly sortableFields: readonly string[];
  readonly filterableFields: readonly string[];
  readonly stateField: string | null;
  readonly transitions: readonly UiTransitionSchema[];
  readonly operationIds: Record<"list" | "read" | "create" | "update" | "delete", string>;
}

export interface UiRoleSchema {
  readonly name: string;
  readonly label: string;
  readonly description?: string;
}

export interface UiViewer {
  readonly primaryRole: string;
  readonly roles: readonly string[];
}

export interface UiFormatting {
  readonly currency?: string;
  readonly locale?: string;
  readonly dateFormat?: string;
  readonly numberFormat?: string;
  readonly weekStartDay?: number;
}

export interface UiSchema {
  readonly entities: readonly UiEntitySchema[];
  readonly roles: readonly UiRoleSchema[];
  readonly generatedAt: string;
  readonly viewer?: UiViewer;
  readonly formatting?: UiFormatting;
  readonly features?: Readonly<Record<string, boolean>>;
}

let cache: UiSchema | null = null;
let inflight: Promise<UiSchema> | null = null;

/** Module-level mirror of the tenant's formatting, so pure formatters can read it. */
let activeFormatting: UiFormatting = {};

export function getActiveFormatting(): UiFormatting {
  return activeFormatting;
}

export async function fetchSchema(): Promise<UiSchema> {
  if (cache !== null) return cache;
  if (inflight !== null) return inflight;
  inflight = (async () => {
    const res = await fetch("/api/v1/meta/schema", { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`schema ${res.status}: ${await res.text().catch(() => res.statusText)}`);
    const schema = (await res.json()) as UiSchema;
    cache = schema;
    activeFormatting = schema.formatting ?? {};
    return schema;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

export interface SchemaState {
  readonly schema: UiSchema | null;
  readonly loading: boolean;
  readonly error: string | null;
}

export function useSchema(): SchemaState {
  const [schema, setSchema] = useState<UiSchema | null>(cache);
  const [loading, setLoading] = useState(cache === null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (cache !== null) {
      setSchema(cache);
      setLoading(false);
      return;
    }
    let alive = true;
    fetchSchema()
      .then((s) => {
        if (alive) {
          setSchema(s);
          setLoading(false);
        }
      })
      .catch((e: unknown) => {
        if (alive) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  return { schema, loading, error };
}

export function entityBySlug(schema: UiSchema | null, slug: string): UiEntitySchema | undefined {
  return schema?.entities.find((e) => e.slug === slug);
}

export function entityByName(schema: UiSchema | null, name: string): UiEntitySchema | undefined {
  return schema?.entities.find((e) => e.name === name);
}

/** A reference field's value points at another entity; resolve its slug for deep links. */
export function slugForEntityName(schema: UiSchema | null, name: string): string | undefined {
  return entityByName(schema, name)?.slug;
}

/** Preferred department display order; anything else sorts after, alphabetically. */
export const DEPARTMENT_ORDER: readonly string[] = [
  "Sales & CRM",
  "Finance",
  "Accounting & GL",
  "Procurement",
  "Supply Chain & Inventory",
  "Manufacturing",
  "Projects & Services",
  "Assets & Maintenance",
  "Pricing & Tax",
  "Human Resources",
  "Clinical",
  "General",
];

// ---- Role-based access -------------------------------------------------------

export type AccessOp = "list" | "read" | "create" | "update" | "delete";

/** The roles the current viewer holds; empty when unauthenticated (dev fallback → show all). */
export function viewerRoles(schema: UiSchema | null): readonly string[] {
  return schema?.viewer?.roles ?? [];
}

function intersects(a: readonly string[], b: readonly string[]): boolean {
  return a.some((x) => b.includes(x));
}

/** Can the viewer perform `op` on this entity? With no viewer (dev mode), everything is visible. */
export function canAccess(schema: UiSchema | null, entity: UiEntitySchema, op: AccessOp = "read"): boolean {
  const roles = viewerRoles(schema);
  if (roles.length === 0) return true;
  return intersects(roles, entity.access[op]);
}

/** Entities the viewer may at least read, preserving schema order. */
export function accessibleEntities(schema: UiSchema | null): readonly UiEntitySchema[] {
  if (schema === null) return [];
  return schema.entities.filter((e) => canAccess(schema, e, "read") || canAccess(schema, e, "list"));
}

/** Lifecycle transitions the viewer's role may fire, across all readable entities. */
export interface ViewerAction {
  readonly entity: UiEntitySchema;
  readonly transition: UiTransitionSchema;
}

export function viewerActions(schema: UiSchema | null): readonly ViewerAction[] {
  const roles = viewerRoles(schema);
  const out: ViewerAction[] = [];
  for (const e of accessibleEntities(schema)) {
    for (const t of e.transitions) {
      if (roles.length === 0 || intersects(roles, t.roles)) out.push({ entity: e, transition: t });
    }
  }
  return out;
}

/** A feature flag's state, defaulting to `fallback` when the tenant hasn't set it. */
export function featureEnabled(schema: UiSchema | null, key: string, fallback = true): boolean {
  const v = schema?.features?.[key];
  return v === undefined ? fallback : v;
}

export function roleLabel(schema: UiSchema | null, name: string): string {
  const r = schema?.roles.find((x) => x.name === name);
  return r?.label ?? name.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** An entity the viewer can advance, plus the states from which they can act. */
export interface InboxEntitySpec {
  readonly entity: UiEntitySchema;
  readonly transitions: readonly UiTransitionSchema[];
  readonly fromStates: readonly string[];
}

/** Entities with at least one lifecycle transition the viewer's role may fire. */
export function inboxEntitySpecs(schema: UiSchema | null): readonly InboxEntitySpec[] {
  const roles = viewerRoles(schema);
  const byEntity = new Map<string, { entity: UiEntitySchema; transitions: UiTransitionSchema[] }>();
  for (const { entity, transition } of viewerActions(schema)) {
    if (entity.stateField === null) continue;
    const slot = byEntity.get(entity.name) ?? { entity, transitions: [] };
    slot.transitions.push(transition);
    byEntity.set(entity.name, slot);
  }
  return [...byEntity.values()].map(({ entity, transitions }) => ({
    entity,
    transitions,
    fromStates: [...new Set(transitions.flatMap((t) => [...t.from]))],
  }));
}

/** Transitions the viewer may fire on a record currently in `state`. */
export function actionsForState(
  spec: InboxEntitySpec,
  state: string,
): readonly UiTransitionSchema[] {
  return spec.transitions.filter((t) => t.from.includes(state));
}

/** Best human label for a record: a name/number/code/title, falling back to id. */
export function recordLabel(entity: UiEntitySchema, record: Record<string, unknown>): string {
  const prefer = ["name", "title", `${entity.name.toLowerCase()}_number`];
  for (const key of prefer) {
    const v = record[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  for (const f of entity.fields) {
    if (/(_number$|^code$|_code$|^sku$|^title$|^name$)/.test(f.name)) {
      const v = record[f.name];
      if (typeof v === "string" && v.length > 0) return v;
    }
  }
  return String(record["id"] ?? "—");
}

export interface DepartmentGroup {
  readonly module: string;
  readonly entities: readonly UiEntitySchema[];
}

/** Groups entities by their `module`, ordered by DEPARTMENT_ORDER then alphabetically. */
export function groupByModule(entities: readonly UiEntitySchema[]): readonly DepartmentGroup[] {
  const byModule = new Map<string, UiEntitySchema[]>();
  for (const e of entities) {
    const list = byModule.get(e.module) ?? [];
    list.push(e);
    byModule.set(e.module, list);
  }
  const rank = (m: string): number => {
    const i = DEPARTMENT_ORDER.indexOf(m);
    return i === -1 ? DEPARTMENT_ORDER.length : i;
  };
  return [...byModule.entries()]
    .map(([module, list]) => ({ module, entities: [...list].sort((a, b) => a.label.localeCompare(b.label)) }))
    .sort((a, b) => rank(a.module) - rank(b.module) || a.module.localeCompare(b.module));
}
