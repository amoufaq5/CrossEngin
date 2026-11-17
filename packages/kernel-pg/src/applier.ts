import type { PgConnection } from "./connection.js";
import {
  ensureMigrationLog,
  isStatementApplied,
  recordStatement,
} from "./migration-log.js";
import {
  type PreconditionReport,
  checkPreconditions,
} from "./preconditions.js";
import { excerptStatement, hashStatement } from "./statement-hash.js";

export const ADVISORY_LOCK_KEY: bigint = 8_675_309n;

export const APPLY_STATEMENT_OUTCOMES = ["executed", "skipped", "failed"] as const;
export type ApplyStatementOutcome = (typeof APPLY_STATEMENT_OUTCOMES)[number];

/**
 * How long a transactional statement waits for its lock before it gives up (H-23).
 *
 * Without one, a DDL statement queued behind a long-running reader holds its place in the table's
 * lock queue, and every query arriving after it queues behind *it* — measured on PG 16: a plain
 * `SELECT` on `meta.audit_log` waited 6 s behind an apply whose `replace_index` was itself waiting on
 * one open read transaction. Giving up after a few seconds turns that outage into a failed statement
 * that changed nothing and is retried.
 */
export const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
/** Retries after a lock timeout, each after a doubling pause starting at one second. */
export const DEFAULT_LOCK_RETRIES = 2;
/**
 * How long a transactional statement may run once it holds its lock. The locks DDL takes are held
 * until the statement's transaction ends, so this bounds the outage a slow rebuild can cause. A
 * statement cancelled by it rolls back whole and is **not** retried, because it would run as long
 * again. `0` disables it.
 */
export const DEFAULT_STATEMENT_TIMEOUT_MS = 10 * 60_000;

/** What ended a failed statement, where it was one of the two bounds this applier sets. */
export const APPLY_STATEMENT_STOPS = ["lock_timeout", "statement_timeout"] as const;
export type ApplyStatementStop = (typeof APPLY_STATEMENT_STOPS)[number];

/**
 * A statement, optionally naming the table it touches so a failure can say which one was busy.
 * `applierStatementsFor` in `reconcile.ts` builds these from a plan.
 */
export type ApplierStatement = string | { readonly sql: string; readonly subject: string };

/**
 * Whether Postgres refuses this statement inside a transaction block — the `CONCURRENTLY` forms of
 * `CREATE INDEX`, `DROP INDEX` and `REINDEX`.
 *
 * Read off the text because that is where Postgres reads it: the refusal is a property of the parsed
 * statement, not of anything a caller could declare differently. A concurrent statement must also be
 * the **only** statement in its string — a multi-statement simple query runs as one implicit
 * transaction, which Postgres refuses for these too — so this answers false for one carrying a
 * second statement, and the applier then runs it transactionally and lets Postgres say so.
 */
export function statementRunsOutsideTransaction(sql: string): boolean {
  const trimmed = sql.trim().replace(/;$/, "");
  if (trimmed.includes(";")) return false;
  return /^(CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY|DROP\s+INDEX\s+CONCURRENTLY|REINDEX\s+(\([^)]*\)\s*)?(INDEX|TABLE|SCHEMA|DATABASE|SYSTEM)\s+CONCURRENTLY)\b/i.test(
    trimmed,
  );
}

