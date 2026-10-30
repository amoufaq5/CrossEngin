import type { JsonSchema } from "./openapi-schema.js";
import { RESERVED_LIST_PARAMS, type ListConfig } from "./list-query.js";
import { FILTER_OPS, type FilterOp } from "./store.js";
import { listValueTypeFor } from "./list-value-types.js";

export interface ParameterDoc {
  readonly name: string;
  readonly in: "query";
  readonly required: false;
  readonly description: string;
  readonly schema: JsonSchema;
}

/**
 * What each fixed list parameter does, keyed by name — a total map over `RESERVED_LIST_PARAMS`, so
 * a seventh fixed parameter is a compile error here rather than a parameter the document omits
 * while the server reads it.
 *
 * `cursor`'s description is **one string whether or not `CURSOR_ENCRYPTION_SECRET` is set**, and
 * that is a decision rather than a simplification: `open()` tests only the `s1.` prefix and hands
 * anything else back as plaintext, so the set of values the server *accepts* is byte-for-byte
 * identical in both modes — only the values it *issues* differ. Branching on the mode would make
 * the document a function of a deployment secret, so two deployments of one manifest would publish
 * two different contracts for one parameter.
 */
const FIXED_PARAM_PROSE: Readonly<Record<(typeof RESERVED_LIST_PARAMS)[number], string>> = {
  limit: "Page size.",
  cursor:
    "An opaque page cursor, taken from a previous response's `nextCursor`. Treat it as opaque: it " +
    "is sealed when the deployment configures a cursor secret and reversible base64url otherwise, " +
    "and the accepted set is the same either way. Terminate a walk on `nextCursor === null` and " +
    "nothing else — a page may be short or empty while the cursor is still non-null.",
  sort: "Field to order by.",
  order: "Order direction.",
  fields:
    "Comma-separated projection: the response carries only these fields. Also accepted on the " +
    "single-record read.",
  q: "Free-text search across this entity's searchable fields.",
};

const FILTER_OP_PROSE: Readonly<Record<FilterOp, string>> = {
  eq: "equal to",
  ne: "not equal to",
  gt: "greater than",
  gte: "greater than or equal to",
  lt: "less than",
  lte: "less than or equal to",
  in: "one of (comma-separated, or the parameter repeated)",
  contains: "containing (case-insensitive substring)",
};

/**
 * The query parameters one entity-list operation accepts, derived from its `ListConfig`.
 *
 * Four shapes are forced by measurement rather than chosen.
 *
 * **`sort`/`order` are omitted where `sortableFields` is empty, and `q` where `searchableFields`
 * is.** Measured across the seven packs: 243 of 375 entities declare no sortable field and 23 no
 * searchable one. Declaring `sort` there with `schema: {enum: []}` would be JSON-Schema-valid and
 * validate nothing — a generated client would reject every value while the server accepts all of
 * them, which is a document stricter than the service it describes.
 *
 * **A filter parameter's schema is `{type: "string"}` and the declared value type goes in the
 * description**, never as a `format` or a numeric `type`. An uncomparable value is not a 400: the
 * SQL answers `FALSE` for a non-`ne` operator and `TRUE` for `ne`, so `?amount[gt]=n/a` returns
 * zero rows and `?amount[ne]=n/a` returns *every* row, both under a 200. A `type: "number"` here
 * would be a constraint only the client enforces — conservative, and still a false statement about
 * the server.
 *
 * **`limit`'s bounds come from this config and are never shared as a `$ref`.** The two parsers
 * genuinely disagree: the entity-list one is `Number.parseInt(raw, 10)` and the association one is
 * `Number` plus `Number.isInteger`, so `?limit=1e2` is **1** on the first and **100** on the
 * second, and `0x10` is the default against **16**. Measured over 18 probes with both bounds held
 * equal — so only the parser can differ — they disagree on **8**; against the real `Invoice`
 * config, whose `defaultLimit` is 100, on **14 of 18**. (An earlier draft said "6 of 14" and named
 * no probe set, so the ratio was unreproducible from the claim; it also understated the
 * divergence.) One `components/parameters/limit` would therefore be a false claim on one surface
 * or the other.
 *
 * **`api_key` appears in neither the parameters nor the security schemes**, measured: it is
 * recognised at `parse_auth_credential` (stage 4 of 17) and refused at `authenticate` (stage 5),
 * which are **3 and 2 stages before `match_route`** (stage 7), so it never reaches a list parameter
 * at all. (An earlier draft said "seven stages before `match_route`", which transposed that stage's
 * own 1-based ordinal into a distance and would put the refusal at index −1.) A `securityScheme` entry would be a *definition* a generator
 * reads as a supported credential and emits a client method for — which is the opposite of
 * ADR-0384's refusal.
 */
