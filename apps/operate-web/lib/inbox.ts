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
}

const PER_ENTITY_LIMIT = 100;

/**
 * Cross-department work queue: every record sitting in a state the viewer's role
 * can advance. One list call per actionable entity, filtered client-side to the
 * states with a fireable transition (so it works regardless of filterability).
 */
export async function fetchInbox(schema: UiSchema | null): Promise<readonly InboxItem[]> {
  const specs = inboxEntitySpecs(schema);
  const items: InboxItem[] = [];
  const results = await Promise.all(
    specs.map(async (spec) => {
      const stateField = spec.entity.stateField;
      if (stateField === null) return [] as InboxItem[];
      try {
        const page = await listRecords(spec.entity.slug, `?limit=${PER_ENTITY_LIMIT}`);
        const out: InboxItem[] = [];
        for (const rec of page.data) {
          const state = String(rec[stateField] ?? "");
          if (!spec.fromStates.includes(state)) continue;
          const actions = actionsForState(spec, state);
          if (actions.length === 0) continue;
          const id = String(rec["id"] ?? "");
          if (id === "") continue;
          out.push({ entity: spec.entity, id, label: recordLabel(spec.entity, rec), state, actions });
        }
        return out;
      } catch {
        // A denied/empty entity shouldn't sink the whole inbox.
        return [] as InboxItem[];
      }
    }),
  );
  for (const batch of results) items.push(...batch);
  items.sort((a, b) => a.entity.label.localeCompare(b.entity.label) || a.label.localeCompare(b.label));
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
