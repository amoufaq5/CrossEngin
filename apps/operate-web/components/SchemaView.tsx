"use client";

import { useState } from "react";

export interface FieldView {
  readonly name: string;
  readonly kind: string;
  readonly type: string;
  readonly required: boolean;
  readonly classification: string | null;
  readonly sensitive: boolean;
  readonly referenceTarget: string | null;
}

export interface PermissionView {
  readonly operation: string;
  readonly roles: ReadonlyArray<string>;
}

export interface StateView {
  readonly name: string;
  readonly label: string;
  readonly category: string | null;
}

export interface TransitionView {
  readonly name: string;
  readonly from: ReadonlyArray<string>;
  readonly to: string;
}

export interface LifecycleView {
  readonly stateField: string | null;
  readonly initialState: string | null;
  readonly states: ReadonlyArray<StateView>;
  readonly transitions: ReadonlyArray<TransitionView>;
}

export interface EntityView {
  readonly name: string;
  readonly label: string;
  readonly traits: ReadonlyArray<string>;
  readonly auditable: boolean;
  readonly fields: ReadonlyArray<FieldView>;
  readonly permissions: ReadonlyArray<PermissionView>;
  readonly lifecycle: LifecycleView | null;
}

export interface RelationView {
  readonly kind: string;
  readonly from: string;
  readonly to: string;
  readonly field: string | null;
  readonly onDelete: string | null;
}

export interface RoleView {
  readonly name: string;
  readonly label: string;
  readonly description: string | null;
  readonly grantCount: number;
}

export interface ManifestMetaView {
  readonly name: string | null;
  readonly slug: string | null;
  readonly version: string | null;
  readonly description: string | null;
}

export interface ManifestCountsView {
  readonly entities: number;
  readonly fields: number;
  readonly roles: number;
  readonly relations: number;
  readonly sensitiveFields: number;
  readonly lifecycles: number;
}

export interface ManifestView {
  readonly meta: ManifestMetaView;
  readonly entities: ReadonlyArray<EntityView>;
  readonly relations: ReadonlyArray<RelationView>;
  readonly roles: ReadonlyArray<RoleView>;
  readonly counts: ManifestCountsView;
}

/** Entities stay expanded only while the whole schema still fits on a screen. */
const AUTO_EXPAND_MAX_ENTITIES = 3;

const BRAND_CLASSIFICATIONS: ReadonlyArray<string> = ["phi", "regulated"];
const AMBER_CLASSIFICATIONS: ReadonlyArray<string> = ["pii", "commercial_sensitive"];

function classificationChip(classification: string): string {
  if (BRAND_CLASSIFICATIONS.includes(classification)) {
    return "bg-brand text-white ring-1 ring-brand-700";
  }
  if (AMBER_CLASSIFICATIONS.includes(classification)) {
    return "bg-amber-50 text-amber-700 ring-1 ring-amber-600/30";
  }
  return "bg-surface-sunken text-ink-muted ring-1 ring-line";
}

/**
 * The projector already renders a reference type as "reference → Target"; the
 * target gets its own inline link-ish cell, so drop the duplicated suffix.
 */
function typeLabel(field: FieldView): string {
  if (field.referenceTarget === null) return field.type;
  const arrow = field.type.indexOf("→");
  return arrow === -1 ? field.type : field.type.slice(0, arrow).trim();
}

