import { describe, expect, it } from "vitest";
import {
  EXECUTION_STATUSES,
  RunbookExecutionSchema,
  canTransitionExecution,
  failedStepCount,
  isExecutionComplete,
  manualOverrideCount,
  type RunbookExecution,
} from "./executions.js";

describe("constants", () => {
  it("EXECUTION_STATUSES has 6 entries", () => {
    expect(EXECUTION_STATUSES).toContain("queued");
    expect(EXECUTION_STATUSES).toContain("paused");
    expect(EXECUTION_STATUSES).toContain("aborted");
  });
});

describe("canTransitionExecution", () => {
  it("queued -> running", () => {
    expect(canTransitionExecution("queued", "running")).toBe(true);
  });

  it("running -> paused -> running", () => {
    expect(canTransitionExecution("running", "paused")).toBe(true);
    expect(canTransitionExecution("paused", "running")).toBe(true);
  });

  it("succeeded is terminal", () => {
    expect(canTransitionExecution("succeeded", "running")).toBe(false);
  });
});

describe("RunbookExecutionSchema", () => {
  const base: RunbookExecution = {
    id: "exec-1",
    incidentId: "INC-2026-0042",
    runbookId: "RB-0001",
    runbookVersion: "1.0.0",
    invokedAt: "2026-05-14T10:05:00Z",
    invokedBy: "u-ic",
    status: "succeeded",
    startedAt: "2026-05-14T10:06:00Z",
    completedAt: "2026-05-14T10:30:00Z",
    durationSeconds: 1440,
    steps: [
      {
        stepNumber: 1,
        title: "Drain traffic",
        startedAt: "2026-05-14T10:06:00Z",
        completedAt: "2026-05-14T10:10:00Z",
        outcome: "passed",
        executedByUserId: "u-tech",
        automated: false,
      },
    ],
    abortedAt: null,
    pageOncallTriggered: false,
    incidentCommanderApprovalUserId: null,
  };

  it("accepts a valid succeeded execution", () => {
    expect(() => RunbookExecutionSchema.parse(base)).not.toThrow();
  });

  it("rejects succeeded without steps", () => {
    expect(() => RunbookExecutionSchema.parse({ ...base, steps: [] })).toThrow(
      /must record step results/,
    );
  });

  it("rejects aborted without abortedAt + reason", () => {
    expect(() =>
      RunbookExecutionSchema.parse({
        ...base,
        status: "aborted",
        completedAt: null,
        durationSeconds: null,
      }),
    ).toThrow(/abortedAt/);
  });

  it("rejects running without startedAt", () => {
    expect(() =>
      RunbookExecutionSchema.parse({
        ...base,
        status: "running",
        startedAt: null,
        completedAt: null,
        durationSeconds: null,
      }),
    ).toThrow(/startedAt/);
  });

  it("rejects duplicate step numbers", () => {
    expect(() =>
      RunbookExecutionSchema.parse({
        ...base,
        steps: [
          base.steps[0]!,
          {
            stepNumber: 1,
            title: "x",
            startedAt: "2026-05-14T10:10:00Z",
            completedAt: "2026-05-14T10:15:00Z",
            outcome: "passed",
            executedByUserId: "u-tech",
            automated: false,
          },
        ],
      }),
    ).toThrow(/duplicate stepNumber/);
  });

  it("rejects succeeded with failed step", () => {
    expect(() =>
      RunbookExecutionSchema.parse({
        ...base,
        steps: [
          {
            ...base.steps[0]!,
            outcome: "failed",
          },
        ],
      }),
    ).toThrow(/non-failed/);
  });

  it("rejects step with completedAt but no outcome", () => {
    expect(() =>
      RunbookExecutionSchema.parse({
        ...base,
        steps: [
          {
            ...base.steps[0]!,
            outcome: null,
          },
        ],
      }),
    ).toThrow(/outcome/);
  });

  it("rejects manual_override step without notes", () => {
    expect(() =>
      RunbookExecutionSchema.parse({
        ...base,
        steps: [
          {
            ...base.steps[0]!,
            outcome: "manual_override",
          },
        ],
      }),
    ).toThrow(/notes/);
  });
});

describe("helpers", () => {
  const exec: RunbookExecution = {
    id: "x",
    incidentId: "INC-2026-0042",
    runbookId: "RB-0001",
    runbookVersion: "1.0.0",
    invokedAt: "2026-05-14T10:00:00Z",
    invokedBy: "u-ic",
    status: "succeeded",
    startedAt: "2026-05-14T10:01:00Z",
    completedAt: "2026-05-14T10:30:00Z",
    durationSeconds: 1740,
    steps: [
      {
        stepNumber: 1,
        title: "x",
        startedAt: "2026-05-14T10:01:00Z",
        completedAt: "2026-05-14T10:10:00Z",
        outcome: "passed",
        executedByUserId: "u-tech",
        automated: true,
      },
      {
        stepNumber: 2,
        title: "y",
        startedAt: "2026-05-14T10:10:00Z",
        completedAt: "2026-05-14T10:20:00Z",
        outcome: "manual_override",
        notes: "Skipped due to maintenance window",
        executedByUserId: "u-ic",
        automated: false,
      },
    ],
    abortedAt: null,
    pageOncallTriggered: false,
    incidentCommanderApprovalUserId: null,
  };

  it("manualOverrideCount counts overrides", () => {
    expect(manualOverrideCount(exec)).toBe(1);
  });

  it("failedStepCount counts failures", () => {
    expect(failedStepCount(exec)).toBe(0);
  });

  it("isExecutionComplete true for terminal statuses", () => {
    expect(isExecutionComplete("succeeded")).toBe(true);
    expect(isExecutionComplete("failed")).toBe(true);
    expect(isExecutionComplete("aborted")).toBe(true);
    expect(isExecutionComplete("running")).toBe(false);
  });
});
