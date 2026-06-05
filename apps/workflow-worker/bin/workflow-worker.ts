#!/usr/bin/env node

import { CliUsageError, helpText, parseWorkerArgs } from "../src/cli.js";
import { incidentsHelpText, parseIncidentsArgs } from "../src/incidents-cli.js";
import { executeIncidents, run } from "../src/node.js";

const CLI_VERSION = "0.0.0";

async function runIncidentsCommand(argv: readonly string[]): Promise<number> {
  let options;
  try {
    options = parseIncidentsArgs(argv);
  } catch (err) {
    if (err instanceof CliUsageError) {
      process.stderr.write(`error: ${err.message}\n\n${incidentsHelpText}`);
      return 2;
    }
    throw err;
  }
  if (options.help) {
    process.stdout.write(incidentsHelpText);
    return 0;
  }
  return executeIncidents(options);
}

async function main(): Promise<number> {
  // Subcommand: `workflow-worker incidents <open|period|verify> …` is a one-shot
  // query (it exits); everything else is the long-running worker loop.
  if (process.argv[2] === "incidents") {
    return runIncidentsCommand(process.argv.slice(3));
  }

  let options;
  try {
    options = parseWorkerArgs(process.argv.slice(2));
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

  const running = await run(options);
  process.stdout.write(
    `workflow-worker ${running.workerId} running [${running.labels.join(", ")}] (mode=${options.mode})\n`,
  );

  // The poll loops run on unref'd timers (so tests never hang); hold the event
  // loop open with a referenced keep-alive that shutdown clears.
  const keepAlive = setInterval(() => {}, 1 << 30);
  const shutdown = (): void => {
    clearInterval(keepAlive);
    void running.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return -1; // keep the process alive
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
