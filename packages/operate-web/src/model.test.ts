import { describe, expect, it } from "vitest";

import {
  ColumnModelSchema,
  DetailModelSchema,
  FormFieldModelSchema,
  FormModelSchema,
  TableModelSchema,
  WebAppModelSchema,
  WebFieldTypeSchema,
  WEB_FIELD_TYPES,
} from "./model.js";

describe("WebFieldTypeSchema", () => {
  it("accepts every manifest field kind", () => {
    for (const t of WEB_FIELD_TYPES) {
      expect(WebFieldTypeSchema.parse(t)).toBe(t);
    }
  });

  it("rejects an unknown kind", () => {
    expect(() => WebFieldTypeSchema.parse("blob")).toThrow();
  });
});

describe("ColumnModelSchema", () => {
  it("accepts a well-formed column", () => {
    const col = { field: "sku", label: "SKU", type: "text", sortable: true, filterable: false };
    expect(ColumnModelSchema.parse(col)).toEqual(col);
  });

  it("rejects an empty field", () => {
    expect(() =>
      ColumnModelSchema.parse({ field: "", label: "X", type: "text", sortable: true, filterable: true }),
    ).toThrow();
  });
});

describe("TableModelSchema", () => {
  it("accepts a table with columns + default sort", () => {
    const table = {
      entity: "Product",
      title: "Products",
      columns: [{ field: "sku", label: "SKU", type: "text", sortable: true, filterable: true }],
      defaultSort: [{ field: "name", direction: "asc" }],
      pageSize: 50,
      rowActions: [{ kind: "openRecord", view: "Product.detail" }],
    };
    expect(TableModelSchema.parse(table)).toEqual(table);
  });

  it("rejects a non-positive page size", () => {
    expect(() =>
      TableModelSchema.parse({
        entity: "Product",
        title: "Products",
        columns: [],
        defaultSort: [],
        pageSize: 0,
        rowActions: [],
      }),
    ).toThrow();
  });
});

describe("DetailModelSchema", () => {
  it("accepts a detail with a value-bearing field", () => {
    const detail = {
      entity: "Product",
      title: "Product",
      sections: [
        {
          title: "Details",
          fields: [{ field: "sku", label: "Sku", type: "text", value: "ABC-1" }],
        },
      ],
    };
    expect(DetailModelSchema.parse(detail)).toEqual(detail);
  });
});

describe("FormFieldModelSchema", () => {
  it("accepts a readonly enum field with validations", () => {
    const field = {
      field: "status",
      label: "Status",
      type: "enum",
      required: true,
      readOnly: true,
      validations: [{ kind: "enum", values: ["active", "discontinued"] }],
    };
    expect(FormFieldModelSchema.parse(field)).toEqual(field);
  });
});

describe("FormModelSchema", () => {
  it("rejects an unknown mode", () => {
    expect(() =>
      FormModelSchema.parse({ entity: "Product", mode: "patch", title: "x", fields: [] }),
    ).toThrow();
  });
});

describe("WebAppModelSchema", () => {
  it("accepts an app model with nav", () => {
    const app = {
      title: "Retail",
      nav: [{ entity: "Product", label: "Products", path: "/ui/Product", views: ["table", "detail", "form"] }],
    };
    expect(WebAppModelSchema.parse(app)).toEqual(app);
  });
});
