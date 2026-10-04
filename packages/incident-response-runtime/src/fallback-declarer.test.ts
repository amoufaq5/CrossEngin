import { IncidentRecordSchema, type IncidentRecord } from "@crossengin/incident-response";
import { describe, expect, it } from "vitest";

import { FixedClock } from "./clock.js";
import {
  CountingIncidentDeclarer,
  type IncidentCloseOut,
  type IncidentCloseOutInput,
  type IncidentDeclarationRequest,
  type IncidentDeclarer,
} from "./declarer.js";
import {
  FallbackIncidentDeclarer,
  INCIDENT_DECLARER_ORIGINS,
  type IncidentDeclarerOrigin,
} from "./fallback-declarer.js";

const AT = "2026-10-01T12:00:00.000Z";

function clock(): FixedClock {
  return new FixedClock(new Date(AT));
}

function request(over: Partial<IncidentDeclarationRequest> = {}): IncidentDeclarationRequest {
  return {
    title: "SLO burn alert: slo_api on api.read",
    severity: "sev2",
    category: "availability",
    declaredBy: "system-slo-enforcer",
    detail: "Auto-declared by SLO enforcement (page): burn 20.0x over 1h.",
    autoDeclaredFor: "availability:api.read",
    metadata: { surface: "api.read", autoDeclared: true },
    ...over,
  };
}

function storedRecord(id: string, over: Record<string, unknown> = {}): IncidentRecord {
  return IncidentRecordSchema.parse({
    id,
    title: "SLO burn alert: slo_api on api.read",
    severity: "sev2",
    category: "availability",
    status: "declared",
    declaredAt: AT,
    declaredBy: "system-slo-enforcer",
    autoDeclaredFor: "availability:api.read",
    timeline: [
      { occurredAt: AT, actorUserId: "system-slo-enforcer", kind: "declared", message: "burn" },
    ],
    ...over,
  });
}

/**
 * A declarer that records every call, written out by hand.
 *
 * The wrapper's whole job is to catch a failing `declare`, which is exactly where a double that
 * silently stopped doing anything would be swallowed. Every test below therefore asserts a recorded
 * *call* (`declared`, `lookups`, `byIdLookups`, `closedOut`) rather than that nothing threw.
 */
function fakeDeclarer(
  opts: {
    readonly failDeclare?: boolean;
    readonly failFindOpen?: boolean;
    readonly failFindById?: boolean;
    readonly failCloseOut?: boolean;
    readonly closeOutAs?: IncidentCloseOut;
    readonly firstSequence?: number;
    readonly open?: ReadonlyMap<string, IncidentRecord>;
    readonly byId?: ReadonlyMap<string, IncidentRecord>;
  } = {},
) {
  const declared: IncidentRecord[] = [];
  const lookups: string[] = [];
  const byIdLookups: string[] = [];
  const closedOut: { readonly incidentId: string; readonly reason: string }[] = [];
  let seq = (opts.firstSequence ?? 1) - 1;
  const declarer: IncidentDeclarer = {
    declare: async (req: IncidentDeclarationRequest): Promise<IncidentRecord> => {
      if (opts.failDeclare === true) throw new Error("store unavailable");
      seq += 1;
      const record = storedRecord(`INC-2026-${String(seq).padStart(4, "0")}`, {
        title: req.title,
        severity: req.severity,
        category: req.category,
        declaredBy: req.declaredBy,
        declaredAt: req.declaredAt ?? AT,
        autoDeclaredFor: req.autoDeclaredFor ?? null,
        timeline: [
          {
            occurredAt: req.declaredAt ?? AT,
            actorUserId: req.declaredBy,
            kind: "declared",
            message: req.detail,
            metadata: req.metadata ?? {},
          },
        ],
      });
      declared.push(record);
      return record;
    },
    findOpen: async (autoDeclaredFor: string): Promise<IncidentRecord | null> => {
      lookups.push(autoDeclaredFor);
      if (opts.failFindOpen === true) throw new Error("store unavailable");
      return opts.open?.get(autoDeclaredFor) ?? null;
    },
    findById: async (incidentId: string): Promise<IncidentRecord | null> => {
      byIdLookups.push(incidentId);
      if (opts.failFindById === true) throw new Error("store unavailable");
      return (
        opts.byId?.get(incidentId) ?? declared.find((record) => record.id === incidentId) ?? null
      );
    },
    closeOut: async (
      incidentId: string,
      input: IncidentCloseOutInput,
    ): Promise<IncidentCloseOut> => {
      closedOut.push({ incidentId, reason: input.reason });
      if (opts.failCloseOut === true) throw new Error("store unavailable");
      return opts.closeOutAs ?? "cancelled";
    },
  };
  return { declared, lookups, byIdLookups, closedOut, declarer };
}

