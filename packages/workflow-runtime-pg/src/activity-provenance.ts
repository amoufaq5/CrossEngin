import type {
  ActivityKind,
  RetryPolicy,
  RetryStrategy,
  WorkflowDefinition,
  WorkflowEvent,
} from "@crossengin/workflow-engine";
import { projectActivities } from "@crossengin/workflow-runtime";

import type { ActivityProjection } from "./activity-store.js";

/**
 * Why an activity could not be assembled into a row `meta.workflow_activities` will accept. Each is
 * a refusal rather than a substituted value, and each names a fact the log or the definition was
 * supposed to carry.
 *
 * Six of this table's columns are NOT NULL with no default and were omitted from the store's
 * INSERT: `label`, `max_attempts`, `retry_policy`, `timeout_seconds`, `timeout_at` and
 * `sequence_cursor`. Only two of the six turn out to be refusable, which is the finding: an
 * activity has **no typed declaration site in the contract at all**. `WorkflowDefinition` carries
 * `timers` and `signals` arrays whose members are schemas, but an activity exists only as a
 * `schedule_activity` `StateAction` whose `parameters` is `z.record(z.string(), z.unknown())`. So
 * unlike `SignalDefinition.deliveryGuarantee`, there is no required field to read back, and the
 * question "where does this value legitimately come from" has a different answer per column.
 */
export const ACTIVITY_PROVENANCE_DEFECTS = [
  "definition_unavailable",
  "activity_kind_unrecognized",
  "max_attempts_unrecorded",
  "max_attempts_out_of_range",
  "attempt_number_out_of_range",
  "attempt_exceeds_max_attempts",
] as const;
export type ActivityProvenanceDefect = (typeof ACTIVITY_PROVENANCE_DEFECTS)[number];

export class ActivityProvenanceUnresolved extends Error {
  readonly defect: ActivityProvenanceDefect;
  readonly activityId: string;
  readonly definitionActivityKey: string;

  constructor(opts: {
    readonly defect: ActivityProvenanceDefect;
    readonly activityId: string;
    readonly definitionActivityKey: string;
    readonly detail: string;
  }) {
    super(
      `cannot persist activity ${opts.activityId} (${opts.definitionActivityKey}): ${opts.defect} — ${opts.detail}`,
    );
    this.name = "ActivityProvenanceUnresolved";
    this.defect = opts.defect;
    this.activityId = opts.activityId;
    this.definitionActivityKey = opts.definitionActivityKey;
  }
}

/**
 * The column's own ceiling, and the reason an inherited deadline is clamped rather than refused.
 * `meta.workflow_activities.timeout_seconds` is `BETWEEN 1 AND 86400`: the catalog's statement that
 * no single activity *attempt* runs longer than a day, whatever its instance's budget is.
 */
export const MAX_ACTIVITY_TIMEOUT_SECONDS = 86_400;

/**
 * `RetryPolicySchema`'s own bounds. The two ceilings differ — `initialDelaySeconds` is capped at an
 * hour and `maxDelaySeconds` at a day — and conflating them is how the first draft of
 * `renderRetryPolicy` produced a policy the contract rejects.
 */
const MAX_RETRY_ATTEMPTS = 50;
const MIN_DELAY_SECONDS = 1;
const MAX_INITIAL_DELAY_SECONDS = 3_600;
const MAX_DELAY_SECONDS = 86_400;

/** The engine's internal backoff, as `scheduleActivity` records it on the event. */
interface RecordedBackoff {
  readonly kind: "exponential" | "linear" | "constant";
  readonly initialMs: number;
  readonly maxMs: number | null;
}

const BACKOFF_STRATEGY: Readonly<Record<RecordedBackoff["kind"], RetryStrategy>> = {
  exponential: "exponential_backoff",
  linear: "linear_backoff",
  constant: "fixed_delay",
};

function readRecordedBackoff(event: WorkflowEvent | undefined): RecordedBackoff | null {
  if (event === undefined) return null;
  const raw = event.payload["retryBackoff"];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const bag = raw as Record<string, unknown>;
  const initialMs = typeof bag["initialMs"] === "number" ? bag["initialMs"] : null;
  if (initialMs === null || !Number.isFinite(initialMs) || initialMs <= 0) return null;
  const kind =
    bag["kind"] === "linear" || bag["kind"] === "constant"
      ? bag["kind"]
      : bag["kind"] === "exponential"
        ? "exponential"
        : null;
  if (kind === null) return null;
  const maxMs = typeof bag["maxMs"] === "number" && Number.isFinite(bag["maxMs"]) ? bag["maxMs"] : null;
  return { kind, initialMs: Math.floor(initialMs), maxMs: maxMs === null ? null : Math.floor(maxMs) };
}

/** The scheduling event per activity id — the one place the engine's retry parameters are recorded. */
function schedulingEvents(
  events: readonly WorkflowEvent[],
): ReadonlyMap<string, WorkflowEvent> {
  const byId = new Map<string, WorkflowEvent>();
  for (const event of events) {
    if (event.kind !== "activity_scheduled") continue;
    if (event.activityId === null) continue;
    // First schedule wins. A retry gets a *fresh* activityId, so a second schedule under one id
    // cannot happen — and if a log holds one, the first is the one the attempt was declared under.
    if (byId.has(event.activityId)) continue;
    byId.set(event.activityId, event);
  }
  return byId;
}

