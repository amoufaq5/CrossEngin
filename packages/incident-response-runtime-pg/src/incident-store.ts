import type { PgConnection } from "@crossengin/kernel-pg";
import {
  formatIncidentId,
  type IncidentRecord,
  type PagedTimelineFacts,
} from "@crossengin/incident-response";
import { IncidentExecutor } from "@crossengin/incident-response-runtime";

import {
  INCIDENT_COLUMNS,
  INCIDENT_COLUMN_NAMES,
  assertAppendOnly,
  incidentPlaceholders,
  incidentRowValues,
  incidentUpdateAssignments,
  rowToIncident,
  type StoredIncident,
} from "./records.js";

const SCHEMA = "meta";
const TABLE = "incidents";

/** Serializes id allocation so two declarers cannot compute the same next sequence. */
const INCIDENT_SEQUENCE_LOCK = 8_675_311n;

export class IncidentRevisionConflictError extends Error {
  constructor(
    readonly incidentId: string,
    readonly expectedRevision: number,
  ) {
    super(
      `incident '${incidentId}' was not at revision ${expectedRevision} — ` +
        "another writer changed it first",
    );
    this.name = "IncidentRevisionConflictError";
  }
}

export class IncidentNotFoundError extends Error {
  constructor(readonly incidentId: string) {
    super(`incident '${incidentId}' not found`);
    this.name = "IncidentNotFoundError";
  }
}

/**
 * How many times a page note will re-read and re-append before giving up.
 *
 * Bounded on purpose: the note loses its race against whatever other writer advanced the
 * revision, and a page note is not worth an unbounded loop in front of an escalation that has
 * already gone out. The `meta.audit_log` row ADR-0326 writes is the other witness, so a note that
 * cannot land is a thinner record, not a lost one.
 */
export const PAGED_NOTE_MAX_ATTEMPTS = 3;

/** The reasons `appendPagedNote` reports instead of throwing. */
export const PAGED_NOTE_NOT_FOUND = "incident_not_found";
export const PAGED_NOTE_REVISION_CONFLICT = "revision_conflict";

export interface PagedNoteOutcome {
  readonly recorded: boolean;
  readonly reason: string | null;
}

export interface AppendPagedNoteInput {
  readonly facts: PagedTimelineFacts;
  readonly actorUserId: string;
  readonly at?: string;
}

/**
 * Builds the note. Stateless, and its clock is never consulted — `appendPagedNote` resolves the
 * instant itself and passes it explicitly, so the entry is stamped once however many times the
 * write is retried.
 */
const PAGE_NOTE_EXECUTOR = new IncidentExecutor();

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const PLACEHOLDERS = incidentPlaceholders();
const UPDATE_ASSIGNMENTS = incidentUpdateAssignments();
/** The revision guard binds after every column value, so it is always the next placeholder. */
const REVISION_GUARD_PARAM = INCIDENT_COLUMN_NAMES.length + 1;

/**
 * Persists declared incidents in `meta.incidents`.
 *
 * Platform-wide, so there is no `withTenantContext` wrapper and no RLS to set up: an incident may
 * name many tenants or none, and confining it to one would hide exactly the cross-tenant events
 * incidents exist to describe. Reads are therefore unfiltered by design, which is why nothing
 * tenant-facing is wired to this store.
 */
export interface PostgresIncidentStoreOptions {
  /**
   * The clock for the two instants this store stamps itself: a paged note with no explicit `at`,
   * and the row's `updated_at` on that write (ADR-0328).
   *
   * Every other write takes its instant from the caller, which is why this store had no clock at
   * all — and then ADR-0327's `appendPagedNote` read `new Date()` directly, so the one method that
   * decides an instant for itself was the one a test could not control.
   */
  readonly clock?: () => Date;
}

export class PostgresIncidentStore {
  private readonly conn: PgConnection;
  private readonly clock: () => Date;

  constructor(conn: PgConnection, opts: PostgresIncidentStoreOptions = {}) {
    this.conn = conn;
    this.clock = opts.clock ?? ((): Date => new Date());
  }

  /**
   * Reserves the next incident id for a year from the rows that exist, not from a counter in this
   * process. The advisory lock makes concurrent allocation safe, and `incidents_year_sequence_key`
   * is what makes a collision impossible even if two processes bypassed the lock.
   */
  async allocateIncidentId(year: number): Promise<string> {
    return this.conn.withAdvisoryLock(INCIDENT_SEQUENCE_LOCK, async () =>
      this.nextIncidentId(year),
    );
  }

