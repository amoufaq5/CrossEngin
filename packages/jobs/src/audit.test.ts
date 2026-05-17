import { describe, expect, it } from "vitest";
import {
  DeadLetterRecordSchema,
  JOB_RUN_STATUSES,
  JobCostRecordSchema,
  JobRunRecordSchema,
  JobRunTriggerInfoSchema,
} from "./audit.js";

const now = "2026-05-11T10:00:00.000Z";

describe("JobRunTriggerInfoSchema", () => {
  it("parses each trigger kind", () => {
    expect(() =>
      JobRunTriggerInfoSchema.parse({
        kind: "event",
        eventName: "prescription.verified",
        eventId: "evt_1",
      }),
    ).not.toThrow();
    expect(() =>
      JobRunTriggerInfoSchema.parse({ kind: "scheduled", scheduledFor: now }),
    ).not.toThrow();
    expect(() =>
      JobRunTriggerInfoSchema.parse({
        kind: "delayed",
        afterEventName: "x.y",
        afterEventId: "evt_2",
        delayMillis: 60_000,
      }),
    ).not.toThrow();
    expect(() =>
      JobRunTriggerInfoSchema.parse({
        kind: "userInvoked",
        action: "pdf.generate",
        invokedBy: "u_1",
      }),
    ).not.toThrow();
    expect(() =>
      JobRunTriggerInfoSchema.parse({
        kind: "workflow",
        workflow: "wf",
        step: "step",
        runId: "r_1",
      }),
    ).not.toThrow();
    expect(() =>
      JobRunTriggerInfoSchema.parse({
        kind: "cdc",
        table: "prescriptions",
        operation: "update",
        primaryKey: "p_1",
      }),
    ).not.toThrow();
  });

  it("rejects an unknown trigger kind", () => {
    expect(() => JobRunTriggerInfoSchema.parse({ kind: "manual" })).toThrow();
  });
});

describe("JobRunRecordSchema", () => {
  it("parses a completed run", () => {
    const r = {
      jobId: "notify-patient",
      jobKind: "event" as const,
      tenantId: "t_1",
      runId: "r_1",
      trigger: { kind: "event" as const, eventName: "prescription.verified", eventId: "e" },
      startedAt: now,
      completedAt: now,
      durationMillis: 1234,
      attempts: 1,
      status: "completed" as const,
      inputDataClass: "phi" as const,
      outputDataClass: "internal" as const,
      error: null,
    };
    expect(() => JobRunRecordSchema.parse(r)).not.toThrow();
  });

  it("permits null completion fields on running rows", () => {
    expect(() =>
      JobRunRecordSchema.parse({
        jobId: "x",
        jobKind: "event",
        tenantId: "t",
        runId: "r",
        trigger: { kind: "scheduled", scheduledFor: now },
        startedAt: now,
        completedAt: null,
        durationMillis: null,
        attempts: 1,
        status: "running",
        inputDataClass: "internal",
        outputDataClass: "internal",
        error: null,
      }),
    ).not.toThrow();
  });

  it("rejects negative duration", () => {
    expect(() =>
      JobRunRecordSchema.parse({
        jobId: "x",
        jobKind: "event",
        tenantId: "t",
        runId: "r",
        trigger: { kind: "scheduled", scheduledFor: now },
        startedAt: now,
        completedAt: now,
        durationMillis: -1,
        attempts: 1,
        status: "completed",
        inputDataClass: "internal",
        outputDataClass: "internal",
        error: null,
      }),
    ).toThrow();
  });

  it("JOB_RUN_STATUSES includes dead-lettered", () => {
    expect(JOB_RUN_STATUSES).toContain("dead-lettered");
  });
});

describe("DeadLetterRecordSchema", () => {
  it("parses a dead-letter entry", () => {
    expect(() =>
      DeadLetterRecordSchema.parse({
        jobId: "scan-virus",
        tenantId: "t",
        runId: "r",
        deadLetteredAt: now,
        reason: "max-retries-exceeded",
        attemptCount: 5,
        finalError: { kind: "retryable", message: "timeout" },
        reprocessable: true,
        reprocessedAt: null,
      }),
    ).not.toThrow();
  });

  it("rejects an unknown reason", () => {
    expect(() =>
      DeadLetterRecordSchema.parse({
        jobId: "x",
        tenantId: "t",
        runId: "r",
        deadLetteredAt: now,
        reason: "unknown-reason",
        attemptCount: 1,
        finalError: { kind: "unknown", message: "x" },
        reprocessable: true,
        reprocessedAt: null,
      }),
    ).toThrow();
  });
});

describe("JobCostRecordSchema", () => {
  it("parses a cost entry", () => {
    expect(() =>
      JobCostRecordSchema.parse({
        jobId: "notify-patient",
        tenantId: "t",
        runId: "r",
        estimatedCostUsd: 0.00002,
        occurredAt: now,
        costBasis: "inngest-execution",
      }),
    ).not.toThrow();
  });

  it("rejects a negative cost", () => {
    expect(() =>
      JobCostRecordSchema.parse({
        jobId: "x",
        tenantId: "t",
        runId: "r",
        estimatedCostUsd: -0.01,
        occurredAt: now,
        costBasis: "external-api",
      }),
    ).toThrow();
  });
});
