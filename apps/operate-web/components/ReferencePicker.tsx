"use client";

import { useEffect, useMemo, useState } from "react";

import { listRecords } from "@/lib/api";
import { entityByName, recordLabel, slugForEntityName, type UiEntitySchema, type UiSchema } from "@/lib/schema";

const INPUT_CLASS =
  "w-full rounded-lg border border-line px-3 py-2 text-sm outline-none transition focus:border-brand disabled:bg-surface-soft disabled:text-ink-faint";

interface Option {
  readonly id: string;
  readonly label: string;
}

const LABELISH = /(^name$|^title$|^code$|_number$|^email$|_name$)/;

/** A filterable text-ish field to run a server-side `contains` search against, or null. */
function searchFieldFor(entity: UiEntitySchema): string | null {
  const filterable = new Set(entity.filterableFields);
  const labelish = entity.fields.find((f) => filterable.has(f.name) && LABELISH.test(f.name));
  if (labelish !== undefined) return labelish.name;
  const text = entity.fields.find((f) => filterable.has(f.name) && (f.input === "text" || f.input === "email"));
  return text?.name ?? null;
}

function toOptions(rows: readonly Record<string, unknown>[], entity: UiEntitySchema): Option[] {
  return rows
    .map((r) => ({ id: String(r["id"] ?? ""), label: recordLabel(entity, r) }))
    .filter((o) => o.id !== "")
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * A dropdown for a reference field: resolves the target entity from the schema, lazy-loads
 * its records, and lets the user pick one by human label (storing the id). For large targets
 * with a filterable label field, typing runs a server-side `contains` search (debounced), so
 * the picker scales past the first page. Falls back to a raw id input when the target can't
 * be resolved or its records can't be listed, so editing is never blocked.
 */
export function ReferencePicker({
  target,
  value,
  onChange,
  disabled,
  required,
  schema,
}: {
  target: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  required?: boolean;
  schema: UiSchema | null;
}) {
  const slug = slugForEntityName(schema, target);
  const targetEntity = entityByName(schema, target);
  const searchField = useMemo(() => (targetEntity !== undefined ? searchFieldFor(targetEntity) : null), [targetEntity]);
  const [options, setOptions] = useState<readonly Option[] | null>(null);
  const [serverOptions, setServerOptions] = useState<readonly Option[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");

  // Initial page (the default dropdown list).
  useEffect(() => {
    if (slug === undefined || targetEntity === undefined) return;
    let alive = true;
    listRecords(slug, "?limit=200")
      .then((res) => {
        if (alive) setOptions(toOptions(res.data, targetEntity));
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [slug, targetEntity]);

  // Server-side typeahead: as the user types, search the label field via `contains`.
  const needle = query.trim();
  useEffect(() => {
    if (slug === undefined || targetEntity === undefined || searchField === null || needle === "") {
      setServerOptions(null);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      listRecords(slug, `?${searchField}[contains]=${encodeURIComponent(needle)}&limit=50`)
        .then((res) => {
          if (alive) setServerOptions(toOptions(res.data, targetEntity));
        })
        .catch(() => {
          if (alive) setServerOptions(null);
        });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [slug, targetEntity, searchField, needle]);

  // No resolvable target, or listing failed → raw id input so the field stays editable.
  if (slug === undefined || targetEntity === undefined || failed) {
    return (
      <input
        type="text"
        className={INPUT_CLASS}
        value={value}
        disabled={disabled}
        placeholder={`${target} id`}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  // With a search field, typing shows server results; otherwise filter the loaded page
  // client-side. Either way the selected option is always kept visible.
  const lower = needle.toLowerCase();
  const visible: readonly Option[] =
    searchField !== null && needle !== ""
      ? (serverOptions ?? [])
      : options === null || needle === ""
        ? (options ?? [])
        : options.filter((o) => o.id === value || o.label.toLowerCase().includes(lower));
  const selectedVisible = value !== "" && visible.some((o) => o.id === value);
  const showFilter = searchField !== null || (options?.length ?? 0) > 12;

  return (
    <div className="space-y-1.5">
      {showFilter && (
        <input
          type="text"
          className={INPUT_CLASS}
          value={query}
          disabled={disabled}
          placeholder={searchField !== null ? `Search ${target.toLowerCase()}…` : `Filter ${target.toLowerCase()}…`}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}
      <select className={INPUT_CLASS} value={value} disabled={disabled || options === null} onChange={(e) => onChange(e.target.value)}>
        {!required && <option value="">—</option>}
        {options === null && <option value={value}>{value === "" ? "Loading…" : value}</option>}
        {value !== "" && !selectedVisible && <option value={value}>{value}</option>}
        {visible.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
