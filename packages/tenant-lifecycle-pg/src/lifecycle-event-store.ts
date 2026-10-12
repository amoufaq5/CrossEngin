import { scopeFilter, type PgConnection } from "@crossengin/kernel-pg";
import {
  ACTION_TARGET_STATE,
  LIFECYCLE_ACTIONS,
  LifecycleEventSchema,
  TenantLifecycleStateSchema,
  actionRequiresFourEyes,
  canTransitionLifecycle,
  type ActionTrigger,
  type LifecycleAction,
  type LifecycleEvent,
  type TenantLifecycleState,
} from "@crossengin/tenant-lifecycle";
import { SET_TENANT_CONTEXT_SQL } from "./tenant-context.js";

/**
 * `meta.tenant_lifecycle_events` — the trail, and the writer it never had.
 *
 * The sentence that makes this load-bearing is in the Article 17 erasure's own source:
 * `PLATFORM_RECORD_TABLES` protects this table from the shared-table erasure with the note
 * *"without it nothing in the database distinguishes a tenant that was deleted from one that never
 * existed"*. The protection has been vacuous since Phase 1, because the table is empty in every
 * deployment — ADR-0334's census classifies it `unwritten_table` — and so is the whole of
 * `actions.ts`: `LIFECYCLE_ACTIONS`, `ACTION_TARGET_STATE`, `LifecycleEventSchema`,
 * `actionRequiresFourEyes`, `eventChain` and `lastEvent` have **no consumer in the workspace**. That
 * is ADR-0334's finding about `states.ts` repeated in the sibling file, which nobody looked at.
 *
 * ## What the catalog could not hold
 *
 * Three defects, each established against a live cluster rather than read off the declaration.
 *
 * **1. `tenant_id` is `ON DELETE CASCADE` into `meta.tenants`, so the trail cannot exist.** Both
 * directions are closed by that one constraint, and they were measured:
 *
 *   - An event written *before* the tenant row is retired is destroyed *with* it. `1` row before the
 *     `DELETE FROM meta.tenants`, `0` after.
 *   - An event written *after* retirement raises
 *     `violates foreign key constraint "tenant_lifecycle_events_tenant_id_fkey"`.
 *
 * ADR-0316's ordering retires the tenant row once the erasure commits, so there is **no point in the
 * sequence at which a durable `… -> deleted` event can exist**. The table whose purpose is to
 * distinguish a deleted tenant from one that never existed is, by its own foreign key, incapable of
 * making that distinction. `meta.tenant_tombstones.tenant_id` carries **no** reference for exactly
 * this reason (ADR-0318) and is the only one of the sixteen `PLATFORM_RECORD_TABLES` that does; the
 * other fifteen are all `CASCADE` children of `meta.tenants`.
 *
 * **2. `actor_user_id` and `approved_by_user_id` are `UUID … ON DELETE RESTRICT` into `meta.users`,
 * which nothing writes.** So no event naming a human can be inserted in any deployment — measured as
 * `Key (actor_user_id)=(…) is not present in table "users"` against `count(*) = 0`. And the contract's
 * `actorUserId` is `z.string().min(1)`, free text, so a non-UUID actor fails at the bind with
 * `invalid input syntax for type uuid`. The repo has twice concluded a `RESTRICT` reference into
 * `meta.users` is wrong for an actor column and made it TEXT (ADR-0318, ADR-0321); this is the third
 * instance and the same conclusion. Because `execute_deletion` *must* carry four-eyes approval by
 * contract, the single transition that matters most was unwritable on both counts at once.
 *
 * **3. There is no platform read arm.** One `ALL`-scope isolation policy, so after the tenant is gone
 * there is no session left to satisfy it — ADR-0318's finding for the tombstone, in the table whose
 * rows are *only* ever read after the subject is gone.
 *
 * This store is written against the catalog those three patches produce. `probeLifecycleTrail` is the
 * loud half: a deployment running the unpatched catalog gets a named verdict at boot rather than a
 * trail that appears to be written and vanishes, which is the one failure nothing downstream can see.
 *
 * ## Append-only, before the statement is composed
 *
 * The whole table is append-only — one row per event, nothing to correct — so, unlike the incident
 * timeline's `assertAppendOnly`, there is no before/after to compare. The enforcement is at the other
 * end: `assertAppendOnlyStatement` refuses any statement this store would issue that is not a plain
 * `INSERT`, and that includes `ON CONFLICT … DO UPDATE`, which is an append in its syntax and a
 * rewrite in its effect. It costs one call and it is what catches the method somebody adds later to
 * "fix the reason on that row" — a trail that can be rewritten is worth less than none, because its
 * readers cannot tell which it is.
 */

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** The most rows one `listForTenant` or `scanAll` page may hold. */
export const LIFECYCLE_EVENT_MAX_LIMIT = 500;

