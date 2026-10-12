import type { PgConnection } from "./connection.js";

/** Name of the throwaway constraint each probe creates and rolls back. */
const PROBE_CONSTRAINT = "_crossengin_expr_probe";

const CHECK_PREFIX = "CHECK (";
const NOT_VALID_SUFFIX = ") NOT VALID";

export interface ExpressionRequest {
  readonly table: string;
  readonly expr: string;
}

export function expressionKey(table: string, expr: string): string {
  return `${table}\u0000${expr}`;
}

export interface RenderedExpressions {
  /**
   * Keyed by `expressionKey`. A null value means Postgres would not accept the expression against
   * that table at all — a missing column, a type error — which is itself a difference worth
   * reporting rather than a reason to guess.
   */
  readonly byRequest: ReadonlyMap<string, string | null>;
  /**
   * The columns each expression actually references, as Postgres parsed it — `conkey` of the probe
   * constraint, in attnum order.
   *
   * This is the one fact that makes a *column-level* CHECK matchable (ADR-0330). Postgres names such
   * a constraint `<table>_<column>_check` when the parsed expression resolves to exactly one column
   * and `<table>_check` when it resolves to none or several, because `AddRelationNewConstraints`
   * only passes a column name along in the first case. Deciding which applies means knowing the
   * expression's Var set, and this is that set, from the same parser that stored the live one.
   *
   * **Optional.** A caller that assembled a `RenderedExpressions` by hand has not probed, and an
   * absent entry means the name cannot be known — never that it is the one-column spelling. Null
   * means the probe itself could not read `conkey` back.
   */
  readonly columnsByRequest?: ReadonlyMap<string, readonly string[] | null>;
}

export const NO_RENDERED_EXPRESSIONS: RenderedExpressions = {
  byRequest: new Map(),
  columnsByRequest: new Map(),
};

/** One expression as Postgres renders and parses it. */
interface ProbeResult {
  readonly rendering: string | null;
  readonly columns: readonly string[] | null;
}

/** Thrown to force the probe transaction to roll back; never escapes `renderExpressions`. */
class RollbackProbe extends Error {
  constructor(readonly rendered: Map<string, ProbeResult>) {
    super("probe complete");
    this.name = "RollbackProbe";
  }
}

/**
 * Asks Postgres to render declared boolean expressions the way it stores them.
 *
 * Index predicates and policy clauses are the one part of a table definition that cannot be compared
 * as text. Postgres does not store what was written; it stores a parsed tree and prints it back
 * through its own deparser, which rewrites structure rather than just spelling — `status IN ('a','b')`
 * comes back as `(status = ANY (ARRAY['a'::text, 'b'::text]))`. Replicating that in TypeScript means
 * writing a SQL parser, and getting it subtly wrong means either missing real drift or inventing
 * false drift on a correct schema.
 *
 * So the declared side is deparsed by the same deparser. Each expression is attached to the table as
 * a `CHECK … NOT VALID` constraint inside a savepoint, read back with `pg_get_constraintdef`, and
 * rolled away. `NOT VALID` is what keeps it cheap: Postgres records the constraint without scanning
 * a single row, so the probe costs the same on an empty table and a large one. The rendering is
 * character-identical to what `pg_get_expr` reports for an index predicate or a policy clause —
 * verified against both.
 *
 * Nothing is committed: every probe is undone by its savepoint, and the surrounding transaction is
 * rolled back whether or not the probes succeeded.
 */
export async function renderExpressions(
  conn: PgConnection,
  schema: string,
  requests: readonly ExpressionRequest[],
): Promise<RenderedExpressions> {
  if (requests.length === 0) return NO_RENDERED_EXPRESSIONS;
  const unique = new Map<string, ExpressionRequest>();
  for (const req of requests) unique.set(expressionKey(req.table, req.expr), req);

  try {
    await conn.transaction(async (tx) => {
      const rendered = new Map<string, ProbeResult>();
      for (const [key, req] of unique) {
        rendered.set(key, await probeOne(tx, schema, req));
      }
      // The probes are a read dressed up as DDL; nothing here may survive.
      throw new RollbackProbe(rendered);
    });
  } catch (err) {
    if (err instanceof RollbackProbe) {
      const byRequest = new Map<string, string | null>();
      const columnsByRequest = new Map<string, readonly string[] | null>();
      for (const [key, result] of err.rendered) {
        byRequest.set(key, result.rendering);
        columnsByRequest.set(key, result.columns);
      }
      return { byRequest, columnsByRequest };
    }
    throw err;
  }
  // `transaction` resolved without the sentinel, which cannot happen.
  throw new Error("expression probe did not roll back");
}

const UNRENDERABLE: ProbeResult = { rendering: null, columns: null };

/**
 * `conkey` comes back alongside the rendering because the probe is the only place either can be
 * had and the row is already in hand — reading it costs no extra statement.
 *
 * `attname::text` for the ADR-0291 reason: node-postgres has no array parser for `name[]`, so an
 * unqualified `attname` arrives as the literal string `{d,a}` and every column reads as mismatched.
 * `unnest(NULL)` yields no rows, so an expression over no column at all arrives as an empty array
 * rather than failing the query — which is the `<table>_check` spelling, not an unknown.
 */
const PROBE_QUERY = `
  SELECT pg_get_constraintdef(oid) AS def,
         ARRAY(
           SELECT a.attname::text
             FROM unnest(conkey) WITH ORDINALITY AS k(attnum, ord)
             JOIN pg_attribute a ON a.attrelid = conrelid AND a.attnum = k.attnum
            ORDER BY k.ord
         ) AS cols
    FROM pg_constraint
   WHERE conname = $1 AND conrelid = $2::regclass
`;

async function probeOne(
  tx: PgConnection,
  schema: string,
  req: ExpressionRequest,
): Promise<ProbeResult> {
  const fq = `${quoteIdent(schema)}.${quoteIdent(req.table)}`;
  const probe = quoteIdent(PROBE_CONSTRAINT);
  await tx.query("SAVEPOINT crossengin_expr_probe");
  try {
    await tx.query(
      `ALTER TABLE ${fq} ADD CONSTRAINT ${probe} CHECK (${req.expr}) NOT VALID`,
    );
    const result = await tx.query<{ def: string; cols: readonly string[] | null }>(
      PROBE_QUERY,
      [PROBE_CONSTRAINT, `${schema}.${req.table}`],
    );
    const row = result.rows[0];
    if (row === undefined) return UNRENDERABLE;
    return {
      rendering: stripCheckWrapper(row.def),
      columns: row.cols ?? null,
    };
  } catch {
    // An expression the table cannot carry is reported as unrenderable, not as a thrown pass.
    return UNRENDERABLE;
  } finally {
    await tx.query("ROLLBACK TO SAVEPOINT crossengin_expr_probe");
  }
}

/**
 * `CHECK ((x = 1)) NOT VALID` → `(x = 1)`, which is exactly what `pg_get_expr` prints for the same
 * expression stored as an index predicate or a policy clause.
 */
export function stripCheckWrapper(constraintDef: string): string {
  let text = constraintDef.trim();
  if (text.endsWith(NOT_VALID_SUFFIX)) {
    text = text.slice(0, text.length - NOT_VALID_SUFFIX.length) + ")";
  }
  if (text.startsWith(CHECK_PREFIX) && text.endsWith(")")) {
    return text.slice(CHECK_PREFIX.length, text.length - 1).trim();
  }
  return text;
}

function quoteIdent(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`unsafe SQL identifier: ${JSON.stringify(name)}`);
  }
  return `"${name}"`;
}
