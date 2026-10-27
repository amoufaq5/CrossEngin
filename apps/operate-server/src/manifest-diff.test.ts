import {
  MANIFEST_SECTION_NAMES,
  MANIFEST_SECTION_REACH_MEANINGS,
  type ManifestSectionName,
} from "@crossengin/kernel/manifest";
import { describe, expect, it } from "vitest";

import {
  DIFF_IMPACTS,
  EMPTY_DIFF_VIEW,
  SECTION_DETAIL_LAYER,
  diffManifests,
  relationLabel,
  type DiffWarningCode,
  type FieldChange,
  type ManifestDiffView,
  type PermissionChange,
  type SectionChangeView,
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

  it("treats a widened field-level create grant as additive, where update is breaking", () => {
    // ADR-0348's asymmetry rather than an inconsistency with the test above: a principal supplying
    // a value already knows it, so widening who may *set* a field discloses nothing, while widening
    // who may *change* one lets a value be destroyed by someone who cannot read it.
    const next = base();
    permissions(next, "Customer")["fields"] = { contact_email: { create: { roles: ["app_user"] } } };
    const view = diffManifests(base(), next);
    expect(permissionChange(view, "Customer", "fields.contact_email.create").granted).toEqual([
      "app_user",
    ]);
    expect(view.impact).toBe("additive");
  });

  it("names the field whose create grant is narrowed", () => {
    // `grantMap` read `fields.*.read` and `fields.*.update` and not the third arm for the two
    // increments after ADR-0348 added it, so this narrowing produced no `PermissionChange` at all:
    // a reviewer was shown a `permissions` section change with nothing naming the field.
    const active = base();
    permissions(active, "Customer")["fields"] = {
      contact_email: { create: { roles: ["app_admin", "app_user"] } },
    };
    const next = base();
    permissions(next, "Customer")["fields"] = {
      contact_email: { create: { roles: ["app_admin"] } },
    };
    const view = diffManifests(active, next);
    expect(permissionChange(view, "Customer", "fields.contact_email.create")).toEqual({
      entity: "Customer",
      operation: "fields.contact_email.create",
      granted: [],
      revoked: ["app_user"],
    });
    expect(codes(view)).toContain("permission_revoked");
    expect(view.impact).toBe("breaking");
  });

  it("reads the create arm directly rather than through its update fallback", () => {
    // `create ?? update` is the authorization path's fallback and resolving it here would report an
    // inherited `update` grant twice and a declared `create` grant not at all. A field declaring
    // only `update` must therefore produce exactly one change, named `.update`.
    const next = base();
    permissions(next, "Customer")["fields"] = { contact_email: { update: { roles: ["app_user"] } } };
    const view = diffManifests(base(), next);
    const operations = view.permissionChanges
      .filter((change) => change.operation.startsWith("fields."))
      .map((change) => change.operation);
    expect(operations).toEqual(["fields.contact_email.update"]);
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

  it("flags the one kind flip that keeps its label", () => {
    // `many_to_one` and `one_to_many` over the same triple share `relationLabel`, so before this
    // the flip was invisible to this layer — and to the census too, since `relations` is
    // `unkeyed_array` and a same-count content change answers `mayWithhold: false`. Measured at
    // `additive` with no detail and no warning.
    //
    // The active side declares CASCADE so the fixture exercises what the warning claims: only
    // `many_to_one` is indexed by `relationDeleteIndex`, so after the flip the declared policy is
    // inert and the column's foreign key reverts to RESTRICT.
    const active = base();
    const before = relations(active)[0];
    if (before === undefined) throw new Error("no relation");
    before["onDelete"] = "cascade";
    const next = base();
    const relation = relations(next)[0];
    if (relation === undefined) throw new Error("no relation");
    relation["kind"] = "one_to_many";
    relation["onDelete"] = "cascade";
    const view = diffManifests(active, next);
    expect(view.impact).toBe("breaking");
    expect(codes(view)).toContain("relation_kind_changed");
    expect(view.relationChanges).toEqual([
      {
        change: "modified",
        label: "WorkOrder.customer → Customer",
        detail: "kind many_to_one → one_to_many",
      },
    ]);
  });

  it("reports the kind alone when the kind and the onDelete both change", () => {
    // A consequence of comparing the kind first, and the right one: the flip makes the declared
    // policy inert, so reporting `onDelete restrict → cascade` beside it would name a rule that
    // will never be applied.
    const next = base();
    const relation = relations(next)[0];
    if (relation === undefined) throw new Error("no relation");
    relation["kind"] = "one_to_many";
    relation["onDelete"] = "cascade";
    const view = diffManifests(base(), next);
    expect(view.relationChanges).toEqual([
      {
        change: "modified",
        label: "WorkOrder.customer → Customer",
        detail: "kind many_to_one → one_to_many",
      },
    ]);
    expect(codes(view)).not.toContain("relation_cascade_added");
  });

  it("reports a kind flip involving many_to_many as a removal and an addition", () => {
    // Which is why the kind comparison needs no arm for it: the label carries the whole of a
    // `many_to_many` (`{kind, left, right}` and nothing else), so such a flip cannot reach the
    // modified branch at all.
    const next = base();
    next["relations"] = [{ kind: "many_to_many", left: "WorkOrder", right: "Customer" }];
    const view = diffManifests(base(), next);
    expect(view.relationChanges.map((change) => change.change).sort()).toEqual([
      "added",
      "removed",
    ]);
    expect(codes(view)).toContain("relation_removed");
    expect(codes(view)).not.toContain("relation_kind_changed");
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

// The two sections the register names as live members (a removed job, a narrowed view) are absent
// from BASE, so a census probe over them needs them present on *both* sides — an added section is
// `mayWithhold: false` and would make every assertion below pass for the wrong reason.
const JOB: Record<string, unknown> = {
  id: "overdue-sweep",
  name: "Overdue sweep",
  description: "Daily sweep that moves sent invoices past their due date to overdue.",
  trigger: { kind: "scheduled", cron: "0 6 * * *", timezone: "UTC" },
  retry: {
    maxAttempts: 3,
    backoff: { kind: "exponential", initialDelay: "PT1M", maxDelay: "PT30M" },
  },
  onFailure: { strategy: "swallow-and-log" },
  idempotent: true,
  inputDataClass: "internal",
  outputDataClass: "internal",
};

const VIEW: Record<string, unknown> = {
  kind: "list",
  entity: "Customer",
  title: "Customers",
  columns: [{ field: "display_name" }, { field: "contact_email" }],
};

function baseWithUnreadSections(): Record<string, unknown> {
  const manifest = base();
  manifest["jobs"] = { overdue_sweep: JSON.parse(JSON.stringify(JOB)) };
  manifest["views"] = { customer_list: JSON.parse(JSON.stringify(VIEW)) };
  return manifest;
}

function sectionChange(view: ManifestDiffView, section: ManifestSectionName): SectionChangeView {
  const found = view.sectionChanges.find((change) => change.section === section);
  if (found === undefined) {
    throw new Error(
      `no section change for ${section}; got ${view.sectionChanges.map((c) => c.section).join(", ")}`,
    );
  }
  return found;
}

describe("the section census", () => {
  it("names no section for an identical pair", () => {
    expect(diffManifests(baseWithUnreadSections(), baseWithUnreadSections()).sectionChanges).toEqual(
      [],
    );
  });

  it("reports a removed job as breaking, which no detail layer can see", () => {
    const next = baseWithUnreadSections();
    next["jobs"] = {};
    const view = diffManifests(baseWithUnreadSections(), next);

    // The five detail layers are silent: this is the register's own live defect, where a reviewer
    // approving the change was shown `No changes`.
    expect(view.entitiesAdded).toEqual([]);
    expect(view.entitiesRemoved).toEqual([]);
    expect(view.entitiesModified).toEqual([]);
    expect(view.fieldChanges).toEqual([]);
    expect(view.permissionChanges).toEqual([]);
    expect(view.relationChanges).toEqual([]);
    expect(view.rolesRemoved).toEqual([]);
    expect(view.lifecycleChanges).toEqual([]);
    expect(view.warnings).toEqual([]);

    expect(sectionChange(view, "jobs")).toMatchObject({
      reach: "served",
      removed: ["overdue_sweep"],
      mayWithhold: true,
    });
    expect(view.impact).toBe("breaking");
  });

  it("reports a narrowed view as breaking", () => {
    const next = baseWithUnreadSections();
    (next["views"] as Record<string, Record<string, unknown>>)["customer_list"]!["columns"] = [
      { field: "display_name" },
    ];
    const view = diffManifests(baseWithUnreadSections(), next);
    expect(sectionChange(view, "views")).toMatchObject({
      reach: "served",
      changed: ["customer_list"],
      mayWithhold: true,
    });
    expect(view.impact).toBe("breaking");
  });

  it("reports meta.extends appearing, which the layers and the renderer both missed", () => {
    const next = baseWithUnreadSections();
    (next["meta"] as Record<string, unknown>)["extends"] = ["operate-erp/core"];
    const view = diffManifests(baseWithUnreadSections(), next);
    // `meta` is keyed by its own object keys, so a lineage appearing is an **added** key and not a
    // changed one — which is also why it is additive: a child gaining a parent inherits, where
    // losing one takes the parent's entities away and reads as `removed`.
    expect(sectionChange(view, "meta")).toMatchObject({
      reach: "served",
      added: ["extends"],
      changed: [],
      mayWithhold: false,
    });
    expect(view.impact).toBe("additive");
  });

  it("reports meta.extends disappearing as breaking", () => {
    // The direction that matters, and ADR-0368's own finding: a child that loses its lineage loses
    // every entity, role and workflow the parent contributed. Invisible in the view before this.
    const active = baseWithUnreadSections();
    (active["meta"] as Record<string, unknown>)["extends"] = ["operate-erp/core"];
    const view = diffManifests(active, baseWithUnreadSections());
    expect(sectionChange(view, "meta")).toMatchObject({
      removed: ["extends"],
      mayWithhold: true,
    });
    expect(view.impact).toBe("breaking");
  });

  it("names a validated_only section without calling it breaking", () => {
    const next = baseWithUnreadSections();
    next["reports"] = {
      customer_roster: {
        kind: "tabular",
        name: "Customer roster",
        entity: "Customer",
        columns: ["display_name"],
      },
    };
    const view = diffManifests(baseWithUnreadSections(), next);
    expect(sectionChange(view, "reports")).toMatchObject({
      reach: "validated_only",
      added: ["customer_roster"],
      mayWithhold: false,
    });
    // Named rather than silent, and additive rather than breaking: no runtime reads it, so the
    // change serves nothing, but a reviewer must still not be shown `No changes`.
    expect(view.impact).toBe("additive");
  });

  it("carries mayWithhold per change rather than leaving the renderer to re-derive it", () => {
    const next = baseWithUnreadSections();
    next["jobs"] = {};
    next["reports"] = {
      r: { kind: "tabular", name: "R", entity: "Customer", columns: ["display_name"] },
    };
    const view = diffManifests(baseWithUnreadSections(), next);

    // Written down rather than re-derived. The first draft of this test looped the changes
    // asserting `change.mayWithhold === manifestSectionChangeMayWithhold(change)`, which compares
    // a field against the very call that produced it (`compare` spreads the change and sets the
    // field from that function, which reads none of `mayWithhold`) — so it held for every input
    // and could only have failed if the field stopped being set at all, which the two values
    // below already catch. Expected values make it a fence: the kernel owns *what the predicate
    // answers* and this owns *that the view carries the kernel's answer*.
    expect(
      view.sectionChanges.map((change) => [change.section, change.mayWithhold] as const),
    ).toEqual([
      // A removed job: `served`, so a reviewer must be told something may be withheld.
      ["jobs", true],
      // A whole section declared where there was none, and `validated_only`: nothing reads it, so
      // nothing can be withheld by it.
      ["reports", false],
    ]);
  });

  it("sends the kernel's sentence for each reach rather than leaving the client to key on it", () => {
    const next = baseWithUnreadSections();
    next["jobs"] = {};
    next["reports"] = {
      r: { kind: "tabular", name: "R", entity: "Customer", columns: ["display_name"] },
    };
    const view = diffManifests(baseWithUnreadSections(), next);

    // `apps/operate-web` held a fourth copy of these three sentences keyed on the bare `reach`
    // string and that copy was the live one, so the sentence travels now. Asserted against the
    // kernel's map rather than against literals: a literal here would be the fifth copy.
    for (const change of view.sectionChanges) {
      expect(change.reachNote).toBe(MANIFEST_SECTION_REACH_MEANINGS[change.reach]);
    }
    // Non-vacuity: the two changes above span two reaches, so the loop compares two distinct
    // sentences rather than one repeated.
    expect(new Set(view.sectionChanges.map((change) => change.reachNote)).size).toBe(2);
  });
});

// A representative *withholding* change per section a detail layer reads. Withholding
// deliberately — `manifestSectionChangeMayWithhold` is what the census would upgrade impact on, so
// a probe whose change answers false would pass whether or not the layer covered the section, and
// the fence would assert nothing. No `detail` field: the extractor comes from
// `SECTION_DETAIL_LAYER`, so the fence reads the production reader rather than a parallel copy of
// it — which is the whole reason that map replaced a membership set.
const COVERED_SECTION_PROBES: readonly {
  readonly section: ManifestSectionName;
  readonly mutate: (next: Record<string, unknown>) => void;
}[] = [
  {
    section: "entities",
    mutate: (next) => {
      entity(next, "Customer")["fields"] = fields(next, "Customer").filter(
        (candidate) => candidate["name"] !== "notes",
      );
    },
  },
  {
    section: "relations",
    mutate: (next) => {
      next["relations"] = [];
    },
  },
  {
    section: "roles",
    mutate: (next) => {
      delete (next["roles"] as Record<string, unknown>)["app_user"];
    },
  },
  {
    section: "permissions",
    mutate: (next) => {
      permissions(next, "WorkOrder")["create"] = { roles: ["app_admin"] };
    },
  },
  {
    section: "workflows",
    mutate: (next) => {
      const workflow = lifecycle(next);
      workflow["states"] = [{ name: "open" }, { name: "closed" }];
      workflow["transitions"] = [{ name: "close", from: "open", to: "closed" }];
    },
  },
];

function layerCount(view: ManifestDiffView, section: ManifestSectionName): number {
  const layer = SECTION_DETAIL_LAYER[section];
  if (layer === null) throw new Error(`no detail layer declared for ${section}`);
  return layer(view);
}

describe("SECTION_DETAIL_LAYER", () => {
  it("is total over the kernel's section census", () => {
    // A section added to `ManifestSchema` is a compile error here; this is the run-time half, so a
    // renamed key cannot leave a live entry pointing at a section that no longer exists.
    expect(Object.keys(SECTION_DETAIL_LAYER).sort()).toEqual([...MANIFEST_SECTION_NAMES].sort());
  });

  it("matches the probe table in both directions", () => {
    // One-way would pass while both halves were stale together (pg-record-retention.ts's rule).
    const covered = MANIFEST_SECTION_NAMES.filter(
      (section) => SECTION_DETAIL_LAYER[section] !== null,
    );
    expect([...covered].sort()).toEqual(COVERED_SECTION_PROBES.map((probe) => probe.section).sort());
  });

  it("counts what its layer reported for every section it covers", () => {
    for (const probe of COVERED_SECTION_PROBES) {
      const next = base();
      probe.mutate(next);
      const view = diffManifests(base(), next);

      // The mutation really reaches the section, and really is one the census would upgrade on —
      // so the suppression below is load-bearing rather than vacuous.
      const change = sectionChange(view, probe.section);
      expect(change.mayWithhold, `${probe.section}: probe must be a withholding change`).toBe(true);

      // And the declared extractor saw it. A section whose entry reads the wrong view field fails
      // here rather than silently suppressing its own census upgrade for every change.
      expect(
        layerCount(view, probe.section),
        `${probe.section}: extractor read nothing for a change its layer reported`,
      ).toBeGreaterThan(0);
    }
  });

  it("counts zero for every covered section on an unchanged pair", () => {
    // The non-vacuity control: each count above is non-zero *because of* the mutation.
    const view = diffManifests(base(), base());
    for (const probe of COVERED_SECTION_PROBES) {
      expect(layerCount(view, probe.section), `${probe.section}`).toBe(0);
    }
  });

  it("does not overrule a layer that judged a change additive", () => {
    // The regression that produced the suppression: adding an optional field changes the `entities`
    // section, `entities` is served, so the coarse census answers may-withhold — and mapping that
    // straight onto impact reported `breaking` for a change entityLayer had correctly called
    // additive, in five existing tests at once.
    const next = base();
    fields(next, "Customer").push({ name: "nickname", type: { kind: "text", maxLength: 80 } });
    const view = diffManifests(base(), next);
    expect(sectionChange(view, "entities").mayWithhold).toBe(true);
    expect(fieldChange(view, "Customer", "nickname").change).toBe("added");
    expect(layerCount(view, "entities")).toBeGreaterThan(0);
    expect(view.impact).toBe("additive");
  });

  it("does not overrule a layer that judged a lifecycle state addition additive", () => {
    // The second half of the same property, and the one a per-member rule would regress: the
    // census names the *workflow* key while `lifecycleLayer` reports by **entity**, so matching
    // member keys against layer details would find no match here and upgrade a state addition to
    // breaking.
    const next = base();
    const workflow = lifecycle(next);
    workflow["states"] = [
      { name: "open" },
      { name: "closed" },
      { name: "cancelled" },
      { name: "on_hold" },
    ];
    workflow["transitions"] = [
      { name: "close", from: "open", to: "closed" },
      { name: "cancel", from: "open", to: "cancelled" },
      { name: "hold", from: "open", to: "on_hold" },
    ];
    const view = diffManifests(base(), next);
    expect(sectionChange(view, "workflows").mayWithhold).toBe(true);
    expect(layerCount(view, "workflows")).toBeGreaterThan(0);
    expect(view.impact).toBe("additive");
  });
});

// Every one of these changes a covered section, is a change the census would upgrade on, and is
// invisible to that section's own detail layer — so before the layer-silence rule each read
// `additive` while taking something away. Measured against the committed tree; four of the five
// covered sections have a member.
const SILENT_LAYER_CASES: readonly {
  readonly name: string;
  readonly section: ManifestSectionName;
  readonly mutateActive?: (active: Record<string, unknown>) => void;
  readonly mutate: (next: Record<string, unknown>) => void;
}[] = [
  {
    // The sharpest member: ADR-0340 refuses an undischargeable obligation at boot, so for a tenant
    // whose deployment declares no evaluator this is a permanent 503 approved as additive.
    name: "an abac obligation added to a list grant",
    section: "permissions",
    mutate: (next) => {
      permissions(next, "Customer")["list"] = {
        roles: ["app_admin", "app_user"],
        abac: "own_rows",
      };
    },
  },
  {
    name: "a role losing its inherits",
    section: "roles",
    mutateActive: (active) => {
      (active["roles"] as Record<string, Record<string, unknown>>)["app_user"] = {
        name: "app_user",
        inherits: ["app_admin"],
      };
    },
    mutate: () => {
      /* next keeps the plain role, so the change is the removal */
    },
  },
  {
    // A real unique index since ADR-0360: existing duplicates stop being updatable and a create
    // that would collide answers 409.
    name: "unique added to a field",
    section: "entities",
    mutate: (next) => {
      field(next, "Customer", "contact_email")["unique"] = true;
    },
  },
  {
    name: "a transition retargeted",
    section: "workflows",
    mutate: (next) => {
      lifecycle(next)["transitions"] = [
        { name: "close", from: "open", to: "cancelled" },
        { name: "cancel", from: "open", to: "cancelled" },
      ];
    },
  },
  {
    name: "a transition re-sourced",
    section: "workflows",
    mutate: (next) => {
      lifecycle(next)["transitions"] = [
        { name: "close", from: "closed", to: "closed" },
        { name: "cancel", from: "open", to: "cancelled" },
      ];
    },
  },
];

describe("a silent layer is not a verdict", () => {
  for (const probe of SILENT_LAYER_CASES) {
    it(`reports ${probe.name} as breaking`, () => {
      const active = base();
      probe.mutateActive?.(active);
      const next = base();
      probe.mutate(next);
      const view = diffManifests(active, next);

      // Three facts, and the test is worthless without all three: the manifest still parses (an
      // unparseable one answers `comparable: false` with every count zero, which is how two of
      // these probes first read as clean), the census would upgrade on it, and the layer that reads
      // that section saw nothing.
      expect(view.comparable, "the mutated manifest must still parse").toBe(true);
      expect(sectionChange(view, probe.section).mayWithhold).toBe(true);
      expect(layerCount(view, probe.section), "the layer must be silent for this to be the case").toBe(
        0,
      );

      expect(view.impact).toBe("breaking");
      // And no detail layer produced a warning either, so `breaking` here is the census's verdict
      // rather than something a warning would have reported anyway.
      expect(view.warnings).toEqual([]);
    });
  }

  it("upgrades a cosmetic change inside a covered section too, which is the stated cost", () => {
    // A role's description moving withholds nothing and reads breaking. That is the same cost every
    // *uncovered* section already pays — the kernel's own doc gives `roles` as its example of a
    // change that may only have moved a label — and it is the safe direction: a reviewer who looks
    // at an over-reported diff loses time, where one who was not shown a removal loses the data.
    const next = base();
    (next["roles"] as Record<string, Record<string, unknown>>)["app_user"] = {
      name: "app_user",
      description: "renamed label",
    };
    const view = diffManifests(base(), next);
    expect(layerCount(view, "roles")).toBe(0);
    expect(view.impact).toBe("breaking");
  });

  it("stays additive when the layer spoke about a different member, which is the stated residual", () => {
    // The granularity is the section and not the member: `entityLayer` reports the added field on
    // Customer, so the census is suppressed for `entities` as a whole and the `unique` added to
    // WorkOrder.title rides along invisibly. Closing this means matching member keys against layer
    // details, which the lifecycle-state test above shows cannot be done uniformly.
    const next = base();
    fields(next, "Customer").push({ name: "nickname", type: { kind: "text", maxLength: 50 } });
    field(next, "WorkOrder", "title")["unique"] = true;
    const view = diffManifests(base(), next);
    expect(layerCount(view, "entities")).toBeGreaterThan(0);
    expect(view.impact).toBe("additive");
  });
});
