import { describe, expect, it } from "vitest";

import {
  DIFF_IMPACTS,
  EMPTY_DIFF_VIEW,
  diffManifests,
  relationLabel,
  type DiffWarningCode,
  type FieldChange,
  type ManifestDiffView,
  type PermissionChange,
} from "./manifest-diff.js";

const BASE: Record<string, unknown> = {
  manifestVersion: "1.0",
  meta: { name: "Field Service", slug: "generated/field-service", version: "1.0.0" },
  entities: [
    {
      name: "Customer",
      traits: ["auditable"],
      fields: [
        { name: "display_name", type: { kind: "text", maxLength: 200 }, required: true },
        { name: "contact_email", type: { kind: "email" }, classification: "pii" },
        { name: "notes", type: { kind: "long_text" } },
      ],
    },
    {
      name: "WorkOrder",
      traits: ["auditable"],
      fields: [
        { name: "title", type: { kind: "text", maxLength: 200 }, required: true },
        { name: "customer", type: { kind: "reference", target: "Customer" }, required: true },
        { name: "quoted_price", type: { kind: "decimal", precision: 12, scale: 2 } },
      ],
    },
  ],
  relations: [
    {
      kind: "many_to_one",
      from: "WorkOrder",
      field: "customer",
      to: "Customer",
      onDelete: "restrict",
    },
  ],
  roles: {
    app_admin: { name: "app_admin" },
    app_user: { name: "app_user" },
  },
  permissions: {
    Customer: {
      list: { roles: ["app_admin", "app_user"] },
      read: { roles: ["app_admin", "app_user"] },
      create: { roles: ["app_admin"] },
      update: { roles: ["app_admin"] },
      delete: { roles: ["app_admin"] },
    },
    WorkOrder: {
      list: { roles: ["app_admin", "app_user"] },
      read: { roles: ["app_admin", "app_user"] },
      create: { roles: ["app_admin", "app_user"] },
      update: { roles: ["app_admin"] },
      delete: { roles: ["app_admin"] },
    },
  },
  workflows: {
    work_order_lifecycle: {
      kind: "entityLifecycle",
      entity: "WorkOrder",
      stateField: "status",
      initialState: "open",
      states: [{ name: "open" }, { name: "closed" }, { name: "cancelled" }],
      transitions: [
        { name: "close", from: "open", to: "closed" },
        { name: "cancel", from: "open", to: "cancelled" },
      ],
    },
  },
};

function base(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(BASE)) as Record<string, unknown>;
}

function entities(manifest: Record<string, unknown>): Record<string, unknown>[] {
  return manifest["entities"] as Record<string, unknown>[];
}

function entity(manifest: Record<string, unknown>, name: string): Record<string, unknown> {
  const found = entities(manifest).find((candidate) => candidate["name"] === name);
  if (found === undefined) throw new Error(`no entity ${name}`);
  return found;
}

function fields(manifest: Record<string, unknown>, entityName: string): Record<string, unknown>[] {
  return entity(manifest, entityName)["fields"] as Record<string, unknown>[];
}

function field(
  manifest: Record<string, unknown>,
  entityName: string,
  fieldName: string,
): Record<string, unknown> {
  const found = fields(manifest, entityName).find((candidate) => candidate["name"] === fieldName);
  if (found === undefined) throw new Error(`no field ${entityName}.${fieldName}`);
  return found;
}

function permissions(
  manifest: Record<string, unknown>,
  entityName: string,
): Record<string, unknown> {
  const all = manifest["permissions"] as Record<string, Record<string, unknown>>;
  const found = all[entityName];
  if (found === undefined) throw new Error(`no permissions for ${entityName}`);
  return found;
}

function relations(manifest: Record<string, unknown>): Record<string, unknown>[] {
  return manifest["relations"] as Record<string, unknown>[];
}

function lifecycle(manifest: Record<string, unknown>): Record<string, unknown> {
  const workflows = manifest["workflows"] as Record<string, Record<string, unknown>>;
  const found = workflows["work_order_lifecycle"];
  if (found === undefined) throw new Error("no lifecycle");
  return found;
}

function codes(view: ManifestDiffView): DiffWarningCode[] {
  return view.warnings.map((warning) => warning.code);
}

