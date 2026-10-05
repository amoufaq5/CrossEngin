import type { Manifest } from "@crossengin/kernel/manifest";
import { resolvedFields } from "@crossengin/kernel/ddl";

import { toDecimalWire, type DecimalSpec } from "./decimal.js";
import type {
  EntityRecord,
  EntityStore,
  ListPage,
  ListQuery,
  TransactionalEntityStore,
} from "./store.js";

/** `entity → field → declaration` for every `decimal` field a manifest declares. */
export type DecimalFieldIndex = ReadonlyMap<string, ReadonlyMap<string, DecimalSpec>>;

/**
 * Every `decimal` field in a resolved manifest, keyed by entity.
 *
 * Fields come from the kernel's `resolvedFields` — the same function `validateManifest` and the
 * column plan use — so a trait-supplied decimal is indexed exactly when it is a real column, and
 * the index cannot name a field the served table lacks.
 */
export function decimalFieldIndexFromManifest(manifest: Manifest): DecimalFieldIndex {
  const out = new Map<string, ReadonlyMap<string, DecimalSpec>>();
  const traits = manifest.traits ?? [];
  for (const entity of manifest.entities ?? []) {
    const specs = new Map<string, DecimalSpec>();
    for (const field of resolvedFields(entity, traits)) {
      if (field.type.kind === "decimal") {
        specs.set(field.name, { precision: field.type.precision, scale: field.type.scale });
      }
    }
    if (specs.size > 0) out.set(entity.name, specs);
  }
  return out;
}

/**
 * Thrown when a value bound for a `decimal` field cannot be one — a word where a figure belongs,
 * or an integer part wider than the column holds. It propagates out of the store call, so a
 * handler maps it to 500 and a transactional write rolls back: there is no reading of
 * `price: "about ten"` that should reach a GL posting, and writing a quantised guess would be
 * the silent loss this layer exists to end.
 */
export class DecimalWireError extends Error {
  constructor(
    readonly entity: string,
    readonly field: string,
    readonly reason: string,
  ) {
    super(`${entity}.${field}: ${reason}`);
    this.name = "DecimalWireError";
  }
}

function convert(entity: string, specs: ReadonlyMap<string, DecimalSpec>, record: EntityRecord): EntityRecord {
  let out: EntityRecord | null = null;
  for (const [field, spec] of specs) {
    const value = record[field];
    if (value === undefined || value === null) continue;
    const converted = toDecimalWire(value, spec);
    if (!converted.ok) throw new DecimalWireError(entity, field, converted.reason);
    if (converted.wire === value) continue;
    out ??= { ...record };
    out[field] = converted.wire;
  }
  return out ?? record;
}

/**
 * Wraps an `EntityStore` so every `decimal` field crossing it — in or out, on every operation —
 * carries the canonical wire form.
 *
 * It is a decorator rather than three per-store implementations because the wire type is a
 * property of the *serving contract*, not of a backend: the JSONB store echoes whatever JSON the
 * write put in its document (so a client that posted `"10.25"` reads back a string and one that
 * posted `10.25` reads back a number — the JSONB store has no wire type at all, only a memory),
 * the in-memory store echoes the object it was handed, and only the column store has a type,
 * because its value went through Postgres. One decorator makes all three answer the same, and
 * `compileOperateServer` applies it where the manifest is known, so no deployment can forget it.
 *
 * Writes are converted too, not only reads. Two reasons: a write-through store returns the record
 * it stored (`ColumnMappedEntityStore.create` echoes its *input*, so without this `create` and a
 * following `get` disagreed inside one store), and the write effects — the double-entry core —
 * create journal lines directly through the store they are handed, which is this one.
 */
export function withDecimalWireType<S extends EntityStore>(store: S, index: DecimalFieldIndex): S {
  if (index.size === 0) return store;

  const map = (entity: string, record: EntityRecord): EntityRecord => {
    const specs = index.get(entity);
    return specs === undefined ? record : convert(entity, specs, record);
  };

  // `Object.create` rather than a fresh object literal: a store also implements interfaces this
  // decorator knows nothing about — `AssociationReader`/`Writer`/`Counter`, `ensureSchema`,
  // `pruneDanglingLinks` — and the association routes reach for them off the same store. Spreading
  // six methods into a new object would drop the rest, so the original stays on the prototype and
  // only the six carrying records are overridden.
  const overrides: EntityStore & Partial<TransactionalEntityStore> = {
    async list(tenantId, entity) {
      return (await store.list(tenantId, entity)).map((r) => map(entity, r));
    },
    async listPage(tenantId, entity, query: ListQuery): Promise<ListPage> {
      const page = await store.listPage(tenantId, entity, query);
      return { records: page.records.map((r) => map(entity, r)), nextCursor: page.nextCursor };
    },
    async get(tenantId, entity, id) {
      const record = await store.get(tenantId, entity, id);
      return record === null ? null : map(entity, record);
    },
    async create(tenantId, entity, record) {
      return map(entity, await store.create(tenantId, entity, map(entity, record)));
    },
    async update(tenantId, entity, id, patch) {
      const updated = await store.update(tenantId, entity, id, map(entity, patch));
      return updated === null ? null : map(entity, updated);
    },
    remove(tenantId, entity, id) {
      return store.remove(tenantId, entity, id);
    },
  };
  const transactional = store as Partial<TransactionalEntityStore>;
  if (typeof transactional.withTransaction === "function") {
    overrides.withTransaction = (tenantId, fn) =>
      transactional.withTransaction!(tenantId, (tx) => fn(withDecimalWireType(tx, index)));
  }
  return Object.assign(Object.create(store) as S, overrides);
}
