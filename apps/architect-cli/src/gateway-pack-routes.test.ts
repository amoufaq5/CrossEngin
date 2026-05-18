import { RouteDefinitionSchema } from "@crossengin/api-gateway";
import { resolveManifest } from "@crossengin/kernel/manifest";
import { buildErpCorePack, ERP_CORE_PACK_SLUG } from "@crossengin/pack-erp-core";
import {
  buildErpHealthcarePack,
  ERP_HEALTHCARE_PACK_SLUG,
} from "@crossengin/pack-erp-healthcare";
import {
  buildErpPaymentsPack,
  ERP_PAYMENTS_PACK_SLUG,
} from "@crossengin/pack-erp-payments";
import { describe, expect, it } from "vitest";

import {
  CRUD_OPERATION_KINDS,
  entityKey,
  generatePackRoutes,
  pluralizePathSegment,
  routeIdFor,
} from "./gateway-pack-routes.js";

describe("entityKey", () => {
  it("lowercases simple entity names", () => {
    expect(entityKey("Patient")).toBe("patient");
    expect(entityKey("Encounter")).toBe("encounter");
  });

  it("splits CamelCase into snake_case", () => {
    expect(entityKey("InvoiceLine")).toBe("invoice_line");
    expect(entityKey("OrderItem")).toBe("order_item");
  });
});

describe("pluralizePathSegment", () => {
  it("appends 's' to simple names", () => {
    expect(pluralizePathSegment("Patient")).toBe("patients");
    expect(pluralizePathSegment("Encounter")).toBe("encounters");
    expect(pluralizePathSegment("Observation")).toBe("observations");
  });

  it("kebabifies CamelCase", () => {
    expect(pluralizePathSegment("InvoiceLine")).toBe("invoice-lines");
    expect(pluralizePathSegment("OrderItem")).toBe("order-items");
  });

  it("uses 'ies' for consonant+y endings", () => {
    expect(pluralizePathSegment("Category")).toBe("categories");
    expect(pluralizePathSegment("Policy")).toBe("policies");
  });

  it("preserves trailing 's' (idempotent for already-plural names)", () => {
    expect(pluralizePathSegment("Address")).toBe("address");
  });
});

describe("routeIdFor", () => {
  it("returns rt_<16 lowercase hex chars>", () => {
    const id = routeIdFor({ packSlug: "x", operationId: "y" });
    expect(id).toMatch(/^rt_[a-f0-9]{16}$/);
  });

  it("matches the RouteDefinition.id regex (rt_[a-z0-9]{8,40})", () => {
    const id = routeIdFor({
      packSlug: ERP_HEALTHCARE_PACK_SLUG,
      operationId: "patient.list",
    });
    expect(id).toMatch(/^rt_[a-z0-9]{8,40}$/);
  });

  it("is deterministic", () => {
    expect(routeIdFor({ packSlug: "a", operationId: "x" })).toBe(
      routeIdFor({ packSlug: "a", operationId: "x" }),
    );
  });

  it("varies with packSlug", () => {
    expect(routeIdFor({ packSlug: "a", operationId: "x" })).not.toBe(
      routeIdFor({ packSlug: "b", operationId: "x" }),
    );
  });

  it("varies with operationId", () => {
    expect(routeIdFor({ packSlug: "a", operationId: "x" })).not.toBe(
      routeIdFor({ packSlug: "a", operationId: "y" }),
    );
  });
});

