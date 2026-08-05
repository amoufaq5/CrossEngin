"use client";

import { useEffect, useRef, useState } from "react";

import type { UiFieldSchema } from "@/lib/schema";

/**
 * A popover of checkboxes over the entity's fields, driving which columns the list table renders.
 * The parent owns the chosen set (persisted per-slug); this component only edits it — and never
 * lets the last visible column be unchecked, so the table can't collapse to just its gutter cells.
 */
export function ColumnChooser({
  fields,
  visible,
  onChange,
  onReset,
}: {
  fields: readonly UiFieldSchema[];
  visible: readonly string[];
  onChange: (next: readonly string[]) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (ref.current !== null && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  const visibleSet = new Set(visible);

  function toggle(name: string) {
    if (visibleSet.has(name)) {
      if (visibleSet.size <= 1) return;
      onChange(visible.filter((c) => c !== name));
    } else {
      // Re-derive from field order so headers stay in a stable, schema-defined order.
      const next = new Set(visibleSet).add(name);
      onChange(fields.filter((f) => next.has(f.name)).map((f) => f.name));
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="rounded-lg border border-line px-3 py-2 text-sm text-ink-muted hover:bg-surface-soft"
      >
        Columns ({visible.length})
      </button>
      {open && (
        <div className="absolute left-0 z-20 mt-1 max-h-80 w-60 overflow-auto rounded-lg border border-line bg-white p-2 shadow-lg">
          <div className="mb-1 flex items-center justify-between px-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Columns</span>
            <button onClick={onReset} className="text-xs font-medium text-brand-600 hover:text-brand-700">
              Reset
            </button>
          </div>
          {fields.map((f) => (
            <label
              key={f.name}
              className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-surface-soft"
            >
              <input
                type="checkbox"
                checked={visibleSet.has(f.name)}
                onChange={() => toggle(f.name)}
                className="cursor-pointer"
              />
              <span className="text-ink">{f.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
