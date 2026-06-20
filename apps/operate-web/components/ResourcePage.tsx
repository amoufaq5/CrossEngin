"use client";

import { useCallback, useEffect, useState } from "react";

import { createRecord, deleteRecord, listRecords } from "@/lib/api";
import { formatCell, titleCase } from "@/lib/format";
import type { FieldDef, ResourceConfig } from "@/lib/resources";
import { Badge } from "@/components/Badge";

type Row = Record<string, unknown>;
type Banner = { kind: "ok" | "err"; text: string } | null;

export function ResourcePage({ resource }: { resource: ResourceConfig }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState<Banner>(null);
  const [formOpen, setFormOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await listRecords(resource.slug, "?limit=100");
      setRows(data as Row[]);
    } catch (e) {
      setBanner({ kind: "err", text: `Failed to load: ${(e as Error).message}` });
    } finally {
      setLoading(false);
    }
  }, [resource.slug]);

  useEffect(() => {
    void load();
  }, [load]);

  const onCreated = (label: string) => {
    setBanner({ kind: "ok", text: `Created ${label}` });
    setFormOpen(false);
    void load();
  };

  const onDelete = async (id: string) => {
    try {
      await deleteRecord(resource.slug, id);
      setBanner({ kind: "ok", text: `Deleted ${id}` });
      void load();
    } catch (e) {
      setBanner({ kind: "err", text: `Delete failed: ${(e as Error).message}` });
    }
  };

  return (
    <div className="px-8 py-6">
      <div className="mb-5 flex items-center justify-between">
        <div>
          <p className="text-sm text-ink-muted">
            {loading ? "Loading…" : `${rows.length} record${rows.length === 1 ? "" : "s"}`}
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn-ghost" onClick={() => void load()}>
            Refresh
          </button>
          <button className="btn-primary" onClick={() => setFormOpen((v) => !v)}>
            {formOpen ? "Close" : `New ${resource.singular}`}
          </button>
        </div>
      </div>

      {banner ? (
        <div
          className={`mb-4 rounded-lg px-4 py-2 text-sm ${
            banner.kind === "ok"
              ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-600/20"
              : "bg-brand-50 text-brand-700 ring-1 ring-brand-600/20"
          }`}
        >
          {banner.text}
        </div>
      ) : null}

      {formOpen ? (
        <CreateForm
          resource={resource}
          onCancel={() => setFormOpen(false)}
          onCreated={onCreated}
          onError={(t) => setBanner({ kind: "err", text: t })}
        />
      ) : null}

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-faint">
                {resource.columns.map((c) => (
                  <th key={c.key} className="px-4 py-3 font-semibold">
                    {c.label}
                  </th>
                ))}
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && !loading ? (
                <tr>
                  <td colSpan={resource.columns.length + 1} className="px-4 py-10 text-center text-ink-faint">
                    No {resource.title.toLowerCase()} yet — create one above.
                  </td>
                </tr>
              ) : null}
              {rows.map((row, i) => (
                <tr key={String(row["id"] ?? i)} className="border-b border-line/70 last:border-0 hover:bg-surface-soft">
                  {resource.columns.map((c) => (
                    <td key={c.key} className="px-4 py-3 text-ink">
                      <Cell value={row[c.key]} kind={c.kind} />
                    </td>
                  ))}
                  <td className="px-4 py-3 text-right">
                    {typeof row["id"] === "string" ? (
                      <button className="btn-danger px-2 py-1 text-xs" onClick={() => void onDelete(row["id"] as string)}>
                        Delete
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Cell({ value, kind }: { value: unknown; kind?: string }) {
  if (kind === "badge" && typeof value === "string" && value.length > 0) {
    return <Badge value={value} />;
  }
  const text = formatCell(value, kind);
  if (kind === "email" && text !== "—") {
    return <span className="text-ink-muted">{text}</span>;
  }
  return <span>{text}</span>;
}

function CreateForm({
  resource,
  onCancel,
  onCreated,
  onError,
}: {
  resource: ResourceConfig;
  onCancel: () => void;
  onCreated: (label: string) => void;
  onError: (text: string) => void;
}) {
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [submitting, setSubmitting] = useState(false);

  const set = (name: string, v: string | boolean) => setValues((prev) => ({ ...prev, [name]: v }));

  const submit = async () => {
    setSubmitting(true);
    try {
      const payload: Record<string, unknown> = {};
      for (const f of resource.fields) {
        const raw = values[f.name];
        if (f.type === "boolean") {
          payload[f.name] = raw === true;
          continue;
        }
        if (raw === undefined || raw === "") continue;
        payload[f.name] = f.type === "number" ? Number(raw) : raw;
      }
      const created = await createRecord(resource.slug, payload);
      const label = String(created["id"] ?? resource.singular);
      onCreated(label);
      setValues({});
    } catch (e) {
      onError(`Create failed: ${(e as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="card mb-5 p-5">
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-ink-muted">
        New {resource.singular}
      </h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {resource.fields.map((f) => (
          <Field key={f.name} field={f} value={values[f.name]} onChange={(v) => set(f.name, v)} />
        ))}
      </div>
      <div className="mt-5 flex gap-2">
        <button className="btn-primary" disabled={submitting} onClick={() => void submit()}>
          {submitting ? "Saving…" : `Create ${resource.singular}`}
        </button>
        <button className="btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function Field({
  field,
  value,
  onChange,
}: {
  field: FieldDef;
  value: string | boolean | undefined;
  onChange: (v: string | boolean) => void;
}) {
  if (field.type === "boolean") {
    return (
      <label className="flex items-center gap-2 self-end pb-2 text-sm text-ink">
        <input
          type="checkbox"
          className="h-4 w-4 rounded border-line text-brand focus:ring-brand"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />
        {field.label}
      </label>
    );
  }

  return (
    <div>
      <label className="label">
        {field.label}
        {field.required ? <span className="text-brand"> *</span> : null}
      </label>
      {field.type === "select" ? (
        <select className="field" value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          {(field.options ?? []).map((o) => (
            <option key={o} value={o}>
              {titleCase(o)}
            </option>
          ))}
        </select>
      ) : field.type === "textarea" ? (
        <textarea
          className="field min-h-[72px]"
          value={(value as string) ?? ""}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          className="field"
          type={inputType(field.type)}
          value={(value as string) ?? ""}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  );
}

function inputType(t: FieldDef["type"]): string {
  switch (t) {
    case "number":
      return "number";
    case "email":
      return "email";
    case "date":
      return "date";
    case "datetime":
      return "datetime-local";
    default:
      return "text";
  }
}
