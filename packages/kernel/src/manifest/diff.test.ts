import { describe, expect, it } from "vitest";
import type { Entity, Trait } from "@crossengin/types/meta-schema";
import {
  FieldNameCollisionError,
  ReservedFieldNameError,
  UnsupportedDiffChangeError,
} from "../ddl/errors.js";
import { computeManifestDiff } from "./diff.js";
import { diffManifestSections } from "./sections.js";
import type { Manifest } from "./types.js";

const meta = { name: "T", slug: "t", version: "1.0.0" } as const;

function manifest(entities: Entity[], traits?: Trait[]): Manifest {
  return { manifestVersion: "1.0", meta, entities, ...(traits === undefined ? {} : { traits }) };
}

/** One entity carrying one custom trait, so only the trait's own declaration varies. */
function traited(traitFields: Trait["fields"]): Manifest {
  return manifest(
    [{ name: "Patient", traits: ["stamped"], fields: [{ name: "label", type: { kind: "text" } }] }],
    [{ name: "stamped", fields: traitFields }],
  );
}

describe("computeManifestDiff", () => {
  it("returns an empty diff for identical manifests", () => {
    const m = manifest([
      { name: "Patient", fields: [{ name: "name", type: { kind: "text" } }] },
    ]);
    const diff = computeManifestDiff(m, m);
    expect(diff.addedEntities).toEqual([]);
    expect(diff.removedEntities).toEqual([]);
    expect(diff.modifiedEntities).toEqual([]);
    expect(diff.destructive).toBe(false);
  });

  it("treats null old as everything-added", () => {
    const m = manifest([
      { name: "Patient", fields: [{ name: "name", type: { kind: "text" } }] },
    ]);
    const diff = computeManifestDiff(null, m);
    expect(diff.addedEntities).toHaveLength(1);
    expect(diff.addedEntities[0]?.name).toBe("Patient");
    expect(diff.destructive).toBe(false);
  });

  it("detects an added entity", () => {
    const m1 = manifest([
      { name: "Patient", fields: [{ name: "name", type: { kind: "text" } }] },
    ]);
    const m2 = manifest([
      { name: "Patient", fields: [{ name: "name", type: { kind: "text" } }] },
      { name: "Prescription", fields: [{ name: "qty", type: { kind: "integer" } }] },
    ]);
    const diff = computeManifestDiff(m1, m2);
    expect(diff.addedEntities.map((e) => e.name)).toEqual(["Prescription"]);
    expect(diff.removedEntities).toEqual([]);
    expect(diff.modifiedEntities).toEqual([]);
    expect(diff.destructive).toBe(false);
  });

  it("detects a removed entity as destructive", () => {
    const m1 = manifest([
      { name: "Patient", fields: [{ name: "name", type: { kind: "text" } }] },
      { name: "Prescription", fields: [{ name: "qty", type: { kind: "integer" } }] },
    ]);
    const m2 = manifest([
      { name: "Patient", fields: [{ name: "name", type: { kind: "text" } }] },
    ]);
    const diff = computeManifestDiff(m1, m2);
    expect(diff.removedEntities.map((e) => e.name)).toEqual(["Prescription"]);
    expect(diff.destructive).toBe(true);
  });

  it("detects a modified entity via the entity diff", () => {
    const m1 = manifest([
      { name: "Patient", fields: [{ name: "name", type: { kind: "text", maxLength: 50 } }] },
    ]);
    const m2 = manifest([
      { name: "Patient", fields: [{ name: "name", type: { kind: "text", maxLength: 100 } }] },
    ]);
    const diff = computeManifestDiff(m1, m2);
    expect(diff.modifiedEntities).toHaveLength(1);
    expect(diff.modifiedEntities[0]?.entity.name).toBe("Patient");
    expect(diff.modifiedEntities[0]?.diff.modifiedFields[0]?.typeChange).toEqual({
      from: "VARCHAR(50)",
      to: "VARCHAR(100)",
    });
  });

  it("marks destructive when a modified entity drops fields", () => {
    const m1 = manifest([
      {
        name: "Patient",
        fields: [
          { name: "name", type: { kind: "text" } },
          { name: "removed_col", type: { kind: "text" } },
        ],
      },
    ]);
    const m2 = manifest([
      { name: "Patient", fields: [{ name: "name", type: { kind: "text" } }] },
    ]);
    const diff = computeManifestDiff(m1, m2);
    expect(diff.modifiedEntities[0]?.diff.destructive).toBe(true);
    expect(diff.destructive).toBe(true);
  });
});

