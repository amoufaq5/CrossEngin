import { resolveManifest, type Manifest, type ManifestRegistry } from "@crossengin/kernel/manifest";
import { ERP_CORE_PACK_SLUG, buildErpCorePack } from "@crossengin/pack-erp-core";
import { buildErpHealthcarePack } from "@crossengin/pack-erp-healthcare";
import { buildErpRetailPack } from "@crossengin/pack-erp-retail";
import { describe, expect, it } from "vitest";

import {
  compileCalendarModel,
  compileDashboardModel,
  compileDetailModel,
  compileFormModel,
  compileKanbanModel,
  compileMapModel,
  compilePivotModel,
  compileTableModel,
  compileWebApp,
  entityTitle,
  humanize,
  webFieldType,
} from "./compile.js";
import {
  CalendarModelSchema,
  DashboardModelSchema,
  DetailModelSchema,
  FormModelSchema,
  KanbanModelSchema,
  MapModelSchema,
  PivotModelSchema,
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
const ADMIN = { roles: ["retail_admin"] };

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

  it("lists only table/detail/form for an entity with no extra views (OrderLine)", () => {
    const app = compileWebApp(retail, MANAGER);
    expect(app.nav.find((n) => n.entity === "OrderLine")?.views).toEqual(["table", "detail", "form"]);
  });
});

/** Augments a resolved manifest with extra view declarations (the packs ship only ListViews). */
function withViews(base: Manifest, views: Record<string, unknown>): Manifest {
  return { ...base, views: { ...(base.views ?? {}), ...views } } as unknown as Manifest;
}

/**
 * Retail with only its `list` views — a base for the view-injection tests, since
 * the pack now authors real kanban/calendar/map/dashboard/pivot views (P3.21)
 * that would otherwise be found ahead of an injected one.
 */
const retailListOnly = {
  ...retail,
  views: Object.fromEntries(
    Object.entries(retail.views ?? {}).filter(([, v]) => (v as { kind: string }).kind === "list"),
  ),
} as unknown as Manifest;

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

const SALES_ORDER_KANBAN = {
  orderBoard: {
    kind: "kanban",
    entity: "SalesOrder",
    stateField: "state",
    columns: [
      { state: "cart", label: { en: "Cart" } },
      { state: "placed", label: { en: "Placed" } },
      { state: "fulfilled", label: { en: "Fulfilled" } },
    ],
    cardFields: ["order_number"],
    allowedTransitions: ["place", "fulfill"],
  },
};

describe("compileKanbanModel — RBAC-gated transitions", () => {
  const m = withViews(retailListOnly, SALES_ORDER_KANBAN);

  it("resolves allowed transitions to {name,toState,fromStates}, gated by the viewer's grants", () => {
    // place is granted to SELLERS (incl cashier); fulfill only to MANAGERS
    const mgr = compileKanbanModel(m, "SalesOrder", MANAGER);
    expect(mgr!.transitions.map((t) => t.name).sort()).toEqual(["fulfill", "place"]);
    const place = mgr!.transitions.find((t) => t.name === "place");
    expect(place?.toState).toBe("placed");
    expect(place?.fromStates).toContain("cart");

    const csh = compileKanbanModel(m, "SalesOrder", CASHIER);
    // a cashier may place but not fulfill
    expect(csh!.transitions.map((t) => t.name)).toEqual(["place"]);
  });

  it("an empty allowedTransitions list yields no transitions", () => {
    const board = compileKanbanModel(withViews(retail, PRODUCT_KANBAN), "Product", MANAGER);
    expect(board!.transitions).toEqual([]);
  });
});

describe("compileCalendarModel", () => {
  const m = withViews(retailListOnly, SALES_ORDER_CALENDAR);

  it("returns null when the entity has no calendar view", () => {
    expect(compileCalendarModel(retailListOnly, "SalesOrder", MANAGER)).toBeNull();
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
    const piiColor = withViews(retailListOnly, {
      orderCalendar: { ...SALES_ORDER_CALENDAR.orderCalendar, colorField: "customer_email" },
    });
    const cal = compileCalendarModel(piiColor, "SalesOrder", CASHIER);
    expect(cal).not.toBeNull();
    expect(cal!.colorField).toBeUndefined();
  });

  it("withholds the calendar (null) when the title field is unreadable — fail-closed", () => {
    const leaky = withViews(retailListOnly, {
      orderCalendar: { ...SALES_ORDER_CALENDAR.orderCalendar, titleField: "customer_email" },
    });
    expect(compileCalendarModel(leaky, "SalesOrder", CASHIER)).toBeNull();
  });
});

