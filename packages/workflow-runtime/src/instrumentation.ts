export const WORKFLOW_INSTRUMENTATION_KINDS = [
  "instance_started",
  "instance_completed",
  "instance_failed",
  "instance_cancelled",
  "state_transitioned",
  "signal_received",
  "signal_consumed",
  "timer_set",
  "timer_fired",
  "timer_cancelled",
  "activity_scheduled",
  "activity_started",
  "activity_completed",
  "activity_failed",
  "action_applied",
  "engine_error",
] as const;
export type WorkflowInstrumentationKind =
  (typeof WORKFLOW_INSTRUMENTATION_KINDS)[number];

export function isWorkflowInstrumentationKind(
  value: unknown,
): value is WorkflowInstrumentationKind {
  return (
    typeof value === "string" &&
    (WORKFLOW_INSTRUMENTATION_KINDS as readonly string[]).includes(value)
  );
}

export interface WorkflowInstrumentationEvent {
  readonly kind: WorkflowInstrumentationKind;
  readonly tenantId: string;
  readonly instanceId: string | null;
  readonly definitionId: string | null;
  readonly correlationId: string | null;
  readonly occurredAt: string;
  readonly durationMs: number | null;
  readonly attributes: Readonly<Record<string, unknown>>;
}

export interface WorkflowInstrumentation {
  onEvent(event: WorkflowInstrumentationEvent): Promise<void> | void;
}

export const NoopInstrumentation: WorkflowInstrumentation = {
  onEvent(): void {
    // no-op
  },
};

export function captureInstrumentation(): {
  readonly instrumentation: WorkflowInstrumentation;
  readonly events: ReadonlyArray<WorkflowInstrumentationEvent>;
  readonly clear: () => void;
} {
  const events: WorkflowInstrumentationEvent[] = [];
  return {
    instrumentation: {
      onEvent(event) {
        events.push(event);
      },
    },
    events,
    clear() {
      events.length = 0;
    },
  };
}

export function combineInstrumentations(
  ...children: ReadonlyArray<WorkflowInstrumentation>
): WorkflowInstrumentation {
  if (children.length === 0) return NoopInstrumentation;
  if (children.length === 1) return children[0]!;
  return {
    async onEvent(event) {
      for (const child of children) {
        await child.onEvent(event);
      }
    },
  };
}
