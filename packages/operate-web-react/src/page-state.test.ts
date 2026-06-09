import type { FormModel, TableModel, WebAppModel } from "@crossengin/operate-web";
import { describe, expect, it } from "vitest";

import {
  PAGE_STATE_GLOBAL,
  appStateUrl,
  buildListQueryUrl,
  buildTransitionUrl,
  buildWriteUrl,
  coerceFormValues,
  fetchPageState,
  isInternalAppHref,
  parsePageState,
  planCardTransition,
  serializePageState,
  submitDelete,
  submitFormWrite,
  submitTransition,
  type WebPageState,
  type WriteFetcher,
  type WriteResult,
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

const FORM: FormModel = {
  entity: "Product",
  mode: "create",
  title: "New Product",
  fields: [
    { field: "sku", label: "SKU", type: "text", required: true, readOnly: false, validations: [] },
    { field: "unit_price", label: "Price", type: "decimal", required: false, readOnly: false, validations: [] },
    { field: "active", label: "Active", type: "boolean", required: false, readOnly: false, validations: [] },
    { field: "computed", label: "Computed", type: "text", required: false, readOnly: true, validations: [] },
  ],
};

describe("buildWriteUrl", () => {
  it("targets the collection without an id and a record with one", () => {
    expect(buildWriteUrl("Product")).toBe("/ui/Product");
    expect(buildWriteUrl("Product", "p1")).toBe("/ui/Product/p1");
    expect(buildWriteUrl("Product", null)).toBe("/ui/Product");
    expect(buildWriteUrl("Sales Order", "a b")).toBe("/ui/Sales%20Order/a%20b");
  });
});

describe("coerceFormValues", () => {
  it("coerces numbers + booleans, drops read-only + empty optional fields", () => {
    const out = coerceFormValues(FORM, { sku: "ABC", unit_price: "9.5", active: "on", computed: "x" });
    expect(out).toEqual({ sku: "ABC", unit_price: 9.5, active: true });
  });

  it("an absent checkbox is false; an empty optional number/text is omitted", () => {
    const out = coerceFormValues(FORM, { sku: "ABC", unit_price: "" });
    expect(out).toEqual({ sku: "ABC", active: false });
  });

  it("drops a non-numeric number field", () => {
    const out = coerceFormValues(FORM, { sku: "ABC", unit_price: "notnum" });
    expect("unit_price" in out).toBe(false);
  });
});

describe("submitFormWrite / submitDelete", () => {
  function recordingFetcher(result: WriteResult): { calls: { method: string; url: string; payload: unknown }[]; fetcher: WriteFetcher } {
    const calls: { method: string; url: string; payload: unknown }[] = [];
    const fetcher: WriteFetcher = async (method, url, payload) => {
      calls.push({ method, url, payload });
      return result;
    };
    return { calls, fetcher };
  }

  it("POSTs to the collection on create", async () => {
    const { calls, fetcher } = recordingFetcher({ ok: true, status: 201, record: { id: "p9" } });
    const res = await submitFormWrite({ entity: "Product", payload: { sku: "A" }, fetcher });
    expect(calls[0]).toEqual({ method: "POST", url: "/ui/Product", payload: { sku: "A" } });
    expect(res.record?.["id"]).toBe("p9");
  });

  it("PATCHes the record on edit", async () => {
    const { calls, fetcher } = recordingFetcher({ ok: true, status: 200 });
    await submitFormWrite({ entity: "Product", entityId: "p1", payload: { sku: "B" }, fetcher });
    expect(calls[0]).toEqual({ method: "PATCH", url: "/ui/Product/p1", payload: { sku: "B" } });
  });

  it("surfaces a non-ok result (e.g. a write-mask 422)", async () => {
    const { fetcher } = recordingFetcher({ ok: false, status: 422, detail: "cannot write field(s): unit_cost" });
    const res = await submitFormWrite({ entity: "Product", payload: { unit_cost: 1 }, fetcher });
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("unit_cost");
  });

  it("submitDelete DELETEs the record with a null payload", async () => {
    const { calls, fetcher } = recordingFetcher({ ok: true, status: 204 });
    await submitDelete("Product", "p1", fetcher);
    expect(calls[0]).toEqual({ method: "DELETE", url: "/ui/Product/p1", payload: null });
  });

  it("submitTransition POSTs the transition name to the transition URL", async () => {
    const { calls, fetcher } = recordingFetcher({ ok: true, status: 200, record: { id: "o1", state: "placed" } });
    await submitTransition("SalesOrder", "o1", "place", fetcher);
    expect(calls[0]).toEqual({ method: "POST", url: "/ui/SalesOrder/o1/transition", payload: { transition: "place" } });
  });
});

describe("buildTransitionUrl / planCardTransition", () => {
  const transitions = [
    { name: "place", toState: "placed", fromStates: ["cart"] },
    { name: "fulfill", toState: "fulfilled", fromStates: ["placed"] },
    { name: "cancel", toState: "cancelled", fromStates: ["cart", "placed"] },
  ];

  it("builds the transition URL", () => {
    expect(buildTransitionUrl("SalesOrder", "o1")).toBe("/ui/SalesOrder/o1/transition");
  });

  it("resolves the bridging transition for a drop, or null", () => {
    expect(planCardTransition(transitions, "cart", "placed")).toBe("place");
    expect(planCardTransition(transitions, "placed", "fulfilled")).toBe("fulfill");
    expect(planCardTransition(transitions, "placed", "cancelled")).toBe("cancel");
    // no transition from cart directly to fulfilled
    expect(planCardTransition(transitions, "cart", "fulfilled")).toBeNull();
    // dropping on the same column is a no-op
    expect(planCardTransition(transitions, "cart", "cart")).toBeNull();
  });
});

describe("SPA navigation helpers", () => {
  it("appStateUrl adds __state=1 preserving existing query", () => {
    expect(appStateUrl("/app/Product")).toBe("/app/Product?__state=1");
    expect(appStateUrl("/app/Product?cursor=c1")).toBe("/app/Product?cursor=c1&__state=1");
    expect(appStateUrl("https://app.example/app/Product/p1")).toBe("/app/Product/p1?__state=1");
  });

  it("isInternalAppHref accepts same-origin /app links, rejects others", () => {
    const origin = "https://app.example";
    expect(isInternalAppHref("/app", origin)).toBe(true);
    expect(isInternalAppHref("/app/Product/p1", origin)).toBe(true);
    expect(isInternalAppHref("/ui/Product", origin)).toBe(false);
    expect(isInternalAppHref("/apple", origin)).toBe(false);
    expect(isInternalAppHref("https://evil.example/app/x", origin)).toBe(false);
    expect(isInternalAppHref("https://app.example/app/Product", origin)).toBe(true);
  });

  it("fetchPageState fetches the __state JSON via the injected fetcher", async () => {
    const calls: string[] = [];
    const state: WebPageState = { kind: "app", app: { title: "T", nav: [] }, basePath: "/app" };
    const got = await fetchPageState("/app/Product/p1", async (url) => {
      calls.push(url);
      return state;
    });
    expect(calls).toEqual(["/app/Product/p1?__state=1"]);
    expect(got).toBe(state);
  });
});
