import { readFile } from "node:fs/promises";

import { z } from "zod";
import type { ChainCheckpoint } from "@crossengin/forensics";
import {
  PostgresChainCheckpointStore,
  PostgresChainLogStore,
  type ChainSigner,
} from "@crossengin/forensics-pg";
import type { PgConnection } from "@crossengin/kernel-pg";

import type { IntervalHandle, IntervalScheduler } from "./jwks.js";

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;

export const CheckpointConfigSchema = z
  .object({
    schema: z.string().regex(SCHEMA_RE).default("meta"),
    intervalMs: z.number().int().positive().default(3_600_000),
    checkpointedBy: z.string().min(1).default("operate-server"),
    tenants: z.array(z.string().uuid()).default([]),
    includePlatform: z.boolean().default(false),
  })
  .strict();
export type CheckpointConfig = z.infer<typeof CheckpointConfigSchema>;

export function parseCheckpointConfig(json: unknown): CheckpointConfig {
  return CheckpointConfigSchema.parse(json);
}

export async function loadCheckpointConfig(path: string): Promise<CheckpointConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new Error(`--checkpoint-config: cannot read ${path}: ${errMessage(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`--checkpoint-config: invalid JSON in ${path}: ${errMessage(err)}`);
  }
  return parseCheckpointConfig(parsed);
}

const DEFAULT_SCHEDULER: IntervalScheduler = {
  setInterval(handler, ms) {
    const h = setInterval(handler, ms);
    (h as { unref?: () => void }).unref?.(); // don't keep the process alive
    return h;
  },
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

/** What one scope resolved to on a pass (for metrics / logging / tests). */
export interface CheckpointPassResult {
  /** The tenant id, or `null` for the platform chain. */
  readonly scope: string | null;
  readonly outcome: "recorded" | "skipped_empty" | "error";
  readonly checkpoint?: ChainCheckpoint;
  readonly error?: unknown;
}

/** Resolves the scopes to checkpoint on a pass — a fixed list, or a live tenant source. */
export type CheckpointScopeSource = () =>
  | Promise<readonly (string | null)[]>
  | readonly (string | null)[];

export interface CheckpointSchedulerOptions {
  readonly logStore: PostgresChainLogStore;
  readonly checkpointStore: PostgresChainCheckpointStore;
  readonly scopes: CheckpointScopeSource;
  readonly intervalMs: number;
  readonly checkpointedBy: string;
  readonly now?: () => Date;
  readonly scheduler?: IntervalScheduler;
  /** Run one pass immediately on start (default true; a re-`record` of an existing checkpoint is a no-op). */
  readonly runOnStart?: boolean;
  readonly onCheckpoint?: (scope: string | null, checkpoint: ChainCheckpoint) => void;
  readonly onError?: (err: unknown) => void;
}

/**
 * Periodically creates + persists a forensic-chain checkpoint per scope, so verifying a long audit chain
 * stays bounded — a verifier folds only the suffix after the latest checkpoint instead of from genesis.
 *
 * Each pass resolves the scope list (config tenants, or an injected live tenant source), reads each
 * scope's chain tail, and — for a non-empty chain — builds a `ChainCheckpoint` at the tail and records
 * it. A scope with an empty chain is skipped (nothing to anchor), never surfaced as an error. A per-scope
 * failure is routed to `onError` and the pass continues, so one scope never blocks the rest. Mirrors
 * `JobScheduler` / `JwksRefreshPoller`: the timer is `unref`'d so it never holds the process open, and
 * `start()` fires an immediate pass before the interval.
 */
export class CheckpointScheduler {
  private handle: IntervalHandle | null = null;

  constructor(private readonly opts: CheckpointSchedulerOptions) {}

  start(): void {
    if (this.handle !== null) return;
    if (this.opts.runOnStart !== false) void this.runOnce();
    this.handle = this.scheduler().setInterval(() => void this.runOnce(), this.opts.intervalMs);
  }

  stop(): void {
    if (this.handle === null) return;
    this.scheduler().clearInterval(this.handle);
    this.handle = null;
  }

  /** One checkpoint pass over every scope. Never rejects — a per-scope error is captured + routed. */
  async runOnce(): Promise<readonly CheckpointPassResult[]> {
    const results: CheckpointPassResult[] = [];
    let scopes: readonly (string | null)[];
    try {
      scopes = await this.opts.scopes();
    } catch (err) {
      this.opts.onError?.(err);
      return results;
    }
    const checkpointedAt = (this.opts.now ?? (() => new Date()))().toISOString();
    for (const scope of scopes) {
      try {
        const tail = await this.opts.logStore.tail(scope);
        if (tail === null) {
          results.push({ scope, outcome: "skipped_empty" });
          continue;
        }
        const checkpoint = await this.opts.logStore.createCheckpoint(scope, {
          checkpointedBy: this.opts.checkpointedBy,
          checkpointedAt,
        });
        await this.opts.checkpointStore.record(scope, checkpoint);
        this.opts.onCheckpoint?.(scope, checkpoint);
        results.push({ scope, outcome: "recorded", checkpoint });
      } catch (err) {
        this.opts.onError?.(err);
        results.push({ scope, outcome: "error", error: err });
      }
    }
    return results;
  }

  private scheduler(): IntervalScheduler {
    return this.opts.scheduler ?? DEFAULT_SCHEDULER;
  }
}

export interface CheckpointLifecycleOptions {
  /** Signs nothing on the checkpoint path (checkpoints only read the tail), but the log store requires one. */
  readonly signer: ChainSigner;
  readonly scheduler?: IntervalScheduler;
  /** Overrides the config's static tenant list with a live source when present (may include `null`). */
  readonly tenants?: CheckpointScopeSource;
  readonly runOnStart?: boolean;
  readonly onCheckpoint?: (scope: string | null, checkpoint: ChainCheckpoint) => void;
  readonly onError?: (err: unknown) => void;
  readonly now?: () => Date;
}

export interface CheckpointLifecycle {
  readonly scheduler: CheckpointScheduler;
  runOnce(): Promise<readonly CheckpointPassResult[]>;
}

/** The scopes derived from a static config: its tenant ids, plus the platform chain when opted in. */
export function configScopes(config: CheckpointConfig): readonly (string | null)[] {
  const scopes: (string | null)[] = [...config.tenants];
  if (config.includePlatform) scopes.push(null);
  return scopes;
}

/**
 * Wires a `CheckpointScheduler` over a live connection: builds the `PostgresChainLogStore` (reader — the
 * signer is required by its constructor but the checkpoint path never signs) + `PostgresChainCheckpointStore`
 * from `conn` at the config's schema, and resolves the scope list from the injected tenant source when given,
 * else the config's `tenants` (+ the platform chain when `includePlatform`).
 */
export function buildCheckpointLifecycle(
  conn: PgConnection,
  config: CheckpointConfig,
  opts: CheckpointLifecycleOptions,
): CheckpointLifecycle {
  const logStore = new PostgresChainLogStore(conn, opts.signer, { schema: config.schema });
  const checkpointStore = new PostgresChainCheckpointStore(conn, { schema: config.schema });
  const scopes: CheckpointScopeSource = opts.tenants ?? (() => configScopes(config));

  const scheduler = new CheckpointScheduler({
    logStore,
    checkpointStore,
    scopes,
    intervalMs: config.intervalMs,
    checkpointedBy: config.checkpointedBy,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.scheduler !== undefined ? { scheduler: opts.scheduler } : {}),
    ...(opts.runOnStart !== undefined ? { runOnStart: opts.runOnStart } : {}),
    ...(opts.onCheckpoint !== undefined ? { onCheckpoint: opts.onCheckpoint } : {}),
    ...(opts.onError !== undefined ? { onError: opts.onError } : {}),
  });

  return { scheduler, runOnce: () => scheduler.runOnce() };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
