import type { PgConnection } from "@crossengin/kernel-pg";
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

const TENANT_ID_RE = /^[0-9a-fA-F-]{1,64}$/;

export function assertTenantId(tenantId: string): void {
  if (!TENANT_ID_RE.test(tenantId)) {
    throw new Error(`invalid tenantId for RLS context: ${JSON.stringify(tenantId)}`);
  }
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
    await this.scoped(killSwitch.tenantId, (tx) =>
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
    return this.scoped(tenantId, async (tx) => {
      const result = await tx.query<Record<string, unknown>>(
        `SELECT ${KILL_SWITCH_COLUMNS} FROM ${this.schema}.${TABLE}
         WHERE related_incident_id = $1 AND ${ACTIVE_PREDICATE}
         ORDER BY armed_at DESC
         LIMIT 2`,
        [incidentId],
      );
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
    return this.scoped(tenantId, async (tx) => {
      const result = await tx.query<Record<string, unknown>>(
        `SELECT ${KILL_SWITCH_COLUMNS} FROM ${this.schema}.${TABLE}
         WHERE kill_switch_id = $1`,
        [killSwitchId],
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
    return this.scoped(tenantId, async (tx) => {
      const result = await tx.query<Record<string, unknown>>(
        `SELECT ${KILL_SWITCH_COLUMNS} FROM ${this.schema}.${TABLE}
         WHERE flag_id = $1 AND ${ACTIVE_PREDICATE}
         ORDER BY armed_at DESC
         LIMIT $2`,
        [flagId, limit],
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
    const result = await this.scoped(killSwitch.tenantId, (tx) =>
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
}

/** The number of bound parameters an INSERT or UPDATE carries — one per column. */
export const KILL_SWITCH_PARAM_COUNT = KILL_SWITCH_COLUMN_NAMES.length;