/** The same double with `findById` left off, which the optional method must still satisfy. */
function fakeDeclarerWithoutFindById(): {
  readonly byIdLookups: readonly string[];
  readonly declarer: IncidentDeclarer;
} {
  const inner = fakeDeclarer();
  const declarer: IncidentDeclarer = {
    declare: async (req) => await inner.declarer.declare(req),
    findOpen: async (key) => await inner.declarer.findOpen(key),
    closeOut: async (id, input) => await inner.declarer.closeOut(id, input),
  };
  return { byIdLookups: inner.byIdLookups, declarer };
}

const CLOSE_OUT: IncidentCloseOutInput = {
  reason: "the burn is back within its threshold",
  actorUserId: "system-slo-enforcer",
};

describe("INCIDENT_DECLARER_ORIGINS", () => {
  it("names the two declarers plus the id this wrapper did not issue", () => {
    expect([...INCIDENT_DECLARER_ORIGINS]).toEqual(["primary", "fallback", "unknown"]);
  });
});

describe("FallbackIncidentDeclarer — declare", () => {
  it("returns the primary's record and reports the primary served it", async () => {
    const primary = fakeDeclarer();
    const d = new FallbackIncidentDeclarer({ primary: primary.declarer, clock: clock() });
    const record = await d.declare(request());
    expect(primary.declared).toHaveLength(1);
    expect(record.id).toBe("INC-2026-0001");
    expect(d.servedBy(record.id)).toBe("primary");
  });

  it("tries the primary before the fallback, rather than guessing from an error type", async () => {
    const primary = fakeDeclarer();
    const fallback = fakeDeclarer({ firstSequence: 900 });
    const d = new FallbackIncidentDeclarer({
      primary: primary.declarer,
      fallback: fallback.declarer,
    });
    await d.declare(request());
    expect(primary.declared).toHaveLength(1);
    expect(fallback.declared).toHaveLength(0);
  });

  it("declares through the fallback when the primary throws, so there is still an id to page", async () => {
    const primary = fakeDeclarer({ failDeclare: true });
    const fallback = fakeDeclarer({ firstSequence: 900 });
    const d = new FallbackIncidentDeclarer({
      primary: primary.declarer,
      fallback: fallback.declarer,
    });
    const record = await d.declare(request());
    expect(fallback.declared).toHaveLength(1);
    expect(record.id).toBe("INC-2026-0900");
    expect(d.servedBy(record.id)).toBe("fallback");
  });

  it("reports the primary's error before falling back, so a store outage is not invisible", async () => {
    const errors: unknown[] = [];
    const primary = fakeDeclarer({ failDeclare: true });
    const d = new FallbackIncidentDeclarer({
      primary: primary.declarer,
      clock: clock(),
      onPrimaryFailure: (err) => errors.push(err),
    });
    await d.declare(request());
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("store unavailable");
  });

  it("defaults the fallback to a per-process counter starting at 0001", async () => {
    // The whole cost of the trade in one assertion: the id is the one a fresh process would mint,
    // and any database that has stored an incident this year already has it.
    const primary = fakeDeclarer({ failDeclare: true });
    const d = new FallbackIncidentDeclarer({
      primary: primary.declarer,
      clock: clock(),
      onPrimaryFailure: () => undefined,
    });
    expect((await d.declare(request())).id).toBe("INC-2026-0001");
  });

  it("passes the whole request through to the fallback, not a reduced copy", async () => {
    const primary = fakeDeclarer({ failDeclare: true });
    const d = new FallbackIncidentDeclarer({
      primary: primary.declarer,
      clock: clock(),
      onPrimaryFailure: () => undefined,
    });
    const record = await d.declare(request({ declaredAt: AT, severity: "sev1" }));
    expect(record.severity).toBe("sev1");
    expect(record.autoDeclaredFor).toBe("availability:api.read");
    expect(record.timeline[0]?.metadata).toMatchObject({ surface: "api.read" });
  });

  it("goes back to the primary on the next declaration rather than latching onto the fallback", async () => {
    let fail = true;
    const inner = fakeDeclarer({ firstSequence: 500 });
    const primary: IncidentDeclarer = {
      declare: async (req) => {
        if (fail) throw new Error("store unavailable");
        return await inner.declarer.declare(req);
      },
      findOpen: async (key) => await inner.declarer.findOpen(key),
      closeOut: async (id, input) => await inner.declarer.closeOut(id, input),
    };
    const d = new FallbackIncidentDeclarer({
      primary,
      clock: clock(),
      onPrimaryFailure: () => undefined,
    });
    const first = await d.declare(request());
    fail = false;
    const second = await d.declare(request({ autoDeclaredFor: "availability:api.write" }));
    expect(d.servedBy(first.id)).toBe("fallback");
    expect(d.servedBy(second.id)).toBe("primary");
    expect(inner.declared).toHaveLength(1);
  });

  it("rejects when the fallback also fails, rather than inventing a third attempt", async () => {
    const primary = fakeDeclarer({ failDeclare: true });
    const fallback = fakeDeclarer({ failDeclare: true });
    const errors: unknown[] = [];
    const d = new FallbackIncidentDeclarer({
      primary: primary.declarer,
      fallback: fallback.declarer,
      onPrimaryFailure: (err) => errors.push(err),
    });
    await expect(d.declare(request())).rejects.toThrow("store unavailable");
    // The primary's failure was still reported; the fallback's is the caller's to handle.
    expect(errors).toHaveLength(1);
  });

  it("lets a later primary declaration claim an id a fallback record already used", async () => {
    // The hazard the fallback trades for a timelier page, pinned rather than hidden: the counter
    // mints `INC-YYYY-0001`, which a store may also issue, and the second declaration is the one
    // that owns the id from then on. The unpersisted episode's routing is lost — which is the
    // correct direction, since the id now names a real row.
    let fail = true;
    const inner = fakeDeclarer();
    const primary: IncidentDeclarer = {
      declare: async (req) => {
        if (fail) throw new Error("store unavailable");
        return await inner.declarer.declare(req);
      },
      findOpen: async (key) => await inner.declarer.findOpen(key),
      closeOut: async (id, input) => await inner.declarer.closeOut(id, input),
    };
    const d = new FallbackIncidentDeclarer({
      primary,
      clock: clock(),
      onPrimaryFailure: () => undefined,
    });
    const unpersisted = await d.declare(request());
    fail = false;
    const stored = await d.declare(request());
    expect(stored.id).toBe(unpersisted.id);
    expect(d.servedBy(stored.id)).toBe("primary");
    await d.closeOut(stored.id, CLOSE_OUT);
    expect(inner.closedOut.map((c) => c.incidentId)).toEqual([stored.id]);
  });

  it("works without an onPrimaryFailure sink", async () => {
    const primary = fakeDeclarer({ failDeclare: true });
    const fallback = fakeDeclarer({ firstSequence: 900 });
    const d = new FallbackIncidentDeclarer({
      primary: primary.declarer,
      fallback: fallback.declarer,
    });
    expect((await d.declare(request())).id).toBe("INC-2026-0900");
  });

  it("accepts a CountingIncidentDeclarer as the explicit fallback", async () => {
    const primary = fakeDeclarer({ failDeclare: true });
    const d = new FallbackIncidentDeclarer({
      primary: primary.declarer,
      fallback: new CountingIncidentDeclarer({ clock: clock() }),
      onPrimaryFailure: () => undefined,
    });
    const record = await d.declare(request());
    expect(record.id).toBe("INC-2026-0001");
    expect(d.servedBy(record.id)).toBe("fallback");
  });
});

