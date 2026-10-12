import {
  assertScopeTenantId,
  classifyScopedWriteRefusal,
  scopeFilter,
  scopeFilterWithPlatform,
  setPlatformWriteSql,
  type PgConnection,
  type ScopedWriteRefusal,
} from "@crossengin/kernel-pg";
import {
  KILL_SWITCH_STATUSES,
  canTransitionKillSwitch,
  type KillSwitch,
} from "@crossengin/feature-flags";

import {
  KILL_SWITCH_COLUMNS,
  KILL_SWITCH_COLUMN_NAMES,
  killSwitchPlaceholders,
  killSwitchRowValues,
  killSwitchUpdateAssignments,
  rowToKillSwitch,
} from "./records.js";

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;
const TABLE = "feature_flag_kill_switches";

const PLACEHOLDERS = killSwitchPlaceholders();
const UPDATE_ASSIGNMENTS = killSwitchUpdateAssignments();

export const SET_TENANT_CONTEXT_SQL =
  "SELECT set_config('app.current_tenant_id', $1, true)";

/**
 * The elevation a platform-wide write needs on `meta.feature_flags` and
 * `meta.feature_flag_kill_switches`, shared by both stores in this package because both tables
 * answer the same question — *may this session change what the deployment does?*
 *
 * Until the policy split, a platform write needed nothing: the single `ALL`-scope policy's `USING`
 * also served as its `WITH CHECK`, and `tenant_id IS NULL` satisfied that unconditionally, so any
 * tenant session could arm a platform-wide kill switch or flip a platform-wide flag. The split
 * leaves the tenant arm exactly where it was and puts the platform arm behind this setting.
 */
export const SET_PLATFORM_CONFIG_WRITE_SQL = setPlatformWriteSql("config");

/**
 * `scopeFilter` and `scopeFilterWithPlatform` live in `kernel-pg` beside `setPlatformWriteSql` and
 * `isoInstant` — eight packages held a verbatim copy and `kernel-pg` is the only dependency all
 * eight share. The rule that chooses between the two spellings, and the two measurements behind the
 * branch, are written down there once.
 *
 * **Which this package reads, and the distinction that matters most here, because it differs by
 * direction.**
 *
 * A **read** takes the inclusive form. `meta.feature_flags`' own catalog comment says a
 * platform-wide flag is *meant* to be evaluated by every tenant's gateway, and a kill switch over a
 * platform-wide flag is the same fact, so a tenant's read legitimately spans its own rows and the
 * platform's. Narrowing it would make these stores owner-independent by destroying the behaviour
 * rather than by reproducing it. Observed live as the owner before the predicate existed:
 * `load("ff_tenantflag…", null)` returned a *tenant's* flag for a platform lookup, and
 * `loadForIncident(…, null)` saw a tenant's switch beside the platform's and **threw** "this needs a
 * human" on healthy data.
 *
 * A **write** takes the strict form, and the inclusive one would be a defect rather than a wider
 * answer: `tenant_id = $n OR tenant_id IS NULL` on an `UPDATE` is a route from a tenant's session
 * into the platform's row, i.e. a tenant flipping `gateway.strict_jwt_aud`. The write side is
 * `guardedWrite` and `release`, and what a zero-row result means there is
 * `assertScopedWriteLanded`'s question.
 */
export {
  scopeFilter,
  scopeFilterWithPlatform,
  type ScopeFilter,
} from "@crossengin/kernel-pg";

export function assertTenantId(tenantId: string): void {
  assertScopeTenantId(tenantId);
}

/**
 * The statuses a release may legally leave, read off `KILL_SWITCH_TRANSITIONS` rather than retyped.
 * Quoting is safe because the values come from the contract's frozen status tuple, never a caller.
 */
const RELEASABLE_FROM: readonly string[] = KILL_SWITCH_STATUSES.filter((status) =>
  canTransitionKillSwitch(status, "released"),
);

const RELEASABLE_FROM_SQL = RELEASABLE_FROM.map((status) => `'${status}'`).join(", ");

/**
 * `isKillSwitchActive` in SQL. The expiry comparison uses the database clock deliberately: a
 * process whose clock has drifted would otherwise serve a lapsed override as live.
 */
const ACTIVE_PREDICATE =
  "status = 'triggered_active' AND (expires_at IS NULL OR expires_at > now())";

/**
 * A `release` that moved no row, and **which of the three reasons it was**.
 *
 * The class and its name stay — a caller catching it would be broken by a new unrelated type — and
 * it carries `reason` now. Before the scope predicate the only possible answer was a stale or
 * already-released row, so the old message's "not found, or no longer releasable" was the whole
 * truth; with the predicate a third answer exists and naming it is the point.
 */
export class KillSwitchNotFoundError extends Error {
  constructor(
    readonly killSwitchId: string,
    readonly reason: ScopedWriteRefusal,
    readonly scopeTenantId: string | null,
    readonly storedTenantId: string | null,
    detail: string,
  ) {
    super(`kill switch '${killSwitchId}' was not released (${reason}): ${detail}`);
    this.name = "KillSwitchNotFoundError";
  }
}

