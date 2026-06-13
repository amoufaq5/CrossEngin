#!/usr/bin/env node

import { createNodePgConnection, parsePgEnvConfig } from "@crossengin/kernel-pg";

import { PostgresReplicationConflictStore } from "../src/conflict-store.js";
import { PostgresReplicationEventStore } from "../src/event-store.js";
import type { ReplicationConflictRecord, ReplicationEventRecord } from "../src/records.js";
import { CliUsageError, parseReplicationArgs, runReplicationQuery, type ReplicationQuerySource } from "../src/query.js";

const EPOCH = new Date(0);

function printHelp(): void {
  process.stdout.write(
    [
      "Usage: crossengin-replication <command> [flags]",
      "",
      "Commands:",
      "  replication events     List replication events (--key, --since, --limit)",
      "  replication conflicts  List concurrent-write resolutions (--key, --limit)",
      "  replication verify     Cross-table drift sweep; exits 1 on drift (--since, --limit)",
      "",
      "Flags: --key <recordKey>  --since <iso>  --limit <n>  --format human|json",
      "Postgres connection comes from the standard PG* env vars.",
      "",
    ].join("\n"),
  );
}

/** Adapts the two stores to the framework-neutral `ReplicationQuerySource`. */
function storeSource(
  eventStore: PostgresReplicationEventStore,
  conflictStore: PostgresReplicationConflictStore,
): ReplicationQuerySource {
  return {
    async listEvents(opts): Promise<readonly ReplicationEventRecord[]> {
      const limitOpt = opts.limit !== undefined ? { limit: opts.limit } : {};
      if (opts.key !== undefined) return eventStore.listForKey(opts.key, limitOpt);
      return eventStore.listSince(opts.since ?? EPOCH, limitOpt);
    },
    async listConflicts(opts): Promise<readonly ReplicationConflictRecord[]> {
      const limitOpt = opts.limit !== undefined ? { limit: opts.limit } : {};
      if (opts.key !== undefined) return conflictStore.listForKey(opts.key, limitOpt);
      return conflictStore.listRecent(limitOpt);
    },
  };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv[0] === "--help" || argv[0] === "-h" || argv.length === 0) {
    printHelp();
    return 0;
  }
  // Accept both `crossengin-replication events …` and `… replication events …`.
  const tail = argv[0] === "replication" ? argv.slice(1) : argv;
  let options;
  try {
    options = parseReplicationArgs(tail);
  } catch (err) {
    if (err instanceof CliUsageError) {
      process.stderr.write(`${err.message}\n`);
      printHelp();
      return 2;
    }
    throw err;
  }

  const conn = createNodePgConnection(parsePgEnvConfig());
  try {
    const source = storeSource(new PostgresReplicationEventStore(conn), new PostgresReplicationConflictStore(conn));
    const { exitCode } = await runReplicationQuery(options, source, (line) => process.stdout.write(`${line}\n`));
    return exitCode;
  } finally {
    await conn.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`crossengin-replication: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
