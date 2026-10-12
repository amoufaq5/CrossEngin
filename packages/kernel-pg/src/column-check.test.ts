import { describe, expect, it } from "vitest";
import { META_TABLES, type TableDefinition } from "@crossengin/kernel/bootstrap";

import {
  COLUMN_CHECK_DELTA_REASONS,
  columnCheckAddName,
  columnCheckRequestsFor,
  declaredColumnChecks,
  diffColumnChecks,
  expectedColumnCheckName,
  isChosenCheckName,
} from "./column-check.js";
import { expressionKey, type RenderedExpressions } from "./expression-render.js";
import type { LiveCheckConstraint, LiveTable } from "./introspection.js";

const WIDGETS: TableDefinition = {
  schema: "meta",
  name: "widgets",
  columns: [
    { name: "id", type: "UUID", notNull: true },
    { name: "kind", type: "TEXT", notNull: true, check: "kind IN ('a', 'b')" },
    { name: "amount_cents", type: "INTEGER", notNull: true },
    { name: "remaining_cents", type: "INTEGER", check: "remaining_cents <= amount_cents" },
    { name: "label", type: "TEXT" },
  ],
  primaryKey: ["id"],
};

const KIND_RENDERING = "(kind = ANY (ARRAY['a'::text, 'b'::text]))";
const REMAINING_RENDERING = "(remaining_cents <= amount_cents)";

function liveCheck(
  name: string,
  expression: string | null,
  columns: readonly string[],
): LiveCheckConstraint {
  return { name, expression, columns };
}

function liveWidgets(checks: readonly LiveCheckConstraint[]): LiveTable {
  return {
    schema: "meta",
    name: "widgets",
    columns: WIDGETS.columns.map((c) => ({
      name: c.name,
      dataType: "text",
      isNullable: c.notNull !== true,
      defaultExpr: null,
    })),
    indexes: [],
    policies: [],
    foreignKeys: [],
    checkConstraints: checks,
    rlsEnabled: false,
  };
}

/** Both of `WIDGETS`'s column checks rendered and parsed as Postgres really does it. */
const RENDERED: RenderedExpressions = {
  byRequest: new Map<string, string | null>([
    [expressionKey("widgets", "kind IN ('a', 'b')"), KIND_RENDERING],
    [expressionKey("widgets", "remaining_cents <= amount_cents"), REMAINING_RENDERING],
  ]),
  columnsByRequest: new Map<string, readonly string[] | null>([
    [expressionKey("widgets", "kind IN ('a', 'b')"), ["kind"]],
    [
      expressionKey("widgets", "remaining_cents <= amount_cents"),
      ["amount_cents", "remaining_cents"],
    ],
  ]),
};

/** The live set a correctly-applied `WIDGETS` carries. */
const CORRECT_CHECKS: readonly LiveCheckConstraint[] = [
  liveCheck("widgets_kind_check", KIND_RENDERING, ["kind"]),
  liveCheck("widgets_check", REMAINING_RENDERING, ["amount_cents", "remaining_cents"]),
];

/** A table whose two column checks are both cross-column, so both want `widgets_check`. */
function crossColumnPair(): {
  readonly table: TableDefinition;
  readonly rendered: RenderedExpressions;
  readonly live: (checks: readonly LiveCheckConstraint[]) => LiveTable;
} {
  const columns = [
    { name: "id", type: "UUID", notNull: true },
    { name: "amount_cents", type: "INTEGER" },
    { name: "remaining_cents", type: "INTEGER", check: "remaining_cents <= amount_cents" },
    { name: "label", type: "TEXT", check: "label <> amount_cents::text" },
  ];
  return {
    table: { ...WIDGETS, columns },
    rendered: {
      byRequest: new Map<string, string | null>([
        [expressionKey("widgets", "remaining_cents <= amount_cents"), REMAINING_RENDERING],
        [expressionKey("widgets", "label <> amount_cents::text"), "(label <> (amount_cents)::text)"],
      ]),
      columnsByRequest: new Map<string, readonly string[] | null>([
        [
          expressionKey("widgets", "remaining_cents <= amount_cents"),
          ["amount_cents", "remaining_cents"],
        ],
        [expressionKey("widgets", "label <> amount_cents::text"), ["amount_cents", "label"]],
      ]),
    },
    live: (checks) => ({
      ...liveWidgets(checks),
      columns: columns.map((c) => ({
        name: c.name,
        dataType: "text",
        isNullable: true,
        defaultExpr: null,
      })),
    }),
  };
}

