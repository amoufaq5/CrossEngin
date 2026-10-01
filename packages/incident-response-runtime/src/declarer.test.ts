import { describe, expect, it } from "vitest";

import { FixedClock } from "./clock.js";
import {
  CountingIncidentDeclarer,
  INCIDENT_CLOSE_OUTS,
  type IncidentDeclarationRequest,
} from "./declarer.js";
import { IncidentExecutor } from "./executor.js";

function request(
  over: Partial<IncidentDeclarationRequest> = {},
): IncidentDeclarationRequest {
  return {
    title: "SLO burn alert: slo_api on api.read",
    severity: "sev2",
    category: "availability",
    declaredBy: "system-slo-enforcer",
    detail: "Auto-declared by SLO enforcement (page): burn 20.0x over 1h / 20.0x over 5m.",
    metadata: { surface: "api.read", autoDeclared: true },
    ...over,
  };
}

const AT = "2026-10-01T12:00:00.000Z";

describe("INCIDENT_CLOSE_OUTS", () => {
  it("names the outcomes an automated recovery can reach", () => {
    expect([...INCIDENT_CLOSE_OUTS]).toEqual([
      "unpersisted",
      "cancelled",
      "human_owned",
      "failed",
    ]);
  });
});

describe("CountingIncidentDeclarer", () => {
  it("issues ids from 0001 in declaration order", async () => {
    const declarer = new CountingIncidentDeclarer({ clock: new FixedClock(new Date(AT)) });
    const first = await declarer.declare(request());
    const second = await declarer.declare(request());
    expect(first.id).toBe("INC-2026-0001");
    expect(second.id).toBe("INC-2026-0002");
  });

  it("counts per year, so a declaration in a new year starts at 0001", async () => {
    const declarer = new CountingIncidentDeclarer({ clock: new FixedClock(new Date(AT)) });
    await declarer.declare(request());
    const next = await declarer.declare(request({ declaredAt: "2027-01-02T00:00:00.000Z" }));
    expect(next.id).toBe("INC-2027-0001");
  });

  it("takes the year from the declaration time, not from the clock", async () => {
    const declarer = new CountingIncidentDeclarer({ clock: new FixedClock(new Date(AT)) });
    const record = await declarer.declare(request({ declaredAt: "2024-03-04T05:06:07.000Z" }));
    expect(record.id).toBe("INC-2024-0001");
    expect(record.declaredAt).toBe("2024-03-04T05:06:07.000Z");
  });

  it("stamps the clock when the request carries no declaration time", async () => {
    const declarer = new CountingIncidentDeclarer({ clock: new FixedClock(new Date(AT)) });
    const record = await declarer.declare(request());
    expect(record.declaredAt).toBe(AT);
  });

  it("produces exactly what the executor produces for the same id", async () => {
    // The declarer is a chooser of ids, not a second record builder: drift between the two would
    // mean an auto-declared incident looked different depending on who declared it.
    const clock = new FixedClock(new Date(AT));
    const declarer = new CountingIncidentDeclarer({ clock });
    const declared = await declarer.declare(request());
    const direct = new IncidentExecutor({ clock }).declare({
      ...request(),
      id: "INC-2026-0001",
      declaredAt: AT,
    });
    expect(declared).toEqual(direct);
  });

  it("carries the surface metadata onto the declaration timeline entry", async () => {
    const declarer = new CountingIncidentDeclarer({ clock: new FixedClock(new Date(AT)) });
    const record = await declarer.declare(request());
    expect(record.timeline).toHaveLength(1);
    expect(record.timeline[0]?.metadata).toEqual({ surface: "api.read", autoDeclared: true });
  });

  it("declares in the status every incident starts in", async () => {
    const declarer = new CountingIncidentDeclarer({ clock: new FixedClock(new Date(AT)) });
    expect((await declarer.declare(request())).status).toBe("declared");
  });

  it("passes affected tenants through", async () => {
    const declarer = new CountingIncidentDeclarer({ clock: new FixedClock(new Date(AT)) });
    const tenant = "7d6f7a3e-9c1f-4a6d-8b2e-55ab0f0c1d22";
    const record = await declarer.declare(request({ affectedTenantIds: [tenant] }));
    expect(record.affectedTenantIds).toEqual([tenant]);
  });

  it("rejects a declaration the contract refuses rather than inventing a record", async () => {
    const declarer = new CountingIncidentDeclarer({ clock: new FixedClock(new Date(AT)) });
    await expect(declarer.declare(request({ title: "" }))).rejects.toThrow();
  });

  it("reports a close-out as unpersisted, because there is no record to cancel", async () => {
    const declarer = new CountingIncidentDeclarer({ clock: new FixedClock(new Date(AT)) });
    const record = await declarer.declare(request());
    expect(
      await declarer.closeOut(record.id, { reason: "recovered", actorUserId: "system" }),
    ).toBe("unpersisted");
  });

  it("finds nothing open, because nothing it declared outlived the process", async () => {
    // Claiming otherwise would have an engine adopt an incident that does not exist anywhere.
    const declarer = new CountingIncidentDeclarer({ clock: new FixedClock(new Date(AT)) });
    const record = await declarer.declare(request({ autoDeclaredFor: "availability:x" }));
    expect(record.autoDeclaredFor).toBe("availability:x");
    expect(await declarer.findOpen("availability:x")).toBeNull();
  });

  it("declares with no signal key when none was given", async () => {
    const declarer = new CountingIncidentDeclarer({ clock: new FixedClock(new Date(AT)) });
    expect((await declarer.declare(request())).autoDeclaredFor).toBeNull();
  });

  it("defaults its clock, so an engine can be built without one", async () => {
    const before = Date.now();
    const record = await new CountingIncidentDeclarer().declare(request());
    expect(new Date(record.declaredAt).getTime()).toBeGreaterThanOrEqual(before);
  });
});
