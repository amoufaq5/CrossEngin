import { quoteIdent } from "@crossengin/kernel/ddl";

/**
 * The accent-folding function the substring search compares through, defined
 * per serving schema.
 *
 * It exists because of an index-matching fact that cost this platform every
 * trigram index it emits. The search predicate wraps the column in a function
 * call, and **a plain-column index cannot match a function-call predicate at any
 * volatility** — the planner compares the index's expression against the
 * clause's left operand, and `col` is not `f(col)`. Measured: with the fold in
 * place the predicate is a `Seq Scan` *even with `enable_seqscan = off`*, which
 * is index matching rather than planner costing.
 *
 * Switching to the overload believed IMMUTABLE does not help either — the
 * catalog reports `provolatile = 's'` for **both** `unaccent` overloads,
 * including `unaccent(regdictionary, text)` — and a STABLE function cannot back
 * an index expression at all. So the fold is declared here, locally, as an
 * IMMUTABLE wrapper, and the SAME expression is used by the index and by the
 * predicate. One derivation, two call sites: a second one would be a
 * coincidence maintained by hand, and the coincidence failing is silent (a
 * correct answer, read by sequential scan).
 */
export const SEARCH_FOLD_FUNCTION = "crossengin_fold_text";

/** `"<schema>"."crossengin_fold_text"` — the qualified reference both sites call. */
export function searchFoldRef(schema: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(SEARCH_FOLD_FUNCTION)}`;
}

/**
 * The folded form of a text expression. The `::text` cast is part of it on both
 * sides, so the index expression and the predicate are textually identical and
 * matching cannot depend on which casts the parser happens to strip.
 */
export function searchFoldExpr(foldRef: string, expr: string): string {
  return `${foldRef}(${expr}::text)`;
}

/**
 * The `CREATE OR REPLACE FUNCTION` for the fold, to be applied before any index
 * that references it.
 *
 * Declaring an IMMUTABLE wrapper over a STABLE `unaccent` is the documented way
 * to index it, and the honest reading of the lie is narrow: `unaccent` is STABLE
 * only because `ALTER TEXT SEARCH DICTIONARY` could change the rules under it.
 * **A deployment that edits its unaccent rules must `REINDEX` the fold indexes**,
 * exactly as it would after changing any index expression's meaning.
 *
 * Both the function and the dictionary are schema-qualified from `unaccentSchema`
 * (discovered from `pg_extension`, never assumed to be `public`): an index
 * expression resolved through `search_path` would be pinned to whatever it
 * resolved to at creation while the query resolves per session, and the two
 * silently diverging is the failure this whole module exists to prevent.
 */
export function emitSearchFoldFunctionDdl(schema: string, unaccentSchema: string): string {
  const dict = `${quoteIdent(unaccentSchema)}.${quoteIdent("unaccent")}`;
  // `quoteIdent` rejects anything but a safe identifier, so neither part can
  // close the string literal this name sits inside.
  const dictLiteral = `'${dict}'::regdictionary`;
  return (
    `CREATE OR REPLACE FUNCTION ${searchFoldRef(schema)}(text) RETURNS text\n`
    + `  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE\n`
    + `  AS $fold$ SELECT ${dict}(${dictLiteral}, $1) $fold$;`
  );
}
