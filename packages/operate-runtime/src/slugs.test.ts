import { describe, expect, it } from "vitest";
import { entityCamel, operationId, resourceSlug, routeId } from "./slugs.js";

describe("slug + operationId conventions", () => {
  it("camel-cases the entity name for operationIds", () => {
    expect(entityCamel("Product")).toBe("product");
    expect(entityCamel("SalesOrder")).toBe("salesOrder");
    expect(entityCamel("OrderLine")).toBe("orderLine");
  });

  it("kebab-pluralizes the entity name for URL paths", () => {
    expect(resourceSlug("Product")).toBe("products");
    expect(resourceSlug("SalesOrder")).toBe("sales-orders");
    expect(resourceSlug("OrderLine")).toBe("order-lines");
  });

  it("builds operationIds the gateway accepts (no hyphens)", () => {
    expect(operationId("SalesOrder", "list")).toBe("salesOrder.list");
    expect(operationId("SalesOrder", "mark_returned")).toBe("salesOrder.mark_returned");
    expect(operationId("SalesOrder", "list")).toMatch(/^[a-z][a-zA-Z0-9._]*$/);
  });

  // `entityReadOperationIds` is gone; what replaced its test is the assertion that this module
  // exports no name-derived operation *set* at all, so the redaction mapping cannot be rebuilt
  // from the entity name again. The real set comes from the derived routes (`compile.test.ts`).
  it("exports no per-entity operation list (the redaction mapping must come from the routes)", async () => {
    const slugs = await import("./slugs.js");
    expect(Object.keys(slugs).filter((k) => /OperationIds$/.test(k))).toEqual([]);
  });

  it("derives a valid rt_ route id from an operationId", () => {
    expect(routeId("salesOrder.mark_returned")).toMatch(/^rt_[a-z0-9]{8,40}$/);
    expect(routeId("a.b")).toMatch(/^rt_[a-z0-9]{8,40}$/);
  });
});
