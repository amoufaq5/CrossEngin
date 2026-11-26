import {
  emitMetaBootstrapSql,
  META_SCHEMA_NAME,
  META_TABLES,
} from "@crossengin/kernel/bootstrap";
import {
  MigrationApplier,
  applyFailures,
  createNodePgConnection,
  formatApplyReport,
  applierStatementsFor,
  applyExitCode,
  formatReconciliationPlan,
  formatUncomparedApplyOutcome,
  looksLikeProductionDatabase,
  parseNonNegativeIntegerFlag,
  parsePgEnvConfig,
  planLiveReconciliation,
  type ApplyReport,
  type ApplyStatementRecord,
  type ReconciliationPlan,
} from "@crossengin/kernel-pg";

import type { ParsedCommand } from "./cli.js";
import { printError, printJson, printSuccess, type IoStreams } from "./format.js";
import type { RunContext } from "./commands.js";

/** Every flag `apply` reads; anything else is refused (H-23). */
export const APPLY_FLAG_KINDS = {
  format: "value",
  "dry-run": "boolean",
  plan: "boolean",
  confirm: "boolean",
  "allow-loosening": "boolean",
  "lock-timeout-ms": "count",
  "statement-timeout-ms": "count",
  "lock-retries": "count",
} as const;

/**
 * One sentence per flag, as a total map over `APPLY_FLAG_KINDS`: adding a flag there is a compile
 * error here until it says what it does, so `apply --help` cannot fall behind the flags `apply`
 * reads (the top-level help lists only some of them, and lists them beside every other command's).
 */
export const APPLY_FLAG_HELP: Readonly<Record<keyof typeof APPLY_FLAG_KINDS, string>> = {
  format: "human|json — the output format (default: human)",
  "dry-run": "print the full bootstrap SQL; connects to nothing",
  plan: "introspect the live schema and print the reconciliation plan, including what it will not close; applies nothing (its probe statements are rolled back), so it needs no --confirm",
  confirm: "required to execute against a database whose name looks like production",
  "allow-loosening": "also DROP foreign keys the catalog no longer declares (said on stderr before anything runs)",
  "lock-timeout-ms": "per-statement lock_timeout for the applier, and the probe's lock bound under --plan",
  "statement-timeout-ms": "per-statement statement_timeout for the applier",
  "lock-retries": "how many times a statement that timed out on its lock is retried",
};

export function applyHelpText(): string {
  const names = Object.keys(APPLY_FLAG_HELP) as (keyof typeof APPLY_FLAG_HELP)[];
  const width = Math.max(...names.map((n) => n.length)) + 4;
  return [
    "Usage: crossengin apply [flags]",
    "",
    "Reconcile the meta-schema with the Postgres named by PGHOST / PGPORT / PGUSER / PGPASSWORD /",
    "PGDATABASE / PGSSLMODE. A flag not listed here is refused, and so is a flag given twice.",
    "",
    "Flags:",
    ...names.map((n) => `  ${`--${n}`.padEnd(width)}${APPLY_FLAG_HELP[n]}`),
    `  ${"--help".padEnd(width)}print this text and run nothing`,
    "",
  ].join("\n");
}

export interface ApplyFlags {
  readonly dryRun: boolean;
  readonly planOnly: boolean;
  readonly confirm: boolean;
  readonly allowLoosening: boolean;
  readonly bounds: {
    readonly lockTimeoutMs?: number;
    readonly statementTimeoutMs?: number;
    readonly lockRetries?: number;
  };
}

/**
 * Read `apply`'s flags strictly. `getBooleanFlag` answers false for any value it does not recognise,
 * so `--plan yes` (which the shared parser reads as `plan = "yes"`) was an **apply**, and a misspelt
 * `--paln` was silently ignored — on the one command whose effect is DDL against a live database.
 */
