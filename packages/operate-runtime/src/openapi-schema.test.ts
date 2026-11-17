import { describe, expect, it } from "vitest";

import { resolvedFields } from "@crossengin/kernel/ddl";
import { buildErpCorePack } from "@crossengin/pack-erp-core";
import type { Entity, Field, PrimitiveFieldType } from "@crossengin/types/meta-schema";

import {
  FIELD_REQUEST_SCHEMAS,
  FIELD_RESPONSE_SCHEMAS,
  UNDESCRIBABLE_FIELD_KINDS,
  entityLifecycleShape,
  entitySchemas,
  fieldRequestSchema,
  fieldResponseSchema,
  omittableOnCreate,
} from "./openapi-schema.js";
import { defaultEffectStamps } from "./compile.js";
import { buildWriteSurfaces, type WriteSurface } from "./write-surface.js";

const KINDS: readonly PrimitiveFieldType["kind"][] = [
  "text",
  "long_text",
  "integer",
  "decimal",
  "boolean",
  "date",
  "time",
  "datetime",
  "duration",
  "uuid",
  "enum",
  "reference",
  "json",
  "file",
  "email",
  "phone",
  "url",
  "currency_amount",
  "geo_point",
  "geo_polygon",
  "country_code",
  "language_code",
  "timezone",
];

const field = (name: string, type: Field["type"], extra: Partial<Field> = {}): Field =>
  ({ name, type, ...extra }) as Field;

