"use client";

import { useEffect, useState } from "react";

import { listRecords } from "@/lib/api";
import { entityByName, recordLabel, slugForEntityName, type UiSchema } from "@/lib/schema";

// Resolved id→label maps per entity slug, shared across all cells/fields in the session so
// a referenced entity's records are fetched at most once. Edits to a referenced record's
// label surface on the next full page load (acceptable for a console).
const caches = new Map<string, Map<string, string>>();
const inflight = new Map<string, Promise<Map<string, string>>>();

function loadLabels(slug: string, entity: ReturnType<typeof entityByName>): Promise<Map<string, string>> {
  const existing = inflight.get(slug);
  if (existing !== undefined) return existing;
  const p = listRecords(slug, "?limit=200")
    .then((res) => {
      const m = new Map<string, string>();
      for (const r of res.data) {
        const id = String(r["id"] ?? "");
        if (id !== "" && entity !== undefined) m.set(id, recordLabel(entity, r));
      }
      caches.set(slug, m);
      return m;
    })
    .catch(() => {
      const m = new Map<string, string>();
      caches.set(slug, m); // cache the failure as empty so we don't refetch in a loop
      return m;
    });
  inflight.set(slug, p);
  return p;
}

/**
 * Resolves a reference value to its target record's human label, lazily loading (and
 * caching) the target entity's records. Returns the raw id while loading or when the
 * label can't be resolved, so a reference always renders something meaningful.
 */
export function useReferenceLabel(schema: UiSchema | null, target: string, id: string): string {
  const slug = slugForEntityName(schema, target);
  const entity = entityByName(schema, target);
  const [, force] = useState(0);

  useEffect(() => {
    if (slug === undefined || entity === undefined || id === "") return;
    if (caches.has(slug)) return;
    let alive = true;
    void loadLabels(slug, entity).then(() => {
      if (alive) force((n) => n + 1);
    });
    return () => {
      alive = false;
    };
  }, [slug, entity, id]);

  if (slug !== undefined && caches.has(slug)) return caches.get(slug)!.get(id) ?? id;
  return id;
}
