import { describe, expect, it } from "vitest";
import type { Field } from "@crossengin/types/meta-schema";
import { ManifestValidationError } from "./errors.js";
import { ManifestSchema, type Manifest } from "./types.js";
import { validateManifest } from "./validate.js";

const meta = { name: "Test", slug: "test", version: "1.0.0" } as const;
const L31 = "'a'); CREATE TABLE public.pwned(x int); --";

function refusal(m: Manifest): ManifestValidationError {
  try {
    validateManifest(m);
  } catch (e) {
    if (e instanceof ManifestValidationError) return e;
    throw e;
  }
  throw new Error("expected validateManifest to refuse");
}

function ownField(field: Field): Manifest {
  return {
    manifestVersion: "1.0",
    meta,
    entities: [{ name: "Note", fields: [{ name: "title", type: { kind: "text" } }, field] }],
  };
}

describe("validateManifest: expression defaults", () => {
  /**
   * The audit's L31 manifest, parsed through the real schema first so the test proves the refusal
   * is validation's and not the schema's: `DefaultValueSchema` still admits any non-empty text.
   */
  it("refuses the L31 payload on an own field, which the schema itself accepts", () => {
    const m = ManifestSchema.parse(
      ownField({ name: "label", type: { kind: "text" }, default: { kind: "expression", expression: L31 } }),
    );
    const err = refusal(m);
    expect(err.path).toBe("entities[0].fields[1].default");
    expect(err.message).toMatch(/Note\.label.*not one of the admitted expressions/s);
    expect(err.message).not.toContain("pwned");
  });

  it("refuses the same payload carried by a custom trait, at the trait's path", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta,
      traits: [
        {
          name: "stamped",
          fields: [{ name: "label", type: { kind: "text" }, default: { kind: "expression", expression: L31 } }],
        },
      ],
      entities: [{ name: "Note", traits: ["stamped"], fields: [{ name: "title", type: { kind: "text" } }] }],
    };
    const err = refusal(m);
    expect(err.path).toBe("traits[0].fields[0].default");
    expect(err.message).toMatch(/trait 'stamped' field 'label'/);
  });

  it("refuses a trait's payload even when no entity carries the trait", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta,
      traits: [
        {
          name: "stamped",
          fields: [{ name: "at", type: { kind: "datetime" }, default: { kind: "expression", expression: "now() --" } }],
        },
      ],
      entities: [{ name: "Note", fields: [{ name: "title", type: { kind: "text" } }] }],
    };
    expect(refusal(m).path).toBe("traits[0].fields[0].default");
  });

  it.each([
    "now(); DROP TABLE meta.tenants",
    "$t$; DROP TABLE x; $t$",
    "(now())",
    "NOW()",
    "pg_sleep(10)",
    "current_date",
  ])("refuses %j on a datetime field", (expression) => {
    const err = refusal(
      ownField({ name: "at", type: { kind: "datetime" }, default: { kind: "expression", expression } }),
    );
    expect(err.path).toBe("entities[0].fields[1].default");
  });

  it("refuses an admitted expression on a field whose column cannot take its result", () => {
    const err = refusal(
      ownField({ name: "label", type: { kind: "text" }, default: { kind: "expression", expression: "now()" } }),
    );
    expect(err.message).toMatch(/datetime field, not a text one/);
  });

  it("refuses a database-computed default on a field the store encrypts at rest", () => {
    const err = refusal({
      manifestVersion: "1.0",
      meta,
      entities: [
        {
          name: "Visit",
          traits: ["auditable"],
          fields: [
            {
              name: "seen_at",
              type: { kind: "datetime" },
              classification: "phi",
              default: { kind: "expression", expression: "now()" },
            },
          ],
        },
      ],
    });
    expect(err.message).toMatch(/ciphertext/);
  });

  it("accepts the admitted spellings on the field types they fit, including through auditable", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta,
      entities: [
        {
          name: "Note",
          traits: ["auditable"],
          fields: [
            { name: "stamped_at", type: { kind: "datetime" }, default: { kind: "expression", expression: "now()" } },
            {
              name: "token",
              type: { kind: "uuid" },
              default: { kind: "expression", expression: "uuid_generate_v7()" },
            },
          ],
        },
      ],
    };
    expect(() => validateManifest(m)).not.toThrow();
  });
});