function fieldChange(view: ManifestDiffView, entityName: string, fieldName: string): FieldChange {
  const found = view.fieldChanges.find(
    (change) => change.entity === entityName && change.field === fieldName,
  );
  if (found === undefined) {
    throw new Error(`no field change for ${entityName}.${fieldName}`);
  }
  return found;
}

function permissionChange(
  view: ManifestDiffView,
  entityName: string,
  operation: string,
): PermissionChange {
  const found = view.permissionChanges.find(
    (change) => change.entity === entityName && change.operation === operation,
  );
  if (found === undefined) {
    throw new Error(`no permission change for ${entityName}.${operation}`);
  }
  return found;
}

describe("constants", () => {
  it("declares the three impacts in escalating order", () => {
    expect(DIFF_IMPACTS).toEqual(["none", "additive", "breaking"]);
  });

  it("exposes an empty view that is incomparable with zeroed counts", () => {
    expect(EMPTY_DIFF_VIEW.comparable).toBe(false);
    expect(EMPTY_DIFF_VIEW.impact).toBe("none");
    expect(EMPTY_DIFF_VIEW.warnings).toEqual([]);
    expect(EMPTY_DIFF_VIEW.entitiesAdded).toEqual([]);
    expect(EMPTY_DIFF_VIEW.entitiesRemoved).toEqual([]);
    expect(EMPTY_DIFF_VIEW.entitiesModified).toEqual([]);
    expect(EMPTY_DIFF_VIEW.fieldChanges).toEqual([]);
    expect(EMPTY_DIFF_VIEW.permissionChanges).toEqual([]);
    expect(EMPTY_DIFF_VIEW.relationChanges).toEqual([]);
    expect(EMPTY_DIFF_VIEW.rolesAdded).toEqual([]);
    expect(EMPTY_DIFF_VIEW.rolesRemoved).toEqual([]);
    expect(EMPTY_DIFF_VIEW.lifecycleChanges).toEqual([]);
    expect(EMPTY_DIFF_VIEW.counts).toEqual({ added: 0, removed: 0, modified: 0, warnings: 0 });
  });
});

describe("no active manifest", () => {
  it("reports the first activation as incomparable", () => {
    const view = diffManifests(null, base());
    expect(view).toEqual(EMPTY_DIFF_VIEW);
    expect(view.comparable).toBe(false);
  });

  it("hands back a fresh view so a caller cannot corrupt the shared constant", () => {
    const view = diffManifests(null, base());
    view.counts.added = 99;
    expect(EMPTY_DIFF_VIEW.counts.added).toBe(0);
  });
});

describe("unchanged manifests", () => {
  it("reports no impact and no warnings for an identical pair", () => {
    const view = diffManifests(base(), base());
    expect(view.comparable).toBe(true);
    expect(view.impact).toBe("none");
    expect(view.warnings).toEqual([]);
    expect(view.entitiesAdded).toEqual([]);
    expect(view.entitiesRemoved).toEqual([]);
    expect(view.entitiesModified).toEqual([]);
    expect(view.fieldChanges).toEqual([]);
    expect(view.permissionChanges).toEqual([]);
    expect(view.relationChanges).toEqual([]);
    expect(view.lifecycleChanges).toEqual([]);
    expect(view.counts).toEqual({ added: 0, removed: 0, modified: 0, warnings: 0 });
  });

  it("compares a minimal manifest that declares no relations, roles or workflows", () => {
    const minimal: Record<string, unknown> = {
      manifestVersion: "1.0",
      meta: { name: "Minimal", slug: "generated/minimal", version: "0.1.0" },
      entities: [{ name: "Thing", fields: [{ name: "label", type: { kind: "text" } }] }],
    };
    const view = diffManifests(minimal, JSON.parse(JSON.stringify(minimal)) as Record<string, unknown>);
    expect(view.comparable).toBe(true);
    expect(view.impact).toBe("none");
  });
});

describe("malformed input", () => {
  it("falls back to incomparable when the active manifest no longer parses", () => {
    const view = diffManifests({ manifestVersion: "0.9" }, base());
    expect(view.comparable).toBe(false);
    expect(view.impact).toBe("none");
  });

  it("falls back to incomparable when the next manifest does not parse", () => {
    const view = diffManifests(base(), { nonsense: true });
    expect(view.comparable).toBe(false);
  });

  it("does not throw on two empty objects", () => {
    expect(() => diffManifests({}, {})).not.toThrow();
    expect(diffManifests({}, {}).comparable).toBe(false);
  });

  it("does not throw on null-ish collection members", () => {
    const broken = base();
    broken["entities"] = null;
    broken["roles"] = null;
    expect(() => diffManifests(broken, base())).not.toThrow();
    expect(diffManifests(broken, base()).comparable).toBe(false);
  });
});

