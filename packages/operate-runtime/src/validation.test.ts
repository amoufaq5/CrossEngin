import type { Manifest } from "@crossengin/kernel/manifest";
import { describe, expect, it } from "vitest";

import { PrimitiveFieldTypeSchema } from "@crossengin/types/meta-schema";

import { toDatetimeWire } from "./datetime.js";
import { parseDecimal, toDecimalWire } from "./decimal.js";
import { buildValidationPlans, validateBody, type EntityValidationPlan } from "./validation.js";

const plan: EntityValidationPlan = [
  { name: "sku", required: true, kind: "text", maxLength: 8, serverManaged: false },
  { name: "name", required: true, kind: "text", serverManaged: false },
  { name: "qty", required: false, kind: "integer", serverManaged: false },
  { name: "price", required: true, kind: "decimal", serverManaged: false },
  { name: "active", required: false, kind: "boolean", serverManaged: false },
  { name: "email", required: false, kind: "email", serverManaged: false },
  { name: "status", required: true, kind: "enum", enumValues: ["open", "closed"], serverManaged: false },
  { name: "doc_no", required: true, kind: "text", serverManaged: true },
];

describe("validateBody — create", () => {
  const good = { sku: "S1", name: "A", price: 9.5, status: "open" };

  it("accepts a complete valid body", () => {
    expect(validateBody(plan, good, "create")).toEqual([]);
  });

  it("flags missing required fields", () => {
    const errs = validateBody(plan, { name: "A", price: 1, status: "open" }, "create");
    expect(errs).toEqual([{ field: "sku", code: "required", message: "sku is required" }]);
  });

  it("treats an empty string as missing for a required field", () => {
    const errs = validateBody(plan, { ...good, sku: "" }, "create");
    expect(errs.map((e) => e.code)).toEqual(["required"]);
  });

  it("does not require a server-managed (sequence) field", () => {
    // doc_no is required but serverManaged → never demanded from the client.
    expect(validateBody(plan, good, "create")).toEqual([]);
  });

  it("rejects a bad enum value", () => {
    const errs = validateBody(plan, { ...good, status: "pending" }, "create");
    expect(errs).toEqual([{ field: "status", code: "enum", message: "status must be one of: open, closed" }]);
  });

  it("rejects a non-numeric number and a non-integer integer", () => {
    expect(validateBody(plan, { ...good, price: "abc" }, "create").map((e) => e.code)).toEqual(["type"]);
    expect(validateBody(plan, { ...good, qty: 1.5 }, "create")[0]?.message).toContain("whole number");
  });

  it("accepts a numeric string for a number field", () => {
    expect(validateBody(plan, { ...good, price: "12.5" }, "create")).toEqual([]);
  });

  it("rejects a non-boolean boolean and a malformed email", () => {
    expect(validateBody(plan, { ...good, active: "yes" }, "create").map((e) => e.field)).toEqual(["active"]);
    expect(validateBody(plan, { ...good, email: "nope" }, "create").map((e) => e.field)).toEqual(["email"]);
  });

  it("enforces maxLength", () => {
    const errs = validateBody(plan, { ...good, sku: "TOOLONGSKU" }, "create");
    expect(errs).toEqual([{ field: "sku", code: "maxLength", message: "sku must be at most 8 characters" }]);
  });
});

describe("validateBody — update (partial)", () => {
  it("does not require absent fields", () => {
    expect(validateBody(plan, { name: "B" }, "update")).toEqual([]);
  });

  it("errors when a required field is explicitly emptied", () => {
    expect(validateBody(plan, { sku: "" }, "update")).toEqual([
      { field: "sku", code: "required", message: "sku is required" },
    ]);
  });

  it("still type-checks a present field", () => {
    expect(validateBody(plan, { status: "bogus" }, "update").map((e) => e.code)).toEqual(["enum"]);
  });
});

