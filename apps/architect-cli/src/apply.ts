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
