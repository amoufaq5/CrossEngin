import type {
  DetailModel,
  FormModel,
  TableModel,
  WebAppModel,
} from "@crossengin/operate-web";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AppShell, DetailView, FormView, TableView, displayValue } from "./components.js";

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