const STORE_MAP = {
  storeMap: {
    kind: "map",
    entity: "Store",
    label: { en: "Store map" },
    geoField: "region",
    markerColorField: "status",
    markerLabelField: "code",
    defaultZoom: 8,
    layers: [
      { id: "all", label: { en: "All stores" }, kind: "markers" },
      { id: "heat", label: { en: "Density" }, kind: "heatmap" },
    ],
    bounds: { south: 24, west: 51, north: 26, east: 56 },
  },
};

describe("compileMapModel", () => {
  const m = withViews(retailListOnly, STORE_MAP);

  it("returns null when the entity has no map view", () => {
    expect(compileMapModel(retailListOnly, "Store", MANAGER)).toBeNull();
  });

  it("compiles a schema-valid map with geo + marker fields, layers, bounds", () => {
    const map = compileMapModel(m, "Store", MANAGER);
    expect(map).not.toBeNull();
    expect(() => MapModelSchema.parse(map)).not.toThrow();
    expect(map!.geoField).toBe("region");
    expect(map!.markerColorField).toBe("status");
    expect(map!.markerLabelField).toBe("code");
    expect(map!.defaultZoom).toBe(8);
    expect(map!.layers.map((l) => l.kind)).toEqual(["markers", "heatmap"]);
    expect(map!.layers[0]!.label).toBe("All stores");
    expect(map!.bounds).toEqual({ south: 24, west: 51, north: 26, east: 56 });
  });

  it("withholds the whole map (null) when the geo field is unreadable — fail-closed", () => {
    // a Product map whose geoField is the commercial_sensitive unit_cost
    const leaky = withViews(retail, {
      productMap: {
        kind: "map",
        entity: "Product",
        geoField: "unit_cost",
        defaultZoom: 5,
        layers: [{ id: "all", label: { en: "All" }, kind: "markers" }],
      },
    });
    expect(compileMapModel(leaky, "Product", MANAGER)).not.toBeNull();
    expect(compileMapModel(leaky, "Product", CASHIER)).toBeNull();
  });

  it("omits an unreadable markerColorField but keeps the map", () => {
    const sensitiveColor = withViews(retail, {
      productMap: {
        kind: "map",
        entity: "Product",
        geoField: "sku",
        markerColorField: "unit_cost",
        defaultZoom: 5,
        layers: [{ id: "all", label: { en: "All" }, kind: "markers" }],
      },
    });
    expect(compileMapModel(sensitiveColor, "Product", MANAGER)!.markerColorField).toBe("unit_cost");
    expect(compileMapModel(sensitiveColor, "Product", CASHIER)!.markerColorField).toBeUndefined();
  });

  it("throws on an unknown entity", () => {
    expect(() => compileMapModel(m, "Nope", MANAGER)).toThrow(/unknown entity/);
  });
});

function withDashboard(
  base: Manifest,
  views: Record<string, unknown>,
  dashboards: Record<string, unknown>,
  reports: Record<string, unknown>,
): Manifest {
  return {
    ...base,
    views: { ...(base.views ?? {}), ...views },
    dashboards: { ...((base as { dashboards?: Record<string, unknown> }).dashboards ?? {}), ...dashboards },
    reports: { ...((base as { reports?: Record<string, unknown> }).reports ?? {}), ...reports },
  } as unknown as Manifest;
}

