import { describe, expect, it } from "vitest";
import {
  entityCamel,
  entityReadOperationIds,
  operationId,
  resourceSlug,
  routeId,
} from "./slugs.js";

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

  it("lists the read operationIds for redaction", () => {
    expect(entityReadOperationIds("Product")).toEqual(["product.list", "product.read"]);
  });

  it("derives a valid rt_ route id from an operationId", () => {
    expect(routeId("salesOrder.mark_returned")).toMatch(/^rt_[a-z0-9]{8,40}$/);
    expect(routeId("a.b")).toMatch(/^rt_[a-z0-9]{8,40}$/);
  });
});