describe("additive changes", () => {
  it("reports a new entity as additive with no warnings", () => {
    const next = base();
    entities(next).push({
      name: "Invoice",
      traits: ["auditable"],
      fields: [{ name: "total", type: { kind: "decimal", precision: 12, scale: 2 } }],
    });
    const view = diffManifests(base(), next);
    expect(view.impact).toBe("additive");
    expect(view.entitiesAdded).toEqual(["Invoice"]);
    expect(view.warnings).toEqual([]);
    expect(view.counts.added).toBe(1);
  });

  it("reports a new optional field as additive and marks the entity modified", () => {
    const next = base();
    fields(next, "Customer").push({ name: "phone", type: { kind: "phone" } });
    const view = diffManifests(base(), next);
    expect(view.impact).toBe("additive");
    expect(view.entitiesModified).toEqual(["Customer"]);
    expect(fieldChange(view, "Customer", "phone")).toEqual({
      entity: "Customer",
      field: "phone",
      change: "added",
      from: null,
      to: "phone",
    });
    expect(view.warnings).toEqual([]);
  });

  it("reports a new role as additive", () => {
    const next = base();
    (next["roles"] as Record<string, unknown>)["app_auditor"] = { name: "app_auditor" };
    const view = diffManifests(base(), next);
    expect(view.rolesAdded).toEqual(["app_auditor"]);
    expect(view.rolesRemoved).toEqual([]);
    expect(view.impact).toBe("additive");
  });
});

describe("entity and field removal", () => {
  it("flags a removed entity as breaking", () => {
    const next = base();
    next["entities"] = entities(next).filter((candidate) => candidate["name"] !== "WorkOrder");
    const view = diffManifests(base(), next);
    expect(view.impact).toBe("breaking");
    expect(view.entitiesRemoved).toEqual(["WorkOrder"]);
    expect(codes(view)).toContain("entity_removed");
    const warning = view.warnings.find((candidate) => candidate.code === "entity_removed");
    expect(warning?.entities).toEqual(["WorkOrder"]);
    expect(warning?.message).toContain("WorkOrder");
  });

  it("flags a removed field as breaking and keeps its previous type", () => {
    const next = base();
    entity(next, "Customer")["fields"] = fields(next, "Customer").filter(
      (candidate) => candidate["name"] !== "notes",
    );
    const view = diffManifests(base(), next);
    expect(view.impact).toBe("breaking");
    expect(codes(view)).toContain("field_removed");
    expect(fieldChange(view, "Customer", "notes")).toEqual({
      entity: "Customer",
      field: "notes",
      change: "removed",
      from: "long_text",
      to: null,
    });
  });

  it("names a removed reference field by its field name, not its column name", () => {
    const next = base();
    entity(next, "WorkOrder")["fields"] = fields(next, "WorkOrder").filter(
      (candidate) => candidate["name"] !== "customer",
    );
    const view = diffManifests(base(), next);
    expect(fieldChange(view, "WorkOrder", "customer").change).toBe("removed");
    expect(view.fieldChanges.some((change) => change.field === "customer_id")).toBe(false);
  });
});

describe("field modification", () => {
  it("reports a type change with the postgres types on both sides", () => {
    const next = base();
    field(next, "Customer", "display_name")["type"] = { kind: "text" };
    const view = diffManifests(base(), next);
    expect(view.impact).toBe("breaking");
    expect(codes(view)).toContain("field_type_changed");
    expect(fieldChange(view, "Customer", "display_name")).toEqual({
      entity: "Customer",
      field: "display_name",
      change: "type_changed",
      from: "VARCHAR(200)",
      to: "TEXT",
    });
  });

  it("treats a field becoming required as breaking (nullabilityChange.to === true)", () => {
    const next = base();
    field(next, "Customer", "notes")["required"] = true;
    const view = diffManifests(base(), next);
    expect(view.impact).toBe("breaking");
    expect(codes(view)).toContain("field_required_added");
    expect(fieldChange(view, "Customer", "notes")).toEqual({
      entity: "Customer",
      field: "notes",
      change: "required_added",
      from: "optional",
      to: "required",
    });
  });

  it("treats a field becoming optional as additive", () => {
    const next = base();
    delete field(next, "Customer", "display_name")["required"];
    const view = diffManifests(base(), next);
    expect(view.impact).toBe("additive");
    expect(codes(view)).not.toContain("field_required_added");
    expect(fieldChange(view, "Customer", "display_name")).toEqual({
      entity: "Customer",
      field: "display_name",
      change: "required_removed",
      from: "required",
      to: "optional",
    });
  });
});