export const LIFECYCLE_EVENT_COLUMNS = [
  "id",
  "tenant_id",
  "action",
  "from_state",
  "to_state",
  "trigger",
  "occurred_at",
  "actor_user_id",
  "actor_system_id",
  "reason",
  "customer_notified_at",
  "notification_channel",
  "requires_four_eyes_approval",
  "approved_by_user_id",
  "approved_at",
  "related_incident_id",
  "notes",
] as const;

/**
 * Which producer writes each lifecycle action — a **total map** over `LIFECYCLE_ACTIONS`, so a
 * ninth action is a compile error rather than a member inheriting whichever answer a loop gave it.
 *
 * It exists because only one of the seven is wired, and a half-populated trail that *looks* complete
 * is worse than an obviously partial one: a reader seeing a lone `execute_deletion` would conclude a
 * tenant was deleted from nowhere. `lifecycleTrailGaps` turns this into the sentence a boot log
 * prints. Same shape and same purpose as `JOB_KIND_PRODUCERS` (ADR-0334).
 *
 * `"none"` is a *declaration* that nothing enqueues this action, not a to-do: `cancel_deletion`
 * targets `archived` (`ACTION_TARGET_STATE`), and the only route that un-schedules a deletion —
 * ADR-0334's deletion-request reject — returns the tenant to `active`, which is `restore`. So
 * `cancel_deletion` has no producer by design rather than by omission, and naming a fix that would
 * not work is worse than naming none.
 */
export const LIFECYCLE_ACTION_PRODUCERS: Readonly<Record<LifecycleAction, string>> = Object.freeze({
  activate: "operate-server/platform-admin",
  suspend: "operate-server/platform-admin",
  restore: "operate-server/deletion-request-routes",
  archive: "operate-server/platform-admin",
  schedule_deletion: "operate-server/deletion-request-routes",
  cancel_deletion: "none",
  execute_deletion: "tenant-lifecycle-pg/deletion-pipeline",
});

/** The actions whose producer is `"none"` — the trail's declared gaps. */
export function lifecycleTrailGaps(): readonly LifecycleAction[] {
  return LIFECYCLE_ACTIONS.filter((a) => LIFECYCLE_ACTION_PRODUCERS[a] === "none");
}

export const LIFECYCLE_EVENT_REFUSALS = [
  "invalid_event_id",
  "invalid_tenant_id",
  "contract_violated",
  "four_eyes_required",
  "four_eyes_violated",
  "not_append_only",
  "tenant_state_unresolvable",
] as const;
export type LifecycleEventRefusal = (typeof LIFECYCLE_EVENT_REFUSALS)[number];

export class LifecycleEventRefused extends Error {
  readonly refusal: LifecycleEventRefusal;

  constructor(refusal: LifecycleEventRefusal, detail: string) {
    super(`refusing to append lifecycle event: ${detail}`);
    this.name = "LifecycleEventRefused";
    this.refusal = refusal;
  }
}

/**
 * Refuses a statement that is not an append.
 *
 * `ON CONFLICT … DO UPDATE` is checked separately from the leading verb because it is the one shape
 * that *reads* as an append: `INSERT` first word, rewrite in effect. `DO NOTHING` is fine — it adds a
 * row or leaves the existing one exactly as it was, which is what append-only means.
 */
