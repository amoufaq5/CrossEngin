import { resolveManifest, type Manifest, type ManifestRegistry } from "@crossengin/kernel/manifest";
import { ERP_CORE_PACK_SLUG, buildErpCorePack } from "@crossengin/pack-erp-core";
import { buildErpHealthcarePack } from "@crossengin/pack-erp-healthcare";
import { buildErpRetailPack } from "@crossengin/pack-erp-retail";
import { describe, expect, it } from "vitest";

import {
  compileCalendarModel,
  compileDetailModel,
  compileFormModel,
  compileKanbanModel,
  compileTableModel,
  compileWebApp,
  entityTitle,
  humanize,
  webFieldType,
} from "./compile.js";
import {
  CalendarModelSchema,
  DetailModelSchema,
  FormModelSchema,
  KanbanModelSchema,
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

  it("lists only table/detail/form when no kanban/calendar view is declared", () => {
    const app = compileWebApp(retail, MANAGER);
    expect(app.nav.find((n) => n.entity === "Product")?.views).toEqual(["table", "detail", "form"]);
  });
});

/** Augments a resolved manifest with extra view declarations (the packs ship only ListViews). */
function withViews(base: Manifest, views: Record<string, unknown>): Manifest {
  return { ...base, views: { ...(base.views ?? {}), ...views } } as unknown as Manifest;
}

const PRODUCT_KANBAN = {
  productBoard: {
    kind: "kanban",
    entity: "Product",
    label: { en: "Product board" },
    stateField: "status",
    columns: [
      { state: "active", label: { en: "Active" }, color: "#0a0", wipLimit: 50 },
      { state: "discontinued", label: { en: "Discontinued" } },
    ],
    cardFields: ["sku", "name", "unit_price", "unit_cost"],
    allowedTransitions: [],
    groupBy: "category",
  },
};

const SALES_ORDER_CALENDAR = {
  orderCalendar: {
    kind: "calendar",
    entity: "SalesOrder",
    label: { en: "Order calendar" },
    startField: "placed_at",
    titleField: "order_number",
    colorField: "state",
    defaultView: "month",
  },
};

describe("compileKanbanModel", () => {
  const m = withViews(retail, PRODUCT_KANBAN);

  it("returns null when the entity has no kanban view (no fallback)", () => {
    expect(compileKanbanModel(retail, "Product", MANAGER)).toBeNull();
  });

  it("compiles a schema-valid board with columns + state field", () => {
    const board = compileKanbanModel(m, "Product", MANAGER);
    expect(board).not.toBeNull();
    expect(() => KanbanModelSchema.parse(board)).not.toThrow();
    expect(board!.stateField).toBe("status");
    expect(board!.columns.map((c) => c.state)).toEqual(["active", "discontinued"]);
    expect(board!.columns[0]).toMatchObject({ label: "Active", color: "#0a0", wipLimit: 50 });
    expect(board!.groupBy).toBe("category");
  });

  it("a manager's card fields include the classified unit_cost", () => {
    const board = compileKanbanModel(m, "Product", MANAGER);
    expect(board!.cardFields.map((f) => f.field)).toContain("unit_cost");
  });

  it("a cashier's card fields OMIT unit_cost (redaction), keeping the board", () => {
    const board = compileKanbanModel(m, "Product", CASHIER);
    expect(board).not.toBeNull();
    expect(board!.cardFields.map((f) => f.field)).not.toContain("unit_cost");
    expect(board!.cardFields.map((f) => f.field)).toContain("sku");
  });

  it("withholds the whole board (null) when the state field itself is unreadable — fail-closed", () => {
    const leaky = withViews(retail, {
      productBoard: { ...PRODUCT_KANBAN.productBoard, stateField: "unit_cost" },
    });
    expect(compileKanbanModel(leaky, "Product", MANAGER)).not.toBeNull();
    expect(compileKanbanModel(leaky, "Product", CASHIER)).toBeNull();
  });

  it("omits an unreadable groupBy field", () => {
    const grouped = withViews(retail, {
      productBoard: { ...PRODUCT_KANBAN.productBoard, groupBy: "unit_cost" },
    });
    expect(compileKanbanModel(grouped, "Product", MANAGER)!.groupBy).toBe("unit_cost");
    expect(compileKanbanModel(grouped, "Product", CASHIER)!.groupBy).toBeUndefined();
  });

  it("throws on an unknown entity", () => {
    expect(() => compileKanbanModel(m, "Nope", MANAGER)).toThrow(/unknown entity/);
  });
});

describe("compileCalendarModel", () => {
  const m = withViews(retail, SALES_ORDER_CALENDAR);

  it("returns null when the entity has no calendar view", () => {
    expect(compileCalendarModel(retail, "SalesOrder", MANAGER)).toBeNull();
  });

  it("compiles a schema-valid calendar with start/title/color + default view", () => {
    const cal = compileCalendarModel(m, "SalesOrder", MANAGER);
    expect(cal).not.toBeNull();
    expect(() => CalendarModelSchema.parse(cal)).not.toThrow();
    expect(cal!.startField).toBe("placed_at");
    expect(cal!.titleField).toBe("order_number");
    expect(cal!.colorField).toBe("state");
    expect(cal!.defaultView).toBe("month");
  });

  it("omits an unreadable colorField but keeps the calendar", () => {
    const piiColor = withViews(retail, {
      orderCalendar: { ...SALES_ORDER_CALENDAR.orderCalendar, colorField: "customer_email" },
    });
    const cal = compileCalendarModel(piiColor, "SalesOrder", CASHIER);
    expect(cal).not.toBeNull();
    expect(cal!.colorField).toBeUndefined();
  });

  it("withholds the calendar (null) when the title field is unreadable — fail-closed", () => {
    const leaky = withViews(retail, {
      orderCalendar: { ...SALES_ORDER_CALENDAR.orderCalendar, titleField: "customer_email" },
    });
    expect(compileCalendarModel(leaky, "SalesOrder", CASHIER)).toBeNull();
  });
});

describe("compileWebApp — kanban/calendar nav exposure", () => {
  it("adds kanban to the entity's nav when a board compiles for the viewer", () => {
    const app = compileWebApp(withViews(retail, PRODUCT_KANBAN), MANAGER);
    expect(app.nav.find((n) => n.entity === "Product")?.views).toContain("kanban");
  });

  it("drops kanban from the nav when the board is withheld for redaction", () => {
    const leaky = withViews(retail, {
      productBoard: { ...PRODUCT_KANBAN.productBoard, stateField: "unit_cost" },
    });
    expect(compileWebApp(leaky, MANAGER).nav.find((n) => n.entity === "Product")?.views).toContain("kanban");
    expect(compileWebApp(leaky, CASHIER).nav.find((n) => n.entity === "Product")?.views).not.toContain("kanban");
  });

  it("adds calendar to the entity's nav when a calendar compiles", () => {
    const app = compileWebApp(withViews(retail, SALES_ORDER_CALENDAR), MANAGER);
    expect(app.nav.find((n) => n.entity === "SalesOrder")?.views).toContain("calendar");
  });
});
