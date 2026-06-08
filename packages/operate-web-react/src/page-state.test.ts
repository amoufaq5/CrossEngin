import type { TableModel, WebAppModel } from "@crossengin/operate-web";
import { describe, expect, it } from "vitest";

import {
  PAGE_STATE_GLOBAL,
  buildListQueryUrl,
  parsePageState,
  serializePageState,
  type WebPageState,
} from "./page-state.js";

const APP: WebAppModel = {
  title: "Demo",
  nav: [{ entity: "Product", label: "Product", path: "/ui/Product", views: ["table", "detail", "form"] }],
};

const TABLE: TableModel = {
  entity: "Product",
  title: "Products",
  columns: [
    { field: "sku", label: "SKU", type: "text", sortable: true, filterable: true },
    { field: "name", label: "Name", type: "text", sortable: false, filterable: false },
  ],
  defaultSort: [{ field: "sku", direction: "asc" }],
  pageSize: 25,
  rowActions: [{ kind: "openRecord", view: "detail" }],
};

describe("page-state global name", () => {
  it("is the stable hydration global", () => {
    expect(PAGE_STATE_GLOBAL).toBe("__OPERATE_WEB_STATE__");
  });
});

describe("serializePageState / parsePageState", () => {
  it("round-trips an app state", () => {
    const state: WebPageState = { kind: "app", app: APP, basePath: "/app" };
    expect(parsePageState(serializePageState(state))).toEqual(state);
  });

  it("round-trips a table state with rows + cursor", () => {
    const state: WebPageState = {
      kind: "table",
      app: APP,
      table: TABLE,
      rows: [{ id: "p1", sku: "ABC", name: "Widget" }],
      nextCursor: "cur_2",
      basePath: "/app",
    };
    expect(parsePageState(serializePageState(state))).toEqual(state);
  });

  it("escapes </script> so the embedded blob cannot break out of a script tag", () => {
    const state: WebPageState = {
      kind: "detail",
      app: APP,
      detail: { entity: "Product", title: "Product", sections: [] },
      record: { id: "p1", note: "</script><script>alert(1)</script>" },
      basePath: "/app",
    };
    const serialized = serializePageState(state);
    // no literal angle brackets survive
    expect(serialized).not.toContain("<");
    expect(serialized).not.toContain(">");
    expect(serialized).not.toContain("</script>");
    expect(serialized).toContain("\\u003c");
    expect(serialized).toContain("\\u003e");
    // …but it is still valid JSON that round-trips the dangerous string verbatim
    const parsed = parsePageState(serialized);
    expect(parsed.kind).toBe("detail");
    if (parsed.kind === "detail") {
      expect(parsed.record["note"]).toBe("</script><script>alert(1)</script>");
    }
  });

  it("escapes U+2028 / U+2029 line terminators", () => {
    const ls = String.fromCharCode(0x2028);
    const ps = String.fromCharCode(0x2029);
    const state: WebPageState = {
      kind: "detail",
      app: APP,
      detail: { entity: "Product", title: "Product", sections: [] },
      record: { id: "p1", note: `a${ls}b${ps}c` },
      basePath: "/app",
    };
    const serialized = serializePageState(state);
    expect(serialized).not.toContain(ls);
    expect(serialized).not.toContain(ps);
    expect(serialized).toContain("\\u2028");
    expect(serialized).toContain("\\u2029");
    const parsed = parsePageState(serialized);
    if (parsed.kind === "detail") {
      expect(parsed.record["note"]).toBe(`a${ls}b${ps}c`);
    }
  });
});

describe("buildListQueryUrl", () => {
  it("builds a bare entity URL with no params", () => {
    expect(buildListQueryUrl("Product")).toBe("/ui/Product");
  });

  it("adds a cursor when present", () => {
    expect(buildListQueryUrl("Product", { cursor: "cur_2" })).toBe("/ui/Product?cursor=cur_2");
  });

  it("ignores an empty / null cursor", () => {
    expect(buildListQueryUrl("Product", { cursor: "" })).toBe("/ui/Product");
    expect(buildListQueryUrl("Product", { cursor: null })).toBe("/ui/Product");
  });

  it("adds sort + order (defaulting order to asc)", () => {
    expect(buildListQueryUrl("Product", { sort: "sku" })).toBe("/ui/Product?sort=sku&order=asc");
    expect(buildListQueryUrl("Product", { sort: "sku", order: "desc" })).toBe(
      "/ui/Product?sort=sku&order=desc",
    );
  });

  it("combines cursor + sort", () => {
    expect(buildListQueryUrl("Product", { cursor: "c1", sort: "sku", order: "desc" })).toBe(
      "/ui/Product?cursor=c1&sort=sku&order=desc",
    );
  });

  it("path-encodes the entity name", () => {
    expect(buildListQueryUrl("Sales Order")).toBe("/ui/Sales%20Order");
  });
});
