import { ZodError, z } from "zod";
import { describe, expect, it } from "vitest";

import {
  WITHHELD_PATH_COMPONENT,
  numericIdentity,
  readRows,
  readRowsWithUnreadable,
  textIdentity,
  unreadableDetail,
  type UnreadableRow,
} from "./read-rows.js";

const RowSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["draft", "published"]),
});

type StoredRecord = z.infer<typeof RowSchema>;

const mapRow = (row: Record<string, unknown>): StoredRecord => RowSchema.parse(row);
const identifyRow = (row: Record<string, unknown>): string | null => textIdentity(row, "id");

const readable = (id: string): Record<string, unknown> => ({ id, kind: "draft" });
/** A row edited into a state the CHECK permits and the contract forbids (ADR-0289). */
const refused = (id: string): Record<string, unknown> => ({ id, kind: "retired-by-hand" });

const record = (id: string): StoredRecord => ({ id, kind: "draft" });

function parseFailure(schema: z.ZodTypeAny, value: unknown): ZodError {
  const result = schema.safeParse(value);
  if (result.success) throw new Error("fixture parses, so it cannot stand in for a refused row");
  return result.error;
}

describe("readRows", () => {
  it("returns the readable rows of a page whose middle row the contract refuses, in order", () => {
    const reports: UnreadableRow[] = [];
    const out = readRows(
      [readable("a"), refused("b"), readable("c")],
      mapRow,
      identifyRow,
      (row) => reports.push(row),
    );
    expect(out).toEqual([record("a"), record("c")]);
    expect(reports).toEqual([{ identity: "b", detail: "kind: invalid_enum_value" }]);
  });

  it("reports nothing at all for a page it can represent entirely", () => {
    const reports: UnreadableRow[] = [];
    const out = readRows([readable("a"), readable("b")], mapRow, identifyRow, (row) =>
      reports.push(row),
    );
    expect(out).toEqual([record("a"), record("b")]);
    expect(reports).toEqual([]);
  });

  it("returns no records and reports every row when the contract refuses all of them", () => {
    const rows = [refused("a"), refused("b"), refused("c")];
    const reports: UnreadableRow[] = [];
    const out = readRows(rows, mapRow, identifyRow, (row) => reports.push(row));
    expect(out).toEqual([]);
    expect(reports).toHaveLength(rows.length);
  });

  it("names the refused row's own business key, which only the raw row can supply", () => {
    // The mapper produced nothing, so the identity cannot have come from a record: `identify` read
    // the column straight off the row that failed.
    const reports: UnreadableRow[] = [];
    readRows([refused("ff_checkout1")], mapRow, identifyRow, (row) => reports.push(row));
    expect(reports[0]?.identity).toBe("ff_checkout1");
  });

  it("reports two fields and no more, so no other column of a refused row travels with the finding", () => {
    const reports: UnreadableRow[] = [];
    readRows(
      [{ id: "b", kind: "retired-by-hand", secret_note: "do not disclose" }],
      mapRow,
      identifyRow,
      (row) => reports.push(row),
    );
    expect(Object.keys(reports[0] ?? {}).sort()).toEqual(["detail", "identity"]);
    expect(JSON.stringify(reports)).not.toContain("do not disclose");
  });

  it("asks for an identity only for a row it could not represent", () => {
    const asked: unknown[] = [];
    readRows(
      [readable("a"), refused("b"), readable("c")],
      mapRow,
      (row) => {
        asked.push(row.id);
        return textIdentity(row, "id");
      },
      () => undefined,
    );
    expect(asked).toEqual(["b"]);
  });

  /**
   * `identify` runs inside the catch, so its own failure is one unidentified finding rather than a
   * page that could not be read. Moving it outside the catch is what this asserts against.
   */
  it("does not let a throw from `identify` cost the rows after it", () => {
    const reports: UnreadableRow[] = [];
    const out = readRows(
      [refused("a"), refused("b"), readable("c")],
      mapRow,
      (row) => {
        if (row.id === "a") throw new Error("the identifying column is itself unreadable");
        return textIdentity(row, "id");
      },
      (row) => reports.push(row),
    );
    expect(out).toEqual([record("c")]);
    expect(reports.map((r) => r.identity)).toEqual([null, "b"]);
  });

  it("keeps the mapper's cause when `identify` throws as well", () => {
    const reports: UnreadableRow[] = [];
    readRows(
      [refused("a")],
      mapRow,
      () => {
        throw new Error("the identifying column is itself unreadable");
      },
      (row) => reports.push(row),
    );
    expect(reports[0]?.detail).toBe("kind: invalid_enum_value");
  });

  it("carries a mapper's own guard message through to the report", () => {
    const reports: UnreadableRow[] = [];
    const out = readRows(
      [readable("a"), { id: "b", kind: "draft", created_at: "not a timestamp" }],
      (row) => {
        if (row.created_at !== undefined) throw new Error("created_at is not an ISO instant");
        return mapRow(row);
      },
      identifyRow,
      (row) => reports.push(row),
    );
    expect(out).toEqual([record("a")]);
    expect(reports).toEqual([{ identity: "b", detail: "created_at is not an ISO instant" }]);
  });
});