describe("FallbackIncidentDeclarer — servedBy", () => {
  it("answers unknown for an id it never issued", () => {
    const primary = fakeDeclarer();
    const d = new FallbackIncidentDeclarer({ primary: primary.declarer });
    expect(d.servedBy("INC-2026-0099")).toBe("unknown");
  });

  it("answers unknown for an id that came back from findOpen, which it did not declare", async () => {
    // An adopted incident was declared by another process; this wrapper has no claim about it.
    const open = new Map([["availability:api.read", storedRecord("INC-2026-0042")]]);
    const primary = fakeDeclarer({ open });
    const d = new FallbackIncidentDeclarer({ primary: primary.declarer });
    const adopted = await d.findOpen("availability:api.read");
    expect(adopted?.id).toBe("INC-2026-0042");
    expect(d.servedBy("INC-2026-0042")).toBe("unknown");
  });

  it("keeps each declaration's origin distinct across several ids", async () => {
    let fail = false;
    const inner = fakeDeclarer();
    const primary: IncidentDeclarer = {
      declare: async (req) => {
        if (fail) throw new Error("store unavailable");
        return await inner.declarer.declare(req);
      },
      findOpen: async (key) => await inner.declarer.findOpen(key),
      closeOut: async (id, input) => await inner.declarer.closeOut(id, input),
    };
    const fallback = fakeDeclarer({ firstSequence: 900 });
    const d = new FallbackIncidentDeclarer({ primary, fallback: fallback.declarer });
    const a = await d.declare(request());
    fail = true;
    const b = await d.declare(request());
    const origins: IncidentDeclarerOrigin[] = [d.servedBy(a.id), d.servedBy(b.id)];
    expect(origins).toEqual(["primary", "fallback"]);
  });

  it("forgets an id once it has been closed out", async () => {
    const primary = fakeDeclarer();
    const d = new FallbackIncidentDeclarer({ primary: primary.declarer });
    const record = await d.declare(request());
    await d.closeOut(record.id, CLOSE_OUT);
    expect(d.servedBy(record.id)).toBe("unknown");
  });

  it("remembers a primary id whose close-out failed, so a later attempt routes the same way", async () => {
    const primary = fakeDeclarer({ failCloseOut: true });
    const d = new FallbackIncidentDeclarer({ primary: primary.declarer });
    const record = await d.declare(request());
    await expect(d.closeOut(record.id, CLOSE_OUT)).rejects.toThrow("store unavailable");
    expect(d.servedBy(record.id)).toBe("primary");
  });
});

