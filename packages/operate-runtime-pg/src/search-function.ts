import type { PgConnection } from "@crossengin/kernel-pg";

/**
 * The IMMUTABLE accent-folding function the substring predicate calls and the trigram index is
 * built from -- one spelling, so the two cannot name different things.
 *
 * ## What was wrong
 *
 * `list-sql.ts` emitted `unaccent(<col>::text) ILIKE …` at two sites and `entity-ddl.ts` emitted
 * `USING gin (<col> gin_trgm_ops)` -- a **bare**-column index. Those two do not meet. Measured on
 * PG 16.13 over a 1,000,000-row table carrying the emitter's own shape, after running the exact
 * predicate the code emits: `idx_scan = 0` on all five trigram indexes, and the plan is a
 * `Parallel Seq Scan` with `Rows Removed by Filter: 333000` per worker. The 5-field `?q=` OR group
 * took **771 ms** with two workers and **1865 ms** with `max_parallel_workers_per_gather = 0`.
 *
 * The index was not *useless*, which is why nobody noticed: a bare `family_name ILIKE '%Smith421%'`
 * **is** served by it (`Bitmap Index Scan on bench_family_name_trgm`, measured). It was dead for
 * the one predicate this codebase emits -- and no other site in the workspace emits a bare `ILIKE`
 * on an entity column (grepped: the only two `ILIKE` sites in `packages/` and `apps/` outside tests
 * are the two in `list-sql.ts`), so the index served nothing at all.
 *
 * `entity-ddl.ts`'s comment was **right** about why: `unaccent` is STABLE, not IMMUTABLE
 * (`pg_proc.provolatile = 's'` for both `unaccent(text)` and `unaccent(regdictionary,text)`), and
 * `CREATE INDEX … (unaccent(col))` raises `functions in index expression must be marked IMMUTABLE`
 * for gin *and* btree -- all three verified. What nobody did was draw the conclusion: if the
 * predicate cannot be indexed, the index cannot serve the predicate.
 *
 * What this fixes is that the two expressions now meet, which is necessary and **not sufficient**:
 * whether a plan reaches the index also depends on whether row-level security confines the session,
 * for a reason that has nothing to do with this wrapper. See {@link SEARCH_INDEX_REACHES}.
 *
 * ## Why the two-argument form, schema-qualified
 *
 * `unaccent(text)` is STABLE for a real reason rather than an oversight: it resolves the dictionary
 * named `unaccent` out of the caller's `search_path` at **execution** time. Measured -- with a
 * second dictionary `ext2.unaccent` in place, an unqualified `'unaccent'::regdictionary` resolves to
 * `ext2.unaccent` under `search_path = ext2, public` and to `public.unaccent` under
 * `search_path = public, ext2`. A `LANGUAGE sql` function's string body is parsed at *inlining*, in
 * the caller's session (the error text in hazard 2 below says `during inlining`), so an unqualified
 * reference inside the wrapper would carry that dependence straight through and the `IMMUTABLE`
 * label would be **false** rather than merely unproven. Pinning `'public.unaccent'::regdictionary`
 * is what makes the declaration true.
 *
 * `public` and not the served schema: there must be exactly **one** such function deployment-wide,
 * because `list-sql.ts` builds the predicate with no knowledge of which schema the row came from
 * (it serves the document store's `meta.operate_entity_records` and every per-tenant column schema
 * through one builder), and an index is only usable by a predicate naming the *same* function OID.
 * `public` is where `CREATE EXTENSION unaccent` puts the dictionary by default and where
 * `COLUMN_STORE_DEFAULT_SCHEMA` already points.
 *
 * ## The declaration is not a fact, and two hazards follow
 *
 * Both reproduced on a live cluster, and both are the reason `probeSearchFunction` exists.
 *
 * 1. **`CREATE OR REPLACE FUNCTION` on a function an index depends on is permitted, silently, with
 *    no reindex.** The index keeps the function's OID and its entries keep the *old* body's output.
 *    The lossy-index recheck means it cannot produce a false **positive** -- a Bitmap Heap Scan
 *    rechecks every candidate with the live function -- so what it produces is a false
 *    **negative**: measured, after replacing the body with one that also translates `S` to `Z`, the
 *    same predicate answered **0 rows via the index and 1022 via a forced sequential scan**. A
 *    wrong answer, in the under-reporting direction, which for a typeahead is the empty dropdown
 *    `search-extension.ts` already names as the worst shape this surface has.
 *
 *    That is why `ensureSearchFunction` issues `CREATE FUNCTION` and never `CREATE OR REPLACE`:
 *    **a definition an index was built from is data, not configuration.** Replacing it is the act
 *    that invalidates every index silently, so the binary must not perform it on an operator's
 *    behalf -- it reports the divergence with both statements in the order they must run.
 *
 * 2. **`DROP EXTENSION unaccent CASCADE` does not drop the index**, because the index depends on
 *    `ce_unaccent` and `ce_unaccent` is not an extension member -- measured, 4 dependency rows on
 *    the index, the index and the function both still present afterwards. The table then becomes
 *    **unwritable**: an `INSERT` raises `text search dictionary "public.unaccent" does not exist`.
 *    Loud rather than silent, so it is not prevented; the standing form of it -- a deployment whose
 *    `unaccent` lives in some other schema -- is what the `dictionary_absent` state reports, since
 *    `CREATE FUNCTION` succeeds for that deployment and the first *call* is what fails.
 */

