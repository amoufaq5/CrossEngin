import type { IdempotencyRecord } from "@crossengin/api-gateway";
import type {
  IdempotencyLookup,
  IdempotencyReservation,
  IdempotencyStore,
  StoredIdempotentResponse,
} from "@crossengin/api-gateway-runtime";
import type { PostgresIdempotencyStore } from "@crossengin/api-gateway-pg";

import type { ActiveTenantSource } from "./checkpoint-scheduler.js";
import type { IntervalHandle, IntervalScheduler } from "./jwks.js";

/**
 * The wiring boundary between the gateway pipeline and a durable idempotency store.
 *
 * `buildOperateGateway` defaults to `InMemoryIdempotencyStore`, which every deployment has had: the
 * replay guard is a `Map` in one process, so a retried `POST` that lands on a different replica —
 * or on the same replica after a restart or a deploy — is **not** deduplicated. That is not a
 * theoretical gap. `--tenant-deletion-routes` is the one route in this binary that *requires* an
 * idempotency key, and the reason recorded for it is that a retried delete mints a second tombstone
 * id, erases nothing the second time, and answers `409 scope_empty` for a request that had already
 * succeeded. Behind a single process the guard holds; behind two it does not exist.
 *
 * **The two halves of the store get opposite failure policies, and the split is the decision.**
 *
 * - `get` runs at stage 10, *before* the handler. A failure means the gateway cannot tell whether
 *   this request is a replay, and the fail-closed answer to that is to not execute: the throw
 *   propagates, the request is refused, and nothing has happened. Exactly `processJobBatch`'s
 *   `cancellation_unknown` — nothing is done yet, so deferring costs nothing.
 * - `reserve` runs at stage 10 too, and propagates for the same reason: a reservation that could
 *   not be established is a request this gateway cannot run exactly once.
 * - `complete` (and `put`) run *after* `dispatch_handler` has returned and the handler's own
 *   transaction has committed. A throw there turns a 2xx into a 500 for work that succeeded, and a client that
 *   retries a 500 gets the second execution — with no record to stop it, because the record is the
 *   thing that failed to write. Throwing therefore **causes** the harm it would be protecting
 *   against, so the failure is reported and swallowed: ADR-0333's rule, where the chain entry has
 *   committed and raising would turn a successful pass into a failed one to protect a projection.
 *
 * Swallowing is a hole, so it is said out loud rather than absorbed: the first failure is logged in
 * full, every one is counted, and `report()` is what a shutdown or a health line prints. A silent
 * swallow would be the surface-reports-success-and-records-nothing class this exists to close.
 */
/**
 * Which call failed. A lost `release` and a lost record are different facts with different
 * consequences — the first answers the next retry 409 until the lease lapses, the second lets it
 * re-execute — so a reporter has to be told which it is to say the right one.
 */
export type IdempotencyPersistOperation = "reserve" | "complete" | "release" | "put";

export interface ReportingIdempotencyStoreOptions {
  /** Receives every persist failure. The first is logged in full by the default wiring. */
  readonly onPersistError?: (
    err: unknown,
    input: { readonly tenantId: string; readonly key: string; readonly operation: IdempotencyPersistOperation },
  ) => void;
}

export interface IdempotencyPersistReport {
  /** Records written without error. */
  readonly persisted: number;
  /** Mutations whose dedup record could not be stored — each one a retry that would re-execute. */
  readonly failed: number;
  /**
   * Reservations that could not be given back. Not in `failed`: nothing re-executes because of one,
   * the key answers in progress until its lease lapses. Releases that succeed are counted nowhere,
   * because a release stores no record and `persisted` is a count of records.
   */
  readonly releaseFailed: number;
  /** The first failure's message, kept because a count alone does not say what went wrong. */
  readonly firstFailure: string | null;
}

const FOREIGN_KEY_VIOLATION = "23503";

export class ReportingIdempotencyStore implements IdempotencyStore {
  private persisted = 0;
  private failed = 0;
  private releaseFailed = 0;
  private firstFailure: string | null = null;

  constructor(
    private readonly inner: IdempotencyStore,
    private readonly opts: ReportingIdempotencyStoreOptions = {},
  ) {}

  /** Propagates. Not knowing whether this is a replay must not admit the request. */
  async get(input: { readonly tenantId: string; readonly key: string }): Promise<IdempotencyLookup | null> {
    return this.inner.get(input);
  }

