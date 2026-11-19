import type {
  ActivityKind,
  WorkflowDefinition,
  WorkflowEvent,
} from "@crossengin/workflow-engine";

const SIDE_EFFECT_KINDS: ReadonlySet<ActivityKind> = new Set([
  "http_call",
  "db_write",
  "ai_call",
  "send_notification",
  "child_workflow",
]);

export interface CompletedActivitySummary {
  readonly activityId: string;
  readonly definitionActivityKey: string;
  readonly kind: ActivityKind;
  readonly completedAt: string;
  readonly compensationActivityKey: string | null;
}

/**
 * The side-effect activities a rollback must undo: those with an `activity_completed` and no
 * `activity_compensated`.
 *
 * It used to admit every `activity_scheduled`, so a charge that failed outright was "refunded", a
 * charge that failed twice and succeeded on its third attempt was refunded three times (each retry
 * schedules a fresh activityId), and an activity cancelled before its handler ran was compensated
 * though `never_started` promises nothing ran. The completion is the evidence that the side effect
 * happened, so it is the only admission — a failed, timed-out or never-started attempt leaves it out,
 * and a retried activity contributes exactly its one successful attempt. A completion that arrived
 * after a cooperative cancellation still counts: the cancellation sealed the status, not the fact
 * that the handler finished its work. This is the rule `computeCompensationPlan` in
 * `@crossengin/workflow-engine` already applies (`status === "succeeded"`); the runtime now agrees
 * with it.
 */
export function listCompensatableActivities(
  events: readonly WorkflowEvent[],
): readonly CompletedActivitySummary[] {
  interface PendingActivity {
    activityId: string;
    definitionActivityKey: string;
    kind: ActivityKind;
    completedAt: string | null;
    compensationActivityKey: string | null;
  }
  const scheduledByActivityId = new Map<string, PendingActivity>();
  const compensated = new Set<string>();
  for (const event of events) {
    if (event.activityId === null) continue;
    if (event.kind === "activity_scheduled") {
      scheduledByActivityId.set(event.activityId, {
        activityId: event.activityId,
        definitionActivityKey:
          typeof event.payload["definitionActivityKey"] === "string"
            ? (event.payload["definitionActivityKey"] as string)
            : "activity",
        kind:
          typeof event.payload["kind"] === "string"
            ? (event.payload["kind"] as ActivityKind)
            : "transformation",
        completedAt: null,
        compensationActivityKey:
          typeof event.payload["compensationActivityKey"] === "string"
            ? (event.payload["compensationActivityKey"] as string)
            : null,
      });
    } else if (event.kind === "activity_completed") {
      const existing = scheduledByActivityId.get(event.activityId);
      if (existing !== undefined) {
        existing.completedAt = event.occurredAt;
      }
    } else if (event.kind === "activity_compensated") {
      compensated.add(event.activityId);
    }
  }
  const out: CompletedActivitySummary[] = [];
  for (const a of scheduledByActivityId.values()) {
    if (a.completedAt === null) continue;
    if (compensated.has(a.activityId)) continue;
    if (!SIDE_EFFECT_KINDS.has(a.kind)) continue;
    out.push({ ...a, completedAt: a.completedAt });
  }
  return out;
}

export interface CompensationStep {
  readonly originalActivityId: string;
  readonly compensationActivityKey: string;
}

export interface CompensationPlan {
  readonly strategy: WorkflowDefinition["compensationStrategy"];
  readonly steps: readonly CompensationStep[];
}

export function planCompensation(input: {
  readonly definition: WorkflowDefinition;
  readonly events: readonly WorkflowEvent[];
}): CompensationPlan {
  const completed = listCompensatableActivities(input.events);
  if (input.definition.compensationStrategy === "no_compensation") {
    return { strategy: "no_compensation", steps: [] };
  }
  const steps: CompensationStep[] = [];
  for (const a of completed) {
    if (a.compensationActivityKey === null) continue;
    steps.push({
      originalActivityId: a.activityId,
      compensationActivityKey: a.compensationActivityKey,
    });
  }
  if (input.definition.compensationStrategy === "immediate_reverse_order") {
    steps.reverse();
  }
  return { strategy: input.definition.compensationStrategy, steps };
}

export function hasOutstandingCompensation(events: readonly WorkflowEvent[]): boolean {
  return listCompensatableActivities(events).length > 0;
}

/**
 * The source `ActivityKind` of every still-compensatable activity, keyed by its activityId. The
 * engine uses this to resolve a compensating handler (its registry key needs the source kind) and
 * to carry the kind onto the emitted `activity_compensated` record. Already-compensated activities
 * are absent (they are excluded by `listCompensatableActivities`).
 */
export function compensationKindByActivityId(
  events: readonly WorkflowEvent[],
): ReadonlyMap<string, ActivityKind> {
  const out = new Map<string, ActivityKind>();
  for (const a of listCompensatableActivities(events)) {
    out.set(a.activityId, a.kind);
  }
  return out;
}