describe("readRowsWithUnreadable", () => {
  it("distinguishes an empty page from a page it could read nothing of", () => {
    expect(readRowsWithUnreadable([], mapRow, identifyRow)).toEqual({
      records: [],
      unreadable: [],
    });
    const wholly = readRowsWithUnreadable([refused("a"), refused("b")], mapRow, identifyRow);
    expect(wholly.records).toEqual([]);
    expect(wholly.unreadable).toHaveLength(2);
  });

  it("is `readRows` with the reports collected, for the same input", () => {
    // Asserting the agreement rather than restating `readRows`' assertions is what stops the two
    // drifting: a change to either that the other does not follow fails here.
    const rows = [readable("a"), refused("b"), readable("c"), refused("d")];
    const collected: UnreadableRow[] = [];
    const viaCallback = readRows(rows, mapRow, identifyRow, (row) => collected.push(row));
    const viaReturn = readRowsWithUnreadable(rows, mapRow, identifyRow);
    expect(viaReturn.records).toEqual(viaCallback);
    expect(viaReturn.unreadable).toEqual(collected);
  });

  it("reports the unreadable rows in the order the page held them", () => {
    const { unreadable } = readRowsWithUnreadable(
      [refused("d"), readable("a"), refused("b")],
      mapRow,
      identifyRow,
    );
    expect(unreadable.map((r) => r.identity)).toEqual(["d", "b"]);
  });
});

describe("unreadableDetail", () => {
  it("names the refused field and the issue code and not the value the row holds", () => {
    const err = parseFailure(RowSchema, { id: "b", kind: "retired-by-hand" });
    // The stored value is in the error we were handed — `err.message` is the JSON of the issues and
    // an `invalid_enum_value` carries `received` — so returning that message is the disclosure.
    expect(err.message).toContain("retired-by-hand");
    expect(unreadableDetail(err)).toBe("kind: invalid_enum_value");
    expect(unreadableDetail(err)).not.toContain("retired-by-hand");
  });

  /**
   * This replaces an assertion that pinned the **old** behaviour, `"a.b: invalid_type"` — the full
   * path render, which is the disclosure the `z.record` cases below demonstrate. It is inverted
   * rather than deleted because the fact it was pinning is still a fact worth pinning: a nested
   * refusal must still name the column, and that is what `a` is.
   */
  it("names a nested field by its column and withholds the component below it", () => {
    const Nested = z.object({ a: z.object({ b: z.string() }) });
    expect(unreadableDetail(parseFailure(Nested, { a: { b: 7 } }))).toBe(
      `a.${WITHHELD_PATH_COMPONENT}: invalid_type`,
    );
  });

  /**
   * **The key is the hazard**: for a `z.record` the path component *is* a stored key, so the obvious
   * `path.join(".")` render discloses it — and the key may embed the value, which is what
   * `AccessReviewItem.grantAttributes` (`z.record(z.string(), z.string())`) makes reachable through
   * `readRowsWithUnreadable`.
   *
   * Asserted in the same shape as the enum case above — the value is in the error we were handed and
   * must not be in the detail — so the property is checkable rather than asserted in prose.
   */
  it("withholds a `z.record` key, because for a record the path component is the stored key", () => {
    const WithRecord = z.object({ grantAttributes: z.record(z.string(), z.string()) });
    const err = parseFailure(WithRecord, {
      grantAttributes: { "employee_ssn_123-45-6789": 7 },
    });
    expect(err.message).toContain("employee_ssn_123-45-6789");
    expect(unreadableDetail(err)).toBe(
      `grantAttributes.${WITHHELD_PATH_COMPONENT}: invalid_type`,
    );
    expect(unreadableDetail(err)).not.toContain("employee_ssn");
    expect(unreadableDetail(err)).not.toContain("123-45-6789");
  });

  it("de-duplicates the keys of a record, so the detail does not grow with the bad ones", () => {
    // The old render printed one entry per key, so a row with fifty refused attributes printed
    // fifty stored keys. They collapse to one entry now, which is also why the withheld component
    // is a single marker rather than one per key.
    const WithRecord = z.object({ grantAttributes: z.record(z.string(), z.string()) });
    const err = parseFailure(WithRecord, { grantAttributes: { ssn: 1, dob: 2, salary: 3 } });
    expect(err.issues).toHaveLength(3);
    expect(unreadableDetail(err)).toBe(
      `grantAttributes.${WITHHELD_PATH_COMPONENT}: invalid_type`,
    );
    for (const key of ["ssn", "dob", "salary"]) {
      expect(unreadableDetail(err)).not.toContain(key);
    }
  });

  it("still separates a bad JSONB column from a bad field inside it", () => {
    // Two facts with two remedies: `record` is not an object at all, or a field in it is wrong.
    // Collapsing the path to its head alone would have rendered both as `record: …`.
    const Outer = z.object({ record: z.object({ outcome: z.enum(["passed", "failed"]) }) });
    expect(unreadableDetail(parseFailure(Outer, { record: "not an object" }))).toBe(
      "record: invalid_type",
    );
    expect(unreadableDetail(parseFailure(Outer, { record: { outcome: "x" } }))).toBe(
      `record.${WITHHELD_PATH_COMPONENT}: invalid_enum_value`,
    );
  });

  it("renders an array index, which is a position and never stored text", () => {
    // So a refused element still says *which* element, where withholding every component past the
    // head would have said only `attestations`.
    const Outer = z.object({
      attestations: z.array(z.object({ outcome: z.enum(["erased", "retained"]) })),
      obligations: z.array(z.enum(["none", "tax_records_7y"])),
    });
    expect(
      unreadableDetail(
        parseFailure(Outer, { attestations: [{ outcome: "erased" }, { outcome: "x" }], obligations: [] }),
      ),
    ).toBe(`attestations.1.${WITHHELD_PATH_COMPONENT}: invalid_enum_value`);
    expect(
      unreadableDetail(parseFailure(Outer, { attestations: [], obligations: ["none", "nope"] })),
    ).toBe("obligations.1: invalid_enum_value");
  });

  it("reads `<root>` for a refusal about the object rather than a field", () => {
    const Refined = z
      .object({ created_by: z.string(), approved_by: z.string() })
      .superRefine((row, ctx) => {
        if (row.created_by === row.approved_by) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "approver must differ from author" });
        }
      });
    expect(unreadableDetail(parseFailure(Refined, { created_by: "u1", approved_by: "u1" }))).toBe(
      "<root>: custom",
    );
  });

  it("sorts the issues, so one defect reads the same whatever order zod walked the object in", () => {
    const Two = z.object({ zz: z.string(), aa: z.string() });
    const err = parseFailure(Two, {});
    expect(err.issues.map((i) => i.path.join("."))).toEqual(["zz", "aa"]);
    expect(unreadableDetail(err)).toBe("aa: invalid_type, zz: invalid_type");
  });

  it("de-duplicates two issues that name one field and one code", () => {
    const Twice = z.object({ id: z.string() }).superRefine((_row, ctx) => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "first" });
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "second" });
    });
    const err = parseFailure(Twice, { id: "a" });
    expect(err.issues).toHaveLength(2);
    expect(unreadableDetail(err)).toBe("<root>: custom");
  });

  it("answers `unparseable` for a zod error carrying no issues", () => {
    expect(unreadableDetail(new ZodError([]))).toBe("unparseable");
  });

  it("passes a non-zod error's own message through", () => {
    expect(unreadableDetail(new Error("created_at is not an ISO instant"))).toBe(
      "created_at is not an ISO instant",
    );
    expect(unreadableDetail(new TypeError("cannot read a BIGINT as a number"))).toBe(
      "cannot read a BIGINT as a number",
    );
  });

  it("answers `unparseable` for a throw that is not an error at all", () => {
    // Never the stringified throw: `"undefined"` as a detail reads like a field named undefined.
    for (const thrown of ["boom", undefined, null, 42, { code: "23514" }, []]) {
      expect(unreadableDetail(thrown)).toBe("unparseable");
    }
  });
});