export function readApplyFlags(
  command: ParsedCommand,
): { readonly ok: true; readonly flags: ApplyFlags } | { readonly ok: false; readonly error: string } {
  if (command.positional.length > 0) {
    return { ok: false, error: `unexpected argument '${command.positional[0]!}'` };
  }
  // A repeat is refused rather than resolved, because the shared parser keeps the later value and
  // `--plan --plan=false` would otherwise be an apply decided by argv order.
  const repeated = [...command.repeatedFlags].sort();
  if (repeated.length > 0) {
    return { ok: false, error: `--${repeated[0]!} is given more than once; give each flag once` };
  }
  const booleans = new Set<string>();
  const bounds: { lockTimeoutMs?: number; statementTimeoutMs?: number; lockRetries?: number } = {};
  const boundKey = {
    "lock-timeout-ms": "lockTimeoutMs",
    "statement-timeout-ms": "statementTimeoutMs",
    "lock-retries": "lockRetries",
  } as const;
  for (const [name, value] of command.flags) {
    const kind = Object.prototype.hasOwnProperty.call(APPLY_FLAG_KINDS, name)
      ? APPLY_FLAG_KINDS[name as keyof typeof APPLY_FLAG_KINDS]
      : undefined;
    if (kind === undefined) return { ok: false, error: `unknown flag --${name}` };
    if (kind === "value") continue;
    if (kind === "boolean") {
      if (value === true || value === "true" || value === "1") booleans.add(name);
      else if (value !== "false" && value !== "0") {
        return { ok: false, error: `--${name} takes no value, or =true / =false; got '${value}'` };
      }
      continue;
    }
    if (value === true) return { ok: false, error: `--${name} needs a value` };
    const parsed = parseNonNegativeIntegerFlag(name, value);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    bounds[boundKey[name as keyof typeof boundKey]] = parsed.value;
  }
  return {
    ok: true,
    flags: {
      dryRun: booleans.has("dry-run"),
      planOnly: booleans.has("plan"),
      confirm: booleans.has("confirm"),
      allowLoosening: booleans.has("allow-loosening"),
      bounds,
    },
  };
}

