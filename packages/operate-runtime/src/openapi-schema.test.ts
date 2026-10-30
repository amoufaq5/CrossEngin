import { describe, expect, it } from "vitest";

import { resolvedFields } from "@crossengin/kernel/ddl";
import { buildErpCorePack } from "@crossengin/pack-erp-core";
import type { Entity, Field, PrimitiveFieldType } from "@crossengin/types/meta-schema";

import {
  FIELD_REQUEST_SCHEMAS,
  FIELD_RESPONSE_SCHEMAS,
  UNDESCRIBABLE_FIELD_KINDS,
  entitySchemas,
  fieldRequestSchema,
  fieldResponseSchema,
  serverFillsOnCreate,
} from "./openapi-schema.js";

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

describe("serverFillsOnCreate", () => {
  it("treats a literal or expression default as filled whatever the wiring", () => {
    const none = { settingsStore: false, allocator: false };
    expect(serverFillsOnCreate(field("a", { kind: "text" }, { default: { kind: "literal", value: "x" } }), none)).toBe(true);
    expect(serverFillsOnCreate(field("b", { kind: "datetime" }, { default: { kind: "expression", expression: "now()" } }), none)).toBe(true);
  });

  it("makes a sequence default depend on the allocator, which is deployment wiring", () => {
    const f = field("n", { kind: "text" }, { default: { kind: "sequence", sequence: "s" } });
    expect(serverFillsOnCreate(f, { settingsStore: false, allocator: false })).toBe(false);
    expect(serverFillsOnCreate(f, { settingsStore: false, allocator: true })).toBe(true);
  });

  it("gates the settings fills on a settings store, where ui-schema's sibling does not", () => {
    // `isServerDefaulted` in ui-schema.ts treats `currency_amount` as filled unconditionally. That
    // is wrong for a request schema: with no settings store nothing fills it, so the field really
    // is a client obligation and a document saying otherwise promises a fill that cannot happen.
    const amount = field("amount", { kind: "currency_amount" });
    const currency = field("currency", { kind: "text" });
    const due = field("due_date", { kind: "date" });
    for (const f of [amount, currency, due]) {
      expect(serverFillsOnCreate(f, { settingsStore: false, allocator: false }), f.name).toBe(false);
      expect(serverFillsOnCreate(f, { settingsStore: true, allocator: false }), f.name).toBe(true);
    }
  });

  it("answers false for an ordinary required field with no default", () => {
    expect(
      serverFillsOnCreate(field("name", { kind: "text" }, { required: true }), {
        settingsStore: true,
        allocator: true,
      }),
    ).toBe(false);
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

  it("describes the RESOLVED field set, which is a third wider than the entity's own", () => {
    // ADR-0361's class, and the whole correctness question for this module. Measured: 51 of 51
    // entities differ, 426 own fields against 630 resolved — 204 outside the narrow aperture,
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
        entitySchemas(e, traits, { settingsStore: false, allocator: false }).response.properties ?? {},
      ).length;
    }
    expect(own).toBe(426);
    expect(resolved).toBe(630);
    // One `id` added per entity, and nothing dropped.
    expect(props).toBe(resolved + entities.length);
  });

  it("carries the four trait fields a narrow read would omit", () => {
    const v = entitySchemas(entity("Vendor"), traits, { settingsStore: false, allocator: false });
    const names = Object.keys(v.response.properties ?? {});
    for (const n of ["created_at", "updated_at", "created_by", "updated_by"]) {
      expect(names, n).toContain(n);
    }
    expect(names).toContain("id");
  });

  it("requires 153 of 395 declared-required fields unwired, and 136 fully wired", () => {
    // The figure that separates a usable create schema from an unusable one: a naive
    // `field.required === true` read overstates a client's obligations by 2.6x to 2.9x, because
    // `validateBody` runs AFTER defaults are applied. The spread between the two wirings is the
    // 14 sequence-defaulted fields plus the three settings-fillable ones, and it is why this takes
    // a `CreateWiring` — the honest required set is a property of the manifest AND the deployment.
    let declared = 0;
    let unwired = 0;
    let wired = 0;
    for (const e of entities) {
      declared += resolvedFields(e, traits).filter((f) => f.required === true).length;
      unwired += entitySchemas(e, traits, { settingsStore: false, allocator: false }).create.required?.length ?? 0;
      wired += entitySchemas(e, traits, { settingsStore: true, allocator: true }).create.required?.length ?? 0;
    }
    expect(declared).toBe(395);
    expect(unwired).toBe(153);
    expect(wired).toBe(136);
  });

  it("describes every field of every entity — nothing undescribable in any pack entity", () => {
    const undescribable = entities.flatMap(
      (e) => entitySchemas(e, traits, { settingsStore: true, allocator: true }).undescribable,
    );
    expect(undescribable).toEqual([]);
  });

  it("leaves an update body wholly optional and sets no additionalProperties anywhere", () => {
    const v = entitySchemas(entity("Invoice"), traits, { settingsStore: true, allocator: true });
    expect(v.update.required).toBeUndefined();
    // Measured rather than cautious: an unknown key is accepted, stored and echoed by the JSONB and
    // in-memory stores and silently dropped by the column store, so `false` would be false of two
    // of the three and `true` would promise the column store's drop is a round trip.
    expect(v.response.additionalProperties).toBeUndefined();
    expect(v.create.additionalProperties).toBeUndefined();
    expect(v.update.additionalProperties).toBeUndefined();
  });

  it("emits no pattern for `id`, because the API does not enforce one", () => {
    // `rec_` + base36 is the GENERATOR's shape; `resolveRecordId` keeps a caller-supplied id as
    // given. A pattern would describe a constraint this API does not have, which is the
    // falsely-specific direction of a falsely-complete description.
    const id = entitySchemas(entity("Vendor"), traits, { settingsStore: false, allocator: false })
      .response.properties?.["id"];
    expect(id?.type).toBe("string");
    expect(id?.pattern).toBeUndefined();
    expect(id?.description).toContain("rec_");
  });
});
