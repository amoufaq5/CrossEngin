#!/usr/bin/env node

import { CliUsageError, helpText, parseServeArgs } from "../src/cli.js";
import { incidentsHelpText, parseIncidentsArgs } from "../src/incidents-cli.js";
import { executeIncidents, serve } from "../src/node.js";

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
  // Subcommand: `operate-server incidents <open|period|verify|metrics|ack|mitigate>`
  // is a one-shot query against meta.incidents (it exits); everything else is the
  // long-running serve loop. Mirrors the workflow-worker bin split.
  if (process.argv[2] === "incidents") {
    return runIncidentsCommand(process.argv.slice(3));
  }

  let options;
  try {
    options = parseServeArgs(process.argv.slice(2));
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
