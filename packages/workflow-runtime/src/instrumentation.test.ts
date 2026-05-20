import { describe, expect, it } from "vitest";

import {
  NoopInstrumentation,
  WORKFLOW_INSTRUMENTATION_KINDS,
  captureInstrumentation,
  combineInstrumentations,
  isWorkflowInstrumentationKind,
  type WorkflowInstrumentation,
  type WorkflowInstrumentationEvent,
} from "./instrumentation.js";

describe("WORKFLOW_INSTRUMENTATION_KINDS", () => {
  it("includes the 14 documented engine events", () => {
    expect(WORKFLOW_INSTRUMENTATION_KINDS).toEqual([
      "instance_started",
      "instance_completed",
      "instance_failed",
      "instance_cancelled",
      "state_transitioned",
      "signal_received",
      "signal_consumed",
      "timer_fired",
      "activity_scheduled",
      "activity_started",
      "activity_completed",
      "activity_failed",
      "action_applied",
      "engine_error",
    ]);
  });

  it("isWorkflowInstrumentationKind validates entries", () => {
    for (const k of WORKFLOW_INSTRUMENTATION_KINDS) {
      expect(isWorkflowInstrumentationKind(k)).toBe(true);
    }
    expect(isWorkflowInstrumentationKind("INSTANCE_STARTED")).toBe(false);
    expect(isWorkflowInstrumentationKind("bogus")).toBe(false);
    expect(isWorkflowInstrumentationKind(null)).toBe(false);
    expect(isWorkflowInstrumentationKind(42)).toBe(false);
  });
});

describe("NoopInstrumentation", () => {
  it("accepts events without throwing or returning anything", () => {
    const event: WorkflowInstrumentationEvent = {
      kind: "instance_started",
      tenantId: "t1",
      instanceId: "wfi_1",
      definitionId: "def_1",
      correlationId: null,
      occurredAt: "2026-05-19T00:00:00Z",
      durationMs: null,
      attributes: {},
    };
    expect(NoopInstrumentation.onEvent(event)).toBeUndefined();
  });
});

describe("captureInstrumentation", () => {
  it("collects events in order", () => {
    const cap = captureInstrumentation();
    cap.instrumentation.onEvent({
      kind: "instance_started",
      tenantId: "t1",
      instanceId: "wfi_1",
      definitionId: "def_1",
      correlationId: null,
      occurredAt: "2026-05-19T00:00:00Z",
      durationMs: null,
      attributes: { foo: "bar" },
    });
    cap.instrumentation.onEvent({
      kind: "state_transitioned",
      tenantId: "t1",
      instanceId: "wfi_1",
      definitionId: "def_1",
      correlationId: null,
      occurredAt: "2026-05-19T00:01:00Z",
      durationMs: null,
      attributes: { previousState: "a", newState: "b" },
    });
    expect(cap.events.length).toBe(2);
    expect(cap.events[0]!.kind).toBe("instance_started");
    expect(cap.events[1]!.attributes["newState"]).toBe("b");
  });

  it("clear() resets the captured events", () => {
    const cap = captureInstrumentation();
    cap.instrumentation.onEvent({
      kind: "instance_started",
      tenantId: "t1",
      instanceId: null,
      definitionId: null,
      correlationId: null,
      occurredAt: "2026-05-19T00:00:00Z",
      durationMs: null,
      attributes: {},
    });
    expect(cap.events.length).toBe(1);
    cap.clear();
    expect(cap.events.length).toBe(0);
  });
});

describe("combineInstrumentations", () => {
  it("dispatches events to all children in order", async () => {
    const a = captureInstrumentation();
    const b = captureInstrumentation();
    const combined = combineInstrumentations(a.instrumentation, b.instrumentation);
    await combined.onEvent({
      kind: "instance_started",
      tenantId: "t1",
      instanceId: "wfi_1",
      definitionId: "def_1",
      correlationId: null,
      occurredAt: "2026-05-19T00:00:00Z",
      durationMs: null,
      attributes: {},
    });
    expect(a.events.length).toBe(1);
    expect(b.events.length).toBe(1);
  });

  it("returns NoopInstrumentation for empty input", () => {
    const c = combineInstrumentations();
    expect(c).toBe(NoopInstrumentation);
  });

  it("returns the single child unchanged when given one", () => {
    const a = captureInstrumentation();
    const c = combineInstrumentations(a.instrumentation);
    expect(c).toBe(a.instrumentation);
  });

  it("awaits async children sequentially", async () => {
    const order: string[] = [];
    const slow: WorkflowInstrumentation = {
      async onEvent() {
        await new Promise((r) => setTimeout(r, 5));
        order.push("slow");
      },
    };
    const fast: WorkflowInstrumentation = {
      onEvent() {
        order.push("fast");
      },
    };
    await combineInstrumentations(slow, fast).onEvent({
      kind: "instance_started",
      tenantId: "t1",
      instanceId: null,
      definitionId: null,
      correlationId: null,
      occurredAt: "2026-05-19T00:00:00Z",
      durationMs: null,
      attributes: {},
    });
    expect(order).toEqual(["slow", "fast"]);
  });
});