const STORE_DASHBOARD_VIEW = {
  storeDashView: { kind: "dashboard", entity: "Store", label: { en: "Store dashboard" }, dashboardRef: "storeDash" },
};
const STORE_DASHBOARD = {
  storeDash: {
    layout: "grid",
    refreshIntervalSeconds: 120,
    cells: [
      { x: 0, y: 0, w: 4, h: 2, widget: { kind: "kpi", report: "salesKpi", title: { en: "Sales" } } },
      { x: 4, y: 0, w: 4, h: 2, widget: { kind: "markdown", body: { en: "Welcome" } } },
      { x: 8, y: 0, w: 4, h: 2, widget: { kind: "tabular", report: "secretReport" } },
    ],
  },
};
const DASHBOARD_REPORTS = {
  salesKpi: {},
  secretReport: { permissions: { roles: ["retail_admin"] } },
};

describe("compileDashboardModel", () => {
  const m = withDashboard(retailListOnly, STORE_DASHBOARD_VIEW, STORE_DASHBOARD, DASHBOARD_REPORTS);

  it("returns null when the entity has no dashboard view", () => {
    expect(compileDashboardModel(retailListOnly, "Store", MANAGER)).toBeNull();
  });

  it("compiles a schema-valid dashboard with layout + cells, dropping a report the viewer can't access", () => {
    const dash = compileDashboardModel(m, "Store", MANAGER);
    expect(dash).not.toBeNull();
    expect(() => DashboardModelSchema.parse(dash)).not.toThrow();
    expect(dash!.layout).toBe("grid");
    expect(dash!.refreshIntervalSeconds).toBe(120);
    // manager sees the salesKpi + markdown widgets; secretReport (admin-only) is dropped
    expect(dash!.cells).toHaveLength(2);
    expect(dash!.cells.map((c) => c.widget.kind)).toEqual(["kpi", "markdown"]);
    expect(dash!.cells[0]!.widget.report).toBe("salesKpi");
    expect(dash!.cells[1]!.widget.body).toBe("Welcome");
  });

  it("a retail_admin sees the report-gated widget too", () => {
    const dash = compileDashboardModel(m, "Store", ADMIN);
    expect(dash!.cells).toHaveLength(3);
    expect(dash!.cells.map((c) => c.widget.report ?? "")).toContain("secretReport");
  });

  it("withholds the whole dashboard (null) when its permissions exclude the viewer — fail-closed", () => {
    const gated = withDashboard(
      retailListOnly,
      STORE_DASHBOARD_VIEW,
      { storeDash: { ...STORE_DASHBOARD.storeDash, permissions: { roles: ["retail_admin"] } } },
      DASHBOARD_REPORTS,
    );
    expect(compileDashboardModel(gated, "Store", ADMIN)).not.toBeNull();
    expect(compileDashboardModel(gated, "Store", MANAGER)).toBeNull();
  });

  it("returns null when the referenced dashboard is missing", () => {
    const dangling = withDashboard(retailListOnly, STORE_DASHBOARD_VIEW, {}, DASHBOARD_REPORTS);
    expect(compileDashboardModel(dangling, "Store", MANAGER)).toBeNull();
  });

  it("throws on an unknown entity", () => {
    expect(() => compileDashboardModel(m, "Nope", MANAGER)).toThrow(/unknown entity/);
  });

  it("exposes dashboard in the nav only when it compiles for the viewer", () => {
    const gated = withDashboard(
      retailListOnly,
      STORE_DASHBOARD_VIEW,
      { storeDash: { ...STORE_DASHBOARD.storeDash, permissions: { roles: ["retail_admin"] } } },
      DASHBOARD_REPORTS,
    );
    expect(compileWebApp(gated, ADMIN).nav.find((n) => n.entity === "Store")?.views).toContain("dashboard");
    expect(compileWebApp(gated, MANAGER).nav.find((n) => n.entity === "Store")?.views).not.toContain("dashboard");
  });
});

const STORE_PIVOT_VIEW = {
  storePivotView: { kind: "pivot", entity: "Store", reportRef: "salesPivot", allowReshape: false },
};
const PIVOT_REPORTS = {
  salesPivot: { label: { en: "Sales pivot" } },
  secretPivot: { label: { en: "Secret" }, permissions: { roles: ["retail_admin"] } },
};

