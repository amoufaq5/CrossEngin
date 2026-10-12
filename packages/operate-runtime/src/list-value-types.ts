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
 * (`INTEGER`) and `decimal` (`NUMERIC(p, s)`). `timestamptz` is given to exactly one,
 * `datetime`. Of the rest, three are `text` as a *measured* answer rather than a shrug:
 *
 * - **`boolean`** — JSON renders it `true`/`false`, and `'false' < 'true'` lexicographically is
 *   the same order as `false < true` as booleans. A cast would buy nothing.
 * - **`date`** — the canonical wire form is `YYYY-MM-DD`, fixed-width and zero-padded, so byte
 *   order *is* chronological order.
 * - **`time`** — likewise: the `HH:MM:SS` head is fixed-width, and two fractional parts with no
 *   trailing zeros compare lexicographically in the order of their values.
 *
 * **`datetime` is `timestamptz`, and the reason is not the canonical form.** That form —
 * `YYYY-MM-DDTHH:mm:ss.sssZ`, fixed width, always UTC — makes byte order chronological by
 * construction, and `withDatetimeWireType` plus `validateBody` now mean nothing else can be
 * written. The cast is for the rows written **before** that was true, whose spellings are not all
 * canonical, and the two stores then place one of them differently:
 * `2026-01-31T19:00:00+09:00` is the same instant as `2026-01-31T10:00:00.000Z` and sorts nine
 * hours away from it as text, while `ColumnMappedEntityStore`'s real `TIMESTAMPTZ` column orders it
 * by its instant. Measured live over five legacy rows, the JSONB store's text order and the instant
 * order differ, and since the keyset cursor is built from the ordering that is the skip-and-repeat
 * failure ADR-0331 established rather than a cosmetic reorder.
 *
 * What it is **not** is a cursor-versus-stored-text divergence, which was the first guess and is
 * wrong: both SQL stores and the in-memory one build `nextCursor` from the **raw row** inside
 * `listPage`, below this decorator, so the cursor carries the stored spelling and the comparison is
 * like-for-like. Verified live — a one-row-per-page walk over five mixed-spelling rows issued
 * cursors reading `2026-01-31T05:00:00-05:00` and `2026-01-31T10:00:00Z`, and visited all five
 * exactly once.
 *
 * `date` and `time` keep `text` on the same test read the other way: a cast is warranted where a
 * plausible stored spelling orders differently from its value, and for those two every form
 * anything ever wrote is already the canonical one — `YYYY-MM-DD` from every server writer and
 * every date input, `HH:MM:SS` from a `TIME` column — so there is nothing for a cast to reorder.
 * Their divergent spellings (`2026-1-5`, `10:00`) are a 422 now and were never produced by a
 * writer. One cast for the kind where the divergence is the normal case, not three for symmetry.
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
  datetime: "timestamptz",
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