describe("COLUMN_CHECK_DELTA_REASONS", () => {
  it("names the two ways a declared column check can differ from a stored one", () => {
    expect([...COLUMN_CHECK_DELTA_REASONS]).toEqual(["expression", "name"]);
  });
});

describe("declaredColumnChecks", () => {
  it("returns one entry per column carrying a check, in declaration order", () => {
    expect(declaredColumnChecks(WIDGETS)).toEqual([
      { column: "kind", expression: "kind IN ('a', 'b')" },
      { column: "remaining_cents", expression: "remaining_cents <= amount_cents" },
    ]);
  });

  it("returns nothing for a table with no column check", () => {
    expect(declaredColumnChecks({ ...WIDGETS, columns: [{ name: "id", type: "UUID" }] })).toEqual(
      [],
    );
  });

  it("finds every column check in the real catalog", () => {
    const total = META_TABLES.reduce((n, t) => n + declaredColumnChecks(t).length, 0);
    // A floor rather than an exact figure: the catalog grows, and what this pins is that the
    // traversal sees the whole of it rather than one table's worth.
    expect(total).toBeGreaterThan(700);
  });
});

describe("columnCheckRequestsFor", () => {
  it("asks for every column check's expression against its own table", () => {
    expect(columnCheckRequestsFor(WIDGETS)).toEqual([
      { table: "widgets", expr: "kind IN ('a', 'b')" },
      { table: "widgets", expr: "remaining_cents <= amount_cents" },
    ]);
  });

  it("asks for nothing when no column declares a check", () => {
    expect(columnCheckRequestsFor({ ...WIDGETS, columns: [{ name: "id", type: "UUID" }] })).toEqual(
      [],
    );
  });
});

describe("expectedColumnCheckName", () => {
  it("uses the single-column spelling when the expression resolves to one column", () => {
    // Verified live: `CHECK (c IN ('x','y'))` on column c arrives as `probe_c_check`.
    expect(expectedColumnCheckName("widgets", ["kind"])).toEqual({
      name: "widgets_kind_check",
      ambiguous: false,
    });
  });

  it("names the column the expression references, not the column it was declared on", () => {
    // Postgres passes `pull_var_clause`'s single Var to ChooseConstraintName; which column carried
    // the `CHECK` clause never enters into it.
    expect(expectedColumnCheckName("widgets", ["amount_cents"]).name).toBe(
      "widgets_amount_cents_check",
    );
  });

  it("uses the table-level spelling for a cross-column expression, and calls it ambiguous", () => {
    // Verified live: `CHECK (d <= a)` on column d arrives as `probe_check`.
    expect(expectedColumnCheckName("widgets", ["amount_cents", "remaining_cents"])).toEqual({
      name: "widgets_check",
      ambiguous: true,
    });
  });

  it("uses the table-level spelling for an expression over no column at all", () => {
    expect(expectedColumnCheckName("widgets", [])).toEqual({
      name: "widgets_check",
      ambiguous: true,
    });
  });

  it("truncates the way makeObjectName does rather than cutting the label off", () => {
    const out = expectedColumnCheckName("access_review_templates", [
      "default_remediation_days_from_completion",
    ]);
    expect(out.name).toBe("access_review_templates_default_remediation_days_from_com_check");
    expect(out.name.endsWith("_check")).toBe(true);
  });
});

