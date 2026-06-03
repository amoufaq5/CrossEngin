import { z } from "zod";
import type { EntityRecord } from "@crossengin/operate-runtime";

/**
 * The persisted shape of one entity record in `meta.operate_entity_records`:
 * a JSONB `document` keyed by `(tenant_id, entity, record_id)`. The store reads
 * the `document` column back as the live `EntityRecord` (node-postgres parses
 * JSONB into a JS object).
 */
export const EntityRecordRowSchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  entity: z.string(),
  record_id: z.string(),
  document: z.record(z.string(), z.unknown()),
  created_at: z.union([z.string(), z.date()]),
  updated_at: z.union([z.string(), z.date()]),
});
export type EntityRecordRow = z.infer<typeof EntityRecordRowSchema>;

/** A row that carries only the `document` column (the common read projection). */
export interface DocumentRow {
  readonly document: EntityRecord;
}

const RECORD_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;

let counter = 0;

/**
 * Generates a `rec_<base36-time><base36-counter>` id — the same shape the
 * in-memory store mints, so records created through either binding are
 * indistinguishable downstream.
 */
export function generateRecordId(): string {
  counter += 1;
  return `rec_${Date.now().toString(36)}${counter.toString(36).padStart(4, "0")}`;
}

/** Returns the record's own `id` when it is a usable string, else a fresh id. */
export function resolveRecordId(record: EntityRecord): string {
  const own = record["id"];
  return typeof own === "string" && RECORD_ID_RE.test(own) ? own : generateRecordId();
}

/** Pure merge for `update`: existing ⊕ patch, with the id pinned (never patched away). */
export function mergeRecord(existing: EntityRecord, patch: EntityRecord, id: string): EntityRecord {
  return { ...existing, ...patch, id };
}

/** Maps a full DB row to the live `EntityRecord` (the stored document). */
export function rowToRecord(row: EntityRecordRow): EntityRecord {
  return row.document;
}
