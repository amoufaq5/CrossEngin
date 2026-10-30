import { resolvedFields } from "@crossengin/kernel/ddl";
import type { Entity, Field, FieldType, PrimitiveFieldType, Trait } from "@crossengin/types/meta-schema";

/**
 * The subset of JSON Schema 2020-12 this emitter produces.
 *
 * Narrow on purpose: it is a *construction* type, never a parse target, so every member here is one
 * the emitter writes. `type` admits an array because OpenAPI 3.1 dropped `nullable` in favour of
 * `type: ["string", "null"]`, and a document still carrying `nullable` is a 3.0 document.
 */
export type JsonSchemaType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "object"
  | "array"
  | "null";

export interface JsonSchema {
  readonly type?: JsonSchemaType | readonly JsonSchemaType[];
  readonly format?: string;
  readonly pattern?: string;
  readonly enum?: readonly string[];
  readonly items?: JsonSchema;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly description?: string;
  readonly oneOf?: readonly JsonSchema[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly $ref?: string;
}

/**
 * Field kinds an OpenAPI schema cannot describe, with the reason — a *shape* answer in both cases
 * and not a wiring one.
 *
 * `duration` is the sharp member: its wire type is **undecided on purpose**.
 * `ColumnMappedEntityStore` refuses to read an `INTERVAL` at all (`UndecidedWireTypeError`) and a
 * manifest declaring one is refused at plan time on `--store pg-columns`, reported as a blocking
 * `unservable_field_type` by the per-tenant applier. So there is no spelling for a document to
 * describe, and inventing one — seconds? ISO 8601? — would be the document deciding a question four
 * ADRs left open. Measured: zero `duration` fields across all seven packs, so the entry has no
 * member today, which is when it is cheapest to be honest.
 *
 * It is a map rather than a set because the reason is the deliverable: a document that silently
 * omits a declared field is falsely complete (ADR-0337), so the emitter's caller reports these by
 * name instead.
 */
export const UNDESCRIBABLE_FIELD_KINDS: ReadonlyMap<PrimitiveFieldType["kind"], string> = new Map([
  [
    "duration",
    "the wire type is undecided (ADR-0334): the column store raises UndecidedWireTypeError rather " +
      "than reading an INTERVAL, and a manifest declaring one is refused at plan time",
  ],
]);

/**
 * What the server **emits** for each field kind.
 *
 * A total map over `PrimitiveFieldType["kind"]` — the fifth dispatcher over that union and the
 * second that is a compile-time fence (`primitiveFieldTypeToPostgresType`'s exhaustive switch,
 * `FIELD_TYPE_CHECKS` and `FIELD_LIST_VALUE_TYPES` are the others; `uiInput`'s
 * `default: return "text"` is the one that is not, and it is why a 24th kind would be rendered as a
 * text box there and must not be here).
 *
 * It is its own map rather than derived from `FIELD_LIST_VALUE_TYPES`, which answers a different
 * question: that one gives a **comparison** type over three values, so `boolean` is `text` there
 * and must be `boolean` here. What this map does take from it is the authority for the wire form —
 * that constant's doc comment is where the canonical spelling of every kind is decided, and these
 * entries read it rather than re-deriving it.
 *
 * Three entries were measured rather than read, because the stored type and the wire type differ:
 *
 * - **`decimal` is a `string`**, not a number: `toDecimalWire` renders
 *   `-?\d+(\.\d{scale})?` with the scale always present, so `decimal(10,2)` emits `"10.50"`.
 *   ADR-0332 made it a string precisely because converting a `NUMERIC(38,10)` to a JS number is
 *   lossy, so describing it as `type: "number"` would invite the coercion the wire type exists to
 *   prevent.
 * - **`reference` is not a uuid.** `fieldTypeToPostgresType` answers `UUID` and
 *   `column-plan.ts` overrides it to `TEXT` holding the target's record id, measured as
 *   `rec_mvvfkrrn0001`. A `format: "uuid"` here would be wrong on every reference field in the
 *   workspace.
 * - **`time` is not fixed width.** `toTimeWire("10:00:00.123456")` passes the fraction through
 *   unbounded, so a `pattern` anchored at three digits would refuse what the server emits.
 */
export const FIELD_RESPONSE_SCHEMAS: {
  readonly [K in PrimitiveFieldType["kind"]]: (
    type: Extract<PrimitiveFieldType, { kind: K }>,
  ) => JsonSchema | null;
} = {
  text: (t) => ({ type: "string", ...(t.maxLength !== undefined ? { description: `max ${String(t.maxLength)} characters` } : {}) }),
  long_text: () => ({ type: "string" }),
  integer: () => ({ type: "integer" }),
  decimal: (t) => ({
    type: "string",
    pattern: `^-?\\d+${t.scale > 0 ? `\\.\\d{${String(t.scale)}}` : ""}$`,
    description:
      `A canonical decimal string at scale ${String(t.scale)}, precision ${String(t.precision)} ` +
      `(ADR-0332). Not a JSON number: parsing it as one is lossy.`,
  }),
  boolean: () => ({ type: "boolean" }),
  date: () => ({ type: "string", format: "date", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
  time: () => ({
    type: "string",
    // `HH:MM:SS` plus an OPTIONAL and unbounded fraction — measured, not assumed.
    pattern: "^\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?$",
  }),
  datetime: () => ({
    type: "string",
    format: "date-time",
    // Fixed width 24, always UTC, always three fraction digits (ADR-0334).
    pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$",
  }),
  duration: () => null,
  uuid: () => ({ type: "string", format: "uuid" }),
  enum: (t) => ({ type: "string", enum: [...t.values] }),
  reference: (t) => ({
    type: "string",
    description: `The id of a ${t.target} record. Record ids are generated \`rec_\` + base36, and a caller-supplied id is kept as given, so no pattern is enforced.`,
  }),
  json: () => ({ description: "An arbitrary JSON document." }),
  file: () => ({ type: "string", description: "A file reference." }),
  email: () => ({ type: "string", format: "email" }),
  phone: () => ({ type: "string" }),
  url: () => ({ type: "string", format: "uri" }),
  currency_amount: () => ({ description: "A currency amount document." }),
  geo_point: () => ({ description: "A geographic point." }),
  geo_polygon: () => ({ description: "A geographic polygon." }),
  country_code: () => ({ type: "string", description: "An ISO 3166-1 country code." }),
  language_code: () => ({ type: "string", description: "A BCP 47 language tag." }),
  timezone: () => ({ type: "string", description: "An IANA time zone name." }),
};

/**
 * What a request may **send** for each field kind.
 *
 * A separate map and not a looser reading of the one above, because the two sets genuinely differ
 * and the request is always the wider — measured through the real converters for the four kinds
 * where it matters:
 *
 * - `decimal(10,2)` accepts the JSON number `10.5`, and the strings `"1e3"`, `" 10.25 "`,
 *   `"+10.25"` and the over-precise `"10.555"`, while emitting `"10.50"` / `"1000.00"` / `"10.56"`.
 * - `datetime` accepts any RFC 3339 instant carrying an offset — `2026-01-31T19:00:00+09:00` and
 *   `…​.1Z` both normalise to the 24-character UTC form — and the request parser additionally
 *   admits a space separator and a lowercase `z`, which a client validating `format: "date-time"`
 *   would typically reject. So `format` here understates what the server takes and overstates
 *   nothing.
 * - `time` accepts `10:00`, emitting `10:00:00`.
 * - `date` is the one that does **not** widen: `toDateWire` refuses a full ISO instant
 *   (`not_a_calendar_date`) and refuses `2026-1-5`, so request and response are the same set. That
 *   is worth stating because the obvious assumption is the other way.
 *
 * One schema per field would therefore be a lie in one direction or the other: the strict form
 * overstates what a client must send, and the loose form understates the precision the response
 * carries.
 */
export const FIELD_REQUEST_SCHEMAS: {
  readonly [K in PrimitiveFieldType["kind"]]: (
    type: Extract<PrimitiveFieldType, { kind: K }>,
  ) => JsonSchema | null;
} = {
  ...FIELD_RESPONSE_SCHEMAS,
  decimal: (t) => ({
    oneOf: [{ type: "string" }, { type: "number" }],
    description:
      `A decimal at scale ${String(t.scale)}, precision ${String(t.precision)}. A JSON number, or ` +
      `a string — which is the form to send when the value has more precision than a double holds. ` +
      `The response is always a canonical string at the declared scale.`,
  }),
  datetime: () => ({
    type: "string",
    format: "date-time",
    description:
      "Any RFC 3339 instant carrying an offset; normalised to UTC with three fraction digits in " +
      "the response. An instant with no offset is refused, because it names no instant.",
  }),
  time: () => ({
    type: "string",
    // Request also accepts `HH:MM`, which the response renders `HH:MM:SS`.
    pattern: "^\\d{1,2}:\\d{2}(:\\d{2}(\\.\\d+)?)?$",
  }),
};

const wrap = (
  type: FieldType,
  map:
    | typeof FIELD_RESPONSE_SCHEMAS
    | typeof FIELD_REQUEST_SCHEMAS,
): JsonSchema | null => {
  if (type.kind === "array") {
    const element = map[type.element.kind](type.element as never);
    return element === null ? null : { type: "array", items: element };
  }
  return map[type.kind](type as never);
};

/** The schema for one field's declared type as the server emits it, or `null` if undescribable. */
export const fieldResponseSchema = (type: FieldType): JsonSchema | null =>
  wrap(type, FIELD_RESPONSE_SCHEMAS);

/** The schema for one field's declared type as a request may send it, or `null`. */
export const fieldRequestSchema = (type: FieldType): JsonSchema | null =>
  wrap(type, FIELD_REQUEST_SCHEMAS);

/** Whether the create path fills this field when the client omits it. */
export interface CreateWiring {
  /** `--store`'s settings store is wired, so a settings-driven default can fill a field. */
  readonly settingsStore: boolean;
  /** A sequence allocator is wired, so a `sequence` default can fill one. */
  readonly allocator: boolean;
}

/**
 * Whether the server fills this field on create, so a client need not send it even when the
 * manifest marks it `required`.
 *
 * This is the question that separates 395 from 136, and getting it wrong overstates a create
 * request's obligations by **2.9x**: of 630 resolved fields in `erp-core`, 395 are `required` and
 * only ~139 carry no default at all — 140 have a `literal` default, 102 an `expression` one (every
 * trait-contributed `created_at`/`updated_at`), and 14 a `sequence`. `validateBody` runs *after*
 * defaults are applied, under its own comment saying so, which is what makes the distinction real
 * rather than cosmetic.
 *
 * Two arms depend on **deployment wiring** rather than on the manifest, which is why this takes a
 * `CreateWiring` instead of a field alone: a `sequence` default fills nothing when no allocator is
 * wired (`applyEntitySequences` returns the body unchanged), and the settings-driven currency and
 * due-date defaults fill nothing without a settings store. So the honest `required` set is a
 * property of the manifest *and* the deployment, and a document that ignored that would promise a
 * server-filled field on a deployment that cannot fill it.
 *
 * `serverManaged` is deliberately not consulted here: `validateBody` skips such a field
 * unconditionally, so it is never a client obligation whatever the wiring.
 */
export const serverFillsOnCreate = (field: Field, wiring: CreateWiring): boolean => {
  const kind = field.default?.kind;
  if (kind === "literal" || kind === "expression") return true;
  if (kind === "sequence") return wiring.allocator;
  // The settings-driven fills, read off `settingsDefaultPlan`'s own predicate rather than copied
  // from `ui-schema.ts`'s `isServerDefaulted`, which treats `currency_amount` as filled
  // **unconditionally** — wrong here, because without a settings store nothing fills it and the
  // field is a client obligation after all.
  if (wiring.settingsStore) {
    if (field.name === "currency" || field.type.kind === "currency_amount") return true;
    if (field.name === "due_date") return true;
  }
  return false;
};

export interface EntitySchemas {
  readonly response: JsonSchema;
  readonly create: JsonSchema;
  readonly update: JsonSchema;
  /** Fields the document could not describe, by name, with the reason. */
  readonly undescribable: readonly { readonly field: string; readonly reason: string }[];
}

/**
 * The three body schemas for one entity, over **`resolvedFields`** and never `entity.fields`.
 *
 * The aperture is the whole correctness question here and it is ADR-0361's class. `entity.fields`
 * is not the set the served table has — a trait contributes more — and the gap is not marginal:
 * measured on `erp-core`, **51 of 51 entities differ, 426 own fields against 630 resolved, so 204
 * fields (32.4%) are outside the narrow aperture**, exactly 51 x 4 because every entity is
 * `auditable`. `ui-schema.ts`, the sibling artifact served at `GET /v1/meta/schema`, reads the
 * narrow set, which is why `created_at`/`updated_at` appear in no view — and measured through the
 * real create handler they **are** in the response body. So an emitter reusing `uiField` would
 * describe 426 of 630 fields, a document missing a third of every entity.
 *
 * `id` is added to the response and to neither request: `resolvedFields` deliberately excludes the
 * implicit primary key, and `RESERVED_ENTITY_FIELD_NAMES` refuses a field declaring either name, so
 * nothing derived from the manifest can collide with it. No `pattern` is emitted for it, because
 * the `rec_` + base36 shape is the *generator's* and `resolveRecordId` keeps a caller-supplied id as
 * given — a pattern would describe a constraint this API does not enforce, which is the
 * falsely-specific direction of the same mistake as a falsely-complete path list.
 *
 * `additionalProperties` is **not** set to `false`, and that is a measurement rather than caution:
 * an unknown key is accepted, stored and echoed by the JSONB and in-memory stores and silently
 * dropped by the column store, so the two stores answer one create with different bodies. `false`
 * would be false of two of the three; `true` would promise the column store's drop is a round trip.
 * Saying nothing is the only honest answer, and the asymmetry is reported instead.
 */
export const entitySchemas = (
  entity: Entity,
  customTraits: readonly Trait[],
  wiring: CreateWiring,
): EntitySchemas => {
  const fields = resolvedFields(entity, customTraits);
  const responseProps: Record<string, JsonSchema> = {
    id: {
      type: "string",
      description: "The record id. Generated as `rec_` + base36; a caller-supplied id is kept.",
    },
  };
  const createProps: Record<string, JsonSchema> = {};
  const updateProps: Record<string, JsonSchema> = {};
  const createRequired: string[] = [];
  const undescribable: { field: string; reason: string }[] = [];

  for (const field of fields) {
    const resp = fieldResponseSchema(field.type);
    const req = fieldRequestSchema(field.type);
    if (resp === null || req === null) {
      const kind = field.type.kind === "array" ? field.type.element.kind : field.type.kind;
      undescribable.push({
        field: field.name,
        reason: UNDESCRIBABLE_FIELD_KINDS.get(kind) ?? `no schema for field kind ${kind}`,
      });
      continue;
    }
    responseProps[field.name] = resp;
    createProps[field.name] = req;
    updateProps[field.name] = req;
    if (field.required === true && !serverFillsOnCreate(field, wiring)) {
      createRequired.push(field.name);
    }
  }

  return {
    response: { type: "object", properties: responseProps, required: ["id"] },
    create: {
      type: "object",
      properties: createProps,
      ...(createRequired.length > 0 ? { required: createRequired } : {}),
    },
    // An update is a partial by construction: the handler merges the patch into the stored record,
    // so every property is optional and `required` is absent rather than empty.
    update: { type: "object", properties: updateProps },
    undescribable,
  };
};
