#!/usr/bin/env node

import { createNodePgConnection, parsePgEnvConfig } from "@crossengin/kernel-pg";

import { GatewayReplayer } from "../src/replayer.js";
import {
  CliUsageError,
  parseExecutionsArgs,
  runVerifyExecutions,
} from "../src/verify-runner.js";

const CLI_VERSION = "0.0.0";

function printHelp(): void {
  process.stdout.write(
    [
      "Usage: crossengin-gateway-pg <command> [flags]",
      "",
      "Commands:",
      "  executions verify    Verify persisted gateway pipeline executions; exit 1 on drift",
      "  executions summary   Same drift sweep but always exit 0 (report only)",
      "  version              Print the CLI version",
      "  help                 Show this help text",
      "",
      "Flags (executions):",
      "  --since <iso>        Only verify executions started at/after this timestamp",
      "  --tenant-id <uuid>   Only verify a single tenant's executions",
      "  --max <n>            Cap the number of executions verified",
      "  --batch-size <n>     Rows fetched per round (default 100)",
      "  --format human|json  Output format (default human)",
      "",
      "Environment:",
      "  PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE, PGSSLMODE, PGAPPNAME",
      "",
    ].join("\n"),
  );
}

async function runExecutions(argv: readonly string[]): Promise<number> {
  const options = parseExecutionsArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }
  const conn = createNodePgConnection(parsePgEnvConfig());
  try {
    const replayer = new GatewayReplayer({ conn });
    const result = await runVerifyExecutions(options, replayer, (line) => {
      process.stdout.write(line + "\n");
    });
    return result.exitCode;
  } finally {
    await conn.close();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const word = argv[0];
  let exitCode = 0;
  if (word === undefined || word === "help" || argv.includes("--help") && word === undefined) {
    printHelp();
    process.exit(0);
  }
  if (word === "version") {
    process.stdout.write(`crossengin-gateway-pg ${CLI_VERSION}\n`);
    process.exit(0);
  }
  if (word === "executions") {
    exitCode = await runExecutions(argv.slice(1));
    process.exit(exitCode);
  }
  process.stderr.write(`unknown command '${word}' (expected executions|version|help)\n`);
  process.exit(2);
}

main().catch((err: unknown) => {
  if (err instanceof CliUsageError) {
    process.stderr.write(err.message + "\n");
    process.exit(2);
  }
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(message + "\n");
  process.exit(1);
});
