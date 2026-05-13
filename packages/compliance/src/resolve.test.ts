import { describe, expect, it } from "vitest";
import type { Manifest } from "@crossengin/kernel/manifest";
import { CollisionError, PackParameterError, UnknownPackError } from "./errors.js";
import { pack as part11Pack } from "./packs/21-cfr-part-11/pack.js";
import { resolveCompliancePacks, type ComplianceRegistry } from "./resolve.js";
import type { CompliancePack } from "./types.js";

const v = "1.0.0";

function registryFrom(map: Record<string, CompliancePack>): ComplianceRegistry {
  return {
    async getPack(id) {
      return map[id] ?? null;
    },
  };
}

describe("resolveCompliancePacks — no packs", () => {
  it("returns the manifest unchanged when compliancePacks is missing", async () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "T", slug: "t", version: v },
    };
    const result = await resolveCompliancePacks(m, { registry: registryFrom({}) });
    expect(result).toBe(m);
  });

  it("returns the manifest unchanged when compliancePacks is an empty array", async () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "T", slug: "t", version: v, compliancePacks: [] },
    };
    const result = await resolveCompliancePacks(m, { registry: registryFrom({}) });
    expect(result).toBe(m);
  });
});

describe("resolveCompliancePacks — single pack", () => {
  it("merges pack-contributed entities into the manifest", async () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: {
        name: "T",
        slug: "t",
        version: v,
        compliancePacks: ["21-cfr-part-11"],
        compliancePackParameters: {
          "21-cfr-part-11": { signatureMeaningStatement: { en: "I approve" } },
        },
      },
      entities: [
        { name: "Prescription", fields: [{ name: "qty", type: { kind: "integer" } }] },
      ],
    };
    const result = await resolveCompliancePacks(m, {
      registry: registryFrom({ "21-cfr-part-11": part11Pack }),
    });
    expect(result.entities?.map((e) => e.name).sort()).toEqual([
      "Prescription",
      "Signature",
    ]);
  });

  it("throws UnknownPackError when a pack is missing from the registry", async () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "T", slug: "t", version: v, compliancePacks: ["nonexistent"] },
    };
    await expect(
      resolveCompliancePacks(m, { registry: registryFrom({}) }),
    ).rejects.toBeInstanceOf(UnknownPackError);
  });
});

describe("resolveCompliancePacks — collisions", () => {
  it("throws when a pack entity collides with a tenant entity name", async () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: {
        name: "T",
        slug: "t",
        version: v,
        compliancePacks: ["21-cfr-part-11"],
        compliancePackParameters: {
          "21-cfr-part-11": { signatureMeaningStatement: { en: "I approve" } },
        },
      },
      entities: [{ name: "Signature", fields: [{ name: "x", type: { kind: "text" } }] }],
    };
    await expect(
      resolveCompliancePacks(m, {
        registry: registryFrom({ "21-cfr-part-11": part11Pack }),
      }),
    ).rejects.toBeInstanceOf(CollisionError);
  });

  it("throws when two packs contribute the same entity name", async () => {
    const dupPack: CompliancePack = {
      meta: { id: "dup", title: "Duplicate", version: "1.0.0" },
      contributions: {
        entities: [{ name: "Signature", fields: [{ name: "x", type: { kind: "text" } }] }],
      },
    };
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: {
        name: "T",
        slug: "t",
        version: v,
        compliancePacks: ["21-cfr-part-11", "dup"],
        compliancePackParameters: {
          "21-cfr-part-11": { signatureMeaningStatement: { en: "I approve" } },
        },
      },
    };
    await expect(
      resolveCompliancePacks(m, {
        registry: registryFrom({ "21-cfr-part-11": part11Pack, dup: dupPack }),
      }),
    ).rejects.toBeInstanceOf(CollisionError);
  });

  it("throws when a pack role collides with a tenant role", async () => {
    const rolePack: CompliancePack = {
      meta: { id: "role-pack", title: "Roles", version: "1.0.0" },
      contributions: { roles: { admin: { name: "admin" } } },
    };
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "T", slug: "t", version: v, compliancePacks: ["role-pack"] },
      roles: { admin: { name: "admin" } },
    };
    await expect(
      resolveCompliancePacks(m, {
        registry: registryFrom({ "role-pack": rolePack }),
      }),
    ).rejects.toBeInstanceOf(CollisionError);
  });
});