describe("classification", () => {
  it("raises a warning when an unclassified field becomes phi", () => {
    const next = base();
    field(next, "Customer", "notes")["classification"] = "phi";
    const view = diffManifests(base(), next);
    expect(view.impact).toBe("additive");
    expect(codes(view)).toContain("classification_raised");
    expect(fieldChange(view, "Customer", "notes")).toEqual({
      entity: "Customer",
      field: "notes",
      change: "classification_changed",
      from: null,
      to: "phi",
    });
  });

  it("treats a dropped pii classification as breaking", () => {
    const next = base();
    delete field(next, "Customer", "contact_email")["classification"];
    const view = diffManifests(base(), next);
    expect(view.impact).toBe("breaking");
    expect(codes(view)).toContain("classification_removed");
    expect(fieldChange(view, "Customer", "contact_email")).toEqual({
      entity: "Customer",
      field: "contact_email",
      change: "classification_changed",
      from: "pii",
      to: null,
    });
  });

  it("records a move between two sensitive classes without a boundary warning", () => {
    const next = base();
    field(next, "Customer", "contact_email")["classification"] = "phi";
    const view = diffManifests(base(), next);
    expect(fieldChange(view, "Customer", "contact_email").to).toBe("phi");
    expect(codes(view)).not.toContain("classification_raised");
    expect(codes(view)).not.toContain("classification_removed");
    expect(view.impact).toBe("additive");
  });

  it("marks the entity modified even when only its classification moved", () => {
    const next = base();
    field(next, "Customer", "notes")["classification"] = "commercial_sensitive";
    const view = diffManifests(base(), next);
    expect(view.entitiesModified).toEqual(["Customer"]);
    expect(view.counts.modified).toBe(1);
  });
});

describe("permissions", () => {
  it("treats a widened delete grant as breaking", () => {
    const next = base();
    permissions(next, "Customer")["delete"] = { roles: ["app_admin", "app_user"] };
    const view = diffManifests(base(), next);
    expect(view.impact).toBe("breaking");
    expect(codes(view)).toContain("permission_granted");
    expect(permissionChange(view, "Customer", "delete")).toEqual({
      entity: "Customer",
      operation: "delete",
      granted: ["app_user"],
      revoked: [],
    });
  });

  it("treats a widened list grant as additive", () => {
    const next = base();
    (next["roles"] as Record<string, unknown>)["app_auditor"] = { name: "app_auditor" };
    permissions(next, "Customer")["list"] = { roles: ["app_admin", "app_user", "app_auditor"] };
    const view = diffManifests(base(), next);
    expect(view.impact).toBe("additive");
    const warning = view.warnings.find((candidate) => candidate.code === "permission_granted");
    expect(warning?.impact).toBe("additive");
    expect(permissionChange(view, "Customer", "list").granted).toEqual(["app_auditor"]);
  });

  it("treats a revoked grant as breaking", () => {
    const next = base();
    permissions(next, "WorkOrder")["create"] = { roles: ["app_admin"] };
    const view = diffManifests(base(), next);
    expect(view.impact).toBe("breaking");
    expect(codes(view)).toContain("permission_revoked");
    expect(permissionChange(view, "WorkOrder", "create")).toEqual({
      entity: "WorkOrder",
      operation: "create",
      granted: [],
      revoked: ["app_user"],
    });
  });

  it("does not restate permission loss for an entity that is removed outright", () => {
    const next = base();
    next["entities"] = entities(next).filter((candidate) => candidate["name"] !== "Customer");
    delete (next["permissions"] as Record<string, unknown>)["Customer"];
    const view = diffManifests(base(), next);
    expect(view.permissionChanges.some((change) => change.entity === "Customer")).toBe(false);
    expect(codes(view)).toContain("entity_removed");
    expect(codes(view)).not.toContain("permission_revoked");
  });

  it("reports a transition grant under a namespaced operation and treats it as additive", () => {
    const next = base();
    permissions(next, "WorkOrder")["transitions"] = { close: { roles: ["app_user"] } };
    const view = diffManifests(base(), next);
    expect(permissionChange(view, "WorkOrder", "transitions.close").granted).toEqual(["app_user"]);
    expect(view.impact).toBe("additive");
  });

  it("treats a widened field-level update grant as breaking", () => {
    const next = base();
    permissions(next, "Customer")["fields"] = { contact_email: { update: { roles: ["app_user"] } } };
    const view = diffManifests(base(), next);
    expect(permissionChange(view, "Customer", "fields.contact_email.update").granted).toEqual([
      "app_user",
    ]);
    expect(view.impact).toBe("breaking");
  });
});

