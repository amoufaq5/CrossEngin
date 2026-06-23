"use client";

import { useEffect, useState } from "react";

import { getRecord, listRecords } from "@/lib/api";
import { entityByName, recordLabel, slugForEntityName, type UiSchema } from "@/lib/schema";

// Resolved id→label maps per entity slug, shared across all cells/fields in the session so
// a referenced entity's records are fetched at most once. Edits to a referenced record's
// label surface on the next full page load (acceptable for a console).
const caches = new Map<string, Map<string, string>>();
const inflight = new Map<string, Promise<Map<string, string>>>();
// Per-(slug,id) single-record resolution for ids beyond the first page of the list fetch.
const oneInflight = new Map<string, Promise<void>>();

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

/** Resolves a single id whose label wasn't in the list page (an entity with >200 records). */
function resolveOne(slug: string, entity: ReturnType<typeof entityByName>, id: string): Promise<void> {
  const key = `${slug}:${id}`;
  const existing = oneInflight.get(key);
  if (existing !== undefined) return existing;
  const p = getRecord(slug, id)
    .then((rec) => {
      const m = caches.get(slug) ?? new Map<string, string>();
      m.set(id, entity !== undefined ? recordLabel(entity, rec) : id);
      caches.set(slug, m);
    })
    .catch(() => {
      // Not found / no access → cache the id as its own label so we don't refetch in a loop.
      const m = caches.get(slug) ?? new Map<string, string>();
      m.set(id, id);
      caches.set(slug, m);
    })
    .finally(() => oneInflight.delete(key));
  oneInflight.set(key, p);
  return p;
}

/**
 * Resolves a reference value to its target record's human label, lazily loading (and
 * caching) the target entity's records — and falling back to a single-record fetch for an
 * id beyond the first page. Returns the raw id while loading or when unresolved, so a
 * reference always renders something meaningful.
 */
export function useReferenceLabel(schema: UiSchema | null, target: string, id: string): string {
  const slug = slugForEntityName(schema, target);
  const entity = entityByName(schema, target);
  const [, force] = useState(0);

  useEffect(() => {
    if (slug === undefined || entity === undefined || id === "") return;
    let alive = true;
    void (async () => {
      const map = caches.get(slug) ?? (await loadLabels(slug, entity));
      if (!map.has(id)) await resolveOne(slug, entity, id);
      if (alive) force((n) => n + 1);
    })();
    return () => {
      alive = false;
    };
  }, [slug, entity, id]);

  if (slug !== undefined && caches.has(slug)) return caches.get(slug)!.get(id) ?? id;
  return id;
}
