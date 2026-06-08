import type { TableModel, WebAppModel } from "@crossengin/operate-web";
import { describe, expect, it } from "vitest";

import type { WebPageState } from "./page-state.js";
import { renderHydratablePage } from "./render.js";

const APP: WebAppModel = {
  title: "Demo",
  nav: [{ entity: "Product", label: "Product", path: "/ui/Product", views: ["table", "detail", "form"] }],
};

const TABLE: TableModel = {
  entity: "Product",
  title: "Products",
  columns: [{ field: "sku", label: "SKU", type: "text", sortable: true, filterable: true }],
  defaultSort: [{ field: "sku", direction: "asc" }],
  pageSize: 25,
  rowActions: [{ kind: "openRecord", view: "detail" }],
};

describe("renderHydratablePage", () => {
  it("emits a #root div, an embedded state script, and a deferred client script", () => {
    const state: WebPageState = { kind: "app", app: APP, basePath: "/app" };
    const html = renderHydratablePage(state, { title: "Demo" });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<div id="root">');
    expect(html).toContain("window.__OPERATE_WEB_STATE__ =");
    expect(html).toContain('<script src="/assets/operate-web-client.js" defer></script>');
    // hydration markers from renderToString (not static markup)
    expect(html).toContain("ce-app");
  });

  it("renders interactive table controls (sort + pagination) into the markup", () => {
    const state: WebPageState = {
      kind: "table",
      app: APP,
      table: TABLE,
      rows: [{ id: "p1", sku: "ABC" }],
      nextCursor: "cur_2",
      basePath: "/app",
    };
    const html = renderHydratablePage(state, { title: "Products" });
    expect(html).toContain('data-sort-field="sku"');
    expect(html).toContain('data-action="next"');
    expect(html).toContain('data-action="prev"');
    expect(html).toContain("ABC");
  });

  it("escapes a </script> hidden in the data so it cannot break out of the state script", () => {
    const state: WebPageState = {
      kind: "detail",
      app: APP,
      detail: { entity: "Product", title: "Product", sections: [] },
      record: { id: "p1", note: "</script><script>alert(1)</script>" },
      basePath: "/app",
    };
    const html = renderHydratablePage(state);
    // the only </script> occurrences are our two real closing tags, never the data's
    const closes = html.match(/<\/script>/g) ?? [];
    expect(closes.length).toBe(2);
    // the data's tag chars were escaped to their \u-form inside the state script
    expect(html).toContain("\\u003c/script\\u003e");
    expect(html).toContain("\\u003cscript\\u003e");
  });

  it("honors a custom client script src", () => {
    const state: WebPageState = { kind: "app", app: APP, basePath: "/app" };
    const html = renderHydratablePage(state, { clientScriptSrc: "/static/app.js" });
    expect(html).toContain('<script src="/static/app.js" defer></script>');
  });
});
