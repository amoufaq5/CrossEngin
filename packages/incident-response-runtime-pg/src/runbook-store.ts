import type { PgConnection } from "@crossengin/kernel-pg";
import {
  RunbookExecutionSchema,
  type RunbookExecution,
} from "@crossengin/incident-response";

const SCHEMA = "meta";
const TABLE = "incident_runbook_executions";

/**
 * The columns of `meta.incident_runbook_executions` in the order `runbookExecutionRowValues`
 * supplies them. Every statement derives its column list, its placeholders and its UPDATE
 * assignments from this one array, so a column added in the middle cannot leave two statements
 * disagreeing about which `$n` means what.
 *
 * `execution_id` is first because it is the business key an UPDATE matches on — the table's own
 * `id` is a surrogate UUID, as in `meta.incidents`.
 */
export const RUNBOOK_EXECUTION_COLUMN_NAMES: readonly string[] = Object.freeze([
  "execution_id",
  "incident_id",
  "runbook_id",
  "runbook_version",
  "invoked_at",
  "invoked_by",
  "status",
  "started_at",
  "completed_at",
  "duration_seconds",
  "steps",
  "aborted_at",
  "aborted_reason",
  "page_oncall_triggered",
  "incident_commander_approval_user_id",
  "artifact_storage_uri",
]);

export const RUNBOOK_EXECUTION_JSONB_COLUMNS: ReadonlySet<string> = new Set(["steps"]);

export const RUNBOOK_EXECUTION_COLUMNS = RUNBOOK_EXECUTION_COLUMN_NAMES.join(", ");

/** `$1, $11::jsonb, …` positionally matching `RUNBOOK_EXECUTION_COLUMN_NAMES`. */
export function runbookExecutionPlaceholders(): string {
  return RUNBOOK_EXECUTION_COLUMN_NAMES.map(
    (col, i) => `$${i + 1}${RUNBOOK_EXECUTION_JSONB_COLUMNS.has(col) ? "::jsonb" : ""}`,
  ).join(", ");
}

/** `col = $n` for every column except the first, which is the key an UPDATE matches on. */
export function runbookExecutionUpdateAssignments(): string {
  return RUNBOOK_EXECUTION_COLUMN_NAMES.slice(1)
    .map(
      (col, i) =>
        `${col} = $${i + 2}${RUNBOOK_EXECUTION_JSONB_COLUMNS.has(col) ? "::jsonb" : ""}`,
    )
    .join(", ");
}

/** The row values for a `RunbookExecution`, positionally matching the column array. */
export function runbookExecutionRowValues(
  record: RunbookExecution,
): readonly unknown[] {
  const valid = RunbookExecutionSchema.parse(record);
  return [
    valid.id,
    valid.incidentId,
    valid.runbookId,
    valid.runbookVersion,
    valid.invokedAt,
    valid.invokedBy,
    valid.status,
    valid.startedAt,
    valid.completedAt,
    valid.durationSeconds,
    JSON.stringify(valid.steps),
    valid.abortedAt,
    valid.abortedReason ?? null,
    valid.pageOncallTriggered,
    valid.incidentCommanderApprovalUserId,
    valid.artifactStorageUri ?? null,
  ];
}

function asString(value: unknown): string {
  return String(value);
}

function asNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function asIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : asString(value);
}

function asNullableIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return asIso(value);
}

function asNullableInt(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return typeof value === "number" ? value : Number.parseInt(String(value), 10);
}

