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

export function listCompensatableActivities(
  events: readonly WorkflowEvent[],
): readonly CompletedActivitySummary[] {
  interface PendingActivity {
    activityId: string;
    definitionActivityKey: string;
    kind: ActivityKind;
    completedAt: string;
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
        completedAt: event.occurredAt,
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
    if (compensated.has(a.activityId)) continue;
    if (!SIDE_EFFECT_KINDS.has(a.kind)) continue;
    out.push(a);
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