describe("textIdentity", () => {
  it("answers a non-empty string column with itself", () => {
    expect(textIdentity({ id: "ff_checkout1" }, "id")).toBe("ff_checkout1");
    expect(textIdentity({ id: " " }, "id")).toBe(" ");
  });

  it("answers null for every row that does not name a handle", () => {
    // The empty string is the one worth stating: `null` says *the row does not name one*, where a
    // handle of `""` would send a remedy to `WHERE id = ''` (ADR-0331).
    for (const raw of ["", null, undefined, 42, 0, true, {}, []]) {
      expect(textIdentity({ id: raw }, "id")).toBeNull();
    }
    expect(textIdentity({}, "id")).toBeNull();
  });
});

describe("numericIdentity", () => {
  it("answers for both wire shapes an integer key arrives in", () => {
    // A BIGINT comes back from node-postgres as a string and an INTEGER as a number (ADR-0331), so
    // one `typeof` predicate would answer for one of the two and silently not the other.
    expect(numericIdentity({ seq: 42 }, "seq")).toBe("42");
    expect(numericIdentity({ seq: "42" }, "seq")).toBe("42");
  });

  it("answers for a sequence number of zero and for a negative one", () => {
    expect(numericIdentity({ seq: 0 }, "seq")).toBe("0");
    expect(numericIdentity({ seq: "0" }, "seq")).toBe("0");
    expect(numericIdentity({ seq: -1 }, "seq")).toBe("-1");
  });

  it("answers null for a column holding no number", () => {
    for (const raw of [Number.NaN, Infinity, -Infinity, "", "abc", null, undefined, true, {}]) {
      expect(numericIdentity({ seq: raw }, "seq")).toBeNull();
    }
    expect(numericIdentity({}, "seq")).toBeNull();
  });

  it("is why an integer key needs its own helper rather than one `String()` call", () => {
    expect(textIdentity({ seq: 42 }, "seq")).toBeNull();
    expect(numericIdentity({ seq: 42 }, "seq")).toBe("42");
  });
});