describe("FIELD_RESPONSE_SCHEMAS / FIELD_REQUEST_SCHEMAS", () => {
  it("are total over all 23 primitive field kinds", () => {
    // The fence: a 24th kind must be a compile error here rather than a field rendered as a text
    // box, which is what `uiInput`'s `default: return "text"` does one module over.
    expect(KINDS).toHaveLength(23);
    for (const kind of KINDS) {
      expect(typeof FIELD_RESPONSE_SCHEMAS[kind], kind).toBe("function");
      expect(typeof FIELD_REQUEST_SCHEMAS[kind], kind).toBe("function");
    }
    expect(Object.keys(FIELD_RESPONSE_SCHEMAS).sort()).toEqual([...KINDS].sort());
    expect(Object.keys(FIELD_REQUEST_SCHEMAS).sort()).toEqual([...KINDS].sort());
  });

  it("describes a decimal as a canonical STRING on the response, never a number", () => {
    // ADR-0332: converting a NUMERIC(38,10) to a JS number is lossy, which is why the wire form is
    // a string. `type: "number"` here would invite exactly the coercion the wire type prevents.
    const s = fieldResponseSchema({ kind: "decimal", precision: 10, scale: 2 } as Field["type"]);
    expect(s?.type).toBe("string");
    expect(s?.pattern).toBe("^-?\\d+\\.\\d{2}$");
    expect(new RegExp(s?.pattern ?? "").test("10.50")).toBe(true);
    expect(new RegExp(s?.pattern ?? "").test("10.5")).toBe(false);
  });

  it("publishes no wire type for a file field, the shape json and currency_amount already have", () => {
    // `FIELD_TYPE_CHECKS.file` is acceptAny and both stores keep any JSON value, so the old
    // `type: "string"` was a constraint only a generated client enforced — and "A file reference"
    // promised a resolution this binary has no storage to perform. The three JSONB-typed kinds now
    // share one shape: a description and no type.
    for (const kind of ["file", "json", "currency_amount"] as const) {
      for (const s of [fieldResponseSchema({ kind } as Field["type"]), fieldRequestSchema({ kind } as Field["type"])]) {
        expect(s?.type, kind).toBeUndefined();
        expect(Object.keys(s ?? {}), kind).toEqual(["description"]);
      }
    }
    const file = fieldResponseSchema({ kind: "file" } as Field["type"]);
    expect(file?.description).not.toMatch(/file reference/i);
    expect(file?.description).toMatch(/does not resolve it to stored file content/);
  });

  it("accepts a decimal as either a string or a number on the request, because the server does", () => {
    // Measured through the real converter: toDecimalWire accepts 10.5, "1e3", " 10.25 ", "+10.25"
    // and the over-precise "10.555", emitting "10.50" / "1000.00" / "10.56". One schema for both
    // directions would be a lie in one of them.
    const s = fieldRequestSchema({ kind: "decimal", precision: 10, scale: 2 } as Field["type"]);
    expect(s?.oneOf?.map((o) => o.type)).toEqual(["string", "number"]);
    expect(s?.pattern).toBeUndefined();
  });

  it("pins a datetime response to the 24-character UTC form and widens the request", () => {
    const resp = fieldResponseSchema({ kind: "datetime" } as Field["type"]);
    const req = fieldRequestSchema({ kind: "datetime" } as Field["type"]);
    const re = new RegExp(resp?.pattern ?? "");
    expect(re.test("2026-01-31T10:00:00.000Z")).toBe(true);
    expect(re.test("2026-01-31T19:00:00+09:00")).toBe(false);
    // The request carries no pattern, because the server normalises any offset-bearing instant.
    expect(req?.pattern).toBeUndefined();
    expect(req?.format).toBe("date-time");
  });

  it("does NOT widen date, because the server does not", () => {
    // The obvious assumption is that every temporal kind widens on the request. Measured:
    // toDateWire REFUSES a full ISO instant (`not_a_calendar_date`) and refuses `2026-1-5`, so
    // request and response are one set here.
    const resp = fieldResponseSchema({ kind: "date" } as Field["type"]);
    const req = fieldRequestSchema({ kind: "date" } as Field["type"]);
    expect(req).toEqual(resp);
    expect(new RegExp(resp?.pattern ?? "").test("2026-01-31T00:00:00.000Z")).toBe(false);
  });

  it("leaves a time response's fraction unbounded, because toTimeWire passes it through", () => {
    const re = new RegExp(fieldResponseSchema({ kind: "time" } as Field["type"])?.pattern ?? "");
    expect(re.test("10:00:00")).toBe(true);
    expect(re.test("10:00:00.123456")).toBe(true);
    // …and the request additionally takes `HH:MM`, which the response renders `10:00:00`.
    const reqRe = new RegExp(fieldRequestSchema({ kind: "time" } as Field["type"])?.pattern ?? "");
    expect(reqRe.test("10:00")).toBe(true);
    expect(re.test("10:00")).toBe(false);
  });

  it("does not claim a reference is a uuid", () => {
    // `fieldTypeToPostgresType` answers UUID and the column plan overrides it to TEXT holding the
    // target's record id — measured as `rec_mvvfkrrn0001`. `format: "uuid"` would be wrong on every
    // reference field in the workspace (78 in erp-core alone).
    const s = fieldResponseSchema({ kind: "reference", target: "Account" } as Field["type"]);
    expect(s?.type).toBe("string");
    expect(s?.format).toBeUndefined();
    expect(s?.description).toContain("Account");
  });

  it("answers null for duration, the one kind whose wire type is undecided", () => {
    expect(fieldResponseSchema({ kind: "duration" } as Field["type"])).toBeNull();
    expect(fieldRequestSchema({ kind: "duration" } as Field["type"])).toBeNull();
    expect(UNDESCRIBABLE_FIELD_KINDS.get("duration")).toContain("undecided");
    // Exactly one undescribable kind, so the map is not a growing excuse list.
    expect([...UNDESCRIBABLE_FIELD_KINDS.keys()]).toEqual(["duration"]);
  });

  it("wraps an array field, and propagates its element's undescribability", () => {
    expect(fieldResponseSchema({ kind: "array", element: { kind: "text" } } as Field["type"])).toEqual({
      type: "array",
      items: { type: "string" },
    });
    expect(
      fieldResponseSchema({ kind: "array", element: { kind: "duration" } } as Field["type"]),
    ).toBeNull();
  });
});