function asJson(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

/**
 * The two `.optional()` (not `.nullable()`) fields round-trip through a nullable column, and the
 * schema distinguishes absent from null for them, so a NULL must come back as an omitted key.
 */
function maybe(key: string, value: string | null): Record<string, string> {
  return value === null ? {} : { [key]: value };
}

/**
 * Rebuilds the `RunbookExecution` from a row, and **re-validates it** on the way out.
 *
 * A CHECK constraint can express "status is one of six values" but not "a succeeded execution
 * recorded every step with a non-failed outcome", "an aborted one carries a reason" or "a step's
 * `manual_override` outcome carries notes" — those are `superRefine` rules, invisible to the
 * database. A row edited by hand into a state the contract forbids is therefore only detectable by
 * parsing it back, and this is where that happens.
 */
export function rowToRunbookExecution(row: Record<string, unknown>): RunbookExecution {
  return RunbookExecutionSchema.parse({
    id: asString(row["execution_id"]),
    incidentId: asString(row["incident_id"]),
    runbookId: asString(row["runbook_id"]),
    runbookVersion: asString(row["runbook_version"]),
    invokedAt: asIso(row["invoked_at"]),
    invokedBy: asString(row["invoked_by"]),
    status: asString(row["status"]),
    startedAt: asNullableIso(row["started_at"]),
    completedAt: asNullableIso(row["completed_at"]),
    durationSeconds: asNullableInt(row["duration_seconds"]),
    steps: asJson(row["steps"]),
    abortedAt: asNullableIso(row["aborted_at"]),
    ...maybe("abortedReason", asNullableString(row["aborted_reason"])),
    pageOncallTriggered: row["page_oncall_triggered"] === true,
    incidentCommanderApprovalUserId: asNullableString(
      row["incident_commander_approval_user_id"],
    ),
    ...maybe("artifactStorageUri", asNullableString(row["artifact_storage_uri"])),
  });
}

export class RunbookExecutionNotFoundError extends Error {
  constructor(readonly executionId: string) {
    super(`runbook execution '${executionId}' not found`);
    this.name = "RunbookExecutionNotFoundError";
  }
}

const PLACEHOLDERS = runbookExecutionPlaceholders();
const UPDATE_ASSIGNMENTS = runbookExecutionUpdateAssignments();

/**
 * Persists runbook executions in `meta.incident_runbook_executions`.
 *
 * Platform-wide, like `meta.incidents` it hangs off: an execution belongs to an incident, which may
 * name many tenants or none, so there is no `withTenantContext` wrapper and no RLS.
 *
 * **The table carries no `revision` column, so writes are last-writer-wins.** Two processes that
 * each read a `running` execution and then write — one aborting it, one marking it succeeded — both
 * succeed, and the second simply overwrites the first with no error anywhere. Unlike
 * `PostgresIncidentStore`, this store cannot offer `IncidentRevisionConflictError`: there is nothing
 * in the row to guard on. In practice one worker drives one execution, so the window is narrow
 * rather than absent, and `update` at least refuses a write to a row that is not there. Closing it
 * properly means a `revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)` column, the same one
 * ADR-0289 added to `meta.incidents` for the same reason.
 */
export class PostgresRunbookExecutionStore {
  private readonly conn: PgConnection;

  constructor(conn: PgConnection) {
    this.conn = conn;
  }

  async insert(record: RunbookExecution): Promise<RunbookExecution> {
    await this.conn.query(
      `INSERT INTO ${SCHEMA}.${TABLE} (${RUNBOOK_EXECUTION_COLUMNS}) VALUES (${PLACEHOLDERS})`,
      runbookExecutionRowValues(record),
    );
    return record;
  }

  /**
   * Writes a new version of an execution. A zero-row update means the row is gone, not that the
   * write was a no-op — every column is assigned, so a matching row always reports one affected row.
   */
  async update(record: RunbookExecution): Promise<RunbookExecution> {
    const result = await this.conn.query(
      `UPDATE ${SCHEMA}.${TABLE} SET ${UPDATE_ASSIGNMENTS} WHERE execution_id = $1`,
      runbookExecutionRowValues(record),
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new RunbookExecutionNotFoundError(record.id);
    }
    return record;
  }

  async load(executionId: string): Promise<RunbookExecution | null> {
    const result = await this.conn.query<Record<string, unknown>>(
      `SELECT ${RUNBOOK_EXECUTION_COLUMNS} FROM ${SCHEMA}.${TABLE} WHERE execution_id = $1`,
      [executionId],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToRunbookExecution(row);
  }

  /** An incident's executions oldest-first, the order they were invoked in. */
  async listForIncident(
    incidentId: string,
    limit = 100,
  ): Promise<readonly RunbookExecution[]> {
    if (limit <= 0) throw new Error("limit must be positive");
    const result = await this.conn.query<Record<string, unknown>>(
      `SELECT ${RUNBOOK_EXECUTION_COLUMNS} FROM ${SCHEMA}.${TABLE}
       WHERE incident_id = $1
       ORDER BY invoked_at ASC
       LIMIT $2`,
      [incidentId, limit],
    );
    return result.rows.map((row) => rowToRunbookExecution(row));
  }

  /** Executions that have not reached a terminal status — what a restarting worker must resume. */
  async listUnfinished(limit = 100): Promise<readonly RunbookExecution[]> {
    if (limit <= 0) throw new Error("limit must be positive");
    const result = await this.conn.query<Record<string, unknown>>(
      `SELECT ${RUNBOOK_EXECUTION_COLUMNS} FROM ${SCHEMA}.${TABLE}
       WHERE status IN ('queued', 'running', 'paused')
       ORDER BY invoked_at ASC
       LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => rowToRunbookExecution(row));
  }
}