describe("generatePackRoutes — core pack (4 entities, 1 lifecycle workflow)", () => {
  const records = generatePackRoutes({
    manifest: buildErpCorePack(),
    packSlug: ERP_CORE_PACK_SLUG,
  });

  it("emits 5 CRUD routes per entity (4 entities → 20 CRUD)", () => {
    const crud = records.filter((r) => r.operationKind !== "transition");
    expect(crud).toHaveLength(20);
  });

  it("emits one route per workflow transition (Invoice lifecycle has 4 transitions)", () => {
    const transitions = records.filter((r) => r.operationKind === "transition");
    expect(transitions).toHaveLength(4);
    expect(transitions.every((r) => r.entity === "Invoice")).toBe(true);
  });

  it("every generated route parses under RouteDefinitionSchema", () => {
    for (const r of records) {
      expect(() => RouteDefinitionSchema.parse(r.route)).not.toThrow();
    }
  });

  it("operationIds are unique within the pack", () => {
    const ids = records.map((r) => r.route.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("route_ids are unique within the pack (deterministic + collision-free)", () => {
    const ids = records.map((r) => r.route.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("Account.list is GET /v1/accounts with idempotency: false + scope account:list", () => {
    const r = records.find((r) => r.route.operationId === "account.list")!.route;
    expect(r.method).toBe("GET");
    expect(r.pathSegments).toEqual([
      { kind: "literal", value: "v1" },
      { kind: "literal", value: "accounts" },
    ]);
    expect(r.idempotencyRequired).toBe(false);
    expect(r.requiredScopes).toEqual(["account:list"]);
  });

  it("Account.create is POST /v1/accounts with idempotency: true + scope account:create", () => {
    const r = records.find((r) => r.route.operationId === "account.create")!.route;
    expect(r.method).toBe("POST");
    expect(r.idempotencyRequired).toBe(true);
    expect(r.requiredScopes).toEqual(["account:create"]);
  });

  it("Account.read is GET /v1/accounts/:id (parameter segment)", () => {
    const r = records.find((r) => r.route.operationId === "account.read")!.route;
    expect(r.method).toBe("GET");
    expect(r.pathSegments).toHaveLength(3);
    expect(r.pathSegments[2]).toEqual({
      kind: "parameter",
      name: "id",
      pattern: null,
    });
  });

  it("InvoiceLine routes use kebab-case path segments", () => {
    const r = records.find((r) => r.route.operationId === "invoice_line.list")!.route;
    const literals = r.pathSegments.filter((s) => s.kind === "literal");
    expect(literals.some((s) => s.kind === "literal" && s.value === "invoice-lines")).toBe(true);
  });

  it("Invoice transitions are POST /v1/invoices/:id/transitions/<name>", () => {
    const sendTransition = records.find(
      (r) => r.route.operationId === "invoice.transition.send",
    );
    expect(sendTransition).toBeDefined();
    const path = sendTransition!.route.pathSegments;
    expect(path[0]).toEqual({ kind: "literal", value: "v1" });
    expect(path[1]).toEqual({ kind: "literal", value: "invoices" });
    expect(path[2]).toEqual({ kind: "parameter", name: "id", pattern: null });
    expect(path[3]).toEqual({ kind: "literal", value: "transitions" });
    expect(path[4]).toEqual({ kind: "literal", value: "send" });
    expect(sendTransition!.route.method).toBe("POST");
    expect(sendTransition!.route.idempotencyRequired).toBe(true);
    expect(sendTransition!.route.requiredScopes).toEqual(["invoice:transition.send"]);
  });
});

describe("generatePackRoutes — healthcare pack (resolved, 3 entities + 2 workflows)", () => {
  async function buildResolvedHealthcare() {
    return resolveManifest(buildErpHealthcarePack(), {
      registry: {
        async getManifest(slug) {
          if (slug === ERP_CORE_PACK_SLUG) return buildErpCorePack();
          return null;
        },
      },
    });
  }

  it("generates routes only for the merged entity set (4 core + 3 healthcare = 7 entities = 35 CRUD)", async () => {
    const m = await buildResolvedHealthcare();
    const records = generatePackRoutes({
      manifest: m,
      packSlug: ERP_HEALTHCARE_PACK_SLUG,
    });
    const crud = records.filter((r) => r.operationKind !== "transition");
    expect(crud).toHaveLength(35);
  });

  it("includes encounter_lifecycle + observation_lifecycle + invoice_lifecycle transitions", async () => {
    const m = await buildResolvedHealthcare();
    const records = generatePackRoutes({
      manifest: m,
      packSlug: ERP_HEALTHCARE_PACK_SLUG,
    });
    const transitionEntities = new Set(
      records
        .filter((r) => r.operationKind === "transition")
        .map((r) => r.entity),
    );
    expect([...transitionEntities].sort()).toEqual([
      "Encounter",
      "Invoice",
      "Observation",
    ]);
  });

  it("encounter.transition.check_in routes to POST /v1/encounters/:id/transitions/check_in", async () => {
    const m = await buildResolvedHealthcare();
    const records = generatePackRoutes({
      manifest: m,
      packSlug: ERP_HEALTHCARE_PACK_SLUG,
    });
    const checkIn = records.find(
      (r) => r.route.operationId === "encounter.transition.check_in",
    );
    expect(checkIn).toBeDefined();
    expect(checkIn!.route.method).toBe("POST");
    expect(checkIn!.route.idempotencyRequired).toBe(true);
  });
});

describe("generatePackRoutes — payments pack (1 new entity, 5 transitions)", () => {
  async function buildResolvedPayments() {
    return resolveManifest(buildErpPaymentsPack(), {
      registry: {
        async getManifest(slug) {
          if (slug === ERP_CORE_PACK_SLUG) return buildErpCorePack();
          return null;
        },
      },
    });
  }

  it("includes Payment + Invoice transitions in the route set", async () => {
    const m = await buildResolvedPayments();
    const records = generatePackRoutes({
      manifest: m,
      packSlug: ERP_PAYMENTS_PACK_SLUG,
    });
    const transitionOps = records
      .filter((r) => r.operationKind === "transition")
      .map((r) => r.route.operationId);
    expect(transitionOps).toContain("payment.transition.capture");
    expect(transitionOps).toContain("payment.transition.refund");
    expect(transitionOps).toContain("invoice.transition.send");
  });
});

describe("generatePackRoutes — edge cases", () => {
  it("manifest with no entities + no workflows returns empty array", () => {
    const records = generatePackRoutes({
      manifest: { manifestVersion: "1.0", meta: { name: "x", slug: "x", version: "1" } },
      packSlug: "x",
    });
    expect(records).toEqual([]);
  });

  it("uses the apiVersion override in path segments + apiVersion field", () => {
    const records = generatePackRoutes({
      manifest: buildErpCorePack(),
      packSlug: ERP_CORE_PACK_SLUG,
      apiVersion: "v2",
    });
    for (const r of records) {
      expect(r.route.apiVersion).toBe("v2");
      const first = r.route.pathSegments[0]!;
      expect(first.kind === "literal" && first.value).toBe("v2");
    }
  });

  it("CRUD_OPERATION_KINDS is the documented set", () => {
    expect([...CRUD_OPERATION_KINDS]).toEqual([
      "list",
      "read",
      "create",
      "update",
      "delete",
    ]);
  });
});
