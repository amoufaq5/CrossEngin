import { IncidentExecutor } from "@crossengin/incident-response-runtime";
import {
  IncidentRevisionConflictError,
  PAGED_NOTE_MAX_ATTEMPTS,
  PAGED_NOTE_NOT_FOUND,
  PAGED_NOTE_REVISION_CONFLICT,
  assertAppendOnly,
  type PagedNoteOutcome,
  type PostgresIncidentStore,
} from "@crossengin/incident-response-runtime-pg";
import type { IncidentRecord } from "@crossengin/incident-response";

/**
 * Appends a non-`paged` timeline entry to a stored incident, and **reports** rather than throws.
 *
 * ADR-0327 gave `meta.incidents` one note writer, `appendPagedNote`, and shaped it entirely around a
 * page: it takes `PagedTimelineFacts` and writes the `paged` kind. A stall kind flip (ADR-0330) is
 * an `observation` — nothing left the platform, the condition being watched reads differently — so
 * it needs the same read-modify-write with a different entry, which is the whole of what this is.
 *
 * Every rule here is `appendPagedNote`'s, deliberately and for its reasons rather than by copying:
 *
 *   - **It reports.** The incident is already durable and the page has already gone out by the time
 *     a note is owed, so raising would turn a successful escalation into a failed one — the choice
 *     ADR-0325 made with `undelivered` over a throw and ADR-0320 with `tenantRetired: false` on a
 *     200. An incident that does not exist is a reason on the result, not an exception.
 *   - **The instant is resolved once**, before the first attempt, so the entry is stamped when the
 *     observation happened rather than when the last retry got through.
 *   - **`assertAppendOnly` gates it**, because this writes a timeline entry directly and is
 *     therefore the second writer that does not pass through `PersistentIncidentEngine.apply` — the
 *     one check standing between a JSONB column and a rewritten timeline (ADR-0328).
 *   - **The retry is short and bounded.** A note loses its race against whatever else advanced the
 *     revision — a scheduler closing the incident out, a page note landing on the same tick — and a
 *     timeline entry is not worth an unbounded loop.
 *
 * It shares `PAGED_NOTE_MAX_ATTEMPTS` and both reason constants rather than defining its own, so the
 * two writers cannot drift into reporting the same failure under two names. The honest home for this
 * is `PostgresIncidentStore` itself, as the generalisation `appendPagedNote` would then be one case
 * of; it lives here because that package is another lane's.
 */

/** The executor is stateless and its clock is never consulted — the instant is passed explicitly. */
const NOTE_EXECUTOR = new IncidentExecutor();

export interface IncidentNoteInput {
  /**
   * The timeline kind. Narrower than `TimelineEntry["kind"]` on purpose: `paged` belongs to
   * `appendPagedNote`, whose `PagedTimelineFacts` is what keeps an address or a routing key out of a
   * stored note (ADR-0327), and the lifecycle kinds (`declared`, `status_changed`, `role_assigned`,
   * `severity_changed`) are facts about a transition this writer deliberately cannot make — it
   * appends and changes nothing else, so writing one would record a transition that did not happen.
   */
  readonly kind: "observation" | "action_taken";
  readonly message: string;
  readonly metadata?: Record<string, unknown>;
  readonly actorUserId: string;
  readonly at?: string;
}

/** Just the two methods this needs, so a test can hand it a recorder. */
export type IncidentNoteStore = Pick<PostgresIncidentStore, "load" | "update">;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function appendIncidentNote(
  store: IncidentNoteStore,
  incidentId: string,
  input: IncidentNoteInput,
  clock: () => Date = () => new Date(),
): Promise<PagedNoteOutcome> {
  const at = input.at ?? clock().toISOString();
  for (let attempt = 0; attempt < PAGED_NOTE_MAX_ATTEMPTS; attempt++) {
    let loaded: Awaited<ReturnType<IncidentNoteStore["load"]>>;
    try {
      loaded = await store.load(incidentId);
    } catch (err) {
      return { recorded: false, reason: `read_failed: ${messageOf(err)}` };
    }
    if (loaded === null) return { recorded: false, reason: PAGED_NOTE_NOT_FOUND };
    let next: IncidentRecord;
    try {
      next = NOTE_EXECUTOR.note(loaded.record, {
        kind: input.kind,
        message: input.message,
        metadata: input.metadata ?? {},
        actorUserId: input.actorUserId,
        at,
      });
      assertAppendOnly(loaded.record, next);
    } catch (err) {
      // The contract refused the entry, or the candidate was not an extension of the stored
      // timeline. A caller bug either way, and one retrying cannot fix.
      return { recorded: false, reason: `note_refused: ${messageOf(err)}` };
    }
    try {
      // The entry keeps the instant the observation was made; the row's `updated_at` is when it was
      // written, which is this attempt and not the one before it.
      await store.update(next, loaded.revision, clock().toISOString());
      return { recorded: true, reason: null };
    } catch (err) {
      if (err instanceof IncidentRevisionConflictError) continue;
      return { recorded: false, reason: `write_failed: ${messageOf(err)}` };
    }
  }
  return { recorded: false, reason: PAGED_NOTE_REVISION_CONFLICT };
}
