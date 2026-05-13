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

describe("validateManifest — roles", () => {
  it("accepts a manifest with a flat role set", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      roles: {
        staff: { name: "staff" },
        pharmacist: { name: "pharmacist", inherits: ["staff"] },
      },
    };
    expect(() => validateManifest(m)).not.toThrow();
  });

  it("throws when role.name doesn't match its record key", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      roles: {
        staff: { name: "pharmacist" },
      },
    };
    expect(() => validateManifest(m)).toThrow(/does not match record key/);
  });

  it("throws on a role inheritance cycle", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      roles: {
        a: { name: "a", inherits: ["b"] },
        b: { name: "b", inherits: ["a"] },
      },
    };
    expect(() => validateManifest(m)).toThrow(/inheritance cycle/);
  });

  it("throws when inherits references an unknown role", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      roles: {
        pharmacist: { name: "pharmacist", inherits: ["mystery"] },
      },
    };
    expect(() => validateManifest(m)).toThrow(/unknown role 'mystery'/);
  });
});

describe("validateManifest — permissions", () => {
  const baseRoles = {
    pharmacist: { name: "pharmacist" as const },
    manager: { name: "manager" as const, inherits: ["pharmacist"] },
  };

  it("accepts permissions for declared entities with declared roles", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [
        { name: "Prescription", fields: [{ name: "qty", type: { kind: "integer" } }] },
      ],
      roles: baseRoles,
      permissions: {
        Prescription: {
          read: { roles: ["pharmacist", "manager"] },
          update: { roles: ["pharmacist"] },
        },
      },
    };
    expect(() => validateManifest(m)).not.toThrow();
  });

  it("throws on a permission entry for an unknown entity", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [
        { name: "Prescription", fields: [{ name: "qty", type: { kind: "integer" } }] },
      ],
      roles: baseRoles,
      permissions: {
        NonExistent: { read: { roles: ["pharmacist"] } },
      },
    };
    expect(() => validateManifest(m)).toThrow(/unknown entity 'NonExistent'/);
  });

  it("throws when an operation grant references an unknown role", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [
        { name: "Prescription", fields: [{ name: "qty", type: { kind: "integer" } }] },
      ],
      roles: baseRoles,
      permissions: {
        Prescription: { read: { roles: ["mystery"] } },
      },
    };
    expect(() => validateManifest(m)).toThrow(/role 'mystery'/);
  });

  it("throws when a transition grant references an unknown role", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [
        { name: "Prescription", fields: [{ name: "qty", type: { kind: "integer" } }] },
      ],
      roles: baseRoles,
      permissions: {
        Prescription: {
          transitions: { verify: { roles: ["mystery"] } },
        },
      },
    };
    expect(() => validateManifest(m)).toThrow(/role 'mystery'/);
  });

  it("throws on a field-level permission for an unknown field", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [
        { name: "Prescription", fields: [{ name: "qty", type: { kind: "integer" } }] },
      ],
      roles: baseRoles,
      permissions: {
        Prescription: {
          fields: { mystery_field: { read: { roles: ["pharmacist"] } } },
        },
      },
    };
    expect(() => validateManifest(m)).toThrow(/unknown field 'mystery_field'/);
  });

  it("accepts a field-level permission for a trait-supplied field (e.g. auditable's created_at)", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [
        {
          name: "Prescription",
          fields: [{ name: "qty", type: { kind: "integer" } }],
          traits: ["auditable"],
        },
      ],
      roles: baseRoles,
      permissions: {
        Prescription: {
          fields: { created_at: { read: { roles: ["pharmacist"] } } },
        },
      },
    };
    expect(() => validateManifest(m)).not.toThrow();
  });

  it("throws when a field-level grant references an unknown role", () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: baseMeta,
      entities: [
        { name: "Prescription", fields: [{ name: "qty", type: { kind: "integer" } }] },
      ],
      roles: baseRoles,
      permissions: {
        Prescription: {
          fields: { qty: { read: { roles: ["mystery"] } } },
        },
      },
    };
    expect(() => validateManifest(m)).toThrow(/role 'mystery'/);
  });
});
