import { resolvedFields } from "@crossengin/kernel/ddl";
import type { Manifest } from "@crossengin/kernel/manifest";
import type { FieldType, PrimitiveFieldType } from "@crossengin/types/meta-schema";

import type {
  EntityStore,
  ListPage,
  ListQuery,
  ListValueType,
  TransactionalEntityStore,
} from "./store.js";

/**
 * The comparison type of every manifest field kind — a **total** map over
 * `PrimitiveFieldType["kind"]`, so a twenty-fourth field kind is a compile error here rather than
 * a new member falling into a text default and sorting wrong in production.
 *
 * `numeric` is given to exactly the two kinds whose Postgres type is numeric — `integer`
 * (`INTEGER`) and `decimal` (`NUMERIC(p, s)`). Everything else is `text`, and four of those are
 * worth the sentence because text is a *measured* answer rather than a shrug:
 *
 * - **`boolean`** — JSON renders it `true`/`false`, and `'false' < 'true'` lexicographically is
 *   the same order as `false < true` as booleans. A cast would buy nothing.
 * - **`date`** — a `YYYY-MM-DD` numeral is fixed-width and zero-padded, so byte order *is*
 *   chronological order.
 * - **`time`** — likewise for `HH:MM:SS`.
 * - **`datetime`** — ISO-8601 instants sort correctly **only while every writer spells them the
 *   same way**. They do not have to: `2026-01-31T10:00:00+09:00` and `2026-01-31T01:00:00Z` are
 *   one instant with two spellings that sort three hours apart, and `validateBody` has no rule for
 *   a `datetime` field at all, so either can be stored. This is a known hole, left here rather
 *   than closed with a third `ListValueType`, because fixing it is a question about the *wire
 *   form* of a `datetime` (which spelling is canonical, and what the column store's `isoInstant`
 *   should agree with) and not about ordering — exactly the shape of the `decimal` question
 *   ADR-0332 had to answer before this one could be. See that increment's follow-ups.
 *
 * The remaining kinds are text by nature (`text`, `long_text`, `email`, `phone`, `url`, `enum`,
 * `country_code`, `language_code`, `timezone`), opaque identifiers nobody orders *by value*
 * (`uuid`, `reference` — the JSONB store holds a reference as the target's record id, which is
 * text in both stores), JSON documents for which no scalar order exists (`json`, `file`,
 * `currency_amount`), geographies that are not scalar-ordered (`geo_point`, `geo_polygon`), or
 * `duration`, whose wire type is undecided on purpose —
 * `ColumnMappedEntityStore` refuses to read an `INTERVAL` at all (`UndecidedWireTypeError`), so
 * there is no spelling for this store to agree with yet.
 */
export const FIELD_LIST_VALUE_TYPES: {
  readonly [K in PrimitiveFieldType["kind"]]: ListValueType;
} = {
  text: "text",
  long_text: "text",
  integer: "numeric",
  decimal: "numeric",
  boolean: "text",
  date: "text",
  time: "text",
  datetime: "text",
  duration: "text",
  uuid: "text",
  enum: "text",
  reference: "text",
  json: "text",
  file: "text",
  email: "text",
  phone: "text",
  url: "text",
  currency_amount: "text",
  geo_point: "text",
  geo_polygon: "text",
  country_code: "text",
  language_code: "text",
  timezone: "text",
};

/**
 * The comparison type of one field's declared type.
 *
 * An `array` field is `text`: `document ->> 'f'` renders the whole array, and a keyset cursor
 * component for an array is already meaningless (`keysetOf` renders it with `String`), so casting
 * the rendering to a number would replace one wrong answer with a different wrong answer.
 */
export function listValueTypeFor(type: FieldType): ListValueType {
  return type.kind === "array" ? "text" : FIELD_LIST_VALUE_TYPES[type.kind];
}

/** `entity → field → comparison type`, holding only the fields that are not plain text. */
export type ListValueTypeIndex = ReadonlyMap<string, ReadonlyMap<string, ListValueType>>;

/**
 * Every non-text field in a resolved manifest, keyed by entity.
 *
 * Fields come from the kernel's `resolvedFields` — the same function `validateManifest`, the
 * column plan and `decimalFieldIndexFromManifest` use — so a trait-supplied field is indexed
 * exactly when it is a real served field, and the index cannot name a field the store lacks.
 * `text` entries are omitted because `text` is what an absent entry means; the index is then
 * empty for a manifest with no numeric field at all, and the decorator can skip itself entirely.
 */
export function listValueTypesForManifest(manifest: Manifest): ListValueTypeIndex {
  const out = new Map<string, ReadonlyMap<string, ListValueType>>();
  const traits = manifest.traits ?? [];
  for (const entity of manifest.entities ?? []) {
    const types = new Map<string, ListValueType>();
    for (const field of resolvedFields(entity, traits)) {
      const type = listValueTypeFor(field.type);
      if (type !== "text") types.set(field.name, type);
    }
    if (types.size > 0) out.set(entity.name, types);
  }
  return out;
}

/**
 * Wraps an `EntityStore` so every list query crossing it carries the manifest's per-field
 * comparison types, letting a text-holding store compare and order a field on its declared type.
 *
 * A decorator rather than a store option for the reason on `ListQuery.valueTypes`: a single
 * `PostgresEntityStore` instance serves several tenants' manifests, so the types belong to the
 * call, not to the instance. And a decorator rather than threading the index through
 * `listConfigForEntity` → `parseListQuery` because **twelve internal callers build a `ListQuery`
 * by hand** — the write effects' GL postings, the aging and WHT reports, the entitlement record
 * cap, the period-lock guard — and every one of them reaches for `ctx.store`, which is this. One
 * seam covers a client request and a journal-line lookup alike; a parse-time hook would have
 * covered only the first.
 *
 * `compileOperateServer` applies it beside `withDecimalWireType`, the one place holding both the
 * store and the manifest, so no deployment can forget it.
 *
 * A query that already carries `valueTypes` is left alone, so a caller that knows better than the
 * manifest (a test, or a nested decorator) wins.
 */
export function withListValueTypes<S extends EntityStore>(store: S, index: ListValueTypeIndex): S {
  if (index.size === 0) return store;

  const typed = (entity: string, query: ListQuery): ListQuery => {
    if (query.valueTypes !== undefined) return query;
    const types = index.get(entity);
    return types === undefined ? query : { ...query, valueTypes: types };
  };

  // `Object.create` rather than a fresh literal, for `withDecimalWireType`'s reason: a store also
  // implements interfaces this decorator knows nothing about (`AssociationReader`/`Writer`/
  // `Counter`, `ensureSchema`, `pruneDanglingLinks`) and the association routes reach for them off
  // the same object, so the original stays on the prototype and only `listPage` is overridden.
  const overrides: Partial<EntityStore> & Partial<TransactionalEntityStore> = {
    listPage(tenantId: string, entity: string, query: ListQuery): Promise<ListPage> {
      return store.listPage(tenantId, entity, typed(entity, query));
    },
  };
  const transactional = store as Partial<TransactionalEntityStore>;
  if (typeof transactional.withTransaction === "function") {
    overrides.withTransaction = <T>(
      tenantId: string,
      fn: (tx: EntityStore) => Promise<T>,
    ): Promise<T> =>
      transactional.withTransaction!(tenantId, (tx: EntityStore) =>
        fn(withListValueTypes(tx, index)),
      );
  }
  return Object.assign(Object.create(store) as S, overrides);
}
