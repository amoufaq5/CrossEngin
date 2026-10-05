import { META_WORKFLOW_ACTIVITIES } from "@crossengin/kernel/bootstrap";
import type { PgConnection, PgQueryResult } from "@crossengin/kernel-pg";
import { RetryPolicySchema } from "@crossengin/workflow-engine";
import { describe, expect, it, vi } from "vitest";

import { PostgresActivityStore, type ActivityProjection } from "./activity-store.js";
import { WorkflowInstanceIdResolver } from "./id-mapping.js";
import {
  insertColumnList,
  missingRequiredColumns,
  requiredColumnNames,
} from "./required-columns.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const INSTANCE_UUID = "00000000-0000-4000-8000-000000000123";

function fixtureActivity(overrides: Partial<ActivityProjection> = {}): ActivityProjection {
  return {
    id: "wfa_act00001",
    instanceId: "wfi_inst0001",
    tenantId: TENANT,
    kind: "http_call",
    definitionActivityKey: "charge_card",
    label: "charge_card",
    status: "scheduled",
    attemptNumber: 1,
    maxAttempts: 3,
    retryPolicy: {
      strategy: "exponential_backoff",
      maxAttempts: 3,
      initialDelaySeconds: 2,
      maxDelaySeconds: 60,
      retryableErrorCodes: [],
      nonRetryableErrorCodes: [],
    },
    scheduledAt: "2026-05-16T12:00:00.000Z",
    startedAt: null,
    completedAt: null,
    timeoutSeconds: 300,
    timeoutAt: "2026-05-16T12:05:00.000Z",
    errorCode: null,
    errorMessage: null,
    inputSha256: null,
    outputSha256: null,
    sequenceCursor: 4,
    ...overrides,
  };
}

function mockConnection(
  handler: (sql: string, params: readonly unknown[] | undefined) => PgQueryResult,
  capture?: Array<{ sql: string; params: readonly unknown[] | undefined }>,
): PgConnection {
  return {
    query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
      if (capture !== undefined) capture.push({ sql, params });
      return handler(sql, params);
    }) as PgConnection["query"],
    transaction: vi.fn() as PgConnection["transaction"],
    withAdvisoryLock: vi.fn() as PgConnection["withAdvisoryLock"],
    close: vi.fn() as PgConnection["close"],
  };
}

function boundValue(
  entry: { sql: string; params: readonly unknown[] | undefined },
  column: string,
): unknown {
  const index = insertColumnList(entry.sql).indexOf(column);
  expect(index).toBeGreaterThanOrEqual(0);
  return entry.params?.[index];
}

async function captureUpsert(
  projection: ActivityProjection,
): Promise<{ sql: string; params: readonly unknown[] | undefined }> {
  const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
  const conn = mockConnection(() => ({ rows: [], rowCount: 1 }), capture);
  const resolver = new WorkflowInstanceIdResolver(conn);
  resolver.register("wfi_inst0001", INSTANCE_UUID);
  const store = new PostgresActivityStore({ conn, instanceResolver: resolver });
  await store.upsert(projection);
  return capture[0]!;
}

/**
 * The durable half of ADR-0332's fix. The old suite's five tests passed against a statement missing
 * six NOT NULL columns, because the offline fake asserts SQL shape and cannot know a column exists.
 */
describe("PostgresActivityStore — catalog-derived column coverage", () => {
  it("names every required column of META_WORKFLOW_ACTIVITIES", async () => {
    const insert = await captureUpsert(fixtureActivity());
    expect(missingRequiredColumns(META_WORKFLOW_ACTIVITIES, insert.sql)).toEqual([]);
  });

  it("required columns are exactly the notNull ones with no default", () => {
    expect([...requiredColumnNames(META_WORKFLOW_ACTIVITIES)].sort()).toEqual([
      "activity_id",
      "attempt_number",
      "definition_activity_key",
      "instance_id",
      "kind",
      "label",
      "max_attempts",
      "retry_policy",
      "scheduled_at",
      "sequence_cursor",
      "status",
      "tenant_id",
      "timeout_at",
      "timeout_seconds",
    ]);
  });

  it("names the six columns whose omission threw against every real database", async () => {
    const insert = await captureUpsert(fixtureActivity());
    const named = insertColumnList(insert.sql);
    for (const column of [
      "label",
      "max_attempts",
      "retry_policy",
      "timeout_seconds",
      "timeout_at",
      "sequence_cursor",
    ]) {
      expect(named).toContain(column);
    }
  });

  it("binds one parameter per named column", async () => {
    const insert = await captureUpsert(fixtureActivity());
    expect(insert.params).toHaveLength(insertColumnList(insert.sql).length);
  });

  it("names no column the catalog does not declare", async () => {
    const insert = await captureUpsert(fixtureActivity());
    const declared = new Set(META_WORKFLOW_ACTIVITIES.columns.map((c) => c.name));
    expect(insertColumnList(insert.sql).filter((c) => !declared.has(c))).toEqual([]);
  });
});

