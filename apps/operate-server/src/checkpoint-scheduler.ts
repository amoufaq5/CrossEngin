import { readFile } from "node:fs/promises";

import { z } from "zod";
import type { PostgresKeyRegistry } from "@crossengin/crypto-pg";
import type { ChainCheckpoint, CheckpointProvenance } from "@crossengin/forensics";
import {
  PostgresChainCheckpointStore,
  PostgresChainLogStore,
  checkpointFromTail,
  type ChainSigner,
} from "@crossengin/forensics-pg";
import type { PgConnection } from "@crossengin/kernel-pg";

import {
  anchoringWouldBury,
  verifyChainFromCheckpoint,
  type ChainVerificationReport,
} from "./chain-verify.js";
import type { IntervalHandle, IntervalScheduler } from "./jwks.js";

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;

export const CheckpointConfigSchema = z
  .object({
    schema: z.string().regex(SCHEMA_RE).default("meta"),
    intervalMs: z.number().int().positive().default(3_600_000),
    checkpointedBy: z.string().min(1).default("operate-server"),
    tenants: z.array(z.string().uuid()).default([]),
    /**
     * Also checkpoint the platform chain.
     *
     * **Defaults to `true` as of ADR-0332**, and it is flipped in the same change as
     * `--integrity-proof-config`'s because the two are one decision: the proof's truncation check
     * has no witness without a checkpoint (ADR-0287), so proving a scope nobody checkpoints leaves
     * that half silently unwitnessed. The platform chain holds only escalation rows, so the extra
     * checkpoint is cheap.
     */
    includePlatform: z.boolean().default(true),
    /** Checkpoint every active tenant from the live tenant registry instead of the static `tenants` list. */
    allTenants: z.boolean().default(false),
    /** With `allTenants`, which tenant statuses to include (passed to the live source; default `['active']`). */
    tenantStatuses: z.array(z.string().min(1)).nonempty().optional(),
  })
  .strict();
export type CheckpointConfig = z.infer<typeof CheckpointConfigSchema>;

/** The live-tenant-registry seam the scheduler reads when `allTenants` is on (satisfied by `PostgresTenantSource`). */
export interface ActiveTenantSource {
  activeTenantIds(): Promise<readonly string[]> | readonly string[];
}

/**
 * Adapts a live `ActiveTenantSource` into a `CheckpointScopeSource`: every active tenant becomes a scope,
 * plus the platform (`null`) chain when `includePlatform`. Re-queried each pass, so a newly-provisioned or
 * newly-suspended tenant is picked up on the next tick.
 */
export function tenantSourceScopes(
  source: ActiveTenantSource,
  opts: { readonly includePlatform?: boolean } = {},
): CheckpointScopeSource {
  return async () => {
    const ids = await source.activeTenantIds();
    const scopes: (string | null)[] = [...ids];
    if (opts.includePlatform === true) scopes.push(null);
    return scopes;
  };
}

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

/**
 * What one scope can resolve to on a pass.
 *
 * An `as const` array with the type derived from it rather than an inline union, for the reason
 * every closed vocabulary in this repo is one: a bare union cannot be enumerated at runtime, so
 * nothing can assert what its members are and a sixth can land unnoticed. The derived type is
 * structurally the union it replaces, so no consumer changes.
 */
export const CHECKPOINT_PASS_OUTCOMES = [
  "recorded",
  "skipped_empty",
  "refused_unverified",
  "refused_anchor_would_bury",
  "error",
] as const;
export type CheckpointPassOutcome = (typeof CHECKPOINT_PASS_OUTCOMES)[number];

/** What one scope resolved to on a pass (for metrics / logging / tests). */
export interface CheckpointPassResult {
  /** The tenant id, or `null` for the platform chain. */
  readonly scope: string | null;
  /**
   * `refused_unverified` is a **verdict** and deliberately not an `error`: the chain was read and
   * did not verify, so `verification` names what failed. An `error` is a verification that could
   * not be performed at all, which says nothing about the chain. Both withhold the anchor — the
   * difference is what an operator is told, and only one of the two is a finding.
   *
   * `refused_anchor_would_bury` is the fifth and is deliberately **not** that one, because its
   * premise is the opposite of it: the chain **verified**, and the finding is the *stored anchor*,
   * which `anchoringWouldBury` adjudicates over the report's `fullBecause`. Reporting a sound chain
   * as `refused_unverified` would tell an operator "this chain did not verify" about a chain that
   * did — the same conflation the refusal/error split above exists to prevent, one case across, and
   * it would send them to look for a tamper in the entries rather than at the checkpoint row that
   * is the whole finding. It carries `verification` for `refused_unverified`'s reason: the refusal
   * leaves no row behind, so the report is the only thing that can say why.
   */
  readonly outcome: CheckpointPassOutcome;
  readonly checkpoint?: ChainCheckpoint;
  /** Present iff a verification ran: absent for `skipped_empty`, and for a throw. */
  readonly verification?: ChainVerificationReport;
  readonly error?: unknown;
}

