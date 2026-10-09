#!/usr/bin/env node

import {
  CliUsageError,
  helpText,
  parsePruneArgs,
  parseServeArgs,
  parseVerifyChainArgs,
  pruneHelpText,
  verifyChainHelpText,
  parseReplayArgs,
  replayHelpText,
  parseRekeyArgs,
  rekeyHelpText,
} from "../src/cli.js";
import { formatMultiTenantReport } from "../src/link-sweep.js";
import { formatChainVerification } from "../src/chain-verify.js";
import { runPruneLinks, runRekey, runReplay, runVerifyChain, serve } from "../src/node.js";
import { formatReplayReport } from "../src/replay.js";
import { formatRekeyResult, formatRekeySurvey } from "../src/rekey.js";

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

async function runReplayCommand(argv: readonly string[]): Promise<number> {
  let options;
  try {
    options = parseReplayArgs(argv);
  } catch (err) {
    if (err instanceof CliUsageError) {
      process.stderr.write(`error: ${err.message}\n\n${replayHelpText}`);
      return 2;
    }
    throw err;
  }
  if (options.help) {
    process.stdout.write(replayHelpText);
    return 0;
  }
  const report = await runReplay(options);
  process.stdout.write(
    options.format === "json"
      ? `${JSON.stringify(report, null, 2)}\n`
      : `${formatReplayReport(report)}\n`,
  );
  // Non-zero for a refused or failed section as well as for a finding: "0 findings" from a
  // subsystem that could not be read must not exit 0, or a maintenance job launders an unread
  // subsystem into a pass. `summarizeReplay` carries that rule; this is just its exit code.
  return report.ok ? 0 : 1;
}

async function runRekeyCommand(argv: readonly string[]): Promise<number> {
  let options;
  try {
    options = parseRekeyArgs(argv);
  } catch (err) {
    if (err instanceof CliUsageError) {
      process.stderr.write(`error: ${err.message}\n\n${rekeyHelpText}`);
      return 2;
    }
    throw err;
  }
  if (options.help) {
    process.stdout.write(rekeyHelpText);
    return 0;
  }
  const report = await runRekey(options);
  if (options.format === "json") {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    // The survey either way, including after a completed rekey: it is what names the columns and
    // the row counts, and a result printed alone would not say what was examined.
    process.stdout.write(`${formatRekeySurvey(report.survey, report.writeStatus)}\n`);
    if (report.result !== null) {
      process.stdout.write(`\n${formatRekeyResult(report.result, report.staleKeyWindowMs, report.staleKeyWindowStated)}\n`);
    }
  }
  // A refused survey exits 1 and a clean plan exits 0, following `replay`: a plan that printed
  // nothing actionable must not be indistinguishable from a refusal nobody read.
  return report.ok ? 0 : 1;
}

async function main(): Promise<number> {

  const argv = process.argv.slice(2);
  if (argv[0] === "prune-links") {
    return runPrune(argv.slice(1));
  }
  if (argv[0] === "rekey") {
    return runRekeyCommand(argv.slice(1));
  }
  if (argv[0] === "verify-chain") {
    return runVerify(argv.slice(1));
  }
  if (argv[0] === "replay") {
    return runReplayCommand(argv.slice(1));
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