export function assertAppendOnlyStatement(sql: string): void {
  const normalised = sql.replace(/\s+/g, " ").trim().toUpperCase();
  if (!normalised.startsWith("INSERT ")) {
    throw new LifecycleEventRefused(
      "not_append_only",
      `the lifecycle trail is append-only; refusing a non-INSERT statement: ${sql.slice(0, 80)}`,
    );
  }
  if (normalised.includes("DO UPDATE")) {
    throw new LifecycleEventRefused(
      "not_append_only",
      "the lifecycle trail is append-only; `ON CONFLICT … DO UPDATE` rewrites a recorded event",
    );
  }
}

export interface LifecycleEventStoreOptions {
  readonly schema?: string;
}

function isoOf(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return isoOf(value);
}

function textOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/**
 * One row back into an event, re-parsed through `LifecycleEventSchema`.
 *
 * Throws on a row the contract cannot represent, which is the behaviour the readers want (ADR-0289).
 * It is not theoretical here: the catalog's `from_state`/`to_state` CHECKs still list the **seven**
 * states ADR-0334 narrowed to five, so `trial` and `past_due` are accepted by the column and refused
 * by the contract. A row holding one is a finding — nothing can have produced it legitimately — and a
 * shorter answer would hide it.
 */
export function rowToLifecycleEvent(row: Record<string, unknown>): LifecycleEvent {
  const candidate: Record<string, unknown> = {
    id: String(row["id"]),
    tenantId: String(row["tenant_id"]),
    action: String(row["action"]) as LifecycleAction,
    fromState: String(row["from_state"]) as TenantLifecycleState,
    toState: String(row["to_state"]) as TenantLifecycleState,
    trigger: String(row["trigger"]) as ActionTrigger,
    occurredAt: isoOf(row["occurred_at"]),
    actorUserId: textOrNull(row["actor_user_id"]),
    actorSystemId: textOrNull(row["actor_system_id"]),
    reason: String(row["reason"]),
    customerNotifiedAt: isoOrNull(row["customer_notified_at"]),
    notificationChannel: String(row["notification_channel"]),
    requiresFourEyesApproval: row["requires_four_eyes_approval"] === true,
    approvedByUserId: textOrNull(row["approved_by_user_id"]),
    approvedAt: isoOrNull(row["approved_at"]),
  };
  const incident = textOrNull(row["related_incident_id"]);
  if (incident !== null) candidate["relatedIncidentId"] = incident;
  const notes = textOrNull(row["notes"]);
  if (notes !== null) candidate["notes"] = notes;
  return LifecycleEventSchema.parse(candidate);
}

export interface LifecycleEventInput {
  readonly id: string;
  readonly tenantId: string;
  readonly action: LifecycleAction;
  readonly fromState: TenantLifecycleState;
  readonly trigger: ActionTrigger;
  readonly occurredAt: string;
  readonly reason: string;
  readonly actorUserId?: string | null;
  readonly actorSystemId?: string | null;
  readonly approvedByUserId?: string | null;
  readonly approvedAt?: string | null;
  readonly customerNotifiedAt?: string | null;
  readonly notificationChannel?: "email" | "in_app" | "phone" | "none";
  readonly relatedIncidentId?: string;
  readonly notes?: string;
}

/**
 * Builds the event for one transition, deriving everything derivable.
 *
 * `toState` comes from `ACTION_TARGET_STATE` and is **never** a parameter: the action and the target
 * state are one fact, and the schema already refuses a pair that disagrees — so accepting both would
 * only create a way to be refused. `requiresFourEyesApproval` comes from `actionRequiresFourEyes`,
 * which until now had no consumer at all; deriving it rather than accepting it is what makes the rule
 * reach the row, since a caller passing `false` for an `archive` under a `compliance_directive` would
 * otherwise record an unapproved privileged act as an approved-not-required one.
 */
