import { describe, expect, it } from "vitest";

import {
  SEARCH_FOLD_FUNCTION,
  emitSearchFoldFunctionDdl,
  searchFoldExpr,
  searchFoldRef,
} from "./search-fold.js";

describe("SEARCH_FOLD_FUNCTION", () => {
  it("is a stable, unqualified function name", () => {
    expect(SEARCH_FOLD_FUNCTION).toBe("crossengin_fold_text");
  });
});

describe("searchFoldRef", () => {
  it("qualifies and quotes the function per serving schema", () => {
    expect(searchFoldRef("tenant_app")).toBe('"tenant_app"."crossengin_fold_text"');
  });

  it("refuses an unsafe schema identifier rather than interpolating it", () => {
    expect(() => searchFoldRef('x"; DROP SCHEMA public; --')).toThrow(/unsafe SQL identifier/);
  });
});

describe("searchFoldExpr", () => {
  it("wraps an expression in the fold, carrying the ::text cast on both sides", () => {
    expect(searchFoldExpr('"tenant_app"."crossengin_fold_text"', '"name"')).toBe(
      '"tenant_app"."crossengin_fold_text"("name"::text)',
    );
  });

  it("folds a JSONB document expression the same way", () => {
    expect(searchFoldExpr("unaccent", "document ->> 'name'")).toBe("unaccent(document ->> 'name'::text)");
  });

  it("is the single definition the index and the predicate both use", () => {
    // Same inputs → same string, which is what makes an index expression match a
    // predicate. A second derivation would be a coincidence maintained by hand,
    // and its failure is silent: a correct answer, read by sequential scan.
    const ref = searchFoldRef("app");
    expect(searchFoldExpr(ref, '"sku"')).toBe(searchFoldExpr(ref, '"sku"'));
  });
});

describe("emitSearchFoldFunctionDdl", () => {
  const ddl = emitSearchFoldFunctionDdl("tenant_app", "public");

  it("creates the function in the serving schema, replaceably", () => {
    expect(ddl).toContain('CREATE OR REPLACE FUNCTION "tenant_app"."crossengin_fold_text"(text) RETURNS text');
  });

  it("declares it IMMUTABLE, because a STABLE function cannot back an index at all", () => {
    expect(ddl).toContain("IMMUTABLE");
  });

  it("is STRICT, so a NULL column folds to NULL and matches nothing (as before)", () => {
    expect(ddl).toContain("STRICT");
  });

  it("is PARALLEL SAFE, so folding does not disqualify a parallel scan", () => {
    expect(ddl).toContain("PARALLEL SAFE");
  });

  it("schema-qualifies both the unaccent function and its dictionary", () => {
    expect(ddl).toContain('"public"."unaccent"(\'"public"."unaccent"\'::regdictionary, $1)');
  });

  it("uses the dictionary schema it is given, never a hardcoded public", () => {
    const elsewhere = emitSearchFoldFunctionDdl("tenant_app", "extensions");
    expect(elsewhere).toContain('"extensions"."unaccent"');
    expect(elsewhere).not.toContain('"public"');
  });

  it("refuses an unsafe extension schema rather than interpolating it into a string literal", () => {
    expect(() => emitSearchFoldFunctionDdl("app", "pub'lic")).toThrow(/unsafe SQL identifier/);
  });

  it("is one statement, terminated", () => {
    expect(ddl.trimEnd().endsWith(";")).toBe(true);
    expect(ddl.split(";").filter((s) => s.trim() !== "")).toHaveLength(1);
  });
});