describe("compilePivotModel", () => {
  const m = withDashboard(retail, STORE_PIVOT_VIEW, {}, PIVOT_REPORTS);

  it("returns null when the entity has no pivot view", () => {
    expect(compilePivotModel(retail, "Store", MANAGER)).toBeNull();
  });

  it("compiles a schema-valid pivot with the report ref + reshape flag + label", () => {
    const pivot = compilePivotModel(m, "Store", MANAGER);
    expect(pivot).not.toBeNull();
    expect(() => PivotModelSchema.parse(pivot)).not.toThrow();
    expect(pivot!.reportRef).toBe("salesPivot");
    expect(pivot!.allowReshape).toBe(false);
    expect(pivot!.reportLabel).toBe("Sales pivot");
  });

  it("withholds the pivot (null) when the report's permissions exclude the viewer — fail-closed", () => {
    const gated = withDashboard(
      retail,
      { storePivotView: { kind: "pivot", entity: "Store", reportRef: "secretPivot", allowReshape: true } },
      {},
      PIVOT_REPORTS,
    );
    expect(compilePivotModel(gated, "Store", ADMIN)).not.toBeNull();
    expect(compilePivotModel(gated, "Store", MANAGER)).toBeNull();
  });

  it("returns null when the referenced report is missing", () => {
    const dangling = withDashboard(retail, { storePivotView: { kind: "pivot", entity: "Store", reportRef: "ghost", allowReshape: true } }, {}, PIVOT_REPORTS);
    expect(compilePivotModel(dangling, "Store", MANAGER)).toBeNull();
  });

  it("exposes pivot in the nav only when it compiles for the viewer", () => {
    const gated = withDashboard(
      retail,
      { storePivotView: { kind: "pivot", entity: "Store", reportRef: "secretPivot", allowReshape: true } },
      {},
      PIVOT_REPORTS,
    );
    expect(compileWebApp(gated, ADMIN).nav.find((n) => n.entity === "Store")?.views).toContain("pivot");
    expect(compileWebApp(gated, MANAGER).nav.find((n) => n.entity === "Store")?.views).not.toContain("pivot");
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

  it("adds map to the entity's nav when a map compiles", () => {
    const app = compileWebApp(withViews(retail, STORE_MAP), MANAGER);
    expect(app.nav.find((n) => n.entity === "Store")?.views).toContain("map");
  });
});

describe("authored retail pack views (P3.21) — compiles the pack's real views", () => {
  it("compiles every view kind the retail pack now declares", () => {
    // SalesOrder: kanban + calendar; Store: map + dashboard; Product: pivot
    expect(compileKanbanModel(retail, "SalesOrder", MANAGER)).not.toBeNull();
    expect(compileCalendarModel(retail, "SalesOrder", MANAGER)).not.toBeNull();
    expect(compileMapModel(retail, "Store", MANAGER)).not.toBeNull();
    expect(compileDashboardModel(retail, "Store", MANAGER)).not.toBeNull();
    expect(compilePivotModel(retail, "Product", MANAGER)).not.toBeNull();
  });

  it("the SalesOrder board resolves its lifecycle transitions (RBAC-gated)", () => {
    const board = compileKanbanModel(retail, "SalesOrder", MANAGER);
    expect(board!.stateField).toBe("state");
    expect(board!.transitions.map((t) => t.name).sort()).toEqual(["cancel", "fulfill", "mark_returned", "place"]);
  });

  it("the Store dashboard resolves its widgets + the Product pivot its report", () => {
    const dash = compileDashboardModel(retail, "Store", MANAGER);
    expect(dash!.cells.length).toBeGreaterThan(0);
    expect(dash!.cells.some((c) => c.widget.report === "salesRevenue")).toBe(true);
    expect(compilePivotModel(retail, "Product", MANAGER)!.reportRef).toBe("productByCategoryStatus");
  });

  it("the nav exposes all the authored view kinds for the right entities", () => {
    const app = compileWebApp(retail, MANAGER);
    expect(app.nav.find((n) => n.entity === "SalesOrder")?.views).toEqual(
      expect.arrayContaining(["table", "detail", "form", "kanban", "calendar"]),
    );
    expect(app.nav.find((n) => n.entity === "Store")?.views).toEqual(expect.arrayContaining(["map", "dashboard"]));
    expect(app.nav.find((n) => n.entity === "Product")?.views).toContain("pivot");
  });
});