export interface PostgresKillSwitchStoreOptions {
  readonly schema?: string;
}

/**
 * Persists `KillSwitch` records in `meta.feature_flag_kill_switches`.
 *
 * Tenant scoping is conditional, not unconditional. The table's `tenant_id` is nullable and its
 * policy is `tenant_id IS NULL OR tenant_id = current_setting('app.current_tenant_id', true)::UUID`
 * — a kill switch may be platform-wide, and the SLO loop's are, because an availability breach on
 * a shared surface is not one tenant's event. So a `withTenantContext` wrapper cannot be applied to
 * every call: setting a tenant context for a platform-wide switch would hide the very row being
 * written. A write therefore takes its scope from the record's own `tenantId`, and a read takes an
 * optional one defaulting to null — with no context set, RLS exposes exactly the `tenant_id IS NULL`
 * rows, which is the fail-closed answer for a caller that does not know whose switch it wants.
 */
export class PostgresKillSwitchStore {
  private readonly schema: string;

  constructor(
    private readonly conn: PgConnection,
    options: PostgresKillSwitchStoreOptions = {},
  ) {
    this.schema = options.schema ?? "meta";
    if (!SCHEMA_RE.test(this.schema)) {
      throw new Error(`invalid schema identifier: ${JSON.stringify(this.schema)}`);
    }
  }

  async record(killSwitch: KillSwitch): Promise<void> {
    const values = killSwitchRowValues(killSwitch);
    await this.scopedWrite(killSwitch.tenantId, (tx) =>
      tx.query(
        `INSERT INTO ${this.schema}.${TABLE} (${KILL_SWITCH_COLUMNS})
         VALUES (${PLACEHOLDERS})`,
        values,
      ),
    );
  }

  /**
   * The active kill switch rolled back for an incident, if any.
   *
   * This is the method the SLO loop needs after a restart. The enforcement planner rolls a flag
   * back when a surface breaches, but the flag it chose lived only in the process that chose it —
   * so a restart mid-breach adopted the open incident and still reported `killSwitchId: null`,
   * leaving a rolled-back flag with nothing in the process knowing which flag it was. Asking the
   * rows by incident id answers that from durable state instead of from memory.
   *
   * More than one active switch for one incident is a fault, not a choice to make: the loop rolls
   * back one flag per episode, so picking one silently would hide a double rollback that someone
   * has to unwind by hand.
   */
  async loadForIncident(
    incidentId: string,
    tenantId: string | null = null,
  ): Promise<KillSwitch | null> {
    const scope = scopeFilterWithPlatform(tenantId, 2);
    return this.scoped(tenantId, async (tx) => {
      const result = await tx.query<Record<string, unknown>>(
        `SELECT ${KILL_SWITCH_COLUMNS} FROM ${this.schema}.${TABLE}
         WHERE related_incident_id = $1 AND ${scope.sql} AND ${ACTIVE_PREDICATE}
         ORDER BY armed_at DESC
         LIMIT 2`,
        [incidentId, ...scope.params],
      );
      // Two rows now means two switches an incident id can legitimately reach, which is the fault
      // this refuses. Without the predicate the owner saw **every** tenant's switch here: one
      // platform and one tenant switch on `INC-2026-0001` refused a healthy episode, verified live,
      // and the two-row guard turned the missing scope into a false "this needs a human". The
      // inclusive arm cannot resurrect that, because `INC-YYYY-NNNN` ids come from one sequence, so
      // a platform episode and a tenant episode never share one.
      if (result.rows.length > 1) {
        throw new Error(
          `more than one active kill switch for incident '${incidentId}' — ` +
            "one episode rolls back one flag, so this needs a human",
        );
      }
      const row = result.rows[0];
      return row === undefined ? null : rowToKillSwitch(row);
    });
  }

  async load(
    killSwitchId: string,
    tenantId: string | null = null,
  ): Promise<KillSwitch | null> {
    const scope = scopeFilterWithPlatform(tenantId, 2);
    return this.scoped(tenantId, async (tx) => {
      const result = await tx.query<Record<string, unknown>>(
        `SELECT ${KILL_SWITCH_COLUMNS} FROM ${this.schema}.${TABLE}
         WHERE kill_switch_id = $1 AND ${scope.sql}`,
        [killSwitchId, ...scope.params],
      );
      const row = result.rows[0];
      return row === undefined ? null : rowToKillSwitch(row);
    });
  }

