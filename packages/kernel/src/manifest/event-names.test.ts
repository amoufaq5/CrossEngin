import { describe, expect, it } from "vitest";

import {
  ENTITY_EVENT_VERBS,
  entityEventName,
  eventNameSegment,
  producibleEntityEventNames,
} from "./event-names.js";
import { ManifestSchema, type Manifest } from "./types.js";

const v = "1.0.0";

function manifest(partial: Omit<Manifest, "manifestVersion" | "meta">): Manifest {
  // Parsed rather than cast: a fixture the real schema would refuse cannot stand in for a
  // manifest a deployment serves.
  return ManifestSchema.parse({
    manifestVersion: "1.0",
    meta: { name: "Fixture", slug: "fixture", version: v },
    ...partial,
  });
}

function entity(name: string): NonNullable<Manifest["entities"]>[number] {
  return { name, fields: [{ name: "a", type: { kind: "text" } }] };
}

describe("eventNameSegment", () => {
  it("lowercases and leaves an already-valid segment alone", () => {
    expect(eventNameSegment("SalesOrder")).toBe("salesorder");
    expect(eventNameSegment("invoice")).toBe("invoice");
  });

  it("collapses each run of non-alphanumerics to a single underscore", () => {
    expect(eventNameSegment("Order-Line")).toBe("order_line");
    expect(eventNameSegment("In Progress")).toBe("in_progress");
    expect(eventNameSegment("a -- b")).toBe("a_b");
    expect(eventNameSegment("Purchase/Order.Line")).toBe("purchase_order_line");
  });

  it("strips leading and trailing underscore runs", () => {
    expect(eventNameSegment("_leading")).toBe("leading");
    expect(eventNameSegment("trailing_")).toBe("trailing");
    expect(eventNameSegment("--both--")).toBe("both");
  });

  it("prefixes x_ when the result does not start with a letter", () => {
    expect(eventNameSegment("2fa")).toBe("x_2fa");
    expect(eventNameSegment("1099Form")).toBe("x_1099form");
  });

  it("prefixes x_ for input with no alphanumerics at all, so the result is never empty", () => {
    expect(eventNameSegment("")).toBe("x_");
    expect(eventNameSegment("---")).toBe("x_");
    expect(eventNameSegment("!!")).toBe("x_");
  });

  it("is idempotent on its own output for every input that carries an alphanumeric", () => {
    for (const raw of ["SalesOrder", "Order-Line", "2fa", "--both--", "a -- b", "_x_", "1099Form"]) {
      const once = eventNameSegment(raw);
      expect(eventNameSegment(once)).toBe(once);
    }
  });

  it("is NOT idempotent on x_, the one output with a trailing underscore", () => {
    // `x_` is the answer for text with no alphanumerics, and a second pass strips its trailing
    // underscore. This is why `entityEventName` takes an already-segmented verb instead of
    // re-segmenting defensively: a defensive pass would rename exactly this one segment.
    expect(eventNameSegment("")).toBe("x_");
    expect(eventNameSegment("x_")).toBe("x");
    expect(eventNameSegment(eventNameSegment("!!"))).not.toBe(eventNameSegment("!!"));
  });

  it("every output is a legal dotted segment: starts with a letter, only [a-z0-9_]", () => {
    for (const raw of ["SalesOrder", "Order-Line", "2fa", "", "!!", "Ünïcode", "a1_b2"]) {
      expect(eventNameSegment(raw)).toMatch(/^[a-z][a-z0-9_]*$|^x_[a-z0-9_]*$/);
      expect(eventNameSegment(raw).length).toBeGreaterThan(0);
    }
  });
});

