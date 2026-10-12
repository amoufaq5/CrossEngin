import type { PgConnection } from "@crossengin/kernel-pg";
import type { WorkflowDefinition } from "@crossengin/workflow-engine";
import {
  type ProjectedInstance,
  projectActivities,
  projectInstance,
  projectSignals,
  projectTimers,
} from "@crossengin/workflow-runtime";

import { projectPersistableActivities } from "./activity-provenance.js";
import { PostgresActivityStore } from "./activity-store.js";
import { PostgresEventLog } from "./event-log.js";
import {
  type JobQueueVisibilityReport,
  probeJobQueueVisibility,
} from "./job-claim.js";
import {
  WorkflowDefinitionIdResolver,
  WorkflowInstanceIdResolver,
} from "./id-mapping.js";
import {
  PostgresInstanceStore,
  type StoredCancellationColumns,
  cancellationProjectionFromRow,
  isoInstant,
} from "./instance-store.js";
import { projectPersistableSignals } from "./signal-provenance.js";
import { PostgresSignalStore } from "./signal-store.js";
import { projectPersistableTimers } from "./timer-provenance.js";
import { PostgresTimerStore } from "./timer-store.js";

const SCHEMA = "meta";

export interface DriftField {
  readonly field: string;
  readonly stored: unknown;
  readonly expected: unknown;
}

export interface InstanceDrift {
  readonly instanceMissing: boolean;
  /**
   * A stored instance row the log cannot account for — no events at all under its id.
   *
   * Its own flag and not `fields`, because it is the **most reachable drift shape there is** and it
   * used to be reported as no drift at all. `ProjectingEventLog.append` creates the row *before* it
   * appends `instance_started`, and the two are not in one transaction, so an append that fails or a
   * process that dies between them commits an instance with an empty log. The old empty-log early
   * return answered `drifted: false` without ever looking at the row, so the one divergence the
   * write ordering actually produces was invisible to the detector built for it.
   *
   * It is reported and never repaired: the honest repair is the missing `instance_started` event,
   * which nothing can synthesise, and deleting the row destroys the only record that the instance
   * was ever started.
   */
  readonly instanceOrphaned: boolean;
  readonly fields: readonly DriftField[];
}

export interface ChildEntityDrift {
  readonly missingIds: readonly string[];
  /**
   * Stored rows the log does not account for. **Reported and never repaired** — there is no `DELETE`
   * on any path here, and there should not be: a row the log cannot explain may be the surviving
   * evidence of a log that was truncated, and a repairer that deletes it destroys the finding.
   * So, unlike `missingIds` and `mismatchedIds`, a non-empty `extraIds` is a standing finding that
   * a resync does not clear.
   */
  readonly extraIds: readonly string[];
  readonly mismatchedIds: readonly string[];
}

export interface VerifyReport {
  readonly instanceId: string;
  readonly hasEvents: boolean;
  readonly definitionId: string | null;
  /**
   * Whether the definition the log names was found in the map this replayer was built with.
   *
   * On the report rather than implied by `definitionId`, because a projection is a function of the
   * log **and the definition**, and `refineStatusFromDefinition` is the half that decides
   * `waiting_for_signal` / `waiting_for_manual` / `waiting_for_timer` and fills `awaiting_*`. With
   * the definition absent that refinement does not run, so a healthy `waiting_for_signal` row is
   * compared against an expected `running` and reported as drift — a false positive of exactly
   * ADR-0330's shape, in the same comparison function. The fields are still reported, because a
   * detector that goes quiet is worse than one whose findings are labelled; but a consumer must read
   * this flag before believing a `status` finding, and `resyncInstance` refuses outright.
   */
  readonly definitionResolved: boolean;
  /**
   * Whether this session could have seen drift at all.
   *
   * `false` makes every other field in this report meaningless and in particular makes
   * `drifted: false` a statement about the session rather than about the instance. All five tables
   * carry **isolation-only** RLS — one `ALL`-scope policy, no `SELECT` platform arm, measured live
   * on a fresh bootstrap — so unlike the split tables (`gateway_pipeline_executions`,
   * `slo_evaluations`, `dr_failover_executions`, each `ALL 1 / SELECT 1 / INSERT 1`) there is no
   * cross-scope read mode here at all: a non-owner with no tenant context sees **zero** rows, not
   * "only the platform's". So the empty log, the absent row and the empty child lists all arrive
   * together and compose into a clean bill of health. This is `rls_would_confine_this_session`
   * (ADR-0329), where a `DELETE` matched 0 rows, reported 0, and the confirming `count(*)` also saw
   * 0 because both read through the same policy — the confirmation cannot catch it, so the catalog
   * is asked instead.
   */
  readonly verifiable: boolean;
  /**
   * Why the log could not be folded at all, or `null`.
   *
   * `projectInstance` **throws** when the first event is not `instance_started`, which a partially
   * erased or hand-edited log produces. Caught and reported rather than propagated: a verification
   * is a diagnostic, and a sweep that dies on its most corrupt instance stops examining the healthy
   * ones behind it (ADR-0289's rule — a row that no longer satisfies its contract is a finding).
   */
  readonly logUnprojectable: string | null;
  readonly instance: InstanceDrift;
  readonly activities: ChildEntityDrift;
  readonly signals: ChildEntityDrift;
  readonly timers: ChildEntityDrift;
  readonly drifted: boolean;
}