describe("FallbackIncidentDeclarer — findOpen", () => {
  it("asks the primary with the key it was given", async () => {
    const primary = fakeDeclarer();
    const d = new FallbackIncidentDeclarer({ primary: primary.declarer });
    expect(await d.findOpen("availability:api.read")).toBeNull();
    expect(primary.lookups).toEqual(["availability:api.read"]);
  });

  it("returns the primary's open incident", async () => {
    const open = new Map([["availability:api.read", storedRecord("INC-2026-0042")]]);
    const primary = fakeDeclarer({ open });
    const d = new FallbackIncidentDeclarer({ primary: primary.declarer });
    expect((await d.findOpen("availability:api.read"))?.id).toBe("INC-2026-0042");
  });

  it("never asks the fallback, whose null means something else entirely", async () => {
    // A counting declarer's `findOpen` is null because nothing it declared survived. Reusing that
    // for an unreachable store would turn "could not ask" into "the rows say nothing is open".
    const primary = fakeDeclarer({ failFindOpen: true });
    const fallback = fakeDeclarer();
    const d = new FallbackIncidentDeclarer({
      primary: primary.declarer,
      fallback: fallback.declarer,
    });
    await expect(d.findOpen("availability:api.read")).rejects.toThrow("store unavailable");
    expect(primary.lookups).toEqual(["availability:api.read"]);
    expect(fallback.lookups).toEqual([]);
  });

  it("propagates the primary's failure instead of answering null itself", async () => {
    // The callers read a thrown lookup as "nothing open" *and report the error* while doing so;
    // answering null here would lose the report and leave an unreachable store looking healthy.
    const primary = fakeDeclarer({ failFindOpen: true });
    const d = new FallbackIncidentDeclarer({ primary: primary.declarer });
    await expect(d.findOpen("availability:api.read")).rejects.toThrow("store unavailable");
  });

  it("does not report a failed lookup through onPrimaryFailure, which is the declare seam", async () => {
    const errors: unknown[] = [];
    const primary = fakeDeclarer({ failFindOpen: true });
    const d = new FallbackIncidentDeclarer({
      primary: primary.declarer,
      onPrimaryFailure: (err) => errors.push(err),
    });
    await expect(d.findOpen("availability:api.read")).rejects.toThrow();
    expect(errors).toEqual([]);
  });
});