export function lifecycleEventFor(input: LifecycleEventInput): LifecycleEvent {
  const requires = actionRequiresFourEyes(input.action, input.trigger);
  return LifecycleEventSchema.parse({
    id: input.id,
    tenantId: input.tenantId,
    action: input.action,
    fromState: input.fromState,
    toState: ACTION_TARGET_STATE[input.action],
    trigger: input.trigger,
    occurredAt: input.occurredAt,
    actorUserId: input.actorUserId ?? null,
    actorSystemId: input.actorSystemId ?? null,
    reason: input.reason,
    customerNotifiedAt: input.customerNotifiedAt ?? null,
    notificationChannel: input.notificationChannel ?? "email",
    requiresFourEyesApproval: requires,
    approvedByUserId: input.approvedByUserId ?? null,
    approvedAt: input.approvedAt ?? null,
    ...(input.relatedIncidentId !== undefined
      ? { relatedIncidentId: input.relatedIncidentId }
      : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
  });
}

export class PostgresLifecycleEventStore {
  private readonly conn: PgConnection;
  private readonly schema: string;

  constructor(conn: PgConnection, opts: LifecycleEventStoreOptions = {}) {
    const schema = opts.schema ?? "meta";
    if (!SCHEMA_RE.test(schema)) {
      throw new Error(`invalid schema identifier: ${JSON.stringify(schema)}`);
    }
    this.conn = conn;
    this.schema = schema;
  }

  private get table(): string {
    return `${this.schema}.tenant_lifecycle_events`;
  }

  /** Appends one event. Own transaction; see `appendWithin` for the pipeline's seam. */
  async append(event: LifecycleEvent): Promise<LifecycleEvent> {
    this.assertAppendable(event);
    return this.conn.transaction(async (tx) => this.insertWithin(tx, event));
  }

  /**
   * The same append, inside a transaction the caller owns.
   *
   * This is what lets the `… -> deleted` event commit with the erasure and the tombstone that record
   * it (ADR-0319), following `appendWithin`'s and `writeWithin`'s precedent in this package. The
   * ordering argument is in `deletion-pipeline.ts`; what matters here is that refusals are raised
   * **before** the caller's transaction is touched, so a refused append leaves whatever else the
   * caller had done intact and rollback-able on its own terms.
   */
  async appendWithin(tx: PgConnection, event: LifecycleEvent): Promise<LifecycleEvent> {
    this.assertAppendable(event);
    return this.insertWithin(tx, event);
  }

  /**
   * Everything refusable about an append, settled before any statement is sent.
   *
   * The four-eyes rule is enforced here as the **second of three layers**, ADR-0318's deliberate
   * redundancy: the contract refuses it in `superRefine`, this refuses it before the SQL is composed,
   * and the column CHECK refuses it where the write lands. The only way a privileged act stays
   * privileged is if the check holds at the point of the write.
   *
   * `four_eyes_required` is the one thing the contract does **not** answer. `LifecycleEventSchema`
   * hard-requires approval for `execute_deletion` only, while `actionRequiresFourEyes` also demands it
   * for an `archive` under a `compliance_directive` and a `schedule_deletion` by a `platform_admin`.
   * Without this check that function stays what it was before this store existed: a rule with no
   * reader.
   */
  private assertAppendable(event: LifecycleEvent): void {
    if (!UUID_RE.test(event.id)) {
      // `LifecycleEvent.id` is `z.string().min(1)` and the column is `UUID` with a
      // `uuid_generate_v7()` default — unlike the tombstone, which carries a TEXT `tombstone_id`
      // beside a surrogate key. The id is written rather than left to the default because a caller
      // that cannot name the event it just appended cannot join it to anything; refusing here means
      // the mismatch reads as a statement about the id instead of as a syntax error from the bind.
      throw new LifecycleEventRefused(
        "invalid_event_id",
        `the id column is UUID, so the event id must be a uuid, got ${JSON.stringify(event.id)}`,
      );
    }
    if (!UUID_RE.test(event.tenantId)) {
      // The column is UUID; a contract that accepts free text would otherwise fail at the bind with
      // a message about syntax rather than about the tenant.
      throw new LifecycleEventRefused(
        "invalid_tenant_id",
        `tenantId must be a uuid, got ${JSON.stringify(event.tenantId)}`,
      );
    }
    // Re-parsed rather than trusted: a caller can construct the type without going through the
    // schema, and this is the last place the contract can be asked.
    const parsed = LifecycleEventSchema.safeParse(event);
    if (!parsed.success) {
      throw new LifecycleEventRefused(
        "contract_violated",
        `the event does not satisfy LifecycleEventSchema: ${parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }
    if (actionRequiresFourEyes(event.action, event.trigger) && !event.requiresFourEyesApproval) {
      throw new LifecycleEventRefused(
        "four_eyes_required",
        `action '${event.action}' under trigger '${event.trigger}' requires four-eyes approval,` +
          " and this event records it as not required",
      );
    }
    if (
      event.requiresFourEyesApproval &&
      event.approvedByUserId !== null &&
      event.actorUserId !== null &&
      event.approvedByUserId === event.actorUserId
    ) {
      throw new LifecycleEventRefused(
        "four_eyes_violated",
        "approver must differ from the actor (four-eyes principle)",
      );
    }
  }

  private async insertWithin(tx: PgConnection, event: LifecycleEvent): Promise<LifecycleEvent> {
    // The write needs the event's own tenant in scope, and this is not a formality — it was the
    // defect, observed live as a non-owner role: `tenant_lifecycle_events_isolation` is the only
    // policy with a `WITH CHECK` (the platform arm is `SELECT`-scoped, ADR-0332), so an `INSERT`
    // from a platform route — which is where every console transition comes from, with no tenant
    // context of its own — raised `42501 new row violates row-level security policy` and the trail
    // recorded nothing while the transition itself succeeded. Reported as `lifecycleRecorded:
    // false` on a 200, which is honest and also exactly the silence this table exists to end.
    //
    // Set here rather than asked of the caller, because the row *names* its tenant: there is no
    // platform-scope lifecycle event (`tenantId` is required and a UUID), so the right scope is
    // never ambiguous and a caller that had to supply it could supply a different one.
    // Transaction-local (`set_config(…, true)`), so `appendWithin` inside the deletion pipeline's
    // transaction cannot leak a scope past the commit — and it sets the same tenant that
    // transaction is already erasing.
    await tx.query(SET_TENANT_CONTEXT_SQL, [event.tenantId]);
    const columns = LIFECYCLE_EVENT_COLUMNS.join(", ");
    const placeholders = LIFECYCLE_EVENT_COLUMNS.map((c, i) => {
      const n = `$${(i + 1).toString()}`;
      // `INSERT … VALUES` with an unknown-typed parameter infers `text`, so the non-text columns are
      // cast. Same reasoning as the tombstone store's cast map.
      if (c === "id" || c === "tenant_id") return `${n}::uuid`;
      if (c === "occurred_at" || c === "customer_notified_at" || c === "approved_at") {
        return `${n}::timestamptz`;
      }
      if (c === "requires_four_eyes_approval") return `${n}::boolean`;
      return n;
    }).join(", ");

    const sql = `INSERT INTO ${this.table} (${columns}) VALUES (${placeholders})`;
    // Before the statement reaches the database, not after: the guard's job is to catch the method
    // somebody adds later, and a check downstream of `tx.query` would already have written.
    assertAppendOnlyStatement(sql);
    await tx.query(sql, [
      event.id,
      event.tenantId,
      event.action,
      event.fromState,
      event.toState,
      event.trigger,
      event.occurredAt,
      event.actorUserId,
      event.actorSystemId,
      event.reason,
      event.customerNotifiedAt,
      event.notificationChannel,
      event.requiresFourEyesApproval,
      event.approvedByUserId,
      event.approvedAt,
      event.relatedIncidentId ?? null,
      event.notes ?? null,
    ]);
    return event;
  }

  /**
   * One tenant's trail, oldest first — the order `eventChain` puts it in, asked of the index rather
   * than of the process.
   *
   * **Scoped beside RLS**, because a table's owner bypasses its policies and connecting as the owner
   * is an ordinary deployment (ADR-0331, ADR-0333). `scopeFilter` — the **strict** spelling — because
   * `tenant_id` is `NOT NULL` here: there is no platform-scope lifecycle event and there cannot be
   * one, since an event is about exactly one tenant by construction. The inclusive
   * `scopeFilterWithPlatform` would add an arm that matches no row and read as a declaration that
   * such a row exists, which is the category error rather than the behaviour.
   *
   * Ordered on `(occurred_at, id)` and not `occurred_at` alone: two transitions can share a
   * timestamp — the deletion pipeline's own event and whatever else the same transaction wrote — and
   * a trail ordered on a key with ties reads back in an order the database is free to change.
   */
  async listForTenant(tenantId: string, limit = 100): Promise<readonly LifecycleEvent[]> {
    const scope = scopeFilter(tenantId);
    const bound = Math.max(1, Math.min(LIFECYCLE_EVENT_MAX_LIMIT, Math.trunc(limit)));
    const result = await this.conn.query<Record<string, unknown>>(
      `SELECT ${LIFECYCLE_EVENT_COLUMNS.join(", ")} FROM ${this.table}` +
        ` WHERE ${scope.sql} ORDER BY occurred_at, id LIMIT $${(scope.params.length + 1).toString()}`,
      [...scope.params, bound],
    );
    return result.rows.map((row) => rowToLifecycleEvent(row));
  }

  /** The most recent event for one tenant, or null. `lastEvent`'s question, asked of the index. */
  async latestForTenant(tenantId: string): Promise<LifecycleEvent | null> {
    const scope = scopeFilter(tenantId);
    const result = await this.conn.query<Record<string, unknown>>(
      `SELECT ${LIFECYCLE_EVENT_COLUMNS.join(", ")} FROM ${this.table}` +
        ` WHERE ${scope.sql} ORDER BY occurred_at DESC, id DESC LIMIT 1`,
      [...scope.params],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToLifecycleEvent(row);
  }

  /**
   * One tenant's trail read under the platform grant — the only read that works after the tenant is
   * gone, and the reason this table needs a `SELECT`-scoped platform policy at all.
   *
   * ADR-0318's argument, in the table it applies to most directly: a lifecycle trail is read
   * *because* the subject no longer exists, so the isolation policy serves it for exactly the readers
   * who do not need it. The scope predicate is still carried — the elevation answers "may this
   * session see other scopes", not "which scope was asked for" — so this reads one tenant's trail and
   * not every tenant's.
   *
   * `app.platform_audit` and not a write grant: the policy is `SELECT`-scoped, so the elevation
   * cannot become the ability to forge a transition (ADR-0313).
   */
  async readTrailAsPlatform(tenantId: string, limit = 100): Promise<readonly LifecycleEvent[]> {
    const scope = scopeFilter(tenantId);
    const bound = Math.max(1, Math.min(LIFECYCLE_EVENT_MAX_LIMIT, Math.trunc(limit)));
    return this.conn.transaction(async (tx) => {
      await tx.query("SELECT set_config('app.platform_audit', 'on', true)");
      const result = await tx.query<Record<string, unknown>>(
        `SELECT ${LIFECYCLE_EVENT_COLUMNS.join(", ")} FROM ${this.table}` +
          ` WHERE ${scope.sql} ORDER BY occurred_at, id LIMIT $${(scope.params.length + 1).toString()}`,
        [...scope.params, bound],
      );
      return result.rows.map((row) => rowToLifecycleEvent(row));
    });
  }

  /**
   * Every tenant this platform has a trail for, with its last recorded transition — the
   * cross-tenant question, which no scope predicate can answer and which the isolation policy
   * cannot serve at all.
   *
   * This is the read that makes the table's purpose true: a tenant with a trail ending in
   * `execute_deletion` and no `meta.tenants` row **is** a tenant that was deleted, and one with no
   * row and no trail is one that never existed. Nothing else in the database answers that.
   */
  async deletedTenants(limit = 100): Promise<readonly LifecycleEvent[]> {
    const bound = Math.max(1, Math.min(LIFECYCLE_EVENT_MAX_LIMIT, Math.trunc(limit)));
    return this.conn.transaction(async (tx) => {
      await tx.query("SELECT set_config('app.platform_audit', 'on', true)");
      const result = await tx.query<Record<string, unknown>>(
        `SELECT ${LIFECYCLE_EVENT_COLUMNS.join(", ")} FROM ${this.table}` +
          " WHERE to_state = 'deleted' ORDER BY occurred_at DESC, id DESC LIMIT $1",
        [bound],
      );
      return result.rows.map((row) => rowToLifecycleEvent(row));
    });
  }
}

/**
 * The tenant's current state, read from the row rather than accepted from the caller.
 *
 * ADR-0328's rule in a second place: the scope of an Article 17 proof is a property of the
 * deployment and not of the request body, and so is a transition's `fromState`. A caller-supplied one
 * lets the request choose what the trail says happened, which is the defect that ADR said was worse
 * than the one it was closing.
 *
 * Returns `null` when the row is absent, which the pipeline treats as a refusal rather than
 * substituting `active`: fabricating the state a tenant was in is ADR-0317's silence in a new field.
 * The state is parsed through `TenantLifecycleStateSchema`, so the column's still-seven-value CHECK
 * cannot smuggle a `trial` or a `past_due` into the trail.
 */
export async function readTenantState(
  tx: PgConnection,
  tenantId: string,
  schema = "meta",
): Promise<TenantLifecycleState | null> {
  if (!SCHEMA_RE.test(schema)) {
    throw new Error(`invalid schema identifier: ${JSON.stringify(schema)}`);
  }
  if (!UUID_RE.test(tenantId)) {
    throw new LifecycleEventRefused("invalid_tenant_id", "tenantId must be a uuid");
  }
  const result = await tx.query<{ status: unknown }>(
    `SELECT status FROM ${schema}.tenants WHERE id = $1::uuid`,
    [tenantId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const parsed = TenantLifecycleStateSchema.safeParse(String(row.status));
  if (!parsed.success) {
    throw new LifecycleEventRefused(
      "tenant_state_unresolvable",
      `meta.tenants.status holds ${JSON.stringify(String(row.status))}, which is not a` +
        " TENANT_LIFECYCLE_STATES member — the column's CHECK is wider than the contract",
    );
  }
  return parsed.data;
}

/**
 * Whether the recorded transition is one the state machine permits.
 *
 * Reported, never refused, and that is the decision. `LifecycleEventSchema` checks `action` against
 * `ACTION_TARGET_STATE` and refuses `fromState === toState`, and deliberately does **not** consult
 * `canTransitionLifecycle` — which is right, because this is an audit trail and not a gate. A trail
 * that refuses to record what happened is worse than none.
 *
 * It is not hypothetical: ADR-0334 moved the tenant to `pending_deletion` on the *asynchronous*
 * route's verify only, so the synchronous `--tenant-deletion-routes` path still deletes a tenant
 * straight from `active`, and `active -> deleted` is not in `TENANT_LIFECYCLE_TRANSITIONS`. Recording
 * it silently would hide a real gap; refusing it would drop the only record of a deletion that
 * happened. So it is recorded and flagged.
 */
export function transitionWasLegal(event: LifecycleEvent): boolean {
  return canTransitionLifecycle(event.fromState, event.toState);
}

export const LIFECYCLE_TRAIL_VERDICTS = [
  "durable",
  "cascades_with_tenant",
  "unreadable_after_deletion",
  "absent",
] as const;
export type LifecycleTrailVerdict = (typeof LIFECYCLE_TRAIL_VERDICTS)[number];

export interface LifecycleTrailProbe {
  readonly verdict: LifecycleTrailVerdict;
  /** True when `tenant_id` references `meta.tenants` with `ON DELETE CASCADE`. */
  readonly cascadesWithTenant: boolean;
  /** True when a `SELECT`-scoped platform policy exists, so the trail is readable after the tenant. */
  readonly platformReadable: boolean;
  /** True when an actor column is a UUID reference into `meta.users` — no human actor is writable. */
  readonly actorColumnsReferenceUsers: boolean;
  readonly detail: string;
}

/**
 * Asks the catalog whether this deployment can actually hold a durable trail.
 *
 * The loud half of a finding the subsystem cannot report itself, in
 * `probeJobQueueVisibility`'s shape (ADR-0334) and for its reason: **a trail that is written and
 * then destroyed by a cascade reads exactly like one that was never written.** Both are an empty
 * table, and the store reports success in both cases — the `INSERT` really did succeed. So the
 * question has to be asked of `pg_constraint` and `pg_policy` rather than inferred from a row count,
 * which is also what `count(*) = 0` looks like for a deployment that has simply never deleted a
 * tenant.
 *
 * Three findings, and the order of the verdicts is the order of their consequences:
 * `cascades_with_tenant` destroys the record, `unreadable_after_deletion` merely hides it from the
 * only people who need it. The actor finding rides along on the detail rather than being its own
 * verdict, because it does not change whether the trail survives — only who can appear in it.
 */
export async function probeLifecycleTrail(
  conn: PgConnection,
  schema = "meta",
): Promise<LifecycleTrailProbe> {
  if (!SCHEMA_RE.test(schema)) {
    throw new Error(`invalid schema identifier: ${JSON.stringify(schema)}`);
  }
  const table = `${schema}.tenant_lifecycle_events`;
  const present = await conn.query<{ present: unknown }>(
    "SELECT to_regclass($1) IS NOT NULL AS present",
    [table],
  );
  if (present.rows[0]?.present !== true) {
    return {
      verdict: "absent",
      cascadesWithTenant: false,
      platformReadable: false,
      actorColumnsReferenceUsers: false,
      detail: `${table} does not exist; no tenant transition can be recorded at all`,
    };
  }

  const fks = await conn.query<{ column_name: unknown; confdeltype: unknown; target: unknown }>(
    `SELECT a.attname AS column_name, c.confdeltype, tgt.relname AS target
       FROM pg_constraint c
       JOIN pg_class tgt ON tgt.oid = c.confrelid
       JOIN unnest(c.conkey) AS k(attnum) ON true
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
      WHERE c.conrelid = to_regclass($1) AND c.contype = 'f'`,
    [table],
  );
  let cascades = false;
  let actorRefs = false;
  for (const row of fks.rows) {
    const column = String(row.column_name);
    const target = String(row.target);
    if (column === "tenant_id" && target === "tenants" && String(row.confdeltype) === "c") {
      cascades = true;
    }
    if ((column === "actor_user_id" || column === "approved_by_user_id") && target === "users") {
      actorRefs = true;
    }
  }

  const policies = await conn.query<{ polcmd: unknown; using_expr: unknown }>(
    `SELECT polcmd, pg_get_expr(polqual, polrelid) AS using_expr
       FROM pg_policy WHERE polrelid = to_regclass($1)`,
    [table],
  );
  const platformReadable = policies.rows.some(
    (p) =>
      // `r` is `SELECT`. A platform arm on an `ALL` policy would be a write route too, which is
      // ADR-0313's refusal — so only a `SELECT`-scoped one counts as readable-after-deletion.
      String(p.polcmd) === "r" && String(p.using_expr ?? "").includes("app.platform_audit"),
  );

  const notes: string[] = [];
  if (cascades) {
    notes.push(
      "tenant_id is ON DELETE CASCADE into meta.tenants, so retiring the tenant row destroys its" +
        " trail and an event cannot be written after retirement — both directions closed",
    );
  }
  if (!platformReadable) {
    notes.push(
      "no SELECT-scoped platform read policy, so the trail is unreadable once the tenant's session" +
        " no longer exists",
    );
  }
  if (actorRefs) {
    notes.push(
      "actor_user_id/approved_by_user_id reference meta.users, which has no writer, so no event" +
        " naming a human can be inserted",
    );
  }

  const verdict: LifecycleTrailVerdict = cascades
    ? "cascades_with_tenant"
    : platformReadable
      ? "durable"
      : "unreadable_after_deletion";
  return {
    verdict,
    cascadesWithTenant: cascades,
    platformReadable,
    actorColumnsReferenceUsers: actorRefs,
    detail: notes.length === 0 ? "the lifecycle trail is durable and readable" : notes.join("; "),
  };
}