  /**
   * Allocates an id and writes the record it names without releasing the lock in between.
   *
   * Allocating and inserting as two locked steps leaves a window: two declarers that both read
   * `MAX(sequence_number)` before either wrote compute the same next sequence, and the second
   * insert is refused by `incidents_year_sequence_key`. One declaration per pass hid that; a loop
   * that can open several breaches in one pass does not. The constraint stays the backstop for
   * anything that bypasses the lock.
   */
  async insertAllocated(
    year: number,
    build: (incidentId: string) => IncidentRecord,
    at: string,
  ): Promise<StoredIncident> {
    return this.conn.withAdvisoryLock(INCIDENT_SEQUENCE_LOCK, async () => {
      const incidentId = await this.nextIncidentId(year);
      const record = build(incidentId);
      if (record.id !== incidentId) {
        // The row's `year` / `sequence_number` are derived from the id, so a record built under a
        // different id would store columns that contradict it — the mismatch the replayer reports.
        throw new Error(
          `incident builder returned id '${record.id}' for allocated id '${incidentId}'`,
        );
      }
      return this.insert(record, at);
    });
  }

  private async nextIncidentId(year: number): Promise<string> {
    const result = await this.conn.query<{ next: string }>(
      `SELECT COALESCE(MAX(sequence_number), 0) + 1 AS next
       FROM ${SCHEMA}.${TABLE}
       WHERE year = $1`,
      [year],
    );
    const row = result.rows[0];
    const next = row === undefined ? 1 : Number.parseInt(row.next, 10);
    return formatIncidentId(year, next);
  }

  async insert(record: IncidentRecord, at: string): Promise<StoredIncident> {
    await this.conn.query(
      `INSERT INTO ${SCHEMA}.${TABLE} (${INCIDENT_COLUMNS}) VALUES (${PLACEHOLDERS})`,
      incidentRowValues(record, 1, at),
    );
    return { record, revision: 1, updatedAt: at };
  }

  /**
   * Writes a new version of an incident, but only if it is still at the revision the caller read.
   * A zero-row update is a conflict, not a success — the alternative is silently discarding
   * whatever the other writer did.
   */
  async update(
    record: IncidentRecord,
    expectedRevision: number,
    at: string,
  ): Promise<StoredIncident> {
    const nextRevision = expectedRevision + 1;
    const values = incidentRowValues(record, nextRevision, at);
    const result = await this.conn.query(
      `UPDATE ${SCHEMA}.${TABLE} SET ${UPDATE_ASSIGNMENTS}
       WHERE incident_id = $1 AND revision = $${REVISION_GUARD_PARAM}`,
      [...values, expectedRevision],
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new IncidentRevisionConflictError(record.id, expectedRevision);
    }
    return { record, revision: nextRevision, updatedAt: at };
  }

  /**
   * Appends a `paged` note to a stored incident and **reports** rather than throws.
   *
   * By the time this runs the page has already left the process and the incident row is already
   * durable, so raising here would turn a successful escalation into a failed one — the mistake
   * ADR-0325 refused when it chose `undelivered` over a throw, and ADR-0320 before it with
   * `tenantRetired: false` on a 200. Every outcome, an incident that does not exist included, is
   * a reason on the result.
   *
   * The read-modify-write is retried because the store's revision guard means a note can lose a
   * race with another writer — a scheduler closing the incident out, say, which is exactly what
   * happens around a resolve. `PAGED_NOTE_MAX_ATTEMPTS` is why that retry is short.
   */
  async appendPagedNote(
    incidentId: string,
    input: AppendPagedNoteInput,
  ): Promise<PagedNoteOutcome> {
    // Resolved once, so every attempt records the instant the page happened rather than the
    // instant the last retry got through.
    const at = input.at ?? this.clock().toISOString();
    for (let attempt = 0; attempt < PAGED_NOTE_MAX_ATTEMPTS; attempt++) {
      let loaded: StoredIncident | null;
      try {
        loaded = await this.load(incidentId);
      } catch (err) {
        return { recorded: false, reason: `read_failed: ${messageOf(err)}` };
      }
      if (loaded === null) return { recorded: false, reason: PAGED_NOTE_NOT_FOUND };
      let next: IncidentRecord;
      try {
        next = PAGE_NOTE_EXECUTOR.notePage(loaded.record, {
          facts: input.facts,
          actorUserId: input.actorUserId,
          at,
        });
        // The same guard every write through `PersistentIncidentEngine.apply` passes, and the
        // reason it moved into `records.ts` (ADR-0328): this was the one writer it did not cover,
        // so a note that rewrote an earlier entry would have been accepted by the only check
        // standing between a JSONB column and an edited timeline.
        assertAppendOnly(loaded.record, next);
      } catch (err) {
        // The contract refused the facts, or the candidate was not an extension of the stored
        // timeline — a caller bug either way, and one retrying cannot fix. Reported rather than
        // raised for the same reason as everything else here.
        return { recorded: false, reason: `note_refused: ${messageOf(err)}` };
      }
      try {
        // The entry keeps the instant the page happened; the row's `updated_at` is when it was
        // written, which is this attempt and not the one before it.
        await this.update(next, loaded.revision, this.clock().toISOString());
        return { recorded: true, reason: null };
      } catch (err) {
        if (err instanceof IncidentRevisionConflictError) continue;
        return { recorded: false, reason: `write_failed: ${messageOf(err)}` };
      }
    }
    return { recorded: false, reason: PAGED_NOTE_REVISION_CONFLICT };
  }

