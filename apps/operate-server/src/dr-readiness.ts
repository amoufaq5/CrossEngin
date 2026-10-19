import { readFile } from "node:fs/promises";

import { z } from "zod";
import {
  BackupRecordSchema,
  DR_TIERS,
  ReplicationLagRecordSchema,
  RunbookSpecSchema,
} from "@crossengin/dr";
import {
  DrReadinessScheduler,
  type DrReadinessAxis,
  type DrReadinessInput,
  type DrReadinessReport,
  type IntervalScheduler,
} from "@crossengin/dr-runtime";
import { buildPersistentDrRuntime } from "@crossengin/dr-runtime-pg";
import type {
  PgConnection,
  UnreadableRow,
  UnreadableRowReporter,
} from "@crossengin/kernel-pg";

const ReplicationLagInputSchema = z
  .object({
    record: ReplicationLagRecordSchema,
    tier: z.enum(DR_TIERS),
  })
  .strict();

export const DrReadinessInputConfigSchema = z
  .object({
    runbooks: z.array(RunbookSpecSchema).default([]),
    backups: z.array(BackupRecordSchema).default([]),
    replication: z.array(ReplicationLagInputSchema).default([]),
    maxRunbookDaysSinceReview: z.number().int().positive().optional(),
    maxRunbookDaysSinceTest: z.number().int().positive().optional(),
  })
  .strict();

export const DrReadinessConfigSchema = z
  .object({
    tenantId: z.string().uuid().nullable().default(null),
    intervalMs: z.number().int().positive().default(3_600_000),
    input: DrReadinessInputConfigSchema,
  })
  .strict();
export type DrReadinessConfig = z.infer<typeof DrReadinessConfigSchema>;

export function parseDrReadinessConfig(json: unknown): DrReadinessConfig {
  return DrReadinessConfigSchema.parse(json);
}

