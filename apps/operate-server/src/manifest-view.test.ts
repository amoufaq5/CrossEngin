import { describe, expect, it } from "vitest";

import { DESIGN_EXAMPLE_MANIFEST } from "./ai-design.js";
import {
  CRUD_OPERATIONS,
  SENSITIVE_CLASSIFICATIONS,
  formatFieldType,
  projectManifestView,
} from "./manifest-view.js";

const LIFECYCLE_MANIFEST: Record<string, unknown> = {
  meta: { name: "Retail", slug: "generated/retail", version: "1.2.0" },
  entities: [
    { name: "SalesOrder", fields: [{ name: "state", type: { kind: "text" } }], traits: ["auditable"] },
    { name: "Product", fields: [{ name: "sku", type: { kind: "text" } }] },
  ],
  workflows: {
    sales_order_lifecycle: {
      kind: "entityLifecycle",
      entity: "SalesOrder",
      stateField: "state",
      initialState: "cart",
      states: [
        { name: "cart", label: { en: "Cart" }, category: "active" },
        { name: "placed", label: { en: "Placed" }, category: "active" },
        { name: "cancelled", label: { en: "Cancelled" }, category: "terminal" },
      ],
      transitions: [
        { name: "place", from: "cart", to: "placed" },
        { name: "cancel", from: ["cart", "placed"], to: "cancelled" },
      ],
    },
    nightly_reprice: { kind: "scheduled", entity: "Product" },
  },
};

describe("constants", () => {
  it("lists the four sensitive classes and the CRUD operations in display order", () => {
    expect([...SENSITIVE_CLASSIFICATIONS].sort()).toEqual([
      "commercial_sensitive",
      "phi",
      "pii",
      "regulated",
    ]);
    expect(CRUD_OPERATIONS).toEqual(["list", "read", "create", "update", "delete"]);
  });
});

describe("formatFieldType", () => {
  it("renders text with and without a max length", () => {
    expect(formatFieldType({ kind: "text", maxLength: 200 })).toBe("text(200)");
    expect(formatFieldType({ kind: "text" })).toBe("text");
  });

  it("renders enum values joined by pipes", () => {
    expect(formatFieldType({ kind: "enum", values: ["a", "b"] })).toBe("enum(a | b)");
  });

  it("caps enum values at six and reports the remainder", () => {
    expect(formatFieldType({ kind: "enum", values: ["a", "b", "c", "d", "e", "f"] })).toBe(
      "enum(a | b | c | d | e | f)",
    );
    expect(
      formatFieldType({ kind: "enum", values: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] }),
    ).toBe("enum(a | b | c | d | e | f | +3 more)");
  });

  it("falls back to the bare kind for an enum with no usable values", () => {
    expect(formatFieldType({ kind: "enum", values: [] })).toBe("enum");
    expect(formatFieldType({ kind: "enum" })).toBe("enum");
  });

  it("renders a reference with an arrow to its target", () => {
    expect(formatFieldType({ kind: "reference", target: "Customer" })).toBe(
      "reference → Customer",
    );
  });

  it("renders decimal precision and scale", () => {
    expect(formatFieldType({ kind: "decimal", precision: 12, scale: 2 })).toBe("decimal(12,2)");
  });

  it("renders integer bounds when either bound is present", () => {
    expect(formatFieldType({ kind: "integer", min: 0, max: 10 })).toBe("integer(0…10)");
    expect(formatFieldType({ kind: "integer", min: 1 })).toBe("integer(1…)");
    expect(formatFieldType({ kind: "integer", max: 99 })).toBe("integer(…99)");
    expect(formatFieldType({ kind: "integer" })).toBe("integer");
  });

  it("renders any other kind bare", () => {
    expect(formatFieldType({ kind: "boolean" })).toBe("boolean");
    expect(formatFieldType({ kind: "currency_amount" })).toBe("currency_amount");
  });

  it("returns unknown for a missing or garbage type", () => {
    expect(formatFieldType(undefined)).toBe("unknown");
    expect(formatFieldType(null)).toBe("unknown");
    expect(formatFieldType("text")).toBe("unknown");
    expect(formatFieldType(["text"])).toBe("unknown");
    expect(formatFieldType({})).toBe("unknown");
    expect(formatFieldType({ kind: 7 })).toBe("unknown");
  });
});

