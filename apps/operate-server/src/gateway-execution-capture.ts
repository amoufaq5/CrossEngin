import { z } from "zod";
import type { PipelineExecution } from "@crossengin/api-gateway";
import type { PostgresPipelineExecutionStore } from "@crossengin/api-gateway-pg";

import { sampleValue } from "./audit-chain.js";

/**
 * Persisting `PipelineExecution` rows to `meta.gateway_pipeline_executions`, which is what makes
 * `GatewayReplayer` able to read anything at all.
 *
 * The replayer has existed since Phase 1 with `stages_out_of_order`, `pass_with_4xx_or_5xx`,
 * `terminating_not_last`, `rate_limit_decision_not_found` and six more drift codes, a bulk verifier
 * and a p50/p95 summary — over a table **no deployment has ever written a row into**, because
 * nothing in this binary constructed the store. ADR-0335 made `meta.rate_limit_decisions` writable,
 * so the orphan check now has one half of its join and not the other: every decision row exists and
 * no execution names it.
 *
 * ## Why this is off unless asked for, with the figure
 *
 * This is a database write on the request path of *every* request, which is the shape
 * `meta.feature_flag_evaluations` was refused a writer for (one row per request per flag, measured
 * at 124 TB/year). Measured here, for one row of this table:
 *
 * - the 17 `StageResult` objects serialise to **~3,950 bytes** of JSON (each ~232 B: stage name,
 *   outcome, two ISO instants, a duration, a reason, an empty `appliedHeaders`, two nulls);
 * - the 18 scalar columns are **~286 bytes** (two UUIDs, `req_`+32, three enums, a principal id, a
 *   correlation id, an `rld_` decision id, three timestamps, four integers);
 * - with the tuple header the uncompressed row is **~4,270 bytes**; `stages` is past the 2 KB TOAST
 *   threshold so pglz compresses this highly repetitive JSON to roughly 40%, giving **~1,900 bytes**;
 * - the primary key, the `request_id` unique constraint and the five declared indexes add
 *   **~207 bytes** of index entries.
 *
 * **≈ 2.1 KB per request, all in.** Unsampled that is **6.6 TB/year at 100 req/s** and
 * **66 TB/year at 1,000 req/s** — same order as the figure that refused the flag-evaluation writer,
 * into the same database that serves the ERP, under RLS, on the request path. So the flag is opt-in
 * and the rate is a **required** part of it: there is no default sample rate, because a default is
 * applied to silence and silence must not choose a write volume.
 *
 * A rate of `0` is **refused by name** rather than honoured. "Capture nothing" is already
 * expressible by omitting the flag; a mounted sink that writes nothing is the surface that reports
 * success and records nothing, and this module exists to end that, not to offer it as a setting.
 *
 * ## Why a sample rate and deliberately not an outcome filter
 *
 * `AuditChainConfig` filters on `outcomes`, `operations` and `sampleRate`, and the obvious cheap
 * default here would be "keep the denials and errors". It is the wrong one: `pass_with_4xx_or_5xx`
 * and `deny_without_4xx_or_5xx` are drift codes about a row whose `finalOutcome` **disagrees** with
 * its status, so filtering on the outcome the gateway claims discards exactly the rows where that
 * claim is false. A uniform sample keeps every drift code detectable in proportion; an outcome
 * filter blinds two of them completely.
 *
 * `operations` is offered, because narrowing the *population* (capture the deletion routes, nothing
 * else) does not blind any check — it answers a different question honestly.
 *
 * The sample is `sampleValue(requestId)`, the audit chain's own function and not a second one, so
 * the two samples are **nested**: at an equal rate both keep the same requests, and at a lower rate
 * this one's rows are a subset of the chain's. A request with an execution row therefore also has a
 * chain entry, which is what makes a sampled dataset jointly diagnosable instead of two unrelated
 * samples of one stream.
 */
