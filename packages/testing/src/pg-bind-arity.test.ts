import { describe, expect, it } from "vitest";

import {
  assertBindArity,
  bindArityMismatch,
  referencedParamPositions,
} from "./pg-bind-arity.js";

describe("referencedParamPositions", () => {
  it("finds a single placeholder", () => {
    expect(referencedParamPositions("SELECT 1 WHERE a = $1")).toEqual([1]);
  });

  it("sorts ascending and de-duplicates a position used twice", () => {
    expect(referencedParamPositions("WHERE a = $2 AND b = $1 AND c = $2")).toEqual([1, 2]);
  });

  it("reads a two-digit position", () => {
    expect(referencedParamPositions("VALUES ($9, $10, $11)")).toEqual([9, 10, 11]);
  });

  it("finds none in a statement that binds nothing", () => {
    expect(referencedParamPositions("SELECT now()")).toEqual([]);
  });

  it("ignores a dollar-quoted body, so a plpgsql guard is not misread", () => {
    // kernel-pg's row-counting guards embed a statement inside `DO $ce$ … $ce$`, and plpgsql
    // itself uses `$1` for its own arguments. A placeholder scan that read inside the body would
    // report positions the bind step never sees.
    const sql = "DO $ce$ BEGIN RAISE 'x %', $1; END $ce$";
    expect(referencedParamPositions(sql)).toEqual([]);
  });

  it("reads placeholders outside a dollar-quoted body on the same statement", () => {
    const sql = "SELECT $1, (DO_NOT_RUN $tag$ $7 $tag$), $2";
    expect(referencedParamPositions(sql)).toEqual([1, 2]);
  });

  it("does not treat a bare dollar as a position", () => {
    expect(referencedParamPositions("SELECT '$', '$x', $1")).toEqual([1]);
  });

  it("requires the closing dollar tag to match, so a bare $$ inside a tagged body does not end it", () => {
    // Under an optional back-reference this stops at the inner `$$`, leaves ` q $a$, $2` behind and
    // reports `$2` — a position the bind step never sees, which is a false positive and the one
    // direction a fence must not fail in.
    expect(referencedParamPositions("DO $a$ $1 $$ q $2 $a$")).toEqual([]);
  });

  it("does not mistake an unpaired tag for a body, so later placeholders survive", () => {
    expect(referencedParamPositions("SELECT '$a$ unclosed', $1, $2")).toEqual([1, 2]);
  });
});

describe("bindArityMismatch", () => {
  it("answers null when the statement references exactly what it binds", () => {
    expect(bindArityMismatch("WHERE a = $1 AND b = $2", ["a", "b"])).toBeNull();
  });

  it("answers null for a statement with no parameters and an empty array", () => {
    expect(bindArityMismatch("SELECT 1", [])).toBeNull();
  });

  it("answers null when params is undefined and nothing is referenced", () => {
    expect(bindArityMismatch("SELECT 1", undefined)).toBeNull();
  });

  it("names an unreferenced trailing parameter — the 08P01 case", () => {
    // The shape that broke four of five template transitions: the caller pushed an actor into
    // `params` for every target while only one arm's assignment mentioned it.
    expect(bindArityMismatch("SET status = $3 WHERE t = $1 AND i = $2", ["t", "i", "s", "actor"]))
      .toEqual({ unsupplied: [], unreferenced: [4] });
  });

  it("names an unreferenced hole in the middle, not only a trailing one", () => {
    expect(bindArityMismatch("WHERE a = $1 AND c = $3", ["a", "b", "c"])).toEqual({
      unsupplied: [],
      unreferenced: [2],
    });
  });

  it("names a referenced position past the end — the 42P18 case", () => {
    expect(bindArityMismatch("SET x = $5 WHERE t = $1", ["t"])).toEqual({
      unsupplied: [5],
      unreferenced: [],
    });
  });

  it("reports both directions at once", () => {
    expect(bindArityMismatch("WHERE a = $1 AND z = $9", ["a", "b"])).toEqual({
      unsupplied: [9],
      unreferenced: [2],
    });
  });

  it("treats undefined params as zero supplied, so a referenced position is unsupplied", () => {
    expect(bindArityMismatch("WHERE a = $1", undefined)).toEqual({
      unsupplied: [1],
      unreferenced: [],
    });
  });

  it("catches the real deprecate shape, where the maximum agrees and the hole is in the middle", () => {
    // Six supplied, `{1,2,3,4,6}` referenced: `max(referenced) === params.length`, so both
    // one-way checks pass it and only set equality does not. This is the statement that answered
    // `42P18 could not determine data type of parameter $5` on every deprecate (ADR-0370).
    const sql =
      "UPDATE t SET status = $3, deprecated_at = $6::timestamptz" +
      " WHERE tenant_id = $1 AND ntpl_id = $2 AND status = $4";
    const params = ["t", "i", "deprecated", "approved", "actor", "2026-09-02T00:00:00.000Z"];
    expect(Math.max(...referencedParamPositions(sql))).toBe(params.length);
    expect(bindArityMismatch(sql, params)).toEqual({ unsupplied: [], unreferenced: [5] });
  });

  it("is both-ways rather than a maximum comparison", () => {
    // max(referenced) === params.length holds for both of these and only one is sound, which is
    // why the predicate compares the whole set.
    expect(bindArityMismatch("WHERE a = $1 AND b = $2", ["a", "b"])).toBeNull();
    expect(bindArityMismatch("WHERE a = $2 AND b = $2", ["a", "b"])).toEqual({
      unsupplied: [],
      unreferenced: [1],
    });
  });
});

describe("assertBindArity", () => {
  it("returns for an agreeing statement", () => {
    expect(() => {
      assertBindArity("WHERE a = $1", ["a"]);
    }).not.toThrow();
  });

  it("names 08P01 and the unreferenced position", () => {
    expect(() => {
      assertBindArity("WHERE a = $1", ["a", "b"]);
    }).toThrow(/08P01.*\$2 referenced by nothing/s);
  });

  it("names 42P18 and the unsupplied position", () => {
    expect(() => {
      assertBindArity("SET x = $5 WHERE a = $1", ["a"]);
    }).toThrow(/42P18.*\$5 past the end of a 1-parameter array/s);
  });

  it("includes the statement, collapsed to one line", () => {
    expect(() => {
      assertBindArity("UPDATE t\n  SET a = $1\n  WHERE b = $9", ["x"]);
    }).toThrow(/statement: UPDATE t SET a = \$1 WHERE b = \$9/);
  });

  it("names both codes when both directions are wrong", () => {
    let message = "";
    try {
      assertBindArity("WHERE a = $1 AND z = $9", ["a", "b"]);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain("08P01");
    expect(message).toContain("42P18");
  });
});
