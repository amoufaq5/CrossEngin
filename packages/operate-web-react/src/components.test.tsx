import type {
  CalendarModel,
  DetailModel,
  FormModel,
  KanbanModel,
  TableModel,
  WebAppModel,
} from "@crossengin/operate-web";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AppShell, CalendarView, DetailView, FormView, KanbanView, TableView, displayValue } from "./components.js";

const APP_MODEL: WebAppModel = {
  title: "Acme Operate",
  nav: [
    { entity: "Product", label: "Products", path: "/ui/Product", views: ["table", "detail", "form"] },
    { entity: "Store", label: "Stores", path: "/ui/Store", views: ["table", "detail", "form"] },
  ],
};

const TABLE_MODEL: TableModel = {
  entity: "Product",
  title: "Products",
  columns: [
    { field: "sku", label: "Sku", type: "text", sortable: true, filterable: true },
    { field: "name", label: "Name", type: "text", sortable: true, filterable: false },
    { field: "unit_price", label: "Unit price", type: "decimal", sortable: true, filterable: false },
  ],
  defaultSort: [{ field: "sku", direction: "asc" }],
  pageSize: 25,
  rowActions: [{ kind: "openRecord", view: "Product.detail" }],
};

const DETAIL_MODEL: DetailModel = {
  entity: "Product",
  title: "Product",
  sections: [
    {
      title: "Details",
      fields: [
        { field: "sku", label: "Sku", type: "text", value: "ABC-1" },
        { field: "name", label: "Name", type: "text", value: "Widget" },
      ],
    },
  ],
};

const FORM_MODEL: FormModel = {
  entity: "Product",
  mode: "create",
  title: "New Product",
  fields: [
    { field: "sku", label: "Sku", type: "text", required: true, readOnly: false, validations: [{ kind: "required" }] },
    { field: "name", label: "Name", type: "text", required: false, readOnly: false, validations: [] },
    {
      field: "status",
      label: "Status",
      type: "enum",
      required: true,
      readOnly: true,
      validations: [{ kind: "enum", values: ["active", "discontinued"] }],
    },
  ],
};

describe("displayValue", () => {
  it("renders primitives and JSON-stringifies objects", () => {
    expect(displayValue(null)).toBe("");
    expect(displayValue(undefined)).toBe("");
    expect(displayValue("x")).toBe("x");
    expect(displayValue(42)).toBe("42");
    expect(displayValue(true)).toBe("true");
    expect(displayValue({ a: 1 })).toBe('{"a":1}');
    expect(displayValue(new Date("2026-01-02T03:04:05.000Z"))).toBe("2026-01-02T03:04:05.000Z");
  });
});

describe("AppShell", () => {
  it("renders the title + one nav link per entity", () => {
    const html = renderToStaticMarkup(<AppShell app={APP_MODEL} />);
    expect(html).toContain("Acme Operate");
    expect(html).toContain('href="/app/Product"');
    expect(html).toContain('href="/app/Store"');
    expect(html).toContain("Products");
    expect(html).toContain("Stores");
  });

  it("wraps a page body in the main region", () => {
    const html = renderToStaticMarkup(
      <AppShell app={APP_MODEL}>
        <p>inner content</p>
      </AppShell>,
    );
    expect(html).toContain("inner content");
  });
});

describe("TableView", () => {
  it("renders a header per model column and a row per record", () => {
    const html = renderToStaticMarkup(
      <TableView
        model={TABLE_MODEL}
        rows={[{ id: "p1", sku: "ABC-1", name: "Widget", unit_price: 9.99 }]}
      />,
    );
    expect(html).toContain('data-field="sku"');
    expect(html).toContain("Unit price");
    expect(html).toContain("ABC-1");
    expect(html).toContain("9.99");
    // links the first cell to the detail surface
    expect(html).toContain('href="/app/Product/p1"');
  });

  it("never renders a column the model omits (redaction is structural)", () => {
    // The model carries no unit_cost column, and the row's stray unit_cost
    // value must not leak into any cell.
    const html = renderToStaticMarkup(
      <TableView model={TABLE_MODEL} rows={[{ id: "p1", sku: "ABC-1", name: "Widget", unit_cost: 4.2 }]} />,
    );
    expect(html).not.toContain("unit_cost");
    expect(html).not.toContain("4.2");
  });
});