describe("projectManifestView — the design example", () => {
  const view = projectManifestView(DESIGN_EXAMPLE_MANIFEST);

  it("projects the manifest meta", () => {
    expect(view.meta).toEqual({
      name: "Field Service",
      slug: "generated/field-service",
      version: "0.1.0",
      description: "Work-order tracking for a field service business.",
    });
  });

  it("projects exactly two entities in manifest order, labelled by name", () => {
    expect(view.entities.map((entity) => entity.name)).toEqual(["Customer", "WorkOrder"]);
    expect(view.entities.map((entity) => entity.label)).toEqual(["Customer", "WorkOrder"]);
  });

  it("marks auditable entities from their traits", () => {
    expect(view.entities.every((entity) => entity.auditable)).toBe(true);
    expect(view.entities[0]?.traits).toEqual(["auditable"]);
  });

  it("projects Customer fields with kinds, requiredness and classification", () => {
    expect(view.entities[0]?.fields).toEqual([
      {
        name: "display_name",
        kind: "text",
        type: "text(200)",
        required: true,
        classification: null,
        sensitive: false,
        referenceTarget: null,
      },
      {
        name: "contact_email",
        kind: "email",
        type: "email",
        required: false,
        classification: "pii",
        sensitive: true,
        referenceTarget: null,
      },
    ]);
  });

  it("projects the WorkOrder reference field with its target", () => {
    const customer = view.entities[1]?.fields.find((field) => field.name === "customer");
    expect(customer?.type).toBe("reference → Customer");
    expect(customer?.kind).toBe("reference");
    expect(customer?.referenceTarget).toBe("Customer");
    expect(customer?.required).toBe(true);
  });

  it("projects the WorkOrder enum and decimal fields", () => {
    const types = Object.fromEntries(
      (view.entities[1]?.fields ?? []).map((field) => [field.name, field.type]),
    );
    expect(types["status"]).toBe("enum(open | in_progress | closed)");
    expect(types["quoted_price"]).toBe("decimal(12,2)");
    const price = view.entities[1]?.fields.find((field) => field.name === "quoted_price");
    expect(price?.classification).toBe("commercial_sensitive");
    expect(price?.sensitive).toBe(true);
  });

  it("projects the relation", () => {
    expect(view.relations).toEqual([
      {
        kind: "many_to_one",
        from: "WorkOrder",
        to: "Customer",
        field: "customer",
        onDelete: "restrict",
      },
    ]);
  });

  it("projects roles with i18n labels and grant counts", () => {
    expect(view.roles).toEqual([
      { name: "app_admin", label: "Administrator", description: "Full access to every entity.", grantCount: 10 },
      { name: "app_user", label: "Staff User", description: "Day-to-day operational access.", grantCount: 7 },
    ]);
  });

  it("computes the counts", () => {
    expect(view.counts).toEqual({
      entities: 2,
      fields: 6,
      roles: 2,
      relations: 1,
      sensitiveFields: 2,
      lifecycles: 0,
    });
    expect(view.entities.every((entity) => entity.lifecycle === null)).toBe(true);
  });
});

describe("projectManifestView — entity shapes", () => {
  it("projects record-keyed entities identically to array-shaped ones", () => {
    const arrayShaped = projectManifestView(DESIGN_EXAMPLE_MANIFEST);
    const entities = DESIGN_EXAMPLE_MANIFEST["entities"] as Record<string, unknown>[];
    const recordKeyed = projectManifestView({
      ...DESIGN_EXAMPLE_MANIFEST,
      entities: Object.fromEntries(entities.map((entity) => [String(entity["name"]), entity])),
    });
    expect(recordKeyed.entities).toEqual(arrayShaped.entities);
    expect(recordKeyed.counts).toEqual(arrayShaped.counts);
  });

  it("takes the record key as the name when a member omits one", () => {
    const view = projectManifestView({
      entities: { Ticket: { fields: { subject: { type: { kind: "text" } } } } },
    });
    expect(view.entities[0]?.name).toBe("Ticket");
    expect(view.entities[0]?.fields[0]?.name).toBe("subject");
    expect(view.entities[0]?.fields[0]?.type).toBe("text");
  });

  it("resolves labels from a plain string, an {en} object, or the name", () => {
    const view = projectManifestView({
      entities: [
        { name: "A", label: "Alpha", fields: [] },
        { name: "B", label: { en: "Bravo" }, fields: [] },
        { name: "C", fields: [] },
      ],
    });
    expect(view.entities.map((entity) => entity.label)).toEqual(["Alpha", "Bravo", "C"]);
  });
});

describe("projectManifestView — permissions", () => {
  it("always emits the five CRUD operations in order", () => {
    const view = projectManifestView(DESIGN_EXAMPLE_MANIFEST);
    expect(view.entities[0]?.permissions.map((permission) => permission.operation)).toEqual([
      "list",
      "read",
      "create",
      "update",
      "delete",
    ]);
    expect(view.entities[0]?.permissions[3]).toEqual({ operation: "update", roles: ["app_admin"] });
  });

  it("emits empty role lists for an entity with no permissions declared", () => {
    const view = projectManifestView({ entities: [{ name: "Ghost", fields: [] }] });
    expect(view.entities[0]?.permissions).toEqual([
      { operation: "list", roles: [] },
      { operation: "read", roles: [] },
      { operation: "create", roles: [] },
      { operation: "update", roles: [] },
      { operation: "delete", roles: [] },
    ]);
  });

  it("counts CRUD, transition and field-level grants toward grantCount", () => {
    const view = projectManifestView({
      roles: { manager: { name: "manager", label: { en: "Manager" }, description: "d" }, clerk: { name: "clerk" } },
      permissions: {
        SalesOrder: {
          list: { roles: ["manager", "clerk"] },
          read: { roles: ["manager", "clerk"] },
          create: { roles: ["manager"] },
          update: { roles: ["manager"] },
          delete: { roles: ["manager"] },
          transitions: { place: { roles: ["manager", "clerk"] }, cancel: { roles: ["manager"] } },
          fields: { unit_cost: { read: { roles: ["manager"] }, update: { roles: ["manager"] } } },
        },
      },
    });
    expect(view.roles.map((role) => [role.name, role.grantCount])).toEqual([
      ["manager", 9],
      ["clerk", 3],
    ]);
  });

  it("falls back to the role name and a null description", () => {
    const view = projectManifestView({ roles: { auditor: {} } });
    expect(view.roles).toEqual([
      { name: "auditor", label: "auditor", description: null, grantCount: 0 },
    ]);
  });
});