/**
 * The provenance an anchor earns from the verification that cleared it. **Derived, never supplied**:
 * a caller able to choose it could assert a verification that never ran, which is the one claim
 * `checkpointAnchorsBoundedProof` exists to adjudicate.
 *
 * A total map over the report's own mode, so a third verification mode is a compile error here
 * rather than a mode inheriting whichever answer an `if`-chain happened to end on.
 */
const PROVENANCE_FOR_VERIFICATION_MODE: Record<
  ChainVerificationReport["mode"],
  CheckpointProvenance
> = {
  full: "verified_full",
  from_checkpoint: "verified_suffix",
};

/** Resolves the scopes to checkpoint on a pass — a fixed list, or a live tenant source. */
export type CheckpointScopeSource = () =>
  | Promise<readonly (string | null)[]>
  | readonly (string | null)[];

export interface CheckpointSchedulerOptions {
  readonly logStore: PostgresChainLogStore;
  readonly checkpointStore: PostgresChainCheckpointStore;
  /**
   * Verifies the scope's chain; the pass anchors only when it answers `ok`.
   *
   * **Required.** An optional verifier defaulting to "do not verify" would be this scheduler's own
   * defect restated as a default — the anchor every bounded proof takes its prefix on trust from
   * would again be one that nothing checked, for every caller that omitted the argument.
   */
  readonly verify: (scope: string | null) => Promise<ChainVerificationReport>;
  readonly scopes: CheckpointScopeSource;
  readonly intervalMs: number;
  readonly checkpointedBy: string;
  readonly now?: () => Date;
  readonly scheduler?: IntervalScheduler;
  /** Run one pass immediately on start (default true; a re-`record` of an existing checkpoint is a no-op). */
  readonly runOnStart?: boolean;
  readonly onCheckpoint?: (scope: string | null, checkpoint: ChainCheckpoint) => void;
  /**
   * A scope that was not anchored: either its chain did not verify, or its chain verified and the
   * stored anchor is one a fresh checkpoint would bury (`refused_anchor_would_bury`). Either way no
   * anchor was written and the pass carried on, and `verification` is what says which.
   *
   * **Required**, unlike the other two callbacks, because a refusal is the only outcome here that
   * leaves nothing in the database. An anchor that is written is its own record and a throw is a
   * condition the next pass meets again, while a refused verification writes no row at all — see
   * `CHAIN_FULL_REASONS`' note on why writing one would be worse — so an optional handler would let
   * a deployment discover that its chain stopped verifying by never being told.
   *
   * That argument is **stronger** for the second cause and not weaker: the burying refusal recurs on
   * every pass for as long as the row stands, and this is the only surface that says so — the
   * integrity proof's own `anchorRowsRefused` names the row, but nothing there knows that the
   * scheduler has stopped anchoring the scope.
   */
  readonly onRefused: (scope: string | null, verification: ChainVerificationReport) => void;
  readonly onError?: (err: unknown) => void;
}

/**
 * Periodically **verifies** each scope's forensic chain and anchors a checkpoint at its tail, so
 * re-verifying a long audit chain stays bounded — a verifier folds only the suffix after the latest
 * checkpoint instead of from genesis.
 *
 * Each pass resolves the scope list (config tenants, or an injected live tenant source) and, per
 * scope, resolves the chain tail, verifies the chain, and records a `ChainCheckpoint` at that tail
 * **only when the verification answers `ok`** — carrying the provenance that verification earned,
 * derived from its own mode.
 *
 * Verifying is this scheduler's job and not the integrity proof's, because a checkpoint is precisely
 * what a bounded verify takes on trust: `verifyChainFromCheckpoint` folds the suffix after the anchor
 * and never re-folds the prefix. So the trust has to be established by whatever places the anchor, at
 * the moment it places it. A pass that anchored first and left checking to the proof would be
 * licensing every later bounded verify to believe a prefix nothing had looked at — and the proof
 * scheduler is a separate, opt-in process, so an anchor whose soundness depended on it would be
 * unsound on every deployment not running it.
 *
 * A scope with an empty chain is skipped — nothing to verify, nothing to anchor — and never surfaced
 * as an error. A scope is refused and routed to `onRefused` for either of **two** reasons: its chain
 * failed verification (`refused_unverified`), or its chain verified and the anchor already on disk
 * is one that writing a fresh checkpoint would bury (`refused_anchor_would_bury`, adjudicated by
 * `anchoringWouldBury`). A throw is routed to `onError`. All three let the pass continue, so one
 * scope never blocks the rest. Mirrors `JobScheduler` / `JwksRefreshPoller`: the timer is `unref`'d
 * so it never holds the process open, and `start()` fires an immediate pass before the interval.
 */
