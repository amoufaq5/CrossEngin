import { RouteDefinitionSchema } from "@crossengin/api-gateway";
import { buildErpCorePack } from "@crossengin/pack-erp-core";
import { describe, expect, it } from "vitest";
import {
  entityRouteSpecs,
  manifestRouteSpecs,
  routeFromSpec,
} from "./operations.js";

const core = buildErpCorePack();
const invoice = (core.entities ?? []).find((e) => e.name === "Invoice")!;

describe("entityRouteSpecs", () => {
  it("derives the five CRUD operations per entity", () => {
    const specs = entityRouteSpecs(invoice, []);
    expect(specs.map((s) => s.action)).toEqual(["list", "create", "read", "update", "delete"]);
  });

  it("maps CRUD to the right HTTP methods + paths", () => {
    const specs = entityRouteSpecs(invoice, []);
    const list = specs.find((s) => s.action === "list")!;
    expect(list.method).toBe("GET");
    expect(list.pathSegments).toEqual([
      { kind: "literal", value: "v1" },
      { kind: "literal", value: "invoices" },
    ]);
    const read = specs.find((s) => s.action === "read")!;
    expect(read.pathSegments.at(-1)).toEqual({ kind: "parameter", name: "id", pattern: null });
  });

  it("adds a transition route per lifecycle transition", () => {
    const specs = entityRouteSpecs(invoice, [
      { name: "send", stateField: "state", toState: "sent", fromStates: ["draft"] },
    ]);
    const send = specs.find((s) => s.action === "transition")!;
    expect(send.operationId).toBe("invoice.send");
    expect(send.method).toBe("POST");
    expect(send.pathSegments.at(-1)).toEqual({ kind: "literal", value: "send" });
    expect(send.authOperation).toEqual({ kind: "transition", name: "send" });
  });
});

describe("manifestRouteSpecs + routeFromSpec", () => {
  it("includes the Invoice lifecycle transitions from the core workflow", () => {
    const specs = manifestRouteSpecs(core);
    const invoiceTransitions = specs.filter(
      (s) => s.entity === "Invoice" && s.action === "transition",
    );
    expect(invoiceTransitions.map((s) => s.transition?.name).sort()).toEqual([
      "mark_overdue",
      "mark_paid",
      "send",
      "void",
    ]);
  });

  it("every derived route is a valid RouteDefinition", () => {
    for (const spec of manifestRouteSpecs(core)) {
      expect(RouteDefinitionSchema.safeParse(routeFromSpec(spec)).success).toBe(true);
    }
  });
});
