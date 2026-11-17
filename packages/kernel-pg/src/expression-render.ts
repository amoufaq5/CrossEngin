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
   * reporting rather than a reason to guess. An **absent** key means the probe could not answer
   * (see `uncompared`), and a comparison reads absence as *not compared*, never as drift.
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
  /**
   * Expressions the probe could not answer, with the error that stopped it (H-23). Before this every
   * probe error was read as *the expression cannot be applied*, so a privilege the session lacked or
   * a lock it could not take reported a correct index or policy as drifted and planned its rebuild.
   */
  readonly uncompared?: readonly UncomparedExpression[];
}

/** An expression left out of the comparison, and why. */
export interface UncomparedExpression {
  readonly table: string;
  readonly expression: string;
  readonly sqlstate: string | null;
  readonly reason: string;
}

export const NO_RENDERED_EXPRESSIONS: RenderedExpressions = {
  byRequest: new Map(),
  columnsByRequest: new Map(),
  uncompared: [],
};

/**
 * How long a probe waits for the lock its `CREATE TEMP TABLE … (LIKE …)` takes on the real table.
 * That lock is `ACCESS SHARE`, which conflicts only with `ACCESS EXCLUSIVE`, so this bounds the wait
 * behind somebody else's migration rather than protecting traffic, which the probe no longer blocks.
 */
export const DEFAULT_PROBE_LOCK_TIMEOUT_MS = 5_000;

export interface RenderExpressionsOptions {
  /** 0 waits indefinitely. */
  readonly lockTimeoutMs?: number;
}

/** One expression as Postgres renders and parses it. */
type ProbeResult =
  | { readonly kind: "rendered"; readonly rendering: string | null; readonly columns: readonly string[] | null }
  | { readonly kind: "uncompared"; readonly uncompared: UncomparedExpression };

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
 * So the declared side is deparsed by the same deparser: each expression is attached as a
 * `CHECK … NOT VALID` constraint, read back with `pg_get_constraintdef`, and rolled away.
 *
 * **Against a session-private copy of the table, not the table** (H-23). `ADD CONSTRAINT` takes
 * `ACCESS EXCLUSIVE`, and this ran once per declared expression on the real table — so `drift` or
 * `apply --plan`, both read-only in intent, queued an exclusive lock behind any open reader and every
 * later query on that table queued behind it: measured, a plain `SELECT` waited 6 s behind a plan.
 * `CREATE TEMP TABLE … (LIKE t)` copies the column names and types the deparser resolves against
 * and takes only `ACCESS SHARE` on `t`; the constraint goes on the copy. The rendering is
 * character-identical (verified over the whole catalog: a converged database still reads as no
 * drift). It also asks for less: `SELECT` on the table rather than ownership of it.
 *
 * It cannot be a `READ ONLY` transaction — Postgres refuses `CREATE TABLE` in one, temporary or not.
 * What it writes is the session's own temporary catalog entries, inside a transaction that is always
 * rolled back. Each table's copy lives in its own savepoint, released before the next, so the locks
 * do not accumulate across the catalog.
 */
export async function renderExpressions(
  conn: PgConnection,
  schema: string,
  requests: readonly ExpressionRequest[],
  options: RenderExpressionsOptions = {},
): Promise<RenderedExpressions> {
  if (requests.length === 0) return NO_RENDERED_EXPRESSIONS;
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_PROBE_LOCK_TIMEOUT_MS;
  if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs < 0) {
    throw new Error(`lockTimeoutMs must be a non-negative integer, got ${String(lockTimeoutMs)}`);
  }
  const byTable = new Map<string, Map<string, ExpressionRequest>>();
  for (const req of requests) {
    const forTable = byTable.get(req.table) ?? new Map<string, ExpressionRequest>();
    forTable.set(expressionKey(req.table, req.expr), req);
    byTable.set(req.table, forTable);
  }

  try {
    await conn.transaction(async (tx) => {
      await tx.query(`SET LOCAL lock_timeout = '${String(lockTimeoutMs)}ms'`);
      const rendered = new Map<string, ProbeResult>();
      let copy = 0;
      for (const [table, forTable] of byTable) {
        await probeTable(tx, schema, table, `_crossengin_probe_${String(copy++)}`, forTable, rendered);
      }
      // The probes are a read dressed up as DDL; nothing here may survive.
      throw new RollbackProbe(rendered);
    });
  } catch (err) {
    if (err instanceof RollbackProbe) {
      const byRequest = new Map<string, string | null>();
      const columnsByRequest = new Map<string, readonly string[] | null>();
      const uncompared: UncomparedExpression[] = [];
      for (const [key, result] of err.rendered) {
        if (result.kind === "rendered") {
          byRequest.set(key, result.rendering);
          columnsByRequest.set(key, result.columns);
        } else {
          uncompared.push(result.uncompared);
        }
      }
      return { byRequest, columnsByRequest, uncompared };
    }
    throw err;
  }
  // `transaction` resolved without the sentinel, which cannot happen.
  throw new Error("expression probe did not roll back");
}