/** The schema holding both the wrapper and the dictionary it pins. See the note above on `public`. */
export const SEARCH_FUNCTION_SCHEMA = "public";

/** The wrapper's bare name. */
export const SEARCH_FUNCTION_NAME = "ce_unaccent";

/** The qualified name every caller spells -- the predicate, the index and the probe. */
export const SEARCH_FUNCTION = `${SEARCH_FUNCTION_SCHEMA}.${SEARCH_FUNCTION_NAME}`;

/** The dictionary the body pins, qualified for the reason in the note above. */
export const SEARCH_DICTIONARY = `${SEARCH_FUNCTION_SCHEMA}.unaccent`;

/**
 * The signature `to_regprocedure` is asked for.
 *
 * Exact rather than by name: `CREATE OR REPLACE` cannot change a function's return type
 * (measured: `ERROR: cannot change return type of existing function`), so pinning the argument
 * type pins the whole shape and an added overload on another argument type cannot shadow it --
 * `ce_unaccent(col::text)` resolves to this one.
 */
export const SEARCH_FUNCTION_SIGNATURE = `${SEARCH_FUNCTION}(text)`;

/**
 * What `pg_proc.prosrc` holds, up to surrounding whitespace, for a function this binary wrote.
 *
 * Written with no surrounding whitespace inside the `$$` so the stored text is byte-identical to
 * this constant for a function the binary created -- `prosrc` preserves the body verbatim, so
 * `AS $$ SELECT … $$` stores the spaces. Verified by reading `prosrc` back both ways.
 *
 * The comparison nonetheless **trims**, and the live run that found this is the argument: a
 * hand-created function with the identical statement written `AS $$ SELECT … $$` tripped the fence
 * on nothing but two spaces, and told its operator that substring search may silently miss rows
 * when it will not. Whitespace *around* a complete SQL statement cannot change what the statement
 * does, so trimming admits no false negative; normalising whitespace *inside* it would be the first
 * step of the SQL parser ADR-0292 refused to write, and is where a real difference could hide.
 */
export const SEARCH_FUNCTION_BODY =
  `SELECT ${SEARCH_FUNCTION_SCHEMA}.unaccent('${SEARCH_DICTIONARY}'::regdictionary, $1)`;

/** `pg_proc.provolatile` for IMMUTABLE -- the one declared property that decides whether an index can exist. */
export const SEARCH_FUNCTION_VOLATILITY = "i";

function definitionSql(orReplace: boolean): string {
  const verb = orReplace ? "CREATE OR REPLACE FUNCTION" : "CREATE FUNCTION";
  return (
    `${verb} ${SEARCH_FUNCTION}(text) RETURNS text` +
    ` LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$${SEARCH_FUNCTION_BODY}$$;`
  );
}

/**
 * What `ensureSearchFunction` runs when the function is absent.
 *
 * `PARALLEL SAFE` and `STRICT` are declared and deliberately **not** fenced, because neither can
 * change which rows come back. `STRICT` is redundant for the answer -- `unaccent` is itself STRICT,
 * so measured, both forms return NULL for a NULL input -- and `PARALLEL SAFE` decides only whether
 * the fallback sequential scan may use workers, which is the 771 ms against 1865 ms figure above.
 * Fencing a property that cannot change an answer would make the probe report a finding an operator
 * has no reason to act on.
 */
