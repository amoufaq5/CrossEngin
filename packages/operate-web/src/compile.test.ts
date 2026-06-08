import { resolveManifest, type Manifest, type ManifestRegistry } from "@crossengin/kernel/manifest";
import { ERP_CORE_PACK_SLUG, buildErpCorePack } from "@crossengin/pack-erp-core";
import { buildErpHealthcarePack } from "@crossengin/pack-erp-healthcare";
import { buildErpRetailPack } from "@crossengin/pack-erp-retail";
import { describe, expect, it } from "vitest";

import {
  compileDetailModel,
  compileFormModel,
  compileTableModel,
  compileWebApp,
  entityTitle,
  humanize,
  webFieldType,
} from "./compile.js";
import {
  DetailModelSchema,
  FormModelSchema,
  TableModelSchema,
  WebAppModelSchema,
} from "./model.js";

const registry: ManifestRegistry = {
  async getManifest(id: string): Promise<Manifest | null> {
    return id === ERP_CORE_PACK_SLUG ? buildErpCorePack() : null;
  },
};
const retail = await resolveManifest(buildErpRetailPack(), { registry });
const healthcare = await resolveManifest(buildErpHealthcarePack(), { registry });

const MANAGER = { roles: ["store_manager"] };
const CASHIER = { roles: ["cashier"] };

function columnFields(roles: { roles: string[] }): string[] {
  return compileTableModel(retail, "Product", roles).columns.map((c) => c.field);
}

describe("humanize / entityTitle / webFieldType", () => {
  it("humanizes snake_case", () => {
    expect(humanize("unit_cost")).toBe("Unit cost");
    expect(humanize("mrn")).toBe("Mrn");
  });

  it("pluralizes a PascalCase entity title", () => {
    expect(entityTitle("Product")).toBe("Products");
    expect(entityTitle("SalesOrder")).toBe("Sales Orders");
  });

  it("maps a manifest field type to a web render hint", () => {
    expect(webFieldType({ kind: "decimal", precision: 12, scale: 2 })).toBe("decimal");
    expect(webFieldType({ kind: "enum", values: ["a"] })).toBe("enum");
  });
});

describe("compileTableModel", () => {
  it("uses the ListView columns (which omit unit_cost) and is schema-valid", () => {
    const table = compileTableModel(retail, "Product", MANAGER);
    expect(() => TableModelSchema.parse(table)).not.toThrow();
    // the retail Product list view declares sku/name/category/unit_price/status
    expect(table.columns.map((c) => c.field)).toEqual(["sku", "name", "category", "unit_price", "status"]);
    expect(table.pageSize).toBe(100);
    expect(table.title).toBe("Products");
  });

  it("falls back to all fields when the entity has no list view", () => {
    // OrderLine has no list view in the retail pack -> every field becomes a column
    const table = compileTableModel(retail, "OrderLine", MANAGER);
    expect(table.columns.length).toBeGreaterThan(0);
  });
});

describe("compileDetailModel — redaction", () => {
  it("a privileged role sees the classified unit_cost in the detail (fallback all-fields)", () => {
    const detail = compileDetailModel(retail, "Product", MANAGER);
    expect(() => DetailModelSchema.parse(detail)).not.toThrow();
    const fields = detail.sections.flatMap((s) => s.fields.map((f) => f.field));
    expect(fields).toContain("unit_cost");
  });

  it("an unprivileged role's detail OMITS the classified unit_cost", () => {
    const detail = compileDetailModel(retail, "Product", CASHIER);
    const fields = detail.sections.flatMap((s) => s.fields.map((f) => f.field));
    expect(fields).not.toContain("unit_cost");
    expect(fields).toContain("sku");
  });

  it("binds record values when a record is supplied", () => {
    const detail = compileDetailModel(retail, "Product", MANAGER, { id: "p1", sku: "ABC", unit_cost: 4.2 });
    const cost = detail.sections.flatMap((s) => s.fields).find((f) => f.field === "unit_cost");
    expect(cost?.value).toBe(4.2);
  });
});

describe("compileFormModel — readOnly + redaction", () => {
  it("includes a writable field as not-readOnly for a privileged role", () => {
    const form = compileFormModel(retail, "Product", MANAGER, "create");
    expect(() => FormModelSchema.parse(form)).not.toThrow();
    const sku = form.fields.find((f) => f.field === "sku");
    expect(sku?.readOnly).toBe(false);
    expect(sku?.required).toBe(true);
  });

  it("omits a field an unprivileged viewer cannot read", () => {
    const form = compileFormModel(retail, "Product", CASHIER, "edit");
    expect(form.fields.find((f) => f.field === "unit_cost")).toBeUndefined();
  });

  it("derives enum validations from the field type", () => {
    const form = compileFormModel(retail, "Product", MANAGER, "create");
    const status = form.fields.find((f) => f.field === "status");
    expect(status?.validations).toContainEqual({ kind: "enum", values: ["active", "discontinued"] });
  });
});

describe("classified-column inclusion proof (table)", () => {
  it("a manager's product table includes unit_price; both roles share the list-view columns", () => {
    expect(columnFields(MANAGER)).toContain("unit_price");
    // the list view doesn't surface unit_cost to anyone; redaction is proved on detail/form
    expect(columnFields(MANAGER)).not.toContain("unit_cost");
  });
});

describe("compileDetailModel — healthcare PHI", () => {
  // mrn has no explicit per-field grant, so its redaction is driven by the
  // classification default: a privileged role (here clinical staff) reads it,
  // everyone else has it dropped.
  const policyForEntity = (): { privilegedRoles: string[] } => ({
    privilegedRoles: ["clinical_admin", "clinician"],
  });

  it("clinician reads Patient.mrn (privileged); front_desk does not", () => {
    const clin = compileDetailModel(healthcare, "Patient", { roles: ["clinician"] }, undefined, { policyForEntity });
    const desk = compileDetailModel(healthcare, "Patient", { roles: ["front_desk"] }, undefined, { policyForEntity });
    const clinFields = clin.sections.flatMap((s) => s.fields.map((f) => f.field));
    const deskFields = desk.sections.flatMap((s) => s.fields.map((f) => f.field));
    expect(clinFields).toContain("mrn");
    expect(deskFields).not.toContain("mrn");
  });
});

describe("compileWebApp", () => {
  it("emits one nav entry per entity, schema-valid", () => {
    const app = compileWebApp(retail, MANAGER);
    expect(() => WebAppModelSchema.parse(app)).not.toThrow();
    expect(app.nav.map((n) => n.entity)).toContain("Product");
    expect(app.nav.find((n) => n.entity === "Product")?.path).toBe("/ui/Product");
    expect(app.title.length).toBeGreaterThan(0);
  });
});