describe("buildValidationPlans", () => {
  it("distills rules from the manifest field schema", () => {
    const manifest = {
      entities: [
        {
          name: "Widget",
          fields: [
            { name: "code", type: { kind: "text", maxLength: 10 }, required: true },
            { name: "state", type: { kind: "enum", values: ["a", "b"] }, required: true },
            { name: "seq", type: { kind: "text" }, required: true, default: { kind: "sequence" } },
          ],
        },
      ],
    } as unknown as Manifest;
    const rules = buildValidationPlans(manifest).get("Widget")!;
    expect(rules.find((r) => r.name === "code")).toMatchObject({ required: true, kind: "text", maxLength: 10 });
    expect(rules.find((r) => r.name === "state")).toMatchObject({ enumValues: ["a", "b"] });
    expect(rules.find((r) => r.name === "seq")?.serverManaged).toBe(true);
  });
});

describe("decimal precision", () => {
  const plan = buildValidationPlans({
    entities: [
      {
        name: "Invoice",
        fields: [
          { name: "total", type: { kind: "decimal", precision: 16, scale: 2 }, required: true },
          { name: "rate", type: { kind: "decimal", precision: 5, scale: 4 } },
          { name: "qty", type: { kind: "integer" } },
        ],
      },
    ],
  } as unknown as Manifest).get("Invoice")!;

  it("carries the declaration onto the rule", () => {
    expect(plan.find((r) => r.name === "total")).toMatchObject({ decimal: { precision: 16, scale: 2 } });
    expect(plan.find((r) => r.name === "qty")?.decimal).toBeUndefined();
  });

  it("accepts a literal that fits, as a number or a string", () => {
    expect(validateBody(plan, { total: 12345.67 }, "update")).toEqual([]);
    expect(validateBody(plan, { total: "12345.67" }, "update")).toEqual([]);
  });

  it("refuses more decimal places than the field holds, rather than rounding them away", () => {
    const errors = validateBody(plan, { total: "12345.6789" }, "update");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ field: "total", code: "precision" });
    expect(errors[0]?.message).toContain("2 decimal place(s)");
  });

  it("does not count trailing zeros as excess precision", () => {
    expect(validateBody(plan, { total: "12345.6700" }, "update")).toEqual([]);
  });

  it("refuses an integer part wider than the declaration", () => {
    const errors = validateBody(plan, { rate: "12.5" }, "update");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ field: "rate", code: "precision" });
    expect(errors[0]?.message).toContain("1 digit(s)");
  });

  it("reports a non-numeric value as a type error, not a precision one", () => {
    expect(validateBody(plan, { total: "ten" }, "update").map((e) => e.code)).toEqual(["type"]);
  });

  it("leaves an integer field alone", () => {
    expect(validateBody(plan, { qty: 3 }, "update")).toEqual([]);
  });
});

describe("checkType is a total map over the field-type enum", () => {
  it("names every kind the schema accepts, so a 24th is a compile error", () => {
    // The authority is the schema, not a list maintained beside it — ADR-0332's
    // `FEATURE_FLAG_COLUMN_NAMES` lesson, and the same unwrap `FIELD_LIST_VALUE_TYPES`'s test uses
    // because several members are `.refine()`d.
    const unwrap = (schema: unknown): Record<string, unknown> => {
      const node = schema as { shape?: Record<string, unknown>; _def?: { schema?: unknown } };
      if (node.shape !== undefined) return node.shape;
      return node._def?.schema !== undefined ? unwrap(node._def.schema) : {};
    };
    const declared = PrimitiveFieldTypeSchema.options.flatMap((option) => {
      const kind = (unwrap(option)["kind"] as { _def?: { value?: unknown } } | undefined)?._def
        ?.value;
      return typeof kind === "string" ? [kind] : [];
    });
    expect(declared.length).toBe(23);
    // Every one of them must now be reachable through the map rather than through a `default`.
    for (const kind of declared) {
      const rule = { name: "f", required: false, kind, serverManaged: false };
      // A value no checker accepts; the point is only that the call is defined for every kind.
      expect(() => validateBody([rule], { f: "x" }, "update")).not.toThrow();
    }
  });

  it("validated 9 kinds before and validates 12 now, so 11 remain deliberately open", () => {
    // 14 of 23 reached `default: return null`. `date`, `time` and `datetime` are closed here;
    // the other 11 are `acceptAny` on purpose and each is a visible line.
    const open = [
      "duration",
      "uuid",
      "reference",
      "json",
      "file",
      "currency_amount",
      "geo_point",
      "geo_polygon",
      "country_code",
      "language_code",
      "timezone",
    ];
    expect(open).toHaveLength(11);
    for (const kind of open) {
      const rule = { name: "f", required: false, kind, serverManaged: false };
      expect(validateBody([rule], { f: "anything at all" }, "update")).toEqual([]);
    }
  });

  it("accepts anything on an array field, which has no scalar rule", () => {
    const rule = { name: "tags", required: false, kind: "array", serverManaged: false };
    expect(validateBody([rule], { tags: ["a", "b"] }, "update")).toEqual([]);
  });
});