describe("FallbackIncidentDeclarer — findById", () => {
  it("asks the primary with the id it was given, and returns its record", async () => {
    const primary = fakeDeclarer();
    const d = new FallbackIncidentDeclarer({ primary: primary.declarer });
    const record = await d.declare(request());
    expect((await d.findById(record.id))?.id).toBe(record.id);
    expect(primary.byIdLookups).toEqual([record.id]);
  });

  it("carries the grade back, which is the only thing a resolve can route on", async () => {
    const primary = fakeDeclarer();
    const d = new FallbackIncidentDeclarer({ primary: primary.declarer });
    const record = await d.declare(request({ severity: "sev1" }));
    expect((await d.findById(record.id))?.severity).toBe("sev1");
  });

  it("answers null when neither declarer holds the id", async () => {
    const primary = fakeDeclarer();
    const fallback = fakeDeclarer();
    const d = new FallbackIncidentDeclarer({
      primary: primary.declarer,
      fallback: fallback.declarer,
    });
    expect(await d.findById("INC-2026-0099")).toBeNull();
    expect(primary.byIdLookups).toEqual(["INC-2026-0099"]);
  });

  it("answers for an id it adopted rather than declared, which only the primary can know", async () => {
    const adopted = storedRecord("INC-2026-0042", { severity: "sev2" });
    const primary = fakeDeclarer({ byId: new Map([["INC-2026-0042", adopted]]) });
    const d = new FallbackIncidentDeclarer({ primary: primary.declarer });
    expect((await d.findById("INC-2026-0042"))?.severity).toBe("sev2");
  });

  it("never looks a fallback-minted id up in the store", async () => {
    // The id came from a counter and may name a *different* stored incident; reading that row would
    // hand the caller somebody else's severity, which is the mis-routed resolve this exists to stop.
    const primary = fakeDeclarer({ failDeclare: true });
    const fallback = fakeDeclarer({ firstSequence: 900 });
    const d = new FallbackIncidentDeclarer({
      primary: primary.declarer,
      fallback: fallback.declarer,
      onPrimaryFailure: () => undefined,
    });
    const record = await d.declare(request());
    expect((await d.findById(record.id))?.id).toBe("INC-2026-0900");
    expect(primary.byIdLookups).toEqual([]);
    expect(fallback.byIdLookups).toEqual([record.id]);
  });

  it("resolves a fallback-minted grade through the default counting fallback", async () => {
    const primary = fakeDeclarer({ failDeclare: true });
    const d = new FallbackIncidentDeclarer({
      primary: primary.declarer,
      clock: clock(),
      onPrimaryFailure: () => undefined,
    });
    const record = await d.declare(request({ severity: "sev1" }));
    expect(d.servedBy(record.id)).toBe("fallback");
    expect((await d.findById(record.id))?.severity).toBe("sev1");
  });

  it("reports a primary failure through the sink and still answers from the fallback", async () => {
    const errors: unknown[] = [];
    const inner = fakeDeclarer({ firstSequence: 900 });
    const fallback = inner.declarer;
    const primary = fakeDeclarer({ failDeclare: true, failFindById: true });
    const d = new FallbackIncidentDeclarer({
      primary: primary.declarer,
      fallback,
      onPrimaryFailure: (err) => errors.push(err),
    });
    const record = await d.declare(request());
    // Declared through the fallback, so the origin already routes it there; make the primary the
    // one asked by forgetting the origin the only way a caller can — closing the episode out.
    await d.closeOut(record.id, CLOSE_OUT);
    expect(d.servedBy(record.id)).toBe("unknown");
    expect((await d.findById(record.id))?.id).toBe(record.id);
    expect(primary.byIdLookups).toEqual([record.id]);
    expect(errors.map((e) => (e as Error).message)).toEqual([
      "store unavailable",
      "store unavailable",
    ]);
  });

  it("does not propagate a primary failure, because a recovery must not become an error", async () => {
    const primary = fakeDeclarer({ failFindById: true });
    const fallback = fakeDeclarer();
    const d = new FallbackIncidentDeclarer({
      primary: primary.declarer,
      fallback: fallback.declarer,
      onPrimaryFailure: () => undefined,
    });
    expect(await d.findById("INC-2026-0042")).toBeNull();
    expect(primary.byIdLookups).toEqual(["INC-2026-0042"]);
    expect(fallback.byIdLookups).toEqual(["INC-2026-0042"]);
  });

  it("swallows a primary failure even with no sink configured", async () => {
    const primary = fakeDeclarer({ failFindById: true });
    const d = new FallbackIncidentDeclarer({ primary: primary.declarer, clock: clock() });
    expect(await d.findById("INC-2026-0042")).toBeNull();
  });

  it("falls through to the fallback when the primary answers null", async () => {
    // No stored row holds the id, so a fallback record for it cannot be shadowing a different
    // incident — the one hazard of a colliding counter id.
    const minted = storedRecord("INC-2026-0001", { severity: "sev1" });
    const primary = fakeDeclarer();
    const fallback = fakeDeclarer({ byId: new Map([["INC-2026-0001", minted]]) });
    const d = new FallbackIncidentDeclarer({
      primary: primary.declarer,
      fallback: fallback.declarer,
    });
    expect((await d.findById("INC-2026-0001"))?.severity).toBe("sev1");
    expect(primary.byIdLookups).toEqual(["INC-2026-0001"]);
  });

  it("asks the fallback when the primary does not implement findById at all", async () => {
    const minted = storedRecord("INC-2026-0001");
    const primary = fakeDeclarerWithoutFindById();
    const fallback = fakeDeclarer({ byId: new Map([["INC-2026-0001", minted]]) });
    const d = new FallbackIncidentDeclarer({
      primary: primary.declarer,
      fallback: fallback.declarer,
    });
    expect((await d.findById("INC-2026-0001"))?.id).toBe("INC-2026-0001");
    expect(fallback.byIdLookups).toEqual(["INC-2026-0001"]);
  });

  it("answers null when a fallback-minted id's fallback cannot answer either", async () => {
    const primary = fakeDeclarer({ failDeclare: true });
    const fallback = fakeDeclarerWithoutFindById();
    const d = new FallbackIncidentDeclarer({
      primary: primary.declarer,
      fallback: fallback.declarer,
      onPrimaryFailure: () => undefined,
    });
    const record = await d.declare(request());
    expect(d.servedBy(record.id)).toBe("fallback");
    expect(await d.findById(record.id)).toBeNull();
  });

  it("invents nothing when neither declarer implements findById", async () => {
    const primary = fakeDeclarerWithoutFindById();
    const fallback = fakeDeclarerWithoutFindById();
    const d = new FallbackIncidentDeclarer({
      primary: primary.declarer,
      fallback: fallback.declarer,
    });
    expect(await d.findById("INC-2026-0001")).toBeNull();
  });
});

