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
}

export const NO_RENDERED_EXPRESSIONS: RenderedExpressions = { byRequest: new Map() };

/** Thrown to force the probe transaction to roll back; never escapes `renderExpressions`. */
class RollbackProbe extends Error {
  constructor(readonly rendered: Map<string, string | null>) {
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
      const rendered = new Map<string, string | null>();
      for (const [key, req] of unique) {
        rendered.set(key, await probeOne(tx, schema, req));
      }
      // The probes are a read dressed up as DDL; nothing here may survive.
      throw new RollbackProbe(rendered);
    });
  } catch (err) {
    if (err instanceof RollbackProbe) return { byRequest: err.rendered };
    throw err;
  }
  // `transaction` resolved without the sentinel, which cannot happen.
  throw new Error("expression probe did not roll back");
}

async function probeOne(
  tx: PgConnection,
  schema: string,
  req: ExpressionRequest,
): Promise<string | null> {
  const fq = `${quoteIdent(schema)}.${quoteIdent(req.table)}`;
  const probe = quoteIdent(PROBE_CONSTRAINT);
  await tx.query("SAVEPOINT crossengin_expr_probe");
  try {
    await tx.query(
      `ALTER TABLE ${fq} ADD CONSTRAINT ${probe} CHECK (${req.expr}) NOT VALID`,
    );
    const result = await tx.query<{ def: string }>(
      "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1 AND conrelid = $2::regclass",
      [PROBE_CONSTRAINT, `${schema}.${req.table}`],
    );
    const def = result.rows[0]?.def;
    return def === undefined ? null : stripCheckWrapper(def);
  } catch {
    // An expression the table cannot carry is reported as unrenderable, not as a thrown pass.
    return null;
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