export const CREATE_SEARCH_FUNCTION_SQL = definitionSql(false);

/**
 * The repair an operator runs, and which this binary never runs itself -- hazard 1 above.
 *
 * Built from the same constants as the create, so the statement that writes the function and the
 * statement printed to fix a divergent one cannot drift (ADR-0332's two-spellings defect).
 */
export const REPLACE_SEARCH_FUNCTION_SQL = definitionSql(true);

/**
 * The one spelling of a call, shared by the predicate (`list-sql.ts`, both sites) and the index
 * expression (`entity-ddl.ts`).
 *
 * Shared because an index is usable only by a predicate naming the same function, and two
 * independently written call sites is exactly how the bare-column index and the `unaccent(...)`
 * predicate came to be two things that do not meet.
 */
export function searchFunctionCall(argSql: string): string {
  return `${SEARCH_FUNCTION}(${argSql})`;
}

/**
 * The same fold **without** the wrapper, for a store that has no trigram index to match.
 *
 * Beside `searchFunctionCall` because the two must fold *identically* -- a store folding rawly and
 * a store folding through the wrapper have to agree about which rows match, and two spellings of
 * the dictionary reference is how they would come not to. Both pin `SEARCH_DICTIONARY`, so neither
 * resolves a dictionary from the caller's `search_path`.
 *
 * It is deliberately **not indexable**, which is the whole reason it is a second function and not
 * a configuration of the first: `CREATE INDEX … (unaccent(col))` raises `functions in index
 * expression must be marked IMMUTABLE` -- measured for gin and for btree, and for the
 * one-argument *and* two-argument forms, since `provolatile = 's'` for both.
 */
export function rawFoldCall(argSql: string): string {
  return `${SEARCH_FUNCTION_SCHEMA}.unaccent('${SEARCH_DICTIONARY}'::regdictionary, ${argSql})`;
}

/** What the live catalog says about the function this binary's predicate names. */
export const SEARCH_FUNCTION_STATES = [
  "absent",
  "created",
  "matches",
  "body_differs",
  "volatility_differs",
  "dictionary_absent",
  "unreadable",
] as const;
export type SearchFunctionState = (typeof SEARCH_FUNCTION_STATES)[number];

/**
 * Whether a deployment in this state is serving substring answers it can rely on.
 *
 * `null` is `unreadable`'s honest arm and is not a third shade of "yes": the catalog read failed,
 * so nothing was established and nothing is claimed (ADR-0331's claim-versus-nobody-looked). A
 * total map rather than a predicate, so a state added later has to say which side of the one
 * question that matters it falls on.
 *
 * Each arm is a measurement, not a judgement:
 * - `absent` -- the predicate names a function that is not there, so every `?q=` and `[contains]`
 *   is a 500 and a reference picker shows an empty dropdown. The same failure shape ADR-0166's
 *   missing extension had.
 * - `body_differs` -- measured at 0 rows via the index against 1022 via a sequential scan.
 * - `volatility_differs` -- measured harmless to *existing* answers: `CREATE OR REPLACE` to STABLE
 *   under a dependent index raises nothing, the index survives and the same query still returns
 *   1000 rows. What it blocks is creating a *new* index, which fails loudly at `ensureSchema`.
 * - `dictionary_absent` -- the body names a dictionary that is not there, so the first call raises.
 */
export const SEARCH_FUNCTION_ANSWERS_TRUSTED: Readonly<Record<SearchFunctionState, boolean | null>> =
  Object.freeze({
    absent: false,
    created: true,
    matches: true,
    body_differs: false,
    volatility_differs: true,
    dictionary_absent: false,
    unreadable: null,
  });

