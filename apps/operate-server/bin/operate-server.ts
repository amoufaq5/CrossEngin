#!/usr/bin/env node

import {
  CliUsageError,
  helpText,
  parsePruneArgs,
  parseServeArgs,
  parseVerifyChainArgs,
  pruneHelpText,
  verifyChainHelpText,
} from "../src/cli.js";
import { formatMultiTenantReport } from "../src/link-sweep.js";
import { formatChainVerification } from "../src/chain-verify.js";
import { runPruneLinks, runVerifyChain, serve } from "../src/node.js";

const CLI_VERSION = "0.0.0";

async function runPrune(argv: readonly string[]): Promise<number> {
  let options;
  try {
    options = parsePruneArgs(argv);
  } catch (err) {
    if (err instanceof CliUsageError) {
      process.stderr.write(`error: ${err.message}\n\n${pruneHelpText}`);
      return 2;
    }
    throw err;
  }
  if (options.help) {
    process.stdout.write(pruneHelpText);
    return 0;
  }
  const report = await runPruneLinks(options);
  process.stdout.write(formatMultiTenantReport(report));
  return 0;
}

async function runVerify(argv: readonly string[]): Promise<number> {
  let options;
  try {
    options = parseVerifyChainArgs(argv);
  } catch (err) {
    if (err instanceof CliUsageError) {
      process.stderr.write(`error: ${err.message}\n\n${verifyChainHelpText}`);
      return 2;
    }
    throw err;
  }
  if (options.help) {
    process.stdout.write(verifyChainHelpText);
    return 0;
  }
  const report = await runVerifyChain(options);
  process.stdout.write(
    options.format === "json"
      ? `${JSON.stringify(report, null, 2)}\n`
      : `${formatChainVerification(report)}\n`,
  );
  return report.ok ? 0 : 1;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv[0] === "prune-links") {
    return runPrune(argv.slice(1));
  }
  if (argv[0] === "verify-chain") {
    return runVerify(argv.slice(1));
  }

  let options;
  try {
    options = parseServeArgs(argv);
  } catch (err) {
    if (err instanceof CliUsageError) {
      process.stderr.write(`error: ${err.message}\n\n${helpText}`);
      return 2;
    }
    throw err;
  }

  if (options.help) {
    process.stdout.write(helpText);
    return 0;
  }
  if (options.version) {
    process.stdout.write(`${CLI_VERSION}\n`);
    return 0;
  }

  const running = await serve(options);
  const source = options.pack !== null ? `pack ${options.pack}` : `manifest ${options.manifestPath ?? ""}`;
  process.stdout.write(
    `operate-server listening on http://localhost:${running.port.toString()} (${source}, store=${options.store})\n`,
  );

  const shutdown = (): void => {
    void running.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return -1; // keep the process alive; the server holds the event loop
}

main()
  .then((code) => {
    if (code >= 0) process.exit(code);
  })
  .catch((err: unknown) => {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(`fatal: ${detail}\n`);
    process.exit(1);
  });