  async listActiveForFlag(
    flagId: string,
    limit = 100,
    tenantId: string | null = null,
  ): Promise<readonly KillSwitch[]> {
    if (limit <= 0) throw new Error("limit must be positive");
    // The scope goes before the LIMIT's parameter, not after it: a `LIMIT` over an unscoped read is
    // the sharper half of this defect, since another scope's rows do not merely join the answer —
    // they displace the asked-for ones and the caller cannot tell.
    const scope = scopeFilterWithPlatform(tenantId, 2);
    return this.scoped(tenantId, async (tx) => {
      const result = await tx.query<Record<string, unknown>>(
        `SELECT ${KILL_SWITCH_COLUMNS} FROM ${this.schema}.${TABLE}
         WHERE flag_id = $1 AND ${scope.sql} AND ${ACTIVE_PREDICATE}
         ORDER BY armed_at DESC
         LIMIT $${String(2 + scope.params.length)}`,
        [flagId, ...scope.params, limit],
      );
      return result.rows.map((row) => rowToKillSwitch(row));
    });
  }

  /**
   * Writes the released record over the row, **in the scope the record names**.
   *
   * The status guard in the WHERE clause is what makes a double release impossible rather than
   * merely unlikely: two processes that both read a triggered switch would otherwise both write a
   * release, and the second would overwrite the first's releasing user and reason — which is
   * exactly the attribution a four-eyes audit depends on.
   *
   * The **scope** predicate beside it is the write-side half of ADR-0331's defect. `kill_switch_id`
   * is table-wide unique, so without it a platform-scoped release landed on a tenant's switch as the
   * owner — and `UPDATE_ASSIGNMENTS` covers `tenant_id`, so it did not merely edit that row, it
   * **moved it into platform scope**. Strict rather than inclusive, which is the opposite choice from
   * every read here and the right one: `tenant_id = $n OR tenant_id IS NULL` on a write is a route
   * from a tenant's session into the platform's row.
   *
   * A zero-row update is an error and no longer an *ambiguous* one. It used to mean "stale or
   * already released"; with the scope predicate it could also mean "wrong scope", so
   * `assertScopedWriteLanded` asks the row which — one extra statement, on the failure path only.
   */
  async release(killSwitch: KillSwitch): Promise<void> {
    if (killSwitch.status !== "released") {
      throw new Error(
        `release() needs a released record, got status '${killSwitch.status}'`,
      );
    }
    const values = killSwitchRowValues(killSwitch);
    const scope = scopeFilter(killSwitch.tenantId, KILL_SWITCH_PARAM_COUNT + 1);
    await this.scopedWrite(killSwitch.tenantId, async (tx) => {
      const result = await tx.query(
        `UPDATE ${this.schema}.${TABLE} SET ${UPDATE_ASSIGNMENTS}
         WHERE kill_switch_id = $1 AND ${scope.sql}
           AND status IN (${RELEASABLE_FROM_SQL})`,
        [...values, ...scope.params],
      );
      const refusal = await classifyScopedWriteRefusal(tx, result.rowCount, {
        schema: this.schema,
        table: TABLE,
        idColumn: "kill_switch_id",
        idValue: killSwitch.id,
        tenantId: killSwitch.tenantId,
        guard: `its status is not one of ${RELEASABLE_FROM_SQL} — it is already released or expired`,
      });
      if (refusal !== null) {
        throw new KillSwitchNotFoundError(
          killSwitch.id,
          refusal.reason,
          killSwitch.tenantId,
          refusal.storedTenantId,
          refusal.detail,
        );
      }
    });
  }

  /**
   * A **read**'s scope: a tenant context, or nothing at all.
   *
   * Nothing, for the platform scope, because the platform *read* policy is `SELECT`-scoped on
   * `tenant_id IS NULL` and demands no grant — a platform row is readable by anyone, which is the
   * behaviour this had before the policy split and the behaviour it keeps. A read deliberately does
   * not claim the write elevation: it does not need it, and a privilege claimed for no reason is
   * one a future statement in the same transaction inherits.
   */
  private scoped<T>(
    tenantId: string | null,
    fn: (tx: PgConnection) => Promise<T>,
  ): Promise<T> {
    if (tenantId !== null) assertTenantId(tenantId);
    return this.conn.transaction(async (tx) => {
      if (tenantId !== null) await tx.query(SET_TENANT_CONTEXT_SQL, [tenantId]);
      return fn(tx);
    });
  }

  /**
   * A **write**'s scope, where the two arms are mutually exclusive by construction: a tenant
   * context, or the platform write elevation, never both. Granting both would give one transaction
   * a `WITH CHECK` satisfiable by a tenant row *and* a platform row, which is the shape the policy
   * split exists to take apart.
   */
  private scopedWrite<T>(
    tenantId: string | null,
    fn: (tx: PgConnection) => Promise<T>,
  ): Promise<T> {
    if (tenantId !== null) assertTenantId(tenantId);
    return this.conn.transaction(async (tx) => {
      if (tenantId === null) await tx.query(SET_PLATFORM_CONFIG_WRITE_SQL);
      else await tx.query(SET_TENANT_CONTEXT_SQL, [tenantId]);
      return fn(tx);
    });
  }
}

/** The number of bound parameters an INSERT or UPDATE carries — one per column. */
export const KILL_SWITCH_PARAM_COUNT = KILL_SWITCH_COLUMN_NAMES.length;
