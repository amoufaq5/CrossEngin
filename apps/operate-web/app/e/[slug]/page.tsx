"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/Badge";
import { FieldInput } from "@/components/FieldInput";
import { Topbar } from "@/components/Topbar";
import { createRecord, listRecords, type ListResult } from "@/lib/api";
import { formatCell } from "@/lib/format";
import { entityBySlug, slugForEntityName, useSchema, type UiEntitySchema, type UiFieldSchema } from "@/lib/schema";

function cellKind(field: UiFieldSchema | undefined): string | undefined {
  if (field === undefined) return undefined;
  if (field.input === "select") return "badge";
  if (field.input === "date" || field.input === "datetime") return "date";
  if (field.input === "number" && /(total|amount|price|cost|subtotal|tax|budget|salary)/.test(field.name)) return "money";
  if (field.input === "email") return "email";
  return undefined;
}

export default function EntityListPage({ params }: { params: { slug: string } }) {
  const { schema, loading } = useSchema();
  const entity = entityBySlug(schema, params.slug);

  if (loading) return <Shell title="Loading…" />;
  if (entity === undefined) return <Shell title="Unknown entity" note={`No entity for "/e/${params.slug}".`} />;
  return <EntityList key={entity.slug} entity={entity} />;
}

function Shell({ title, note }: { title: string; note?: string }) {
  return (
    <>
      <Topbar title={title} />
      <div className="px-8 py-6 text-sm text-ink-muted">{note ?? "Loading…"}</div>
    </>
  );
}

