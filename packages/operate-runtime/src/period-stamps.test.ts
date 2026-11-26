import { buildErpCorePack } from "@crossengin/pack-erp-core";
import { describe, expect, it } from "vitest";

import { CLOSED_PERIOD_STATES, periodClosedAtStampEffect, periodClosedAtWiring } from "./period-stamps.js";
import { InMemoryEntityStore } from "./store.js";
import type { WriteEffectInput } from "./write-effects.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-07-01T09:00:00.000Z");

describe("periodClosedAtWiring", () => {
  it("is wired on erp-core over the lifecycle's own state field", () => {
    expect(periodClosedAtWiring(buildErpCorePack())).toEqual({ entity: "FiscalPeriod", stateField: "status", field: "closed_at" });
  });

  it("is absent when the period declares no closed_at", () => {
    const core = buildErpCorePack();
    const bare = {
      ...core,
      entities: (core.entities ?? []).map((e) =>
        e.name === "FiscalPeriod" ? { ...e, fields: e.fields.filter((f) => f.name !== "closed_at") } : e,
      ),
    };
    expect(periodClosedAtWiring(bare)).toBeNull();
  });

  it("counts closed and locked as closed, and nothing else", () => {
    expect([...CLOSED_PERIOD_STATES]).toEqual(["closed", "locked"]);
  });
});

describe("periodClosedAtStampEffect", () => {
  const effect = periodClosedAtStampEffect({ entity: "FiscalPeriod", stateField: "status", field: "closed_at", clock: { now: () => NOW } });

  async function run(beforeStatus: string, afterStatus: string, beforeClosedAt: string | null = null) {
    const store = new InMemoryEntityStore();
    const row = await store.create(TENANT, "FiscalPeriod", { status: afterStatus, closed_at: beforeClosedAt });
    const id = String(row["id"]);
    const input: WriteEffectInput = {
      operation: "transition",
      entity: "FiscalPeriod",
      tenantId: TENANT,
      id,
      before: { status: beforeStatus, closed_at: beforeClosedAt },
      after: { status: afterStatus, closed_at: beforeClosedAt },
      store,
    };
    await effect(input);
    return (await store.get(TENANT, "FiscalPeriod", id))?.["closed_at"] ?? null;
  }

  it("stamps the close time on the edge into closed", async () => {
    expect(await run("open", "closed")).toBe(NOW.toISOString());
    expect(await run("closing", "closed")).toBe(NOW.toISOString());
  });

  it("keeps the close time across closed → locked", async () => {
    expect(await run("closed", "locked", "2026-06-30T23:00:00.000Z")).toBe("2026-06-30T23:00:00.000Z");
  });

  it("clears it on the edge out of closed", async () => {
    expect(await run("closed", "open", "2026-06-30T23:00:00.000Z")).toBeNull();
  });

  it("writes nothing on an edge that changes neither side", async () => {
    expect(await run("open", "closing")).toBeNull();
  });

  it("ignores other entities and creates", async () => {
    const store = new InMemoryEntityStore();
    let wrote = false;
    const spy = Object.assign(Object.create(store) as InMemoryEntityStore, {
      update: () => {
        wrote = true;
        return Promise.resolve(null);
      },
    });
    const base = { tenantId: TENANT, id: "x", before: { status: "open" }, after: { status: "closed" }, store: spy };
    await effect({ ...base, operation: "transition", entity: "Invoice" });
    await effect({ ...base, operation: "create", entity: "FiscalPeriod" });
    expect(wrote).toBe(false);
  });
});
