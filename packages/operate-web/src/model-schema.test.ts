import { describe, expect, it } from "vitest";
import { z } from "zod";

import { webModelSchemas, zodToOpenApiSchema } from "./model-schema.js";

describe("zodToOpenApiSchema", () => {
  it("maps primitives + optional + enum + literal", () => {
    const schema = z.object({
      a: z.string(),
      b: z.number(),
      c: z.boolean().optional(),
      d: z.enum(["x", "y"]),
      k: z.literal("kpi"),
    });
    const out = zodToOpenApiSchema(schema);
    expect(out.type).toBe("object");
    expect(out.properties!["a"]).toEqual({ type: "string" });
    expect(out.properties!["b"]).toEqual({ type: "number" });
    expect(out.properties!["c"]).toEqual({ type: "boolean" });
    expect(out.properties!["d"]).toEqual({ type: "string", enum: ["x", "y"] });
    expect(out.properties!["k"]).toEqual({ type: "string", enum: ["kpi"] });
    // optional field omitted from required
    expect(out.required).toEqual(["a", "b", "d", "k"]);
  });

  it("maps arrays + nested objects", () => {
    const out = zodToOpenApiSchema(z.object({ rows: z.array(z.object({ n: z.number() })) }));
    expect(out.properties!["rows"]).toEqual({
      type: "array",
      items: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
    });
  });

  it("maps a discriminated union to oneOf", () => {
    const u = z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("a"), x: z.string() }),
      z.object({ kind: z.literal("b"), y: z.number() }),
    ]);
    const out = zodToOpenApiSchema(u);
    expect(out.oneOf).toHaveLength(2);
    expect(out.oneOf![0]!.properties!["kind"]).toEqual({ type: "string", enum: ["a"] });
  });

  it("maps z.unknown() to an open schema", () => {
    expect(zodToOpenApiSchema(z.unknown())).toEqual({});
  });
});

describe("webModelSchemas", () => {
  const models = webModelSchemas();

  it("publishes the view-model shapes", () => {
    expect(Object.keys(models).sort()).toEqual(
      ["CalendarModel", "DashboardModel", "DetailModel", "FormModel", "KanbanModel", "MapModel", "PivotModel", "TableModel", "WebAppModel"].sort(),
    );
  });

  it("TableModel is an object with typed columns + scalar props", () => {
    const t = models["TableModel"]!;
    expect(t.type).toBe("object");
    expect(t.properties!["entity"]).toEqual({ type: "string" });
    expect(t.properties!["pageSize"]).toEqual({ type: "number" });
    expect(t.properties!["columns"]!.type).toBe("array");
    expect(t.properties!["columns"]!.items!.type).toBe("object");
    // rowActions items are a discriminated union -> oneOf
    expect(t.properties!["rowActions"]!.items!.oneOf).toBeDefined();
  });

  it("DetailModel nests sections -> fields", () => {
    const d = models["DetailModel"]!;
    const sections = d.properties!["sections"]!;
    expect(sections.type).toBe("array");
    expect(sections.items!.properties!["fields"]!.type).toBe("array");
  });
});
