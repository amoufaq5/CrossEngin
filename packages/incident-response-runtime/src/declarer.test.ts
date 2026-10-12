import { describe, expect, it } from "vitest";

import { FixedClock } from "./clock.js";
import {
  CountingIncidentDeclarer,
  INCIDENT_CLOSE_OUTS,
  closeOutClosesAlert,
  type IncidentDeclarationRequest,
  type IncidentDeclarer,
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

describe("closeOutClosesAlert", () => {
  it("closes the alert for a cancelled record", () => {
    expect(closeOutClosesAlert("cancelled")).toBe(true);
  });

  it("closes the alert for an unpersisted episode, because the page was real either way", () => {
    // Nothing stored the record, but the page left over a real transport with a real dedup key.
    // Leaving the alert up would strand exactly the deployments with no incident store to look in.
    expect(closeOutClosesAlert("unpersisted")).toBe(true);
  });

  it("leaves a triaged incident's alert alone", () => {
    // The record is open and owned; resolving its alert takes it off the board of the person
    // holding it, which is the opposite of what is true.
    expect(closeOutClosesAlert("human_owned")).toBe(false);
  });

  it("leaves the alert up when the close-out failed", () => {
    // Fail closed: an alert left up is noise, an alert wrongly closed is silence.
    expect(closeOutClosesAlert("failed")).toBe(false);
  });

  it("answers for every close-out in the vocabulary", () => {
    // So a fifth close-out is a compile break here rather than a silently-false answer.
    for (const closeOut of INCIDENT_CLOSE_OUTS) {
      expect(typeof closeOutClosesAlert(closeOut)).toBe("boolean");
    }
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

describe("CountingIncidentDeclarer — findById", () => {
  it("answers for an id it minted in this process", async () => {
    const declarer = new CountingIncidentDeclarer({ clock: new FixedClock(new Date(AT)) });
    const record = await declarer.declare(request());
    expect(await declarer.findById(record.id)).toEqual(record);
  });

  it("answers with the grade the declaration was made at, which is what a resolve routes on", async () => {
    const declarer = new CountingIncidentDeclarer({ clock: new FixedClock(new Date(AT)) });
    const record = await declarer.declare(request({ severity: "sev1" }));
    expect((await declarer.findById(record.id))?.severity).toBe("sev1");
  });

  it("answers null for an id it never minted", async () => {
    const declarer = new CountingIncidentDeclarer({ clock: new FixedClock(new Date(AT)) });
    await declarer.declare(request());
    expect(await declarer.findById("INC-2026-0099")).toBeNull();
  });

  it("answers null from a fresh declarer, which is what a restart looks like", async () => {
    // The id a previous process minted is not authoritative anyway, so "cannot tell" is the only
    // honest answer — and it is the answer that leaves the alert for a human.
    const before = new CountingIncidentDeclarer({ clock: new FixedClock(new Date(AT)) });
    const record = await before.declare(request());
    const after = new CountingIncidentDeclarer({ clock: new FixedClock(new Date(AT)) });
    expect(await after.findById(record.id)).toBeNull();
  });

  it("keeps each episode's record distinct", async () => {
    const declarer = new CountingIncidentDeclarer({ clock: new FixedClock(new Date(AT)) });
    const first = await declarer.declare(request({ severity: "sev3" }));
    const second = await declarer.declare(request({ severity: "sev1" }));
    const grades = [
      (await declarer.findById(first.id))?.severity,
      (await declarer.findById(second.id))?.severity,
    ];
    expect(grades).toEqual(["sev3", "sev1"]);
  });

  it("still answers after the episode was closed out", async () => {
    // Pruning on close-out would make the answer depend on whether the caller asks before or after
    // it closes the record, and a resolve may legitimately do either.
    const declarer = new CountingIncidentDeclarer({ clock: new FixedClock(new Date(AT)) });
    const record = await declarer.declare(request());
    expect(await declarer.closeOut(record.id, { reason: "recovered", actorUserId: "sys" })).toBe(
      "unpersisted",
    );
    expect((await declarer.findById(record.id))?.id).toBe(record.id);
  });

  it("remembers nothing for a declaration the contract refused", async () => {
    const declarer = new CountingIncidentDeclarer({ clock: new FixedClock(new Date(AT)) });
    await expect(declarer.declare(request({ title: "" }))).rejects.toThrow();
    expect(await declarer.findById("INC-2026-0001")).toBeNull();
  });

  it("does not make findOpen answer from the same map", async () => {
    // The two questions are not the same question. `findOpen` drives adoption, and adopting an
    // incident that exists nowhere but this map is the thing its null answer prevents.
    const declarer = new CountingIncidentDeclarer({ clock: new FixedClock(new Date(AT)) });
    const record = await declarer.declare(request({ autoDeclaredFor: "availability:api.read" }));
    expect(await declarer.findById(record.id)).not.toBeNull();
    expect(await declarer.findOpen("availability:api.read")).toBeNull();
  });
});

describe("IncidentDeclarer — findById is optional", () => {
  it("accepts a declarer that does not implement it", async () => {
    // Pinned with a double that omits the method: a required `findById` would break every
    // implementation and every test double in this repo at once, for a caller that has to handle
    // "cannot tell" regardless.
    const minimal: IncidentDeclarer = {
      declare: async (req) =>
        new IncidentExecutor({ clock: new FixedClock(new Date(AT)) }).declare({
          ...req,
          id: "INC-2026-0001",
          declaredAt: AT,
        }),
      findOpen: async () => null,
      closeOut: async () => "unpersisted",
    };
    expect(minimal.findById).toBeUndefined();
    expect((await minimal.declare(request())).id).toBe("INC-2026-0001");
  });

  it("reads absent the same way it reads null: nothing to resolve", async () => {
    const minimal: IncidentDeclarer = {
      declare: async () => {
        throw new Error("not used");
      },
      findOpen: async () => null,
      closeOut: async () => "unpersisted",
    };
    expect(await minimal.findById?.("INC-2026-0001")).toBeUndefined();
  });
});