/**
 * Renders the engine's millisecond backoff as the `RetryPolicy` the JSONB column holds.
 *
 * **A rendering, not a resolution — and the one value here that is knowingly lossy.** The event's
 * `retryBackoff` is the authority and stays in the log forever; this column is a projection of it,
 * so unlike a delivery guarantee (which exists nowhere but the definition, hence
 * `signal-provenance.ts`'s refusal) nothing is being invented and nothing is being lost. Two
 * renderings round, and both round *up* to `RetryPolicySchema`'s one-second floor:
 *
 * - A sub-second backoff. `initialDelaySeconds` is `min(1)`, so a 250ms backoff cannot be written
 *   down; `1` over-states the wait, which delays a retry rather than firing one early.
 * - No backoff at all with `maxAttempts > 1`, which the engine honours as *retry immediately*
 *   (`availableAt` stays null). `fixed_delay` with a 1s floor is the nearest expressible form, and
 *   it is a rendering rather than a category error: the delay genuinely is fixed, at zero.
 *
 * The one thing not rendered is the `no_retry` *category*. `RetryPolicySchema` ties it to
 * `maxAttempts === 1`, and it claims this activity will never be retried — so it is used only when
 * the recorded ceiling says exactly that, never as the shape for "no backoff was declared".
 */
export function renderRetryPolicy(input: {
  readonly maxAttempts: number;
  readonly backoff: RecordedBackoff | null;
}): RetryPolicy {
  const maxAttempts = input.maxAttempts;
  if (input.backoff === null) {
    if (maxAttempts === 1) {
      return {
        strategy: "no_retry",
        maxAttempts: 1,
        initialDelaySeconds: MIN_DELAY_SECONDS,
        maxDelaySeconds: MIN_DELAY_SECONDS,
        retryableErrorCodes: [],
        nonRetryableErrorCodes: [],
      };
    }
    return {
      strategy: "fixed_delay",
      maxAttempts,
      initialDelaySeconds: MIN_DELAY_SECONDS,
      maxDelaySeconds: MIN_DELAY_SECONDS,
      retryableErrorCodes: [],
      nonRetryableErrorCodes: [],
    };
  }
  const initialDelaySeconds = Math.min(
    MAX_INITIAL_DELAY_SECONDS,
    Math.max(MIN_DELAY_SECONDS, Math.round(input.backoff.initialMs / 1000)),
  );
  // An absent `maxMs` means the engine applies no cap, and the column requires a figure — so the
  // ceiling is the column's own, never `initialDelaySeconds`, which would claim a cap that caps.
  const cap =
    input.backoff.maxMs === null
      ? MAX_DELAY_SECONDS
      : Math.min(MAX_DELAY_SECONDS, Math.max(MIN_DELAY_SECONDS, Math.round(input.backoff.maxMs / 1000)));
  return {
    strategy: BACKOFF_STRATEGY[input.backoff.kind],
    maxAttempts,
    initialDelaySeconds,
    maxDelaySeconds: Math.max(initialDelaySeconds, cap),
    retryableErrorCodes: [],
    nonRetryableErrorCodes: [],
  };
}

/** The six facts `projectActivities` cannot produce on its own. */
export interface ActivityProvenance {
  readonly kind: ActivityKind;
  readonly label: string;
  readonly maxAttempts: number;
  readonly retryPolicy: RetryPolicy;
  readonly timeoutSeconds: number;
  readonly timeoutAt: string;
}

