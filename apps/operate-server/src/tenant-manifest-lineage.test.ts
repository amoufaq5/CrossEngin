import {
  manifestHash,
  resolveManifest,
  tryValidateManifest,
  type Manifest,
} from "@crossengin/kernel/manifest";
import { ERP_CORE_PACK_SLUG, buildErpCorePack } from "@crossengin/pack-erp-core";
import { describe, expect, it } from "vitest";

import {
  TENANT_PARENT_POLICY,
  buildTenantManifestLineage,
  buildTenantManifestRegistry,
  permittedParentSentence,
  permittedParentSlug,
  type TenantManifestParent,
} from "./tenant-manifest-lineage.js";

const BOOT = buildErpCorePack();
const PARENT: TenantManifestParent = { slug: ERP_CORE_PACK_SLUG, manifest: BOOT };

function child(over: Partial<Manifest["meta"]> = {}, entityName = "Widget"): Manifest {
  return {
    manifestVersion: "1.0",
    meta: {
      name: "Acme",
      slug: "tenant/acme",
      version: "2.1.0",
      extends: [ERP_CORE_PACK_SLUG],
      ...over,
    },
    entities: [{ name: entityName, fields: [{ name: "label", type: { kind: "text" } }] }],
    roles: { widget_clerk: { name: "widget_clerk" } },
    permissions: { [entityName]: { list: { roles: ["widget_clerk"] }, read: { roles: ["widget_clerk"] } } },
  };
}

describe("TENANT_PARENT_POLICY", () => {
  it("names the one policy in force", () => {
    expect(TENANT_PARENT_POLICY).toBe("deployment_boot_manifest_only");
  });
});

describe("buildTenantManifestRegistry", () => {
  it("answers the parent manifest for the permitted slug", async () => {
    const registry = buildTenantManifestRegistry(PARENT);
    expect(await registry.getManifest(ERP_CORE_PACK_SLUG)).toBe(BOOT);
  });

  it("answers null for every other id", async () => {
    const registry = buildTenantManifestRegistry(PARENT);
    for (const id of ["operate-erp/retail", "tenant/acme", "", ERP_CORE_PACK_SLUG.toUpperCase()]) {
      expect(await registry.getManifest(id)).toBeNull();
    }
  });

  it("matches exactly — no prefix or suffix generosity", async () => {
    const registry = buildTenantManifestRegistry(PARENT);
    expect(await registry.getManifest("operate-erp")).toBeNull();
    expect(await registry.getManifest("operate-erp/core/extra")).toBeNull();
    expect(await registry.getManifest(` ${ERP_CORE_PACK_SLUG}`)).toBeNull();
  });

  it("answers null for every id when the deployment registers no parent", async () => {
    const registry = buildTenantManifestRegistry(null);
    expect(await registry.getManifest(ERP_CORE_PACK_SLUG)).toBeNull();
    expect(await registry.getManifest("anything")).toBeNull();
  });

  it("honours a slug that differs from the manifest's own, which is what parentId is for", async () => {
    const aliased = buildTenantManifestRegistry({ slug: "deployment/boot", manifest: BOOT });
    expect(await aliased.getManifest("deployment/boot")).toBe(BOOT);
    expect(await aliased.getManifest(ERP_CORE_PACK_SLUG)).toBeNull();
    const resolved = await resolveManifest(child({ extends: ["deployment/boot"] }), {
      registry: aliased,
    });
    expect(resolved.meta.manifestResolution?.parents).toEqual([
      expect.objectContaining({ slug: ERP_CORE_PACK_SLUG, parentId: "deployment/boot" }),
    ]);
  });
});

describe("permittedParentSlug", () => {
  it("is the parent's slug, and null where there is no parent", () => {
    expect(permittedParentSlug(PARENT)).toBe(ERP_CORE_PACK_SLUG);
    expect(permittedParentSlug(null)).toBeNull();
  });

  it("is the registry's own key and not the manifest's slug, for an aliased parent", () => {
    expect(permittedParentSlug({ slug: "deployment/boot", manifest: BOOT })).toBe("deployment/boot");
  });
});

describe("buildTenantManifestLineage", () => {
  it("derives both halves from one source so they cannot disagree", async () => {
    const lineage = buildTenantManifestLineage(PARENT);
    expect(lineage.permittedParentSlug).toBe(ERP_CORE_PACK_SLUG);
    expect(await lineage.registry.getManifest(lineage.permittedParentSlug ?? "")).toBe(BOOT);
  });

  it("carries a null permitted slug alongside a registry that holds nothing", async () => {
    const lineage = buildTenantManifestLineage(null);
    expect(lineage.permittedParentSlug).toBeNull();
    expect(await lineage.registry.getManifest(ERP_CORE_PACK_SLUG)).toBeNull();
  });
});

describe("permittedParentSentence", () => {
  it("names the permitted slug, which the kernel's refusal cannot", () => {
    expect(permittedParentSentence(ERP_CORE_PACK_SLUG)).toBe(
      "this deployment permits extending only 'operate-erp/core'",
    );
  });

  it("says no parent is extensible rather than rendering null", () => {
    const sentence = permittedParentSentence(null);
    expect(sentence).not.toContain("null");
    expect(sentence).toContain("no manifest a tenant may extend");
  });
});