/**
 * Whether a **new** trigram index can be created from the function in this state.
 *
 * This is the column store's **DDL** dependency, and it is a different question from whether
 * existing answers are trustworthy -- which is why there are two maps and not one. `body_differs` is
 * where they disagree, and that disagreement is the finding rather than an inconsistency: an index
 * *can* be created from a replaced body, and it is built from the wrong output, which is
 * {@link SEARCH_FUNCTION_ANSWERS_TRUSTED}'s `false` arm. One map would have to pick one of those two
 * facts and drop the other.
 *
 * Each arm is a measurement:
 * - `absent` -- `CREATE INDEX … USING gin (public.ce_unaccent("fam"::text) gin_trgm_ops)` raises
 *   `function public.ce_unaccent(text) does not exist`. `ColumnMappedEntityStore.ensureSchema` runs
 *   those statements in a plain **uncaught** loop, and `applyTenantManifestSchema` runs them inside
 *   one transaction -- so the first one takes the boot down on the one path and aborts the tenant's
 *   whole application on the other.
 * - `volatility_differs` -- `functions in index expression must be marked IMMUTABLE`, verified for
 *   gin and for btree.
 * - `dictionary_absent` -- `false`, and conservatively rather than measured both ways: building the
 *   index *calls* the function once per row, so it raises on a populated table and succeeds on an
 *   empty one. `false` is the arm that does not promise a build will work, and the deployment is
 *   broken either way, since every `INSERT` calls the function too.
 * - `body_differs` -- creatable, which is the hazard and not the comfort.
 * - `unreadable` -- nothing was established, so nothing is claimed (ADR-0331).
 */
export const SEARCH_FUNCTION_ADMITS_INDEX: Readonly<Record<SearchFunctionState, boolean | null>> =
  Object.freeze({
    absent: false,
    created: true,
    matches: true,
    body_differs: true,
    volatility_differs: false,
    dictionary_absent: false,
    unreadable: null,
  });

export interface SearchFunctionProbe {
  readonly state: SearchFunctionState;
  /** The live `prosrc` on `body_differs`, the live `provolatile` on `volatility_differs`, the driver's message on `unreadable`, and null otherwise. */
  readonly detail: string | null;
}

interface FunctionRow {
  readonly prosrc: string;
  readonly provolatile: string;
  readonly dictionary_present: boolean;
}

/**
 * The fragment of the probe's statement a fake `PgConnection` recognises it by, and the row it
 * answers with to model *present and correct*.
 *
 * Both live in the module that owns the query, so a fake cannot drift from it. Three test files
 * reach `ensureColumnStoreExtensions` and each hand-rolls its own fake, so three hand-written rows
 * would be three chances to model a state the probe reads differently — ADR-0332's
 * `FEATURE_FLAG_COLUMN_NAMES`, where a store's column list and the catalog's disagreed and every
 * offline test passed.
 *
 * The matcher is load-bearing and not a convenience: a fake's fallback is `{rows: []}`, which is
 * exactly how a real database reports *this function does not exist* (`to_regprocedure` answers NULL
 * rather than raising), so a fake that stops matching does not fail loudly — it answers `absent` and
 * the refusal fires in every test on the path. `to_regprocedure` is named by no other statement
 * either store issues, which a test asserts against the real workspace scan.
 */
export const SEARCH_FUNCTION_PROBE_MATCH = "to_regprocedure";

/** @see SEARCH_FUNCTION_PROBE_MATCH */
export const SEARCH_FUNCTION_PRESENT_ROW: Readonly<FunctionRow> = Object.freeze({
  prosrc: SEARCH_FUNCTION_BODY,
  provolatile: SEARCH_FUNCTION_VOLATILITY,
  dictionary_present: true,
});

/**
 * Reads the live function and compares it to what this binary's predicate and index assume.
 *
 * Asked of the catalog rather than inferred from a `CREATE`'s own result, because a create answers
 * the same for a function it wrote and one it found (ADR-0330's rule), and the two facts that
 * decide an answer -- the body and the volatility -- are only in the catalog.
 *
 * Ordered so that the *reason* an operator is given is the one with a remedy. The dictionary is
 * checked first among the present-function arms: a correct body naming a dictionary that is not
 * there is a configuration problem whose remedy is `CREATE EXTENSION`, and reporting
 * `matches` for it would be true of the text and false of every call. The body is checked before
 * the volatility because a wrong body is a wrong answer while a wrong volatility is a blocked
 * index, and a deployment holding both should be told about the answer.
 *
 * Works as a non-owner: verified live as the non-superuser `serving` role, which reads `prosrc`,
 * `provolatile` and `pg_ts_dict` and holds `EXECUTE` on the function by the default `PUBLIC` grant.
 */
