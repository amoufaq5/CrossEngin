import {
  CliUsageError as PackageCliUsageError,
  parseSloArgs as packageParseSloArgs,
  type SloCliOptions,
} from "@crossengin/observability-runtime-pg";

import { CliUsageError } from "./cli.js";

export type { OutputFormat, SloCliOptions, SloCommand } from "@crossengin/observability-runtime-pg";
export {
  formatSloActions,
  formatSloSummary,
  formatSloVerify,
  runSloQuery,
  type RunSloResult,
  type SloQuerySource,
} from "@crossengin/observability-runtime-pg";

/**
 * Parses `operate-server slo <actions|summary|verify> [options]` argv (the slice
 * after the `slo` verb), delegating to `@crossengin/observability-runtime-pg`'s
 * framework-neutral `parseSloArgs` and re-wrapping its `CliUsageError` as the
 * operate-server `CliUsageError` so the bin's existing exit-code mapping (catch
 * `CliUsageError` → print help + exit 2) covers it uniformly with the serve +
 * incidents parsers. `actions`/`summary` read recent enforcement actions;
 * `verify` runs the drift sweep and exits 1 on any drift. `--since` /
 * `--limit` / `--format human|json`. Mirrors `incidents-cli.ts` so an operator
 * queries the same SLO enforcement tables — populated by operate-server's own
 * `--slo-persist` loop — from the serving binary, without the standalone
 * `crossengin-slo` tool.
 */
export function parseSloArgs(argv: readonly string[]): SloCliOptions {
  try {
    return packageParseSloArgs(argv);
  } catch (err) {
    if (err instanceof PackageCliUsageError) throw new CliUsageError(err.message);
    throw err;
  }
}

export const sloHelpText = `operate-server slo — query the SLO enforcement audit tables

Usage:
  operate-server slo actions  [--since <iso>] [--limit N] [--format human|json]
  operate-server slo summary  [--since <iso>] [--limit N] [--format human|json]
  operate-server slo verify   [--since <iso>] [--limit N] [--format human|json]

Commands:
  actions   List recent SLO enforcement actions (availability + latency signals)
  summary   Roll the actions up (total/opened/ongoing/recovered/paged)
  verify    Run the enforcement-history drift sweep; exits 1 if any drift

Options:
  --since <iso>    Only consider actions at/after this ISO timestamp (else recent)
  --limit <n>      Max actions to read (default 1000 with --since, else 100)
  --format <f>     human (default) | json
  --help, -h       Show this help

These tables (meta.slo_enforcement_actions) are populated by the serving SLO
loop under \`--slo --slo-persist\`. Postgres: standard PG* env vars (PGHOST,
PGDATABASE, ...).
`;
