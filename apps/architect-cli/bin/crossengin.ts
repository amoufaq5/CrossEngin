#!/usr/bin/env node

import { META_TABLES } from "@crossengin/kernel/bootstrap";

import { runApply } from "../src/apply.js";
import { helpText, parseArgs } from "../src/cli.js";
import {
  runChat,
  runDiff,
  runHash,
  runInit,
  runPatch,
  runValidate,
  runVersion,
  type RunContext,
} from "../src/commands.js";
import { runGateway } from "../src/gateway.js";
import { runRetention } from "../src/retention.js";
import { runSessions } from "../src/sessions.js";
import { runTenant } from "../src/tenant.js";
import { runTenants } from "../src/tenants.js";
import { runWorkflow } from "../src/workflow.js";
import { printError } from "../src/format.js";

const CLI_VERSION = "0.0.0";

async function main(): Promise<number> {
  const ctx: RunContext = {
    io: {
      stdout: { write: (chunk: string) => process.stdout.write(chunk) },
      stderr: { write: (chunk: string) => process.stderr.write(chunk) },
    },
    env: process.env,
  };

  const parsed = parseArgs(process.argv);
  if (!parsed.ok) {
    printError(ctx.io, parsed.error.message);
    process.stderr.write("\n" + helpText());
    return 2;
  }

  const command = parsed.command;
  switch (command.subcommand) {
    case "help":
      process.stdout.write(helpText());
      return 0;
    case "version":
      return runVersion(command, ctx, {
        cliVersion: CLI_VERSION,
        metaTablesCount: META_TABLES.length,
      });
    case "init":
      return runInit(command, ctx);
    case "validate":
      return runValidate(command, ctx);
    case "diff":
      return runDiff(command, ctx);
    case "patch":
      return runPatch(command, ctx);
    case "hash":
      return runHash(command, ctx);
    case "apply":
      return runApply(command, ctx);
    case "chat":
      return runChat(command, ctx);
    case "sessions":
      return runSessions(command, ctx);
    case "gateway":
      return runGateway(command, ctx);
    case "retention":
      return runRetention(command, ctx);
    case "tenant":
      return runTenant(command, ctx);
    case "tenants":
      return runTenants(command, ctx);
    case "workflow":
      return runWorkflow(command, ctx);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(message + "\n");
    process.exit(1);
  });
