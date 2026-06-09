import type { WebAppModel } from "@crossengin/operate-web";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PageRoot } from "./page.js";
import type { WebPageState } from "./page-state.js";
import { AppRouter } from "./router.js";

const APP: WebAppModel = {
  title: "Demo",
  nav: [{ entity: "Product", label: "Product", path: "/ui/Product", views: ["table", "detail", "form"] }],
};

describe("AppRouter — SSR parity", () => {
  it("renders the same markup PageRoot does for the initial state (so hydration matches)", () => {
    const state: WebPageState = {
      kind: "detail",
      app: APP,
      detail: { entity: "Product", title: "Product", sections: [{ title: "Details", fields: [{ field: "sku", label: "SKU", type: "text" }] }] },
      record: { id: "p1", sku: "ABC" },
      basePath: "/app",
      canEdit: false,
      canDelete: false,
    };
    const viaRouter = renderToStaticMarkup(<AppRouter initial={state} />);
    const viaPageRoot = renderToStaticMarkup(<PageRoot state={state} />);
    expect(viaRouter).toBe(viaPageRoot);
  });

  it("renders the app shell for an app-kind state", () => {
    const state: WebPageState = { kind: "app", app: APP, basePath: "/app" };
    const html = renderToStaticMarkup(<AppRouter initial={state} />);
    expect(html).toContain("Demo");
    expect(html).toContain('href="/app/Product"');
  });
});
