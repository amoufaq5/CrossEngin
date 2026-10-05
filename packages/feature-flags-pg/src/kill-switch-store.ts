import { setPlatformWriteSql, type PgConnection } from "@crossengin/kernel-pg";
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

const TENANT_ID_RE = /^[0-9a-fA-F-]{1,64}$/;

export function assertTenantId(tenantId: string): void {
  if (!TENANT_ID_RE.test(tenantId)) {
    throw new Error(`invalid tenantId for RLS context: ${JSON.stringify(tenantId)}`);
  }
}

/** A `tenant_id` predicate and the parameters it binds, for one scope. */
export interface ScopeFilter {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/**
 * The `tenant_id` predicate a scoped read must carry, **beside** RLS rather than instead of it.
 *
 * RLS alone is not enough for the ordinary reason ADR-0331 measured on the forensic chain: **a
 * table's owner bypasses its policies**, and a deployment that connects as the owner is a normal
 * deployment. Both tables here are `tenant_id`-nullable with a `SELECT`-scoped platform read arm,
 * so a read that names the platform scope and carries no predicate answers from whichever scope
 * the row happens to be in. Observed live on this schema as the owner: `load("ff_tenantflag…",
 * null)` returned a *tenant's* flag for a platform lookup, and `loadForIncident(…, null)` saw a
 * tenant's switch beside the platform's and **threw** "this needs a human" on healthy data.
 *
 * The predicate **branches** rather than using `tenant_id IS NOT DISTINCT FROM $1`, which is the
 * one operator matching NULL to NULL and would give a single code path: ADR-0331 measured it at
 * 16 ms sequential scan against 45k entries where `tenant_id = $1` is a 0.09 ms index scan, because
 * it is not an indexable operator. `tenant_id IS NULL` is indexable, so both arms keep
 * `idx_feature_flags_tenant` / `idx_feature_flag_kill_switches_tenant`.
 *
 * This is a verbatim copy of `forensics-pg`'s `scopeFilter`. It belongs in `kernel-pg` beside
 * `setPlatformWriteSql` — the one module every store here already depends on — and lives per
 * package only because that is where the rest of this scope plumbing already lives.
 *
 * `firstParam` is the 1-based position the predicate's own parameter takes, so a caller that
 * already binds values can place this anywhere in its list.
 */
export function scopeFilter(tenantId: string | null, firstParam = 1): ScopeFilter {
  // `tenant_id = NULL` is never true, so the platform scope cannot ride along as a bound parameter
  // and has to be asked for as `IS NULL`.
  if (tenantId === null) return { sql: "tenant_id IS NULL", params: [] };
  assertTenantId(tenantId);
  return { sql: `tenant_id = $${String(firstParam)}`, params: [tenantId] };
}

/**
 * `scopeFilter` with the platform's rows kept in a tenant's answer, which is the predicate **both
 * tables in this package want**.
 *
 * The strict form is right where a scope's rows are a closed set — a hash chain, a tenant's own
 * certification report — and wrong here: `meta.feature_flags`' own catalog comment says a
 * platform-wide flag is *meant* to be evaluated by every tenant's gateway, and a kill switch over a
 * platform-wide flag is the same fact. So a tenant's read legitimately spans its own rows and the
 * platform's, and narrowing it would make this store owner-independent by destroying the behaviour
 * rather than by reproducing it.
 *
 * The rule: **the predicate reproduces what a non-owner would have been shown, no wider and no
 * narrower.** For a tenant that is `tenant_id = $n OR tenant_id IS NULL` — the isolation policy
 * OR'd with the `SELECT`-scoped platform read arm, which is how Postgres combines two permissive
 * policies. For the platform scope the two functions agree on `tenant_id IS NULL`, and that is the
 * arm the defect was in: the platform read is the one that was answering with a tenant's row.
 *
 * Still indexable — Postgres plans the disjunction as a BitmapOr over `idx_feature_flags_tenant`,
 * because each arm is an indexable operator on its own. That is precisely the property
 * `tenant_id IS NOT DISTINCT FROM $1` lacks.
 */
export function scopeFilterWithPlatform(
  tenantId: string | null,
  firstParam = 1,
): ScopeFilter {
  if (tenantId === null) return scopeFilter(null, firstParam);
  assertTenantId(tenantId);
  return {
    sql: `(tenant_id = $${String(firstParam)} OR tenant_id IS NULL)`,
    params: [tenantId],
  };
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

export class KillSwitchNotFoundError extends Error {
  constructor(readonly killSwitchId: string) {
    super(`kill switch '${killSwitchId}' not found, or no longer releasable`);
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
   * Writes the released record over the row.
   *
   * The status guard in the WHERE clause is what makes a double release impossible rather than
   * merely unlikely: two processes that both read a triggered switch would otherwise both write a
   * release, and the second would overwrite the first's releasing user and reason — which is
   * exactly the attribution a four-eyes audit depends on. A zero-row update is therefore an error,
   * not a success.
   */
  async release(killSwitch: KillSwitch): Promise<void> {
    if (killSwitch.status !== "released") {
      throw new Error(
        `release() needs a released record, got status '${killSwitch.status}'`,
      );
    }
    const values = killSwitchRowValues(killSwitch);
    const result = await this.scopedWrite(killSwitch.tenantId, (tx) =>
      tx.query(
        `UPDATE ${this.schema}.${TABLE} SET ${UPDATE_ASSIGNMENTS}
         WHERE kill_switch_id = $1 AND status IN (${RELEASABLE_FROM_SQL})`,
        values,
      ),
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new KillSwitchNotFoundError(killSwitch.id);
    }
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