const UNRENDERABLE: ProbeResult = { kind: "rendered", rendering: null, columns: null };

/**
 * Whether an error raised while attaching or reading the probe says the **expression** is wrong for
 * the table, rather than that the probe could not run.
 *
 * Class 42 is the parser's (an undefined column or function, a type mismatch) — except `42501`,
 * which is a privilege and says nothing about the expression. Class 22 is a literal that does not
 * coerce, and `0A000` a construct a CHECK may not hold. Everything else — a lock timeout, a
 * cancellation, a lost connection, an error with no SQLSTATE at all — is *not compared*, because
 * reading it as "cannot be applied" is what planned a rebuild of a correct object.
 */
export function errorMeansExpressionInapplicable(sqlstate: string | null): boolean {
  if (sqlstate === null) return false;
  if (sqlstate === "42501") return false;
  return sqlstate.startsWith("42") || sqlstate.startsWith("22") || sqlstate === "0A000";
}

function sqlstateOf(err: unknown): string | null {
  const code = (err as { readonly code?: unknown } | null)?.code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : null;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function probeTable(
  tx: PgConnection,
  schema: string,
  table: string,
  copyName: string,
  requests: ReadonlyMap<string, ExpressionRequest>,
  rendered: Map<string, ProbeResult>,
): Promise<void> {
  const source = `${quoteIdent(schema)}.${quoteIdent(table)}`;
  const copy = quoteIdent(copyName);
  await tx.query("SAVEPOINT crossengin_expr_table");
  try {
    try {
      await tx.query(`CREATE TEMP TABLE ${copy} (LIKE ${source})`);
    } catch (err) {
      // The copy could not be made — the session cannot read the table, or could not take the lock
      // in time. Nothing about any of its expressions is known.
      const sqlstate = sqlstateOf(err);
      const reason = `could not copy ${schema}.${table} to probe it: ${messageOf(err)}`;
      for (const [key, req] of requests) {
        rendered.set(key, {
          kind: "uncompared",
          uncompared: { table, expression: req.expr, sqlstate, reason },
        });
      }
      return;
    }
    for (const [key, req] of requests) {
      rendered.set(key, await probeOne(tx, copyName, req));
    }
  } finally {
    // Undoes the copy and releases the lock its `LIKE` took on the real table before the next one.
    await tx.query("ROLLBACK TO SAVEPOINT crossengin_expr_table");
    await tx.query("RELEASE SAVEPOINT crossengin_expr_table");
  }
}

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
  copyName: string,
  req: ExpressionRequest,
): Promise<ProbeResult> {
  const probe = quoteIdent(PROBE_CONSTRAINT);
  await tx.query("SAVEPOINT crossengin_expr_probe");
  try {
    await tx.query(
      `ALTER TABLE ${quoteIdent(copyName)} ADD CONSTRAINT ${probe} CHECK (${req.expr}) NOT VALID`,
    );
    const result = await tx.query<{ def: string; cols: readonly string[] | null }>(
      PROBE_QUERY,
      [PROBE_CONSTRAINT, `pg_temp.${copyName}`],
    );
    const row = result.rows[0];
    if (row === undefined) return UNRENDERABLE;
    return {
      kind: "rendered",
      rendering: stripCheckWrapper(row.def),
      columns: row.cols ?? null,
    };
  } catch (err) {
    const sqlstate = sqlstateOf(err);
    if (errorMeansExpressionInapplicable(sqlstate)) return UNRENDERABLE;
    return {
      kind: "uncompared",
      uncompared: { table: req.table, expression: req.expr, sqlstate, reason: messageOf(err) },
    };
  } finally {
    await tx.query("ROLLBACK TO SAVEPOINT crossengin_expr_probe");
    await tx.query("RELEASE SAVEPOINT crossengin_expr_probe");
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