describe("ENTITY_EVENT_VERBS", () => {
  it("maps the three fixed-verb operations and nothing else", () => {
    expect(Object.keys(ENTITY_EVENT_VERBS).sort()).toEqual(["create", "delete", "update"]);
    expect(ENTITY_EVENT_VERBS).toEqual({
      create: "created",
      update: "updated",
      delete: "deleted",
    });
  });

  it("is frozen, so no consumer can rename a verb for the whole process", () => {
    expect(Object.isFrozen(ENTITY_EVENT_VERBS)).toBe(true);
  });

  it("every verb is already a segment, so entityEventName need not segment it", () => {
    for (const verb of Object.values(ENTITY_EVENT_VERBS)) {
      expect(eventNameSegment(verb)).toBe(verb);
    }
  });
});

describe("entityEventName", () => {
  it("joins entity and verb with a dot, segmenting the entity", () => {
    expect(entityEventName({ entity: "SalesOrder", verb: "created" })).toBe("salesorder.created");
    expect(entityEventName({ entity: "Order-Line", verb: "in_progress" })).toBe(
      "order_line.in_progress",
    );
  });

  it("segments the prefix and puts it first", () => {
    expect(entityEventName({ prefix: "Retail Ops", entity: "SalesOrder", verb: "placed" })).toBe(
      "retail_ops.salesorder.placed",
    );
  });

  it("omits the prefix segment entirely when no prefix is given", () => {
    expect(entityEventName({ entity: "Lead", verb: "created" }).split(".")).toHaveLength(2);
    expect(entityEventName({ prefix: "retail", entity: "Lead", verb: "created" }).split("."))
      .toHaveLength(3);
  });

  it("does NOT segment the verb — the caller owns that, and both sources differ", () => {
    // A transition target reaches this function already segmented; passing raw text through
    // proves the function is not quietly doing it a second time.
    expect(entityEventName({ entity: "SalesOrder", verb: "In Progress" })).toBe(
      "salesorder.In Progress",
    );
  });

  it("drops an empty verb rather than emitting a dangling dot", () => {
    expect(entityEventName({ entity: "SalesOrder", verb: "" })).toBe("salesorder");
    expect(entityEventName({ prefix: "retail", entity: "SalesOrder", verb: "" })).toBe(
      "retail.salesorder",
    );
  });

  it("an empty prefix string is dropped too, since it segments to x_ only for the entity", () => {
    // `eventNameSegment("")` is `x_`, which is non-empty — so an empty prefix is a *declared*
    // prefix and lands as `x_`. Pinned because the alternative reading (dropping it) would make
    // `eventPrefix: ""` and an absent prefix indistinguishable.
    expect(entityEventName({ prefix: "", entity: "Lead", verb: "created" })).toBe(
      "x_.lead.created",
    );
  });
});