export async function loadDrReadinessConfig(path: string): Promise<DrReadinessConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new Error(`--dr-readiness-config: cannot read ${path}: ${errMessage(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`--dr-readiness-config: invalid JSON in ${path}: ${errMessage(err)}`);
  }
  return parseDrReadinessConfig(parsed);
}

/**
 * An execution row the contract refused, named by the readiness axis its evidence belonged to.
 *
 * `axis` is `Extract`ed from `DrReadinessAxis` rather than spelled as its own two-member union, so
 * it is the report's **own** vocabulary: an operator meeting `[dr] unreadable row on drills` can
 * line it up against the `unevidenced=…` figure on the line above it, and a rename of either axis
 * is a compile error here instead of a log line that has stopped agreeing with the report.
 */
export interface UnreadableDrExecution extends UnreadableRow {
  readonly axis: Extract<DrReadinessAxis, "failovers" | "drills">;
}

export interface DrReadinessLifecycleOptions {
  readonly scheduler?: IntervalScheduler;
  readonly onReport?: (report: DrReadinessReport) => void;
  readonly onError?: (err: unknown) => void;
  /**
   * Where a row the contract refused is reported, and **required** where the other two callbacks
   * are not.
   *
   * ADR-0371's `onRefused` asymmetry, and it transfers exactly: a report that is written is its own
   * record and a throw is a condition the next tick meets again, while an unreadable row leaves
   * **nothing durable at all**. The snapshot this pass goes on to record describes the readable
   * subset and `DrReadinessReport` has no field that can say it was a subset (see `assessOnce`), so
   * this callback is the only place the fact exists. An optional one would let a deployment
   * discover that part of its DR history had stopped being readable by never being told — the
   * defect restated as a default (ADR-0364's addendum).
   */
  readonly onUnreadableExecution: (row: UnreadableDrExecution) => void;
  readonly failoverLimit?: number;
  readonly drillLimit?: number;
}

export interface DrReadinessLifecycle {
  readonly scheduler: DrReadinessScheduler;
  assessOnce(): Promise<DrReadinessReport>;
}

/**
 * Wires a persistent DR runtime + a readiness scheduler over a live connection:
 * each tick folds the failover + drill executions recorded through the API (read
 * back from Postgres) into the config's declared infra (runbooks / backups /
 * replication), assesses readiness, and persists the snapshot.
 */
export function buildDrReadinessLifecycle(
  conn: PgConnection,
  config: DrReadinessConfig,
  opts: DrReadinessLifecycleOptions,
): DrReadinessLifecycle {
  const persistent = buildPersistentDrRuntime(conn, { tenantId: config.tenantId });
  const failoverLimit = opts.failoverLimit ?? 500;
  const drillLimit = opts.drillLimit ?? 500;

  /**
   * One pass: read both histories, fold them into the declared infra, assess, persist.
   *
   * **A row the contract refuses no longer takes the pass with it, and that is the whole of what
   * was wrong here.** `.map(rowToRecord)` in either store threw out of the page, the throw
   * propagated through this function into `DrReadinessScheduler`'s `catch`, and that handler only
   * calls `onError` — so one unreadable drill or failover meant **no readiness snapshot was
   * recorded at all**, every tick, and `drReadinessSource` then certified against whatever stale
   * snapshot `latest()` still held, or against none. ADR-0372's whole increment — teaching
   * `assessDrReadiness` to say which axes it had no evidence for rather than scoring `ready: true`
   * over an empty input — ran only on a pass that completed, so a single refused row disarmed it.
   *
   * **What is deliberately *not* done: an unreadable row does not mark its axis unevidenced**, and
   * the reason is that the report cannot say it without saying something false. Measured against
   * `packages/dr-runtime/src/readiness.ts`:
   *
   * - For a **failover** it is not expressible at all. `unevidencedAxes` is typed
   *   `DrEvidenceAxisSchema`, `DR_EVIDENCE_AXES` carries `satisfies readonly DrEvidenceAxis[]`, and
   *   `DrEvidenceAxis` is read off `DR_AXIS_EMPTY_MEANS`, where `failovers` is `nothing_happened` —
   *   so listing `failovers` there is a compile error, on purpose: an empty failover list is the
   *   healthy claim that nothing failed over.
   * - For a **drill** it is expressible and false. `unevidencedAxes` means *this axis carried no
   *   record at all*: `evidenceFromDrReadiness` renders it as `no drills record was supplied, so
   *   nothing on that axis was verified` and summarises it as `no DR record on drills`. With even
   *   one readable row beside the refused one, records were supplied and verified — so naming the
   *   axis puts a false sentence into a SOC 2 evidence pack, which is a refusal shaped like a
   *   finding: ranked below an honest incomplete answer (ADR-0336), and ADR-0337's falsely-true
   *   control pointed the other way.
   *
   * The degenerate case needs no special handling and is already right: if *every* row on an axis
   * is unreadable the readable list is empty, `assessDrReadiness` names the axis for the ordinary
   * reason, and `ready` is `false`. So the gap is the **partial** page, where the honest answer is
   * the narrower one — record the snapshot, carry the count to the operator, claim nothing about
   * the axis. Closing it properly needs `DrReadinessReport` to gain a field for a fact it has no
   * vocabulary for today (*this axis's evidence was partly unreadable*, which is neither
   * `unevidenced` nor an issue count), and that is a contract change in `@crossengin/dr-runtime`.
   */
  async function assessOnce(): Promise<DrReadinessReport> {
    // The scope is named, which it could not be before: these two reads took a limit alone, so as
    // the table's owner — who bypasses RLS — they returned every tenant's history and
    // `assessDrReadiness` scored this deployment's DR readiness off other tenants' drills and
    // failovers. `config.tenantId` was already here; the stores simply had nowhere to receive it.
    const scope = config.tenantId ?? null;
    // The store's reporter says only `{identity, detail}`; which history the row came from is this
    // function's knowledge and not the store's, so the axis is attached here.
    const reportOn =
      (axis: UnreadableDrExecution["axis"]): UnreadableRowReporter =>
      (row) => {
        opts.onUnreadableExecution({ ...row, axis });
      };
    const [failoverRows, drillRows] = await Promise.all([
      persistent.failoverStore.listRecent(scope, reportOn("failovers"), failoverLimit),
      persistent.drillStore.listRecent(scope, reportOn("drills"), drillLimit),
    ]);
    const input: DrReadinessInput = {
      ...config.input,
      failovers: failoverRows.map((row) => row.record),
      drills: drillRows.map((row) => row.record),
    };
    return persistent.assess(input, { tenantId: config.tenantId });
  }

  const scheduler = new DrReadinessScheduler({
    assess: assessOnce,
    intervalMs: config.intervalMs,
    ...(opts.scheduler !== undefined ? { scheduler: opts.scheduler } : {}),
    ...(opts.onReport !== undefined ? { onReport: opts.onReport } : {}),
    ...(opts.onError !== undefined ? { onError: opts.onError } : {}),
  });

  return { scheduler, assessOnce };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