describe("isChosenCheckName", () => {
  it("accepts the unsuffixed name", () => {
    expect(isChosenCheckName("widgets", null, "widgets_check")).toBe(true);
  });

  it("accepts the numeric suffixes ChooseConstraintName appends on a collision", () => {
    // Verified live: a table with two cross-column column checks carries `multi_check` and
    // `multi_check1`.
    expect(isChosenCheckName("multi", null, "multi_check1")).toBe(true);
    expect(isChosenCheckName("multi", null, "multi_check2")).toBe(true);
  });

  it("accepts the single-column spelling and its suffixes", () => {
    expect(isChosenCheckName("widgets", "kind", "widgets_kind_check")).toBe(true);
    expect(isChosenCheckName("widgets", "kind", "widgets_kind_check3")).toBe(true);
  });

  it("rejects a name from another table", () => {
    expect(isChosenCheckName("widgets", null, "gadgets_check")).toBe(false);
  });

  it("rejects a hand-written name that merely starts the same way", () => {
    expect(isChosenCheckName("widgets", null, "widgets_check_v2")).toBe(false);
  });

  it("rejects a pass number past the bound rather than looping forever", () => {
    expect(isChosenCheckName("widgets", null, "widgets_check999")).toBe(false);
  });
});

describe("columnCheckAddName", () => {
  it("writes the expected name when nothing else can want it", () => {
    expect(
      columnCheckAddName({
        expectedName: "widgets_kind_check",
        liveName: "widgets_check1",
        contested: false,
        expressionDiffers: true,
      }),
    ).toBe("widgets_kind_check");
  });

  it("reuses the live name when the expected one is contested and the expression differs", () => {
    // The live name is the one name certainly free: the same statement drops it.
    expect(
      columnCheckAddName({
        expectedName: "widgets_check",
        liveName: "widgets_check1",
        contested: true,
        expressionDiffers: true,
      }),
    ).toBe("widgets_check1");
  });

  it("writes nothing for a contested name-only difference, which would not converge", () => {
    // Dropping `widgets_check1` and re-adding it with the same expression repairs nothing, and the
    // next diff reports the same difference — a plan step that never closes.
    expect(
      columnCheckAddName({
        expectedName: "widgets_check",
        liveName: "widgets_check1",
        contested: true,
        expressionDiffers: false,
      }),
    ).toBeNull();
  });

  it("writes the expected name for an uncontested name-only difference", () => {
    expect(
      columnCheckAddName({
        expectedName: "widgets_kind_check",
        liveName: "widgets_check",
        contested: false,
        expressionDiffers: false,
      }),
    ).toBe("widgets_kind_check");
  });
});

