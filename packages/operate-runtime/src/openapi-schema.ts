import { resolvedFields } from "@crossengin/kernel/ddl";
import type { Manifest } from "@crossengin/kernel/manifest";
import type { Entity, Field, FieldType, PrimitiveFieldType, Trait } from "@crossengin/types/meta-schema";

import {
  CALLER_RECORD_ID_PATTERN,
  EXPECTED_UPDATED_AT_KEY,
  SERVER_OWNED_ADMITTED,
  type WriteSurface,
} from "./write-surface.js";

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
  readonly enum?: readonly (string | number)[];
  readonly items?: JsonSchema;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly description?: string;
  readonly oneOf?: readonly JsonSchema[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly readOnly?: boolean;
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
  // No `type`: the value is unconstrained (`FIELD_TYPE_CHECKS.file` is `acceptAny`) and both stores
  // keep any JSON value, so `type: "string"` was a constraint only a generated client enforced.
  // "A file reference" claimed what this binary cannot honour — it has no object storage and nothing
  // resolves a value to file content — and what a file value *is* stays undecided, so this says less.
  file: () => ({
    description:
      "Any JSON value. Its shape is not validated, and the server does not resolve it to stored file content.",
  }),
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
 * - `decimal(10,2)` accepts the JSON number `10.5` and the strings `"1e3"`, `" 10.25 "` and
 *   `"+10.25"`, while emitting `"10.50"` / `"1000.00"`. It does **not** accept the over-precise
 *   `"10.555"`, which an earlier draft listed here and which is a **422** —
 *   `precision: amount must have at most 2 decimal place(s)`, because `validateBody`'s own comment
 *   states the rule that a client literal carrying more precision than the field holds is refused
 *   rather than rounded. `toDecimalWire` *would* emit `"10.56"` for it, which is what that draft
 *   conflated: what the converter can render is not what a request may send. The three surviving
 *   examples are what the two maps rest on and they reproduce exactly. The emitted request schema
 *   is correspondingly a little wider than the server — `oneOf: [string, number]` with no pattern
 *   and no precision bound — which is the same deliberate choice a filter parameter's bare
 *   `{type: "string"}` rests on: a constraint only the client enforces would still be a false
 *   statement about what this API accepts, and here it would reject `"1e3"`, which it takes.
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

/**
 * Whether a client may omit this field on create even though the manifest marks it `required`.
 *
 * It answers a question about the **client's obligation**, which is what a request schema's
 * `required` array means — deliberately not "does the server fill it", which is the name this
 * function used to carry and is what produced both of the defects it no longer has. The two differ
 * in exactly the places that mattered: a `sequence` field is one the server fills *only when an
 * allocator is wired* and one the client is *never obliged to send*, and a settings-defaulted field
 * is one the server fills *for some tenants*.
 *
 * Measured on `erp-core`: of **630** resolved fields, **395** are `required`, and the three default
 * kinds account for 140 `literal`, 102 `expression` (every trait-contributed `created_at` /
 * `updated_at`) and 14 `sequence` — every one of them on a `required` field. So the document's
 * create obligation is **139**, a factor of **2.84** below the manifest's own `required` count, and
 * the figure is exactly *the required fields that carry no default at all*, which is a statement a
 * reader can check rather than a number to trust. `validateBody` runs **after** defaults are
 * applied, under its own comment saying so, which is what makes the distinction real.
 *
 * The `sequence` arm is unconditional, and its comment used to say so while the code did not:
 * `buildValidationPlans` sets `serverManaged: f.default?.kind === "sequence"` and `validateBody`
 * skips a `serverManaged` rule **unconditionally**, so such a field is never a client obligation
 * whatever the wiring. Reading the allocator here made the document *stricter than the server* on
 * 14 of `erp-core`'s fields — measured, a create omitting `invoice_number` with no allocator wired
 * answers **201** and stores `invoice_number: undefined`. Overstating is the safe direction, which
 * is why it survived; it was still a false sentence in a published contract, and it masked the
 * defect underneath, which is that nothing refuses that record.
 *
 * There is **no settings arm**, and its absence is the load-bearing decision. `applySettingsDefaults`
 * fills a currency field only when the tenant's `defaults.currency` is set and `due_date` only when
 * `finance.defaultPaymentTermsDays` is, so the obligation differs **per tenant** — while
 * `/v1/meta/openapi` serves one document per compiled server, memoised, for every tenant that
 * reaches it. A settings-dependent `required` set is therefore not expressible in this document at
 * all, and the arm that read `settingsStore !== undefined` was answering a question about the
 * deployment that only the tenant's own row can answer. Measured live through the real create
 * handler: a request carrying exactly the old document's required set answered **422** naming
 * `currency` and `due_date` on a fresh tenant and **201** once those settings were populated — so
 * the old answer was wrong in the understating direction on every tenant's first invoice, on three
 * live fields (`Invoice.currency`, `Invoice.due_date`, `Bill.due_date`). A client that sends a
 * field the server would have defaulted loses nothing: a caller's value always wins.
 */
export const omittableOnCreate = (field: Field): boolean => {
  const kind = field.default?.kind;
  return kind === "literal" || kind === "expression" || kind === "sequence";
};

/** The lifecycle facts the request schemas need: which field holds the state and where a record starts. */
export interface EntityLifecycleShape {
  readonly stateField: string;
  readonly initialState: string;
}

/**
 * An entity's lifecycle shape, or `null` for an entity with none. The first `entityLifecycle` wins,
 * which is `lifecycleStateField`'s reading and the guard compile's: one entity, one lifecycle.
 */
export function entityLifecycleShape(manifest: Manifest, entityName: string): EntityLifecycleShape | null {
  for (const wf of Object.values(manifest.workflows ?? {})) {
    if (wf.kind === "entityLifecycle" && wf.entity === entityName) {
      return { stateField: wf.stateField, initialState: wf.initialState };
    }
  }
  return null;
}

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
 * `id` is added to the response and to the create request, which keeps a caller-supplied id, with
 * the pattern the create handler refuses outside of (`record_id_malformed`). It is in no update
 * request, and neither is any other field the server owns (`writeSurfaceRefusal`): a field the
 * server stamps is described on the response and in neither request, because both requests refuse
 * it 422 — publishing it as writable would hand a generated client a property every request fails
 * on.
 *
 * `additionalProperties` is `false` on both requests, which is true now and was not before the
 * write surface: an undeclared key used to be stored by the JSONB and in-memory stores and dropped
 * by the column store, so no value of the keyword described all three. The handler refuses it 422
 * before any store sees the body, so every store answers alike.
 *
 * All three schemas are a function of **the manifest alone** — this took a `CreateWiring` until the
 * two arms that read it were measured, and neither survived: see `omittableOnCreate`. That is a
 * property worth keeping rather than an accident, because `/v1/meta/openapi` memoises one document
 * per compiled server and serves it to every tenant that reaches it, so a schema varying with
 * anything *but* the manifest cannot be right for all of them at once.
 */
export const entitySchemas = (
  entity: Entity,
  customTraits: readonly Trait[],
  /**
   * Required and nullable rather than optional: a lifecycle state field is not freely writable, and
   * a caller that forgot to say so would publish it as one — the omission indistinguishable from an
   * entity that has no lifecycle (ADR-0386's rule that an optional input defaulting to the
   * permissive answer makes its own omission unobservable).
   */
  lifecycle: EntityLifecycleShape | null,
  /** Which fields the server owns, so a request schema does not offer them. See `buildWriteSurfaces`. */
  surface: WriteSurface,
): EntitySchemas => {
  const fields = resolvedFields(entity, customTraits);
  const responseProps: Record<string, JsonSchema> = {
    id: {
      type: "string",
      description: "The record id. Generated as `rec_` + base36; a caller-supplied id is kept.",
    },
  };
  const createProps: Record<string, JsonSchema> = {
    id: {
      type: "string",
      pattern: CALLER_RECORD_ID_PATTERN.source,
      description:
        "Optional. Kept as the record id when supplied (an import keeping its source ids); an id that already exists is refused 409.",
    },
  };
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
    if (lifecycle !== null && field.name === lifecycle.stateField) {
      // The server refuses every create value but the initial state and every update value but the
      // stored one (`lifecycleStateGuard`), so publishing the field's full enum as writable told a
      // generated client it could do what each request then answered 422 to. On create the property
      // is an enum of one; on update it is `readOnly`, which a client should not send — re-sending the
      // stored value is admitted, which is why it stays described rather than removed.
      createProps[field.name] = {
        ...req,
        enum: [lifecycle.initialState],
        description:
          `Every record is created in '${lifecycle.initialState}'; omit it or send that value. ` +
          `'${field.name}' moves only through this entity's lifecycle transition routes.`,
      };
      updateProps[field.name] = {
        ...req,
        readOnly: true,
        description:
          `Not changeable by an update: '${field.name}' moves only through this entity's lifecycle ` +
          `transition routes. Re-sending the stored value is accepted; any other value is refused 422.`,
      };
    } else {
      const owned = surface.serverOwned.get(field.name);
      if (owned === undefined || SERVER_OWNED_ADMITTED[owned].create) createProps[field.name] = req;
      if (owned === undefined || SERVER_OWNED_ADMITTED[owned].update) updateProps[field.name] = req;
    }
    if (field.required === true && !omittableOnCreate(field) && field.name in createProps) {
      createRequired.push(field.name);
    }
  }

  return {
    response: { type: "object", properties: responseProps, required: ["id"] },
    create: {
      type: "object",
      properties: createProps,
      ...(createRequired.length > 0 ? { required: createRequired } : {}),
      additionalProperties: false,
    },
    // An update is a partial by construction: the handler merges the patch into the stored record,
    // so every property is optional and `required` is absent rather than empty.
    // The concurrency token rides beside the fields; closing the body without it would describe the
    // token the console sends on every edit as a request this API refuses.
    update: {
      type: "object",
      properties: {
        ...updateProps,
        [EXPECTED_UPDATED_AT_KEY]: {
          type: "string",
          description:
            "Optional. The `updated_at` this client last read; the update is refused 409 when the record has moved since. Not stored.",
        },
      },
      additionalProperties: false,
    },
    undescribable,
  };
};
