import { describe, expect, it } from "vitest";
import { COLUMN_RENDER_HINTS, ColumnDefinitionSchema, ColumnGroupSchema } from "./columns.js";

describe("ColumnDefinitionSchema", () => {
  it("parses a minimal column", () => {
    const c = ColumnDefinitionSchema.parse({ field: "name" });
    expect(c.sortable).toBe(true);
    expect(c.filterable).toBe(true);
    expect(c.truncate).toBe(true);
  });

  it("parses a badge-rendered column with alignment", () => {
    const c = ColumnDefinitionSchema.parse({
      field: "status",
      label: { en: "Status" },
      render: "badge",
      align: "center",
      width: 120,
    });
    expect(c.render).toBe("badge");
    expect(c.align).toBe("center");
  });

  it("rejects an unknown render hint", () => {
    expect(() => ColumnDefinitionSchema.parse({ field: "x", render: "fancy" })).toThrow();
  });

  it("rejects width outside [40, 2000]", () => {
    expect(() => ColumnDefinitionSchema.parse({ field: "x", width: 10 })).toThrow();
    expect(() => ColumnDefinitionSchema.parse({ field: "x", width: 5000 })).toThrow();
  });

  it("rejects sortable+filterable on a hidden column", () => {
    expect(() =>
      ColumnDefinitionSchema.parse({
        field: "x",
        hidden: true,
        sortable: true,
      }),
    ).toThrow(/hidden columns cannot/);
  });

  it("accepts a sticky-end column", () => {
    expect(() => ColumnDefinitionSchema.parse({ field: "actions", sticky: "end" })).not.toThrow();
  });

  it("COLUMN_RENDER_HINTS covers the documented hints", () => {
    expect(COLUMN_RENDER_HINTS).toContain("badge");
    expect(COLUMN_RENDER_HINTS).toContain("relativeTime");
    expect(COLUMN_RENDER_HINTS).toContain("markdown");
  });
});

describe("ColumnGroupSchema", () => {
  it("parses a column group", () => {
    const g = ColumnGroupSchema.parse({
      label: { en: "Patient" },
      columns: [{ field: "patient.name" }, { field: "patient.dob" }],
    });
    expect(g.columns).toHaveLength(2);
  });

  it("rejects an empty group", () => {
    expect(() => ColumnGroupSchema.parse({ label: { en: "x" }, columns: [] })).toThrow();
  });
});
