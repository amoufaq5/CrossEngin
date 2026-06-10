import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import type { HandlerInput } from "@crossengin/api-gateway-runtime";
import type { PermissionMap, RoleDefinition } from "@crossengin/auth";
import { describe, expect, it } from "vitest";

import type { ApiDescriptor } from "./api-descriptor.js";
import {
  OPENAPI_OPERATION_ID,
  buildOpenApiHandler,
  buildPerCallerOpenApiHandler,
  filterDescriptorForPrincipal,
  openApiRouteDefinition,
  toOpenApiDocument,
  type OpenApiRbacContext,
} from "./openapi.js";

const descriptor: ApiDescriptor = {
  apiVersion: "v1",
  operations: [
    { operationId: "product.list", method: "GET", path: "/v1/products", kind: "list", entity: "Product" },
    { operationId: "product.create", method: "POST", path: "/v1/products", kind: "create", entity: "Product" },
    { operationId: "product.read", method: "GET", path: "/v1/products/{id}", kind: "read", entity: "Product" },
    { operationId: "report.run", method: "GET", path: "/v1/reports/{report}", kind: "report" },
  ],
  reports: [{ name: "salesRevenue", kind: "kpi", entity: "SalesOrder", label: "Total revenue" }],
};

describe("toOpenApiDocument", () => {
  const doc = toOpenApiDocument(descriptor, { title: "Test API", version: "v1" });

  it("is a 3.1 doc with grouped paths + lowercased method keys", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info).toEqual({ title: "Test API", version: "v1" });
    expect(Object.keys(doc.paths["/v1/products"]!).sort()).toEqual(["get", "post"]);
    expect(doc.paths["/v1/products"]!["get"]!.operationId).toBe("product.list");
  });

  it("derives path parameters from {placeholders}", () => {
    const read = doc.paths["/v1/products/{id}"]!["get"]!;
    expect(read.parameters).toEqual([{ name: "id", in: "path", required: true, schema: { type: "string" } }]);
  });

  it("tags the report route + documents its 404, and carries x-reports", () => {
    const report = doc.paths["/v1/reports/{report}"]!["get"]!;
    expect(report.tags).toEqual(["reports"]);
    // 200 + the report's own 404 + the always-on 401 (P3.33)
    expect(Object.keys(report.responses).sort()).toEqual(["200", "401", "404"]);
    expect(report.parameters).toEqual([{ name: "report", in: "path", required: true, schema: { type: "string" } }]);
    expect(doc["x-reports"]).toEqual(descriptor.reports);
  });

  it("attaches RFC 9457 error responses per operation (P3.33)", () => {
    const create = doc.paths["/v1/products"]!["post"]!;
    // create: 401 + 403, each application/problem+json referencing ProblemDetails
    expect(create.responses["401"]?.content?.["application/problem+json"].schema).toEqual({
      $ref: "#/components/schemas/ProblemDetails",
    });
    expect(create.responses["403"]).toBeDefined();
    expect(create.responses["404"]).toBeUndefined(); // no record id on create
    // read (has {id}) documents 404; report documents 404 but not 403
    expect(doc.paths["/v1/products/{id}"]!["get"]!.responses["404"]).toBeDefined();
    expect(doc.paths["/v1/reports/{report}"]!["get"]!.responses["403"]).toBeUndefined();
    // the ProblemDetails schema is always present
    expect(doc.components?.schemas["ProblemDetails"]).toBeDefined();
  });

  it("a transition operation documents 404 + 409", () => {
    const td = toOpenApiDocument(
      {
        apiVersion: "v1",
        operations: [
          { operationId: "so.place", method: "POST", path: "/v1/sales-orders/{id}/place", kind: "transition", entity: "SalesOrder", transition: "place" },
        ],
        reports: [],
      },
      { title: "T", version: "v1" },
    );
    const op = td.paths["/v1/sales-orders/{id}/place"]!["post"]!;
    expect(op.responses["409"]).toBeDefined();
    expect(op.responses["404"]).toBeDefined();
    expect(op.requestBody?.content["application/json"].schema).toEqual({
      type: "object",
      properties: { transition: { type: "string" } },
      required: ["transition"],
    });
  });

  it("has no components when no entity schemas are supplied (report op still adds ReportData)", () => {
    // with a report op present, ReportData is added even without entity schemas
    expect(doc.components?.schemas["ReportData"]).toBeDefined();
    expect(doc.components?.schemas["Product"]).toBeUndefined();
  });
});