export class CheckpointScheduler {
  private handle: IntervalHandle | null = null;
  private inFlight = false;

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

  /**
   * One checkpoint pass over every scope. Never rejects — a per-scope error is captured + routed.
   *
   * A pass already in flight makes this a no-op returning `[]`, because a full fold is unbounded in
   * the chain's length — the measured cost is ~152 microseconds of signature CPU per entry, so a
   * scope that has to fold from genesis can outlast an hourly interval at a few hundred thousand
   * entries and the timer would then stack passes on exactly the deployment least able to afford
   * them. Overlapping passes are not unsafe (a re-`record` at the same sequence is a no-op), so
   * this bounds cost and not correctness, and `[]` is honest: this call performed no pass.
   */
  async runOnce(): Promise<readonly CheckpointPassResult[]> {
    const results: CheckpointPassResult[] = [];
    if (this.inFlight) return results;
    this.inFlight = true;
    try {
      return await this.pass(results);
    } finally {
      this.inFlight = false;
    }
  }

  private async pass(results: CheckpointPassResult[]): Promise<readonly CheckpointPassResult[]> {
    let scopes: readonly (string | null)[];
    try {
      scopes = await this.opts.scopes();
    } catch (err) {
      this.opts.onError?.(err);
      return results;
    }
    for (const scope of scopes) {
      let recorded: { checkpoint: ChainCheckpoint; verification: ChainVerificationReport } | null =
        null;
      try {
        // The tail is resolved BEFORE verifying because it is the sequence the anchor will claim,
        // and everything at or below it is provably inside what the verification then loaded. The
        // alternative — let `createCheckpoint` find a tail afterwards — anchors at a *later*
        // sequence, so entries appended during the verification are stamped verified by a fold that
        // never saw them and are skipped by every bounded pass after it: ADR-0371's own defect,
        // narrowed to one band per pass and reopened on every pass. Writers into that window are
        // continuous on a serving deployment (every audited request anchors a row, ADR-0286), and
        // on the first post-upgrade pass the window is the whole full fold.
        //
        // Anchoring at the pre-verify tail is conservative in the only direction that is safe: a
        // row appended in the window is simply not covered yet, and the next pass covers it.
        const tail = await this.opts.logStore.tail(scope);
        if (tail === null) {
          // An empty chain is a skip and not an error: `verifyChainFull` over zero entries is
          // vacuously `ok`, so verifying first would anchor nothing and report a failure instead.
          results.push({ scope, outcome: "skipped_empty" });
          continue;
        }
        const verification = await this.opts.verify(scope);
        if (!verification.ok) {
          this.opts.onRefused(scope, verification);
          results.push({ scope, outcome: "refused_unverified", verification });
          continue;
        }
        // Ordered AFTER `!verification.ok` and before any anchor is built. A verification that both
        // failed and carries a burying reason is reported as the failure, because "this chain did
        // not verify" is the stronger and more urgent statement and the anchor refusal is implied
        // by it — nothing is written on either path.
        //
        // The chain verified here, and the finding is the anchor already on disk. Anchoring would
        // write a **readable** checkpoint at the tail, which `latest()` then returns because it
        // orders by `sequence_number DESC` — so the refused row sits below it and
        // `IntegrityProofReport.anchorRowsRefused` goes back to empty. Measured live before and
        // after one pass: `compromised` with `[onPass, onFinding, escalate]`, then `verified` with
        // `[onPass, escalate]`, the refused row still on disk (ADR-0374). The scheduler would be
        // erasing the alarm, and no callback would fire at all. The bound is exact rather than a
        // narrow race: the finding survives only while the tail is at or below the refused anchor's
        // sequence, where `ON CONFLICT … DO NOTHING` fires, and is buried the moment the chain gains
        // one entry — which on a serving deployment is every audited request (ADR-0286).
        //
        // The cost is stated because it is the deliberate price: this scope folds from genesis on
        // every pass until the row is corrected, at a measured ~152 microseconds of Ed25519 verify
        // per entry (ADR-0371), so 15.2 s of signature CPU per pass at 100k entries. It is the right
        // price because the alternative silences the one detector there is for that row, and it is
        // self-healing in the correct direction: once an operator corrects or removes the row,
        // `latest()` reads again, the next pass anchors normally, and the cost disappears.
        //
        // It also makes `node.ts`'s start order **irrelevant** rather than merely safe. Today the
        // checkpoint lifecycle starts before the integrity proof, both `runOnStart` and both hourly
        // by default, so the burial happened milliseconds before the proof looked — but ADR-0371
        // refused to let soundness depend on a start order in a third file, and a scheduler that
        // cannot bury the finding cannot bury it in any order.
        if (anchoringWouldBury(verification.fullBecause)) {
          this.opts.onRefused(scope, verification);
          results.push({ scope, outcome: "refused_anchor_would_bury", verification });
          continue;
        }
        const checkpoint = checkpointFromTail(tail, {
          checkpointedBy: this.opts.checkpointedBy,
          // Resolved per scope rather than once per pass, so a long pass does not stamp its last
          // scope's anchor with the time its first scope was read.
          checkpointedAt: (this.opts.now ?? (() => new Date()))().toISOString(),
          provenance: PROVENANCE_FOR_VERIFICATION_MODE[verification.mode],
        });
        await this.opts.checkpointStore.record(scope, checkpoint);
        recorded = { checkpoint, verification };
      } catch (err) {
        this.opts.onError?.(err);
        results.push({ scope, outcome: "error", error: err });
        continue;
      }
      if (recorded === null) continue;
      // Outside the `try`: a throw from the caller's own callback is the caller's, and catching it
      // here would file a recorded anchor as an `error` — a result that says the opposite of what
      // happened to the database.
      this.opts.onCheckpoint?.(scope, recorded.checkpoint);
      results.push({
        scope,
        outcome: "recorded",
        checkpoint: recorded.checkpoint,
        verification: recorded.verification,
      });
    }
    return results;
  }