describe("omittableOnCreate", () => {
  it("treats a literal or expression default as omittable", () => {
    expect(omittableOnCreate(field("a", { kind: "text" }, { default: { kind: "literal", value: "x" } }))).toBe(true);
    expect(omittableOnCreate(field("b", { kind: "datetime" }, { default: { kind: "expression", expression: "now()" } }))).toBe(true);
  });

  it("treats a sequence default as omittable UNCONDITIONALLY, because validateBody does", () => {
    // The arm that used to read `wiring.allocator`. `buildValidationPlans` sets
    // `serverManaged: f.default?.kind === "sequence"` and `validateBody` skips a `serverManaged`
    // rule with no reference to any wiring, so such a field is never a client obligation — measured
    // live, a create omitting `invoice_number` with no allocator wired answers 201 and stores
    // `undefined`. Reading the allocator made the document stricter than the server on 14 of
    // `erp-core`'s fields, in contradiction of the comment four lines above it.
    const f = field("n", { kind: "text" }, { default: { kind: "sequence", sequence: "s" } });
    expect(omittableOnCreate(f)).toBe(true);
  });

  it("treats a settings-fillable field as a client obligation, because the fill is per tenant", () => {
    // There is deliberately no settings arm. `applySettingsDefaults` fills a currency field only
    // when the tenant's `defaults.currency` is set and `due_date` only when
    // `finance.defaultPaymentTermsDays` is, so the obligation is a property of the TENANT while
    // this document is one per compiled server. Measured live: a create carrying exactly the old
    // required set answered 422 naming `currency` and `due_date` on a fresh tenant and 201 once
    // those settings were populated, so the old answer was wrong in the understating direction on
    // every tenant's first invoice. Overstating costs a caller nothing, because a caller's value
    // always wins over a default.
    for (const f of [
      field("amount", { kind: "currency_amount" }),
      field("currency", { kind: "text" }),
      field("due_date", { kind: "date" }),
    ]) {
      expect(omittableOnCreate(f), f.name).toBe(false);
    }
  });

  it("answers false for an ordinary required field with no default", () => {
    expect(omittableOnCreate(field("name", { kind: "text" }, { required: true }))).toBe(false);
  });
});