function EntityList({ entity }: { entity: UiEntitySchema }) {
  const { schema } = useSchema();
  const [result, setResult] = useState<ListResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ field: string; order: "asc" | "desc" } | null>(null);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [showNew, setShowNew] = useState(false);

  const fieldByName = useMemo(() => {
    const m = new Map<string, UiFieldSchema>();
    for (const f of entity.fields) m.set(f.name, f);
    return m;
  }, [entity]);

  const query = useMemo(() => {
    const p = new URLSearchParams();
    p.set("limit", "50");
    if (sort) {
      p.set("sort", sort.field);
      p.set("order", sort.order);
    }
    for (const [k, v] of Object.entries(filters)) if (v.trim() !== "") p.set(k, v.trim());
    const s = p.toString();
    return s === "" ? "" : `?${s}`;
  }, [sort, filters]);

  const load = useCallback(() => {
    setBusy(true);
    listRecords(entity.slug, query)
      .then((r) => {
        setResult(r);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  }, [entity.slug, query]);

  useEffect(() => load(), [load]);

  const rows = useMemo(() => {
    const data = result?.data ?? [];
    const needle = q.trim().toLowerCase();
    if (needle === "") return data;
    return data.filter((row) =>
      entity.listColumns.some((c) => String(row[c] ?? "").toLowerCase().includes(needle)),
    );
  }, [result, q, entity.listColumns]);

  function toggleSort(field: string) {
    if (!entity.sortableFields.includes(field)) return;
    setSort((prev) =>
      prev?.field === field ? { field, order: prev.order === "asc" ? "desc" : "asc" } : { field, order: "asc" },
    );
  }

  return (
    <>
      <Topbar title={entity.label} subtitle={`${entity.fields.length} fields · ${entity.slug}`} />
      <div className="px-8 py-6">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={`Search ${entity.label.toLowerCase()}…`}
            className="w-64 rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-brand"
          />
          {entity.filterableFields.slice(0, 3).map((f) => (
            <FilterControl
              key={f}
              field={fieldByName.get(f)}
              value={filters[f] ?? ""}
              onChange={(v) => setFilters((prev) => ({ ...prev, [f]: v }))}
            />
          ))}
          <button onClick={load} className="rounded-lg border border-line px-3 py-2 text-sm text-ink-muted hover:bg-surface-soft">
            Refresh
          </button>
          <button
            onClick={() => setShowNew((s) => !s)}
            className="ml-auto rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600"
          >
            {showNew ? "Close" : `New ${entity.singular}`}
          </button>
        </div>

        {showNew && (
          <CreateForm
            entity={entity}
            onDone={() => {
              setShowNew(false);
              load();
            }}
          />
        )}

        {error && (
          <div className="mb-4 rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-700">{error}</div>
        )}

        <div className="overflow-hidden rounded-xl border border-line bg-white">
          <table className="w-full text-sm">
            <thead className="bg-surface-soft text-left text-xs uppercase tracking-wide text-ink-faint">
              <tr>
                {entity.listColumns.map((c) => {
                  const sortable = entity.sortableFields.includes(c);
                  const arrow = sort?.field === c ? (sort.order === "asc" ? " ↑" : " ↓") : "";
                  return (
                    <th
                      key={c}
                      onClick={() => toggleSort(c)}
                      className={`px-4 py-2.5 font-semibold ${sortable ? "cursor-pointer hover:text-ink" : ""}`}
                    >
                      {fieldByName.get(c)?.label ?? c}
                      {arrow}
                    </th>
                  );
                })}
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {busy && rows.length === 0 && (
                <tr>
                  <td colSpan={entity.listColumns.length + 1} className="px-4 py-8 text-center text-ink-faint">
                    Loading…
                  </td>
                </tr>
              )}
              {!busy && rows.length === 0 && (
                <tr>
                  <td colSpan={entity.listColumns.length + 1} className="px-4 py-8 text-center text-ink-faint">
                    No records.
                  </td>
                </tr>
              )}
              {rows.map((row) => {
                const id = String(row["id"] ?? "");
                return (
                  <tr key={id} className="transition hover:bg-surface-soft/60">
                    {entity.listColumns.map((c) => (
                      <td key={c} className="px-4 py-2.5 text-ink">
                        <Cell field={fieldByName.get(c)} value={row[c]} schema={schema} />
                      </td>
                    ))}
                    <td className="px-4 py-2.5 text-right">
                      <Link href={`/e/${entity.slug}/${encodeURIComponent(id)}`} className="text-sm font-medium text-brand-600 hover:text-brand-700">
                        Open →
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-ink-faint">
          {rows.length} shown{result?.nextCursor ? " · more available (refine filters)" : ""}
        </p>
      </div>
    </>
  );
}

function Cell({
  field,
  value,
  schema,
}: {
  field: UiFieldSchema | undefined;
  value: unknown;
  schema: ReturnType<typeof useSchema>["schema"];
}) {
  if (value === null || value === undefined || value === "") return <span className="text-ink-faint">—</span>;
  const kind = cellKind(field);
  if (kind === "badge") return <Badge value={String(value)} />;
  if (field?.input === "reference" && field.referenceTarget) {
    const slug = slugForEntityName(schema, field.referenceTarget);
    if (slug) {
      return (
        <Link href={`/e/${slug}/${encodeURIComponent(String(value))}`} className="text-brand-600 hover:text-brand-700">
          {String(value)}
        </Link>
      );
    }
  }
  return <span>{formatCell(value, kind)}</span>;
}

function FilterControl({
  field,
  value,
  onChange,
}: {
  field: UiFieldSchema | undefined;
  value: string;
  onChange: (v: string) => void;
}) {
  if (field === undefined) return null;
  if (field.input === "select") {
    return (
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-brand"
      >
        <option value="">{field.label}: all</option>
        {(field.enumValues ?? []).map((o) => (
          <option key={o} value={o}>
            {o.replace(/_/g, " ")}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={`${field.label}…`}
      className="w-40 rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-brand"
    />
  );
}

function CreateForm({ entity, onDone }: { entity: UiEntitySchema; onDone: () => void }) {
  const editable = entity.fields.filter((f) => f.readOnly !== true);
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {};
      for (const f of editable) {
        const v = values[f.name];
        if (v === undefined || v === "") continue;
        payload[f.name] = f.input === "number" ? Number(v) : v;
      }
      await createRecord(entity.slug, payload);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-5 rounded-xl border border-line bg-white p-5">
      <h3 className="mb-4 text-sm font-semibold text-ink">New {entity.singular}</h3>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        {editable.map((f) => (
          <label key={f.name} className="block">
            <span className="mb-1 flex items-center gap-1 text-xs font-medium text-ink-muted">
              {f.label}
              {f.required && <span className="text-brand-600">*</span>}
              {f.classification && (
                <span className="rounded bg-amber-50 px-1 text-[10px] font-semibold text-amber-700">{f.classification}</span>
              )}
            </span>
            <FieldInput field={f} value={values[f.name] ?? (f.input === "boolean" ? false : "")} onChange={(v) => setValues((p) => ({ ...p, [f.name]: v }))} />
          </label>
        ))}
      </div>
      {error && <p className="mt-3 text-sm text-brand-600">{error}</p>}
      <div className="mt-4 flex gap-3">
        <button onClick={() => void submit()} disabled={busy} className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-60">
          {busy ? "Creating…" : "Create"}
        </button>
      </div>
    </div>
  );
}
