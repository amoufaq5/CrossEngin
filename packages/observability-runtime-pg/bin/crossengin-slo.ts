#!/usr/bin/env node

import { createNodePgConnection, parsePgEnvConfig } from "@crossengin/kernel-pg";

import { PostgresSloEnforcementActionStore } from "../src/enforcement-action-store.js";
import { PostgresSloLatencyEvaluationStore } from "../src/latency-evaluation-store.js";
import {
  verifyEnforcementHistory,
  type DriftIssue,
} from "../src/replayer.js";
import type {
  SloEnforcementActionRecord,
  SloLatencyEvaluationRecord,
} from "../src/records.js";
import {
  CliUsageError,
  parseSloArgs,
  runSloQuery,
  type SloQuerySource,
} from "../src/query.js";

const CLI_VERSION = "0.0.0";

function printHelp(): void {
  process.stdout.write(
    [
      "Usage: crossengin-slo <command> [flags]",
      "",
      "Commands:",
      "  slo actions    List recent SLO enforcement actions",
      "  slo summary    Roll up enforcement decisions (opened/ongoing/recovered/paged)",
      "  slo verify     Verify enforcement history; exit 1 on drift",
      "  slo latency    List recent SLO latency evaluations",
      "  version        Print the CLI version",
      "  help           Show this help text",
      "",
      "Flags (slo):",
      "  --since <iso>        Only consider rows at/after this timestamp",
      "  --limit <n>          Cap the number of rows read (default 1000)",
      "  --format human|json  Output format (default human)",
      "",
      "Environment:",
      "  PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE, PGSSLMODE, PGAPPNAME",
      "",
    ].join("\n"),
  );
}

class StoreSloQuerySource implements SloQuerySource {
  private readonly store: PostgresSloEnforcementActionStore;
  private readonly latencyStore: PostgresSloLatencyEvaluationStore;

  constructor(
    store: PostgresSloEnforcementActionStore,
    latencyStore: PostgresSloLatencyEvaluationStore,
  ) {
    this.store = store;
    this.latencyStore = latencyStore;
  }

  private async load(opts: {
    readonly since?: Date;
    readonly limit?: number;
  }): Promise<readonly SloEnforcementActionRecord[]> {
    if (opts.since !== undefined) {
      return this.store.listSince(opts.since, opts.limit ?? 1000);
    }
    return this.store.listRecent(opts.limit ?? 100);
  }

  async listActions(opts: {
    readonly since?: Date;
    readonly limit?: number;
  }): Promise<readonly SloEnforcementActionRecord[]> {
    return this.load(opts);
  }

  async verifyActions(opts: {
    readonly since?: Date;
    readonly limit?: number;
  }): Promise<readonly DriftIssue[]> {
    const actions = await this.load(opts);
    return verifyEnforcementHistory(actions);
  }

  async listLatencyEvaluations(opts: {
    readonly since?: Date;
    readonly limit?: number;
  }): Promise<readonly SloLatencyEvaluationRecord[]> {
    const since = opts.since ?? new Date(0);
    return this.latencyStore.listSince(since, opts.limit ?? 1000);
  }
}

async function runSlo(argv: readonly string[]): Promise<number> {
  const options = parseSloArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }
  const conn = createNodePgConnection(parsePgEnvConfig());
  try {
    const store = new PostgresSloEnforcementActionStore(conn);
    const latencyStore = new PostgresSloLatencyEvaluationStore(conn);
    const source = new StoreSloQuerySource(store, latencyStore);
    const result = await runSloQuery(options, source, (line) => {
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
  if (word === undefined || word === "help") {
    printHelp();
    process.exit(0);
  }
  if (word === "version") {
    process.stdout.write(`crossengin-slo ${CLI_VERSION}\n`);
    process.exit(0);
  }
  if (word === "slo") {
    const exitCode = await runSlo(argv.slice(1));
    process.exit(exitCode);
  }
  process.stderr.write(`unknown command '${word}' (expected slo|version|help)\n`);
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