  /**
   * The open incident already declared for an automated signal, if any.
   *
   * This is what lets a declarer whose open-episode state is in memory survive a restart: it asks
   * the rows rather than its own map, and adopts the incident it already declared instead of
   * declaring a second for the same still-present breach. `idx_incidents_auto_declared_open` is
   * what makes "at most one" true rather than merely intended, so a second row can be read as a
   * database fault rather than quietly preferred.
   */
  async findOpenFor(autoDeclaredFor: string): Promise<StoredIncident | null> {
    const result = await this.conn.query<Record<string, unknown>>(
      `SELECT ${INCIDENT_COLUMNS} FROM ${SCHEMA}.${TABLE}
       WHERE auto_declared_for = $1
         AND status NOT IN ('closed', 'cancelled')
       ORDER BY declared_at DESC
       LIMIT 2`,
      [autoDeclaredFor],
    );
    if (result.rows.length > 1) {
      throw new Error(
        `more than one open incident for signal '${autoDeclaredFor}' — ` +
          "idx_incidents_auto_declared_open should have made that impossible",
      );
    }
    const row = result.rows[0];
    return row === undefined ? null : rowToIncident(row);
  }

  async load(incidentId: string): Promise<StoredIncident | null> {
    const result = await this.conn.query<Record<string, unknown>>(
      `SELECT ${INCIDENT_COLUMNS} FROM ${SCHEMA}.${TABLE} WHERE incident_id = $1`,
      [incidentId],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToIncident(row);
  }

  async listOpen(limit = 100): Promise<readonly StoredIncident[]> {
    if (limit <= 0) throw new Error("limit must be positive");
    const result = await this.conn.query<Record<string, unknown>>(
      `SELECT ${INCIDENT_COLUMNS} FROM ${SCHEMA}.${TABLE}
       WHERE status NOT IN ('closed', 'cancelled')
       ORDER BY declared_at ASC
       LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => rowToIncident(row));
  }

  async listForTenant(tenantId: string, limit = 100): Promise<readonly StoredIncident[]> {
    if (limit <= 0) throw new Error("limit must be positive");
    const result = await this.conn.query<Record<string, unknown>>(
      `SELECT ${INCIDENT_COLUMNS} FROM ${SCHEMA}.${TABLE}
       WHERE affected_tenant_ids @> to_jsonb($1::text)
       ORDER BY declared_at DESC
       LIMIT $2`,
      [tenantId, limit],
    );
    return result.rows.map((row) => rowToIncident(row));
  }

  async listRecent(limit = 100): Promise<readonly StoredIncident[]> {
    if (limit <= 0) throw new Error("limit must be positive");
    const result = await this.conn.query<Record<string, unknown>>(
      `SELECT ${INCIDENT_COLUMNS} FROM ${SCHEMA}.${TABLE}
       ORDER BY declared_at DESC
       LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => rowToIncident(row));
  }

  async countSince(since: Date): Promise<number> {
    const result = await this.conn.query<{ count: string }>(
      `SELECT COUNT(*)::TEXT AS count FROM ${SCHEMA}.${TABLE} WHERE declared_at >= $1`,
      [since.toISOString()],
    );
    const row = result.rows[0];
    if (row === undefined) return 0;
    return Number.parseInt(row.count, 10);
  }
}