/**
 * Each side is resolved against **its own** manifest's traits. Before this, both sides were
 * expanded against `next.traits`, so a trait's own declaration changing came back identical on
 * both sides and the diff reported nothing — while `columnPlanForEntity` reads `manifest.traits`,
 * so the served table really did gain, lose or retype that column.
 */
describe("computeManifestDiff over a custom trait", () => {
  it("sees a trait field retyped", () => {
    const diff = computeManifestDiff(
      traited([{ name: "stamp", type: { kind: "text", maxLength: 50 } }]),
      traited([{ name: "stamp", type: { kind: "text", maxLength: 100 } }]),
    );
    expect(diff.modifiedEntities).toHaveLength(1);
    expect(diff.modifiedEntities[0]?.diff.modifiedFields[0]?.name).toBe("stamp");
    expect(diff.modifiedEntities[0]?.diff.modifiedFields[0]?.typeChange).toEqual({
      from: "VARCHAR(50)",
      to: "VARCHAR(100)",
    });
  });

  /**
   * A trait field is now refused for exactly the changes an own field is refused for. That is the
   * consistency worth having and it is also the limit of this half: a caller that degrades on the
   * throw to a comparison over `entity.fields` learns nothing from it, so the section census is
   * what covers a type-kind change on a trait.
   */
  it("refuses a trait field's type kind changing, as it does for an own field", () => {
    const before = traited([{ name: "stamp", type: { kind: "text" } }]);
    const after = traited([{ name: "stamp", type: { kind: "integer" } }]);
    expect(() => computeManifestDiff(before, after)).toThrow(UnsupportedDiffChangeError);
    expect(diffManifestSections(before, after)).toEqual([
      expect.objectContaining({ section: "traits", changed: ["stamped"] }),
    ]);
  });

  it("sees a trait field removed, and calls it destructive", () => {
    const diff = computeManifestDiff(
      traited([{ name: "stamp", type: { kind: "text" } }]),
      traited([{ name: "other", type: { kind: "text" } }]),
    );
    expect(diff.modifiedEntities[0]?.diff.removedFields).toEqual(["stamp"]);
    expect(diff.modifiedEntities[0]?.diff.addedFields.map((f) => f.name)).toEqual(["other"]);
    expect(diff.destructive).toBe(true);
  });

  it("sees a trait field becoming required", () => {
    const diff = computeManifestDiff(
      traited([{ name: "stamp", type: { kind: "text" } }]),
      traited([{ name: "stamp", type: { kind: "text" }, required: true }]),
    );
    expect(diff.modifiedEntities[0]?.diff.modifiedFields[0]?.nullabilityChange).toEqual({
      from: false,
      to: true,
    });
  });

  it("reports nothing when the trait is unchanged", () => {
    const m = traited([{ name: "stamp", type: { kind: "text" } }]);
    const diff = computeManifestDiff(m, m);
    expect(diff.modifiedEntities).toEqual([]);
    expect(diff.destructive).toBe(false);
  });

  it("still refuses an own field colliding with an old trait's field", () => {
    const before = manifest(
      [{ name: "Patient", traits: ["stamped"], fields: [{ name: "stamp", type: { kind: "text" } }] }],
      [{ name: "stamped", fields: [{ name: "stamp", type: { kind: "text" } }] }],
    );
    const after = traited([{ name: "stamp", type: { kind: "text" } }]);
    expect(() => computeManifestDiff(before, after)).toThrow(FieldNameCollisionError);
  });

  /**
   * The regression the fabricated-entity form of this fix carried, and the reason
   * `DiffContext.oldCustomTraits` exists instead.
   *
   * Pre-expanding the old entity into `{...entity, traits: [], fields: [...own, ...trait]}` was the
   * cheap way to resolve it against its own traits, and it destroyed provenance: with trait fields
   * sitting in `fields`, `computeEntityDiff`'s own `checkEntityFieldNames` read them as own
   * declarations and threw `ReservedFieldNameError` for a trait supplying `id`. Measured on that
   * form: `ManifestSchema.parse` succeeds, `validateManifest` accepted it (it does not any more —
   * see the validator rule), and `computeManifestDiff` went from answering cleanly to throwing.
   * The consumer then degraded the **whole** entity layer to a name-level comparison, so an
   * unrelated own-field change on another entity went from `entitiesModified: ["Patient"]` to `[]`.
   */
  it("does not read a trait-supplied field as an own declaration", () => {
    const idTrait = (extra: Trait["fields"]): Manifest =>
      manifest(
        [
          {
            name: "Patient",
            traits: ["stamped"],
            fields: [{ name: "label", type: { kind: "text" } }, ...extra],
          },
        ],
        [{ name: "stamped", fields: [{ name: "id", type: { kind: "text" } }] }],
      );
    const before = idTrait([{ name: "doomed", type: { kind: "text" } }]);
    const after = idTrait([]);
    const diff = computeManifestDiff(before, after);
    expect(diff.modifiedEntities[0]?.diff.removedFields).toEqual(["doomed"]);
    expect(diff.destructive).toBe(true);
  });

  it("still refuses an own field named `id`, which is a declaration", () => {
    const own = manifest([
      { name: "Patient", fields: [{ name: "id", type: { kind: "text" } }] },
    ]);
    expect(() => computeManifestDiff(own, own)).toThrow(ReservedFieldNameError);
  });

  /**
   * The case one `customTraits` list cannot express at all: the old entity names a trait the old
   * manifest declares and the new one does not, having dropped the trait from the entity too. With
   * one list the old side resolved against `next.traits`, where the trait is absent, and
   * `expandTraits` threw `UnknownTraitError`.
   */
  it("resolves the old side against a trait only the old manifest declares", () => {
    const before = traited([{ name: "stamp", type: { kind: "text" } }]);
    const after = manifest([
      { name: "Patient", fields: [{ name: "label", type: { kind: "text" } }] },
    ]);
    const diff = computeManifestDiff(before, after);
    expect(diff.modifiedEntities[0]?.diff.removedFields).toEqual(["stamp"]);
    expect(diff.destructive).toBe(true);
  });

  /**
   * Indexes resolve from the old side's own traits too, which is the half a fields-only comparison
   * would miss: `computeResolvedIndexes` reads a trait's `indexed` fields and its references.
   */
  it("resolves the old side's trait-contributed indexes against its own traits", () => {
    const diff = computeManifestDiff(
      traited([{ name: "stamp", type: { kind: "text" }, indexed: true }]),
      traited([{ name: "stamp", type: { kind: "text" } }]),
    );
    expect(diff.modifiedEntities[0]?.diff.removedIndexes).toEqual([{ columns: ["stamp"] }]);
    expect(diff.modifiedEntities[0]?.diff.addedIndexes).toEqual([]);
  });

  /**
   * A trait field's *classification* moves no column, so `computeFieldModification` does not
   * compare it and the entity diff is silent — which is correct for this function and is why the
   * section census is the half that catches it.
   */
  it("leaves a trait field's classification to the section census", () => {
    const before = traited([{ name: "stamp", type: { kind: "text" }, classification: "phi" }]);
    const after = traited([{ name: "stamp", type: { kind: "text" }, classification: "internal" }]);
    expect(computeManifestDiff(before, after).modifiedEntities).toEqual([]);
    expect(diffManifestSections(before, after)).toEqual([
      expect.objectContaining({ section: "traits", changed: ["stamped"], reach: "served" }),
    ]);
  });
});