describe("toOpenApiDocument — component schemas (P3.32)", () => {
  const entitySchemas = {
    Product: {
      type: "object",
      properties: { id: { type: "string" }, sku: { type: "string" }, unit_price: { type: "number" } },
      required: ["sku"],
    },
  };
  const doc = toOpenApiDocument(descriptor, { title: "T", version: "v1" }, { entitySchemas });

  it("embeds the entity schema + the ReportData union under components.schemas", () => {
    expect(doc.components?.schemas["Product"]).toEqual(entitySchemas.Product);
    expect(doc.components?.schemas["ReportData"]).toBeDefined();
  });

  it("references the entity schema from read/create request + responses", () => {
    const read = doc.paths["/v1/products/{id}"]!["get"]!;
    expect(read.responses["200"]?.content?.["application/json"].schema).toEqual({ $ref: "#/components/schemas/Product" });
    const create = doc.paths["/v1/products"]!["post"]!;
    expect(create.requestBody?.content["application/json"].schema).toEqual({ $ref: "#/components/schemas/Product" });
    expect(create.responses["201"]?.content?.["application/json"].schema).toEqual({ $ref: "#/components/schemas/Product" });
  });

  it("wraps the list response (data array of the entity ref + page)", () => {
    const list = doc.paths["/v1/products"]!["get"]!;
    const schema = list.responses["200"]?.content?.["application/json"].schema as {
      properties: { data: { items: unknown } };
    };
    expect(schema.properties.data.items).toEqual({ $ref: "#/components/schemas/Product" });
  });

  it("references ReportData from the report operation's 200", () => {
    const report = doc.paths["/v1/reports/{report}"]!["get"]!;
    expect(report.responses["200"]?.content?.["application/json"].schema).toEqual({
      $ref: "#/components/schemas/ReportData",
    });
  });
});

describe("openApiRouteDefinition + buildOpenApiHandler", () => {
  it("routes GET /v1/openapi.json", () => {
    const route = openApiRouteDefinition();
    expect(route.operationId).toBe(OPENAPI_OPERATION_ID);
    expect(route.method).toBe("GET");
    expect(route.pathSegments).toEqual([
      { kind: "literal", value: "v1" },
      { kind: "literal", value: "openapi.json" },
    ]);
  });

  it("the handler returns the document (200) regardless of principal", async () => {
    const doc = toOpenApiDocument(descriptor, { title: "T", version: "v1" });
    const handler = buildOpenApiHandler(doc);
    const res = await handler({ principal: null } as unknown as HandlerInput);
    expect(res.kind === "json" && res.status).toBe(200);
    if (res.kind === "json") expect(res.body).toBe(doc);
  });
});

const RBAC_DESCRIPTOR: ApiDescriptor = {
  apiVersion: "v1",
  operations: [
    { operationId: "rx.read", method: "GET", path: "/v1/prescriptions/{id}", kind: "read", entity: "prescription" },
    { operationId: "rx.create", method: "POST", path: "/v1/prescriptions", kind: "create", entity: "prescription" },
    { operationId: "rx.delete", method: "DELETE", path: "/v1/prescriptions/{id}", kind: "delete", entity: "prescription" },
    { operationId: "rx.verify", method: "POST", path: "/v1/prescriptions/{id}/verify", kind: "transition", entity: "prescription", transition: "verify" },
    { operationId: "report.run", method: "GET", path: "/v1/reports/{report}", kind: "report" },
  ],
  reports: [],
};

const ROLES: ReadonlyMap<string, RoleDefinition> = new Map([["staff", { name: "staff" }], ["pharmacist", { name: "pharmacist" }]]);
const PERMS: PermissionMap = {
  prescription: {
    read: { roles: ["pharmacist"] },
    create: { roles: ["pharmacist"] },
    delete: { roles: [] },
    transitions: { verify: { roles: ["pharmacist"] } },
  },
};
const rbac: OpenApiRbacContext = {
  permissions: PERMS,
  roles: ROLES,
  principalRoles: (p) => ({ primaryRole: p?.grantedScopes?.[0] ?? "anonymous" }),
};
function principal(role: string): ResolvedPrincipal {
  return { tenantId: "t", grantedScopes: [role] } as unknown as ResolvedPrincipal;
}

describe("filterDescriptorForPrincipal (P3.28)", () => {
  it("keeps only the operations the caller is RBAC-granted; the no-entity report op always stays", () => {
    const pharm = filterDescriptorForPrincipal(RBAC_DESCRIPTOR, principal("pharmacist"), rbac);
    expect(pharm.operations.map((o) => o.operationId).sort()).toEqual(["report.run", "rx.create", "rx.read", "rx.verify"]);
    // delete is granted to nobody (roles: []), so it's dropped even for a pharmacist
    expect(pharm.operations.some((o) => o.kind === "delete")).toBe(false);

    const staff = filterDescriptorForPrincipal(RBAC_DESCRIPTOR, principal("staff"), rbac);
    // staff has no prescription grants → only the report op survives
    expect(staff.operations.map((o) => o.operationId)).toEqual(["report.run"]);
  });

  it("the per-caller handler projects the filtered descriptor to OpenAPI", async () => {
    const handler = buildPerCallerOpenApiHandler(RBAC_DESCRIPTOR, { title: "Rx", version: "v1" }, rbac);
    const res = await handler({ principal: principal("staff") } as unknown as HandlerInput);
    expect(res.kind === "json" && res.status).toBe(200);
    if (res.kind === "json") {
      const doc = res.body as { paths: Record<string, Record<string, unknown>> };
      expect(doc.paths["/v1/prescriptions"]).toBeUndefined(); // create dropped for staff
      expect(doc.paths["/v1/reports/{report}"]?.["get"]).toBeDefined();
    }
  });
});