export function resolveActivityProvenance(input: {
  readonly activityId: string;
  readonly definitionActivityKey: string;
  readonly kind: ActivityKind | null;
  readonly attemptNumber: number;
  readonly maxAttempts: number | null;
  readonly scheduledAt: string;
  readonly definition: WorkflowDefinition | undefined;
  readonly schedulingEvent: WorkflowEvent | undefined;
}): ActivityProvenance {
  const { activityId, definitionActivityKey } = input;
  // Built rather than called, so every `throw` below narrows at the throw site — the alternative is
  // a `(): never` helper whose call TS does not treat as terminal, which costs three casts.
  const refusal = (defect: ActivityProvenanceDefect, detail: string): ActivityProvenanceUnresolved =>
    new ActivityProvenanceUnresolved({ defect, activityId, definitionActivityKey, detail });

  const definition = input.definition;
  if (definition === undefined) {
    throw refusal(
      "definition_unavailable",
      "the instance's workflow definition is not in the engine's definition map",
    );
  }

  const kind = input.kind;
  if (kind === null) {
    throw refusal(
      "activity_kind_unrecognized",
      "the activity_scheduled event's payload carries no recognised ACTIVITY_KINDS member",
    );
  }

  const maxAttempts = input.maxAttempts;
  if (maxAttempts === null) {
    throw refusal(
      "max_attempts_unrecorded",
      "the activity_scheduled event records no maxAttempts, and a retry ceiling is a decision the definition made",
    );
  }

  // Both bounds are the column's CHECK (`BETWEEN 1 AND 50`) and the contract's, and the engine
  // reads `maxAttempts` out of an untyped `parameters` bag with no upper bound — so a definition
  // declaring 100 is reachable, and it is the INSERT that would fail rather than anything upstream.
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_RETRY_ATTEMPTS) {
    throw refusal(
      "max_attempts_out_of_range",
      `maxAttempts ${String(maxAttempts)} is outside 1..${String(MAX_RETRY_ATTEMPTS)}`,
    );
  }
  if (
    !Number.isInteger(input.attemptNumber) ||
    input.attemptNumber < 1 ||
    input.attemptNumber > MAX_RETRY_ATTEMPTS
  ) {
    throw refusal(
      "attempt_number_out_of_range",
      `attemptNumber ${String(input.attemptNumber)} is outside 1..${String(MAX_RETRY_ATTEMPTS)}`,
    );
  }
  // Each column's CHECK passes independently while the pair violates `WorkflowActivitySchema` —
  // ADR-0289's class, caught here because it is the only place that sees both.
  if (input.attemptNumber > maxAttempts) {
    throw refusal(
      "attempt_exceeds_max_attempts",
      `attemptNumber ${String(input.attemptNumber)} exceeds maxAttempts ${String(maxAttempts)}`,
    );
  }

  const timeoutSeconds = Math.min(
    MAX_ACTIVITY_TIMEOUT_SECONDS,
    Math.max(1, Math.floor(definition.timeoutSeconds)),
  );

  return {
    kind,
    // **Presentational, and therefore derivable where a promise would not be.** An activity has no
    // declared label anywhere in the contract, so the only honest candidates are its key and a
    // refusal. The key is chosen because it *is* the activity's declared identity — the same
    // declaration read at a coarser resolution, not an invention — and because a label makes no
    // claim the system acts on: nothing branches on it, no worker reads it, no proof commits to it.
    // That is the whole of the difference from a delivery guarantee, which is why this one derives
    // and that one refuses.
    label: definitionActivityKey,
    maxAttempts,
    retryPolicy: renderRetryPolicy({
      maxAttempts,
      backoff: readRecordedBackoff(input.schedulingEvent),
    }),
    // **The instance's deadline, clamped to the column's ceiling.** An activity's own timeout has
    // no declaration site either, and the two wrong answers are not symmetric: too short abandons
    // work the definition never asked to be abandoned, too long only defers a timeout nothing
    // enforces today. So the figure is derived from the one declared deadline that exists —
    // `WorkflowDefinition.timeoutSeconds`, which no activity attempt can usefully outlive — and
    // the clamp is the catalog's own 86400, not a number chosen here. Deliberately *not*
    // `definition.timeoutSeconds` raw: its range is 60..31536000 and the column's is 1..86400, so
    // passing it through unclamped is the INSERT failure this fix exists to remove.
    timeoutSeconds,
    // Forced, once `timeoutSeconds` is settled: `WorkflowActivitySchema` requires
    // `timeoutAt > scheduledAt`, and `isActivityTimedOut` answers for an activity that has not
    // started — so the clock runs from the schedule instant, which is also the only base that
    // exists when the row is first written (`startedAt` is nullable and null at that moment).
    timeoutAt: new Date(Date.parse(input.scheduledAt) + timeoutSeconds * 1000).toISOString(),
  };
}

/**
 * `projectActivities` plus the six facts the table requires — the one input
 * `PostgresActivityStore.upsert` accepts, so no caller can assemble a row that the column
 * constraints will reject.
 */
export function projectPersistableActivities(
  events: readonly WorkflowEvent[],
  definition: WorkflowDefinition | undefined,
): readonly ActivityProjection[] {
  const scheduled = schedulingEvents(events);
  return projectActivities(events).map((a): ActivityProjection => {
    const provenance = resolveActivityProvenance({
      activityId: a.id,
      definitionActivityKey: a.definitionActivityKey,
      kind: a.kind,
      attemptNumber: a.attemptNumber,
      maxAttempts: a.maxAttempts,
      scheduledAt: a.scheduledAt,
      definition,
      schedulingEvent: scheduled.get(a.id),
    });
    return {
      id: a.id,
      instanceId: a.instanceId,
      tenantId: a.tenantId,
      kind: provenance.kind,
      definitionActivityKey: a.definitionActivityKey,
      label: provenance.label,
      status: a.status,
      attemptNumber: a.attemptNumber,
      maxAttempts: provenance.maxAttempts,
      retryPolicy: provenance.retryPolicy,
      scheduledAt: a.scheduledAt,
      startedAt: a.startedAt,
      completedAt: a.completedAt,
      timeoutSeconds: provenance.timeoutSeconds,
      timeoutAt: provenance.timeoutAt,
      errorCode: a.errorCode,
      errorMessage: a.errorMessage,
      inputSha256: a.inputSha256,
      outputSha256: a.outputSha256,
      sequenceCursor: a.sequenceCursor,
    };
  });
}