  private scheduler(): IntervalScheduler {
    return this.opts.scheduler ?? DEFAULT_SCHEDULER;
  }
}

export interface CheckpointLifecycleOptions {
  /** Signs nothing on the checkpoint path (this scheduler only reads), but the log store requires one. */
  readonly signer: ChainSigner;
  /**
   * Resolves each entry's signing fingerprint to its registered public key for the verification.
   *
   * The ingredient rather than the composed `verify` seam, mirroring `IntegrityProofLifecycleOptions`:
   * this function owns both stores, so composing the verifier here is what makes it impossible to
   * point the verification at a different chain store than the one being anchored — a caller
   * supplying its own seam would have to build a second pair at the same schema to have anything to
   * pass, and two spellings of one thing can disagree. The scheduler keeps the seam, which is where
   * a test wants it.
   */
  readonly registry: PostgresKeyRegistry;
  readonly scheduler?: IntervalScheduler;
  /** Overrides the config's static tenant list with a live source when present (may include `null`). */
  readonly tenants?: CheckpointScopeSource;
  readonly runOnStart?: boolean;
  readonly onCheckpoint?: (scope: string | null, checkpoint: ChainCheckpoint) => void;
  /** Required for `CheckpointSchedulerOptions.onRefused`'s reason: a refusal leaves no row behind. */
  readonly onRefused: (scope: string | null, verification: ChainVerificationReport) => void;
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
 * from `conn` at the config's schema, composes the verification over that same pair, and resolves the scope
 * list from the injected tenant source when given, else the config's `tenants` (+ the platform chain when
 * `includePlatform`).
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
    // `verifyChainFromCheckpoint` and not `verifyChainFull`, because it falls back to a full fold
    // whenever the latest checkpoint cannot anchor a bounded proof — there is none yet, or there is
    // one written before provenance existed. A chain that has only ever been anchored this way is
    // sound inductively: each anchor stands for a fold that covered everything up to it.
    //
    // A brand-new chain therefore pays exactly one fold from genesis and is bounded from then on.
    // An UPGRADED deployment heals the same way, but only once its chain gains an entry, and the
    // condition is worth knowing: the healing pass computes an anchor at the current tail, and
    // `record` is `ON CONFLICT (tenant_id, sequence_number) DO NOTHING` — deliberately, so a
    // provenance cannot be promoted in place — so a legacy provenance-less row sitting AT the tail
    // is not replaced and the next pass folds fully again. A serving tenant's chain grows on every
    // audited request, so it heals on the next pass; an idle chain re-folds until something appends
    // to it. `includePlatform` defaults to true and the platform chain holds only escalation rows,
    // which makes it the likely instance. That is a cost and not an unsoundness — a full fold is
    // the stronger check — and it is reported rather than worked around, because the alternatives
    // are a second anchor at one sequence or an `UPDATE` arm on a table ADR-0332 made
    // immutable-by-RLS, both of which are schema decisions of their own.
    verify: (scope) => verifyChainFromCheckpoint(logStore, opts.registry, checkpointStore, scope),
    scopes,
    intervalMs: config.intervalMs,
    checkpointedBy: config.checkpointedBy,
    onRefused: opts.onRefused,
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