export const listQueryParameters = (
  config: ListConfig,
  /**
   * Each filterable field's comparison type, for the description. Optional because it is a
   * *courtesy* and not a constraint: omitting it loses a sentence and changes nothing a client may
   * send, which is the one thing a filter parameter's schema must not claim.
   */
  valueTypes: Readonly<Record<string, string>> = {},
): readonly ParameterDoc[] => {
  const out: ParameterDoc[] = [];
  const fixed = (name: (typeof RESERVED_LIST_PARAMS)[number], schema: JsonSchema, extra = ""): void => {
    out.push({
      name,
      in: "query",
      required: false,
      description: `${FIXED_PARAM_PROSE[name]}${extra === "" ? "" : ` ${extra}`}`,
      schema,
    });
  };

  fixed(
    "limit",
    { type: "integer", minimum: 1, maximum: config.maxLimit },
    `Defaults to ${String(config.defaultLimit)}; values above ${String(config.maxLimit)} are clamped rather than refused.`,
  );
  fixed("cursor", { type: "string" });

  if (config.sortableFields.length > 0) {
    fixed("sort", { type: "string", enum: [...config.sortableFields] });
    fixed("order", { type: "string", enum: ["asc", "desc"] });
  }
  if (config.searchableFields.length > 0) {
    fixed(
      "q",
      { type: "string" },
      `Matches any of: ${config.searchableFields.join(", ")}.`,
    );
  }
  if (config.fields.length > 0) {
    fixed("fields", { type: "string" }, `One or more of: ${config.fields.join(", ")}.`);
  }

  for (const field of config.filterableFields) {
    const valueType = valueTypes[field];
    const typeNote = valueType === undefined ? "" : ` Compared as ${valueType}.`;
    // The bare form first: `FILTER_KEY_RE` makes the bracket optional and `parseFilterKey` defaults
    // the operator to `eq`, so `?field=value` is a real parameter and not a shorthand the document
    // may leave out.
    out.push({
      name: field,
      in: "query",
      required: false,
      description: `Filter: \`${field}\` equal to this value.${typeNote}`,
      schema: { type: "string" },
    });
    for (const op of FILTER_OPS) {
      out.push({
        name: `${field}[${op}]`,
        in: "query",
        required: false,
        description: `Filter: \`${field}\` ${FILTER_OP_PROSE[op]} this value.${typeNote}`,
        schema: { type: "string" },
      });
    }
  }
  return out;
};

/**
 * The sentence an operation carries about parameters the document does **not** list, because
 * OpenAPI has no closed-world parameter construct and the distinction here is load-bearing.
 *
 * A reader of a parameter list cannot tell *this name is ignored* from *this name is refused*, and
 * for a list route those are different answers to different names: a parameter naming nothing is
 * ignored, while one naming a real field this entity declines to filter is a **400** — which is
 * exactly the distinction `ListConfig.fields` was built to make (ADR-0359). Leaving it implied
 * would let a document's silence read as permission, which is ADR-0337's direction.
 *
 * **`q` is the member that makes the note load-bearing rather than tidy, and an earlier draft
 * omitted it** — in the direction that misleads precisely the reader who consults the note. This
 * operation drops `q` from its parameter list exactly when the entity declares no searchable
 * field, and `q` is **not a field**, so the note's own first rule ("a name this entity does not
 * declare as a field is ignored") told such a reader the omission meant it was ignored. It is a
 * **400 `search_not_served`**, verified against `UNSERVED_LIST_OUTPUTS` and live on
 * `erp-core`'s `BomLine`, `PriceListItem` and `ExchangeRate` — 3 of its 51 list configs. So the
 * note that exists to stop a silence reading as permission had the same defect it names.
 *
 * The sort clause was wrong the same way and is measured now: `defaultSort` is empty on **34 of
 * `erp-core`'s 51** list configs, so "falls back to the declared default order" describes a
 * minority and the honest statement is that no ordering is guaranteed. That is the same majority
 * this module cites one paragraph above as the reason not to refuse an unsortable `?sort`, which
 * is what made the error easy to make and worth recording.
 */
export const LIST_PARAMETER_COMPLEMENT_NOTE =
  "Parameters not listed here are not all treated alike, and there are four outcomes. A name this " +
  "entity does not declare as a field is ignored, as on any HTTP surface. A name that IS one of " +
  "this entity's fields but is not filterable is refused with 400 `filter_not_served`. A " +
  "filterable field with an operator outside the eight listed is refused with 400 " +
  "`filter_operator_not_served`. And `q` — which this operation omits exactly when the entity " +
  "declares no searchable field, so it is NOT covered by the first rule, `q` not being a field — " +
  "is refused with 400 `search_not_served`. All three refusals exist because dropping the " +
  "predicate would widen the answer to rows the caller asked to exclude. An unsortable `?sort` is " +
  "NOT refused, because the rows are right and only their order is not the one asked for: it " +
  "falls back to this entity's default sort, which for most entities is empty, in which case the " +
  "store's own order is served and no ordering is guaranteed at all.";

/** The fixed parameters an association-list operation accepts, which has its own parser. */
export const associationListParameters = (bounds: {
  readonly defaultLimit: number;
  readonly maxLimit: number;
}): readonly ParameterDoc[] => [
  {
    name: "limit",
    in: "query",
    required: false,
    description: `Page size. Defaults to ${String(bounds.defaultLimit)}, maximum ${String(bounds.maxLimit)}. Parsed by the association route's own reader, which disagrees with the entity-list reader on several malformed inputs.`,
    schema: { type: "integer", minimum: 1, maximum: bounds.maxLimit },
  },
  {
    name: "cursor",
    in: "query",
    required: false,
    description:
      "An opaque page cursor. On an association list this is an offset into the owner's links " +
      "rather than a keyset, so it carries no field value.",
    schema: { type: "string" },
  },
];

/** The value type each filterable field is compared as, for the parameter descriptions. */
export const filterValueTypes = (
  config: ListConfig,
  fieldTypes: ReadonlyMap<string, Parameters<typeof listValueTypeFor>[0]>,
): Readonly<Record<string, string>> => {
  const out: Record<string, string> = {};
  for (const field of config.filterableFields) {
    const t = fieldTypes.get(field);
    if (t !== undefined) out[field] = listValueTypeFor(t);
  }
  return out;
};