function sqlstateOf(err: unknown): string | null {
  const code = (err as { readonly code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

/**
 * Which bound ended a failed statement, if either did. `55P03` is `lock_not_available`; `57014` is
 * any cancellation, and only the statement timeout's message names the timeout, so a cancellation
 * from elsewhere (an operator's `pg_cancel_backend`) is reported as what it is.
 */
export function applyStatementStop(err: unknown): ApplyStatementStop | null {
  const code = sqlstateOf(err);
  if (code === "55P03") return "lock_timeout";
  if (code === "57014" && /statement timeout/i.test(err instanceof Error ? err.message : "")) {
    return "statement_timeout";
  }
  return null;
}

export interface ApplyStatementRecord {
  /** Position in the statement list the applier was given. Preserved so the list reads in order. */
  readonly index: number;
  readonly statementHash: string;
  readonly excerpt: string;
  readonly durationMs: number;
  readonly outcome: ApplyStatementOutcome;
  readonly succeeded: boolean;
  readonly errorMessage: string | null;
  readonly skipped: boolean;
  /** The table the statement touches, when the caller named it. */
  readonly subject: string | null;
  /** False for a `CONCURRENTLY` statement, which ran outside any transaction and without timeouts. */
  readonly transactional: boolean;
  /** Executions attempted; more than one only after a lock timeout. 0 for a skipped statement. */
  readonly attempts: number;
  readonly stoppedBy: ApplyStatementStop | null;
}

export interface ApplyReport {
  readonly totalStatements: number;
  readonly executed: number;
  readonly skipped: number;
  readonly failed: number;
  /** Statements never reached, because `stopOnFailure` ended the run early. */
  readonly notAttempted: number;
  readonly durationMs: number;
  readonly preconditions: PreconditionReport;
  /**
   * One entry per statement reached, in statement order. A statement after the last entry was never
   * attempted.
   */
  readonly statements: readonly ApplyStatementRecord[];
  /**
   * Where the run stopped early, or null if every statement was reached. Only ever set under
   * `stopOnFailure` — continuing past a failure reaches the end, so this stays null and `failed`
   * is the field to check.
   */
  readonly haltedAt: number | null;
  /**
   * The index of the first failure, or null if there was none. The plan is ordered, so a later
   * failure is often fallout from this one: an index on a column whose `ADD COLUMN` failed fails
   * too. No dependency analysis is attempted — this just says which failure to read first.
   */
  readonly firstFailureAt: number | null;
}

export interface MigrationApplierOptions {
  readonly connection: PgConnection;
  readonly schema: string;
  readonly statements: readonly ApplierStatement[];
  readonly now?: () => number;
  /**
   * Whether a statement whose hash is already recorded as applied may be skipped. Default true.
   *
   * Pass **false** when the statement list was computed from the live schema. The log records what
   * was executed, not what the database currently holds, so a statement that ran once and whose
   * object was later dropped is still marked applied — and skipping it would leave the object
   * missing. A reconciliation plan already contains only statements the database needs, so the
   * skip has nothing to save and can only do harm.
   */
  readonly skipApplied?: boolean;
  /**
   * Whether to stop at the first failed statement. **Default false — the applier continues.**
   *
   * Stopping was the original behaviour, and it made sense when the statement list was a replay of
   * the bootstrap emission: a `CREATE TABLE` that failed meant the next 500 statements were about
   * to fail the same way, and halting kept the output readable. A reconciliation plan is the
   * opposite case (ADR-0290, ADR-0291): every step in it is *expected* to succeed, so a failure is
   * already exceptional, and the steps are largely independent — one refused `ALTER` says nothing
   * about the 30 additions after it. Stopping there turns one problem into an unknown number of
   * unapplied statements and forces a run per failure to discover them.
   *
   * Each statement runs in its own transaction, so continuing cannot leave a poisoned one open, and
   * a failed statement is never recorded as applied — the next run re-attempts it either way.
   *
   * Pass **true** for a list whose statements genuinely build on each other and where a wall of
   * consequent failures would be worse than one.
   */
  readonly stopOnFailure?: boolean;
  /** Per transactional statement; default `DEFAULT_LOCK_TIMEOUT_MS`. `0` waits indefinitely. */
  readonly lockTimeoutMs?: number;
  /** Per transactional statement; default `DEFAULT_STATEMENT_TIMEOUT_MS`. `0` disables it. */
  readonly statementTimeoutMs?: number;
  /** Retries after a lock timeout; default `DEFAULT_LOCK_RETRIES`. */
  readonly lockRetries?: number;
  /** Injected for tests; the pause between lock-timeout retries. */
  readonly sleep?: (ms: number) => Promise<void>;
}

function nonNegativeInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${String(value)}`);
  }
  return value;
}

export class MigrationApplier {
  private readonly connection: PgConnection;
  private readonly schema: string;
  private readonly statements: readonly { readonly sql: string; readonly subject: string | null }[];
  private readonly now: () => number;
  private readonly skipApplied: boolean;
  private readonly stopOnFailure: boolean;
  private readonly lockTimeoutMs: number;
  private readonly statementTimeoutMs: number;
  private readonly lockRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: MigrationApplierOptions) {
    this.connection = opts.connection;
    this.schema = opts.schema;
    this.statements = opts.statements.map((s) =>
      typeof s === "string" ? { sql: s, subject: null } : { sql: s.sql, subject: s.subject },
    );
    this.now = opts.now ?? (() => Date.now());
    this.skipApplied = opts.skipApplied ?? true;
    this.stopOnFailure = opts.stopOnFailure ?? false;
    this.lockTimeoutMs = nonNegativeInteger(
      "lockTimeoutMs",
      opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    );
    this.statementTimeoutMs = nonNegativeInteger(
      "statementTimeoutMs",
      opts.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS,
    );
    this.lockRetries = nonNegativeInteger("lockRetries", opts.lockRetries ?? DEFAULT_LOCK_RETRIES);
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * One execution of one statement. A transactional one sets both bounds with `SET LOCAL`, so they
   * end with its transaction and never reach the pooled connection's next user. A concurrent one
   * runs bare: it takes no lock that blocks reads or writes, and a timeout would only cancel a build
   * part-way and leave an invalid index for the next plan to rebuild.
   */
  private async execute(sql: string, transactional: boolean): Promise<void> {
    if (!transactional) {
      await this.connection.query(sql);
      return;
    }
    await this.connection.transaction(async (tx) => {
      await tx.query(`SET LOCAL lock_timeout = '${String(this.lockTimeoutMs)}ms'`);
      await tx.query(`SET LOCAL statement_timeout = '${String(this.statementTimeoutMs)}ms'`);
      await tx.query(sql);
    });
  }

  private stopMessage(
    stop: ApplyStatementStop,
    subject: string | null,
    attempts: number,
    postgres: string,
  ): string {
    const where = subject ?? "its table";
    if (stop === "lock_timeout") {
      return (
        `lock timeout on ${where}: waited ${String(this.lockTimeoutMs)} ms, ${String(attempts)} ` +
        `time(s), for a lock another session holds. The statement changed nothing. Re-run apply when ` +
        `${where} is quieter, or raise --lock-timeout-ms (Postgres: ${postgres})`
      );
    }
    return (
      `statement timeout on ${where}: ran past ${String(this.statementTimeoutMs)} ms holding its ` +
      `lock and was cancelled. The statement changed nothing. Run it in a quieter window with ` +
      `--statement-timeout-ms raised, or 0 to disable (Postgres: ${postgres})`
    );
  }

  async apply(): Promise<ApplyReport> {
    const start = this.now();
    return this.connection.withAdvisoryLock(ADVISORY_LOCK_KEY, async () => {
      const preconditions = await checkPreconditions(this.connection, this.schema);
      if (!preconditions.ok) {
        return {
          totalStatements: this.statements.length,
          executed: 0,
          skipped: 0,
          failed: 0,
          notAttempted: this.statements.length,
          durationMs: this.now() - start,
          preconditions,
          statements: [],
          haltedAt: null,
          firstFailureAt: null,
        };
      }

      await ensureMigrationLog(this.connection, this.schema);

      const records: ApplyStatementRecord[] = [];
      let executed = 0;
      let skipped = 0;
      let failed = 0;
      let haltedAt: number | null = null;
      let firstFailureAt: number | null = null;

      for (let index = 0; index < this.statements.length; index++) {
        const { sql, subject } = this.statements[index]!;
        const statementHash = hashStatement(sql);
        const excerpt = excerptStatement(sql);
        const transactional = !statementRunsOutsideTransaction(sql);

        if (
          this.skipApplied &&
          (await isStatementApplied(this.connection, this.schema, statementHash))
        ) {
          records.push({
            index,
            statementHash,
            excerpt,
            durationMs: 0,
            outcome: "skipped",
            succeeded: true,
            errorMessage: null,
            skipped: true,
            subject,
            transactional,
            attempts: 0,
            stoppedBy: null,
          });
          skipped++;
          continue;
        }

        const stmtStart = this.now();
        let attempts = 0;
        try {
          for (;;) {
            attempts++;
            try {
              await this.execute(sql, transactional);
              break;
            } catch (err) {
              // Only a lock timeout is retried: the statement rolled back having changed nothing,
              // and the session holding the lock may well be gone in a second.
              const retriable =
                transactional && applyStatementStop(err) === "lock_timeout" && attempts <= this.lockRetries;
              if (!retriable) throw err;
              await this.sleep(1_000 * 2 ** (attempts - 1));
            }
          }
          const durationMs = this.now() - stmtStart;
          await recordStatement(this.connection, this.schema, sql, durationMs, true, null);
          records.push({
            index,
            statementHash,
            excerpt,
            durationMs,
            outcome: "executed",
            succeeded: true,
            errorMessage: null,
            skipped: false,
            subject,
            transactional,
            attempts,
            stoppedBy: null,
          });
          executed++;
        } catch (err) {
          const durationMs = this.now() - stmtStart;
          const postgres = err instanceof Error ? err.message : String(err);
          const stoppedBy = transactional ? applyStatementStop(err) : null;
          const errorMessage =
            stoppedBy === null ? postgres : this.stopMessage(stoppedBy, subject, attempts, postgres);
          // Logged as `succeeded = false`, which `isStatementApplied` does not count as applied, so
          // the next run re-attempts this statement. Continuing past it must not weaken that.
          await recordStatement(
            this.connection,
            this.schema,
            sql,
            durationMs,
            false,
            errorMessage,
          );
          records.push({
            index,
            statementHash,
            excerpt,
            durationMs,
            outcome: "failed",
            succeeded: false,
            errorMessage,
            skipped: false,
            subject,
            transactional,
            attempts,
            stoppedBy,
          });
          failed++;
          if (firstFailureAt === null) firstFailureAt = index;
          if (this.stopOnFailure) {
            haltedAt = index;
            break;
          }
        }
      }

      return {
        totalStatements: this.statements.length,
        executed,
        skipped,
        failed,
        notAttempted: this.statements.length - records.length,
        durationMs: this.now() - start,
        preconditions,
        statements: records,
        haltedAt,
        firstFailureAt,
      };
    });
  }
}

/** The failed statements, in statement order. Convenience over `report.statements`. */
export function applyFailures(report: ApplyReport): readonly ApplyStatementRecord[] {
  return report.statements.filter((s) => s.outcome === "failed");
}

export function formatApplyReport(report: ApplyReport): string {
  const lines: string[] = [];
  lines.push(`Apply report (${report.durationMs} ms):`);
  if (!report.preconditions.ok) {
    lines.push("  PRECONDITIONS FAILED — no statements were executed:");
    for (const p of report.preconditions.problems) {
      lines.push(`    [${p.code}] ${p.message}`);
      if (p.remedy !== null) lines.push(`      remedy: ${p.remedy}`);
    }
    return lines.join("\n");
  }
  lines.push(`  total:    ${report.totalStatements}`);
  lines.push(`  executed: ${report.executed}`);
  lines.push(`  skipped:  ${report.skipped}`);
  lines.push(`  failed:   ${report.failed}`);
  if (report.notAttempted > 0) {
    lines.push(`  not attempted: ${report.notAttempted}`);
  }
  const failures = applyFailures(report);
  if (failures.length > 0) {
    lines.push(`  ${failures.length} failed statement(s), in statement order:`);
    for (const record of failures) {
      lines.push(`    #${record.index} ${record.excerpt}`);
      if (record.errorMessage !== null) {
        lines.push(`      error: ${record.errorMessage}`);
      }
    }
    const lockStops = failures.filter((r) => r.stoppedBy === "lock_timeout").length;
    if (lockStops > 0) {
      lines.push(
        `  ${String(lockStops)} statement(s) gave up waiting for a lock rather than queue ahead of ` +
          "live traffic; each changed nothing, the rest of the run stands, and re-running apply " +
          "retries only what is still needed.",
      );
    }
    const concurrentFailures = failures.filter((r) => !r.transactional).length;
    if (concurrentFailures > 0) {
      lines.push(
        `  ${String(concurrentFailures)} concurrent index statement(s) failed; a failed ` +
          "CREATE INDEX CONCURRENTLY leaves an invalid index, which the next apply drops and rebuilds.",
      );
    }
    if (failures.length > 1 && report.firstFailureAt !== null) {
      // Steps are applied in plan order and no dependency analysis is done, so a later failure may
      // simply be fallout from the first — say so rather than letting the reader guess.
      lines.push(
        `  read #${report.firstFailureAt} first: later failures may be consequences of it.`,
      );
    }
  }
  if (report.haltedAt !== null) {
    lines.push(
      `  halted at statement #${report.haltedAt}; ${report.notAttempted} statement(s) not attempted.`,
    );
  }
  return lines.join("\n");
}