/**
 * Why a resync wrote nothing.
 *
 * Each one is a premise of the repair that did not hold, and each is reported rather than thrown
 * because `bulkResync` must keep going — a typed refusal is a fact a caller can act on, where an
 * exception message is one it can only print. The three provenance refusals
 * (`ActivityProvenanceUnresolved` and friends) deliberately still throw: those are raised by the
 * projections themselves and are already loud and named.
 */
export const RESYNC_REFUSALS = [
  /**
   * RLS confines this session on the projection tables, so the repair can neither read what it
   * needs nor write what it derives. **Refused first, before the log is read**, because that is the
   * only ordering that distinguishes the two outcomes: a confined session's `listByInstance` matches
   * zero rows, so without this the repairer answers `hadEvents: false` — "there was nothing to
   * repair" — for every instance in the database.
   *
   * It covers the write too, and that is the half with teeth. On a table whose isolation policy is
   * the *only* arm, that policy's `USING` also serves as its `WITH CHECK`, so there is no second
   * route in: every `INSERT … ON CONFLICT` here is refused `42501` as a non-owner, and the
   * instance `UPDATE` matches nothing and reports success. None of the four stores sets
   * transaction-local tenant context (see this module's note on `WorkflowReplayerOptions`), so an
   * RLS-bypassing connection — the table's owner, or a `BYPASSRLS` role, which is what the worker
   * fleet already assumes — is a **precondition** of this tool rather than a deployment detail.
   * Stated and refused, rather than discovered at the first repair.
   */
  "rls_would_confine_this_session",
  /**
   * The log names a definition this replayer was not given. **The load-bearing refusal.** Without
   * it, `projectInstance` silently skips `refineStatusFromDefinition` and the resync writes
   * `status = 'running'` with `awaiting_signal_names = '[]'` over a correct `waiting_for_signal`
   * row — a repair that reports success while making the row *less* true than it found it. It is
   * reachable whenever the instance has no activities, signals or timers to make one of the three
   * child projections refuse first, which is every purely state-machine instance: a
   * `manual_approval` state, an `automatic` chain, a `set_variable` guard.
   *
   * Refused in preference to letting the child projections raise, so the reported cause is the
   * missing definition rather than whichever symptom surfaced first — ADR-0334's `no_definitions` /
   * `no_job_handlers` lesson.
   */
  "definition_unresolved",
  /**
   * No row exists under this instance id, so the projection's `UPDATE` would match nothing.
   * `upsertProjection` cannot create one (the create-time columns are not in the projection), and
   * every child write resolves the instance's surrogate uuid first, so the whole resync is a no-op.
   */
  "instance_row_absent",
  /** `projectInstance` refused the log; see `VerifyReport.logUnprojectable`. */
  "log_unprojectable",
] as const;
export type ResyncRefusal = (typeof RESYNC_REFUSALS)[number];

export interface ResyncReport {
  readonly instanceId: string;
  readonly hadEvents: boolean;
  /** Set iff nothing was written. `upserts` is all-zero whenever this is non-null. */
  readonly refusal: ResyncRefusal | null;
  readonly detail: string | null;
  readonly upserts: {
    /**
     * Whether the instance row was actually updated — `rowCount > 0` from the statement, not "the
     * statement was issued". It reported `true` unconditionally before, so the one instance-level
     * drift `verifyInstance` can detect (`instanceMissing`) was also the one the resync claimed to
     * have repaired and had not.
     */
    readonly instance: boolean;
    readonly activities: number;
    readonly signals: number;
    readonly timers: number;
  };
}

export interface BulkResyncReport {
  readonly reports: readonly ResyncReport[];
  /**
   * Instances whose resync raised. Collected rather than propagated so one unprojectable instance
   * does not end a sweep — the same reason `drainAllTenants` catches per tenant (ADR-0302).
   */
  readonly errors: readonly { readonly instanceId: string; readonly message: string }[];
}

/** The five tables a replay reads, in the order a failure would be noticed. */
export const REPLAY_TABLES = [
  "workflow_events",
  "workflow_instances",
  "workflow_activities",
  "workflow_signals",
  "workflow_timers",
] as const;

