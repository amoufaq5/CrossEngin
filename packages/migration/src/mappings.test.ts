import { describe, expect, it } from "vitest";
import {
  EntityMappingSchema,
  FieldMappingSchema,
  FieldTransformSchema,
  TRANSFORM_KINDS,
  isTypeCoercionAllowed,
  type EntityMapping,
  type FieldMapping,
} from "./mappings.js";

describe("TRANSFORM_KINDS", () => {
  it("has 14 entries", () => {
    expect(TRANSFORM_KINDS).toContain("identity");
    expect(TRANSFORM_KINDS).toContain("regex_extract");
    expect(TRANSFORM_KINDS).toContain("redact");
  });
});

describe("FieldTransformSchema", () => {
  it("accepts identity", () => {
    expect(() => FieldTransformSchema.parse({ kind: "identity" })).not.toThrow();
  });

  it("rejects regex_extract without pattern", () => {
    expect(() =>
      FieldTransformSchema.parse({ kind: "regex_extract" }),
    ).toThrow(/pattern/);
  });

  it("rejects regex_extract with invalid regex", () => {
    expect(() =>
      FieldTransformSchema.parse({
        kind: "regex_extract",
        pattern: "[unclosed",
      }),
    ).toThrow(/valid JavaScript regex/);
  });

  it("rejects split without delimiter", () => {
    expect(() =>
      FieldTransformSchema.parse({ kind: "split" }),
    ).toThrow(/delimiter/);
  });

  it("rejects concat with fewer than two sourceFields", () => {
    expect(() =>
      FieldTransformSchema.parse({
        kind: "concat",
        sourceFields: ["first_name"],
      }),
    ).toThrow(/at least two sourceFields/);
  });

  it("rejects lookup without lookupTable", () => {
    expect(() =>
      FieldTransformSchema.parse({ kind: "lookup" }),
    ).toThrow(/lookupTable/);
  });

  it("rejects date_parse without inputFormat", () => {
    expect(() =>
      FieldTransformSchema.parse({ kind: "date_parse" }),
    ).toThrow(/inputFormat/);
  });

  it("rejects default_if_null without defaultValue", () => {
    expect(() =>
      FieldTransformSchema.parse({ kind: "default_if_null" }),
    ).toThrow(/defaultValue/);
  });
});

describe("FieldMappingSchema", () => {
  const base: FieldMapping = {
    sourceField: "Email Address",
    targetField: "email",
    targetType: "email",
    targetNullable: false,
    transforms: [{ kind: "trim" }, { kind: "lowercase" }],
    required: true,
    skipIfNull: false,
  };

  it("accepts a valid mapping", () => {
    expect(() => FieldMappingSchema.parse(base)).not.toThrow();
  });

  it("rejects required=true with targetNullable=true", () => {
    expect(() =>
      FieldMappingSchema.parse({ ...base, targetNullable: true }),
    ).toThrow(/required=true implies targetNullable=false/);
  });

  it("rejects skipIfNull combined with required", () => {
    expect(() =>
      FieldMappingSchema.parse({
        ...base,
        skipIfNull: true,
      }),
    ).toThrow(/cannot be combined with required/);
  });

  it("rejects malformed targetField", () => {
    expect(() =>
      FieldMappingSchema.parse({ ...base, targetField: "Email" }),
    ).toThrow();
  });
});

describe("EntityMappingSchema", () => {
  const base: EntityMapping = {
    id: "sf-account",
    sourceEntity: "Account",
    targetEntity: "accounts",
    fields: [
      {
        sourceField: "Id",
        targetField: "external_id",
        targetType: "string",
        targetNullable: false,
        transforms: [],
        required: true,
        skipIfNull: false,
      },
      {
        sourceField: "Name",
        targetField: "name",
        targetType: "string",
        targetNullable: false,
        transforms: [{ kind: "trim" }],
        required: true,
        skipIfNull: false,
      },
    ],
    skipUnmappedSourceFields: true,
    idempotencyKeyFields: ["external_id"],
    upsertMode: "upsert",
  };

  it("accepts a valid mapping", () => {
    expect(() => EntityMappingSchema.parse(base)).not.toThrow();
  });

  it("rejects duplicate sourceField", () => {
    expect(() =>
      EntityMappingSchema.parse({
        ...base,
        fields: [...base.fields, base.fields[0]!],
      }),
    ).toThrow(/source field 'Id' mapped more than once/);
  });

  it("rejects duplicate targetField", () => {
    expect(() =>
      EntityMappingSchema.parse({
        ...base,
        fields: [
          base.fields[0]!,
          {
            sourceField: "Other",
            targetField: "external_id",
            targetType: "string",
            targetNullable: false,
            transforms: [],
            required: true,
            skipIfNull: false,
          },
        ],
      }),
    ).toThrow(/destination of more than one mapping/);
  });

  it("rejects idempotency key not in target fields", () => {
    expect(() =>
      EntityMappingSchema.parse({
        ...base,
        idempotencyKeyFields: ["nonexistent"],
      }),
    ).toThrow(/not a declared target field/);
  });

  it("rejects duplicate idempotency keys", () => {
    expect(() =>
      EntityMappingSchema.parse({
        ...base,
        idempotencyKeyFields: ["external_id", "external_id"],
      }),
    ).toThrow(/duplicate idempotency key/);
  });

  it("rejects malformed mapping id", () => {
    expect(() =>
      EntityMappingSchema.parse({ ...base, id: "SF-Account" }),
    ).toThrow();
  });
});

describe("isTypeCoercionAllowed", () => {
  it("integer -> decimal is allowed", () => {
    expect(isTypeCoercionAllowed("integer", "decimal").compatible).toBe(true);
  });

  it("integer -> string is allowed", () => {
    expect(isTypeCoercionAllowed("integer", "string").compatible).toBe(true);
  });

  it("decimal -> integer is NOT allowed (lossy)", () => {
    expect(isTypeCoercionAllowed("decimal", "integer").compatible).toBe(false);
  });

  it("date -> datetime is allowed", () => {
    expect(isTypeCoercionAllowed("date", "datetime").compatible).toBe(true);
  });

  it("datetime -> date is NOT allowed (lossy)", () => {
    expect(isTypeCoercionAllowed("datetime", "date").compatible).toBe(false);
  });

  it("unknown -> string is allowed", () => {
    expect(isTypeCoercionAllowed("unknown", "string").compatible).toBe(true);
  });

  it("binary -> string is NOT allowed", () => {
    expect(isTypeCoercionAllowed("binary", "string").compatible).toBe(false);
  });

  it("reports the source/target in the reason", () => {
    const r = isTypeCoercionAllowed("decimal", "integer");
    expect(r.reason).toContain("decimal");
    expect(r.reason).toContain("integer");
  });
});
