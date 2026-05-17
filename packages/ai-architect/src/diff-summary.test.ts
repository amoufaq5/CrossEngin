import { describe, expect, it } from "vitest";
import type { Entity } from "@crossengin/types/meta-schema";
import type { ManifestDiff } from "@crossengin/kernel/manifest";
import { diffSummaryFromManifestDiff } from "./diff-summary.js";

const emptyDiff: ManifestDiff = {
  addedEntities: [],
  removedEntities: [],
  modifiedEntities: [],
  destructive: false,
};

describe("diffSummaryFromManifestDiff", () => {
  it("returns 'no changes' for an empty diff", () => {
    const s = diffSummaryFromManifestDiff(emptyDiff);
    expect(s.summary).toBe("no changes");
    expect(s.added).toEqual([]);
    expect(s.removed).toEqual([]);
    expect(s.modified).toEqual([]);
    expect(s.destructive).toBe(false);
  });

  it("summarizes added entities with field count", () => {
    const entity: Entity = {
      name: "Patient",
      fields: [
        { name: "first_name", type: { kind: "text" } },
        { name: "email", type: { kind: "email" } },
        { name: "dob", type: { kind: "date" } },
      ],
    };
    const s = diffSummaryFromManifestDiff({
      ...emptyDiff,
      addedEntities: [entity],
    });
    expect(s.summary).toBe("1 added");
    expect(s.added).toEqual(["Added entity 'Patient' (3 fields)"]);
    expect(s.destructive).toBe(false);
  });

  it("uses singular 'field' when there is exactly one", () => {
    const entity: Entity = {
      name: "Minimal",
      fields: [{ name: "x", type: { kind: "text" } }],
    };
    const s = diffSummaryFromManifestDiff({
      ...emptyDiff,
      addedEntities: [entity],
    });
    expect(s.added[0]).toBe("Added entity 'Minimal' (1 field)");
  });

  it("marks removed entities as destructive", () => {
    const entity: Entity = {
      name: "Legacy",
      fields: [{ name: "x", type: { kind: "text" } }],
    };
    const s = diffSummaryFromManifestDiff({
      ...emptyDiff,
      removedEntities: [entity],
      destructive: true,
    });
    expect(s.summary).toBe("1 removed");
    expect(s.removed).toEqual(["Removed entity 'Legacy' (destructive)"]);
    expect(s.destructive).toBe(true);
  });

  it("summarizes modified entities with per-section counts", () => {
    const entity: Entity = {
      name: "Patient",
      fields: [{ name: "x", type: { kind: "text" } }],
    };
    const s = diffSummaryFromManifestDiff({
      ...emptyDiff,
      modifiedEntities: [
        {
          entity,
          diff: {
            tableName: "patient",
            addedFields: [{ name: "email", type: { kind: "email" } }],
            removedFields: ["old_col"],
            modifiedFields: [
              { name: "name", columnName: "name", nullabilityChange: { from: false, to: true } },
            ],
            addedIndexes: [{ columns: ["email"] }],
            removedIndexes: [],
            destructive: true,
          },
        },
      ],
      destructive: true,
    });
    expect(s.summary).toBe("1 modified");
    expect(s.modified[0]).toBe(
      "Modified entity 'Patient' (+1 field, -1 field, ~1 field, +1 index)",
    );
    expect(s.destructive).toBe(true);
  });

  it("uses plural 'indexes' when index count > 1", () => {
    const entity: Entity = {
      name: "Patient",
      fields: [{ name: "x", type: { kind: "text" } }],
    };
    const s = diffSummaryFromManifestDiff({
      ...emptyDiff,
      modifiedEntities: [
        {
          entity,
          diff: {
            tableName: "patient",
            addedFields: [],
            removedFields: [],
            modifiedFields: [],
            addedIndexes: [{ columns: ["a"] }, { columns: ["b"] }],
            removedIndexes: [],
            destructive: false,
          },
        },
      ],
    });
    expect(s.modified[0]).toContain("+2 indexes");
  });

  it("combines multiple change categories", () => {
    const eAdd: Entity = {
      name: "New",
      fields: [{ name: "x", type: { kind: "text" } }],
    };
    const eRem: Entity = {
      name: "Old",
      fields: [{ name: "x", type: { kind: "text" } }],
    };
    const eMod: Entity = {
      name: "Existing",
      fields: [{ name: "x", type: { kind: "text" } }],
    };
    const s = diffSummaryFromManifestDiff({
      addedEntities: [eAdd],
      removedEntities: [eRem],
      modifiedEntities: [
        {
          entity: eMod,
          diff: {
            tableName: "existing",
            addedFields: [{ name: "y", type: { kind: "text" } }],
            removedFields: [],
            modifiedFields: [],
            addedIndexes: [],
            removedIndexes: [],
            destructive: false,
          },
        },
      ],
      destructive: true,
    });
    expect(s.summary).toBe("1 added, 1 removed, 1 modified");
    expect(s.added).toHaveLength(1);
    expect(s.removed).toHaveLength(1);
    expect(s.modified).toHaveLength(1);
  });
});
