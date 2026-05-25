import { describe, expect, it } from "vitest";
import {
  GENERATION_STATUSES,
  GENERATOR_TOOLS,
  GenerationRunSchema,
  GeneratorConfigSchema,
  NAMING_CONVENTIONS,
  SpecSourceSchema,
  canTransitionGeneration,
  defaultConfigFor,
  namingFor,
  type GenerationRun,
  type GeneratorConfig,
} from "./generation.js";

const SHA = "a".repeat(64);

describe("constants", () => {
  it("GENERATOR_TOOLS has 6 entries", () => {
    expect(GENERATOR_TOOLS).toContain("openapi_generator");
    expect(GENERATOR_TOOLS).toContain("stainless");
    expect(GENERATOR_TOOLS).toContain("custom_template");
  });

  it("GENERATION_STATUSES has 8 entries", () => {
    expect(GENERATION_STATUSES).toContain("queued");
    expect(GENERATION_STATUSES).toContain("linting");
    expect(GENERATION_STATUSES).toContain("succeeded");
  });

  it("NAMING_CONVENTIONS has 4 entries", () => {
    expect(NAMING_CONVENTIONS).toEqual(["camelCase", "snake_case", "PascalCase", "kebab-case"]);
  });
});

describe("canTransitionGeneration", () => {
  it("queued -> fetching_spec", () => {
    expect(canTransitionGeneration("queued", "fetching_spec")).toBe(true);
  });

  it("packaging -> succeeded", () => {
    expect(canTransitionGeneration("packaging", "succeeded")).toBe(true);
  });

  it("succeeded is terminal", () => {
    expect(canTransitionGeneration("succeeded", "queued")).toBe(false);
  });

  it("queued -> succeeded not allowed (must traverse pipeline)", () => {
    expect(canTransitionGeneration("queued", "succeeded")).toBe(false);
  });

  it("any state -> failed allowed", () => {
    expect(canTransitionGeneration("linting", "failed")).toBe(true);
    expect(canTransitionGeneration("testing", "failed")).toBe(true);
  });
});

describe("GeneratorConfigSchema", () => {
  it("accepts default TS config", () => {
    expect(() => GeneratorConfigSchema.parse(defaultConfigFor("typescript"))).not.toThrow();
  });

  it("rejects naming convention mismatch", () => {
    expect(() =>
      GeneratorConfigSchema.parse({
        ...defaultConfigFor("python"),
        namingConvention: "PascalCase",
      }),
    ).toThrow(/conventionally uses/);
  });

  it("rejects custom_template tool without customTemplatePath", () => {
    expect(() =>
      GeneratorConfigSchema.parse({
        ...defaultConfigFor("typescript"),
        tool: "custom_template",
      }),
    ).toThrow(/customTemplatePath/);
  });

  it("rejects manual tool with generateAsyncMethods", () => {
    expect(() =>
      GeneratorConfigSchema.parse({
        ...defaultConfigFor("typescript"),
        tool: "manual",
      }),
    ).toThrow(/manual.*does not generate methods/);
  });

  it("rejects Go config without generateSyncMethods", () => {
    expect(() =>
      GeneratorConfigSchema.parse({
        ...defaultConfigFor("go"),
        generateSyncMethods: false,
      }),
    ).toThrow(/synchronous/);
  });
});

describe("SpecSourceSchema", () => {
  it("accepts a valid OpenAPI 3.1 source", () => {
    expect(() =>
      SpecSourceSchema.parse({
        format: "openapi_3_1",
        sourceUrl: "https://api.crossengin.io/openapi.json",
        sourceSha256: SHA,
        fetchedAt: "2026-05-15T10:00:00Z",
        apiVersion: "v1",
        sizeBytes: 250_000,
      }),
    ).not.toThrow();
  });
});

describe("GenerationRunSchema", () => {
  const base: GenerationRun = {
    id: "gen-1",
    language: "typescript",
    config: defaultConfigFor("typescript"),
    spec: {
      format: "openapi_3_1",
      sourceUrl: "https://api.crossengin.io/openapi.json",
      sourceSha256: SHA,
      fetchedAt: "2026-05-15T10:00:00Z",
      apiVersion: "v1",
      sizeBytes: 250_000,
    },
    status: "succeeded",
    queuedAt: "2026-05-15T10:00:00Z",
    startedAt: "2026-05-15T10:01:00Z",
    completedAt: "2026-05-15T10:10:00Z",
    durationSeconds: 540,
    outputArtifactSha256: SHA,
    outputStorageUri: "s3://crossengin-sdks/typescript/1.0.0.tgz",
    triggeredBy: "ci-bot",
    testsPassed: 200,
    testsFailed: 0,
    lintWarnings: 3,
    lintErrors: 0,
  };

  it("accepts a valid succeeded run", () => {
    expect(() => GenerationRunSchema.parse(base)).not.toThrow();
  });

  it("rejects config.language mismatch", () => {
    expect(() =>
      GenerationRunSchema.parse({
        ...base,
        config: { ...base.config, language: "python" } as GeneratorConfig,
      }),
    ).toThrow(/config\.language must match/);
  });

  it("rejects succeeded without outputArtifactSha256", () => {
    expect(() => GenerationRunSchema.parse({ ...base, outputArtifactSha256: null })).toThrow(
      /outputArtifactSha256/,
    );
  });

  it("rejects succeeded with failing tests", () => {
    expect(() => GenerationRunSchema.parse({ ...base, testsFailed: 1 })).toThrow(/testsFailed=0/);
  });

  it("rejects succeeded with lint errors", () => {
    expect(() => GenerationRunSchema.parse({ ...base, lintErrors: 1 })).toThrow(/lintErrors=0/);
  });

  it("rejects failed without failureReason", () => {
    expect(() =>
      GenerationRunSchema.parse({
        ...base,
        status: "failed",
      }),
    ).toThrow(/failureReason/);
  });
});

describe("helpers", () => {
  it("namingFor returns canonical convention", () => {
    expect(namingFor("typescript")).toBe("camelCase");
    expect(namingFor("python")).toBe("snake_case");
    expect(namingFor("go")).toBe("PascalCase");
  });

  it("defaultConfigFor produces a valid config", () => {
    expect(() => GeneratorConfigSchema.parse(defaultConfigFor("python"))).not.toThrow();
  });

  it("defaultConfigFor Go has generateSyncMethods=true", () => {
    expect(defaultConfigFor("go").generateSyncMethods).toBe(true);
  });

  it("defaultConfigFor TS has generateAsyncMethods=true", () => {
    expect(defaultConfigFor("typescript").generateAsyncMethods).toBe(true);
  });
});