export async function probeSearchFunction(conn: PgConnection): Promise<SearchFunctionProbe> {
  try {
    const res = await conn.query<FunctionRow>(
      `SELECT p.prosrc,
              p.provolatile,
              EXISTS (
                SELECT 1 FROM pg_ts_dict d
                  JOIN pg_namespace dn ON dn.oid = d.dictnamespace
                 WHERE dn.nspname = $2 AND d.dictname = $3
              ) AS dictionary_present
         FROM pg_proc p
        WHERE p.oid = to_regprocedure($1)`,
      [SEARCH_FUNCTION_SIGNATURE, SEARCH_FUNCTION_SCHEMA, "unaccent"],
    );
    // `to_regprocedure` answers NULL rather than raising for a function, or a schema, that does not
    // exist -- both verified -- so zero rows is the absence and not a failed read.
    const row = res.rows[0];
    if (row === undefined) return { state: "absent", detail: null };
    if (!row.dictionary_present) return { state: "dictionary_absent", detail: SEARCH_DICTIONARY };
    // Trimmed, for the reason on `SEARCH_FUNCTION_BODY`: a hand-created function carrying the
    // identical statement inside `$$ … $$` tripped this on two spaces during the live run, and a
    // false "search may silently miss rows" costs more than it buys.
    if (row.prosrc.trim() !== SEARCH_FUNCTION_BODY) return { state: "body_differs", detail: row.prosrc };
    if (row.provolatile !== SEARCH_FUNCTION_VOLATILITY) {
      return { state: "volatility_differs", detail: row.provolatile };
    }
    return { state: "matches", detail: null };
  } catch (err) {
    return { state: "unreadable", detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Creates the function when it is absent, and otherwise reports what is there.
 *
 * `CREATE FUNCTION` and never `CREATE OR REPLACE`, which is the whole of hazard 1: replacing a body
 * an index was built from leaves the index holding the old body's output with no error and no
 * reindex, so the binary would be the thing that corrupted it. A `body_differs` deployment is
 * **reported** instead -- and the probe cannot tell the harmful case from the harmless one, which is
 * the measured reason it reports rather than refusing: a body replaced *before* any index existed is
 * internally consistent and answers correctly, a body replaced *after* is silently wrong, and
 * nothing in `pg_proc` or `pg_index` records when either happened (neither catalog carries a
 * modification timestamp). Refusing would refuse a deployment that works, which is ADR-0352's own
 * reason for a survey that reports.
 *
 * A failure is caught rather than thrown, and the reason is narrower than it was: **this function
 * serves the query builder's dependency, and the document store does not have one.** Since
 * `entity-ops.ts` declared `foldText: (sql) => rawFoldCall(sql)`, a `--store pg` deployment names
 * `ce_unaccent` nowhere -- so throwing here would refuse the shipped compose default over the
 * absence of an object it does not use, which is ADR-0352's *refusing a deployment that works*
 * exactly.
 *
 * It is **not** the place for the column store's refusal either, and that is a decision rather than
 * an omission. For `--store pg-columns` the function is additionally a **DDL** prerequisite -- the
 * index expression `entity-ddl.ts` emits names it -- and a state that blocks the index makes that
 * store unprovisionable rather than merely unsearchable (see {@link SEARCH_FUNCTION_ADMITS_INDEX}).
 * A refusal for that belongs with the other prerequisites of that store's DDL, i.e. beside
 * `pg_trgm` in `ensureColumnStoreExtensions`, because that is the one place **both** column-store
 * call sites pass through: `ensureSearchExtension` is called by the boot path only, and
 * `applyTenantManifestSchema` never calls it, so a refusal placed here could not reach the
 * per-tenant applier at all. That is the half of this fix recorded in ADR-0383's *Open questions*.
 */
export async function ensureSearchFunction(conn: PgConnection): Promise<SearchFunctionProbe> {
  const probe = await probeSearchFunction(conn);
  if (probe.state !== "absent") return probe;
  try {
    await conn.query(CREATE_SEARCH_FUNCTION_SQL);
  } catch (err) {
    return { state: "absent", detail: err instanceof Error ? err.message : String(err) };
  }
  // Re-asked rather than reported from the write's own success, because `CREATE FUNCTION` succeeds
  // for a body naming a dictionary that does not exist -- a `LANGUAGE sql` string body is parsed at
  // inlining, so the first *call* is what raises. Without this, a deployment whose `unaccent` could
  // not be installed would be told `created` and every search would 500. Mapped back to `created`
  // when it agrees, because that is the one thing the write knows and the probe cannot: whether
  // this boot wrote it, which is what tells an operator their own init SQL is or is not doing the
  // job (`ensureSearchExtension`'s present/created split, one object over).
  const after = await probeSearchFunction(conn);
  return after.state === "matches" ? { state: "created", detail: null } : after;
}

/**
 * How far an `ILIKE` predicate can reach a trigram index on this session.
 *
 * This is **not** about the wrapper, and it is the measured reason the boot line does not say
 * "substring search is index-accelerated": `ILIKE`'s own operator function `texticlike` is
 * `proleakproof = false` on PG 16.13, so a session that row-level security *confines* cannot
 * evaluate the predicate before the policy and the whole thing becomes a post-policy filter on a
 * sequential scan. Measured both ways on a 200,000-row table -- as the owner, `Bitmap Index Scan on
 * employee_family_name_utrgm`; as the non-owner `serving` role with tenant context, `Seq Scan …
 * Rows Removed by Filter: 199000`.
 *
 * Three facts make it worth reporting rather than fixing. It is **pre-existing**: a *bare*
 * `family_name ILIKE '%…%'` against the superseded plain-column index is a `Seq Scan` for the same
 * non-owner too, so the old indexes were dead for two independent reasons and this increment
 * removes one of them. It is **not fixable here**: `ALTER FUNCTION ce_unaccent(text) LEAKPROOF`
 * leaves the plan a `Seq Scan`, measured, because `texticlike` is the non-leakproof half and
 * marking a core text operator leakproof is not a thing a platform does to its operators' databases.
 * And it is **not a defect on the deployment this serves**: ADR-0349 records that a
 * `--store pg-columns` serving role must own its entity tables, since `ensureSchema` issues
 * owner-only `ALTER` and policy statements on every boot -- so for that role RLS is not the
 * confinement and the index is reached.
 */
export const SEARCH_INDEX_REACHES = ["every_table", "owned_tables_only", "unknown"] as const;
export type SearchIndexReach = (typeof SEARCH_INDEX_REACHES)[number];

/**
 * Asks the two role facts that are table-independent.
 *
 * Deliberately **not** `row_security_active`, which `kernel-pg` exposes and which is the right
 * question one argument later: it needs a table, and this runs before `ensureSchema` has created
 * any. So the answer is bounded on purpose -- `every_table` is conclusive (an exempt role is never
 * confined), and `owned_tables_only` says the rest depends on ownership rather than claiming the
 * index is unreachable.
 */
export async function probeSearchIndexReach(conn: PgConnection): Promise<SearchIndexReach> {
  try {
    const res = await conn.query<{ readonly exempt: boolean }>(
      "SELECT (rolsuper OR rolbypassrls) AS exempt FROM pg_roles WHERE rolname = current_user",
    );
    const row = res.rows[0];
    if (row === undefined) return "unknown";
    return row.exempt ? "every_table" : "owned_tables_only";
  } catch {
    return "unknown";
  }
}

/** The clause appended to a healthy boot line, so it states a reach rather than claiming a plan. */
function reachClause(reach: SearchIndexReach): string {
  switch (reach) {
    case "every_table":
      return "the predicate and the trigram index are one expression, and this role is RLS-exempt";
    case "owned_tables_only":
      return (
        "the predicate and the trigram index are one expression, reached on tables this role owns" +
        " — RLS confines ILIKE to a sequential scan because texticlike is not LEAKPROOF"
      );
    case "unknown":
      return "the predicate and the trigram index are one expression";
  }
}

/**
 * Which of the function's two dependents a state breaks, and on which store, read from the two
 * total maps rather than restated in each arm.
 *
 * **This is a correction, and it is the increment's own class landing on itself.** The first version
 * of the `absent` arm said *"every ?q= and every [contains] filter will answer 500"* with no store
 * named, and that sentence is false in **both** directions:
 *
 * - On `--store pg` nothing is wrong. `entity-ops.ts` declares `foldText: (sql) => rawFoldCall(sql)`
 *   on the document store's adapter, so its predicate names `public.unaccent(…)` and names
 *   `ce_unaccent` **nowhere**. Asserted in `list-sql.test.ts` by driving the real `listPageOp` with a
 *   recording connection -- not a synthetic adapter, which is what every earlier `foldText` test used
 *   -- and in both directions, so the claim cannot go stale silently. Every `?q=` and every
 *   `[contains]` on the shipped compose default works in all seven states.
 * - On `--store pg-columns` it understates by a category. `entity-ddl.ts`'s index expression names
 *   the same function the predicate does, so a state that blocks the index does not make search slow
 *   or absent -- it makes the store **unprovisionable**: `ensureSchema`'s trigram loop is uncaught,
 *   and `applyTenantManifestSchema` runs the same statements inside one transaction and so aborts the
 *   tenant's entire application, leaving them served from the JSONB fallback rather than their own
 *   schema (ADR-0314's *their data is in a different place than they think*). "Every search answers
 *   500" and "this store cannot be provisioned" are different findings with different remedies, and
 *   the second is the one an operator meets first.
 *
 * That is the same shape as hazard (c) -- a boot line asserting a consequence the pass did not
 * establish (ADR-0337) -- one field further in, and it is why the attribution is rendered from the
 * maps rather than written per arm. Rendering it is also what gives both maps their first non-test
 * reader: ADR-0344's ground for a total map is that a new enum member must be a compile error, and a
 * map nothing reads is a constant nobody reads.
 */
function dependentsClause(state: SearchFunctionState): string | null {
  const answers = SEARCH_FUNCTION_ANSWERS_TRUSTED[state];
  const admitsIndex = SEARCH_FUNCTION_ADMITS_INDEX[state];
  // `unreadable` already says nothing is claimed, and attributing a consequence to a store from a
  // read that failed would be the falsely-true control this file exists to avoid (ADR-0331).
  if (answers === null || admitsIndex === null) return null;
  // Healthy in both dependents: there is nothing to attribute, and `reachClause` already speaks.
  if (answers && admitsIndex) return null;
  const ddl = admitsIndex
    ? "A new trigram index is still creatable from it, so schema application is unaffected."
    : // `either` only where the predicate is broken too: on `volatility_differs` the sentence before
      // this one says existing answers are unaffected, so "either" would contradict it.
      `No trigram index can be created from it${answers ? "" : " either"}, so` +
      " ColumnMappedEntityStore.ensureSchema cannot apply the schema at all (its trigram loop is not" +
      " caught) and applyTenantManifestSchema aborts its transaction, leaving that tenant served" +
      " from the JSONB document store rather than its own schema.";
  return (
    `${ddl} Everything above is about --store pg-columns: --store pg is unaffected in every state,` +
    " because the document store declares its own accent fold and names this function nowhere."
  );
}

/**
 * The boot sentence, said in all seven states.
 *
 * Said on success too, for the reason every survey in this binary is: "we checked and the predicate
 * can reach its index" cannot be inferred from the absence of a line, and this is the surface whose
 * failure mode was an empty dropdown that reads as empty data.
 *
 * It deliberately does **not** say "substring search is index-accelerated", which is what an
 * earlier draft of this function said and what the live run refuted: that is a claim about a *plan*,
 * and the plan also depends on whether RLS confines the session -- so the sentence states what this
 * pass established, which is that the two expressions now meet. Claiming the plan would be
 * ADR-0337's falsely-true control, in the boot line of the increment that exists to close one.
 *
 * Two parts, and the split is which half can be written per state: {@link stateSentence} says what is
 * true of the **function** and what to run, and {@link dependentsClause} says what that reaches, per
 * store, derived from the two total maps. See that function for why the attribution is not written
 * into each arm.
 */
export function searchFunctionLine(
  probe: SearchFunctionProbe,
  reach: SearchIndexReach = "unknown",
): string {
  const sentence = stateSentence(probe, reach);
  const dependents = dependentsClause(probe.state);
  return dependents === null ? sentence : `${sentence} ${dependents}`;
}

function stateSentence(probe: SearchFunctionProbe, reach: SearchIndexReach): string {
  switch (probe.state) {
    case "created":
      return `[search] ${SEARCH_FUNCTION}: created — ${reachClause(reach)}`;
    case "matches":
      return `[search] ${SEARCH_FUNCTION}: present — ${reachClause(reach)}`;
    case "absent":
      return (
        `[search] ${SEARCH_FUNCTION}: ABSENT — every ?q= and every [contains] filter will answer` +
        " 500, and a reference picker's typeahead will show an EMPTY dropdown rather than an error," +
        " which reads as no matching records." +
        // The remedy splits on whether a create was attempted, and that is ADR-0334's rule rather
        // than a nicety: `CREATE FUNCTION` is precisely the statement that was just refused, so
        // printing it alone to the role that was refused is a remedy that cannot work.
        //
        // The privilege is named as the *usual* cause and never asserted as this one. A create can
        // throw for reasons that are not privilege, and `probe.detail` is the only evidence here --
        // so saying "this role does not hold CREATE" would be a claim the pass did not establish,
        // which is ADR-0337's falsely-true control in the line correcting one. What *is* established
        // and worth saying is the negative: the two `CREATE EXTENSION`s beside this statement prove
        // nothing about the privilege, because `IF NOT EXISTS` short-circuits on an already-installed
        // extension before any privilege check. Measured by ADR-0383's review as the non-superuser
        // `serving` role, which holds neither CREATE on the database nor CREATE on `public` and for
        // which both of those statements still succeed. So the floor this increment raises is said
        // out loud rather than left to be inferred from two statements that do not imply it.
        (probe.detail === null
          ? ` Run: ${CREATE_SEARCH_FUNCTION_SQL}`
          : ` Run it once as a role holding CREATE on schema ${SEARCH_FUNCTION_SCHEMA}:` +
            ` creating it was refused: ${probe.detail}. ${CREATE_SEARCH_FUNCTION_SQL} Granting that` +
            ` privilege on schema ${SEARCH_FUNCTION_SCHEMA} to this role and rebooting works too.` +
            " That privilege is the usual cause and is NOT established by the CREATE EXTENSION" +
            " statements beside it: IF NOT EXISTS short-circuits on an already-installed extension" +
            " before any privilege check.")
      );
    case "dictionary_absent":
      return (
        `[search] ${SEARCH_FUNCTION}: the text search dictionary ${SEARCH_DICTIONARY} it names does` +
        " NOT exist, so every ?q= and every [contains] filter will answer 500. Install it as a" +
        ` superuser once: CREATE EXTENSION IF NOT EXISTS unaccent SCHEMA ${SEARCH_FUNCTION_SCHEMA};`
      );
    case "body_differs":
      return (
        `[search] ${SEARCH_FUNCTION}: its body is NOT the one this binary's trigram indexes were` +
        " built from, so substring search may silently MISS rows that match (measured: 0 rows via" +
        " the index where a sequential scan answers 1022). This binary will not replace a function" +
        " an index depends on, because replacing it invalidates every index with no error and no" +
        ` reindex. To repair, run both, in this order: ${REPLACE_SEARCH_FUNCTION_SQL}` +
        // It used to say "REINDEX every index named in the superseded-index line above", and that
        // was wrong three ways. The superseded line names the **bare-column `_trgm`** indexes, which
        // do not depend on this function at all, so reindexing them repairs nothing; the indexes that
        // need it are the expression indexes built from it, which no boot line enumerates; and that
        // line is pushed *after* this one by `searchExtensionLine` and is `null` on a converged
        // deployment, so on exactly the deployments needing this repair there is no "line above".
        // ADR-0334's class — a remedy that cannot work — inside the increment citing it. The exact
        // set is stated by its dependency rather than by a name, because the names come from
        // `entity-ddl.ts` and importing them here would be a cycle (that module imports
        // `searchFunctionCall` from this one).
        " then REINDEX every trigram index that was built from it. The exact set is every index" +
        ` that depends on ${SEARCH_FUNCTION_SIGNATURE} — which is what DROP FUNCTION on it refuses` +
        " over — and REINDEX DATABASE; is the one form that needs no list." +
        ` Live body: ${probe.detail ?? "unknown"}`
      );
    case "volatility_differs":
      // The schema-application consequence is `dependentsClause`'s, derived from
      // `SEARCH_FUNCTION_ADMITS_INDEX`, so it is not restated here — two spellings of one
      // consequence is how the predicate and the index came to disagree in the first place.
      return (
        `[search] ${SEARCH_FUNCTION}: it is not IMMUTABLE (pg_proc.provolatile =` +
        ` '${probe.detail ?? "?"}', expected '${SEARCH_FUNCTION_VOLATILITY}'). Existing indexes` +
        ` and answers are unaffected — measured. Run: ${REPLACE_SEARCH_FUNCTION_SQL}`
      );
    case "unreadable":
      return (
        `[search] ${SEARCH_FUNCTION}: could not be read or created, so nothing is claimed about` +
        ` substring search — it may answer 500. (${probe.detail ?? "no detail"})`
      );
  }
}