export function SchemaView({ schema }: { schema: ManifestView }) {
  const [open, setOpen] = useState<Readonly<Record<string, boolean>>>(() => {
    const expanded = schema.entities.length <= AUTO_EXPAND_MAX_ENTITIES;
    const initial: Record<string, boolean> = {};
    for (const entity of schema.entities) initial[entity.name] = expanded;
    return initial;
  });

  const openCount = schema.entities.filter((e) => open[e.name] === true).length;
  const allOpen = openCount === schema.entities.length && schema.entities.length > 0;

  function toggle(name: string) {
    setOpen((prev) => ({ ...prev, [name]: prev[name] !== true }));
  }

  function setAll(value: boolean) {
    const next: Record<string, boolean> = {};
    for (const entity of schema.entities) next[entity.name] = value;
    setOpen(next);
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <CountPill label="Entities" value={schema.counts.entities} />
        <CountPill label="Fields" value={schema.counts.fields} />
        <CountPill label="Roles" value={schema.counts.roles} />
        <CountPill label="Relations" value={schema.counts.relations} />
        <CountPill
          label="Sensitive fields"
          value={schema.counts.sensitiveFields}
          accent={schema.counts.sensitiveFields > 0}
        />
        <CountPill label="Lifecycles" value={schema.counts.lifecycles} />
      </div>

      {(schema.meta.name !== null ||
        schema.meta.slug !== null ||
        schema.meta.version !== null ||
        schema.meta.description !== null) && (
        <div className="rounded-xl border border-line bg-surface-soft px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            {schema.meta.name !== null && (
              <span className="text-sm font-bold text-ink">{schema.meta.name}</span>
            )}
            {schema.meta.slug !== null && <span className="chip font-mono">{schema.meta.slug}</span>}
            {schema.meta.version !== null && <span className="chip">v{schema.meta.version}</span>}
          </div>
          {schema.meta.description !== null && (
            <p className="mt-1 text-sm text-ink-muted">{schema.meta.description}</p>
          )}
        </div>
      )}

      <div>
        <div className="mb-2 flex flex-wrap items-center gap-3">
          <div className="label mb-0">Entities</div>
          {schema.entities.length > 1 && (
            <button
              type="button"
              onClick={() => setAll(!allOpen)}
              className="text-xs font-semibold text-brand-600 hover:text-brand-700"
            >
              {allOpen ? "Collapse all" : "Expand all"}
            </button>
          )}
        </div>

        {schema.entities.length === 0 ? (
          <p className="text-sm text-ink-muted">This design declares no entities.</p>
        ) : (
          <div className="space-y-3">
            {schema.entities.map((entity) => (
              <EntityBlock
                key={entity.name}
                entity={entity}
                open={open[entity.name] === true}
                onToggle={() => toggle(entity.name)}
              />
            ))}
          </div>
        )}
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <RelationsSection relations={schema.relations} />
        <RolesSection roles={schema.roles} />
      </div>
    </div>
  );
}

