import type { EntityRecord, EntityStore, ListQuery } from "./store.js";

/** Follow every page; never silently return a partial financial dataset. */
export async function completeList(store: EntityStore, tenantId: string, entity: string, query: ListQuery): Promise<readonly EntityRecord[]> {
  const records: EntityRecord[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await store.listPage(tenantId, entity, { ...query, limit: Math.max(1, query.limit), cursor });
    records.push(...page.records);
    cursor = page.nextCursor;
    if (cursor !== null) {
      if (seen.has(cursor) || page.records.length === 0) throw new Error("Financial report pagination did not advance");
      seen.add(cursor);
    }
    if (records.length > 100_000) throw new Error("Financial dataset exceeds interactive reporting limit; no partial result was returned");
  } while (cursor !== null);
  return records;
}