describe("projectManifestView — lifecycles", () => {
  const view = projectManifestView(LIFECYCLE_MANIFEST);

  it("attaches the entityLifecycle workflow to its entity", () => {
    const lifecycle = view.entities[0]?.lifecycle;
    expect(lifecycle?.stateField).toBe("state");
    expect(lifecycle?.initialState).toBe("cart");
    expect(lifecycle?.states).toEqual([
      { name: "cart", label: "Cart", category: "active" },
      { name: "placed", label: "Placed", category: "active" },
      { name: "cancelled", label: "Cancelled", category: "terminal" },
    ]);
  });

  it("normalizes a string `from` to an array and keeps array `from` as-is", () => {
    expect(view.entities[0]?.lifecycle?.transitions).toEqual([
      { name: "place", from: ["cart"], to: "placed" },
      { name: "cancel", from: ["cart", "placed"], to: "cancelled" },
    ]);
  });

  it("leaves entities without an entityLifecycle workflow null and counts the rest", () => {
    expect(view.entities[1]?.name).toBe("Product");
    expect(view.entities[1]?.lifecycle).toBeNull();
    expect(view.counts.lifecycles).toBe(1);
    expect(view.counts.entities).toBe(2);
  });

  it("accepts array-shaped workflows too", () => {
    const workflows = Object.values(LIFECYCLE_MANIFEST["workflows"] as Record<string, unknown>);
    const arrayShaped = projectManifestView({ ...LIFECYCLE_MANIFEST, workflows });
    expect(arrayShaped.entities[0]?.lifecycle).toEqual(view.entities[0]?.lifecycle);
  });
});

describe("projectManifestView — defensive handling", () => {
  it("projects an empty view for an empty manifest", () => {
    const view = projectManifestView({});
    expect(view).toEqual({
      meta: { name: null, slug: null, version: null, description: null },
      entities: [],
      relations: [],
      roles: [],
      counts: { entities: 0, fields: 0, roles: 0, relations: 0, sensitiveFields: 0, lifecycles: 0 },
    });
  });

  it("ignores non-collection entities/relations/roles", () => {
    const view = projectManifestView({
      meta: "nope",
      entities: "nope",
      relations: 7,
      roles: true,
      workflows: "nope",
      permissions: "nope",
    });
    expect(view.entities).toEqual([]);
    expect(view.relations).toEqual([]);
    expect(view.roles).toEqual([]);
    expect(view.meta.name).toBeNull();
    expect(view.counts.entities).toBe(0);
  });

  it("skips null and primitive members without throwing", () => {
    const view = projectManifestView({
      entities: [null, 3, { name: "Real", fields: [null, { name: "ok", type: { kind: "uuid" } }] }],
      relations: [null, "x", { kind: "many_to_one", from: "Real", to: "Real" }],
      roles: { broken: null, fine: { name: "fine" } },
    });
    expect(view.entities.map((entity) => entity.name)).toEqual(["Real"]);
    expect(view.entities[0]?.fields.map((field) => field.name)).toEqual(["ok"]);
    expect(view.relations).toEqual([
      { kind: "many_to_one", from: "Real", to: "Real", field: null, onDelete: null },
    ]);
    expect(view.roles.map((role) => role.name)).toEqual(["fine"]);
  });

  it("never throws on a null-ish manifest", () => {
    expect(() => projectManifestView(null as unknown as Record<string, unknown>)).not.toThrow();
    expect(projectManifestView(null as unknown as Record<string, unknown>).counts.entities).toBe(0);
  });

  it("treats a field with no type as unknown and not required", () => {
    const view = projectManifestView({ entities: [{ name: "E", fields: [{ name: "f" }] }] });
    expect(view.entities[0]?.fields[0]).toEqual({
      name: "f",
      kind: "unknown",
      type: "unknown",
      required: false,
      classification: null,
      sensitive: false,
      referenceTarget: null,
    });
  });

  it("keeps a non-sensitive classification visible but unflagged", () => {
    const view = projectManifestView({
      entities: [
        { name: "E", fields: [{ name: "f", type: { kind: "text" }, classification: "internal" }] },
      ],
    });
    expect(view.entities[0]?.fields[0]?.classification).toBe("internal");
    expect(view.entities[0]?.fields[0]?.sensitive).toBe(false);
    expect(view.counts.sensitiveFields).toBe(0);
  });
});