export const GatewayExecutionCaptureConfigSchema = z
  .object({
    /**
     * Fraction of requests whose execution is persisted. No `.default()`: see above — a write
     * volume must not be chosen by silence. `0` is refused rather than meaning "off".
     */
    sampleRate: z.number().gt(0).max(1),
    /** Optional operation-id allowlist. A request that matched no route is excluded when set. */
    operations: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();
export type GatewayExecutionCaptureConfig = z.infer<typeof GatewayExecutionCaptureConfigSchema>;

export function parseGatewayExecutionCaptureConfig(json: unknown): GatewayExecutionCaptureConfig {
  return GatewayExecutionCaptureConfigSchema.parse(json);
}

/** Measured; the derivation is in this module's header. Includes index entries. */
export const ESTIMATED_EXECUTION_ROW_BYTES = 2_100;

/**
 * The sentence a boot line prints. It states the rate, the per-row cost and the projection at two
 * reference rates, because "sampling at 1%" is not a figure an operator can act on and
 * "0.66 TB/year at 1,000 req/s" is. Printed whether or not anything goes wrong — a cost accepted
 * silently is a cost nobody chose.
 */
export function describeCaptureCost(config: GatewayExecutionCaptureConfig): string {
  // Trailing zeros are stripped only *after* a decimal point, and the point only when nothing is
  // left behind it. The naive `/\.?0+$/` reads the integer "100" — which is what
  // `(1).toPrecision(3)` of a full sample gives, with no point at all — as "1", so a 100% capture
  // announced itself as 1% and understated the figure beside it a hundredfold. In the one line
  // whose whole job is to make an operator see the cost before accepting it.
  const pct = (config.sampleRate * 100)
    .toPrecision(3)
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");
  const perYear = (rps: number): string => {
    const bytes = ESTIMATED_EXECUTION_ROW_BYTES * config.sampleRate * rps * 86_400 * 365;
    return bytes >= 1e12 ? `${(bytes / 1e12).toFixed(1)} TB/yr` : `${(bytes / 1e9).toFixed(1)} GB/yr`;
  };
  const scope =
    config.operations === undefined
      ? "all operations"
      : `${String(config.operations.length)} operation(s)`;
  return (
    `capturing ${pct}% of executions (${scope}) at ~${String(ESTIMATED_EXECUTION_ROW_BYTES)} B/row ` +
    `incl. indexes — ~${perYear(100)} at 100 req/s, ~${perYear(1000)} at 1,000 req/s`
  );
}

/** Pure filter: the operation allowlist, then the deterministic sample. */
export function shouldCaptureExecution(
  execution: PipelineExecution,
  config: GatewayExecutionCaptureConfig,
): boolean {
  if (config.operations !== undefined) {
    if (execution.routeOperationId === null) return false;
    if (!config.operations.includes(execution.routeOperationId)) return false;
  }
  if (config.sampleRate >= 1) return true;
  return sampleValue(execution.requestId) < config.sampleRate;
}

export interface GatewayExecutionCaptureReport {
  /** Rows the store accepted. */
  readonly written: number;
  /** Executions the filter excluded — the sample working, not a fault. */
  readonly filtered: number;
  /** Writes that threw. Each one is a lost observation and never a failed request. */
  readonly failed: number;
  /** Executions shed because `maxInFlight` writes were already outstanding. */
  readonly shed: number;
  readonly firstFailure: string | null;
}

export interface GatewayExecutionCaptureOptions {
  readonly store: Pick<PostgresPipelineExecutionStore, "record">;
  readonly config: GatewayExecutionCaptureConfig;
  /**
   * Writes allowed to be outstanding at once. Reached, further executions are **shed and counted**
   * rather than queued.
   *
   * Deliberately not `AuditChainObserver`'s per-scope promise chain. That chain exists because a
   * hash chain has an order and an append must follow its predecessor; a pipeline execution is an
   * independent row under `ON CONFLICT (request_id) DO NOTHING`, so serialising buys nothing and
   * costs two things under load — it pins a tenant's capture to one write at a time, and it grows
   * an unbounded promise chain when the database is slower than the traffic, which turns a slow
   * disk into an out-of-memory. Shedding is the right failure for an observation: the sample is
   * already a fraction, and a shed row is one fewer of something that was never complete.
   */
  readonly maxInFlight?: number;
  readonly onError?: (err: unknown, execution: PipelineExecution) => void;
}

/**
 * The per-request sink. `record` **never throws and never awaits on the request path** — it is
 * handed to `onExecution`, which `OperateHttpServer.dispatch` calls after the response is built and
 * wraps in its own `try`, and observation must not be able to break serving.
 */
export class GatewayExecutionCaptureObserver {
  private readonly inFlight = new Set<Promise<void>>();
  private written = 0;
  private filtered = 0;
  private failed = 0;
  private shed = 0;
  private firstFailure: string | null = null;
  private readonly maxInFlight: number;

  constructor(private readonly opts: GatewayExecutionCaptureOptions) {
    this.maxInFlight = opts.maxInFlight ?? 8;
  }

  record(execution: PipelineExecution): void {
    if (!shouldCaptureExecution(execution, this.opts.config)) {
      this.filtered += 1;
      return;
    }
    if (this.inFlight.size >= this.maxInFlight) {
      this.shed += 1;
      return;
    }
    const task = (async () => {
      try {
        await this.opts.store.record(execution);
        this.written += 1;
      } catch (err) {
        this.failed += 1;
        if (this.firstFailure === null) {
          this.firstFailure = err instanceof Error ? err.message : String(err);
        }
        this.opts.onError?.(err, execution);
      }
    })();
    this.inFlight.add(task);
    void task.finally(() => this.inFlight.delete(task));
  }

  asExecutionSink(): (execution: PipelineExecution) => void {
    return (execution) => {
      this.record(execution);
    };
  }

  /** Resolves once every outstanding write has settled — graceful shutdown and tests. */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight]);
    }
  }

  pending(): number {
    return this.inFlight.size;
  }

  report(): GatewayExecutionCaptureReport {
    return {
      written: this.written,
      filtered: this.filtered,
      failed: this.failed,
      shed: this.shed,
      firstFailure: this.firstFailure,
    };
  }
}

/**
 * What a capture failure most often is, as a sentence worth printing once rather than per request.
 *
 * `meta.gateway_pipeline_executions.tenant_id` references `meta.tenants`, and `--api-key
 * 'key:role:tenant'` names an arbitrary UUID that need not have a row there — so on such a
 * deployment *every* captured request fails its foreign key. That is a configuration fact, not a
 * database fault, and it is the same class as the `principal_id` references ADR-0335 made TEXT: the
 * difference is that this one is a real tenant reference and stays. The boot survey
 * (`surveyUserFkReadiness`'s sibling for tenants) names those tenants already; this is the line
 * that connects the two for whoever reads the error.
 */
export const CAPTURE_FK_HINT =
  "meta.gateway_pipeline_executions.tenant_id references meta.tenants: an --api-key tenant with no tenants row cannot be captured";
