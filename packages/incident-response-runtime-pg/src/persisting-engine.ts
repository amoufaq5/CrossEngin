import type { PgConnection } from "@crossengin/kernel-pg";
import type { IncidentRecord } from "@crossengin/incident-response";
import {
  IncidentExecutor,
  SystemClock,
  cancelIfUntriaged,
  type AssignRoleInput,
  type AttachPostmortemInput,
  type ChangeSeverityInput,
  type Clock,
  type DeclareIncidentInput,
  type HandOffRoleInput,
  type NoteInput,
  type TransitionIncidentInput,
} from "@crossengin/incident-response-runtime";

import {
  IncidentNotFoundError,
  PostgresIncidentStore,
} from "./incident-store.js";
// Re-exported, not redefined: this module owned both until `appendPagedNote` needed them too, and
// the store cannot import from here without a cycle (ADR-0328). Every existing importer keeps
// working.
import {
  IncidentTimelineRewriteError,
  assertAppendOnly,
  type StoredIncident,
} from "./records.js";

export { IncidentTimelineRewriteError };

/** What `declare` needs beyond the executor's input: the id comes from the store. */
export type PersistentDeclareInput = Omit<DeclareIncidentInput, "id">;

export interface PersistentIncidentEngineOptions {
  readonly conn: PgConnection;
  readonly store?: PostgresIncidentStore;
  readonly executor?: IncidentExecutor;
  readonly clock?: Clock;
}

/**
 * Runs the pure executor and writes each result, so an incident's lifecycle survives the process
 * that declared it.
 *
 * Every mutation goes through `apply`: read the row with its revision, transform it purely, write
 * it back under that revision. The pure step is where the contract is enforced, so an illegal
 * transition never reaches the database; the revision guard is what stops two schedulers from
 * overwriting each other.
 */
export class PersistentIncidentEngine {
  private readonly store: PostgresIncidentStore;
  private readonly executor: IncidentExecutor;
  private readonly clock: Clock;

  constructor(opts: PersistentIncidentEngineOptions) {
    this.store = opts.store ?? new PostgresIncidentStore(opts.conn);
    this.clock = opts.clock ?? new SystemClock();
    this.executor = opts.executor ?? new IncidentExecutor({ clock: this.clock });
  }

  /**
   * Declares an incident with an id allocated from the rows that exist. A restart therefore
   * continues the year's sequence instead of resetting it to 0001 and colliding.
   *
   * Allocation and insert happen inside one locked step, so two declarations in flight at once
   * cannot both be handed the same sequence.
   */
  async declare(input: PersistentDeclareInput): Promise<StoredIncident> {
    const at = input.declaredAt ?? this.clock.nowIso();
    const year = new Date(at).getUTCFullYear();
    return this.store.insertAllocated(
      year,
      (id) => this.executor.declare({ ...input, id, declaredAt: at }),
      at,
    );
  }

  /** Declares an incident whose id is already chosen — for callers that planned the record. */
  async persistDeclared(record: IncidentRecord): Promise<StoredIncident> {
    return this.store.insert(record, this.clock.nowIso());
  }

  async load(incidentId: string): Promise<StoredIncident | null> {
    return this.store.load(incidentId);
  }

  /** The open incident already declared for an automated signal — see `findOpenFor` on the store. */
  async findOpenFor(autoDeclaredFor: string): Promise<StoredIncident | null> {
    return this.store.findOpenFor(autoDeclaredFor);
  }

  /**
   * The single write path. `mutate` must return a record whose timeline extends the loaded one;
   * rewriting or dropping an already-recorded entry is refused rather than persisted, because the
   * timeline is the incident's account of itself and an update that edits history is not an
   * append.
   */
  async apply(
    incidentId: string,
    mutate: (record: IncidentRecord) => IncidentRecord,
  ): Promise<StoredIncident> {
    const loaded = await this.store.load(incidentId);
    if (loaded === null) throw new IncidentNotFoundError(incidentId);
    const next = mutate(loaded.record);
    assertAppendOnly(loaded.record, next);
    return this.store.update(next, loaded.revision, this.clock.nowIso());
  }

  async transition(
    incidentId: string,
    input: TransitionIncidentInput,
  ): Promise<StoredIncident> {
    return this.apply(incidentId, (record) => this.executor.transition(record, input));
  }

  async assignRole(incidentId: string, input: AssignRoleInput): Promise<StoredIncident> {
    return this.apply(incidentId, (record) => this.executor.assignRole(record, input));
  }

  async handOffRole(incidentId: string, input: HandOffRoleInput): Promise<StoredIncident> {
    return this.apply(incidentId, (record) => this.executor.handOffRole(record, input));
  }

  async changeSeverity(
    incidentId: string,
    input: ChangeSeverityInput,
  ): Promise<StoredIncident> {
    return this.apply(incidentId, (record) => this.executor.changeSeverity(record, input));
  }

  async note(incidentId: string, input: NoteInput): Promise<StoredIncident> {
    return this.apply(incidentId, (record) => this.executor.note(record, input));
  }

  async attachPostmortem(
    incidentId: string,
    input: AttachPostmortemInput,
  ): Promise<StoredIncident> {
    return this.apply(incidentId, (record) => this.executor.attachPostmortem(record, input));
  }

  /**
   * Closes out an incident whose triggering signal recovered, and returns null when a human has
   * already taken it — see `cancelIfUntriaged` for why cancelling is the only automatic option.
   */
  async cancelIfUntriaged(
    incidentId: string,
    input: { readonly reason: string; readonly actorUserId: string; readonly at?: string },
  ): Promise<StoredIncident | null> {
    const loaded = await this.store.load(incidentId);
    if (loaded === null) throw new IncidentNotFoundError(incidentId);
    const next = cancelIfUntriaged(loaded.record, {
      at: input.at ?? this.clock.nowIso(),
      actorUserId: input.actorUserId,
      reason: input.reason,
    });
    if (next === null) return null;
    return this.store.update(next, loaded.revision, this.clock.nowIso());
  }

  async listOpen(limit = 100): Promise<readonly StoredIncident[]> {
    return this.store.listOpen(limit);
  }
}