describe("relations", () => {
  it("labels a many_to_one relation by its origin field and target", () => {
    expect(
      relationLabel({ kind: "many_to_one", from: "WorkOrder", field: "customer", to: "Customer" }),
    ).toBe("WorkOrder.customer → Customer");
    expect(relationLabel({ kind: "many_to_many", left: "Tag", right: "WorkOrder" })).toBe(
      "Tag ↔ WorkOrder",
    );
  });

  it("flags a removed relation as breaking", () => {
    const next = base();
    next["relations"] = [];
    const view = diffManifests(base(), next);
    expect(view.impact).toBe("breaking");
    expect(codes(view)).toContain("relation_removed");
    expect(view.relationChanges).toEqual([
      { change: "removed", label: "WorkOrder.customer → Customer", detail: "onDelete: restrict" },
    ]);
  });

  it("flags an onDelete that turns into cascade", () => {
    const next = base();
    const relation = relations(next)[0];
    if (relation === undefined) throw new Error("no relation");
    relation["onDelete"] = "cascade";
    const view = diffManifests(base(), next);
    expect(view.impact).toBe("breaking");
    expect(codes(view)).toContain("relation_cascade_added");
    expect(view.relationChanges).toEqual([
      {
        change: "modified",
        label: "WorkOrder.customer → Customer",
        detail: "onDelete restrict → cascade",
      },
    ]);
  });

  it("reports a non-cascade onDelete change as additive", () => {
    const next = base();
    const relation = relations(next)[0];
    if (relation === undefined) throw new Error("no relation");
    relation["onDelete"] = "set_null";
    const view = diffManifests(base(), next);
    expect(view.impact).toBe("additive");
    expect(codes(view)).not.toContain("relation_cascade_added");
    expect(view.relationChanges[0]?.change).toBe("modified");
  });

  it("reports an added relation as additive", () => {
    const next = base();
    relations(next).push({ kind: "many_to_many", left: "Customer", right: "WorkOrder" });
    const view = diffManifests(base(), next);
    expect(view.impact).toBe("additive");
    expect(view.relationChanges).toEqual([
      { change: "added", label: "Customer ↔ WorkOrder", detail: null },
    ]);
  });
});

describe("roles", () => {
  it("flags a removed role as breaking", () => {
    const next = base();
    delete (next["roles"] as Record<string, unknown>)["app_user"];
    const view = diffManifests(base(), next);
    expect(view.impact).toBe("breaking");
    expect(view.rolesRemoved).toEqual(["app_user"]);
    expect(codes(view)).toContain("role_removed");
  });
});

describe("lifecycle", () => {
  it("flags a removed state as breaking", () => {
    const next = base();
    const workflow = lifecycle(next);
    workflow["states"] = [{ name: "open" }, { name: "closed" }];
    workflow["transitions"] = [{ name: "close", from: "open", to: "closed" }];
    const view = diffManifests(base(), next);
    expect(view.impact).toBe("breaking");
    expect(codes(view)).toContain("lifecycle_changed");
    expect(view.lifecycleChanges[0]?.entity).toBe("WorkOrder");
    expect(view.lifecycleChanges[0]?.detail).toContain("states removed: cancelled");
  });

  it("reports an added state as additive", () => {
    const next = base();
    const workflow = lifecycle(next);
    workflow["states"] = [
      { name: "open" },
      { name: "closed" },
      { name: "cancelled" },
      { name: "on_hold" },
    ];
    const view = diffManifests(base(), next);
    expect(view.impact).toBe("additive");
    expect(view.lifecycleChanges).toEqual([
      { entity: "WorkOrder", detail: "states added: on_hold" },
    ]);
  });

  it("flags a lifecycle dropped from a surviving entity as breaking", () => {
    const next = base();
    next["workflows"] = {};
    const view = diffManifests(base(), next);
    expect(view.impact).toBe("breaking");
    expect(view.lifecycleChanges).toEqual([{ entity: "WorkOrder", detail: "lifecycle removed" }]);
  });
});

