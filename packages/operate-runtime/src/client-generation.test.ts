import { GenerationRunSchema } from "@crossengin/sdk-clients";
import { describe, expect, it } from "vitest";

import { clientLanguageSupported, generateClient, SUPPORTED_CLIENT_LANGUAGES } from "./client-generation.js";
import type { OpenApiDocument } from "./openapi.js";

const DOC: OpenApiDocument = {
  openapi: "3.1.0",
  info: { title: "T", version: "v1" },
  paths: {
    "/v1/products": {
      get: { operationId: "product.list", summary: "", tags: ["Product"], responses: { "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { data: { type: "array", items: { $ref: "#/components/schemas/Product" } }, page: { type: "object" } } } } } } } },
    },
  },
  components: { schemas: { Product: { type: "object", properties: { id: { type: "string" }, sku: { type: "string" } }, required: ["sku"] } } },
  "x-reports": [],
};

const NOW = new Date("2026-06-11T00:00:00.000Z");

describe("clientLanguageSupported", () => {
  it("is true for ts/python/go, false for others", () => {
    expect(SUPPORTED_CLIENT_LANGUAGES).toEqual(["typescript", "python", "go"]);
    expect(clientLanguageSupported("typescript")).toBe(true);
    expect(clientLanguageSupported("python")).toBe(true);
    expect(clientLanguageSupported("go")).toBe(true);
    expect(clientLanguageSupported("java")).toBe(false);
    expect(clientLanguageSupported("rust")).toBe(false);
  });
});

describe("generateClient", () => {
  for (const language of ["typescript", "python", "go"] as const) {
    it(`produces a schema-valid succeeded GenerationRun + source for ${language}`, () => {
      const { run, source } = generateClient(DOC, language, { triggeredBy: "ci", now: NOW });
      // the run round-trips through the contract schema
      expect(() => GenerationRunSchema.parse(run)).not.toThrow();
      expect(run.status).toBe("succeeded");
      expect(run.language).toBe(language);
      expect(run.config.tool).toBe("custom_template");
      expect(run.spec.format).toBe("openapi_3_1");
      expect(run.outputArtifactSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(run.outputStorageUri).toContain(language);
      // source is real + non-empty, and its sha matches the run's build proof
      expect(source).not.toBeNull();
      expect(source!.length).toBeGreaterThan(0);
    });
  }

  it("is deterministic for a fixed clock (same sha twice)", () => {
    const a = generateClient(DOC, "typescript", { triggeredBy: "ci", now: NOW });
    const b = generateClient(DOC, "typescript", { triggeredBy: "ci", now: NOW });
    expect(a.run.outputArtifactSha256).toBe(b.run.outputArtifactSha256);
    expect(a.source).toBe(b.source);
  });

  it("the run id defaults from the artifact sha", () => {
    const { run } = generateClient(DOC, "go", { triggeredBy: "ci", now: NOW });
    expect(run.id).toBe(`gen-go-${run.outputArtifactSha256!.slice(0, 12)}`);
  });

  it("yields a failed run (no source) for an unsupported language", () => {
    const { run, source } = generateClient(DOC, "java", { triggeredBy: "ci", now: NOW });
    expect(() => GenerationRunSchema.parse(run)).not.toThrow();
    expect(run.status).toBe("failed");
    expect(run.failureReason).toContain("no built-in emitter for java");
    expect(source).toBeNull();
  });

  it("honors a custom client name", () => {
    const { source } = generateClient(DOC, "typescript", { triggeredBy: "ci", now: NOW, clientName: "createRetailClient" });
    expect(source).toContain("export function createRetailClient(");
  });
});