describe("producibleEntityEventNames", () => {
  it("yields exactly three names per entity when no workflow declares a lifecycle", () => {
    const names = producibleEntityEventNames(
      manifest({ entities: [entity("Lead"), entity("Invoice")] }),
    );
    expect(names.size).toBe(2 * Object.keys(ENTITY_EVENT_VERBS).length);
    expect([...names].sort()).toEqual([
      "invoice.created",
      "invoice.deleted",
      "invoice.updated",
      "lead.created",
      "lead.deleted",
      "lead.updated",
    ]);
  });

  it("adds one name per declared transition target, over the workflow's own entity", () => {
    const names = producibleEntityEventNames(
      manifest({
        entities: [entity("SalesOrder")],
        workflows: {
          sales_order_lifecycle: {
            kind: "entityLifecycle",
            entity: "SalesOrder",
            stateField: "state",
            states: [{ name: "draft" }, { name: "placed" }, { name: "fulfilled" }],
            initialState: "draft",
            transitions: [
              { name: "place", from: "draft", to: "placed" },
              { name: "fulfil", from: "placed", to: "fulfilled" },
            ],
          },
        },
      }),
    );
    expect(names.has("salesorder.placed")).toBe(true);
    expect(names.has("salesorder.fulfilled")).toBe(true);
    expect(names.size).toBe(5);
  });

  it("never names a state nothing transitions to — the initial state is reached by a create", () => {
    const names = producibleEntityEventNames(
      manifest({
        entities: [entity("SalesOrder")],
        workflows: {
          lc: {
            kind: "entityLifecycle",
            entity: "SalesOrder",
            stateField: "state",
            // `draft` and `abandoned` are declared states with no transition *to* them.
            states: [
              { name: "draft" },
              { name: "placed" },
              { name: "abandoned", category: "terminal" },
            ],
            initialState: "draft",
            transitions: [{ name: "place", from: "draft", to: "placed" }],
          },
        },
      }),
    );
    expect(names.has("salesorder.placed")).toBe(true);
    expect(names.has("salesorder.draft")).toBe(false);
    expect(names.has("salesorder.abandoned")).toBe(false);
    // Reading `states` would have produced 3 extra names here; the whole point of reading
    // targets is that over-reporting is the permissive direction.
    expect(names.size).toBe(4);
  });

  it("segments a transition target, so a multi-word state yields a legal segment", () => {
    const names = producibleEntityEventNames(
      manifest({
        entities: [entity("WorkOrder")],
        workflows: {
          lc: {
            kind: "entityLifecycle",
            entity: "WorkOrder",
            stateField: "state",
            states: [{ name: "open" }, { name: "In Progress" }],
            initialState: "open",
            transitions: [{ name: "start", from: "open", to: "In Progress" }],
          },
        },
      }),
    );
    expect(names.has("workorder.in_progress")).toBe(true);
  });

  it("de-duplicates a transition target that collides with a fixed verb", () => {
    const names = producibleEntityEventNames(
      manifest({
        entities: [entity("Thing")],
        workflows: {
          lc: {
            kind: "entityLifecycle",
            entity: "Thing",
            stateField: "state",
            states: [{ name: "new" }, { name: "updated" }],
            initialState: "new",
            transitions: [{ name: "touch", from: "new", to: "updated" }],
          },
        },
      }),
    );
    expect(names.size).toBe(3);
    expect(names.has("thing.updated")).toBe(true);
  });

  it("ignores orchestration and scheduled workflows, which emit no entity event", () => {
    const names = producibleEntityEventNames(
      manifest({
        entities: [entity("Lead")],
        workflows: {
          saga: { kind: "orchestration", steps: [] },
          nightly: { kind: "scheduled", schedule: "0 2 * * *", action: {} },
        },
      }),
    );
    expect(names.size).toBe(3);
  });

  it("includes a lifecycle whose entity is not in this manifest's own entities list", () => {
    // A pack inherits an entity through `meta.extends` and declares a lifecycle over it; the
    // producer names the event from the write's entity, not from this list, so filtering on it
    // would be the narrow read this function exists to avoid.
    const names = producibleEntityEventNames(
      manifest({
        workflows: {
          lc: {
            kind: "entityLifecycle",
            entity: "InheritedThing",
            stateField: "state",
            states: [{ name: "a" }, { name: "b" }],
            initialState: "a",
            transitions: [{ name: "go", from: "a", to: "b" }],
          },
        },
      }),
    );
    expect([...names]).toEqual(["inheritedthing.b"]);
  });

  it("applies the prefix to every name, so each is three segments", () => {
    const names = producibleEntityEventNames(
      manifest({
        entities: [entity("Lead")],
        workflows: {
          lc: {
            kind: "entityLifecycle",
            entity: "Lead",
            stateField: "state",
            states: [{ name: "a" }, { name: "b" }],
            initialState: "a",
            transitions: [{ name: "go", from: "a", to: "b" }],
          },
        },
      }),
      { eventPrefix: "Retail" },
    );
    expect([...names].every((n) => n.split(".").length === 3)).toBe(true);
    expect(names.has("retail.lead.created")).toBe(true);
    expect(names.has("retail.lead.b")).toBe(true);
  });

  it("a prefix changes every name and no count", () => {
    const m = manifest({ entities: [entity("Lead"), entity("Invoice")] });
    const bare = producibleEntityEventNames(m);
    const prefixed = producibleEntityEventNames(m, { eventPrefix: "retail" });
    expect(prefixed.size).toBe(bare.size);
    for (const n of bare) expect(prefixed.has(n)).toBe(false);
  });

  it("an empty manifest produces nothing, and an empty options object is the same as none", () => {
    const m = manifest({});
    expect(producibleEntityEventNames(m).size).toBe(0);
    expect(producibleEntityEventNames(m, {}).size).toBe(0);
  });

  it("every produced name is a dot-joined sequence of legal segments", () => {
    // The odd segments can only come from the prefix and a transition target: `EntityNameSchema`
    // is `/^[A-Z][A-Za-z0-9]*$/`, so an entity segment is only ever a lowercasing and can never
    // need `_` or the `x_` prefix, while `eventPrefix` and `Transition.to` are unconstrained text.
    const names = producibleEntityEventNames(
      manifest({
        entities: [entity("OrderLine"), entity("Invoice2Line")],
        workflows: {
          lc: {
            kind: "entityLifecycle",
            entity: "OrderLine",
            stateField: "state",
            states: [{ name: "open" }, { name: "99 Closed" }],
            initialState: "open",
            transitions: [{ name: "close", from: "open", to: "99 Closed" }],
          },
        },
      }),
      { eventPrefix: "7-Eleven" },
    );
    expect(names.size).toBeGreaterThan(0);
    for (const name of names) {
      for (const seg of name.split(".")) expect(seg).toMatch(/^(?:[a-z]|x_)[a-z0-9_]*$/);
    }
    expect(names.has("x_7_eleven.orderline.x_99_closed")).toBe(true);
    expect(names.has("x_7_eleven.invoice2line.created")).toBe(true);
  });

  it("a PascalCase entity name always segments without an underscore or an x_ prefix", () => {
    for (const name of ["SalesOrder", "Invoice", "Invoice2Line", "A", "X9"]) {
      expect(eventNameSegment(name)).toMatch(/^[a-z][a-z0-9]*$/);
    }
  });

  it("the result is the exact set entityEventName would build, which is the producer's builder", () => {
    // Derived rather than restated: the set is asserted against the same join the live producer
    // calls, so a change to the grammar cannot leave this test asserting the old spelling.
    const m = manifest({
      entities: [entity("Lead"), entity("Invoice")],
      workflows: {
        lc: {
          kind: "entityLifecycle",
          entity: "Invoice",
          stateField: "state",
          states: [{ name: "draft" }, { name: "sent" }],
          initialState: "draft",
          transitions: [{ name: "send", from: "draft", to: "sent" }],
        },
      },
    });
    const expected = new Set<string>();
    for (const e of m.entities ?? []) {
      for (const verb of Object.values(ENTITY_EVENT_VERBS)) {
        expected.add(entityEventName({ entity: e.name, verb }));
      }
    }
    expected.add(entityEventName({ entity: "Invoice", verb: eventNameSegment("sent") }));
    expect([...producibleEntityEventNames(m)].sort()).toEqual([...expected].sort());
  });

  it("reproduces the measured arithmetic of a core-sized pack: 3n + distinct target names", () => {
    // Resolved `erp-core` answers 230 = 51 entities × 3 + 77 distinct `(entity, target)` names,
    // with zero collisions between the two groups. Built from a fixture of the same shape because
    // kernel cannot import a pack — the packs depend on kernel — so the pack-wide figures are the
    // workspace rule's job and the arithmetic is this test's.
    const entities = Array.from({ length: 51 }, (_, i) => entity(`E${i}`));
    const workflows: NonNullable<Manifest["workflows"]> = {};
    for (let i = 0; i < 19; i += 1) {
      workflows[`lc${i}`] = {
        kind: "entityLifecycle",
        entity: `E${i}`,
        stateField: "state",
        states: [{ name: "s0" }, { name: "s1" }, { name: "s2" }],
        initialState: "s0",
        transitions: [
          { name: "a", from: "s0", to: "s1" },
          { name: "b", from: "s1", to: "s2" },
        ],
      };
    }
    const names = producibleEntityEventNames(manifest({ entities, workflows }));
    expect(names.size).toBe(51 * 3 + 19 * 2);
  });
});
