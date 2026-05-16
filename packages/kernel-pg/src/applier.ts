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

export interface ApplyStatementRecord {
  readonly statementHash: string;
  readonly excerpt: string;
  readonly durationMs: number;
  readonly succeeded: boolean;
  readonly errorMessage: string | null;
  readonly skipped: boolean;
}

export interface ApplyReport {
  readonly totalStatements: number;
  readonly executed: number;
  readonly skipped: number;
  readonly failed: number;
  readonly durationMs: number;
  readonly preconditions: PreconditionReport;
  readonly statements: readonly ApplyStatementRecord[];
  readonly haltedAt: number | null;
}

export interface MigrationApplierOptions {
  readonly connection: PgConnection;
  readonly schema: string;
  readonly statements: readonly string[];
  readonly now?: () => number;
}

export class MigrationApplier {
  private readonly connection: PgConnection;
  private readonly schema: string;
  private readonly statements: readonly string[];
  private readonly now: () => number;

  constructor(opts: MigrationApplierOptions) {
    this.connection = opts.connection;
    this.schema = opts.schema;
    this.statements = opts.statements;
    this.now = opts.now ?? (() => Date.now());
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
          durationMs: this.now() - start,
          preconditions,
          statements: [],
          haltedAt: null,
        };
      }

      await ensureMigrationLog(this.connection, this.schema);

      const records: ApplyStatementRecord[] = [];
      let executed = 0;
      let skipped = 0;
      let failed = 0;
      let haltedAt: number | null = null;

      for (let index = 0; index < this.statements.length; index++) {
        const sql = this.statements[index]!;
        const statementHash = hashStatement(sql);
        const excerpt = excerptStatement(sql);

        if (await isStatementApplied(this.connection, this.schema, statementHash)) {
          records.push({
            statementHash,
            excerpt,
            durationMs: 0,
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
            statementHash,
            excerpt,
            durationMs,
            succeeded: true,
            errorMessage: null,
            skipped: false,
          });
          executed++;
        } catch (err) {
          const durationMs = this.now() - stmtStart;
          const errorMessage = err instanceof Error ? err.message : String(err);
          await recordStatement(
            this.connection,
            this.schema,
            sql,
            durationMs,
            false,
            errorMessage,
          );
          records.push({
            statementHash,
            excerpt,
            durationMs,
            succeeded: false,
            errorMessage,
            skipped: false,
          });
          failed++;
          haltedAt = index;
          break;
        }
      }

      return {
        totalStatements: this.statements.length,
        executed,
        skipped,
        failed,
        durationMs: this.now() - start,
        preconditions,
        statements: records,
        haltedAt,
      };
    });
  }
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
  if (report.haltedAt !== null) {
    lines.push(`  halted at statement #${report.haltedAt}:`);
    const failedRecord = report.statements[report.haltedAt];
    if (failedRecord !== undefined) {
      lines.push(`    ${failedRecord.excerpt}`);
      if (failedRecord.errorMessage !== null) {
        lines.push(`    error: ${failedRecord.errorMessage}`);
      }
    }
  }
  return lines.join("\n");
}
