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
  readonly statements: readonly string[];
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
}

export class MigrationApplier {
  private readonly connection: PgConnection;
  private readonly schema: string;
  private readonly statements: readonly string[];
  private readonly now: () => number;
  private readonly skipApplied: boolean;
  private readonly stopOnFailure: boolean;

  constructor(opts: MigrationApplierOptions) {
    this.connection = opts.connection;
    this.schema = opts.schema;
    this.statements = opts.statements;
    this.now = opts.now ?? (() => Date.now());
    this.skipApplied = opts.skipApplied ?? true;
    this.stopOnFailure = opts.stopOnFailure ?? false;
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
        const sql = this.statements[index]!;
        const statementHash = hashStatement(sql);
        const excerpt = excerptStatement(sql);

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
          });
          skipped++;
          continue;
        }

        const stmtStart = this.now();
        try {
          await this.connection.transaction(async (tx) => {
            await tx.query(sql);
          });
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
          });
          executed++;
        } catch (err) {
          const durationMs = this.now() - stmtStart;
          const errorMessage = err instanceof Error ? err.message : String(err);
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