describe("entitySchemas over the real erp-core pack", () => {
  const manifest = buildErpCorePack();
  const traits = manifest.traits ?? [];
  const entities: readonly Entity[] = manifest.entities ?? [];
  const entity = (name: string): Entity => {
    const found = entities.find((e) => e.name === name);
    if (found === undefined) throw new Error(`no entity ${name}`);
    return found;
  };
  const surfaces = buildWriteSurfaces(manifest, defaultEffectStamps(manifest));
  const surfaceOf = (e: Entity): WriteSurface => {
    const found = surfaces.get(e.name);
    if (found === undefined) throw new Error(`no surface for ${e.name}`);
    return found;
  };

  it("describes the RESOLVED field set, which is a third wider than the entity's own", () => {
    // ADR-0361's class, and the whole correctness question for this module. Measured: 51 of 51
    // entities differ, 427 own fields against 631 resolved (426 and 630 until
    // `BillLine.purchase_order_line_id`) — 204 outside the narrow aperture,
    // exactly 51 x 4 because every entity is `auditable`. The sibling artifact `ui-schema.ts` reads
    // the narrow set, which is why `created_at`/`updated_at` appear in no view; measured through the
    // real create handler they ARE in the response body.
    let own = 0;
    let resolved = 0;
    let props = 0;
    for (const e of entities) {
      own += e.fields.length;
      resolved += resolvedFields(e, traits).length;
      props += Object.keys(
        entitySchemas(e, traits, null, surfaceOf(e)).response.properties ?? {},
      ).length;
    }
    expect(own).toBe(427);
    expect(resolved).toBe(631);
    // One `id` added per entity, and nothing dropped.
    expect(props).toBe(resolved + entities.length);
  });

  it("carries the four trait fields a narrow read would omit", () => {
    const v = entitySchemas(entity("Vendor"), traits, null, surfaceOf(entity("Vendor")));
    const names = Object.keys(v.response.properties ?? {});
    for (const n of ["created_at", "updated_at", "created_by", "updated_by"]) {
      expect(names, n).toContain(n);
    }
    expect(names).toContain("id");
  });

  it("requires exactly the 139 required fields that carry no default, of 395 declared", () => {
    // The figure that separates a usable create schema from an unusable one: a naive
    // `field.required === true` read overstates a client's obligations by 2.84x, because
    // `validateBody` runs AFTER defaults are applied.
    //
    // This used to assert 153 unwired and 136 wired, and the spread WAS the defect: the 14
    // sequence-defaulted fields are never a client obligation (validateBody skips them with no
    // reference to the wiring) and the 3 settings-fillable ones always are (the fill depends on the
    // tenant's own settings row, which no document serving every tenant can be right about). So the
    // test pinned both halves of ADR-0392's own understating defect as the intended behaviour —
    // ADR-0372's class — and the honest property is that there is no spread at all.
    //
    // Derived rather than hardcoded on the right-hand side: the assertion is that the document's
    // required set IS "required and carrying no default", which a reader can check, with 139 beside
    // it only so a change in the pack moves a named number rather than silently agreeing.
    let declared = 0;
    let noDefault = 0;
    let required = 0;
    for (const e of entities) {
      const fields = resolvedFields(e, traits);
      declared += fields.filter((f) => f.required === true).length;
      noDefault += fields.filter((f) => f.required === true && f.default === undefined).length;
      required += entitySchemas(e, traits, null, surfaceOf(e)).create.required?.length ?? 0;
    }
    expect(declared).toBe(395);
    expect(required).toBe(noDefault);
    expect(required).toBe(139);
  });

  it("names currency and due_date as required, which is the understating defect's exact members", () => {
    // The three live members, by name, so the fix cannot be reverted while the suite stays green:
    // `Invoice.currency`, `Invoice.due_date` and `Bill.due_date` were dropped from `required` by a
    // settings arm that read whether a settings STORE was wired, while the fill reads the tenant's
    // own settings VALUES. Every deployment wires a store — `ResolvedStores.settingsStore` is not
    // optional — so all three were understated on every tenant until its settings were populated.
    const inv = entitySchemas(entity("Invoice"), traits, null, surfaceOf(entity("Invoice"))).create.required ?? [];
    const bill = entitySchemas(entity("Bill"), traits, null, surfaceOf(entity("Bill"))).create.required ?? [];
    expect(inv).toContain("currency");
    expect(inv).toContain("due_date");
    expect(bill).toContain("due_date");
    // And the other half of the same fix: a sequence-defaulted field is omittable, so the document
    // is not stricter than the server either.
    expect(inv).not.toContain("invoice_number");
    expect(bill).not.toContain("bill_number");
  });

  it("describes every field of every entity — nothing undescribable in any pack entity", () => {
    const undescribable = entities.flatMap(
      (e) => entitySchemas(e, traits, null, surfaceOf(e)).undescribable,
    );
    expect(undescribable).toEqual([]);
  });

  it("leaves an update body wholly optional and closes both request bodies to undeclared keys", () => {
    const v = entitySchemas(entity("Invoice"), traits, null, surfaceOf(entity("Invoice")));
    expect(v.update.required).toBeUndefined();
    // `false` on both requests and nothing on the response. This test used to pin all three as
    // absent, with the reason that an unknown key was stored by the JSONB and in-memory stores and
    // dropped by the column store — true then, and the reason it was a defect rather than a fact to
    // describe. The create and update handlers now refuse an undeclared key 422 before any store
    // sees it, so `false` is true of every store.
    expect(v.response.additionalProperties).toBeUndefined();
    expect(v.create.additionalProperties).toBe(false);
    expect(v.update.additionalProperties).toBe(false);
    // Closed, the update body must still admit the concurrency token the handler strips before the
    // write surface is asked and the console sends on every edit; the create handler has no token.
    expect(v.update.properties?.["expectedUpdatedAt"]).toMatchObject({ type: "string" });
    expect(v.create.properties?.["expectedUpdatedAt"]).toBeUndefined();
  });

  it("offers no request a field the server owns, and offers create the caller's own id", () => {
    const v = entitySchemas(entity("Invoice"), traits, null, surfaceOf(entity("Invoice")));
    // Stamped by the server on the same request, or by a write effect on the posting edge.
    for (const owned of ["created_at", "updated_at", "created_by", "updated_by", "booking_rate", "withholding_total", "paid_at"]) {
      expect(v.response.properties?.[owned], owned).toBeDefined();
      expect(v.create.properties?.[owned], owned).toBeUndefined();
      expect(v.update.properties?.[owned], owned).toBeUndefined();
    }
    // A sequence number is admitted on create (an import keeping legacy numbers) and refused after.
    expect(v.create.properties?.["invoice_number"]).toBeDefined();
    expect(v.update.properties?.["invoice_number"]).toBeUndefined();
    // The id: create only, with the pattern the handler refuses outside of.
    expect(v.create.properties?.["id"]?.pattern).toBe("^[A-Za-z0-9_-]{1,200}$");
    expect(v.update.properties?.["id"]).toBeUndefined();
    // The control: an ordinary declared field is on both.
    expect(v.create.properties?.["total"]).toBeDefined();
    expect(v.update.properties?.["total"]).toBeDefined();
  });

  it("publishes a lifecycle state field as the server enforces it, not as a free enum", () => {
    // The server refuses every create value but the initial state and every update value but the
    // stored one (`lifecycleStateGuard`). The document used to publish Invoice.state as a five-value
    // writable enum on both bodies, which told a generated client it could do what each request then
    // answered 422 to.
    const lifecycle = entityLifecycleShape(manifest, "Invoice");
    expect(lifecycle).toEqual({ stateField: "state", initialState: "draft" });
    const v = entitySchemas(entity("Invoice"), traits, lifecycle, surfaceOf(entity("Invoice")));
    expect(v.create.properties?.["state"]?.enum).toEqual(["draft"]);
    expect(v.create.properties?.["state"]?.description).toContain("transition");
    expect(v.update.properties?.["state"]?.readOnly).toBe(true);
    expect(v.update.properties?.["state"]?.description).toContain("refused 422");
    // The response still says every state the record can be in.
    expect(v.response.properties?.["state"]?.enum).toHaveLength(5);
    // And a field that is not the state field is untouched.
    expect(v.update.properties?.["total"]?.readOnly).toBeUndefined();
    // The control: with no lifecycle the field is published as declared.
    const bare = entitySchemas(entity("Invoice"), traits, null, surfaceOf(entity("Invoice")));
    expect(bare.create.properties?.["state"]?.enum).toHaveLength(5);
    expect(bare.update.properties?.["state"]?.readOnly).toBeUndefined();
  });

  it("follows the lifecycle's own state field, which is not always `state`", () => {
    const lifecycle = entityLifecycleShape(manifest, "Opportunity");
    expect(lifecycle?.stateField).toBe("stage");
    const v = entitySchemas(entity("Opportunity"), traits, lifecycle, surfaceOf(entity("Opportunity")));
    expect(v.create.properties?.["stage"]?.enum).toEqual([lifecycle?.initialState]);
    expect(v.update.properties?.["stage"]?.readOnly).toBe(true);
    expect(entityLifecycleShape(manifest, "Vendor")).toBeNull();
  });

  it("emits no pattern for the RESPONSE `id`, which describes what a record carries, not what a caller sends", () => {
    // `rec_` + base36 is the GENERATOR's shape and a caller-supplied id is kept, so the response
    // promises a string and no narrower shape; the create request carries the pattern the handler
    // enforces on a caller's id.
    const id = entitySchemas(entity("Vendor"), traits, null, surfaceOf(entity("Vendor")))
      .response.properties?.["id"];
    expect(id?.type).toBe("string");
    expect(id?.pattern).toBeUndefined();
    expect(id?.description).toContain("rec_");
  });
});