export async function runApply(
  command: ParsedCommand,
  ctx: RunContext,
): Promise<number> {
  if (command.flags.get("help") === true && !command.repeatedFlags.has("help")) {
    // Before anything is read or validated: asking for help must never run, or refuse to run, the
    // command it is asking about.
    printSuccess(ctx.io, applyHelpText());
    return 0;
  }
  const read = readApplyFlags(command);
  if (!read.ok) {
    printError(ctx.io, `apply: ${read.error}`);
    return 2;
  }
  const { dryRun, planOnly, confirm, bounds } = read.flags;
  // The one reconciliation refusal an operator can override (ADR-0328). It has existed on
  // `ReconciliationOptions` since ADR-0308 with no way to pass it, so the four kill-switch
  // `meta.users` foreign keys ADR-0296 removed from the catalog have been reported as undeclared
  // drift on every existing deployment since, with no way to drop them but by hand. It reaches
  // **foreign keys only**, because dropping one is the single loosening that cannot fail against
  // existing rows — which is what keeps ADR-0290's "every step in the plan is expected to succeed"
  // true.
  const allowLoosening = read.flags.allowLoosening;
  if (dryRun) {
    return emitDryRun(ctx.io, command);
  }
  let config: ReturnType<typeof parsePgEnvConfig>;
  try {
    config = parsePgEnvConfig(ctx.env);
  } catch (err) {
    printError(ctx.io, `apply: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  // `--plan` is exempt: it introspects and proves through probe statements that are rolled back
  // (`planLiveReconciliation`), so it writes nothing, and refusing it is refusing the one read an
  // operator wants before deciding whether to pass `--confirm` at all.
  if (looksLikeProductionDatabase(config.database) && !confirm && !planOnly) {
    printError(
      ctx.io,
      `apply: refusing to apply against production-looking database '${config.database}' without --confirm`,
    );
    return 2;
  }
  const conn = createNodePgConnection(config);
  try {
    // Reconcile against the live schema rather than replaying the bootstrap SQL. On an empty
    // database the plan *is* the bootstrap SQL, so a fresh install is unchanged; on a database
    // that already has the schema, only the differences are applied — which is what lets an
    // edited table definition migrate instead of re-running `CREATE TABLE` and halting.
    const plan = await planLiveReconciliation(conn, META_SCHEMA_NAME, META_TABLES, {
      ...(allowLoosening ? { allowLoosening: true } : {}),
      ...(bounds.lockTimeoutMs === undefined ? {} : { probeLockTimeoutMs: bounds.lockTimeoutMs }),
    });
    if (planOnly) {
      if (command.format === "json") {
        printJson(ctx.io, plan);
      } else {
        printSuccess(ctx.io, formatReconciliationPlan(plan));
      }
      return 0;
    }
    if (allowLoosening) {
      // Said out loud before anything runs: this is the one invocation that *removes* a constraint
      // the database is currently enforcing, and the apply report alone would not say so.
      printError(
        ctx.io,
        "apply: --allow-loosening — undeclared foreign keys will be DROPPED rather than reported",
      );
    }
    const applier = new MigrationApplier({
      connection: conn,
      schema: META_SCHEMA_NAME,
      // The plan's own statements, and nothing prepended. `emitSchemaCreate` used to lead this
      // list and was redundant twice over: `MigrationApplier` calls `ensureMigrationLog` before the
      // first statement and *its* first DDL is `CREATE SCHEMA IF NOT EXISTS`, and on an empty
      // database the plan is `emitBootstrapSql`, which already begins with the same statement. The
      // cost was a report that read as a claim about the schema: on a fully converged database the
      // plan is empty, so the applier ran exactly that one idempotent statement and printed
      // `total: 1, executed: 1` — "one change was made" where nothing had changed, which is the
      // confusion ADR-0331 added the re-plan to remove.
      statements: applierStatementsFor(plan),
      // The plan was computed from the live schema, so every statement in it is needed; the hash
      // log records what ran, not what the database holds, and skipping on it here would leave a
      // dropped object missing.
      skipApplied: false,
      // Continue past a failed statement. The plan is built to succeed and its steps are largely
      // independent, so one refused ALTER must not hide the thirty additions behind it.
      stopOnFailure: false,
      ...bounds,
    });
    const report = await applier.apply();
    // Re-plan after a clean apply, because "executed 3, failed 0" is not the same claim as "the
    // schema now matches the catalog" and an operator reads it as if it were (ADR-0331).
    //
    // A plan converges in one pass almost always, but not always: a step can only be planned
    // against the schema as it was *before* the pass, so a declared CHECK on a column whose type
    // is also changing is deferred to the next plan rather than ordered after the `ALTER` — which
    // is the safe choice, since the plan's invariant is that every step in it is expected to
    // succeed, and ordering it would be guessing at a dependency this planner does not model.
    // Found live: a two-pass case reported `failed: 0` with the CHECK still missing.
    //
    // Only on a clean apply. After a failure the remaining difference is obviously the failure's,
    // and a second message would bury the first.
    const converged =
      report.preconditions.ok && report.failed === 0
        ? await planLiveReconciliation(conn, META_SCHEMA_NAME, META_TABLES, {
            ...(allowLoosening ? { allowLoosening: true } : {}),
            ...(bounds.lockTimeoutMs === undefined ? {} : { probeLockTimeoutMs: bounds.lockTimeoutMs }),
          })
        : null;
    if (command.format === "json") {
      printJson(ctx.io, applyJsonPayload(report, plan, converged));
    } else {
      printSuccess(ctx.io, formatApplyReport(report));
      // Which plan's differences to print is not cosmetic. After a clean apply the pre-apply plan's
      // statements have all *run*, so rendering it prints "1 statement(s) to apply" about work this
      // invocation just did — the same confusion between a report of the past and a claim about the
      // present that the re-plan above exists to end. `converged` is the only one of the two that
      // describes the schema as it now is; `plan` is the best available only when the apply did not
      // finish, and there the failure report sits beside it.
      const standing = standingDifferences(plan, converged);
      if (standing.unreconciled.length > 0 || (standing.uncompared ?? []).length > 0) {
        printSuccess(ctx.io, formatReconciliationPlan(standing));
      }
      const uncomparedOutcome = formatUncomparedApplyOutcome(standing.uncompared ?? []);
      if (uncomparedOutcome !== null) printSuccess(ctx.io, uncomparedOutcome);
      if (converged !== null && converged.statements.length > 0) {
        printSuccess(
          ctx.io,
          `  ${converged.statements.length.toString()} statement(s) still to apply —` +
            " run apply again. A step is planned against the schema as it was before this pass," +
            " so a change that depends on one of them lands on the next.",
        );
      }
    }
    // Unchanged by ADR-0363 and deliberately: an `unreconciled` item exits 0, including the one
    // reason no re-run can clear, because `deploy/`'s `migrate` step gates the API on this exit
    // code. `crossengin-pg.ts` carries the argument at the sibling site. An expression left
    // uncompared by the plan that describes the schema now does exit 1 (`applyExitCode`): its change
    // may have been skipped, and a re-run is the remedy.
    return applyExitCode(report, standingDifferences(plan, converged).uncompared ?? []);
  } catch (err) {
    printError(ctx.io, `apply: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    await conn.close().catch(() => undefined);
  }
}

export interface ApplyJsonPayload {
  readonly report: ApplyReport;
  readonly plan: ReconciliationPlan;
  /**
   * The failed statements, lifted out of `report.statements` so a consumer sees each failure's SQL
   * and error without walking 800 outcome entries to find them.
   */
  readonly failures: readonly ApplyStatementRecord[];
  /**
   * The plan as it stands **after** this pass, so a machine consumer can tell "it ran" from "it is
   * done" (ADR-0331). `null` when the apply did not finish cleanly — the remaining difference is
   * then obviously the failure's, and re-planning would only describe it a second way.
   *
   * `remaining.statements.length === 0` **and** `remaining.uncompared` empty is the convergence
   * claim. Statements left mean another `apply` is needed, which happens when a step could only be
   * planned against the schema as it was before this pass; an uncompared expression means the plan
   * could not say whether that object matches the catalog at all.
   */
  readonly remaining: ReconciliationPlan | null;
}

export function applyJsonPayload(
  report: ApplyReport,
  plan: ReconciliationPlan,
  remaining: ReconciliationPlan | null = null,
): ApplyJsonPayload {
  return { report, plan, failures: applyFailures(report), remaining };
}

/**
 * Which of the two plans describes the differences that **still** stand, for printing.
 *
 * Not cosmetic, and found live. After a clean apply the pre-apply plan's statements have all run, so
 * rendering it prints "1 statement(s) to apply" about work this very invocation just did — a report
 * of the past read as a claim about the present, which is the confusion ADR-0331's re-plan exists to
 * end. The re-plan is the only one of the two that describes the schema as it now is.
 *
 * `null` means no re-plan was taken, which only happens when the apply did not finish; the pre-apply
 * plan is then the best available and the failure report sits beside it to say so.
 */
export function standingDifferences(
  plan: ReconciliationPlan,
  converged: ReconciliationPlan | null,
): ReconciliationPlan {
  return converged ?? plan;
}

function emitDryRun(io: IoStreams, command: ParsedCommand): number {
  const statements = emitMetaBootstrapSql();
  if (command.format === "json") {
    printJson(io, {
      schema: META_SCHEMA_NAME,
      tableCount: META_TABLES.length,
      statementCount: statements.length,
      statements,
    });
    return 0;
  }
  for (const stmt of statements) {
    io.stdout.write(stmt + "\n");
  }
  io.stdout.write(`-- ${statements.length.toString()} statement(s); ${META_TABLES.length.toString()} tables\n`);
  return 0;
}