describe("FallbackIncidentDeclarer — closeOut", () => {
  it("closes a primary-issued id through the primary", async () => {
    const primary = fakeDeclarer();
    const d = new FallbackIncidentDeclarer({ primary: primary.declarer });
    const record = await d.declare(request());
    expect(await d.closeOut(record.id, CLOSE_OUT)).toBe("cancelled");
    expect(primary.closedOut).toEqual([
      { incidentId: record.id, reason: CLOSE_OUT.reason },
    ]);
  });

  it("passes a human_owned close-out through unchanged", async () => {
    const primary = fakeDeclarer({ closeOutAs: "human_owned" });
    const d = new FallbackIncidentDeclarer({ primary: primary.declarer });
    const record = await d.declare(request());
    expect(await d.closeOut(record.id, CLOSE_OUT)).toBe("human_owned");
  });

  it("does NOT ask the primary to close a fallback-minted id", async () => {
    // The id came from a counter and may name somebody else's row; asking the primary to cancel it
    // would either be refused or cancel the wrong incident.
    const primary = fakeDeclarer({ failDeclare: true });
    const fallback = fakeDeclarer({ firstSequence: 900, closeOutAs: "unpersisted" });
    const d = new FallbackIncidentDeclarer({
      primary: primary.declarer,
      fallback: fallback.declarer,
      onPrimaryFailure: () => undefined,
    });
    const record = await d.declare(request());
    await d.closeOut(record.id, CLOSE_OUT);
    expect(primary.closedOut).toEqual([]);
    expect(fallback.closedOut).toEqual([{ incidentId: record.id, reason: CLOSE_OUT.reason }]);
  });

  it("reports a fallback-minted close-out as unpersisted, not as a clean close", async () => {
    const primary = fakeDeclarer({ failDeclare: true });
    const d = new FallbackIncidentDeclarer({
      primary: primary.declarer,
      clock: clock(),
      onPrimaryFailure: () => undefined,
    });
    const record = await d.declare(request());
    expect(await d.closeOut(record.id, CLOSE_OUT)).toBe("unpersisted");
  });

  it("propagates a primary close-out failure rather than answering from the fallback", async () => {
    // The row is still open. `unpersisted` would claim it does not exist; a throw lets the caller
    // report `failed`, which is what leaves it where a human finds it.
    const primary = fakeDeclarer({ failCloseOut: true });
    const fallback = fakeDeclarer();
    const d = new FallbackIncidentDeclarer({
      primary: primary.declarer,
      fallback: fallback.declarer,
    });
    const record = await d.declare(request());
    await expect(d.closeOut(record.id, CLOSE_OUT)).rejects.toThrow("store unavailable");
    expect(primary.closedOut).toHaveLength(1);
    expect(fallback.closedOut).toEqual([]);
  });

  it("routes an id it never issued to the primary, which is the only one that can know", async () => {
    // An incident adopted after a restart was stored by the process that declared it.
    const primary = fakeDeclarer();
    const fallback = fakeDeclarer();
    const d = new FallbackIncidentDeclarer({
      primary: primary.declarer,
      fallback: fallback.declarer,
    });
    expect(await d.closeOut("INC-2026-0042", CLOSE_OUT)).toBe("cancelled");
    expect(primary.closedOut).toEqual([
      { incidentId: "INC-2026-0042", reason: CLOSE_OUT.reason },
    ]);
    expect(fallback.closedOut).toEqual([]);
  });

  it("forwards the close-out input verbatim", async () => {
    const primary = fakeDeclarer();
    const d = new FallbackIncidentDeclarer({ primary: primary.declarer });
    const record = await d.declare(request());
    await d.closeOut(record.id, { ...CLOSE_OUT, at: AT });
    expect(primary.closedOut[0]?.reason).toBe(CLOSE_OUT.reason);
  });

  it("keeps two episodes' routing separate when one was minted by each", async () => {
    let fail = true;
    const inner = fakeDeclarer({ firstSequence: 7 });
    const primary: IncidentDeclarer = {
      declare: async (req) => {
        if (fail) throw new Error("store unavailable");
        return await inner.declarer.declare(req);
      },
      findOpen: async (key) => await inner.declarer.findOpen(key),
      closeOut: async (id, input) => await inner.declarer.closeOut(id, input),
    };
    const fallback = fakeDeclarer({ firstSequence: 900, closeOutAs: "unpersisted" });
    const d = new FallbackIncidentDeclarer({ primary, fallback: fallback.declarer });
    const unpersisted = await d.declare(request());
    fail = false;
    const persisted = await d.declare(request({ autoDeclaredFor: "availability:api.write" }));
    const outcomes = [
      await d.closeOut(unpersisted.id, CLOSE_OUT),
      await d.closeOut(persisted.id, CLOSE_OUT),
    ];
    expect(outcomes).toEqual(["unpersisted", "cancelled"]);
    expect(inner.closedOut.map((c) => c.incidentId)).toEqual([persisted.id]);
    expect(fallback.closedOut.map((c) => c.incidentId)).toEqual([unpersisted.id]);
  });
});

describe("FallbackIncidentDeclarer — as an IncidentDeclarer", () => {
  it("satisfies the seam, so it can wrap another wrapper", async () => {
    const innermost = fakeDeclarer();
    const outer = new FallbackIncidentDeclarer({
      primary: new FallbackIncidentDeclarer({ primary: innermost.declarer }),
      clock: clock(),
    });
    const record = await outer.declare(request());
    expect(innermost.declared).toHaveLength(1);
    expect(outer.servedBy(record.id)).toBe("primary");
  });

  it("is usable where an IncidentDeclarer is required", async () => {
    const primary = fakeDeclarer();
    const seam: IncidentDeclarer = new FallbackIncidentDeclarer({ primary: primary.declarer });
    const record = await seam.declare(request());
    expect(await seam.findOpen("availability:api.read")).toBeNull();
    expect(await seam.closeOut(record.id, CLOSE_OUT)).toBe("cancelled");
    expect(primary.lookups).toEqual(["availability:api.read"]);
  });
});
