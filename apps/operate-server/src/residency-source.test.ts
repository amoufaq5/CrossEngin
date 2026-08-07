import { buildProfileFromTemplate } from "@crossengin/residency";
import { describe, expect, it } from "vitest";

import { loadResidencyDirectory } from "./residency-source.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

describe("loadResidencyDirectory", () => {
  it("parses a residency file into a directory", () => {
    const profile = buildProfileFromTemplate("eu-only", { establishedAt: "2026-01-01T00:00:00.000Z" });
    const dir = loadResidencyDirectory(JSON.stringify({ tenants: [{ tenantId: TENANT, profile }] }));
    expect(dir.resolve(TENANT)?.primaryRegion).toBe("eu-central");
    expect(dir.resolve("absent")).toBeNull();
  });

  it("rejects a malformed profile", () => {
    expect(() =>
      loadResidencyDirectory(JSON.stringify({ tenants: [{ tenantId: TENANT, profile: { primaryRegion: "eu-central" } }] })),
    ).toThrow();
  });
});