describe("ordering and counts", () => {
  it("orders every breaking warning ahead of every additive one", () => {
    const next = base();
    entity(next, "Customer")["fields"] = fields(next, "Customer").filter(
      (candidate) => candidate["name"] !== "notes",
    );
    field(next, "WorkOrder", "quoted_price")["classification"] = "commercial_sensitive";
    (next["roles"] as Record<string, unknown>)["app_auditor"] = { name: "app_auditor" };
    permissions(next, "WorkOrder")["list"] = { roles: ["app_admin", "app_user", "app_auditor"] };
    const view = diffManifests(base(), next);

    const impacts = view.warnings.map((warning) => warning.impact);
    expect(impacts).toEqual([...impacts].sort((a, b) => (a === b ? 0 : a === "breaking" ? -1 : 1)));
    expect(impacts[0]).toBe("breaking");
    expect(view.impact).toBe("breaking");
    expect(codes(view)).toEqual([
      "field_removed",
      "classification_raised",
      "permission_granted",
    ]);
  });

  it("counts added, removed, modified entities and warnings", () => {
    const next = base();
    entities(next).push({
      name: "Invoice",
      traits: ["auditable"],
      fields: [{ name: "total", type: { kind: "decimal", precision: 12, scale: 2 } }],
    });
    entity(next, "Customer")["fields"] = fields(next, "Customer").filter(
      (candidate) => candidate["name"] !== "notes",
    );
    next["entities"] = entities(next).filter((candidate) => candidate["name"] !== "WorkOrder");
    const view = diffManifests(base(), next);
    expect(view.counts.added).toBe(1);
    expect(view.counts.removed).toBe(1);
    expect(view.counts.modified).toBe(1);
    expect(view.counts.warnings).toBe(view.warnings.length);
    expect(view.counts.warnings).toBeGreaterThan(0);
  });

  it("keeps a breaking impact when additive changes also exist", () => {
    const next = base();
    (next["roles"] as Record<string, unknown>)["app_auditor"] = { name: "app_auditor" };
    delete (next["roles"] as Record<string, unknown>)["app_user"];
    const view = diffManifests(base(), next);
    expect(view.rolesAdded).toEqual(["app_auditor"]);
    expect(view.rolesRemoved).toEqual(["app_user"]);
    expect(view.impact).toBe("breaking");
  });
});

describe("changes the kernel diff refuses", () => {
  it("still reports a changed type kind instead of throwing", () => {
    const next = base();
    field(next, "Customer", "notes")["type"] = { kind: "integer" };
    const view = diffManifests(base(), next);
    expect(view.comparable).toBe(true);
    expect(view.impact).toBe("breaking");
    expect(fieldChange(view, "Customer", "notes")).toEqual({
      entity: "Customer",
      field: "notes",
      change: "type_changed",
      from: "long_text",
      to: "integer",
    });
    expect(codes(view)).toContain("field_type_changed");
  });

  it("still reports the rest of the diff when an enum widening blocks the kernel", () => {
    const withEnum = base();
    field(withEnum, "WorkOrder", "title")["type"] = { kind: "enum", values: ["a", "b"] };
    const next = JSON.parse(JSON.stringify(withEnum)) as Record<string, unknown>;
    field(next, "WorkOrder", "title")["type"] = { kind: "enum", values: ["a", "b", "c"] };
    delete (next["roles"] as Record<string, unknown>)["app_user"];
    const view = diffManifests(withEnum, next);
    expect(view.comparable).toBe(true);
    expect(view.rolesRemoved).toEqual(["app_user"]);
    expect(fieldChange(view, "WorkOrder", "title").change).toBe("type_changed");
  });
});