describe("diffColumnChecks", () => {
  it("reports nothing against a correctly-applied table", () => {
    const out = diffColumnChecks(WIDGETS, liveWidgets(CORRECT_CHECKS), RENDERED, new Set());
    expect(out.changed).toEqual([]);
    expect(out.missing).toEqual([]);
    expect(out.complete).toBe(true);
    expect([...out.claimed].sort()).toEqual(["widgets_check", "widgets_kind_check"]);
  });

  it("compares nothing at all when no renderings were supplied", () => {
    const out = diffColumnChecks(
      WIDGETS,
      liveWidgets([liveCheck("widgets_kind_check", "(kind = 'a'::text)", ["kind"])]),
      { byRequest: new Map() },
      new Set(),
    );
    expect(out.changed).toEqual([]);
    expect(out.missing).toEqual([]);
    expect(out.claimed.size).toBe(0);
    // Incomplete, so the caller falls back to the over-approximated expected-name set and the
    // unclaimed row does not read as undeclared.
    expect(out.complete).toBe(false);
  });

  it("compares nothing when the rendering is there but the parsed column set is not", () => {
    const out = diffColumnChecks(
      WIDGETS,
      liveWidgets([liveCheck("widgets_kind_check", "(kind = 'a'::text)", ["kind"])]),
      { byRequest: RENDERED.byRequest },
      new Set(),
    );
    expect(out.changed).toEqual([]);
    expect(out.complete).toBe(false);
  });

  it("reports a changed expression under the name Postgres gave it", () => {
    const out = diffColumnChecks(
      WIDGETS,
      liveWidgets([
        liveCheck("widgets_kind_check", "(kind = 'a'::text)", ["kind"]),
        CORRECT_CHECKS[1] as LiveCheckConstraint,
      ]),
      RENDERED,
      new Set(),
    );
    expect(out.changed).toHaveLength(1);
    expect(out.changed[0]).toMatchObject({
      column: "kind",
      liveName: "widgets_kind_check",
      expectedName: "widgets_kind_check",
      addName: "widgets_kind_check",
      reasons: ["expression"],
      detail: `(kind = 'a'::text) → ${KIND_RENDERING}`,
    });
    expect(out.missing).toEqual([]);
  });

  it("reports a changed cross-column expression, and keeps the live name for the add", () => {
    const out = diffColumnChecks(
      WIDGETS,
      liveWidgets([
        CORRECT_CHECKS[0] as LiveCheckConstraint,
        liveCheck("widgets_check", "(remaining_cents < amount_cents)", [
          "amount_cents",
          "remaining_cents",
        ]),
      ]),
      RENDERED,
      new Set(),
    );
    expect(out.changed).toHaveLength(1);
    expect(out.changed[0]).toMatchObject({
      column: "remaining_cents",
      liveName: "widgets_check",
      expectedName: "widgets_check",
      // Contested: every cross-column column check on the table wants `widgets_check`.
      addName: "widgets_check",
      reasons: ["expression"],
    });
  });

  it("claims a row whose stored expression could not be deparsed, without comparing it", () => {
    const out = diffColumnChecks(
      WIDGETS,
      liveWidgets([liveCheck("widgets_kind_check", null, ["kind"]), CORRECT_CHECKS[1] as LiveCheckConstraint]),
      RENDERED,
      new Set(),
    );
    expect(out.changed).toEqual([]);
    expect(out.claimed.has("widgets_kind_check")).toBe(true);
    expect(out.complete).toBe(true);
  });

  it("reports a declared check with nothing behind it as missing", () => {
    const out = diffColumnChecks(
      WIDGETS,
      liveWidgets([CORRECT_CHECKS[1] as LiveCheckConstraint]),
      RENDERED,
      new Set(),
    );
    expect(out.missing).toEqual([
      {
        column: "kind",
        expression: "kind IN ('a', 'b')",
        expectedName: "widgets_kind_check",
        addName: "widgets_kind_check",
      },
    ]);
    expect(out.changed).toEqual([]);
  });

  it("refuses to name the add for a missing check whose name is contested", () => {
    const out = diffColumnChecks(
      WIDGETS,
      liveWidgets([CORRECT_CHECKS[0] as LiveCheckConstraint]),
      RENDERED,
      new Set(),
    );
    // `remaining_cents` wants `widgets_check`, which Postgres may land on with a numeric suffix
    // depending on what else it is naming — so no name is written and the difference is reported.
    expect(out.missing).toEqual([
      {
        column: "remaining_cents",
        expression: "remaining_cents <= amount_cents",
        expectedName: "widgets_check",
        addName: null,
      },
    ]);
  });

  it("matches by rendering when the constraint sits under a name Postgres would not choose now", () => {
    // The catalog's expression used to be cross-column and is now single-column, so the database
    // still holds it as `widgets_check` while a fresh install would call it `widgets_kind_check`.
    const out = diffColumnChecks(
      WIDGETS,
      liveWidgets([
        liveCheck("widgets_check1", KIND_RENDERING, ["kind"]),
        CORRECT_CHECKS[1] as LiveCheckConstraint,
      ]),
      RENDERED,
      new Set(),
    );
    expect(out.changed).toHaveLength(1);
    expect(out.changed[0]).toMatchObject({
      column: "kind",
      liveName: "widgets_check1",
      expectedName: "widgets_kind_check",
      addName: "widgets_kind_check",
      reasons: ["name"],
    });
  });

  it("matches by naming family when neither the name nor the expression does", () => {
    const out = diffColumnChecks(
      WIDGETS,
      liveWidgets([
        liveCheck("widgets_check1", "(kind = 'a'::text)", ["kind"]),
        CORRECT_CHECKS[1] as LiveCheckConstraint,
      ]),
      RENDERED,
      new Set(),
    );
    expect(out.changed).toHaveLength(1);
    expect(out.changed[0]).toMatchObject({
      column: "kind",
      liveName: "widgets_check1",
      expectedName: "widgets_kind_check",
      reasons: ["name", "expression"],
    });
    expect(out.missing).toEqual([]);
  });

  it("gives the shared table-level name to the first declaration that wants it", () => {
    const two = crossColumnPair();
    const live: LiveTable = {
      ...two.live([liveCheck("widgets_check", "(amount_cents > 0)", ["amount_cents"])]),
    };
    const out = diffColumnChecks(two.table, live, two.rendered, new Set());
    // Both checks want `widgets_check` and only one row carries it. Declaration order decides,
    // which is also the order `CREATE TABLE` would have named them in — and the second is reported
    // missing with no `addName`, since `ChooseConstraintName`'s suffix is not a plan's to predict.
    expect(out.changed.map((c) => c.column)).toEqual(["remaining_cents"]);
    expect(out.changed[0]).toMatchObject({
      liveName: "widgets_check",
      expectedName: "widgets_check",
      addName: "widgets_check",
      reasons: ["expression"],
    });
    expect(out.missing).toEqual([
      {
        column: "label",
        expression: "label <> amount_cents::text",
        expectedName: "widgets_check",
        addName: null,
      },
    ]);
  });

  it("writes no add name for a contested name-only difference", () => {
    const two = crossColumnPair();
    const live: LiveTable = {
      ...two.live([
        // Correct expression, but under the suffixed name — so `widgets_check` is where a fresh
        // install would put it and that name is contested by the other declaration.
        liveCheck("widgets_check1", REMAINING_RENDERING, ["amount_cents", "remaining_cents"]),
      ]),
    };
    const out = diffColumnChecks(two.table, live, two.rendered, new Set());
    expect(out.changed).toHaveLength(1);
    expect(out.changed[0]).toMatchObject({
      column: "remaining_cents",
      liveName: "widgets_check1",
      expectedName: "widgets_check",
      reasons: ["name"],
      addName: null,
    });
  });

  it("leaves family rows alone when two of them could be the same declaration", () => {
    const two = crossColumnPair();
    const live: LiveTable = {
      ...two.live([
        liveCheck("widgets_check1", "(remaining_cents < amount_cents)", [
          "amount_cents",
          "remaining_cents",
        ]),
        liveCheck("widgets_check2", "(remaining_cents > amount_cents)", [
          "amount_cents",
          "remaining_cents",
        ]),
      ]),
    };
    const out = diffColumnChecks(two.table, live, two.rendered, new Set());
    // `widgets_check` itself is absent and two suffixed rows both cover `remaining_cents`, so
    // nothing says which is the declared one. Both rows stay unclaimed and the declaration is
    // reported missing — one finding beside two undeclared rows, rather than a guess.
    expect(out.changed).toEqual([]);
    expect(out.missing.map((m) => m.column)).toEqual(["remaining_cents", "label"]);
    expect(out.claimed.size).toBe(0);
  });

  it("never claims a row a declared table-level check already matched", () => {
    const out = diffColumnChecks(
      WIDGETS,
      liveWidgets([
        liveCheck("widgets_kind_check", KIND_RENDERING, ["kind"]),
        CORRECT_CHECKS[1] as LiveCheckConstraint,
      ]),
      RENDERED,
      new Set(["widgets_kind_check"]),
    );
    expect(out.claimed.has("widgets_kind_check")).toBe(false);
    // The declaration is reported missing, and it will not write over the name either.
    expect(out.missing).toEqual([
      {
        column: "kind",
        expression: "kind IN ('a', 'b')",
        expectedName: "widgets_kind_check",
        addName: null,
      },
    ]);
  });

  it("skips a check whose column is not live yet, and says so", () => {
    const live: LiveTable = {
      ...liveWidgets([CORRECT_CHECKS[1] as LiveCheckConstraint]),
      columns: WIDGETS.columns
        .filter((c) => c.name !== "kind")
        .map((c) => ({ name: c.name, dataType: "text", isNullable: true, defaultExpr: null })),
    };
    const out = diffColumnChecks(WIDGETS, live, RENDERED, new Set());
    // The `ADD COLUMN` carries the CHECK along, so there is nothing to plan and nothing to report.
    expect(out.changed).toEqual([]);
    expect(out.missing).toEqual([]);
    expect(out.complete).toBe(false);
  });

  it("returns the empty diff for a table declaring no column check", () => {
    const out = diffColumnChecks(
      { ...WIDGETS, columns: [{ name: "id", type: "UUID" }] },
      liveWidgets([liveCheck("widgets_adhoc_check", "(id IS NOT NULL)", ["id"])]),
      RENDERED,
      new Set(),
    );
    expect(out.complete).toBe(true);
    expect(out.claimed.size).toBe(0);
  });

  it("treats a declared expression the table cannot carry as unknown, not as drift", () => {
    const rendered: RenderedExpressions = {
      byRequest: new Map<string, string | null>([
        [expressionKey("widgets", "kind IN ('a', 'b')"), null],
        [expressionKey("widgets", "remaining_cents <= amount_cents"), REMAINING_RENDERING],
      ]),
      columnsByRequest: new Map<string, readonly string[] | null>([
        [expressionKey("widgets", "kind IN ('a', 'b')"), null],
        [
          expressionKey("widgets", "remaining_cents <= amount_cents"),
          ["amount_cents", "remaining_cents"],
        ],
      ]),
    };
    const out = diffColumnChecks(WIDGETS, liveWidgets(CORRECT_CHECKS), rendered, new Set());
    expect(out.changed).toEqual([]);
    expect(out.missing).toEqual([]);
    expect(out.complete).toBe(false);
  });

  it("pairs two checks declaring one expression with the rows already carrying their names", () => {
    const twins: TableDefinition = {
      ...WIDGETS,
      columns: [
        { name: "a", type: "INTEGER", check: "a >= 0" },
        { name: "b", type: "INTEGER", check: "b >= 0" },
      ],
    };
    const rendered: RenderedExpressions = {
      byRequest: new Map<string, string | null>([
        [expressionKey("widgets", "a >= 0"), "(a >= 0)"],
        [expressionKey("widgets", "b >= 0"), "(b >= 0)"],
      ]),
      columnsByRequest: new Map<string, readonly string[] | null>([
        [expressionKey("widgets", "a >= 0"), ["a"]],
        [expressionKey("widgets", "b >= 0"), ["b"]],
      ]),
    };
    const live: LiveTable = {
      ...liveWidgets([
        liveCheck("widgets_b_check", "(b >= 0)", ["b"]),
        liveCheck("widgets_a_check", "(a >= 0)", ["a"]),
      ]),
      columns: twins.columns.map((c) => ({
        name: c.name,
        dataType: "integer",
        isNullable: true,
        defaultExpr: null,
      })),
    };
    const out = diffColumnChecks(twins, live, rendered, new Set());
    expect(out.changed).toEqual([]);
    expect([...out.claimed].sort()).toEqual(["widgets_a_check", "widgets_b_check"]);
  });
});