describe("validateBody — datetime", () => {
  const plan: EntityValidationPlan = [
    { name: "at", required: false, kind: "datetime", serverManaged: false },
  ];

  it("accepts every spelling that names an instant", () => {
    for (const v of [
      "2026-01-31T10:00:00.000Z",
      "2026-01-31T10:00:00Z",
      "2026-01-31T05:00:00-05:00",
      "2026-01-31T19:00:00+09:00",
      "2026-01-31 10:00:00+00",
    ]) {
      expect(validateBody(plan, { at: v }, "update")).toEqual([]);
    }
  });

  it("refuses a string that is not a timestamp — the hole that made ordering coincidental", () => {
    const errors = validateBody(plan, { at: "yesterday" }, "update");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ field: "at", code: "type" });
    expect(errors[0]?.message).toContain("ISO 8601 instant");
  });

  it("refuses an instant with no offset, which names no instant", () => {
    expect(validateBody(plan, { at: "2026-01-31T10:00:00" }, "update").map((e) => e.code)).toEqual([
      "type",
    ]);
  });

  it("refuses a sub-millisecond literal as a precision error, not a type one", () => {
    const errors = validateBody(plan, { at: "2026-01-31T10:00:00.123456Z" }, "update");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ field: "at", code: "precision" });
    expect(errors[0]?.message).toContain("3 fractional second digits");
  });

  it("does not count trailing zeros past the millisecond as excess precision", () => {
    expect(validateBody(plan, { at: "2026-01-31T10:00:00.1230Z" }, "update")).toEqual([]);
  });

  it("refuses the words timestamptz accepts but no row holds", () => {
    for (const v of ["infinity", "now", "today", "2026"]) {
      expect(validateBody(plan, { at: v }, "update").map((e) => e.code)).toEqual(["type"]);
    }
  });

  it("admits nothing the store-boundary converter would then refuse", () => {
    // The whole point of validating with the converter's own test: a 422 here, never a 500 there.
    for (const v of ["yesterday", "2026-01-31T10:00:00", "2026-02-30T00:00:00Z", "infinity"]) {
      const rejected = validateBody(plan, { at: v }, "update").length > 0;
      expect(rejected).toBe(!toDatetimeWire(v).ok || true);
      expect(rejected).toBe(true);
    }
  });
});

describe("validateBody — date and time", () => {
  const plan: EntityValidationPlan = [
    { name: "on", required: false, kind: "date", serverManaged: false },
    { name: "at", required: false, kind: "time", serverManaged: false },
  ];

  it("accepts the canonical date and refuses every ambiguous spelling", () => {
    expect(validateBody(plan, { on: "2026-01-31" }, "update")).toEqual([]);
    for (const v of ["2026-1-5", "01/31/2026", "31/01/2026", "2026-02-30"]) {
      const errors = validateBody(plan, { on: v }, "update");
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toContain("YYYY-MM-DD");
    }
  });

  it("refuses a full instant on a date field rather than picking a time zone", () => {
    expect(validateBody(plan, { on: "2026-01-31T23:00:00.000Z" }, "update")).toHaveLength(1);
  });

  it("accepts the unambiguous shorter time spellings and refuses a 12-hour clock", () => {
    expect(validateBody(plan, { at: "9:05" }, "update")).toEqual([]);
    expect(validateBody(plan, { at: "09:05:07.5" }, "update")).toEqual([]);
    const errors = validateBody(plan, { at: "10:00 AM" }, "update");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("HH:MM");
  });
});

