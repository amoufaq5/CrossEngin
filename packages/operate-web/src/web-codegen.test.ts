import { resolveManifest, type Manifest, type ManifestRegistry } from "@crossengin/kernel/manifest";
import { ERP_CORE_PACK_SLUG, buildErpCorePack } from "@crossengin/pack-erp-core";
import { buildErpRetailPack } from "@crossengin/pack-erp-retail";
import { describe, expect, it } from "vitest";

import { describeWebApi, type WebApiDescriptor } from "./describe.js";
import { emitWebClientModule, webMethodName } from "./web-codegen.js";

const registry: ManifestRegistry = {
  async getManifest(id: string): Promise<Manifest | null> {
    return id === ERP_CORE_PACK_SLUG ? buildErpCorePack() : null;
  },
};
const retail = await resolveManifest(buildErpRetailPack(), { registry });

describe("webMethodName", () => {
  it("names routes <entity><Kind>, transitions <entity><Transition>", () => {
    expect(webMethodName({ kind: "table", method: "GET", path: "/ui/Product", entity: "Product" })).toBe("productTable");
    expect(webMethodName({ kind: "create", method: "POST", path: "/ui/Product", entity: "Product" })).toBe("productCreate");
    expect(webMethodName({ kind: "transition", method: "POST", path: "/ui/SalesOrder/{id}/transition", entity: "SalesOrder", transition: "place" })).toBe("salesOrderPlace");
    expect(webMethodName({ kind: "app", method: "GET", path: "/ui/app" })).toBe("app");
  });
});

const FIXTURE: WebApiDescriptor = {
  title: "T",
  routes: [
    { kind: "app", method: "GET", path: "/ui/app", responseSchema: { $ref: "#/models/WebAppModel" } },
    { kind: "describe", method: "GET", path: "/ui/_describe" },
  ],
  entities: [
    {
      entity: "Product",
      label: "Product",
      views: ["table", "detail", "form"],
      routes: [
        { kind: "table", method: "GET", path: "/ui/Product", entity: "Product", responseSchema: { type: "object", properties: { table: { $ref: "#/models/TableModel" }, page: { type: "object", properties: { data: { type: "array", items: { type: "object", additionalProperties: true } }, nextCursor: { type: ["string", "null"] } } } }, required: ["table", "page"] } },
        { kind: "detail", method: "GET", path: "/ui/Product/{id}", entity: "Product", responseSchema: { type: "object", properties: { detail: { $ref: "#/models/DetailModel" }, record: { type: "object", additionalProperties: true } }, required: ["detail", "record"] } },
        { kind: "create", method: "POST", path: "/ui/Product", entity: "Product", responseSchema: { type: "object", properties: { record: { type: "object", additionalProperties: true } }, required: ["record"] } },
        { kind: "delete", method: "DELETE", path: "/ui/Product/{id}", entity: "Product" },
      ],
      schema: { type: "object", properties: { id: { type: "string" }, sku: { type: "string" }, unit_cost: { type: ["number", "null"] } }, required: ["sku"] },
    },
  ],
  models: {
    WebAppModel: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
    TableModel: { type: "object", properties: { entity: { type: "string" }, columns: { type: "array", items: { type: "object", properties: { field: { type: "string" } }, required: ["field"] } } }, required: ["entity", "columns"] },
    DetailModel: { type: "object", properties: { entity: { type: "string" } }, required: ["entity"] },
  },
};

describe("emitWebClientModule", () => {
  const out = emitWebClientModule(FIXTURE);

  it("emits view-model + per-entity interfaces", () => {
    expect(out).toContain("export interface WebAppModel {");
    expect(out).toContain("export interface TableModel {");
    expect(out).toContain("export interface Product {");
    expect(out).toContain("readonly sku: string;");
    expect(out).toContain("readonly unit_cost?: number | null;");
  });

  it("emits typed methods, resolving $ref models in the envelope", () => {
    expect(out).toContain("app: (query?: QueryParams): Promise<WebAppModel> =>");
    expect(out).toContain("productTable: (query?: QueryParams): Promise<{ table: TableModel; page:");
    expect(out).toContain("productDetail: (id: string, query?: QueryParams): Promise<{ detail: DetailModel;");
    expect(out).toContain("productCreate: (body: Product, query?: QueryParams):");
    expect(out).toContain("productDelete: (id: string, query?: QueryParams): Promise<void> =>");
  });

  it("skips the describe route + emits the named factory", () => {
    expect(out).not.toContain("describe:");
    expect(out).toContain("export function createWebClient(options: ClientOptions)");
    expect(out).toContain("export class WebApiError extends Error");
  });

  it("honors a custom client name", () => {
    expect(emitWebClientModule(FIXTURE, { clientName: "createRetailWebClient" })).toContain("export function createRetailWebClient(");
  });
});

describe("emitWebClientModule over the real retail descriptor", () => {
  it("emits transition methods baking in the transition name", () => {
    const descriptor = describeWebApi(retail, { roles: ["store_manager"] });
    const out = emitWebClientModule(descriptor);
    expect(out).toContain("export function createWebClient(");
    // a SalesOrder transition method POSTs the baked transition name
    expect(out).toMatch(/salesOrderPlace: \(id: string, query\?: QueryParams\):/);
    expect(out).toContain('{ transition: "place" }');
  });
});
