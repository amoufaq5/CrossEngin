import { describe, expect, it } from "vitest";
import type { Manifest } from "./types.js";
import { ManifestValidationError } from "./errors.js";
import { validateManifest } from "./validate.js";

const baseMeta = { name: "Test", slug: "test", version: "1.0.0" } as const;

describe("validateManifest — entities", () => {
  it("accepts an empty manifest", () => {
    const m: Manifest = { manifestVersion: "1.0", meta: baseMeta };
    expect(() => validateManifest(m)).not.toThrow();
  });

  it("throws on duplicate entity names", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [
        { name: "Patient", fields: [{ name: "a", type: { kind: "text" } }] },
        { name: "Patient", fields: [{ name: "b", type: { kind: "text" } }] },
      ],
    };
    expect(() => validateManifest(m)).toThrow(ManifestValidationError);
  });

  it("accepts entities with reference to a known entity", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [
        { name: "Patient", fields: [{ name: "a", type: { kind: "text" } }] },
        {
          name: "Prescription",
          fields: [{ name: "patient", type: { kind: "reference", target: "Patient" } }],
        },
      ],
    };
    expect(() => validateManifest(m)).not.toThrow();
  });

  it("throws on reference to an unknown entity", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [
        {
          name: "Prescription",
          fields: [{ name: "patient", type: { kind: "reference", target: "Patient" } }],
        },
      ],
    };
    expect(() => validateManifest(m)).toThrow(/Patient/);
  });
});

describe("validateManifest — traits", () => {
  it("throws on duplicate custom trait names", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      traits: [
        { name: "geocoded", fields: [] },
        { name: "geocoded", fields: [] },
      ],
    };
    expect(() => validateManifest(m)).toThrow(ManifestValidationError);
  });

  it("throws when a custom trait shadows a built-in", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      traits: [{ name: "auditable", fields: [] }],
    };
    expect(() => validateManifest(m)).toThrow(/built-in/);
  });

  it("accepts entities referencing a built-in trait", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [
        {
          name: "Patient",
          fields: [{ name: "a", type: { kind: "text" } }],
          traits: ["auditable"],
        },
      ],
    };
    expect(() => validateManifest(m)).not.toThrow();
  });

  it("accepts entities referencing a custom trait declared in manifest", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [
        {
          name: "Patient",
          fields: [{ name: "a", type: { kind: "text" } }],
          traits: ["geocoded"],
        },
      ],
      traits: [
        {
          name: "geocoded",
          fields: [{ name: "lat", type: { kind: "decimal", precision: 10, scale: 6 } }],
        },
      ],
    };
    expect(() => validateManifest(m)).not.toThrow();
  });

  it("throws on an unknown trait reference", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [
        {
          name: "Patient",
          fields: [{ name: "a", type: { kind: "text" } }],
          traits: ["mystery"],
        },
      ],
    };
    expect(() => validateManifest(m)).toThrow(/mystery/);
  });

  it("checks trait field references against entity set", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [{ name: "Patient", fields: [{ name: "a", type: { kind: "text" } }] }],
      traits: [
        {
          name: "with_owner",
          fields: [{ name: "owner", type: { kind: "reference", target: "Owner" } }],
        },
      ],
    };
    expect(() => validateManifest(m)).toThrow(/Owner/);
  });
});

describe("validateManifest — relations", () => {
  it("accepts many_to_one with known entities", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [
        { name: "Patient", fields: [{ name: "a", type: { kind: "text" } }] },
        { name: "Prescription", fields: [{ name: "a", type: { kind: "text" } }] },
      ],
      relations: [
        { kind: "many_to_one", from: "Prescription", field: "patient", to: "Patient" },
      ],
    };
    expect(() => validateManifest(m)).not.toThrow();
  });

  it("throws on many_to_one with unknown 'to'", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [{ name: "Prescription", fields: [{ name: "a", type: { kind: "text" } }] }],
      relations: [
        { kind: "many_to_one", from: "Prescription", field: "patient", to: "Patient" },
      ],
    };
    expect(() => validateManifest(m)).toThrow(/Patient/);
  });

  it("throws on many_to_many with unknown 'left'", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [{ name: "Specialty", fields: [{ name: "a", type: { kind: "text" } }] }],
      relations: [{ kind: "many_to_many", left: "Doctor", right: "Specialty" }],
    };
    expect(() => validateManifest(m)).toThrow(/Doctor/);
  });
});