  /**
   * Propagates, for `get`'s reason: no reservation means no guarantee, so the request is refused —
   * with one exception. A foreign-key refusal says the tenant has no `meta.tenants` row, so no
   * record for it can ever exist and refusing would turn every keyed request from that tenant into
   * a 500 ahead of the tenant-status gate's named 403 (measured live). That request proceeds
   * unguarded and reported, which is exactly what it was before reservations existed; the gate,
   * on by default, refuses it a stage later.
   */
  async reserve(input: {
    readonly tenantId: string;
    readonly record: IdempotencyRecord;
  }): Promise<IdempotencyReservation> {
    try {
      return await this.inner.reserve(input);
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code !== FOREIGN_KEY_VIOLATION) throw err;
      this.failed += 1;
      this.firstFailure ??= err instanceof Error ? err.message : String(err);
      this.opts.onPersistError?.(err, {
        tenantId: input.tenantId,
        key: input.record.idempotencyKey,
        operation: "reserve",
      });
      return { reserved: true };
    }
  }

  /** Reported and swallowed, for `put`'s reason: the handler has committed. */
  async complete(input: {
    readonly tenantId: string;
    readonly record: IdempotencyRecord;
    readonly replay: StoredIdempotentResponse | null;
  }): Promise<void> {
    try {
      await this.inner.complete(input);
      this.persisted += 1;
    } catch (err) {
      this.failed += 1;
      this.firstFailure ??= err instanceof Error ? err.message : String(err);
      this.opts.onPersistError?.(err, {
        tenantId: input.tenantId,
        key: input.record.idempotencyKey,
        operation: "complete",
      });
    }
  }

  /**
   * Reported and swallowed. A release follows a request that changed nothing, so a lost one costs
   * the next retry a 409 until the reservation's lease lapses — never a second execution.
   */
  async release(input: {
    readonly tenantId: string;
    readonly key: string;
    readonly requestHashSha256: string;
  }): Promise<void> {
    try {
      await this.inner.release(input);
    } catch (err) {
      this.releaseFailed += 1;
      this.opts.onPersistError?.(err, { tenantId: input.tenantId, key: input.key, operation: "release" });
    }
  }

  async put(input: { readonly tenantId: string; readonly record: IdempotencyRecord }): Promise<void> {
    try {
      await this.inner.put(input);
      this.persisted += 1;
    } catch (err) {
      this.failed += 1;
      if (this.firstFailure === null) {
        this.firstFailure = err instanceof Error ? err.message : String(err);
      }
      this.opts.onPersistError?.(err, {
        tenantId: input.tenantId,
        key: input.record.idempotencyKey,
        operation: "put",
      });
    }
  }

  /**
   * Delegated unchanged, failure included. `GatewayRuntime` never calls it — it reserves, completes
   * and releases — so applying `put`'s post-effect reasoning here would be inventing a policy for a
   * call that is not made. A caller that appears later should decide for itself.
   */
  async update(input: {
    readonly tenantId: string;
    readonly key: string;
    readonly mutate: (rec: IdempotencyRecord) => IdempotencyRecord;
  }): Promise<IdempotencyRecord> {
    return this.inner.update(input);
  }

  report(): IdempotencyPersistReport {
    return {
      persisted: this.persisted,
      failed: this.failed,
      releaseFailed: this.releaseFailed,
      firstFailure: this.firstFailure,
    };
  }
}

/**
 * What this store does and does not guarantee, as one sentence a boot line can print.
 *
 * It used to be weaker: the gateway read the key, ran the handler, and only then wrote a record, so
 * two *concurrent* retries both read "unseen" and both executed. The gateway now reserves the key in
 * one conditional upsert before the handler runs, so the second concurrent retry is answered
 * `409` in progress. What it still is not is exactly-once under a lapsed lease: a handler that runs
 * past the reservation's lease lets a retry take the key over, and an unanchored release that is
 * lost leaves the key answering in progress until that lease lapses.
 */
export const IDEMPOTENCY_GUARANTEE =
  "deduplicates retries across replicas and restarts and answers a concurrent retry 409 in progress; a handler outliving its 300 s lease can be re-executed by a retry";

/**
 * `meta.gateway_idempotency_records.tenant_id` is `NOT NULL` and references `meta.tenants`, exactly
 * as `gateway_pipeline_executions.tenant_id` does — so `CAPTURE_FK_HINT`'s configuration hazard
 * applies here too, and here it is **worse**.
 *
 * On a deployment whose credentials come from `--api-key 'key:role:tenant'` naming a UUID with no
 * `meta.tenants` row, every `put` fails its foreign key. Because `put` is reported and swallowed —
 * which it must be, for the reason in this module's header — the failure is not a 500 and not a
 * refused request: it is a **replay guard that is mounted, logged as working, and stores nothing**,
 * so a retried mutation re-executes exactly as it did with the in-memory store. The capture's
 * equivalent failure merely loses an observation; this one loses the guarantee the flag was turned
 * on for.
 *
 * So it is said at boot rather than discovered from a counter. `surveyUserFkReadiness`' sibling
 * tenant survey already names the unprovisioned tenants; this is the sentence that connects them to
 * this flag.
 */