describe("PostgresActivityStore.upsert", () => {
  it("INSERTs with ON CONFLICT (activity_id) DO UPDATE", async () => {
    const insert = await captureUpsert(fixtureActivity());
    expect(insert.sql).toContain("INSERT INTO meta.workflow_activities");
    expect(insert.sql).toContain("ON CONFLICT (activity_id) DO UPDATE");
    expect(boundValue(insert, "activity_id")).toBe("wfa_act00001");
    expect(boundValue(insert, "instance_id")).toBe(INSTANCE_UUID);
    expect(boundValue(insert, "kind")).toBe("http_call");
    expect(boundValue(insert, "status")).toBe("scheduled");
  });

  it("binds the retry policy as JSON text the contract accepts back", async () => {
    const insert = await captureUpsert(fixtureActivity());
    const raw = boundValue(insert, "retry_policy");
    expect(typeof raw).toBe("string");
    expect(RetryPolicySchema.safeParse(JSON.parse(raw as string)).success).toBe(true);
  });

  it("binds label, max_attempts, timeout and sequence cursor", async () => {
    const insert = await captureUpsert(fixtureActivity());
    expect(boundValue(insert, "label")).toBe("charge_card");
    expect(boundValue(insert, "max_attempts")).toBe(3);
    expect(boundValue(insert, "timeout_seconds")).toBe(300);
    expect(boundValue(insert, "timeout_at")).toBe("2026-05-16T12:05:00.000Z");
    expect(boundValue(insert, "sequence_cursor")).toBe(4);
  });

  it("leaves the schedule-time facts out of the DO UPDATE set", async () => {
    const insert = await captureUpsert(fixtureActivity());
    const doUpdate = insert.sql.slice(insert.sql.indexOf("DO UPDATE"));
    for (const column of ["label", "retry_policy", "timeout_seconds", "sequence_cursor"]) {
      expect(doUpdate).not.toContain(`${column} = EXCLUDED`);
    }
  });

  it("binds a timeout strictly after the schedule instant, as the contract requires", async () => {
    const insert = await captureUpsert(fixtureActivity());
    expect(Date.parse(boundValue(insert, "timeout_at") as string)).toBeGreaterThan(
      Date.parse(boundValue(insert, "scheduled_at") as string),
    );
  });

  it("binds the same ceiling to max_attempts and into the retry policy", async () => {
    // `decideActivityRetry` reads `retryPolicy.maxAttempts` while `claimDueActivities` reads the
    // column, so the two disagreeing would give a worker a different licence than the planner.
    const insert = await captureUpsert(fixtureActivity({ maxAttempts: 7, retryPolicy: {
      strategy: "fixed_delay", maxAttempts: 7, initialDelaySeconds: 3, maxDelaySeconds: 3,
      retryableErrorCodes: [], nonRetryableErrorCodes: [],
    } }));
    expect(boundValue(insert, "max_attempts")).toBe(7);
    expect(JSON.parse(boundValue(insert, "retry_policy") as string).maxAttempts).toBe(7);
  });

  it("threads completedAt + outputSha256 for succeeded activities", async () => {
    const insert = await captureUpsert(
      fixtureActivity({
        status: "succeeded",
        completedAt: "2026-05-16T12:00:30.000Z",
        outputSha256: "a".repeat(64),
      }),
    );
    expect(boundValue(insert, "completed_at")).toBe("2026-05-16T12:00:30.000Z");
    expect(boundValue(insert, "output_sha256")).toBe("a".repeat(64));
  });

  it("threads errorCode + errorMessage for failed activities", async () => {
    const insert = await captureUpsert(
      fixtureActivity({
        status: "failed",
        completedAt: "2026-05-16T12:00:30.000Z",
        errorCode: "503",
        errorMessage: "service unavailable",
      }),
    );
    expect(boundValue(insert, "error_code")).toBe("503");
    expect(boundValue(insert, "error_message")).toBe("service unavailable");
  });

  it("rejects when instance is not resolvable", async () => {
    const conn = mockConnection(() => ({ rows: [], rowCount: 0 }));
    const resolver = new WorkflowInstanceIdResolver(conn);
    const store = new PostgresActivityStore({ conn, instanceResolver: resolver });
    await expect(store.upsert(fixtureActivity({ instanceId: "wfi_unknown01" }))).rejects.toThrow(
      /workflow instance not found/,
    );
  });
});

describe("PostgresActivityStore.upsertMany", () => {
  it("calls upsert for each projection", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 1 }), capture);
    const resolver = new WorkflowInstanceIdResolver(conn);
    resolver.register("wfi_inst0001", INSTANCE_UUID);
    const store = new PostgresActivityStore({ conn, instanceResolver: resolver });
    await store.upsertMany([
      fixtureActivity({ id: "wfa_act00001" }),
      fixtureActivity({ id: "wfa_act00002", definitionActivityKey: "notify", label: "notify" }),
    ]);
    const inserts = capture.filter((c) => c.sql.includes("INSERT INTO meta.workflow_activities"));
    expect(inserts).toHaveLength(2);
  });

  it("issues no statement for an empty list", async () => {
    const capture: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const conn = mockConnection(() => ({ rows: [], rowCount: 1 }), capture);
    const resolver = new WorkflowInstanceIdResolver(conn);
    const store = new PostgresActivityStore({ conn, instanceResolver: resolver });
    await store.upsertMany([]);
    expect(capture).toEqual([]);
  });
});
