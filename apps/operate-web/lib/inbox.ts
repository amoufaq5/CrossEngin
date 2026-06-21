"use client";

import { useCallback, useEffect, useState } from "react";

import { listRecords } from "@/lib/api";
import {
  actionsForState,
  inboxEntitySpecs,
  recordLabel,
  type UiEntitySchema,
  type UiSchema,
  type UiTransitionSchema,
} from "@/lib/schema";

export interface InboxItem {
  readonly entity: UiEntitySchema;
  readonly id: string;
  readonly label: string;
  readonly state: string;
  readonly actions: readonly UiTransitionSchema[];
  /** When the item began waiting (last update, falling back to creation); null if unknown. */
  readonly waitingSince: string | null;
  /** Milliseconds the item has been waiting, or null when no timestamp is available. */
  readonly ageMs: number | null;
}

const PER_ENTITY_LIMIT = 200;

function waitingSinceOf(rec: Record<string, unknown>): string | null {
  const u = rec["updated_at"];
  if (typeof u === "string" && u.length > 0) return u;
  const c = rec["created_at"];
  return typeof c === "string" && c.length > 0 ? c : null;
}

/** Builds a list query that pushes the state filter server-side when the column is filterable. */
function inboxQuery(spec: ReturnType<typeof inboxEntitySpecs>[number]): string {
  const stateField = spec.entity.stateField;
  const params = [`limit=${PER_ENTITY_LIMIT}`];
  if (stateField !== null && spec.entity.filterableFields.includes(stateField) && spec.fromStates.length > 0) {
    params.push(`${encodeURIComponent(stateField)}[in]=${spec.fromStates.map(encodeURIComponent).join(",")}`);
  }
  return `?${params.join("&")}`;
}

/**
 * Cross-department work queue: every record sitting in a state the viewer's role
 * can advance. One list call per actionable entity — the state filter is pushed
 * server-side when the column is filterable, and always re-checked client-side so
 * the result is correct regardless. Sorted oldest-waiting first.
 */
export async function fetchInbox(schema: UiSchema | null, now: number = Date.now()): Promise<readonly InboxItem[]> {
  const specs = inboxEntitySpecs(schema);
  const items: InboxItem[] = [];
  const results = await Promise.all(
    specs.map(async (spec) => {
      const stateField = spec.entity.stateField;
      if (stateField === null) return [] as InboxItem[];
      try {
        const page = await listRecords(spec.entity.slug, inboxQuery(spec));
        const out: InboxItem[] = [];
        for (const rec of page.data) {
          const state = String(rec[stateField] ?? "");
          if (!spec.fromStates.includes(state)) continue;
          const actions = actionsForState(spec, state);
          if (actions.length === 0) continue;
          const id = String(rec["id"] ?? "");
          if (id === "") continue;
          const waitingSince = waitingSinceOf(rec);
          const ageMs = waitingSince !== null ? Math.max(0, now - Date.parse(waitingSince)) : null;
          out.push({ entity: spec.entity, id, label: recordLabel(spec.entity, rec), state, actions, waitingSince, ageMs });
        }
        return out;
      } catch {
        // A denied/empty entity shouldn't sink the whole inbox.
        return [] as InboxItem[];
      }
    }),
  );
  for (const batch of results) items.push(...batch);
  // Oldest-waiting first; items without a timestamp sort last.
  items.sort((a, b) => {
    if (a.ageMs === null && b.ageMs === null) return a.entity.label.localeCompare(b.entity.label);
    if (a.ageMs === null) return 1;
    if (b.ageMs === null) return -1;
    return b.ageMs - a.ageMs;
  });
  return items;
}

export interface InboxState {
  readonly items: readonly InboxItem[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
}

export function useInbox(schema: UiSchema | null): InboxState {
  const [items, setItems] = useState<readonly InboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (schema === null) return;
    setLoading(true);
    fetchInbox(schema)
      .then((i) => {
        setItems(i);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [schema]);

  useEffect(() => {
    if (schema === null) return;
    let alive = true;
    setLoading(true);
    fetchInbox(schema)
      .then((i) => alive && setItems(i))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [schema]);

  return { items, loading, error, refresh };
}
