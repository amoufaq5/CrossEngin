import { describe, expect, it } from "vitest";
import type { Entity } from "@crossengin/types/meta-schema";
import { computeManifestDiff } from "./diff.js";
import type { Manifest } from "./types.js";

const meta = { name: "T", slug: "t", version: "1.0.0" } as const;

function manifest(entities: Entity[]): Manifest {
  return { manifestVersion: "1.0", meta, entities };
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
