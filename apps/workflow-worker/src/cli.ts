export type WorkerMode = "tick" | "claim" | "retry" | "all";

const MODES: ReadonlySet<string> = new Set(["tick", "claim", "retry", "all"]);

export interface WorkerCliOptions {
  readonly mode: WorkerMode;
  readonly workerId: string;
  readonly schema: string | null;
  readonly tickIntervalMs: number;
  readonly claimIntervalMs: number;
  readonly retryIntervalMs: number;
  readonly batchSize: number;
  readonly leaseMs: number;
  readonly definitionsPath: string | null;
  readonly help: boolean;
  readonly version: boolean;
}

export class CliUsageError extends Error {}

function takeValue(arg: string, next: string | undefined, flag: string): string {
  if (arg.includes("=")) return arg.slice(arg.indexOf("=") + 1);
  if (next === undefined) throw new CliUsageError(`flag ${flag} requires a value`);
  return next;
}

function isInline(arg: string): boolean {
  return arg.includes("=");
}

function intFlag(raw: string, flag: string, min: number): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new CliUsageError(`invalid ${flag}: ${raw} (integer >= ${min.toString()})`);
  return n;
}

const DEFAULTS = {
  mode: "all" as WorkerMode,
  tickIntervalMs: 5_000,
  claimIntervalMs: 1_000,
  retryIntervalMs: 5_000,
  batchSize: 50,
  leaseMs: 30_000,
};

/**
 * Parses `workflow-worker` argv. `--mode` selects which workers run: `tick`
 * (advisory-lock bulk timer), `claim` (parallel per-unit timer claim), `retry`
 * (activity retry executor), or `all` (claim + retry — the parallel production
 * combo). A random `--worker-id` is generated when omitted.
 */
export function parseWorkerArgs(argv: readonly string[]): WorkerCliOptions {
  let mode: WorkerMode = DEFAULTS.mode;
  let workerId = "";
  let schema: string | null = null;
  let tickIntervalMs = DEFAULTS.tickIntervalMs;
  let claimIntervalMs = DEFAULTS.claimIntervalMs;
  let retryIntervalMs = DEFAULTS.retryIntervalMs;
  let batchSize = DEFAULTS.batchSize;
  let leaseMs = DEFAULTS.leaseMs;
  let definitionsPath: string | null = null;
  let help = false;
  let version = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    const next = argv[i + 1];
    const consumed = (): number => (isInline(arg) ? 0 : 1);
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--version" || arg === "-v") {
      version = true;
    } else if (arg === "--mode" || arg.startsWith("--mode=")) {
      const raw = takeValue(arg, next, "--mode");
      if (!MODES.has(raw)) throw new CliUsageError(`invalid --mode: ${raw} (tick|claim|retry|all)`);
      mode = raw as WorkerMode;
      i += consumed();
    } else if (arg === "--worker-id" || arg.startsWith("--worker-id=")) {
      workerId = takeValue(arg, next, "--worker-id");
      i += consumed();
    } else if (arg === "--schema" || arg.startsWith("--schema=")) {
      schema = takeValue(arg, next, "--schema");
      i += consumed();
    } else if (arg === "--tick-interval-ms" || arg.startsWith("--tick-interval-ms=")) {
      tickIntervalMs = intFlag(takeValue(arg, next, "--tick-interval-ms"), "--tick-interval-ms", 100);
      i += consumed();
    } else if (arg === "--claim-interval-ms" || arg.startsWith("--claim-interval-ms=")) {
      claimIntervalMs = intFlag(takeValue(arg, next, "--claim-interval-ms"), "--claim-interval-ms", 100);
      i += consumed();
    } else if (arg === "--retry-interval-ms" || arg.startsWith("--retry-interval-ms=")) {
      retryIntervalMs = intFlag(takeValue(arg, next, "--retry-interval-ms"), "--retry-interval-ms", 100);
      i += consumed();
    } else if (arg === "--batch-size" || arg.startsWith("--batch-size=")) {
      batchSize = intFlag(takeValue(arg, next, "--batch-size"), "--batch-size", 1);
      i += consumed();
    } else if (arg === "--lease-ms" || arg.startsWith("--lease-ms=")) {
      leaseMs = intFlag(takeValue(arg, next, "--lease-ms"), "--lease-ms", 1000);
      i += consumed();
    } else if (arg === "--definitions" || arg.startsWith("--definitions=")) {
      definitionsPath = takeValue(arg, next, "--definitions");
      i += consumed();
    } else {
      throw new CliUsageError(`unknown argument: ${arg}`);
    }
  }

  return {
    mode,
    workerId: workerId.length > 0 ? workerId : `worker-${Math.random().toString(36).slice(2, 12)}`,
    schema,
    tickIntervalMs,
    claimIntervalMs,
    retryIntervalMs,
    batchSize,
    leaseMs,
    definitionsPath,
    help,
    version,
  };
}

export const helpText = `workflow-worker — run the CrossEngin workflow runtime as a distributed worker

Usage:
  workflow-worker [--mode all|claim|retry|tick] [options]

Options:
  --mode <m>               tick (advisory-lock bulk timer) | claim (parallel
                           per-unit timer claim) | retry (activity retry) | all
                           (claim + retry) (default all)
  --worker-id <id>         Lease owner id (default a random id)
  --schema <name>          Postgres schema for the workflow tables (default meta)
  --tick-interval-ms <n>   Bulk-tick poll interval (default 5000)
  --claim-interval-ms <n>  Timer-claim poll interval (default 1000)
  --retry-interval-ms <n>  Activity-retry poll interval (default 5000)
  --batch-size <n>         Claim batch size (default 50)
  --lease-ms <n>           Claim lease duration (default 30000)
  --definitions <file>     JSON array of WorkflowDefinitions to run (default none)
  --help, -h               Show this help
  --version, -v            Print version

Postgres: standard PG* env vars (PGHOST, PGDATABASE, ...). The worker should
connect with a role that can see all tenants' workflow rows (BYPASSRLS).
`;