describe("DetailView", () => {
  it("renders a section title and a dl row per field", () => {
    const html = renderToStaticMarkup(<DetailView model={DETAIL_MODEL} />);
    expect(html).toContain("Details");
    expect(html).toContain("<dt>Sku</dt>");
    expect(html).toContain("<dd>ABC-1</dd>");
    expect(html).toContain("<dd>Widget</dd>");
  });

  it("falls back to the supplied record for a value-less field", () => {
    const model: DetailModel = {
      entity: "Product",
      title: "Product",
      sections: [{ title: "Details", fields: [{ field: "sku", label: "Sku", type: "text" }] }],
    };
    const html = renderToStaticMarkup(<DetailView model={model} record={{ sku: "FROM-RECORD" }} />);
    expect(html).toContain("FROM-RECORD");
  });
});

describe("FormView", () => {
  it("renders a labelled control per field, marks required + disables readOnly", () => {
    const html = renderToStaticMarkup(<FormView model={FORM_MODEL} />);
    expect(html).toContain("New Product");
    expect(html).toContain('for="field-sku"');
    expect(html).toContain("required");
    // status is an enum + readOnly -> a disabled select over its values
    expect(html).toContain("<select");
    expect(html).toContain("discontinued");
    expect(html).toContain("disabled");
    expect(html).toContain('action="/app/Product"');
  });
});

const KANBAN_MODEL: KanbanModel = {
  entity: "SalesOrder",
  title: "Order board",
  stateField: "state",
  columns: [
    { state: "cart", label: "Cart" },
    { state: "placed", label: "Placed", color: "#0a0", wipLimit: 10 },
  ],
  cardFields: [
    { field: "order_number", label: "Order #", type: "text" },
    { field: "total", label: "Total", type: "decimal" },
  ],
  allowedTransitions: ["place"],
};

const CALENDAR_MODEL: CalendarModel = {
  entity: "SalesOrder",
  title: "Order calendar",
  startField: "placed_at",
  titleField: "order_number",
  colorField: "state",
  defaultView: "month",
};

describe("KanbanView", () => {
  const rows = [
    { id: "o1", state: "cart", order_number: "SO-1", total: 10 },
    { id: "o2", state: "placed", order_number: "SO-2", total: 20 },
    { id: "o3", state: "archived", order_number: "SO-3", total: 30 },
  ];

  it("groups rows into the declared columns and shows only card fields", () => {
    const html = renderToStaticMarkup(<KanbanView model={KANBAN_MODEL} rows={rows} />);
    expect(html).toContain('data-state="cart"');
    expect(html).toContain('data-state="placed"');
    // SO-1 in cart, SO-2 in placed, SO-3 (archived) dropped (no matching column)
    expect(html).toContain("SO-1");
    expect(html).toContain("SO-2");
    expect(html).not.toContain("SO-3");
    // card links to detail
    expect(html).toContain("/app/SalesOrder/o1");
    // the wip limit shows on the placed column count
    expect(html).toContain("/10");
  });

  it("renders only the model's card fields (a redacted field never appears)", () => {
    // a model whose cardFields omit `total` (as if redacted) never emits its value
    const redactedModel: KanbanModel = { ...KANBAN_MODEL, cardFields: [{ field: "order_number", label: "Order #", type: "text" }] };
    const html = renderToStaticMarkup(<KanbanView model={redactedModel} rows={rows} />);
    expect(html).toContain("SO-1");
    expect(html).not.toContain('data-field="total"');
  });
});

describe("CalendarView", () => {
  const rows = [
    { id: "o2", order_number: "SO-2", placed_at: "2026-02-01", state: "placed" },
    { id: "o1", order_number: "SO-1", placed_at: "2026-01-01", state: "cart" },
  ];

  it("renders an agenda ordered by start, with title links", () => {
    const html = renderToStaticMarkup(<CalendarView model={CALENDAR_MODEL} rows={rows} />);
    // ordered by placed_at ascending: SO-1 (Jan) before SO-2 (Feb)
    expect(html.indexOf("SO-1")).toBeLessThan(html.indexOf("SO-2"));
    expect(html).toContain('dateTime="2026-01-01"');
    expect(html).toContain("/app/SalesOrder/o1");
  });

  it("omits the color swatch when the model carries no colorField", () => {
    const noColor: CalendarModel = { entity: "SalesOrder", title: "Cal", startField: "placed_at", titleField: "order_number", defaultView: "week" };
    const html = renderToStaticMarkup(<CalendarView model={noColor} rows={rows} />);
    expect(html).not.toContain("ce-calendar-color");
  });
});
