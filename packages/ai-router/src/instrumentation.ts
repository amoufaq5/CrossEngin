export const ROUTER_INSTRUMENTATION_KINDS = [
  "llm_call_started",
  "llm_call_completed",
  "llm_call_failed",
  "embed_call_started",
  "embed_call_completed",
  "embed_call_failed",
  "ceiling_resolved",
] as const;
export type RouterInstrumentationKind = (typeof ROUTER_INSTRUMENTATION_KINDS)[number];

export function isRouterInstrumentationKind(value: unknown): value is RouterInstrumentationKind {
  return (
    typeof value === "string" && (ROUTER_INSTRUMENTATION_KINDS as readonly string[]).includes(value)
  );
}

export interface RouterInstrumentationEvent {
  readonly kind: RouterInstrumentationKind;
  readonly tenantId: string;
  readonly sessionId: string;
  readonly task: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly occurredAt: string;
  readonly durationMs: number | null;
  readonly attributes: Readonly<Record<string, unknown>>;
}

export interface RouterInstrumentation {
  onEvent(event: RouterInstrumentationEvent): Promise<void> | void;
}

export const NoopRouterInstrumentation: RouterInstrumentation = {
  onEvent(): void {
    // no-op
  },
};

export function captureRouterInstrumentation(): {
  readonly instrumentation: RouterInstrumentation;
  readonly events: ReadonlyArray<RouterInstrumentationEvent>;
  readonly clear: () => void;
} {
  const events: RouterInstrumentationEvent[] = [];
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

export function combineRouterInstrumentations(
  ...children: ReadonlyArray<RouterInstrumentation>
): RouterInstrumentation {
  if (children.length === 0) return NoopRouterInstrumentation;
  if (children.length === 1) return children[0]!;
  return {
    async onEvent(event) {
      for (const child of children) {
        await child.onEvent(event);
      }
    },
  };
}