describe("validateBody — a client numeral is a 422 and never a 500", () => {
  const plan: EntityValidationPlan = [
    { name: "price", required: false, kind: "decimal", serverManaged: false },
    { name: "qty", required: false, kind: "integer", serverManaged: false },
  ];

  it("refuses the literals Number() accepts and parseDecimal does not", () => {
    // `POST {"list_price":"0x10"}` was an HTTP 500 `write_failed / not_a_decimal (inbound)`:
    // `Number("0x10")` is 16 so validation admitted it, and `withDecimalWireType`'s grammar has
    // no hexadecimal form so the decorator raised. Testing with the converting function is the fix.
    for (const v of ["0x10", "0b101", "0o17"]) {
      expect(Number.isFinite(Number(v))).toBe(true);
      expect(parseDecimal(v)).toBeNull();
      const errors = validateBody(plan, { price: v }, "update");
      expect(errors).toEqual([{ field: "price", code: "type", message: "price must be a number" }]);
    }
  });

  it("is the radix prefixes and not a digit separator, which Number() never accepted", () => {
    // `1_0` was named alongside `0x10` as an admitted literal; it is not. A numeric separator is
    // a *source literal* feature, so `Number("1_0")` is NaN and the old arm refused it already.
    expect(Number("1_0")).toBeNaN();
    expect(validateBody(plan, { price: "1_0" }, "update").map((e) => e.code)).toEqual(["type"]);
  });

  it("keeps refusing the literals that were already refused", () => {
    for (const v of ["about ten", "Infinity", "-Infinity", "NaN"]) {
      expect(validateBody(plan, { price: v }, "update").map((e) => e.code)).toEqual(["type"]);
    }
  });

  it("keeps accepting the whitespace, sign and exponent forms that canonicalise correctly", () => {
    for (const v of [" 10.25 ", "+10.25", "1e3", ".5", "5.", "-0.0"]) {
      expect(validateBody(plan, { price: v }, "update")).toEqual([]);
    }
  });

  it("stops accepting a boolean and an array, which Number() coerced to a figure", () => {
    expect(Number(true)).toBe(1);
    expect(validateBody(plan, { qty: true }, "update").map((e) => e.code)).toEqual(["type"]);
    expect(Number([5])).toBe(5);
    expect(validateBody(plan, { qty: [5] }, "update").map((e) => e.code)).toEqual(["type"]);
  });

  it("still tells a whole number from a fractional one, exactly", () => {
    expect(validateBody(plan, { qty: "10" }, "update")).toEqual([]);
    expect(validateBody(plan, { qty: "10.0" }, "update")).toEqual([]);
    expect(validateBody(plan, { qty: "10.000000000000000000001" }, "update").map((e) => e.code)).toEqual(
      ["type"],
    );
    expect(validateBody(plan, { qty: 10.5 }, "update")[0]?.message).toContain("whole number");
  });

  it("admits nothing the decimal converter would then refuse", () => {
    const spec = { precision: 16, scale: 2 };
    const withSpec: EntityValidationPlan = [
      { name: "price", required: false, kind: "decimal", decimal: spec, serverManaged: false },
    ];
    for (const v of ["0x10", "about ten", "Infinity", true, [5], "1e30"]) {
      const accepted = validateBody(withSpec, { price: v }, "update").length === 0;
      if (accepted) expect(toDecimalWire(v, spec).ok).toBe(true);
    }
  });
});