describe("resolving a tenant manifest against the registry", () => {
  it("composes the union of the child's and the parent's entities and roles", async () => {
    const resolved = await resolveManifest(child(), { registry: buildTenantManifestRegistry(PARENT) });
    expect(resolved.entities?.length).toBe((BOOT.entities?.length ?? 0) + 1);
    expect(resolved.entities?.some((e) => e.name === "Widget")).toBe(true);
    expect(resolved.entities?.some((e) => e.name === "Invoice")).toBe(true);
    expect(Object.keys(resolved.roles ?? {})).toContain("widget_clerk");
    expect(Object.keys(resolved.roles ?? {})).toContain("erp_admin");
    expect(Object.keys(resolved.workflows ?? {}).length).toBe(Object.keys(BOOT.workflows ?? {}).length);
  });

  it("keeps the child's own slug and version, not the parent's", async () => {
    const resolved = await resolveManifest(child(), { registry: buildTenantManifestRegistry(PARENT) });
    expect(resolved.meta.slug).toBe("tenant/acme");
    expect(resolved.meta.version).toBe("2.1.0");
  });

  it("strips meta.extends, so re-resolution costs zero lookups and cannot loop", async () => {
    const ids: string[] = [];
    const counting = {
      async getManifest(id: string): Promise<Manifest | null> {
        ids.push(id);
        return buildTenantManifestRegistry(PARENT).getManifest(id);
      },
    };
    const once = await resolveManifest(child(), { registry: counting });
    expect(ids).toEqual([ERP_CORE_PACK_SLUG]);
    expect(once.meta.extends).toBeUndefined();
    ids.length = 0;
    const twice = await resolveManifest(once, { registry: counting });
    expect(ids).toEqual([]);
    expect(manifestHash(twice)).toBe(manifestHash(once));
  });

  it("re-resolving the boot manifest itself is a no-op, which is why one entry suffices", async () => {
    const ids: string[] = [];
    const counting = {
      async getManifest(id: string): Promise<Manifest | null> {
        ids.push(id);
        return null;
      },
    };
    const again = await resolveManifest(BOOT, { registry: counting });
    expect(ids).toEqual([]);
    expect(manifestHash(again)).toBe(manifestHash(BOOT));
  });

  it("leaves a manifest with no extends content-identical", async () => {
    const flat: Manifest = {
      manifestVersion: "1.0",
      meta: { name: "Flat", slug: "tenant/flat", version: "1.0.0" },
      entities: [{ name: "W", fields: [{ name: "a", type: { kind: "text" } }] }],
    };
    const resolved = await resolveManifest(flat, { registry: buildTenantManifestRegistry(PARENT) });
    expect(JSON.stringify(resolved)).toBe(JSON.stringify(flat));
    expect(resolved.meta.manifestResolution).toBeUndefined();
  });

  it("stamps manifestResolution naming the parent's slug, version and hash", async () => {
    const resolved = await resolveManifest(child(), { registry: buildTenantManifestRegistry(PARENT) });
    expect(resolved.meta.manifestResolution?.parents).toEqual([
      {
        slug: ERP_CORE_PACK_SLUG,
        version: BOOT.meta.version,
        hash: manifestHash(BOOT),
        parentId: ERP_CORE_PACK_SLUG,
      },
    ]);
  });

  it("throws UnknownParentManifestError for a parent this deployment does not serve", async () => {
    await expect(
      resolveManifest(child({ extends: ["operate-erp/retail"] }), {
        registry: buildTenantManifestRegistry(PARENT),
      }),
    ).rejects.toMatchObject({ name: "UnknownParentManifestError" });
  });

  it("throws UnknownParentManifestError for every extends when no parent is registered", async () => {
    await expect(
      resolveManifest(child(), { registry: buildTenantManifestRegistry(null) }),
    ).rejects.toMatchObject({ name: "UnknownParentManifestError" });
  });

  it("throws ExtendsCycleError when the child's own slug collides with the parent's", async () => {
    await expect(
      resolveManifest(child({ slug: ERP_CORE_PACK_SLUG }), {
        registry: buildTenantManifestRegistry(PARENT),
      }),
    ).rejects.toMatchObject({ name: "ExtendsCycleError" });
  });

  it("throws UndeclaredEntityOverrideError for a collision the child did not declare", async () => {
    await expect(
      resolveManifest(child({}, "Invoice"), { registry: buildTenantManifestRegistry(PARENT) }),
    ).rejects.toMatchObject({ name: "UndeclaredEntityOverrideError", entity: "Invoice" });
  });

  it("accepts a declared override of an inherited entity", async () => {
    const declared: Manifest = {
      ...child(),
      entities: [
        {
          name: "Currency",
          overrides: true,
          fields: [
            { name: "code", type: { kind: "text" }, required: true },
            { name: "label", type: { kind: "text" } },
          ],
        },
      ],
      permissions: { Currency: { list: { roles: ["widget_clerk"] }, read: { roles: ["widget_clerk"] } } },
    };
    const resolved = await resolveManifest(declared, { registry: buildTenantManifestRegistry(PARENT) });
    const currency = resolved.entities?.find((e) => e.name === "Currency");
    expect(currency?.fields.map((f) => f.name)).toEqual(["code", "label"]);
    expect(resolved.entities?.length).toBe(BOOT.entities?.length);
  });

  it("a child referencing a parent's entity fails standalone and validates once resolved", async () => {
    const referencing: Manifest = {
      ...child(),
      entities: [
        {
          name: "Widget",
          fields: [
            { name: "label", type: { kind: "text" } },
            { name: "currency_id", type: { kind: "uuid" } },
          ],
        },
      ],
      relations: [
        { kind: "many_to_one", from: "Widget", to: "Currency", field: "currency_id", onDelete: "restrict" },
      ],
    };
    const standalone = tryValidateManifest(referencing);
    expect(standalone.ok).toBe(false);
    expect(standalone.ok ? "" : standalone.errors.map((e) => e.message).join(" ")).toMatch(
      /unknown entity 'Currency'/,
    );
    const resolved = await resolveManifest(referencing, {
      registry: buildTenantManifestRegistry(PARENT),
    });
    expect(tryValidateManifest(resolved).ok).toBe(true);
  });
});
