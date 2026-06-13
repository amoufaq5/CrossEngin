import { DrillRecordSchema, FailoverRecordSchema, type DrillRecord, type FailoverRecord } from "@crossengin/dr";
import { createNodePgConnection, parsePgEnvConfig, type PgConnection } from "@crossengin/kernel-pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresDrillStore } from "./drill-store.js";
import { PostgresFailoverStore } from "./failover-store.js";

/**
 * Real-Postgres integration test (gated on `CROSSENGIN_PG_TEST=1`, skipped offline) for the
 * DR persistence stores: persist a succeeded failover + a passing drill to
 * `meta.failover_records` / `meta.dr_drills`, read them back, and find the overdue drill.
 */
const RUN = process.env["CROSSENGIN_PG_TEST"] === "1";
const suite = RUN ? describe : describe.skip;

suite("DR persistence (real Postgres)", () => {
  let conn: PgConnection;
  let failoverStore: PostgresFailoverStore;
  let drillStore: PostgresDrillStore;

  beforeAll(() => {
    conn = createNodePgConnection(parsePgEnvConfig());
    failoverStore = new PostgresFailoverStore(conn);
    drillStore = new PostgresDrillStore(conn);
  });

  afterAll(async () => {
    if (conn !== undefined) await conn.close();
  });

  it("persists a succeeded failover + reads it back", async () => {
    const id = randomUUID();
    const record: FailoverRecord = FailoverRecordSchema.parse({
      id,
      tier: "tier_1_business_critical",
      trigger: "planned_drill",
      triggeredBy: "ops",
      triggeredAt: "2026-06-13T00:00:00.000Z",
      fromRegion: "us-east",
      toRegion: "us-west",
      affectedApps: ["operate-server"],
      status: "succeeded",
      startedAt: "2026-06-13T00:00:00.000Z",
      completedAt: "2026-06-13T00:05:00.000Z",
      durationSeconds: 300,
      actualRpoSeconds: 30,
      actualRtoSeconds: 300,
    });
    await failoverStore.record(record);
    const back = await failoverStore.get(id);
    expect(back).toMatchObject({ id, status: "succeeded", actualRpoSeconds: 30, fromRegion: "us-east" });
    expect((await failoverStore.listRecent({ limit: 5 })).some((r) => r.id === id)).toBe(true);
  });

  it("persists a passing drill + finds it overdue once past its next-due date", async () => {
    const id = randomUUID();
    const drill: DrillRecord = DrillRecordSchema.parse({
      id,
      kind: "failover_test",
      tier: "tier_1_business_critical",
      scheduledFor: "2026-06-01T00:00:00.000Z",
      executedAt: "2026-06-01T00:30:00.000Z",
      executedBy: "ops",
      scopeRegions: ["us-east", "us-west"],
      scopeApps: ["operate-server"],
      outcome: "passed",
      measuredRpoSeconds: 30,
      measuredRtoSeconds: 300,
      findings: [],
      nextDrillDueAt: "2026-06-10T00:00:00.000Z",
    });
    await drillStore.record(drill);
    expect((await drillStore.get(id))?.outcome).toBe("passed");
    const overdue = await drillStore.listOverdue(new Date("2026-06-15T00:00:00.000Z"));
    expect(overdue.some((d) => d.id === id)).toBe(true);
  });
});