export interface ReplayVisibilityReport {
  /** `visible` only when every one of the five tables is. */
  readonly usable: boolean;
  readonly tables: readonly { readonly table: string; readonly report: JobQueueVisibilityReport }[];
  readonly detail: string;
}

/**
 * **This replayer requires an RLS-bypassing connection, and says so rather than assuming it.**
 *
 * None of the four stores it writes through sets transaction-local tenant context. That is a
 * property of the whole workflow persistence layer and not of this module — `ProjectingEventLog`
 * drives the same four stores on the engine's own append path, and `claimDueTimers` documents the
 * worker connection as "platform-scoped (RLS-bypassing), so one fleet serves every tenant" — so
 * giving these stores a scope is a subsystem-wide decision with the engine on the other end of it,
 * not a fix to make here. What belongs here is the refusal: `probeVisibility` asks the catalog, and
 * `resyncInstance` answers `rls_would_confine_this_session` instead of writing nothing and calling
 * it nothing to do.
 */
export interface WorkflowReplayerOptions {
  readonly conn: PgConnection;
  readonly definitions: ReadonlyMap<string, WorkflowDefinition>;
  readonly instanceResolver?: WorkflowInstanceIdResolver;
  readonly definitionResolver?: WorkflowDefinitionIdResolver;
}

/** The timestamps are `unknown` because node-postgres hands a `TIMESTAMPTZ` back as a `Date`. */
interface StoredInstanceRow extends StoredCancellationColumns {
  readonly instance_id: string;
  readonly status: string;
  readonly current_state: string;
  readonly variables: unknown;
  readonly sequence_cursor: number;
  readonly completed_at: unknown;
  readonly failed_at: unknown;
  readonly cancelled_at: unknown;
  readonly suspended_at: unknown;
  readonly compensation_started_at: unknown;
  readonly compensation_completed_at: unknown;
}

interface StoredActivityRow {
  readonly activity_id: string;
  readonly status: string;
  readonly definition_activity_key: string;
}

interface StoredSignalRow {
  readonly signal_id: string;
  readonly status: string;
}

interface StoredTimerRow {
  readonly timer_id: string;
  readonly status: string;
  readonly fire_count: unknown;
  /** `TIMESTAMPTZ`, so node-postgres hands back a `Date` — normalised, per ADR-0330. */
  readonly next_fire_at: unknown;
}

/**
 * What the replayer compares for a timer: its status **and its recurrence position**.
 *
 * `status` alone was enough while every timer fired once. A recurring timer is armed again on its own
 * id, so a row whose `fire_count` has stopped advancing or whose `next_fire_at` is stale projects as
 * `scheduled` just like a healthy one — the drift would be a cron timer that quietly stopped
 * recurring, which is precisely the state `cron_next_fire_unresolved` exists to refuse at write time
 * and nothing watched for afterwards. One signature string rather than three `DriftField`s because
 * `compareSimpleProjections` reports ids and the caller's remedy is a re-upsert either way.
 */
export function timerProjectionSignature(input: {
  readonly status: string;
  readonly fireCount: number;
  readonly nextFireAt: string | null;
}): string {
  return `${input.status}|${String(input.fireCount)}|${input.nextFireAt ?? "-"}`;
}

/**
 * A stored JSONB object, or `null` when the column holds anything else.
 *
 * `null` rather than `{}`, which is `parseStringArray`'s rule one column over and for its stated
 * reason: an unreadable column and an empty object are different facts, and collapsing them made a
 * `variables` column tampered to `42` or `"[1,2]"` compare **equal** to the healthy empty case on
 * every instance that set no variable. Two parsers in one file answering that question opposite ways
 * is the inconsistency; this is the side with the argument behind it.
 */
function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The canonical text of a JSON value, with object keys sorted and array order preserved.
 *
 * `JSONB` does not preserve key order, so a plain `JSON.stringify` comparison would report drift on
 * a healthy row whose keys came back in a different order — the same fact `dispatchDedupHash` exists
 * for (ADR-0309). Array order *is* significant, because a variable holding a list is a list.
 * `undefined` entries are dropped, matching what a JSONB round trip does to them, so an in-process
 * projection and its stored form compare equal.
 */
