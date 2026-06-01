import { emitMetaBootstrapSql, META_SCHEMA_NAME, META_TABLES } from "@crossengin/kernel/bootstrap";
import {
  ExtendsCycleError,
  UnknownParentManifestError,
  emitManifestCreate,
  resolveManifest,
  tryValidateManifest,
} from "@crossengin/kernel/manifest";
import {
  MigrationApplier,
  createNodePgConnection,
  formatApplyReport,
  looksLikeProductionDatabase,
  parsePgEnvConfig,
  type ApplyReport,
} from "@crossengin/kernel-pg";

import type { ParsedCommand } from "./cli.js";
import { getBooleanFlag, getStringFlag } from "./cli.js";
import { printError, printJson, printSuccess, type IoStreams } from "./format.js";
import type { RunContext } from "./commands.js";
import {
  UnknownPackError,
  listAvailablePacks,
  packManifestRegistry,
  resolvePack,
  type PackEntry,
} from "./pack-registry.js";

const DEFAULT_PACK_SCHEMA = "public";

interface ResolvedPlan {
  readonly metaStatements: readonly string[];
  readonly packStatements: readonly string[];
  readonly pack: PackEntry | null;
  readonly packSchema: string;
}

export async function runApply(command: ParsedCommand, ctx: RunContext): Promise<number> {
  const dryRun = getBooleanFlag(command, "dry-run");
  const confirm = getBooleanFlag(command, "confirm");
  const packSlug = getStringFlag(command, "pack");
  const packSchema = getStringFlag(command, "pack-schema") ?? DEFAULT_PACK_SCHEMA;

  let plan: ResolvedPlan;
  try {
    plan = await buildPlan({ packSlug, packSchema });
  } catch (err) {
    if (err instanceof UnknownPackError) {
      printError(ctx.io, `apply: ${err.message}`);
      return 2;
    }
    if (err instanceof PackValidationError) {
      printError(ctx.io, `apply: ${err.message}`);
      return 1;
    }
    if (err instanceof ExtendsCycleError) {
      printError(ctx.io, `apply: pack extends-chain cycle: ${err.message}`);
      return 1;
    }
    if (err instanceof UnknownParentManifestError) {
      printError(
        ctx.io,
        `apply: pack references unknown parent: ${err.message}. Available: ${listAvailablePacks().join(", ")}`,
      );
      return 1;
    }
    throw err;
  }

  if (dryRun) {
    return emitDryRun(ctx.io, command, plan);
  }
  let config: ReturnType<typeof parsePgEnvConfig>;
  try {
    config = parsePgEnvConfig(ctx.env);
  } catch (err) {
    printError(ctx.io, `apply: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  if (looksLikeProductionDatabase(config.database) && !confirm) {
    printError(
      ctx.io,
      `apply: refusing to apply against production-looking database '${config.database}' without --confirm`,
    );
    return 2;
  }
  const conn = createNodePgConnection(config);
  try {
    const applier = new MigrationApplier({
      connection: conn,
      schema: META_SCHEMA_NAME,
      statements: [...plan.metaStatements, ...plan.packStatements],
    });
    const report = await applier.apply();
    if (command.format === "json") {
      printJson(ctx.io, { ...report, pack: plan.pack?.slug ?? null });
    } else if (command.format === "gh-summary") {
      // M4.15.w — Markdown summary for CI step output. Operators
      // redirect `crossengin apply --confirm --format gh-summary
      // >> $GITHUB_STEP_SUMMARY` to surface apply-report results
      // in the run UI. Verdict reflects exit-code semantic:
      // preconditions failed or failed > 0 → :x:; clean → :white_
      // check_mark:. Per-statement failure rows surface for
      // operator triage.
      ctx.io.stdout.write(
        formatApplyReportGhSummary({
          schema: META_SCHEMA_NAME,
          pack: plan.pack,
          packSchema: plan.packSchema,
          report,
        }),
      );
    } else {
      printSuccess(ctx.io, formatApplyReport(report));
      if (plan.pack !== null) {
        printSuccess(
          ctx.io,
          `applied pack '${plan.pack.slug}' (${plan.packStatements.length.toString()} statement(s) in schema '${plan.packSchema}').`,
        );
      }
    }
    if (!report.preconditions.ok || report.failed > 0) return 1;
    return 0;
  } catch (err) {
    printError(ctx.io, `apply: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    await conn.close().catch(() => undefined);
  }
}

class PackValidationError extends Error {
  readonly kind = "pack_validation_error" as const;

  constructor(slug: string, errors: ReadonlyArray<{ path: string; message: string }>) {
    const summary = errors.map((e) => `${e.path}: ${e.message}`).join("; ");
    super(`pack '${slug}' failed validation: ${summary}`);
    this.name = "PackValidationError";
  }
}

async function buildPlan(input: {
  readonly packSlug: string | null;
  readonly packSchema: string;
}): Promise<ResolvedPlan> {
  const metaStatements = emitMetaBootstrapSql();
  if (input.packSlug === null) {
    return {
      metaStatements,
      packStatements: [],
      pack: null,
      packSchema: input.packSchema,
    };
  }
  const pack = resolvePack(input.packSlug);
  const rawManifest = pack.build();
  const manifest = await resolveManifest(rawManifest, {
    registry: packManifestRegistry(),
  });
  const result = tryValidateManifest(manifest);
  if (!result.ok) {
    throw new PackValidationError(input.packSlug, result.errors);
  }
  const packStatements = emitManifestCreate(manifest, { schema: input.packSchema });
  return {
    metaStatements,
    packStatements,
    pack,
    packSchema: input.packSchema,
  };
}

function emitDryRun(io: IoStreams, command: ParsedCommand, plan: ResolvedPlan): number {
  const allStatements = [...plan.metaStatements, ...plan.packStatements];
  if (command.format === "json") {
    printJson(io, {
      schema: META_SCHEMA_NAME,
      tableCount: META_TABLES.length,
      statementCount: allStatements.length,
      metaStatementCount: plan.metaStatements.length,
      packStatementCount: plan.packStatements.length,
      pack: plan.pack === null ? null : { slug: plan.pack.slug, schema: plan.packSchema },
      availablePacks: listAvailablePacks(),
      statements: allStatements,
    });
    return 0;
  }
  if (command.format === "gh-summary") {
    // M4.15.w — gh-summary for dry-run is informational (not a
    // gate). Reports planned-statement counts + table count + pack
    // metadata. No verdict emoji since dry-run doesn't pass/fail
    // semantically.
    io.stdout.write(
      formatApplyDryRunGhSummary({
        schema: META_SCHEMA_NAME,
        tableCount: META_TABLES.length,
        metaStatementCount: plan.metaStatements.length,
        packStatementCount: plan.packStatements.length,
        pack: plan.pack,
        packSchema: plan.packSchema,
      }),
    );
    return 0;
  }
  for (const stmt of plan.metaStatements) io.stdout.write(stmt + "\n");
  if (plan.packStatements.length > 0) {
    io.stdout.write(
      `\n-- ${plan.packStatements.length.toString()} pack statement(s) from '${plan.pack!.slug}' (schema '${plan.packSchema}')\n`,
    );
    for (const stmt of plan.packStatements) io.stdout.write(stmt + "\n");
  }
  io.stdout.write(
    `-- ${allStatements.length.toString()} statement(s) total; ${META_TABLES.length.toString()} meta tables` +
      (plan.pack !== null ? ` + pack '${plan.pack.slug}'` : "") +
      "\n",
  );
  return 0;
}

// M4.15.w — gh-summary Markdown for an apply report. Verdict footer
// reflects exit-code semantic: precondition failure or any failed
// statement → :x: with the apply gate failure message; clean +
// non-empty → :white_check_mark: with applied/skipped counts.
// Preconditions section surfaces problems (missing pg_uuidv7, too-
// old PG, no CREATE privilege) with a remedy column. Failed-
// statement table surfaces hash + excerpt + error message for
// triage; statements that succeeded don't appear (would be 50+
// rows of noise for a successful meta apply).
export interface ApplyReportGhSummaryInput {
  readonly schema: string;
  readonly pack: PackEntry | null;
  readonly packSchema: string;
  readonly report: ApplyReport;
}

export function formatApplyReportGhSummary(input: ApplyReportGhSummaryInput): string {
  const lines: string[] = [];
  const { report } = input;
  lines.push(`## Apply: meta schema${input.pack !== null ? ` + pack \`${input.pack.slug}\`` : ""}`);
  lines.push("");
  lines.push(`**Schema:** \`${input.schema}\`  `);
  if (input.pack !== null) {
    lines.push(`**Pack:** \`${input.pack.slug}\` (schema \`${input.packSchema}\`)  `);
  }
  lines.push(
    `**Statements:** ${report.totalStatements} | **Executed:** ${report.executed} | **Skipped:** ${report.skipped} | **Failed:** ${report.failed} | **Duration:** ${report.durationMs}ms`,
  );
  lines.push("");

  // Precondition problems take priority — if they fail, the apply
  // didn't run any statements so the per-statement table is empty
  // but the precondition table is what operators need to see.
  if (!report.preconditions.ok && report.preconditions.problems.length > 0) {
    lines.push(`### Precondition problems (${report.preconditions.problems.length})`);
    lines.push("");
    lines.push(`| Code | Message | Remedy |`);
    lines.push(`|------|---------|--------|`);
    for (const p of report.preconditions.problems) {
      const remedy = p.remedy === null ? "" : escapeMdPipe(p.remedy);
      lines.push(`| \`${p.code}\` | ${escapeMdPipe(p.message)} | ${remedy} |`);
    }
    lines.push("");
    lines.push(`:x: **Apply blocked** — preconditions failed; no statements executed.`);
    return lines.join("\n") + "\n";
  }

  // Failed statements (subset of report.statements). Successful
  // statements don't appear in the table — too many rows for the
  // common case (~50+ meta statements all succeed).
  const failedStatements = report.statements.filter((s) => !s.succeeded && !s.skipped);
  if (failedStatements.length > 0) {
    lines.push(`### Failed statements (${failedStatements.length})`);
    lines.push("");
    lines.push(`| Hash | Excerpt | Error |`);
    lines.push(`|------|---------|-------|`);
    for (const s of failedStatements) {
      const hash = s.statementHash.slice(0, 8);
      lines.push(
        `| \`${hash}\` | \`${escapeMdPipe(s.excerpt)}\` | ${escapeMdPipe(s.errorMessage ?? "(no error message)")} |`,
      );
    }
    lines.push("");
    if (report.haltedAt !== null) {
      lines.push(
        `:x: **Apply halted at statement ${report.haltedAt + 1}/${report.totalStatements}** — ${report.failed} statement(s) failed.`,
      );
    } else {
      lines.push(`:x: **Apply completed with errors** — ${report.failed} statement(s) failed.`);
    }
    return lines.join("\n") + "\n";
  }

  // Success path.
  lines.push(
    `:white_check_mark: **Apply succeeded** — ${report.executed} statement(s) executed, ${report.skipped} skipped (already applied).`,
  );
  return lines.join("\n") + "\n";
}

export interface ApplyDryRunGhSummaryInput {
  readonly schema: string;
  readonly tableCount: number;
  readonly metaStatementCount: number;
  readonly packStatementCount: number;
  readonly pack: PackEntry | null;
  readonly packSchema: string;
}

export function formatApplyDryRunGhSummary(input: ApplyDryRunGhSummaryInput): string {
  const lines: string[] = [];
  const total = input.metaStatementCount + input.packStatementCount;
  lines.push(
    `## Apply (dry-run): meta schema${input.pack !== null ? ` + pack \`${input.pack.slug}\`` : ""}`,
  );
  lines.push("");
  lines.push(`**Schema:** \`${input.schema}\`  `);
  if (input.pack !== null) {
    lines.push(`**Pack:** \`${input.pack.slug}\` (schema \`${input.packSchema}\`)  `);
  }
  lines.push(
    `**Statements planned:** ${total} (${input.metaStatementCount} meta + ${input.packStatementCount} pack) | **Meta tables:** ${input.tableCount}`,
  );
  lines.push("");
  // Informational note instead of verdict — dry-run doesn't gate.
  lines.push(
    `_Dry-run: no statements executed. Re-run without \`--dry-run\` and with \`--confirm\` to apply._`,
  );
  return lines.join("\n") + "\n";
}

function escapeMdPipe(s: string): string {
  // Markdown pipe escape for table cells. Backslashes get
  // double-escaped first so we don't undo our own quoting.
  return s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}
