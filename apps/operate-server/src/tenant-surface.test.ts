import type { Manifest } from "@crossengin/kernel/manifest";
import type { PackInstallation } from "@crossengin/marketplace";
import { describe, expect, it } from "vitest";

import {
  BUILTIN_PACK_MARKETPLACE_IDS,
  buildBuiltinPackResolver,
  resolveTenantSurface,
  type PackManifestResolver,
} from "./tenant-surface.js";

function inst(packId: string, status: PackInstallation["status"]): PackInstallation {
  return {
    id: `inst-${packId}`,
    tenantId: "00000000-0000-4000-8000-000000000001",
    packId,
    installedVersion: status === "installed" ? "1.0.0" : null,
    pinnedVersion: null,
    status,
    updatePolicy: "manual",
    config: {},
    permissionGrants: [],
    requestedAt: "2026-06-11T00:00:00.000Z",
    requestedBy: "00000000-0000-4000-8000-0000000000aa",
    installedAt: status === "installed" ? "2026-06-11T00:05:00.000Z" : null,
    installedBy: status === "installed" ? "00000000-0000-4000-8000-0000000000aa" : null,
    lastUpdatedAt: null,
    uninstalledAt: null,
    uninstalledBy: null,
  } as unknown as PackInstallation;
}

const FAKE_RESOLVER: PackManifestResolver = {
  async resolve(packId) {
    if (packId === "acme.crm.sales") {
      return {
        manifestVersion: "1.0",
        meta: { name: "CRM", slug: "acme/crm", version: "1.0.0" },
        entities: [{ name: "Lead" }, { name: "Opportunity" }],
        views: { "lead.list": {} },
      } as unknown as Manifest;
    }
    return null;
  },
};

describe("resolveTenantSurface", () => {
  it("composes only installed packs into the entity/view union", async () => {
    const surface = await resolveTenantSurface(
      [inst("acme.crm.sales", "installed"), inst("acme.other", "installing")],
      FAKE_RESOLVER,
    );
    expect(surface.packs).toHaveLength(1); // the 'installing' pack is not live
    expect(surface.packs[0]).toMatchObject({ packId: "acme.crm.sales", resolved: true });
    expect(surface.entities).toEqual(["Lead", "Opportunity"]);
    expect(surface.views).toEqual(["lead.list"]);
  });

  it("marks an unknown pack id as unresolved (no entities)", async () => {
    const surface = await resolveTenantSurface([inst("unknown.pack.x", "installed")], FAKE_RESOLVER);
    expect(surface.packs[0]).toMatchObject({ packId: "unknown.pack.x", resolved: false, entities: [] });
    expect(surface.entities).toEqual([]);
  });

  it("dedupes + sorts entity names across packs", async () => {
    const dupResolver: PackManifestResolver = {
      async resolve() {
        return { manifestVersion: "1.0", meta: { name: "X", slug: "x/y", version: "1.0.0" }, entities: [{ name: "B" }, { name: "A" }] } as unknown as Manifest;
      },
    };
    const surface = await resolveTenantSurface([inst("a.b.c", "installed"), inst("a.b.d", "installed")], dupResolver);
    expect(surface.entities).toEqual(["A", "B"]);
  });
});

describe("buildBuiltinPackResolver", () => {
  it("resolves a built-in marketplace pack id to its merged manifest", async () => {
    const r = buildBuiltinPackResolver();
    const m = await r.resolve("crossengin.erp.education", null);
    const names = (m?.entities ?? []).map((e) => e.name);
    expect(names).toContain("Course"); // education
    expect(names).toContain("Account"); // core lineage
  });

  it("returns null for an unknown pack id", async () => {
    expect(await buildBuiltinPackResolver().resolve("third.party.thing", null)).toBeNull();
  });

  it("maps the six built-in verticals", () => {
    expect(Object.keys(BUILTIN_PACK_MARKETPLACE_IDS).sort()).toEqual([
      "crossengin.erp.construction",
      "crossengin.erp.core",
      "crossengin.erp.education",
      "crossengin.erp.grocery",
      "crossengin.erp.healthcare",
      "crossengin.erp.retail",
    ]);
  });
});