function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, unknown] => entry[1] !== undefined)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export class WorkflowReplayer {
  private readonly conn: PgConnection;
  private readonly definitions: ReadonlyMap<string, WorkflowDefinition>;
  private readonly instanceResolver: WorkflowInstanceIdResolver;
  private readonly definitionResolver: WorkflowDefinitionIdResolver;
  private readonly eventLog: PostgresEventLog;
  private readonly instanceStore: PostgresInstanceStore;
  private readonly activityStore: PostgresActivityStore;
  private readonly signalStore: PostgresSignalStore;
  private readonly timerStore: PostgresTimerStore;
  /**
   * Memoised for the replayer's lifetime, which is one invocation: the answer is a property of the
   * role and the catalog, and asking it per instance would put five catalog queries in front of
   * every row of a sweep. A grant changed mid-process is not picked up, which is the right trade for
   * a tool that is constructed, run and discarded.
   */
  private visibility: ReplayVisibilityReport | null = null;

  constructor(opts: WorkflowReplayerOptions) {
    this.conn = opts.conn;
    this.definitions = opts.definitions;
    this.instanceResolver = opts.instanceResolver ?? new WorkflowInstanceIdResolver(opts.conn);
    this.definitionResolver =
      opts.definitionResolver ?? new WorkflowDefinitionIdResolver(opts.conn);
    this.eventLog = new PostgresEventLog({
      conn: opts.conn,
      instanceResolver: this.instanceResolver,
    });
    this.instanceStore = new PostgresInstanceStore({
      conn: opts.conn,
      instanceResolver: this.instanceResolver,
      definitionResolver: this.definitionResolver,
    });
    this.activityStore = new PostgresActivityStore({
      conn: opts.conn,
      instanceResolver: this.instanceResolver,
    });
    this.signalStore = new PostgresSignalStore({
      conn: opts.conn,
      instanceResolver: this.instanceResolver,
    });
    this.timerStore = new PostgresTimerStore({
      conn: opts.conn,
      instanceResolver: this.instanceResolver,
    });
  }

  /**
   * Whether this connection can read the five tables a replay touches.
   *
   * The reason this exists is the reason `probeJobQueueVisibility` does, and it is sharper here.
   * All five tables carry exactly one `ALL`-scope tenant-isolation policy and **no platform arm**,
   * while a replay is deliberately cross-tenant. As a non-owner role with no
   * `app.current_tenant_id` set, `listByInstance` matches 0 rows, so `verifyInstance` answers
   * `hasEvents: false, drifted: false` and `resyncInstance` answers `hadEvents: false` — for every
   * instance in the database. **A detector that can see nothing gives a clean bill of health, and a
   * repairer that can write nothing reports that there was nothing to repair.** Counting rows
   * cannot tell that apart from a healthy deployment, so the catalog is asked instead.
   */
  async probeVisibility(): Promise<ReplayVisibilityReport> {
    if (this.visibility !== null) return this.visibility;
    const tables: { readonly table: string; readonly report: JobQueueVisibilityReport }[] = [];
    for (const table of REPLAY_TABLES) {
      tables.push({ table, report: await probeJobQueueVisibility(this.conn, { table }) });
    }
    const blocked = tables.filter((t) => t.report.visibility !== "visible");
    this.visibility = {
      usable: blocked.length === 0,
      tables,
      detail:
        blocked.length === 0
          ? `'${tables[0]?.report.role ?? ""}' can read every workflow projection table across tenants`
          : blocked
              .map((t) => `${SCHEMA}.${t.table}: ${t.report.visibility} — ${t.report.detail}`)
              .join("; "),
    };
    return this.visibility;
  }

  async resyncInstance(instanceId: string): Promise<ResyncReport> {
    const visibility = await this.probeVisibility();
    if (!visibility.usable) {
      return noWrites(instanceId, false, "rls_would_confine_this_session", visibility.detail);
    }
    const events = await this.eventLog.listByInstance(instanceId);
    if (events.length === 0) {
      return noWrites(instanceId, false, null, null);
    }
    const definitionId = definitionIdOf(events);
    const definition = definitionId === null ? undefined : this.definitions.get(definitionId);
    // **Refused before anything is computed.** The three child projections refuse when the
    // definition is missing, but only if the instance *has* a child to project — so a purely
    // state-machine instance went straight through and had its refined status written away. The
    // repair is only conclusive when both halves of the projection's input are in hand.
    if (definition === undefined) {
      return noWrites(
        instanceId,
        true,
        "definition_unresolved",
        definitionId === null
          ? "the instance_started event names no definitionId"
          : `definition ${definitionId} is not in this replayer's definition map, so the projected ` +
            "status would not be refined from the state machine",
      );
    }
    let projection: ProjectedInstance | null;
    try {
      projection = projectInstance(events, definition);
    } catch (err) {
      return noWrites(instanceId, true, "log_unprojectable", messageOf(err));
    }
    if (projection === null) {
      return noWrites(instanceId, true, "log_unprojectable", "the log folded to no instance");
    }
    // **All three resolved before the first write.** Each can refuse, and a refusal that has
    // already upserted the instance leaves a half-resynced instance behind — from the one tool
    // whose whole job is to make the projections agree with the log. So the whole resync is
    // computed first and written second: either every projection is persistable, or none is
    // written. (ADR-0331 established this for signals alone, when they were the only refuser.)
    const signals = projectPersistableSignals(events, definition);
    const activities = projectPersistableActivities(events, definition);
    const timers = projectPersistableTimers(events, definition);
    const instanceUpserted = await this.instanceStore.upsertProjection(projection);
    if (!instanceUpserted) {
      // Refused *after* the instance statement and *before* every child write, which is where the
      // boundary has to be: the statement matched nothing, so nothing was written by it, and each
      // child write would raise `workflow instance not found in database` on the resolver anyway.
      // Reported as its own refusal rather than as that incidental exception.
      return noWrites(
        instanceId,
        true,
        "instance_row_absent",
        `no row in ${SCHEMA}.workflow_instances carries instance_id ${instanceId}, so the ` +
          "projection has nothing to be written over",
      );
    }
    await this.activityStore.upsertMany(activities);
    await this.signalStore.upsertMany(signals);
    // `preserve_claim`: a repair is not the result of a claim, so it must not release one. See
    // `TIMER_CLAIM_POLICIES`.
    await this.timerStore.upsertMany(timers, { claimPolicy: "preserve_claim" });
    return {
      instanceId,
      hadEvents: true,
      refusal: null,
      detail: null,
      upserts: {
        instance: instanceUpserted,
        activities: activities.length,
        signals: signals.length,
        timers: timers.length,
      },
    };
  }

  async verifyInstance(instanceId: string): Promise<VerifyReport> {
    const verifiable = (await this.probeVisibility()).usable;
    const events = await this.eventLog.listByInstance(instanceId);
    if (events.length === 0) {
      // The row is still read. An instance row with an empty log is drift — the drift this
      // deployment's write ordering actually produces — and the old early return reported it as
      // health without issuing the query. See `InstanceDrift.instanceOrphaned`.
      const orphan = await this.fetchInstanceRow(instanceId);
      return {
        instanceId,
        hasEvents: false,
        definitionId: null,
        definitionResolved: false,
        verifiable,
        logUnprojectable: null,
        instance: { instanceMissing: false, instanceOrphaned: orphan !== null, fields: [] },
        activities: { missingIds: [], extraIds: [], mismatchedIds: [] },
        signals: { missingIds: [], extraIds: [], mismatchedIds: [] },
        timers: { missingIds: [], extraIds: [], mismatchedIds: [] },
        drifted: orphan !== null,
      };
    }
    const definitionId = definitionIdOf(events);
    const definition = definitionId === null ? undefined : this.definitions.get(definitionId);
    let expected: ProjectedInstance | null;
    let logUnprojectable: string | null = null;
    try {
      expected = projectInstance(events, definition);
    } catch (err) {
      expected = null;
      logUnprojectable = messageOf(err);
    }
    const storedInstance = await this.fetchInstanceRow(instanceId);
    const instanceDrift = expected === null
      ? {
          instanceMissing: false,
          instanceOrphaned: false,
          fields: [] as DriftField[],
        }
      : compareInstanceProjection(expected, storedInstance);

    // `projectActivities`, not `projectPersistableActivities` — the same choice, and for the same
    // reason, as the signals below: a read-only report must stay answerable when the definition map
    // is incomplete, and it compares only the two fields a resync can repair.
    const expectedActivities = projectActivities(events);
    const storedActivities = await this.fetchActivityRows(instanceId);
    const activityDrift = compareActivityProjections(expectedActivities, storedActivities);

    // `projectSignals`, not `projectPersistableSignals`: this is the read-only report, and it
    // compares the two fields a resync can actually repair. Provenance — the delivery guarantee,
    // the source system, the principal — is written once at receipt and deliberately left out of
    // the upsert's DO UPDATE set, so reporting a provenance mismatch here would be a finding no
    // repair clears, and a standing finding is one an operator mutes. The non-throwing projection
    // also keeps the report answerable when the definition map is incomplete, which is the
    // opposite choice from the write path above — a diagnostic that refuses to diagnose is worse
    // than one that reports less, while a write that invents a guarantee is worse than no write.
    const expectedSignals = projectSignals(events);
    const storedSignals = await this.fetchSignalRows(instanceId);
    const signalDrift = compareSimpleProjections(
      expectedSignals.map((s) => ({ id: s.id, status: s.status })),
      storedSignals.map((s) => ({ id: s.signal_id, status: s.status })),
    );

    const expectedTimers = projectTimers(events);
    const storedTimers = await this.fetchTimerRows(instanceId);
    const timerDrift = compareSimpleProjections(
      expectedTimers.map((t) => ({
        id: t.id,
        status: timerProjectionSignature({
          status: t.status,
          fireCount: t.fireCount,
          nextFireAt: t.nextFireAt,
        }),
      })),
      storedTimers.map((t) => ({
        id: t.timer_id,
        status: timerProjectionSignature({
          status: t.status,
          fireCount: Number(t.fire_count ?? 0),
          nextFireAt: isoInstant(t.next_fire_at),
        }),
      })),
    );

    const drifted =
      logUnprojectable !== null ||
      instanceDrift.instanceMissing ||
      instanceDrift.instanceOrphaned ||
      instanceDrift.fields.length > 0 ||
      activityDrift.missingIds.length > 0 ||
      activityDrift.extraIds.length > 0 ||
      activityDrift.mismatchedIds.length > 0 ||
      signalDrift.missingIds.length > 0 ||
      signalDrift.extraIds.length > 0 ||
      signalDrift.mismatchedIds.length > 0 ||
      timerDrift.missingIds.length > 0 ||
      timerDrift.extraIds.length > 0 ||
      timerDrift.mismatchedIds.length > 0;

    return {
      instanceId,
      hasEvents: true,
      // The id the **log** names, not `definition?.id`, which answered `null` for the one case worth
      // distinguishing: a definition the log names and the map lacks read identically to a log that
      // names none, so a reader could not tell an unresolved definition from an unlabelled instance.
      definitionId,
      definitionResolved: definition !== undefined,
      verifiable,
      logUnprojectable,
      instance: instanceDrift,
      activities: activityDrift,
      signals: signalDrift,
      timers: timerDrift,
      drifted,
    };
  }

  /**
   * One page of instance ids, keyset-paged on `instance_id`.
   *
   * **Keyset and not `OFFSET`, and ordered by `instance_id` and not `started_at`**, for two reasons
   * that compound. `started_at` is not unique, so a tie at a page boundary makes the walk re-read or
   * **step over** a row (ADR-0327), and a stepped-over row is one nothing else examines; and `OFFSET`
   * shifts under any concurrent insert. The second reason is specific to a *repairing* sweep and is
   * worse: `resyncInstance` writes `status`, which is one of this listing's own filters — so
   * `bulkResync({status})` repairing an instance out of the filtered set shrank the result ahead of
   * its own cursor and skipped one row for every row it fixed. `instance_id` is NOT NULL and
   * unique-constrained, so the order is total, and no write on any path here changes it.
   *
   * The cost is that pages no longer arrive newest-first; a sweep wants coverage, not recency.
   */
  async listInstanceIds(opts: {
    readonly tenantId?: string;
    readonly status?: string;
    readonly limit?: number;
    /** Exclusive lower bound — the last `instance_id` of the previous page. */
    readonly after?: string;
  } = {}): Promise<readonly string[]> {
    const limit = opts.limit ?? 1000;
    const filters: string[] = [];
    const params: unknown[] = [];
    if (opts.tenantId !== undefined) {
      params.push(opts.tenantId);
      filters.push(`tenant_id = $${params.length.toString()}`);
    }
    if (opts.status !== undefined) {
      params.push(opts.status);
      filters.push(`status = $${params.length.toString()}`);
    }
    if (opts.after !== undefined) {
      params.push(opts.after);
      filters.push(`instance_id > $${params.length.toString()}`);
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
    params.push(limit);
    const result = await this.conn.query<{ instance_id: string }>(
      `SELECT instance_id FROM ${SCHEMA}.workflow_instances ${where}
        ORDER BY instance_id ASC
        LIMIT $${params.length.toString()}`,
      params,
    );
    return result.rows.map((r) => r.instance_id);
  }

  async bulkResync(opts: {
    readonly tenantId?: string;
    readonly status?: string;
    readonly batchSize?: number;
    readonly maxInstances?: number;
  } = {}): Promise<BulkResyncReport> {
    const batchSize = opts.batchSize ?? 100;
    const maxInstances = opts.maxInstances ?? Number.POSITIVE_INFINITY;
    const reports: ResyncReport[] = [];
    const errors: { readonly instanceId: string; readonly message: string }[] = [];
    let after: string | undefined;
    while (reports.length + errors.length < maxInstances) {
      const remaining = maxInstances - (reports.length + errors.length);
      const limit = Math.min(batchSize, remaining);
      const ids = await this.listInstanceIds({
        ...(opts.tenantId !== undefined ? { tenantId: opts.tenantId } : {}),
        ...(opts.status !== undefined ? { status: opts.status } : {}),
        ...(after !== undefined ? { after } : {}),
        limit,
      });
      if (ids.length === 0) break;
      for (const id of ids) {
        try {
          reports.push(await this.resyncInstance(id));
        } catch (err) {
          errors.push({ instanceId: id, message: messageOf(err) });
        }
      }
      after = ids[ids.length - 1];
      if (ids.length < limit) break;
    }
    return { reports, errors };
  }

  private async fetchInstanceRow(instanceId: string): Promise<StoredInstanceRow | null> {
    const result = await this.conn.query<StoredInstanceRow>(
      `SELECT instance_id, status, current_state, variables, sequence_cursor,
              completed_at, failed_at, cancelled_at, suspended_at,
              compensation_started_at, compensation_completed_at,
              cancellation_requested_at, cancellation_requested_by,
              cancellation_disposition, cancellation_signalled_activity_ids
         FROM ${SCHEMA}.workflow_instances
        WHERE instance_id = $1
        LIMIT 1`,
      [instanceId],
    );
    return result.rows[0] ?? null;
  }

  private async fetchActivityRows(instanceId: string): Promise<readonly StoredActivityRow[]> {
    const uuid = await this.instanceResolver.resolve(instanceId);
    if (uuid === null) return [];
    const result = await this.conn.query<StoredActivityRow>(
      `SELECT activity_id, status, definition_activity_key
         FROM ${SCHEMA}.workflow_activities
        WHERE instance_id = $1`,
      [uuid],
    );
    return result.rows;
  }

  private async fetchSignalRows(instanceId: string): Promise<readonly StoredSignalRow[]> {
    const uuid = await this.instanceResolver.resolve(instanceId);
    if (uuid === null) return [];
    const result = await this.conn.query<StoredSignalRow>(
      `SELECT signal_id, status
         FROM ${SCHEMA}.workflow_signals
        WHERE instance_id = $1`,
      [uuid],
    );
    return result.rows;
  }

  private async fetchTimerRows(instanceId: string): Promise<readonly StoredTimerRow[]> {
    const uuid = await this.instanceResolver.resolve(instanceId);
    if (uuid === null) return [];
    const result = await this.conn.query<StoredTimerRow>(
      `SELECT timer_id, status, fire_count, next_fire_at
         FROM ${SCHEMA}.workflow_timers
        WHERE instance_id = $1`,
      [uuid],
    );
    return result.rows;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The `definitionId` the log's first event names, which is the only place the projection reads it. */
function definitionIdOf(
  events: readonly { readonly payload: Record<string, unknown> }[],
): string | null {
  const first = events[0];
  if (first === undefined) return null;
  const value = first.payload["definitionId"];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function noWrites(
  instanceId: string,
  hadEvents: boolean,
  refusal: ResyncRefusal | null,
  detail: string | null,
): ResyncReport {
  return {
    instanceId,
    hadEvents,
    refusal,
    detail,
    upserts: { instance: false, activities: 0, signals: 0, timers: 0 },
  };
}

function compareInstanceProjection(
  expected: ProjectedInstance,
  stored: StoredInstanceRow | null,
): InstanceDrift {
  if (stored === null) {
    return { instanceMissing: true, instanceOrphaned: false, fields: [] };
  }
  const fields: DriftField[] = [];
  const expectedVariables = expected.variables;
  const storedVariables = parseJsonObject(stored.variables);
  if (stored.status !== expected.status) {
    fields.push({ field: "status", stored: stored.status, expected: expected.status });
  }
  if (stored.current_state !== expected.currentState) {
    fields.push({
      field: "current_state",
      stored: stored.current_state,
      expected: expected.currentState,
    });
  }
  if (stored.sequence_cursor !== expected.sequenceCursor) {
    fields.push({
      field: "sequence_cursor",
      stored: stored.sequence_cursor,
      expected: expected.sequenceCursor,
    });
  }
  // **Structurally, not key-by-key with `!==`.** The old comparison compared values by identity, so
  // a variable holding an object or an array — `set_variable` puts whatever the event payload
  // carried into the map, and `instance_started` seeds it the same way — was never equal to itself:
  // `JSONB` comes back from node-postgres *parsed*, as a fresh object, and two structurally
  // identical objects are `!==`. Every healthy instance with one nested variable reported permanent
  // `variables` drift. That is ADR-0330's defect in the same function, one field across, and it
  // survived for the same reason: the offline fake hands back the very object the test put in, so
  // identity held and no test could see it.
  if (storedVariables === null || canonicalJson(storedVariables) !== canonicalJson(expectedVariables)) {
    fields.push({
      field: "variables",
      stored: storedVariables ?? stored.variables,
      expected: expectedVariables,
    });
  }
  // The cancellation fence, compared on the same footing as the terminal timestamps. It is the field
  // the driver loops read *instead of* the status, so a row whose `cancellation_requested_at` was
  // cleared would serve a cancelled instance's timers as live — and until this, nothing looked.
  const storedCancellation = cancellationProjectionFromRow(stored);
  // Every timestamp goes through `isoInstant`, including the six that were here before: node-postgres
  // returns a `TIMESTAMPTZ` as a `Date`, so the plain `!==` these used reported drift on every row
  // that had one set. Verified live against a real cluster; the offline fakes hand back strings,
  // which is why no test saw it.
  const timestampFields: Array<[string, unknown, string | null]> = [
    ["completed_at", stored.completed_at, expected.completedAt],
    ["failed_at", stored.failed_at, expected.failedAt],
    ["cancelled_at", stored.cancelled_at, expected.cancelledAt],
    ["suspended_at", stored.suspended_at, expected.suspendedAt],
    [
      "compensation_started_at",
      stored.compensation_started_at,
      expected.compensationStartedAt,
    ],
    [
      "compensation_completed_at",
      stored.compensation_completed_at,
      expected.compensationCompletedAt,
    ],
    [
      "cancellation_requested_at",
      storedCancellation.cancellationRequestedAt,
      expected.cancellationRequestedAt,
    ],
  ];
  for (const [name, storedValue, expectedValue] of timestampFields) {
    const storedInstant = isoInstant(storedValue);
    if (storedInstant !== (expectedValue === null ? null : isoInstant(expectedValue))) {
      fields.push({ field: name, stored: storedInstant, expected: expectedValue });
    }
  }
  const textFields: Array<[string, string | null, string | null]> = [
    [
      "cancellation_requested_by",
      storedCancellation.cancellationRequestedBy,
      expected.cancellationRequestedBy,
    ],
    [
      "cancellation_disposition",
      storedCancellation.cancellationDisposition,
      expected.cancellationDisposition,
    ],
  ];
  for (const [name, storedValue, expectedValue] of textFields) {
    if (storedValue !== expectedValue) {
      fields.push({ field: name, stored: storedValue, expected: expectedValue });
    }
  }
  // **Compared as a sequence, not as a set.** The projection builds this from a `Set` whose
  // insertion order is first-occurrence order over `listByInstance`, which orders by
  // `sequence_number` — unique per instance under `workflow_events_instance_sequence_key`, so the
  // order is a total and deterministic function of the log, and the only writer of the column is
  // `upsertProjection` from that same projection. A healthy row therefore matches element for
  // element, and a set comparison would be strictly weaker for no gain: it would pass a reordered
  // column that the healthy writer could never have produced. A stored value that is not a JSON
  // array of strings reads as drift rather than as emptiness, which is why the raw value is
  // reported.
  const storedIds = storedCancellation.cancellationSignalledActivityIds;
  if (storedIds === null || !sequenceEqual(storedIds, expected.cancellationSignalledActivityIds)) {
    fields.push({
      field: "cancellation_signalled_activity_ids",
      stored: storedIds ?? stored.cancellation_signalled_activity_ids,
      expected: expected.cancellationSignalledActivityIds,
    });
  }
  return { instanceMissing: false, instanceOrphaned: false, fields };
}

function sequenceEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

/** Takes the three fields it actually compares, so neither projection shape has to be asserted. */
interface ComparableActivity {
  readonly id: string;
  readonly status: string;
  readonly definitionActivityKey: string;
}

function compareActivityProjections(
  expected: readonly ComparableActivity[],
  stored: readonly StoredActivityRow[],
): ChildEntityDrift {
  const expectedById = new Map(expected.map((e) => [e.id, e] as const));
  const storedById = new Map(stored.map((s) => [s.activity_id, s] as const));
  const missingIds: string[] = [];
  const extraIds: string[] = [];
  const mismatchedIds: string[] = [];
  for (const [id, e] of expectedById) {
    const s = storedById.get(id);
    if (s === undefined) {
      missingIds.push(id);
      continue;
    }
    if (s.status !== e.status || s.definition_activity_key !== e.definitionActivityKey) {
      mismatchedIds.push(id);
    }
  }
  for (const id of storedById.keys()) {
    if (!expectedById.has(id)) extraIds.push(id);
  }
  return { missingIds, extraIds, mismatchedIds };
}

function compareSimpleProjections(
  expected: readonly { readonly id: string; readonly status: string }[],
  stored: readonly { readonly id: string; readonly status: string }[],
): ChildEntityDrift {
  const expectedById = new Map(expected.map((e) => [e.id, e] as const));
  const storedById = new Map(stored.map((s) => [s.id, s] as const));
  const missingIds: string[] = [];
  const extraIds: string[] = [];
  const mismatchedIds: string[] = [];
  for (const [id, e] of expectedById) {
    const s = storedById.get(id);
    if (s === undefined) {
      missingIds.push(id);
      continue;
    }
    if (s.status !== e.status) mismatchedIds.push(id);
  }
  for (const id of storedById.keys()) {
    if (!expectedById.has(id)) extraIds.push(id);
  }
  return { missingIds, extraIds, mismatchedIds };
}

