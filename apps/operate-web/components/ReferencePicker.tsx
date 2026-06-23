"use client";

import { useEffect, useState } from "react";

import { listRecords } from "@/lib/api";
import { entityByName, recordLabel, slugForEntityName, type UiSchema } from "@/lib/schema";

const INPUT_CLASS =
  "w-full rounded-lg border border-line px-3 py-2 text-sm outline-none transition focus:border-brand disabled:bg-surface-soft disabled:text-ink-faint";

interface Option {
  readonly id: string;
  readonly label: string;
}

/**
 * A dropdown for a reference field: resolves the target entity from the schema, lazy-loads
 * its records, and lets the user pick one by human label (storing the id). Falls back to a
 * plain id text input when the target can't be resolved or its records can't be listed, so
 * editing is never blocked.
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
  const [options, setOptions] = useState<readonly Option[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (slug === undefined || targetEntity === undefined) return;
    let alive = true;
    listRecords(slug, "?limit=500")
      .then((res) => {
        if (!alive) return;
        const opts = res.data
          .map((r) => ({ id: String(r["id"] ?? ""), label: recordLabel(targetEntity, r) }))
          .filter((o) => o.id !== "")
          .sort((a, b) => a.label.localeCompare(b.label));
        setOptions(opts);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [slug, targetEntity]);

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

  // Selected id not present in the loaded options (e.g. truncated list) → keep it as an
  // explicit option so the picker never silently drops an existing value.
  const hasValue = value !== "" && (options?.some((o) => o.id === value) ?? false);

  // Client-side filter for large lists; the selected option is always kept visible.
  const needle = query.trim().toLowerCase();
  const visible =
    options === null || needle === ""
      ? (options ?? [])
      : options.filter((o) => o.id === value || o.label.toLowerCase().includes(needle));
  const showFilter = (options?.length ?? 0) > 12;

  return (
    <div className="space-y-1.5">
      {showFilter && (
        <input
          type="text"
          className={INPUT_CLASS}
          value={query}
          disabled={disabled}
          placeholder={`Filter ${target.toLowerCase()}…`}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}
      <select className={INPUT_CLASS} value={value} disabled={disabled || options === null} onChange={(e) => onChange(e.target.value)}>
        {!required && <option value="">—</option>}
        {options === null && <option value={value}>{value === "" ? "Loading…" : value}</option>}
        {value !== "" && options !== null && !hasValue && <option value={value}>{value}</option>}
        {visible.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