function EntityBlock({
  entity,
  open,
  onToggle,
}: {
  entity: EntityView;
  open: boolean;
  onToggle: () => void;
}) {
  const sensitive = entity.fields.filter((f) => f.sensitive).length;

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-white">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full flex-wrap items-center gap-2 px-4 py-3 text-left hover:bg-surface-soft"
      >
        <span aria-hidden className="text-xs font-bold text-ink-faint">
          {open ? "▾" : "▸"}
        </span>
        <span className="text-sm font-bold text-ink">{entity.label}</span>
        <span className="font-mono text-xs text-ink-faint">{entity.name}</span>
        {entity.auditable && (
          <span className="inline-flex items-center rounded-md bg-surface-sunken px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-ink-muted">
            auditable
          </span>
        )}
        {entity.lifecycle !== null && <span className="chip">lifecycle</span>}
        <span className="ml-auto flex flex-wrap items-center gap-2">
          {sensitive > 0 && (
            <span className="inline-flex items-center rounded-md bg-brand-50 px-2 py-0.5 text-[11px] font-bold text-brand-700">
              {sensitive} sensitive
            </span>
          )}
          <span className="text-xs text-ink-faint">
            {entity.fields.length} {entity.fields.length === 1 ? "field" : "fields"}
          </span>
        </span>
      </button>

      {open && (
        <div className="space-y-4 border-t border-line px-4 py-4">
          <FieldsTable fields={entity.fields} />
          <PermissionMatrix permissions={entity.permissions} />
          {entity.lifecycle !== null && <LifecyclePanel lifecycle={entity.lifecycle} />}
          {entity.traits.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
                Traits
              </span>
              {entity.traits.map((t) => (
                <span key={t} className="chip font-mono">
                  {t}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FieldsTable({ fields }: { fields: ReadonlyArray<FieldView> }) {
  if (fields.length === 0) {
    return <p className="text-sm text-ink-muted">No fields declared.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="data-table">
        <thead>
          <tr>
            <th>Field</th>
            <th>Type</th>
            <th>Required</th>
            <th>Classification</th>
          </tr>
        </thead>
        <tbody>
          {fields.map((f) => (
            <tr key={f.name}>
              <td className="whitespace-nowrap font-mono text-xs font-semibold text-ink">{f.name}</td>
              <td className="whitespace-nowrap">
                <span className="text-ink-muted">{typeLabel(f)}</span>
                {f.referenceTarget !== null && (
                  <span className="ml-2 font-mono text-xs font-semibold text-brand-600">
                    → {f.referenceTarget}
                  </span>
                )}
              </td>
              <td className="whitespace-nowrap">
                {f.required ? (
                  <span className="text-[11px] font-bold uppercase tracking-wide text-ink">
                    required
                  </span>
                ) : (
                  <span className="text-ink-faint">—</span>
                )}
              </td>
              <td className="whitespace-nowrap">
                {f.classification === null ? (
                  <span className="text-ink-faint">—</span>
                ) : (
                  <span
                    className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-bold ${classificationChip(f.classification)}`}
                  >
                    {f.classification}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PermissionMatrix({ permissions }: { permissions: ReadonlyArray<PermissionView> }) {
  if (permissions.length === 0) return null;
  return (
    <div>
      <div className="label">Permissions</div>
      <div className="overflow-x-auto">
        <div className="flex min-w-max gap-2">
          {permissions.map((p) => (
            <div
              key={p.operation}
              className={`min-w-[9rem] rounded-lg border px-3 py-2 ${
                p.roles.length === 0 ? "border-dashed border-line bg-surface-soft" : "border-line bg-white"
              }`}
            >
              <div className="text-[11px] font-bold uppercase tracking-wide text-ink-muted">
                {p.operation}
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                {p.roles.length === 0 ? (
                  <span className="text-xs font-medium text-ink-faint">— no roles</span>
                ) : (
                  p.roles.map((r) => (
                    <span key={r} className="chip font-mono">
                      {r}
                    </span>
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function LifecyclePanel({ lifecycle }: { lifecycle: LifecycleView }) {
  return (
    <div>
      <div className="label">
        Lifecycle
        {lifecycle.stateField !== null && (
          <span className="ml-2 font-mono text-[11px] font-medium normal-case tracking-normal text-ink-faint">
            {lifecycle.stateField}
          </span>
        )}
      </div>
      <div className="rounded-lg border border-line bg-surface-soft px-3 py-2.5">
        <div className="overflow-x-auto">
          <div className="flex min-w-max flex-wrap items-center gap-1.5">
            {lifecycle.states.map((s) => {
              const initial = s.name === lifecycle.initialState;
              return (
                <span
                  key={s.name}
                  title={s.category ?? undefined}
                  className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-semibold ${
                    initial
                      ? "bg-brand text-white ring-1 ring-brand-700"
                      : "bg-white text-ink-muted ring-1 ring-line"
                  }`}
                >
                  {s.label}
                  {initial && <span className="text-[10px] font-bold uppercase opacity-80">initial</span>}
                </span>
              );
            })}
            {lifecycle.states.length === 0 && (
              <span className="text-xs text-ink-faint">No states declared.</span>
            )}
          </div>
        </div>

        {lifecycle.transitions.length > 0 && (
          <ul className="mt-2 space-y-1">
            {lifecycle.transitions.map((t) => (
              <li key={t.name} className="flex flex-wrap items-baseline gap-2 text-xs">
                <span className="font-mono font-semibold text-ink">{t.name}</span>
                <span className="text-ink-muted">
                  {t.from.length === 0 ? "any" : t.from.join(" | ")}{" "}
                  <span className="text-brand-600">→</span> {t.to === "" ? "—" : t.to}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function RelationsSection({ relations }: { relations: ReadonlyArray<RelationView> }) {
  return (
    <div>
      <div className="label">Relations</div>
      {relations.length === 0 ? (
        <p className="text-sm text-ink-muted">No relations declared.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="data-table">
            <thead>
              <tr>
                <th>Relation</th>
                <th>Kind</th>
                <th>Field</th>
                <th>On delete</th>
              </tr>
            </thead>
            <tbody>
              {relations.map((r, i) => (
                <tr key={`${r.from}-${r.to}-${r.field ?? ""}-${i}`}>
                  <td className="whitespace-nowrap font-mono text-xs font-semibold text-ink">
                    {r.from} <span className="text-brand-600">→</span> {r.to}
                  </td>
                  <td className="whitespace-nowrap text-ink-muted">{r.kind || "—"}</td>
                  <td className="whitespace-nowrap font-mono text-xs text-ink-muted">
                    {r.field ?? "—"}
                  </td>
                  <td className="whitespace-nowrap text-ink-muted">{r.onDelete ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function RolesSection({ roles }: { roles: ReadonlyArray<RoleView> }) {
  return (
    <div>
      <div className="label">Roles</div>
      {roles.length === 0 ? (
        <p className="text-sm text-ink-muted">No roles declared.</p>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {roles.map((r) => (
            <li key={r.name} className="flex flex-wrap items-baseline gap-2 px-3 py-2">
              <span className="text-sm font-semibold text-ink">{r.label}</span>
              <span className="font-mono text-xs text-ink-faint">{r.name}</span>
              <span className="ml-auto chip">
                {r.grantCount} {r.grantCount === 1 ? "grant" : "grants"}
              </span>
              {r.description !== null && (
                <p className="w-full text-xs text-ink-muted">{r.description}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CountPill({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div
      className={`rounded-lg border px-3 py-1.5 ${
        accent ? "border-brand-200 bg-brand-50" : "border-line bg-surface-soft"
      }`}
    >
      <div className={`text-sm font-black ${accent ? "text-brand-700" : "text-ink"}`}>
        {value.toLocaleString()}
      </div>
      <div className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">{label}</div>
    </div>
  );
}