export const IDEMPOTENCY_FK_HINT =
  "meta.gateway_idempotency_records.tenant_id references meta.tenants: an --api-key tenant with no tenants row cannot reserve a key, so its requests run unguarded (and the tenant-status gate refuses them)";

export interface IdempotencyPruneResult {
  readonly tenantsSwept: number;
  readonly deleted: number;
  /** Tenants whose sweep threw. One tenant's failure never stops the rest. */
  readonly failures: readonly { readonly tenantId: string; readonly message: string }[];
}

/**
 * Drops every active tenant's lapsed idempotency records.
 *
 * A loop here rather than one unscoped `DELETE` in the store, because `deleteExpired` takes a
 * required scope: as the table's owner an unscoped delete reaps every tenant's rows while naming
 * none, and as a non-owner RLS confines it to nothing and reports 0 — which a reaper cannot tell
 * from a table that is already clean. The scope is a fact the caller holds, so the caller supplies
 * it.
 *
 * Without this the table only grows: records are read for one TTL (a day by default) and never
 * again. A per-tenant failure is collected and the sweep continues — one tenant's bad row must not
 * stop the others, the rule `drainAllTenants` follows for delivery.
 */
export async function pruneIdempotencyRecords(opts: {
  readonly store: Pick<PostgresIdempotencyStore, "deleteExpired">;
  readonly tenants: ActiveTenantSource;
  readonly now?: () => Date;
}): Promise<IdempotencyPruneResult> {
  const now = (opts.now ?? (() => new Date()))();
  const ids = await opts.tenants.activeTenantIds();
  const failures: { tenantId: string; message: string }[] = [];
  let deleted = 0;
  for (const tenantId of ids) {
    try {
      deleted += await opts.store.deleteExpired(now, tenantId);
    } catch (err) {
      failures.push({ tenantId, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { tenantsSwept: ids.length, deleted, failures };
}

const DEFAULT_SCHEDULER: IntervalScheduler = {
  setInterval(handler, ms) {
    const h = setInterval(handler, ms);
    (h as { unref?: () => void }).unref?.(); // never hold the process open
    return h;
  },
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

/**
 * Hourly. Deliberately **not** a flag.
 *
 * A durable idempotency store that needs a second opt-in to stop growing is a feature with a trap
 * in it: the records are read for one TTL and never again, so an unpruned table accumulates every
 * keyed mutation the deployment has ever served. Mounting the store is therefore mounting the
 * reaper, and an hour is well inside the day-long default TTL while being far cheaper than the
 * traffic that fills it.
 */
export const DEFAULT_IDEMPOTENCY_PRUNE_MS = 3_600_000;

export interface IdempotencyPruneSchedulerOptions {
  readonly store: Pick<PostgresIdempotencyStore, "deleteExpired">;
  readonly tenants: ActiveTenantSource;
  readonly intervalMs?: number;
  readonly scheduler?: IntervalScheduler;
  readonly now?: () => Date;
  readonly onError?: (err: unknown) => void;
  readonly onSwept?: (result: IdempotencyPruneResult) => void;
}

/**
 * Reaps lapsed idempotency records on a timer, alongside `PruneScheduler` and `JobScheduler` and
 * following their shape: the timer is `unref`'d, every tick re-enumerates the active tenants so a
 * newly provisioned one is picked up, and a failed sweep is routed to `onError` rather than thrown
 * out of a timer callback.
 *
 * It sweeps at boot like its siblings — unlike `DeletionScheduler`, which deliberately does not,
 * because that one destroys a tenant's data irreversibly. This one deletes rows the gateway has
 * already stopped reading.
 */
export class IdempotencyPruneScheduler {
  private handle: IntervalHandle | null = null;

  constructor(private readonly opts: IdempotencyPruneSchedulerOptions) {}

  start(): void {
    if (this.handle !== null) return;
    void this.sweepOnce();
    this.handle = this.scheduler().setInterval(
      () => void this.sweepOnce(),
      this.opts.intervalMs ?? DEFAULT_IDEMPOTENCY_PRUNE_MS,
    );
  }

  stop(): void {
    if (this.handle === null) return;
    this.scheduler().clearInterval(this.handle);
    this.handle = null;
  }

  async sweepOnce(): Promise<void> {
    try {
      const result = await pruneIdempotencyRecords({
        store: this.opts.store,
        tenants: this.opts.tenants,
        ...(this.opts.now !== undefined ? { now: this.opts.now } : {}),
      });
      this.opts.onSwept?.(result);
    } catch (err) {
      this.opts.onError?.(err);
    }
  }

  private scheduler(): IntervalScheduler {
    return this.opts.scheduler ?? DEFAULT_SCHEDULER;
  }
}
