import { resolveManifest, type Manifest, type ManifestRegistry } from "@crossengin/kernel/manifest";
import { ERP_CORE_PACK_SLUG, buildErpCorePack } from "@crossengin/pack-erp-core";
import { buildErpRetailPack } from "@crossengin/pack-erp-retail";
import type { Entity } from "@crossengin/types/meta-schema";
import { describe, expect, it } from "vitest";

import { EntityFieldResolver, entityFields, redactRecord } from "./viewer.js";

const registry: ManifestRegistry = {
  async getManifest(id: string): Promise<Manifest | null> {
    return id === ERP_CORE_PACK_SLUG ? buildErpCorePack() : null;
  },
};
const retail = await resolveManifest(buildErpRetailPack(), { registry });

function productEntity(): Entity {
  const e = (retail.entities ?? []).find((x) => x.name === "Product");
  if (e === undefined) throw new Error("Product entity missing from fixture");
  return e;
}

describe("EntityFieldResolver — classification redaction bridge", () => {
  it("a privileged role (store_manager) can read the classified unit_cost", () => {
    const resolver = new EntityFieldResolver(retail, "Product", { roles: ["store_manager"] });
    const access = resolver.resolve(entityFields(productEntity()));
    expect(access.get("unit_cost")?.read).toBe(true);
  });

  it("an unprivileged role (cashier) cannot read the classified unit_cost", () => {
    const resolver = new EntityFieldResolver(retail, "Product", { roles: ["cashier"] });
    const access = resolver.resolve(entityFields(productEntity()));
    expect(access.get("unit_cost")?.read).toBe(false);
    // a non-sensitive field stays readable for everyone
    expect(access.get("sku")?.read).toBe(true);
  });

  it("an unknown role is treated as unprivileged (fail-closed, no throw)", () => {
    const resolver = new EntityFieldResolver(retail, "Product", { roles: ["totally_unknown"] });
    const access = resolver.resolve(entityFields(productEntity()));
    expect(access.get("unit_cost")?.read).toBe(false);
    expect(access.get("sku")?.read).toBe(true);
  });

  it("an empty role list is unprivileged", () => {
    const resolver = new EntityFieldResolver(retail, "Product", { roles: [] });
    const access = resolver.resolve(entityFields(productEntity()));
    expect(access.get("unit_cost")?.read).toBe(false);
  });

  it("a readable field is writable only when the write mask allows it", () => {
    const resolver = new EntityFieldResolver(retail, "Product", { roles: ["store_manager"] });
    const access = resolver.resolve(entityFields(productEntity()));
    expect(access.get("sku")?.write).toBe(true);
    // a redacted field is never writable
    const cashier = new EntityFieldResolver(retail, "Product", { roles: ["cashier"] });
    const cashierAccess = cashier.resolve(entityFields(productEntity()));
    expect(cashierAccess.get("unit_cost")?.write).toBe(false);
  });
});

describe("redactRecord", () => {
  const access = new Map([
    ["unit_cost", { read: false, write: false }],
    ["sku", { read: true, write: true }],
  ]);

  it("drops read=false fields but keeps id + readable fields", () => {
    const out = redactRecord({ id: "p1", sku: "ABC", unit_cost: 4.2, name: "Widget" }, access);
    expect(out).toEqual({ id: "p1", sku: "ABC", name: "Widget" });
    expect("unit_cost" in out).toBe(false);
  });

  it("keeps a field absent from the access map (non-classified extras)", () => {
    const out = redactRecord({ id: "p1", extra: "kept" }, access);
    expect(out).toEqual({ id: "p1", extra: "kept" });
  });
});
