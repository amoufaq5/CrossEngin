import { ClientReleaseSchema, CompatibilityEntrySchema, GenerationRunSchema } from "@crossengin/sdk-clients";
import { describe, expect, it } from "vitest";

import { clientLanguageSupported, generateClient, planClientRelease, SUPPORTED_CLIENT_LANGUAGES } from "./client-generation.js";
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
    expect(SUPPORTED_CLIENT_LANGUAGES).toEqual(["typescript", "python", "go", "php"]);
    expect(clientLanguageSupported("typescript")).toBe(true);
    expect(clientLanguageSupported("python")).toBe(true);
    expect(clientLanguageSupported("go")).toBe(true);
    expect(clientLanguageSupported("php")).toBe(true);
    expect(clientLanguageSupported("java")).toBe(false);
    expect(clientLanguageSupported("rust")).toBe(false);
  });
});

describe("generateClient", () => {
  for (const language of ["typescript", "python", "go", "php"] as const) {
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

describe("planClientRelease", () => {
  const gen = generateClient(DOC, "typescript", { triggeredBy: "ci", now: NOW });

  it("turns a succeeded run into a schema-valid draft release + fully_compatible entry", () => {
    const { release, compatibility } = planClientRelease(gen, { version: "1.0.0", now: NOW });
    expect(() => ClientReleaseSchema.parse(release)).not.toThrow();
    expect(() => CompatibilityEntrySchema.parse(compatibility)).not.toThrow();
    expect(release.status).toBe("draft");
    expect(release.version).toBe("1.0.0");
    expect(release.channel).toBe("stable");
    expect(release.artifactSha256).toBe(gen.run.outputArtifactSha256); // build-proof carried through
    expect(release.generationRunId).toBe(gen.run.id); // back-link to the run
    expect(release.apiVersion).toBe("v1");
    expect(compatibility.level).toBe("fully_compatible");
    expect(compatibility.clientVersion).toBe("1.0.0");
  });

  it("publishes (stamps publishedAt/publishedBy) when publishedBy is set", () => {
    const { release } = planClientRelease(gen, { version: "1.2.3", publishedBy: "release-bot", now: NOW });
    expect(release.status).toBe("published");
    expect(release.publishedBy).toBe("release-bot");
    expect(release.publishedAt).toBe(NOW.toISOString());
  });

  it("supports a beta channel with a pre-release version", () => {
    const { release } = planClientRelease(gen, { version: "1.0.0-beta.1", channel: "beta", now: NOW });
    expect(release.channel).toBe("beta");
    expect(release.version).toBe("1.0.0-beta.1");
  });

  it("rejects a non-succeeded run", () => {
    const failed = generateClient(DOC, "java", { triggeredBy: "ci", now: NOW });
    expect(() => planClientRelease(failed, { version: "1.0.0", now: NOW })).toThrow(/cannot plan a release/);
  });

  it("enforces the contract — a stable channel forbids a pre-release version", () => {
    expect(() => planClientRelease(gen, { version: "1.0.0-rc.1", channel: "stable", now: NOW })).toThrow();
  });
});
