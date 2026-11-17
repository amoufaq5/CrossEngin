import { describe, expect, it } from "vitest";
import type { Field } from "@crossengin/types/meta-schema";
import { BUILT_IN_TRAIT_FIELDS } from "./built-in-traits.js";
import { emitDefault } from "./column.js";
import {
  ADMITTED_EXPRESSION_DEFAULTS,
  EXPRESSION_DEFAULTS,
  UnadmittedExpressionDefaultError,
  admittedExpressionDefaultSql,
  expressionDefaultRefusal,
} from "./expression-default.js";

/** The audit's L31 payload, which reached `CREATE TABLE` verbatim before the lookup. */
const L31_PAYLOAD = "'a'); CREATE TABLE public.pwned(x int); --";

/**
 * Spellings an attacker or a careless author would try. Every one must be refused: a parser that
 * admitted any of them by normalising (case, whitespace, a trailing comment, a cast) would be a
 * second grammar the emitter does not share.
 */
const REFUSED_EXPRESSIONS: readonly string[] = [
  L31_PAYLOAD,
  // L31 as written leaves the rest of the CREATE TABLE unparseable, so the whole batch fails;
  // this one closes the injected statement's parentheses and executed on PG 16 before the lookup.
  "'a'); CREATE TABLE public.pwned(x int); CREATE TEMP TABLE z (tenant_id uuid, id text, q text DEFAULT 'a'",
  "now(); DROP TABLE meta.tenants",
  "now() -- trailing comment",
  "now()/* block */",
  "/**/now()",
  "NOW()",
  "Now()",
  " now()",
  "now() ",
  "now ()",
  "now()\n",
  "now()\u0000",
  "(now())",
  "((now()))",
  "now()::date",
  "now() + interval '1 day'",
  "$$x$$",
  "$t$; DROP TABLE x; $t$",
  "E'\\x27'",
  "pg_sleep(10)",
  "current_date",
  "current_timestamp",
  "gen_random_uuid()",
  "uuid_generate_v7()::text",
  "public.now()",
  "pg_catalog.now()",
  "now（）",
  "constructor",
  "__proto__",
  "toString",
  "hasOwnProperty",
  "valueOf",
  "x",
];

describe("EXPRESSION_DEFAULTS", () => {
  it("admits exactly the two spellings the workspace uses", () => {
    expect(ADMITTED_EXPRESSION_DEFAULTS).toEqual(["now()", "uuid_generate_v7()"]);
  });

  it("renders each admitted key to its own spelling and nothing else", () => {
    for (const [key, entry] of EXPRESSION_DEFAULTS) {
      expect(entry.sql).toBe(key);
      expect(admittedExpressionDefaultSql(key)).toBe(entry.sql);
    }
  });

  it("covers every expression default the built-in traits carry", () => {
    let seen = 0;
    for (const [trait, fields] of BUILT_IN_TRAIT_FIELDS) {
      for (const f of fields) {
        if (f.default?.kind !== "expression") continue;
        seen += 1;
        expect(expressionDefaultRefusal(f), `${trait}.${f.name}`).toBeNull();
      }
    }
    // auditable's created_at and updated_at; a floor so the loop cannot pass having seen nothing.
    expect(seen).toBeGreaterThanOrEqual(2);
  });
});

describe("emitDefault on an expression", () => {
  it.each(ADMITTED_EXPRESSION_DEFAULTS)("renders admitted `%s`", (expression) => {
    expect(emitDefault({ kind: "expression", expression })).toBe(expression);
  });

  it.each(REFUSED_EXPRESSIONS.map((e) => [JSON.stringify(e), e] as const))(
    "throws for %s",
    (_label, expression) => {
      expect(() => emitDefault({ kind: "expression", expression })).toThrow(
        UnadmittedExpressionDefaultError,
      );
    },
  );

  it("never echoes the refused text, only its length", () => {
    try {
      emitDefault({ kind: "expression", expression: L31_PAYLOAD });
      throw new Error("expected a refusal");
    } catch (e) {
      expect(e).toBeInstanceOf(UnadmittedExpressionDefaultError);
      const err = e as UnadmittedExpressionDefaultError;
      expect(err.message).not.toContain("CREATE TABLE");
      expect(err.message).not.toContain("pwned");
      expect(err.message).toContain(`${L31_PAYLOAD.length} characters`);
      expect(err.expressionLength).toBe(L31_PAYLOAD.length);
    }
  });

  it("still renders literal defaults, which are values and not SQL", () => {
    expect(emitDefault({ kind: "literal", value: L31_PAYLOAD })).toBe(
      "'''a''); CREATE TABLE public.pwned(x int); --'",
    );
  });
});

describe("expressionDefaultRefusal", () => {
  const dt = (expression: string, extra: Partial<Field> = {}): Field => ({
    name: "stamped_at",
    type: { kind: "datetime" },
    default: { kind: "expression", expression },
    ...extra,
  });

  it("answers null for a field with no expression default", () => {
    expect(expressionDefaultRefusal({ name: "a", type: { kind: "text" } })).toBeNull();
    expect(
      expressionDefaultRefusal({
        name: "a",
        type: { kind: "text" },
        default: { kind: "literal", value: "x" },
      }),
    ).toBeNull();
  });

  it("admits now() on a datetime and uuid_generate_v7() on a uuid", () => {
    expect(expressionDefaultRefusal(dt("now()"))).toBeNull();
    expect(
      expressionDefaultRefusal({
        name: "token",
        type: { kind: "uuid" },
        default: { kind: "expression", expression: "uuid_generate_v7()" },
      }),
    ).toBeNull();
  });

  it.each(REFUSED_EXPRESSIONS.map((e) => [JSON.stringify(e), e] as const))(
    "refuses %s without echoing it",
    (_label, expression) => {
      const reason = expressionDefaultRefusal(dt(expression));
      expect(reason).toMatch(/not one of the admitted expressions/);
      if (expression.length > 3) expect(reason).not.toContain(expression);
    },
  );

  it("refuses an admitted expression on a field type its result does not fit", () => {
    expect(
      expressionDefaultRefusal({
        name: "label",
        type: { kind: "text" },
        default: { kind: "expression", expression: "now()" },
      }),
    ).toMatch(/datetime field, not a text one/);
    expect(
      expressionDefaultRefusal({
        name: "ref",
        type: { kind: "reference", target: "Account" },
        default: { kind: "expression", expression: "uuid_generate_v7()" },
      }),
    ).toMatch(/uuid field, not a reference one/);
  });

  it("refuses a database-computed default on a field encrypted at rest", () => {
    expect(expressionDefaultRefusal(dt("now()", { classification: "phi" }))).toMatch(/ciphertext/);
    expect(expressionDefaultRefusal(dt("now()", { classification: "regulated" }))).toMatch(
      /ciphertext/,
    );
    expect(expressionDefaultRefusal(dt("now()", { classification: "pii" }))).toBeNull();
  });
});
