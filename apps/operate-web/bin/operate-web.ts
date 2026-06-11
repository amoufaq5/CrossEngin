#!/usr/bin/env node

import { CliUsageError, helpText, parseWebArgs } from "../src/cli.js";
import { parseWebClientArgs, webClientHelpText } from "../src/web-client-cli.js";
import { executeWebClient, serve } from "../src/node.js";

const CLI_VERSION = "0.0.0";

async function runWebClientCommand(argv: readonly string[]): Promise<number> {
  let options;
  try {
    options = parseWebClientArgs(argv);
  } catch (err) {
    if (err instanceof CliUsageError) {
      process.stderr.write(`error: ${err.message}\n\n${webClientHelpText}`);
      return 2;
    }
    throw err;
  }
  if (options.help) {
    process.stdout.write(webClientHelpText);
    return 0;
  }
  return executeWebClient(options);
}

async function main(): Promise<number> {
  if (process.argv[2] === "web-client") {
    return runWebClientCommand(process.argv.slice(3));
  }
  let options;
  try {
    options = parseWebArgs(process.argv.slice(2));
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
    `operate-web listening on http://localhost:${running.port.toString()} (${source})\n`,
  );

  const shutdown = (): void => {
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
