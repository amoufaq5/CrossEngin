import { readFileSync } from "node:fs";

import { resolveManifest, type Manifest, type ManifestRegistry } from "@crossengin/kernel/manifest";
import { buildErpCorePack, ERP_CORE_PACK_SLUG } from "@crossengin/pack-erp-core";
import { buildErpRetailPack } from "@crossengin/pack-erp-retail";
import { describe, expect, it } from "vitest";

import { lifecycleStateField } from "./list-query.js";
import {
  LOCKED_DOCUMENT_SPECS,
  lockedDocumentConfigs,
  lockedDocumentGuardsFor,
  lockedDocumentSpec,
  POSTED_ENTRY_ENTITY,
  STATE_LOCKED_ENTITIES,
} from "./locked-documents.js";
import { InMemoryEntityStore } from "./store.js";
import type { WriteGuardInput } from "./write-guards.js";

const TENANT = "11111111-1111-1111-1111-111111111111";
const CORE = buildErpCorePack();

function namesOf(m: Manifest): ReadonlySet<string> {
  return new Set((m.entities ?? []).map((e) => e.name));
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("LOCKED_DOCUMENT_SPECS is the one list compile wires (ADR-0480)", () => {
  it("names each entity once", () => {
    const entities = LOCKED_DOCUMENT_SPECS.map((s) => s.entity);
    expect(new Set(entities).size).toBe(entities.length);
  });

  it("is exactly the set of entities compile.ts asks lockedDocumentGuardsFor about, in both directions", () => {
    const src = stripComments(readFileSync(new URL("./compile.ts", import.meta.url), "utf8"));
    const wired = [...src.matchAll(/lockedDocumentGuardsFor\(manifest, names, "([A-Za-z]+)"\)/g)].map((m) => m[1]);
    expect(wired.length).toBeGreaterThanOrEqual(8);
    expect([...new Set(wired)].sort()).toEqual(LOCKED_DOCUMENT_SPECS.map((s) => s.entity).sort());
    expect(wired.length).toBe(new Set(wired).size);
  });

  it("derives STATE_LOCKED_ENTITIES: every spec that may read `state`, plus the posted entry", () => {
    expect([...STATE_LOCKED_ENTITIES].sort()).toEqual(
      ["Bill", "Invoice", "JournalEntry", "Payment", "PurchaseOrder", "SalesOrder", "TaxReturn", "WhtCertificate"].sort(),
    );
    expect(STATE_LOCKED_ENTITIES).toContain(POSTED_ENTRY_ENTITY);
    expect(STATE_LOCKED_ENTITIES).not.toContain("FiscalPeriod");
  });

  it("throws for an entity it does not declare rather than answering no lock", () => {
    expect(() => lockedDocumentSpec("Expense")).toThrow(RangeError);
  });
});

const registry: ManifestRegistry = {
  async getManifest(id: string): Promise<Manifest | null> {
    return id === ERP_CORE_PACK_SLUG ? buildErpCorePack() : null;
  },
};
const RETAIL = await resolveManifest(buildErpRetailPack(), { registry });

describe("each spec's guards on resolved packs", () => {

  for (const [label, manifest] of [
    ["erp-core", CORE],
    ["erp-retail", RETAIL],
  ] as const) {
    for (const spec of LOCKED_DOCUMENT_SPECS) {
      const names = namesOf(manifest);
      if (!names.has(spec.entity)) continue;
      const configs = lockedDocumentConfigs(manifest, names, spec);
      it(`${label}: ${spec.entity} refuses a delete in every locked state, and a line write under a locked parent`, async () => {
        const guards = lockedDocumentGuardsFor(manifest, names, spec.entity);
        expect(guards.length).toBe(configs.length);
        if (configs.length === 0) return;
        const stateField = configs[0]!.stateField ?? "state";
        if (spec.stateFieldSource !== "state") expect(stateField).toBe(lifecycleStateField(manifest, spec.entity) ?? "state");
        const store = new InMemoryEntityStore();
        for (const state of spec.lockedStates) {
          const del: WriteGuardInput = {
            operation: "delete",
            entity: spec.entity,
            tenantId: TENANT,
            id: "doc",
            before: { [stateField]: state },
            after: {},
            store,
          };
          const results = await Promise.all(guards.map((g) => g(del)));
          expect(results.every((r) => r?.error === spec.lockedError)).toBe(true);
        }
        for (const child of spec.children.filter((c) => names.has(c.entity))) {
          const parent = await store.create(TENANT, spec.entity, { [stateField]: spec.lockedStates[0]! });
          const write: WriteGuardInput = {
            operation: "create",
            entity: child.entity,
            tenantId: TENANT,
            id: null,
            before: null,
            after: { [child.parentField]: parent["id"] },
            store,
          };
          const refused = (await Promise.all(guards.map((g) => g(write)))).filter((r) => r !== null);
          expect(refused.map((r) => r?.status)).toEqual([422]);
        }
      });
    }
  }

  it("guards retail's OrderLine under the sales order it belongs to", () => {
    const configs = lockedDocumentConfigs(RETAIL, namesOf(RETAIL), lockedDocumentSpec("SalesOrder"));
    const children = configs.map((c) => c.childEntity);
    expect(children).toContain("OrderLine");
    expect(children.sort()).toEqual(["OrderLine", "SalesOrderLine"].filter((e) => namesOf(RETAIL).has(e)).sort());
  });

  it("names a remedy only where a correction leaves the state (no `void` hint on a paid invoice)", () => {
    const [invoice] = lockedDocumentConfigs(CORE, namesOf(CORE), lockedDocumentSpec("Invoice"));
    expect(invoice?.hintByState?.["sent"]).toContain("void");
    expect(invoice?.hintByState?.["paid"]).toBeUndefined();
  });

  it("yields nothing for an entity a manifest does not declare", () => {
    const bare: Manifest = { ...CORE, entities: (CORE.entities ?? []).filter((e) => e.name !== "Bill" && e.name !== "BillLine") };
    expect(lockedDocumentGuardsFor(bare, namesOf(bare), "Bill")).toEqual([]);
  });
});