describe("resolveCompliancePacks — pack parameters", () => {
  const minimalProvided = { signatureMeaningStatement: { en: "I approve" } };

  it("accepts valid parameters", async () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: {
        name: "T",
        slug: "t",
        version: v,
        compliancePacks: ["21-cfr-part-11"],
        compliancePackParameters: {
          "21-cfr-part-11": {
            signatureMethod: "smart-card-pin",
            auditRetentionYears: 10,
            signatureMeaningStatement: { en: "I approve" },
          },
        },
      },
    };
    await expect(
      resolveCompliancePacks(m, {
        registry: registryFrom({ "21-cfr-part-11": part11Pack }),
      }),
    ).resolves.toBeDefined();
  });

  it("uses defaults for unspecified optional parameters", async () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: {
        name: "T",
        slug: "t",
        version: v,
        compliancePacks: ["21-cfr-part-11"],
        compliancePackParameters: {
          "21-cfr-part-11": minimalProvided,
        },
      },
    };
    await expect(
      resolveCompliancePacks(m, {
        registry: registryFrom({ "21-cfr-part-11": part11Pack }),
      }),
    ).resolves.toBeDefined();
  });

  it("throws when a required parameter is missing", async () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "T", slug: "t", version: v, compliancePacks: ["21-cfr-part-11"] },
    };
    await expect(
      resolveCompliancePacks(m, {
        registry: registryFrom({ "21-cfr-part-11": part11Pack }),
      }),
    ).rejects.toBeInstanceOf(PackParameterError);
  });

  it("throws on enum value mismatch", async () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: {
        name: "T",
        slug: "t",
        version: v,
        compliancePacks: ["21-cfr-part-11"],
        compliancePackParameters: {
          "21-cfr-part-11": {
            signatureMethod: "fingerprint",
            signatureMeaningStatement: { en: "I approve" },
          },
        },
      },
    };
    await expect(
      resolveCompliancePacks(m, {
        registry: registryFrom({ "21-cfr-part-11": part11Pack }),
      }),
    ).rejects.toBeInstanceOf(PackParameterError);
  });

  it("throws when integer below minimum", async () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: {
        name: "T",
        slug: "t",
        version: v,
        compliancePacks: ["21-cfr-part-11"],
        compliancePackParameters: {
          "21-cfr-part-11": {
            auditRetentionYears: 5,
            signatureMeaningStatement: { en: "I approve" },
          },
        },
      },
    };
    await expect(
      resolveCompliancePacks(m, {
        registry: registryFrom({ "21-cfr-part-11": part11Pack }),
      }),
    ).rejects.toBeInstanceOf(PackParameterError);
  });

  it("throws on wrong primitive type for a string parameter", async () => {
    const stringPack: CompliancePack = {
      meta: {
        id: "s",
        title: "S",
        version: "1.0.0",
        parameters: { label: { type: "string", required: true } },
      },
      contributions: {},
    };
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: {
        name: "T",
        slug: "t",
        version: v,
        compliancePacks: ["s"],
        compliancePackParameters: { s: { label: 42 } },
      },
    };
    await expect(
      resolveCompliancePacks(m, { registry: registryFrom({ s: stringPack }) }),
    ).rejects.toBeInstanceOf(PackParameterError);
  });
});

describe("resolveCompliancePacks — end-to-end with validateManifest", () => {
  it("the merged manifest passes validateManifest", async () => {
    const m: Manifest = {
      manifestVersion: "1.0",
      meta: {
        name: "T",
        slug: "t",
        version: v,
        compliancePacks: ["21-cfr-part-11"],
        compliancePackParameters: {
          "21-cfr-part-11": { signatureMeaningStatement: { en: "I approve" } },
        },
      },
      entities: [
        { name: "Prescription", fields: [{ name: "qty", type: { kind: "integer" } }] },
      ],
    };
    const augmented = await resolveCompliancePacks(m, {
      registry: registryFrom({ "21-cfr-part-11": part11Pack }),
    });
    const { validateManifest } = await import("@crossengin/kernel/manifest");
    expect(() => validateManifest(augmented)).not.toThrow();
  });
});
